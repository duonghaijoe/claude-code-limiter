'use strict';

const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

let pool = null;

function getPool() {
  if (!pool) throw new Error('Database not initialized. Call init() first.');
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function init() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  pool = new Pool({ connectionString });

  // Verify connectivity up front so a misconfigured DSN fails fast at boot.
  await pool.query('SELECT 1');

  await runMigrations();
  console.log(`[db] Postgres connected and migrations applied`);
  return pool;
}

async function runMigrations() {
  await query(`
    CREATE TABLE IF NOT EXISTS tier (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL UNIQUE,
      limits          JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_pools   JSONB NOT NULL DEFAULT '[]'::jsonb,
      failover_pools  JSONB NOT NULL DEFAULT '[]'::jsonb,
      credit_weights  JSONB NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_user (
      id                TEXT PRIMARY KEY,
      email             TEXT NOT NULL UNIQUE,
      name              TEXT NOT NULL,
      password_hash     TEXT,
      external_subject  TEXT,
      tier_id           TEXT REFERENCES tier(id) ON DELETE SET NULL,
      role              TEXT NOT NULL DEFAULT 'member',
      status            TEXT NOT NULL DEFAULT 'active',
      last_seen         TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pool (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      plan        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subscription (
      id                    TEXT PRIMARY KEY,
      pool_id               TEXT NOT NULL REFERENCES pool(id) ON DELETE CASCADE,
      pod_name              TEXT NOT NULL UNIQUE,
      pod_endpoint          TEXT NOT NULL,
      login_email           TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'pending_auth',
      oauth_token           TEXT,
      oauth_token_added_at  TIMESTAMPTZ,
      cool_down_until       TIMESTAMPTZ,
      last_health           TIMESTAMPTZ,
      notes                 TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Forward migration for existing DBs that already had subscription without oauth columns.
    ALTER TABLE subscription ADD COLUMN IF NOT EXISTS oauth_token TEXT;
    ALTER TABLE subscription ADD COLUMN IF NOT EXISTS oauth_token_added_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS project (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      workspace_path  TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS session (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
      project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      subscription_id TEXT REFERENCES subscription(id) ON DELETE SET NULL,
      pinned_until    TIMESTAMPTZ,
      status          TEXT NOT NULL DEFAULT 'active',
      started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at        TIMESTAMPTZ
    );

    -- Claude Agent SDK session id (returned in result.session_id). Distinct
    -- from session.id (our row UUID). Used as the SDK resume target on
    -- subsequent turns so the model continues the same conversation.
    ALTER TABLE session ADD COLUMN IF NOT EXISTS claude_session_id TEXT;

    CREATE TABLE IF NOT EXISTS message (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS usage_event (
      id                  BIGSERIAL PRIMARY KEY,
      user_id             TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
      subscription_id     TEXT REFERENCES subscription(id) ON DELETE SET NULL,
      session_id          TEXT REFERENCES session(id) ON DELETE SET NULL,
      model               TEXT NOT NULL,
      input_tokens        BIGINT NOT NULL DEFAULT 0,
      output_tokens       BIGINT NOT NULL DEFAULT 0,
      cache_read_tokens   BIGINT NOT NULL DEFAULT 0,
      cache_create_tokens BIGINT NOT NULL DEFAULT 0,
      credit_cost         BIGINT NOT NULL,
      weights_snapshot    JSONB NOT NULL,
      timestamp           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS credit_grant (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
      amount      BIGINT NOT NULL,
      reason      TEXT,
      granted_by  TEXT REFERENCES app_user(id) ON DELETE SET NULL,
      granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_event (
      id              BIGSERIAL PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
      session_id      TEXT REFERENCES session(id) ON DELETE SET NULL,
      type            TEXT NOT NULL,
      subscription_id TEXT REFERENCES subscription(id) ON DELETE SET NULL,
      detail          JSONB,
      timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_usage_user_ts ON usage_event(user_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_sub_ts ON usage_event(subscription_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_session_event_user_ts ON session_event(user_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_credit_grant_user ON credit_grant(user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_app_user_email ON app_user(email);

    -- Drop legacy single-budget columns. Pre-release cleanup; no migration
    -- path needed. Existing dev DBs already have limits[] populated.
    ALTER TABLE tier DROP COLUMN IF EXISTS credit_budget;
    ALTER TABLE tier DROP COLUMN IF EXISTS window_type;
  `);
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ---------- Bootstrap ----------

async function ensureBootstrapAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('[db] ADMIN_EMAIL/ADMIN_PASSWORD not set; skipping admin bootstrap');
    return null;
  }

  const existing = await getUserByEmail(email);
  if (existing) {
    return existing;
  }

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  await query(
    `INSERT INTO app_user (id, email, name, password_hash, role, status)
     VALUES ($1, $2, $3, $4, 'admin', 'active')`,
    [id, email, email.split('@')[0], hash]
  );
  console.log(`[db] Bootstrapped admin user ${email}`);
  return getUser(id);
}

