'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const db = require('./db');
const authApi = require('./routes/auth-api');
const adminApi = require('./routes/admin-api');
const chatApi = require('./routes/chat-api');
const { setupWebSocket } = require('./ws');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '2mb' }));

// CORS — allow configured origins (comma-separated).
const allowList = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (allowList.length === 0 || allowList.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Static SPA. The dashboard build serves both /dashboard/* (admin) and /chat/* (member).
const dashboardDir = path.join(__dirname, '..', '..', '..', 'dashboard', 'dist');
app.use('/dashboard', express.static(dashboardDir));
app.use('/chat', express.static(dashboardDir));
app.get('/dashboard/*', (req, res) => res.sendFile(path.join(dashboardDir, 'index.html')));
app.get('/chat/*', (req, res) => res.sendFile(path.join(dashboardDir, 'index.html')));

// API routes.
app.use('/api/auth', authApi);
app.use('/api/admin', adminApi);
app.use('/api/chat', chatApi);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => res.redirect('/dashboard'));

setupWebSocket(server);

app.use((err, req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

async function start(port) {
  await db.init();
  await db.ensureBootstrapAdmin();

  await new Promise((resolve) => server.listen(port, resolve));
  console.log(`[server] listening on :${port}`);
  console.log(`[server] dashboard  http://localhost:${port}/dashboard`);
  console.log(`[server] auth API   http://localhost:${port}/api/auth`);
  console.log(`[server] admin API  http://localhost:${port}/api/admin`);
  console.log(`[server] chat API   http://localhost:${port}/api/chat`);
  console.log(`[server] websocket  ws://localhost:${port}/ws`);
}

module.exports = { app, server, start };
