'use strict';

const { WebSocketServer } = require('ws');
const { verifyJWT } = require('./services/auth');
const subAuth = require('./services/sub-auth');

let dashboardWss = null;
let subAuthWss = null;

/**
 * Set up WebSocket servers on the given HTTP server.
 *
 *   /ws                  - dashboard event stream (broadcast)
 *   /ws/admin/sub-auth   - admin terminal for `claude setup-token` (one client per session)
 *
 * Both upgrade through the same HTTP listener; we route by pathname.
 */
function setupWebSocket(server) {
  dashboardWss = new WebSocketServer({ noServer: true });
  subAuthWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const { pathname } = url;

    if (pathname === '/ws') {
      dashboardWss.handleUpgrade(request, socket, head, (ws) => {
        dashboardWss.emit('connection', ws, request);
      });
      return;
    }

    if (pathname === '/ws/admin/sub-auth') {
      const ticket = url.searchParams.get('ticket');
      const claims = ticket ? verifyJWT(ticket) : null;
      if (!claims || claims.purpose !== 'sub-auth' || !claims.subscriptionId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      subAuthWss.handleUpgrade(request, socket, head, (ws) => {
        subAuthWss.emit('connection', ws, request, claims);
      });
      return;
    }

    socket.destroy();
  });

  dashboardWss.on('connection', (ws) => {
    ws.send(JSON.stringify({
      type: 'connected',
      timestamp: new Date().toISOString(),
    }));
    ws.on('error', (err) => {
      console.error('[ws] dashboard error:', err.message);
    });
  });

  subAuthWss.on('connection', (ws, _request, claims) => {
    ws.on('error', (err) => {
      console.error('[ws] sub-auth error:', err.message);
    });
    subAuth.attach({ subscriptionId: claims.subscriptionId, ws })
      .catch((err) => {
        console.error('[ws] sub-auth attach failed:', err.message);
        try {
          ws.send(JSON.stringify({ type: 'error', error: 'attach_failed', detail: err.message }));
        } catch { /* swallow */ }
        try { ws.close(); } catch { /* swallow */ }
      });
  });

  console.log('[ws] dashboard ready on /ws');
  console.log('[ws] sub-auth ready on /ws/admin/sub-auth');
}

/**
 * Broadcast an event to all connected dashboard clients.
 */
function broadcast(event) {
  if (!dashboardWss) return;
  const message = JSON.stringify(event);
  for (const client of dashboardWss.clients) {
    if (client.readyState === 1) client.send(message);
  }
}

function getClientCount() {
  if (!dashboardWss) return 0;
  let count = 0;
  for (const client of dashboardWss.clients) {
    if (client.readyState === 1) count++;
  }
  return count;
}

module.exports = {
  setupWebSocket,
  broadcast,
  getClientCount,
};
