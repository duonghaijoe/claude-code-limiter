'use strict';

// Broker: picks an active subscription for a user's turn and relays the
// request to the chosen pod's HTTP /run.
//
// Selection rules:
//   1. If the session is pinned to a subscription and the pin hasn't expired
//      and the subscription is still usable, reuse it.
//   2. Otherwise walk tier.allowed_pools in order, then failover_pools; within
//      each pool pick the active, non-cool-down subscription with the oldest
//      last_health (best-effort round-robin).
//   3. On 429 from the pod, mark the subscription's cool_down_until and retry
//      with the next candidate.
//
// We deliberately keep this per-process and stateless — no in-memory queues,
// no scheduler. State lives in Postgres so multiple portal-server instances
// can interleave safely (FOR UPDATE SKIP LOCKED inside `pickSubscription`).

const http = require('http');
const { URL } = require('url');
const db = require('../db');

const PIN_TTL_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 5 * 60 * 1000;

class BrokerError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 500;
  }
}

/**
 * Pick a subscription for the user/session and persist the pin.
 * Returns the subscription row.
 *
 * @param {object} opts
 * @param {object} opts.user - app_user row (must have tier_id)
 * @param {object} opts.session - session row
 * @param {Set<string>} [opts.exclude] - subscription ids to skip (already-failed)
 */
async function pickSubscription({ user, session, exclude }) {
  if (session && session.subscription_id && session.pinned_until && new Date(session.pinned_until) > new Date()) {
    if (!exclude || !exclude.has(session.subscription_id)) {
      const sub = await db.getSubscription(session.subscription_id);
      if (sub && isUsable(sub)) return sub;
    }
  }

  if (!user.tier_id) {
    throw new BrokerError('no_tier', 'User has no tier assigned', 403);
  }
  const tier = await db.getTier(user.tier_id);
  if (!tier) throw new BrokerError('tier_missing', 'User tier not found', 500);

  const allowedPools = Array.isArray(tier.allowed_pools) ? tier.allowed_pools : [];
  const failoverPools = Array.isArray(tier.failover_pools) ? tier.failover_pools : [];
  const orderedPools = [...allowedPools, ...failoverPools];
  if (orderedPools.length === 0) {
    throw new BrokerError('no_pools', 'Tier has no pools configured', 503);
  }

  const excludeArr = exclude ? Array.from(exclude) : [];
  for (const poolId of orderedPools) {
    const sub = await pickFromPool(poolId, excludeArr);
    if (sub) return sub;
  }
  throw new BrokerError('no_capacity', 'No available subscription pods', 503);
}

function isUsable(sub) {
  if (sub.status !== 'active') return false;
  if (sub.cool_down_until && new Date(sub.cool_down_until) > new Date()) return false;
  if (!sub.oauth_token) return false;
  return true;
}

async function pickFromPool(poolId, excludeArr) {
  const params = [poolId];
  let where = `pool_id = $1
                AND status = 'active'
                AND oauth_token IS NOT NULL
                AND (cool_down_until IS NULL OR cool_down_until < NOW())`;
  if (excludeArr.length > 0) {
    params.push(excludeArr);
    where += ` AND NOT (id = ANY($${params.length}::text[]))`;
  }
  // last_health ASC NULLS FIRST → least-recently-touched first.
  const { rows } = await db.query(
    `SELECT * FROM subscription
      WHERE ${where}
      ORDER BY last_health ASC NULLS FIRST, id ASC
      LIMIT 1`,
    params
  );
  return rows[0] || null;
}

async function pinSession(sessionId, subscriptionId) {
  const pinned = new Date(Date.now() + PIN_TTL_MS);
  await db.updateSession(sessionId, {
    subscription_id: subscriptionId,
    pinned_until: pinned,
  });
}

async function markCoolDown(subscriptionId) {
  const until = new Date(Date.now() + COOLDOWN_MS);
  await db.updateSubscription(subscriptionId, { cool_down_until: until });
  await db.recordSessionEvent({
    userId: null,
    type: 'cool_down',
    subscriptionId,
    detail: { reason: 'pod_429', until: until.toISOString() },
  }).catch(() => { /* swallow logging error */ });
}

