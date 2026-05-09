'use strict';

const db = require('../db');

/**
 * Compute the effective credit balance for a user:
 *   tier.credit_budget + Σ active grants - Σ usage in window
 *
 * Returns { allowed, balance, used, budget, grants, window, weights, tier }
 * `allowed` is false when balance <= 0 OR when the user has no tier assigned.
 */
async function evaluateBalance(user) {
  if (!user.tier_id) {
    return {
      allowed: false,
      reason: 'No tier assigned. Ask an admin to assign a tier.',
      balance: 0,
      used: 0,
      budget: 0,
      grants: 0,
      window: null,
      weights: {},
      tier: null,
    };
  }

  const tier = await db.getTier(user.tier_id);
  if (!tier) {
    return {
      allowed: false,
      reason: 'Tier missing.',
      balance: 0,
      used: 0,
      budget: 0,
      grants: 0,
      window: null,
      weights: {},
      tier: null,
    };
  }

  const since = db.windowStart(tier.window_type);
  const used = await db.sumUsageInWindow(user.id, since);
  const grants = await db.sumActiveGrants(user.id);
  const budget = Number(tier.credit_budget);
  const balance = budget + grants - used;

  return {
    allowed: balance > 0,
    reason: balance > 0 ? null : `Credit budget exhausted. ${used}/${budget + grants} used since ${since.toISOString()}.`,
    balance,
    used,
    budget,
    grants,
    window: { type: tier.window_type, since },
    weights: tier.credit_weights,
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
};
