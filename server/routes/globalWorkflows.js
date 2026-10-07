const express = require('express');
const crypto = require('crypto');
const Workflow = require('../models/Workflow');
const WorkflowVersion = require('../models/WorkflowVersion');
const { validateWorkflowDefinition } = require('../validation/workflowDefinition');
const { attachWorkflowKind, attachWorkflowKinds } = require('../lib/workflowKind');

function generateWorkflowId() {
  return `wf_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

const router = express.Router();

function normalizeTriggerDefinition(definition) {
  const next = { ...definition };
  const trigger = { ...(definition.trigger || {}) };

  if ((definition.nodes || []).some((node) => node?.analysis_mode === 'inventory')) {
    trigger.alertType = 'inventory_critical';
  }

  if (!trigger.alertType) {
    trigger.alertType = trigger.metric || 'default_alert';
  }
  if (!trigger.brandScope) {
    trigger.brandScope = 'global';
  }
  if (trigger.brandScope === 'global') {
    trigger.brandIds = [];
  }
  if (!trigger.type) {
    trigger.type = 'alert';
  }

  next.trigger = trigger;
  return next;
}

router.get('/', async (req, res, next) => {
  try {
    const workflows = await Workflow.find({ scope: 'global', tenantId: null }).lean();
    res.json({ workflows: attachWorkflowKinds(workflows) });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const definition = normalizeTriggerDefinition(req.body);
    definition.workflow_id = generateWorkflowId();

    const { ok, errors } = validateWorkflowDefinition(definition);
    if (!ok) {
      return res.status(400).json({ errors });
    }

    const workflowId = definition.workflow_id;
    const version = definition.version;

    const workflow = await Workflow.create({
      tenantId: null,
      tenantIds: [],
      scope: 'global',
      workflowId,
      name: definition.name || workflowId,
      latestVersion: version,
      isActive: true
    });

    await WorkflowVersion.create({
      tenantId: null,
      tenantIds: [],
      scope: 'global',
      workflowId,
      version,
      definitionJson: definition
    });

    res.status(201).json({ workflow: attachWorkflowKind(workflow.toObject()) });
  } catch (err) {
    next(err);
  }
});

router.get('/:workflowId', async (req, res, next) => {
  try {
    const { workflowId } = req.params;
    const workflow = await Workflow.findOne({ scope: 'global', tenantId: null, workflowId }).lean();
    if (!workflow) return res.status(404).json({ error: 'workflow not found' });

    const version = await WorkflowVersion.findOne({
      tenantId: null,
      scope: 'global',
      workflowId,
      version: workflow.latestVersion
    }).lean();

    res.json({ workflow: attachWorkflowKind(workflow), version });
  } catch (err) {
    next(err);
  }
});

router.post('/:workflowId/versions', async (req, res, next) => {
  try {
    const { workflowId } = req.params;
    const definition = normalizeTriggerDefinition(req.body);
    const { ok, errors } = validateWorkflowDefinition(definition);
    if (!ok) {
      return res.status(400).json({ errors });
    }
    if (definition.workflow_id !== workflowId) {
      return res.status(400).json({ error: 'workflow_id mismatch' });
    }

    const workflow = await Workflow.findOne({ scope: 'global', tenantId: null, workflowId });
    if (!workflow) return res.status(404).json({ error: 'workflow not found' });

    const version = definition.version;

    await WorkflowVersion.create({
      tenantId: null,
      tenantIds: [],
      scope: 'global',
      workflowId,
      version,
      definitionJson: definition
    });

    workflow.latestVersion = version;
    if (definition.name) {
      workflow.name = definition.name;
    }
    await workflow.save();

    res.status(201).json({ version });
  } catch (err) {
    next(err);
  }
});

router.get('/:workflowId/versions', async (req, res, next) => {
  try {
    const { workflowId } = req.params;
    const versions = await WorkflowVersion.find({
      tenantId: null,
      scope: 'global',
      workflowId
    })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ versions });
  } catch (err) {
    next(err);
  }
});

router.patch('/:workflowId', async (req, res, next) => {
  try {
    const { workflowId } = req.params;
    const { name, isActive } = req.body;

    const workflow = await Workflow.findOne({ scope: 'global', tenantId: null, workflowId });
    if (!workflow) return res.status(404).json({ error: 'workflow not found' });

    if (name !== undefined) workflow.name = name;
    if (isActive !== undefined) workflow.isActive = isActive;

    await workflow.save();
    res.json({ workflow: attachWorkflowKind(workflow.toObject()) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:workflowId', async (req, res, next) => {
  try {
    const { workflowId } = req.params;

    const workflow = await Workflow.findOne({ scope: 'global', tenantId: null, workflowId });
    if (!workflow) return res.status(404).json({ error: 'workflow not found' });

    await WorkflowVersion.deleteMany({ scope: 'global', tenantId: null, workflowId });
    await Workflow.deleteOne({ scope: 'global', tenantId: null, workflowId });

    res.json({ message: 'Workflow deleted successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
