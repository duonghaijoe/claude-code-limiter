'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticate } = require('../services/auth');
const { evaluateBalance } = require('../services/limiter');
const { summaryForUser, recordTurn } = require('../services/usage');
const broker = require('../services/broker');

router.use(authenticate);

function workspaceRoot() {
  return process.env.WORKSPACE_ROOT || '/workspaces';
}

function safeName(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

router.get('/balance', async (req, res, next) => {
  try {
    const balance = await evaluateBalance(req.user);
    res.json({ balance });
  } catch (err) { next(err); }
});

router.get('/usage', async (req, res, next) => {
  try {
    const summary = await summaryForUser(req.user.id);
    res.json(summary);
  } catch (err) { next(err); }
});

// ---------- Projects ----------

router.get('/projects', async (req, res, next) => {
  try {
    const projects = await db.listProjects(req.user.id);
    res.json({ projects });
  } catch (err) { next(err); }
});

router.post('/projects', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const userDir = safeName(req.user.email.split('@')[0] || req.user.id);
    const projectDir = safeName(name);
    const workspacePath = path.join(workspaceRoot(), userDir, projectDir);

    // Create the directory eagerly so the pod mount target exists.
    fs.mkdirSync(workspacePath, { recursive: true });

    const project = await db.createProject({
      userId: req.user.id,
      name,
      workspacePath,
    });
    res.status(201).json({ project });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'Project name already exists' });
    }
    next(err);
  }
});

router.delete('/projects/:id', async (req, res, next) => {
  try {
    const project = await db.getProject(req.params.id);
    if (!project || project.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Project not found' });
    }
    await db.deleteProject(project.id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ---------- Sessions ----------

router.get('/sessions', async (req, res, next) => {
  try {
    const sessions = await db.listSessions({
      userId: req.user.id,
      projectId: req.query.project_id || null,
    });
    res.json({ sessions });
  } catch (err) { next(err); }
});

router.post('/sessions', async (req, res, next) => {
  try {
    const { project_id } = req.body;
    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    const project = await db.getProject(project_id);
    if (!project || project.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const session = await db.createSessionRow({
      userId: req.user.id,
      projectId: project.id,
    });
    res.status(201).json({ session });
  } catch (err) { next(err); }
});

router.get('/sessions/:id/messages', async (req, res, next) => {
  try {
    const session = await db.getSession(req.params.id);
    if (!session || session.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const messages = await db.listMessages(session.id);
    res.json({ messages });
  } catch (err) { next(err); }
});

// POST /sessions/:id/messages
//   Body: { content: string, model?: string }
//   Streams SSE: pod events relayed through, then a final `event: meta` carrying credit_cost.
//   Pre-flight quota check + post-turn usage record.
router.post('/sessions/:id/messages', async (req, res, next) => {
  try {
    const session = await db.getSession(req.params.id);
    if (!session || session.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const project = await db.getProject(session.project_id);
    if (!project) return res.status(404).json({ error: 'Project missing' });

    const { content, model } = req.body || {};
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content required' });
    }

    const balance = await evaluateBalance(req.user);
    if (!balance.allowed) {
      return res.status(402).json({ error: 'quota_exhausted', balance });
    }

    await db.appendMessage({ sessionId: session.id, role: 'user', content });

    let routed;
    try {
      routed = await broker.route({
        user: req.user,
        session,
        project,
        prompt: content,
        model,
      });
    } catch (err) {
      if (err instanceof broker.BrokerError) {
        return res.status(err.status).json({ error: err.code, detail: err.message });
      }
      throw err;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let assistantText = '';
    let usage = null;
    let resultModel = model || null;
    let resultClaudeSessionId = null;
    let resultIsError = false;

    try {
      for await (const evt of routed.events) {
        // Pod emits its own `done` to close its half of the stream. Don't
        // relay it — chat-api owns the client-facing protocol (meta +
        // done) and forwarding the pod's done duplicates the close.
        if (evt.event === 'done') continue;
        send(evt.event, evt.data);
        if (evt.event === 'result' && evt.data && evt.data.type === 'result') {
          if (typeof evt.data.result === 'string') assistantText = evt.data.result;
          if (evt.data.usage) usage = evt.data.usage;
          if (evt.data.model) resultModel = evt.data.model;
          if (typeof evt.data.session_id === 'string') resultClaudeSessionId = evt.data.session_id;
          if (evt.data.is_error) resultIsError = true;
        }
      }
    } catch (err) {
      send('error', { error: 'stream_error', detail: err.message });
      res.end();
      return;
    }

    // Persist the SDK's session id so the next turn can resume the same
    // conversation. Only on success — error turns get a fresh id we don't
    // want to lock in.
    if (!resultIsError && resultClaudeSessionId && resultClaudeSessionId !== session.claude_session_id) {
      try {
        await db.updateSession(session.id, { claude_session_id: resultClaudeSessionId });
      } catch (err) {
        send('error', { error: 'persist_session_failed', detail: err.message });
      }
    }

    let creditCost = 0;
    if (usage) {
      try {
        const turn = await recordTurn({
          user: req.user,
          subscriptionId: routed.subscription.id,
          sessionId: session.id,
          model: resultModel || 'unknown',
          tokens: {
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            cacheReadTokens: usage.cache_read_input_tokens || 0,
            cacheCreateTokens: usage.cache_creation_input_tokens || 0,
          },
        });
        creditCost = turn.creditCost;
      } catch (err) {
        send('error', { error: 'record_usage_failed', detail: err.message });
      }
    }

    if (assistantText) {
      try {
        await db.appendMessage({ sessionId: session.id, role: 'assistant', content: assistantText });
      } catch (err) {
        send('error', { error: 'append_message_failed', detail: err.message });
      }
    }

    send('meta', { credit_cost: creditCost, subscription_id: routed.subscription.id });
    send('done', { ok: true });
    res.end();
  } catch (err) {
    if (!res.headersSent) return next(err);
    res.end();
  }
});

module.exports = router;
