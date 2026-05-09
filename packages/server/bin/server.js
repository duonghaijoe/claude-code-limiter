#!/usr/bin/env node

'use strict';

const app = require('../src/server/index.js');

const port = parseInt(process.env.PORT || '3000', 10);

console.log(`[server] starting; NODE_ENV=${process.env.NODE_ENV || 'development'}`);

app.start(port).catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\n[server] received ${signal}, shutting down`);
  if (app.server && app.server.listening) {
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
  console.error('[server] unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception:', err);
  process.exit(1);
});
