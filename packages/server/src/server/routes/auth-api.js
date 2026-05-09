'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyPassword, createJWT, authenticate } = require('../services/auth');

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const user = await db.getUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ error: `Account ${user.status}` });
    }

    await db.updateUser(user.id, { last_seen: new Date() });
    const token = createJWT({ userId: user.id, role: user.role });

    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('jwt', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, tier_id: user.tier_id },
    });
  } catch (err) { next(err); }
});

router.post('/logout', (req, res) => {
  res.clearCookie('jwt');
  res.json({ ok: true });
});

router.get('/me', authenticate, async (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      role: req.user.role,
      tier_id: req.user.tier_id,
      status: req.user.status,
    },
  });
});

module.exports = router;
