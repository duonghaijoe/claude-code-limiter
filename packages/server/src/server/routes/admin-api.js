'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { hashPassword, createJWT, authenticate, requireAdmin } = require('../services/auth');
const { evaluateBalance } = require('../services/limiter');

router.use(authenticate, requireAdmin);

function publicUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return rest;
}

// ---------- Users ----------

router.get('/users', async (req, res, next) => {
  try {
    const users = await db.listUsers();
    const out = await Promise.all(users.map(async (u) => {
      const balance = await evaluateBalance(u);
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        tier_id: u.tier_id,
        role: u.role,
        status: u.status,
        last_seen: u.last_seen,
        created_at: u.created_at,
        balance,
      };
    }));
    res.json({ users: out });
  } catch (err) { next(err); }
});

router.post('/users', async (req, res, next) => {
  try {
    const { email, name, password, tier_id, role } = req.body;
    if (!email || !name) {
      return res.status(400).json({ error: 'email and name are required' });
    }
    const existing = await db.getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already exists' });

    const passwordHash = password ? hashPassword(password) : null;
    const user = await db.createUser({
      email,
      name,
      passwordHash,
      tierId: tier_id,
      role: role || 'member',
    });
    res.status(201).json({ user: publicUser(user) });
  } catch (err) { next(err); }
});

router.put('/users/:id', async (req, res, next) => {
  try {
    const user = await db.getUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const updates = {};
    const { name, tier_id, role, status, password } = req.body;
    if (name !== undefined) updates.name = name;
    if (tier_id !== undefined) updates.tier_id = tier_id;
    if (role !== undefined) updates.role = role;
    if (status !== undefined) updates.status = status;
    if (password) updates.password_hash = hashPassword(password);

    const updated = await db.updateUser(user.id, updates);
    res.json({ user: publicUser(updated) });
  } catch (err) { next(err); }
});

