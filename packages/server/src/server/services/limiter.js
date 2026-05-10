'use strict';

const db = require('../db');

// Multi-limit balance evaluator.
//
// A tier carries a `limits[]` array. Every limit is its own bucket with an
// independent window and budget; the turn is allowed iff *every* limit allows.
//
// Limit shape (stored in tier.limits jsonb):
//   {
//     id:           string,                  // unique within the tier
//     label:        string,                  // for UI
//     kind:         'session' | 'weekly_all' | 'weekly_model',
//     budget:       number,                  // credits in this bucket
//     window_hours: number,                  // 'session' kinds only — sliding length
//     reset_dow:    0..6,                    // 'weekly_*' kinds — 0=Sun..6=Sat (UTC)
//     reset_hour:   0..23,                   // 'weekly_*' kinds — UTC hour-of-day
//     models:       string[]                 // 'weekly_model' only — class names
//   }
//
// Grants (admin-issued credits) apply additively to every limit. They are
// the only escape hatch for "I burned my weekly all-models budget but need
// 50 more turns to land this PR" — admin grants 50 → all limits relax by 50.

const MODEL_CLASSES = ['opus', 'sonnet', 'haiku'];

function modelClass(modelId) {
  if (!modelId || typeof modelId !== 'string') return 'other';
  const m = modelId.toLowerCase();
  for (const c of MODEL_CLASSES) {
    if (m.includes(c)) return c;
  }
  return 'other';
}

/**
 * Compute the start of the most recent UTC weekly anchor at-or-before `now`.
 * `dow`: 0=Sunday … 6=Saturday. `hour`: 0..23.
 */
function lastWeeklyAnchor(now, dow, hour) {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(hour);
  // Walk back day-by-day until the weekday matches and the anchor is <= now.
  for (let i = 0; i < 8; i++) {
    if (d.getUTCDay() === dow && d.getTime() <= now.getTime()) return d;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  // Defensive: should not happen.
  return new Date(now.getTime() - 7 * 24 * 3600 * 1000);
}

async function evalLimit(user, limit, grants) {
  const id = limit.id;
  const label = limit.label || limit.id;
  const baseBudget = Number(limit.budget) || 0;
  const effectiveBudget = baseBudget + (Number(grants) || 0);

  if (limit.kind === 'session') {
    const hours = Number(limit.window_hours) || 5;
    const lookback = new Date(Date.now() - hours * 3600 * 1000);
    const { firstTs, total } = await db.usageStatsInWindow({
      userId: user.id,
      since: lookback,
    });
    const since = firstTs ? new Date(firstTs) : null;
    const resetsAt = since ? new Date(since.getTime() + hours * 3600 * 1000) : null;
    const used = Number(total) || 0;
    const remaining = effectiveBudget - used;
    return {
      id,
      label,
      kind: 'session',
      budget: baseBudget,
      effective_budget: effectiveBudget,
      used,
      remaining,
      window: {
        since: since ? since.toISOString() : null,
        resets_at: resetsAt ? resetsAt.toISOString() : null,
        hours,
      },
      models: null,
      allowed: remaining > 0,
    };
  }

  if (limit.kind === 'weekly_all' || limit.kind === 'weekly_model') {
    const dow = Number.isInteger(limit.reset_dow) ? limit.reset_dow : 1;
    const hour = Number.isInteger(limit.reset_hour) ? limit.reset_hour : 0;
    const since = lastWeeklyAnchor(new Date(), dow, hour);
    const resetsAt = new Date(since.getTime() + 7 * 24 * 3600 * 1000);

    let used;
    if (limit.kind === 'weekly_model') {
      const classes = (Array.isArray(limit.models) && limit.models.length > 0)
        ? limit.models
        : ['sonnet'];
      used = await db.sumUsageInWindowByClass({
        userId: user.id,
        since,
        classes,
      });
    } else {
      used = await db.sumUsageInWindow(user.id, since);
    }
    const remaining = effectiveBudget - used;
    return {
      id,
      label,
      kind: limit.kind,
      budget: baseBudget,
      effective_budget: effectiveBudget,
      used: Number(used) || 0,
      remaining,
      window: {
        since: since.toISOString(),
        resets_at: resetsAt.toISOString(),
        reset_dow: dow,
        reset_hour: hour,
      },
      models: limit.kind === 'weekly_model' ? (limit.models || ['sonnet']) : null,
      allowed: remaining > 0,
    };
  }

  // Unknown kind — fail closed so misconfiguration doesn't silently grant.
  return {
    id,
    label,
    kind: limit.kind || 'unknown',
    budget: baseBudget,
    effective_budget: effectiveBudget,
    used: 0,
    remaining: 0,
    window: null,
    models: null,
    allowed: false,
    error: `Unknown limit kind: ${limit.kind}`,
  };
}

async function evaluateBalance(user) {
  if (!user.tier_id) {
    return {
      allowed: false,
      reason: 'No tier assigned. Ask an admin to assign a tier.',
      limits: [],
      grants: 0,
      tier: null,
    };
  }

  const tier = await db.getTier(user.tier_id);
  if (!tier) {
    return {
      allowed: false,
      reason: 'Tier missing.',
      limits: [],
      grants: 0,
      tier: null,
    };
  }

  const tierLimits = Array.isArray(tier.limits) ? tier.limits : [];
  if (tierLimits.length === 0) {
    return {
      allowed: false,
      reason: 'Tier has no limits configured.',
      limits: [],
      grants: 0,
      tier,
    };
  }

  const grants = await db.sumActiveGrants(user.id);

  const limits = [];
  for (const l of tierLimits) {
    limits.push(await evalLimit(user, l, grants));
  }

  const blocking = limits.find((x) => !x.allowed);
  return {
    allowed: !blocking,
    reason: blocking ? `Limit "${blocking.label}" exhausted (${blocking.used}/${blocking.effective_budget} credits).` : null,
    limits,
    grants: Number(grants) || 0,
    tier,
  };
}

/**
 * Compute the credit cost of a turn from raw token counts.
 *
 * weights example:
 *   { input: 1, output: 5, cache_read: 0, cache_create: 1 }
 *
 * model-specific weights override, e.g.:
 *   { models: { "claude-opus-4-7": { input: 5, output: 25, ... } }, default: {...} }
 */
function computeCreditCost({ model, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens }, weights) {
  const w = pickModelWeights(weights, model);
  const cost =
    (inputTokens || 0) * (w.input || 0) +
    (outputTokens || 0) * (w.output || 0) +
    (cacheReadTokens || 0) * (w.cache_read || 0) +
    (cacheCreateTokens || 0) * (w.cache_create || 0);
  // Round up to keep credits an integer; never zero a real turn.
  return Math.max(1, Math.ceil(cost));
}

function pickModelWeights(weights, model) {
  if (!weights || typeof weights !== 'object') return {};
  if (weights.models && weights.models[model]) return weights.models[model];
  if (weights.default) return weights.default;
  // flat shape: { input, output, ... }
  return weights;
}

module.exports = {
  evaluateBalance,
  computeCreditCost,
  modelClass,
  MODEL_CLASSES,
};
