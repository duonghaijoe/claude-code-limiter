'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

let jwtSecret = null;
function getJWTSecret() {
  if (jwtSecret) return jwtSecret;
  jwtSecret = process.env.JWT_SECRET || crypto.randomUUID();
  if (!process.env.JWT_SECRET) {
    console.warn('[auth] JWT_SECRET not set; generated a random secret. Sessions will not survive restart.');
  }
  return jwtSecret;
}

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compareSync(plain, hash);
}

function createJWT(payload, expiresIn) {
  return jwt.sign(payload, getJWTSecret(), { expiresIn: expiresIn || '24h' });
}

function verifyJWT(token) {
  try {
    return jwt.verify(token, getJWTSecret());
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = decodeURIComponent(rest.join('=').trim());
  }
  return cookies;
}

function extractToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.headers.cookie) {
    const c = parseCookies(req.headers.cookie);
    if (c.jwt) return c.jwt;
  }
  return null;
}

async function authenticate(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const decoded = verifyJWT(token);
  if (!decoded || !decoded.userId) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const user = await db.getUser(decoded.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (user.status !== 'active') return res.status(403).json({ error: `User ${user.status}` });

  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  createJWT,
  verifyJWT,
  authenticate,
  requireAdmin,
};