router.delete('/users/:id', async (req, res, next) => {
  try {
    const user = await db.getUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }
    await db.deleteUser(user.id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ---------- Tiers ----------

router.get('/tiers', async (req, res, next) => {
  try {
    const tiers = await db.listTiers();
    res.json({ tiers });
  } catch (err) { next(err); }
});

router.post('/tiers', async (req, res, next) => {
  try {
    const { name, limits, allowed_pools, failover_pools, credit_weights } = req.body;
    if (!name || !credit_weights) {
      return res.status(400).json({ error: 'name and credit_weights are required' });
    }
    if (!Array.isArray(limits) || limits.length === 0) {
      return res.status(400).json({ error: 'limits[] is required (at least one entry)' });
    }
    const validation = validateLimits(limits);
    if (validation) return res.status(400).json({ error: validation });
    const tier = await db.createTier({
      name,
      limits,
      allowedPools: allowed_pools,
      failoverPools: failover_pools,
      creditWeights: credit_weights,
    });
    res.status(201).json({ tier });
  } catch (err) { next(err); }
});

function validateLimits(limits) {
  const seen = new Set();
  for (const l of limits) {
    if (!l || typeof l !== 'object') return 'limit must be an object';
    if (!l.id || typeof l.id !== 'string') return 'limit.id required';
    if (seen.has(l.id)) return `duplicate limit id: ${l.id}`;
    seen.add(l.id);
    if (!['session', 'weekly_all', 'weekly_model'].includes(l.kind)) {
      return `limit.kind must be session|weekly_all|weekly_model (got ${l.kind})`;
    }
    if (typeof l.budget !== 'number' || l.budget < 0) return 'limit.budget must be a non-negative number';
    if (l.kind === 'session' && (!l.window_hours || l.window_hours <= 0)) {
      return 'session limit requires window_hours > 0';
    }
    if (l.kind === 'weekly_model' && (!Array.isArray(l.models) || l.models.length === 0)) {
      return 'weekly_model limit requires models[] with at least one class';
    }
  }
  return null;
}

router.put('/tiers/:id', async (req, res, next) => {
  try {
    const tier = await db.getTier(req.params.id);
    if (!tier) return res.status(404).json({ error: 'Tier not found' });
    if (req.body.limits !== undefined) {
      if (!Array.isArray(req.body.limits) || req.body.limits.length === 0) {
        return res.status(400).json({ error: 'limits[] must be a non-empty array' });
      }
      const validation = validateLimits(req.body.limits);
      if (validation) return res.status(400).json({ error: validation });
    }
    const updated = await db.updateTier(tier.id, req.body);
    res.json({ tier: updated });
  } catch (err) { next(err); }
});

router.delete('/tiers/:id', async (req, res, next) => {
  try {
    await db.deleteTier(req.params.id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ---------- Pools ----------

router.get('/pools', async (req, res, next) => {
  try {
    const pools = await db.listPools();
    res.json({ pools });
  } catch (err) { next(err); }
});

router.post('/pools', async (req, res, next) => {
  try {
    const { name, plan } = req.body;
    if (!name || !plan) return res.status(400).json({ error: 'name and plan are required' });
    const pool = await db.createPoolRow({ name, plan });
    res.status(201).json({ pool });
  } catch (err) { next(err); }
});

router.delete('/pools/:id', async (req, res, next) => {
  try {
    await db.deletePool(req.params.id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ---------- Subscriptions ----------

router.get('/subscriptions', async (req, res, next) => {
  try {
    const subs = await db.listSubscriptions();
    res.json({ subscriptions: subs });
  } catch (err) { next(err); }
});

router.post('/subscriptions', async (req, res, next) => {
  try {
    const { pool_id, pod_name, pod_endpoint, login_email, notes } = req.body;
    if (!pool_id || !pod_name || !pod_endpoint || !login_email) {
      return res.status(400).json({ error: 'pool_id, pod_name, pod_endpoint, login_email are required' });
    }
    const sub = await db.createSubscription({
      poolId: pool_id,
      podName: pod_name,
      podEndpoint: pod_endpoint,
      loginEmail: login_email,
      notes,
    });
    res.status(201).json({ subscription: sub });
  } catch (err) { next(err); }
});

router.put('/subscriptions/:id', async (req, res, next) => {
  try {
    const sub = await db.getSubscription(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    const updated = await db.updateSubscription(sub.id, req.body);
    res.json({ subscription: updated });
  } catch (err) { next(err); }
});

router.delete('/subscriptions/:id', async (req, res, next) => {
  try {
    await db.deleteSubscription(req.params.id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// Mint a short-lived ticket the admin browser uses to attach to
// /ws/admin/sub-auth and walk through `claude setup-token` interactively.
router.post('/subscriptions/:id/auth/start', async (req, res, next) => {
  try {
    const sub = await db.getSubscription(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });

    const ticket = createJWT(
      { purpose: 'sub-auth', subscriptionId: sub.id, adminId: req.user.id },
      '5m'
    );

    // Build a relative ws_url; the client decides ws vs wss based on its own scheme.
    const wsUrl = `/ws/admin/sub-auth?ticket=${encodeURIComponent(ticket)}`;
    res.json({ ticket, ws_url: wsUrl, expires_in: 300 });
  } catch (err) { next(err); }
});

// ---------- Grants ----------

router.get('/users/:id/grants', async (req, res, next) => {
  try {
    const grants = await db.listGrants(req.params.id);
    res.json({ grants });
  } catch (err) { next(err); }
});

router.post('/users/:id/grants', async (req, res, next) => {
  try {
    const user = await db.getUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { amount, reason, expires_at } = req.body;
    if (amount == null || !expires_at) {
      return res.status(400).json({ error: 'amount and expires_at are required' });
    }
    const grant = await db.createGrant({
      userId: user.id,
      amount,
      reason,
      grantedBy: req.user.id,
      expiresAt: expires_at,
    });
    res.status(201).json({ grant });
  } catch (err) { next(err); }
});

// ---------- Events ----------

router.get('/events', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const userId = req.query.user_id || null;
    const events = await db.recentEvents({ userId, limit });
    res.json({ events });
  } catch (err) { next(err); }
});

module.exports = router;
