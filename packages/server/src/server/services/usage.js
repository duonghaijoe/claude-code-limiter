'use strict';

const db = require('../db');
const { computeCreditCost, evaluateBalance } = require('./limiter');

/**
 * Record one completed turn.
 * Computes credit_cost from token counts using the user's tier weights at insert time
 * and freezes the weights snapshot in the row so retroactive weight changes don't rewrite history.
 *
 * Caller must have already checked balance via evaluateBalance() pre-flight.
 */
async function recordTurn({ user, subscriptionId, sessionId, model, tokens }) {
  const tier = user.tier_id ? await db.getTier(user.tier_id) : null;
  const weights = tier ? tier.credit_weights : {};

  const creditCost = computeCreditCost({ model, ...tokens }, weights);

  await db.recordUsage({
    userId: user.id,
    subscriptionId,
    sessionId,
    model,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheCreateTokens: tokens.cacheCreateTokens,
    creditCost,
    weightsSnapshot: weights,
  });

  return { creditCost };
}

/**
 * User-facing summary: balance + window + recent usage.
 */
async function summaryForUser(userId) {
  const user = await db.getUser(userId);
  if (!user) return null;
  const balance = await evaluateBalance(user);
  const recent = await db.recentEvents({ userId, limit: 25 });
  return { balance, recent };
}

module.exports = {
  recordTurn,
  summaryForUser,
};
