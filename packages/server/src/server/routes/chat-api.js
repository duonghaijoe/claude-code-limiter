'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticate } = require('../services/auth');
const { evaluateBalance } = require('../services/limiter');
const { summaryForUser } = require('../services/usage');

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

module.exports = router;