// ---------- Users ----------

async function getUser(id) {
  const { rows } = await query('SELECT * FROM app_user WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getUserByEmail(email) {
  const { rows } = await query('SELECT * FROM app_user WHERE email = $1', [email]);
  return rows[0] || null;
}

async function listUsers() {
  const { rows } = await query('SELECT * FROM app_user ORDER BY created_at ASC');
  return rows;
}

async function createUser({ email, name, passwordHash, tierId, role }) {
  const id = uuidv4();
  await query(
    `INSERT INTO app_user (id, email, name, password_hash, tier_id, role)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, email, name, passwordHash || null, tierId || null, role || 'member']
  );
  return getUser(id);
}

async function updateUser(id, fields) {
  const sets = [];
  const values = [];
  let i = 1;
  if (fields.name !== undefined) { sets.push(`name = $${i++}`); values.push(fields.name); }
  if (fields.tier_id !== undefined) { sets.push(`tier_id = $${i++}`); values.push(fields.tier_id); }
  if (fields.role !== undefined) { sets.push(`role = $${i++}`); values.push(fields.role); }
  if (fields.status !== undefined) { sets.push(`status = $${i++}`); values.push(fields.status); }
  if (fields.password_hash !== undefined) { sets.push(`password_hash = $${i++}`); values.push(fields.password_hash); }
  if (fields.last_seen !== undefined) { sets.push(`last_seen = $${i++}`); values.push(fields.last_seen); }
  if (sets.length === 0) return getUser(id);
  values.push(id);
  await query(`UPDATE app_user SET ${sets.join(', ')} WHERE id = $${i}`, values);
  return getUser(id);
}

async function deleteUser(id) {
  await query('DELETE FROM app_user WHERE id = $1', [id]);
}

// ---------- Tiers ----------

async function listTiers() {
  const { rows } = await query('SELECT * FROM tier ORDER BY name ASC');
  return rows;
}

async function getTier(id) {
  const { rows } = await query('SELECT * FROM tier WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createTier({ name, limits, allowedPools, failoverPools, creditWeights }) {
  const id = uuidv4();
  await query(
    `INSERT INTO tier (id, name, limits, allowed_pools, failover_pools, credit_weights)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
    [
      id,
      name,
      JSON.stringify(Array.isArray(limits) ? limits : []),
      JSON.stringify(allowedPools || []),
      JSON.stringify(failoverPools || []),
      JSON.stringify(creditWeights),
    ]
  );
  return getTier(id);
}

async function updateTier(id, fields) {
  const sets = [];
  const values = [];
  let i = 1;
  if (fields.name !== undefined) { sets.push(`name = $${i++}`); values.push(fields.name); }
  if (fields.limits !== undefined) { sets.push(`limits = $${i++}::jsonb`); values.push(JSON.stringify(fields.limits)); }
  if (fields.allowed_pools !== undefined) { sets.push(`allowed_pools = $${i++}`); values.push(JSON.stringify(fields.allowed_pools)); }
  if (fields.failover_pools !== undefined) { sets.push(`failover_pools = $${i++}`); values.push(JSON.stringify(fields.failover_pools)); }
  if (fields.credit_weights !== undefined) { sets.push(`credit_weights = $${i++}`); values.push(JSON.stringify(fields.credit_weights)); }
  if (sets.length === 0) return getTier(id);
  values.push(id);
  await query(`UPDATE tier SET ${sets.join(', ')} WHERE id = $${i}`, values);
  return getTier(id);
}

async function deleteTier(id) {
  await query('DELETE FROM tier WHERE id = $1', [id]);
}

// ---------- Pools ----------

async function listPools() {
  const { rows } = await query('SELECT * FROM pool ORDER BY name ASC');
  return rows;
}

async function getPoolById(id) {
  const { rows } = await query('SELECT * FROM pool WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createPoolRow({ name, plan }) {
  const id = uuidv4();
  await query('INSERT INTO pool (id, name, plan) VALUES ($1, $2, $3)', [id, name, plan]);
  return getPoolById(id);
}

async function deletePool(id) {
  await query('DELETE FROM pool WHERE id = $1', [id]);
}

// ---------- Subscriptions ----------

async function listSubscriptions() {
  const { rows } = await query(
    `SELECT s.*, p.name AS pool_name, p.plan AS pool_plan
     FROM subscription s
     JOIN pool p ON s.pool_id = p.id
     ORDER BY s.created_at ASC`
  );
  return rows;
}

async function getSubscription(id) {
  const { rows } = await query('SELECT * FROM subscription WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createSubscription({ poolId, podName, podEndpoint, loginEmail, notes }) {
  const id = uuidv4();
  await query(
    `INSERT INTO subscription (id, pool_id, pod_name, pod_endpoint, login_email, notes)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, poolId, podName, podEndpoint, loginEmail, notes || null]
  );
  return getSubscription(id);
}

async function updateSubscription(id, fields) {
  const sets = [];
  const values = [];
  let i = 1;
  if (fields.status !== undefined) { sets.push(`status = $${i++}`); values.push(fields.status); }
  if (fields.cool_down_until !== undefined) { sets.push(`cool_down_until = $${i++}`); values.push(fields.cool_down_until); }
  if (fields.last_health !== undefined) { sets.push(`last_health = $${i++}`); values.push(fields.last_health); }
  if (fields.notes !== undefined) { sets.push(`notes = $${i++}`); values.push(fields.notes); }
  if (fields.pod_endpoint !== undefined) { sets.push(`pod_endpoint = $${i++}`); values.push(fields.pod_endpoint); }
  if (sets.length === 0) return getSubscription(id);
  values.push(id);
  await query(`UPDATE subscription SET ${sets.join(', ')} WHERE id = $${i}`, values);
  return getSubscription(id);
}

async function setSubscriptionOAuth(id, oauthToken) {
  await query(
    `UPDATE subscription
        SET oauth_token = $1,
            oauth_token_added_at = NOW(),
            status = 'active'
      WHERE id = $2`,
    [oauthToken, id]
  );
  return getSubscription(id);
}

async function deleteSubscription(id) {
  await query('DELETE FROM subscription WHERE id = $1', [id]);
}

// ---------- Projects / Sessions / Messages ----------

async function listProjects(userId) {
  const { rows } = await query(
    'SELECT * FROM project WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return rows;
}

async function getProject(id) {
  const { rows } = await query('SELECT * FROM project WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createProject({ userId, name, workspacePath }) {
  const id = uuidv4();
  await query(
    `INSERT INTO project (id, user_id, name, workspace_path)
     VALUES ($1, $2, $3, $4)`,
    [id, userId, name, workspacePath]
  );
  return getProject(id);
}

async function deleteProject(id) {
  await query('DELETE FROM project WHERE id = $1', [id]);
}

async function listSessions({ userId, projectId }) {
  if (projectId) {
    const { rows } = await query(
      'SELECT * FROM session WHERE user_id = $1 AND project_id = $2 ORDER BY started_at DESC',
      [userId, projectId]
    );
    return rows;
  }
  const { rows } = await query(
    'SELECT * FROM session WHERE user_id = $1 ORDER BY started_at DESC',
    [userId]
  );
  return rows;
}

async function getSession(id) {
  const { rows } = await query('SELECT * FROM session WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createSessionRow({ userId, projectId, subscriptionId, pinnedUntil }) {
  const id = uuidv4();
  await query(
    `INSERT INTO session (id, user_id, project_id, subscription_id, pinned_until)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, projectId, subscriptionId || null, pinnedUntil || null]
  );
  return getSession(id);
}

async function updateSession(id, fields) {
  const sets = [];
  const values = [];
  let i = 1;
  if (fields.subscription_id !== undefined) { sets.push(`subscription_id = $${i++}`); values.push(fields.subscription_id); }
  if (fields.pinned_until !== undefined) { sets.push(`pinned_until = $${i++}`); values.push(fields.pinned_until); }
  if (fields.status !== undefined) { sets.push(`status = $${i++}`); values.push(fields.status); }
  if (fields.ended_at !== undefined) { sets.push(`ended_at = $${i++}`); values.push(fields.ended_at); }
  if (fields.claude_session_id !== undefined) { sets.push(`claude_session_id = $${i++}`); values.push(fields.claude_session_id); }
  if (sets.length === 0) return getSession(id);
  values.push(id);
  await query(`UPDATE session SET ${sets.join(', ')} WHERE id = $${i}`, values);
  return getSession(id);
}

async function listMessages(sessionId) {
  const { rows } = await query(
    'SELECT * FROM message WHERE session_id = $1 ORDER BY created_at ASC',
    [sessionId]
  );
  return rows;
}

async function appendMessage({ sessionId, role, content }) {
  const id = uuidv4();
  await query(
    `INSERT INTO message (id, session_id, role, content) VALUES ($1, $2, $3, $4)`,
    [id, sessionId, role, content]
  );
  return { id, session_id: sessionId, role, content };
}

// ---------- Usage events ----------

async function recordUsage({ userId, subscriptionId, sessionId, model, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, creditCost, weightsSnapshot }) {
  await query(
    `INSERT INTO usage_event
       (user_id, subscription_id, session_id, model,
        input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
        credit_cost, weights_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      userId,
      subscriptionId || null,
      sessionId || null,
      model,
      inputTokens || 0,
      outputTokens || 0,
      cacheReadTokens || 0,
      cacheCreateTokens || 0,
      creditCost,
      JSON.stringify(weightsSnapshot || {}),
    ]
  );
}

async function sumUsageInWindow(userId, since) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(credit_cost), 0)::bigint AS total
       FROM usage_event
      WHERE user_id = $1 AND timestamp >= $2`,
    [userId, since]
  );
  return Number(rows[0].total);
}

// Both the earliest event timestamp inside the window and the total cost.
// Used by `session` limits to anchor a sliding window on the first message.
async function usageStatsInWindow({ userId, since }) {
  const { rows } = await query(
    `SELECT MIN(timestamp) AS first_ts, COALESCE(SUM(credit_cost), 0)::bigint AS total
       FROM usage_event
      WHERE user_id = $1 AND timestamp >= $2`,
    [userId, since]
  );
  return {
    firstTs: rows[0].first_ts || null,
    total: Number(rows[0].total),
  };
}

// Sum credit cost where the model id falls into one of the given classes.
// Classes are matched by substring (case-insensitive) on the model id, e.g.
// 'sonnet' matches 'claude-sonnet-4-6'. Unknown classes match nothing.
async function sumUsageInWindowByClass({ userId, since, classes }) {
  if (!Array.isArray(classes) || classes.length === 0) return 0;
  const { rows } = await query(
    `SELECT COALESCE(SUM(credit_cost), 0)::bigint AS total
       FROM usage_event
      WHERE user_id = $1
        AND timestamp >= $2
        AND CASE
          WHEN model ILIKE '%opus%'   THEN 'opus'
          WHEN model ILIKE '%sonnet%' THEN 'sonnet'
          WHEN model ILIKE '%haiku%'  THEN 'haiku'
          ELSE 'other'
        END = ANY($3::text[])`,
    [userId, since, classes]
  );
  return Number(rows[0].total);
}

async function recentEvents({ userId, limit }) {
  const lim = limit || 50;
  if (userId) {
    const { rows } = await query(
      `SELECT e.*, u.name AS user_name, u.email AS user_email
         FROM usage_event e
         JOIN app_user u ON e.user_id = u.id
        WHERE e.user_id = $1
        ORDER BY e.timestamp DESC LIMIT $2`,
      [userId, lim]
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT e.*, u.name AS user_name, u.email AS user_email
       FROM usage_event e
       JOIN app_user u ON e.user_id = u.id
      ORDER BY e.timestamp DESC LIMIT $1`,
    [lim]
  );
  return rows;
}

// ---------- Credit grants ----------

async function listGrants(userId) {
  const { rows } = await query(
    'SELECT * FROM credit_grant WHERE user_id = $1 ORDER BY granted_at DESC',
    [userId]
  );
  return rows;
}

async function sumActiveGrants(userId, asOf) {
  const ts = asOf || new Date();
  const { rows } = await query(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS total
       FROM credit_grant
      WHERE user_id = $1 AND expires_at > $2`,
    [userId, ts]
  );
  return Number(rows[0].total);
}

async function createGrant({ userId, amount, reason, grantedBy, expiresAt }) {
  const id = uuidv4();
  await query(
    `INSERT INTO credit_grant (id, user_id, amount, reason, granted_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, userId, amount, reason || null, grantedBy || null, expiresAt]
  );
  const { rows } = await query('SELECT * FROM credit_grant WHERE id = $1', [id]);
  return rows[0];
}

// ---------- Session events ----------

async function recordSessionEvent({ userId, sessionId, type, subscriptionId, detail }) {
  await query(
    `INSERT INTO session_event (user_id, session_id, type, subscription_id, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      sessionId || null,
      type,
      subscriptionId || null,
      detail ? JSON.stringify(detail) : null,
    ]
  );
}

module.exports = {
  init,
  close,
  query,
  ensureBootstrapAdmin,
  // users
  getUser,
  getUserByEmail,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  // tiers
  listTiers,
  getTier,
  createTier,
  updateTier,
  deleteTier,
  // pools
  listPools,
  getPoolById,
  createPoolRow,
  deletePool,
  // subscriptions
  listSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  setSubscriptionOAuth,
  deleteSubscription,
  // projects/sessions/messages
  listProjects,
  getProject,
  createProject,
  deleteProject,
  listSessions,
  getSession,
  createSessionRow,
  updateSession,
  listMessages,
  appendMessage,
  // usage
  recordUsage,
  sumUsageInWindow,
  usageStatsInWindow,
  sumUsageInWindowByClass,
  recentEvents,
  // grants
  listGrants,
  sumActiveGrants,
  createGrant,
  // session events
  recordSessionEvent,
};
