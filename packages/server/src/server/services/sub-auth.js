'use strict';

// Subscription auth orchestrator.
//
// Flow:
//   1. Admin invokes POST /api/admin/subscriptions/:id/auth/start.
//   2. Server returns a short-lived JWT ticket + WS URL.
//   3. Admin opens /ws/admin/sub-auth?ticket=...
//   4. attach() runs `claude setup-token` inside the subscription pod via
//      Docker exec with TTY=true and bridges the hijacked duplex to the WS.
//   5. We tail the pty output for an OAuth token (sk-ant-oat-...). Once
//      detected, we persist it on the subscription row, mark status=active,
//      and notify the WS client. The client may close at any time.
//
// We use dockerode rather than node-pty because Docker Engine API natively
// supports TTY-attached exec, which is exactly the channel we need, and
// avoids native compilation in the server image.

const Docker = require('dockerode');
const db = require('../db');

const TOKEN_REGEX = /(sk-ant-oat[0-9a-zA-Z_\-]+)/;

let dockerSingleton = null;
function getDocker() {
  if (dockerSingleton) return dockerSingleton;
  // Defaults to /var/run/docker.sock on linux, named pipe on Windows.
  // DOCKER_HOST env var (e.g. tcp://...) is honored by dockerode.
  dockerSingleton = new Docker();
  return dockerSingleton;
}

function isTokenLine(buf) {
  const m = buf.match(TOKEN_REGEX);
  return m ? m[1] : null;
}

/**
 * Attach an admin WS to a freshly-spawned `claude setup-token` exec inside
 * the subscription's pod container.
 *
 * @param {object} opts
 * @param {string} opts.subscriptionId - subscription row id
 * @param {WebSocket} opts.ws - already-upgraded admin WS
 * @returns {Promise<void>} resolves when the exec exits or the WS closes
 */
async function attach({ subscriptionId, ws }) {
  const sub = await db.getSubscription(subscriptionId);
  if (!sub) {
    safeSend(ws, { type: 'error', error: 'subscription_not_found' });
    ws.close();
    return;
  }

  const docker = getDocker();
  const container = docker.getContainer(sub.pod_name);

  // Sanity check: container must exist and be running.
  let info;
  try {
    info = await container.inspect();
  } catch (err) {
    safeSend(ws, { type: 'error', error: 'pod_not_found', detail: err.message });
    ws.close();
    return;
  }
  if (!info.State || !info.State.Running) {
    safeSend(ws, { type: 'error', error: 'pod_not_running' });
    ws.close();
    return;
  }

  // Allow override for smoke testing without real Anthropic OAuth.
  const cmd = process.env.SUB_AUTH_CMD
    ? JSON.parse(process.env.SUB_AUTH_CMD)
    : ['claude', 'setup-token'];

  let exec;
  try {
    exec = await container.exec({
      Cmd: cmd,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: ['TERM=xterm-256color'],
    });
  } catch (err) {
    safeSend(ws, { type: 'error', error: 'exec_create_failed', detail: err.message });
    ws.close();
    return;
  }

  let stream;
  try {
    stream = await exec.start({ hijack: true, stdin: true, Tty: true });
  } catch (err) {
    safeSend(ws, { type: 'error', error: 'exec_start_failed', detail: err.message });
    ws.close();
    return;
  }

  safeSend(ws, { type: 'ready', subscription_id: subscriptionId });

  let captured = false;
  let scanBuf = '';
  const SCAN_BUF_MAX = 8 * 1024;
  // Tracks the latest in-flight token-persist so `end` can wait for it before
  // the WS goes away. Otherwise the admin UI can see `exit` without `saved`.
  let persistPromise = Promise.resolve();

  stream.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    safeSend(ws, { type: 'data', data: text });

    if (captured) return;
    scanBuf += text;
    if (scanBuf.length > SCAN_BUF_MAX) {
      scanBuf = scanBuf.slice(-SCAN_BUF_MAX);
    }
    const token = isTokenLine(scanBuf);
    if (!token) return;

    captured = true;
    persistPromise = (async () => {
      try {
        await db.setSubscriptionOAuth(subscriptionId, token);
        safeSend(ws, { type: 'token-detected' });
        safeSend(ws, { type: 'saved' });
      } catch (err) {
        safeSend(ws, { type: 'error', error: 'persist_failed', detail: err.message });
      }
    })();
  });

  stream.on('end', async () => {
    await persistPromise;
    let exitCode = null;
    try {
      const inspect = await exec.inspect();
      exitCode = inspect.ExitCode;
    } catch { /* swallow */ }
    safeSend(ws, { type: 'exit', code: exitCode });
    if (ws.readyState === ws.OPEN) ws.close();
  });

  stream.on('error', (err) => {
    safeSend(ws, { type: 'error', error: 'stream_error', detail: err.message });
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (!msg || !msg.type) return;
    if (msg.type === 'data' && typeof msg.data === 'string') {
      try { stream.write(msg.data); } catch { /* peer gone */ }
    } else if (msg.type === 'resize' && msg.cols && msg.rows) {
      exec.resize({ w: msg.cols, h: msg.rows }).catch(() => {});
    } else if (msg.type === 'close') {
      try { stream.end(); } catch { /* swallow */ }
    }
  });

  ws.on('close', () => {
    try { stream.end(); } catch { /* swallow */ }
    try { stream.destroy(); } catch { /* swallow */ }
  });
}

function safeSend(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch { /* swallow */ }
}

module.exports = { attach };
