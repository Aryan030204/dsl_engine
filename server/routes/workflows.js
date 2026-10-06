const express = require('express');
const crypto = require('crypto');
const Workflow = require('../models/Workflow');
const WorkflowVersion = require('../models/WorkflowVersion');
const Tenant = require('../models/Tenant');
const { validateWorkflowDefinition } = require('../validation/workflowDefinition');
const { attachWorkflowKind, attachWorkflowKinds } = require('../lib/workflowKind');
const {
  buildTenantWorkflowQuery,
  buildWorkflowVersionQuery,
  getVersionTenantId,
  getWorkflowTenantIds
} = require('../services/workflowResolverService');

function generateWorkflowId() {
  return `wf_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

const router = express.Router({ mergeParams: true });

function normalizeTriggerDefinition(definition, tenantId, scope = 'tenant') {
  const next = { ...definition };
  const trigger = { ...(definition.trigger || {}) };

  // Inventory-trigger behavior is opt-in per workflow node. Preserve every
  // existing workflow's configured alert type and defaults.
  if ((definition.nodes || []).some((node) => node?.analysis_mode === 'inventory')) {
    trigger.alertType = 'inventory_critical';
  }

  if (!trigger.alertType) {
    trigger.alertType = trigger.metric || 'default_alert';
  }

  if (!trigger.brandScope) {
    trigger.brandScope = scope === 'global' ? 'global' : 'single';
  }

  if (trigger.brandScope === 'single' || trigger.brandScope === 'multiple') {
    if (!Array.isArray(trigger.brandIds) || trigger.brandIds.length === 0) {
      trigger.brandIds = tenantId ? [tenantId] : [];
    }
  } else {
    trigger.brandIds = [];
  }

  if (!trigger.type) {
    trigger.type = 'alert';
  }

  next.trigger = trigger;
  return next;
}

// Middleware to validate tenant exists
async function validateTenant(req, res, next) {
  try {
    const { tenantId } = req.params;
    const tenant = await Tenant.findOne({ tenantId, isActive: true });
    if (!tenant) {
      return res.status(404).json({ error: `Tenant '${tenantId}' not found` });
    }
    req.tenant = tenant;
    next();
  } catch (err) {
    next(err);
  }
}

router.use(validateTenant);

router.get('/', async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const includeGlobal = req.query.includeGlobal === 'true';

    const tenantWorkflows = await Workflow.find({
      $or: [
        { tenantIds: tenantId },
        { tenantId }
      ],
      $and: [
        { $or: [{ scope: 'tenant' }, { scope: { $exists: false } }] }
      ]
    }).lean();
    if (!includeGlobal) {
      return res.json({ workflows: attachWorkflowKinds(tenantWorkflows) });
    }

    const globalWorkflows = await Workflow.find({ scope: 'global', tenantId: null }).lean();
    const workflowsById = new Map();

    globalWorkflows.forEach((workflow) => workflowsById.set(workflow.workflowId, workflow));
    tenantWorkflows.forEach((workflow) => workflowsById.set(workflow.workflowId, workflow));

    res.json({ workflows: attachWorkflowKinds(Array.from(workflowsById.values())) });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const definition = normalizeTriggerDefinition(req.body, tenantId, 'tenant');
    definition.workflow_id = generateWorkflowId();
    
    const { ok, errors } = validateWorkflowDefinition(definition);
    if (!ok) {
      return res.status(400).json({ errors });
    }

    const workflowId = definition.workflow_id;
    const version = definition.version;

    const workflow = await Workflow.create({
      tenantId: null,
      tenantIds: [tenantId],
      scope: 'tenant',
      workflowId,
      name: definition.name || workflowId,
      latestVersion: version,
      isActive: true
    });

    await WorkflowVersion.create({
      tenantId: null,
      tenantIds: [tenantId],
      scope: 'tenant',
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
    const { tenantId, workflowId } = req.params;
    const includeGlobal = req.query.includeGlobal === 'true';

    let workflow = await Workflow.findOne(buildTenantWorkflowQuery(tenantId, workflowId)).lean();
    if (!workflow && includeGlobal) {
      workflow = await Workflow.findOne({ scope: 'global', tenantId: null, workflowId }).lean();
    }
    if (!workflow) return res.status(404).json({ error: 'workflow not found' });

    const version = await WorkflowVersion.findOne(
      buildWorkflowVersionQuery(workflow, workflowId, workflow.latestVersion)
    ).lean();

    res.json({ workflow: attachWorkflowKind(workflow), version });
  } catch (err) {
    next(err);
  }
});

router.post('/:workflowId/versions', async (req, res, next) => {
  try {
    const { tenantId, workflowId } = req.params;
    const definition = normalizeTriggerDefinition(req.body, tenantId, 'tenant');
    const { ok, errors } = validateWorkflowDefinition(definition);
    if (!ok) {
      return res.status(400).json({ errors });
    }
    if (definition.workflow_id !== workflowId) {
      return res.status(400).json({ error: 'workflow_id mismatch' });
    }

    const version = definition.version;
    const workflow = await Workflow.findOne(buildTenantWorkflowQuery(tenantId, workflowId));
    if (!workflow) return res.status(404).json({ error: 'workflow not found' });

    await WorkflowVersion.create({
      tenantId: getVersionTenantId(workflow),
      scope: workflow.scope || 'tenant',
      tenantIds: getWorkflowTenantIds(workflow),
      workflowId,
      version,
      definitionJson: definition
    });

    workflow.latestVersion = version;
    // Keep display name in sync with the latest definition name (if provided)
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
    const { tenantId, workflowId } = req.params;
    const includeGlobal = req.query.includeGlobal === 'true';

    let workflow = await Workflow.findOne(buildTenantWorkflowQuery(tenantId, workflowId)).lean();
    if (!workflow && includeGlobal) {
      workflow = await Workflow.findOne({ scope: 'global', tenantId: null, workflowId }).lean();
    }
    if (!workflow) return res.status(404).json({ error: 'workflow not found' });

    const versions = await WorkflowVersion.find(
      buildWorkflowVersionQuery(workflow, workflowId)
    )
      .sort({ createdAt: -1 })
      .lean();
    res.json({ versions });
  } catch (err) {
    next(err);
  }
});

// Update workflow metadata
router.patch('/:workflowId', async (req, res, next) => {
  try {
    const { tenantId, workflowId } = req.params;
    const { name, isActive } = req.body;

    const workflow = await Workflow.findOne(buildTenantWorkflowQuery(tenantId, workflowId));
    if (!workflow) return res.status(404).json({ error: 'workflow not found' });

    if (name !== undefined) workflow.name = name;
    if (isActive !== undefined) workflow.isActive = isActive;

    await workflow.save();
    res.json({ workflow: attachWorkflowKind(workflow.toObject()) });
  } catch (err) {
    next(err);
  }
});

// Delete a workflow and all its versions
router.delete('/:workflowId', async (req, res, next) => {
  try {
    const { tenantId, workflowId } = req.params;

    const workflow = await Workflow.findOne(buildTenantWorkflowQuery(tenantId, workflowId));
    if (!workflow) return res.status(404).json({ error: 'workflow not found' });

    // Delete all versions
    await WorkflowVersion.deleteMany(buildWorkflowVersionQuery(workflow, workflowId));

    // Delete the workflow
    await Workflow.deleteOne({ _id: workflow._id });

    res.json({ message: 'Workflow deleted successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
