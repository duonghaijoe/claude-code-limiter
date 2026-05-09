'use strict';

// Subscription pod runtime.
//
// One pod = one Claude Pro/Max subscription. The pod is stateless from
// the broker's perspective: every /run carries the OAuth token captured
// during `claude setup-token`. We expose that token as
// CLAUDE_CODE_OAUTH_TOKEN to the spawned Claude CLI subprocess so it
// authenticates against the subscription rather than an API key.
//
// Endpoints:
//   GET  /health           - liveness; reports if the `claude` CLI is on PATH
//   POST /run              - { prompt, workspaceDir, sessionId?, oauthToken } → SSE stream of SDK events
//                            terminates with `event: result` carrying token usage and result text

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let queryFn = null;
async function getQuery() {
  if (queryFn) return queryFn;
  const mod = await import('@anthropic-ai/claude-agent-sdk');
  queryFn = mod.query;
  return queryFn;
}

function start({ port }) {
  const app = express();
  app.use(express.json({ limit: '8mb' }));

  app.get('/health', (req, res) => {
    let cliVersion = null;
    try {
      cliVersion = require('child_process')
        .execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 })
        .trim();
    } catch (err) {
      // Pod is healthy if HTTP responds; CLI absence is a separate concern surfaced in payload.
    }
    res.json({ status: 'ok', cli: cliVersion });
  });

  app.post('/run', async (req, res) => {
    const { prompt, workspaceDir, sessionId, oauthToken, model } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required' });
    }
    if (!workspaceDir || typeof workspaceDir !== 'string') {
      return res.status(400).json({ error: 'workspaceDir is required' });
    }
    if (!oauthToken || typeof oauthToken !== 'string') {
      return res.status(400).json({ error: 'oauthToken is required' });
    }

    if (!fs.existsSync(workspaceDir)) {
      try { fs.mkdirSync(workspaceDir, { recursive: true }); } catch (err) {
        return res.status(500).json({ error: 'workspace_create_failed', detail: err.message });
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sse = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const query = await getQuery();
      const iter = query({
        prompt,
        options: {
          cwd: workspaceDir,
          resume: sessionId || undefined,
          model: model || undefined,
        },
      });

      for await (const msg of iter) {
        sse('message', msg);
        if (msg.type === 'result') {
          sse('result', msg);
        }
      }
      sse('done', { ok: true });
    } catch (err) {
      sse('error', { error: err.message });
    } finally {
      if (previousToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken;
      else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (previousApiKey !== undefined) process.env.ANTHROPIC_API_KEY = previousApiKey;
      res.end();
    }
  });

  app.use((err, req, res, _next) => {
    console.error('[pod] error', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    else res.end();
  });

  app.listen(port, () => {
    console.log(`[pod] listening on :${port}`);
  });

  return app;
}

module.exports = { start };