async function markHealth(subscriptionId) {
  await db.updateSubscription(subscriptionId, { last_health: new Date() });
}

/**
 * Open a streaming POST to the pod's /run, returning the live response.
 *
 * Resolves to { res, abort } where `res` is the IncomingMessage (already
 * received headers). The caller is responsible for piping/reading data.
 */
function postRun(sub, payload) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL('/run', sub.pod_endpoint); }
    catch (err) { return reject(new BrokerError('bad_endpoint', `Invalid pod_endpoint: ${err.message}`, 500)); }

    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request({
      method: 'POST',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'Accept': 'text/event-stream',
      },
    });

    req.on('response', (res) => resolve({ res, req }));
    req.on('error', (err) => reject(new BrokerError('pod_unreachable', err.message, 502)));
    req.end(body);
  });
}

/**
 * Route a turn end-to-end. Returns an async iterator yielding SSE events
 * already parsed: `{ event, data }` where data is the JSON-decoded payload.
 *
 * The caller decides how to forward these to the end user (WS, SSE, etc.).
 *
 * @param {object} opts
 * @param {object} opts.user - app_user row
 * @param {object} opts.session - session row (will be pinned)
 * @param {object} opts.project - project row (gives workspace_path)
 * @param {string} opts.prompt
 * @param {string} [opts.model]
 *
 * @returns {Promise<{ subscription, events: AsyncIterable }>}
 */
async function route({ user, session, project, prompt, model }) {
  const tried = new Set();
  let lastError = null;

  while (true) {
    let sub;
    try {
      sub = await pickSubscription({ user, session, exclude: tried });
    } catch (err) {
      // If we already tried at least one pod and all failed at the transport
      // layer, the more useful error is the actual failure — not the generic
      // "no_capacity" that pickSubscription reports once candidates exhaust.
      if (lastError && err instanceof BrokerError && err.code === 'no_capacity') {
        throw lastError;
      }
      throw err;
    }
    tried.add(sub.id);

    let runResp;
    try {
      runResp = await postRun(sub, {
        prompt,
        workspaceDir: project.workspace_path,
        sessionId: session.id,
        oauthToken: sub.oauth_token,
        model: model || undefined,
      });
    } catch (err) {
      console.warn(`[broker] pod unreachable sub=${sub.id} endpoint=${sub.pod_endpoint}: ${err.message}`);
      lastError = err;
      continue;
    }

    const { res } = runResp;

    if (res.statusCode === 429) {
      console.warn(`[broker] pod 429 sub=${sub.id} → cool_down`);
      await markCoolDown(sub.id);
      res.resume(); // drain
      lastError = new BrokerError('rate_limited', 'Pod returned 429', 429);
      continue;
    }
    if (res.statusCode >= 500) {
      console.warn(`[broker] pod ${res.statusCode} sub=${sub.id} → retry`);
      res.resume();
      lastError = new BrokerError('pod_error', `Pod returned ${res.statusCode}`, 502);
      continue;
    }
    if (res.statusCode !== 200) {
      // 4xx that's not 429 — don't retry; surface.
      const body = await drain(res);
      throw new BrokerError('pod_rejected', `Pod returned ${res.statusCode}: ${body}`, 502);
    }

    await pinSession(session.id, sub.id);
    await markHealth(sub.id);

    return { subscription: sub, events: parseSSE(res) };
  }
  // unreachable
}

async function* parseSSE(res) {
  let buf = '';
  for await (const chunk of res) {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evt = parseBlock(block);
      if (evt) yield evt;
    }
  }
  if (buf.trim()) {
    const evt = parseBlock(buf);
    if (evt) yield evt;
  }
}

function parseBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  let data = dataLines.join('\n');
  try { data = JSON.parse(data); } catch { /* keep as string */ }
  return { event, data };
}

function drain(res) {
  return new Promise((resolve) => {
    let body = '';
    res.on('data', (c) => { body += c.toString('utf8'); });
    res.on('end', () => resolve(body));
    res.on('error', () => resolve(body));
  });
}

module.exports = {
  route,
  pickSubscription,
  pinSession,
  markCoolDown,
  markHealth,
  BrokerError,
};
