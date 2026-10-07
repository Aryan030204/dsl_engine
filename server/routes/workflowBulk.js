const express = require('express');
const { deniedTenants } = require('../middleware/auth');
const crypto = require('crypto');
const Workflow = require('../models/Workflow');
const WorkflowVersion = require('../models/WorkflowVersion');
const WorkflowSchedule = require('../models/WorkflowSchedule');
const WorkflowJob = require('../models/WorkflowJob');
const Tenant = require('../models/Tenant');
const { validateWorkflowDefinition } = require('../validation/workflowDefinition');
const { getNextRunAt } = require('../../scheduler/app/cronUtils');
const {
  SCHEDULE_WINDOW_MODES,
  SCHEDULE_WINDOW_MODE_VALUES
} = require('../../scheduler/app/scheduleWindowModes');

function generateWorkflowId() {
  return `wf_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function generateBulkId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function isSupportedTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeTenantIds(tenantIds) {
  if (!Array.isArray(tenantIds)) return [];
  return Array.from(
    new Set(
      tenantIds
        .map((tenantId) => String(tenantId || '').trim().toUpperCase())
        .filter(Boolean)
    )
  );
}

function normalizeTenantWorkflowDefinition(definition, tenantIds) {
  const next = { ...(definition || {}) };
  const trigger = { ...(next.trigger || {}) };

  if ((next.nodes || []).some((node) => node?.analysis_mode === 'inventory')) {
    trigger.alertType = 'inventory_critical';
  }

  if (!trigger.alertType) {
    trigger.alertType = trigger.metric || 'default_alert';
  }

  if (!trigger.brandScope || trigger.brandScope === 'single') {
    trigger.brandScope = tenantIds.length > 1 ? 'multiple' : 'single';
  }

  if (trigger.brandScope === 'single' || trigger.brandScope === 'multiple') {
    if (!Array.isArray(trigger.brandIds) || trigger.brandIds.length === 0) {
      trigger.brandIds = tenantIds;
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

async function getTenantMap(tenantIds) {
  const tenants = await Tenant.find({ tenantId: { $in: tenantIds }, isActive: true }).lean();
  return new Map(tenants.map((tenant) => [tenant.tenantId, tenant]));
}

function getBulkWriteErrors(error) {
  if (Array.isArray(error?.writeErrors)) return error.writeErrors;
  if (typeof error?.getWriteErrors === 'function') return error.getWriteErrors();
  if (typeof error?.result?.getWriteErrors === 'function') return error.result.getWriteErrors();
  return [];
}

function getBulkWriteErrorIndex(writeError) {
  if (Number.isInteger(writeError?.index)) return writeError.index;
  if (Number.isInteger(writeError?.err?.index)) return writeError.err.index;
  return null;
}

function getBulkWriteErrorMessage(writeError) {
  return writeError?.errmsg
    || writeError?.err?.errmsg
    || writeError?.message
    || writeError?.err?.message
    || 'bulk write failed';
}

async function bulkInsertByTenant(Model, docs, buildFailure) {
  if (!docs.length) {
    return { succeededTenantIds: new Set(), failures: [] };
  }

  try {
    await Model.bulkWrite(
      docs.map((doc) => ({ insertOne: { document: doc } })),
      { ordered: false }
    );

    return {
      succeededTenantIds: new Set(docs.map((doc) => doc.tenantId)),
      failures: []
    };
  } catch (error) {
    const writeErrors = getBulkWriteErrors(error);
    if (!writeErrors.length) {
      return {
        succeededTenantIds: new Set(),
        failures: docs.map((doc) => buildFailure(doc.tenantId, error.message))
      };
    }

    const failuresByIndex = new Map();
    writeErrors.forEach((writeError) => {
      const index = getBulkWriteErrorIndex(writeError);
      if (index !== null && docs[index]) {
        failuresByIndex.set(index, getBulkWriteErrorMessage(writeError));
      }
    });

    return {
      succeededTenantIds: new Set(
        docs
          .filter((_, index) => !failuresByIndex.has(index))
          .map((doc) => doc.tenantId)
      ),
      failures: Array.from(failuresByIndex.entries()).map(([index, message]) => (
        buildFailure(docs[index].tenantId, message)
      ))
    };
  }
}

function serializeJob(job) {
  return {
    jobId: job._id,
    type: job.type,
    status: job.status,
    workflowId: job.workflowId,
    scheduleGroupId: job.scheduleGroupId,
    tenantIds: job.tenantIds,
    totalCount: job.totalCount,
    processedCount: job.processedCount,
    successCount: job.successCount,
    failureCount: job.failureCount,
    successes: job.result?.successes || [],
    failures: job.result?.failures || [],
    error: job.error || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null
  };
}

function getWorkflowTenantIds(workflow = {}) {
  if (Array.isArray(workflow.tenantIds) && workflow.tenantIds.length) {
    return workflow.tenantIds;
  }
  return workflow.tenantId ? [workflow.tenantId] : [];
}

async function createBulkScheduleJob({ workflowId, tenantIds, payload }) {
  const { cronExpr, timezone, windowMode = SCHEDULE_WINDOW_MODES.PREVIOUS_COMPLETE_DAY } = payload || {};

  if (!tenantIds.length) {
    const error = new Error('tenantIds must include at least one tenant');
    error.status = 400;
    throw error;
  }

  if (!cronExpr) {
    const error = new Error('cronExpr is required');
    error.status = 400;
    throw error;
  }

  if (timezone && !isSupportedTimeZone(timezone)) {
    const error = new Error('timezone must be a supported IANA timezone');
    error.status = 400;
    throw error;
  }

  if (!SCHEDULE_WINDOW_MODE_VALUES.includes(windowMode)) {
    const error = new Error(`windowMode must be one of ${SCHEDULE_WINDOW_MODE_VALUES.join(', ')}`);
    error.status = 400;
    throw error;
  }

  const workflow = await Workflow.findOne({
    workflowId,
    $or: [
      { scope: 'global', tenantId: null },
      { scope: 'tenant' },
      { scope: { $exists: false } }
    ]
  }).lean();

  if (!workflow) {
    const error = new Error('workflow not found');
    error.status = 404;
    throw error;
  }

  const tenantMap = await getTenantMap(tenantIds);
  const inactiveTenantIds = tenantIds.filter((tenantId) => !tenantMap.has(tenantId));
  if (inactiveTenantIds.length) {
    const error = new Error('one or more tenants were not found or inactive');
    error.status = 400;
    error.details = { missingTenantIds: inactiveTenantIds };
    throw error;
  }

  const isGlobal = (workflow.scope || 'tenant') === 'global';
  if (!isGlobal) {
    const allowedTenantIds = new Set(getWorkflowTenantIds(workflow));
    const disallowedTenantIds = tenantIds.filter((tenantId) => !allowedTenantIds.has(tenantId));
    if (disallowedTenantIds.length) {
      const error = new Error('one or more tenants do not have access to this workflow');
      error.status = 400;
      error.details = { missingTenantIds: disallowedTenantIds };
      throw error;
    }
  }

  const scheduleGroupId = generateBulkId('sg');
  const job = await WorkflowJob.create({
    type: 'create_bulk_schedules',
    status: 'pending',
    workflowId: workflow.workflowId,
    scheduleGroupId,
    tenantIds,
    totalCount: tenantIds.length,
    payload: {
      ...(payload || {}),
      scope: isGlobal ? 'global' : 'tenant',
      workflowId: workflow.workflowId,
      windowMode,
      scheduleGroupId
    }
  });

  enqueueBulkScheduleJob(job._id);
  return job;
}

async function processBulkScheduleJob(jobId) {
  const job = await WorkflowJob.findOneAndUpdate(
    { _id: jobId, status: 'pending' },
    { $set: { status: 'running', startedAt: new Date() } },
    { new: true }
  );

  if (!job) return;

  const { tenantIds, workflowId, scheduleGroupId } = job;
  const payload = job.payload || {};
  const tenantMap = await getTenantMap(tenantIds);
  const successes = [];
  const failures = [];

  try {
    const workflows = payload.scope === 'global'
      ? await Workflow.find({ scope: 'global', tenantId: null, workflowId: payload.workflowId }).lean()
      : await Workflow.find({ scope: 'tenant', workflowId }).lean();
    const workflowByTenant = new Map();
    if (payload.scope === 'global' && workflows[0]) {
      tenantIds.forEach((tenantId) => workflowByTenant.set(tenantId, workflows[0]));
    } else {
      workflows.forEach((workflow) => {
        if (Array.isArray(workflow.tenantIds) && workflow.tenantIds.length) {
          workflow.tenantIds.forEach((tenantId) => {
            if (tenantIds.includes(tenantId)) workflowByTenant.set(tenantId, workflow);
          });
        } else if (workflow.tenantId && tenantIds.includes(workflow.tenantId)) {
          workflowByTenant.set(workflow.tenantId, workflow);
        }
      });
    }
    const scheduleDocs = [];
    const now = new Date();

    tenantIds.forEach((tenantId) => {
      const tenant = tenantMap.get(tenantId);
      const workflow = workflowByTenant.get(tenantId);

      if (!tenant) {
        failures.push({ tenantId, error: 'tenant not found or inactive' });
        return;
      }

      if (!workflow) {
        failures.push({ tenantId, error: 'workflow not found for tenant' });
        return;
      }

      try {
        const resolvedTimeZone = payload.timezone || tenant?.settings?.timezone || 'UTC';
        scheduleDocs.push({
          tenantId,
          workflowId: workflow.workflowId,
          scheduleGroupId,
          name: payload.name || `${workflow.workflowId}-schedule`,
          triggerType: 'cron',
          cronExpr: payload.cronExpr,
          timezone: resolvedTimeZone,
          windowMode: payload.windowMode || SCHEDULE_WINDOW_MODES.PREVIOUS_COMPLETE_DAY,
          isActive: payload.isActive !== false,
          overlapPolicy: payload.overlapPolicy || 'queue_one_pending',
          retryPolicy: payload.retryPolicy || { maxAttempts: 3, backoffSeconds: [30, 120, 600] },
          nextRunAt: getNextRunAt(payload.cronExpr, now, resolvedTimeZone),
          lastEvaluatedAt: now,
          createdAt: now,
          updatedAt: now
        });
      } catch (error) {
        failures.push({ tenantId, workflowId: workflow.workflowId, error: error.message });
      }
    });

    await WorkflowJob.updateOne(
      { _id: jobId },
      {
        $set: {
          processedCount: failures.length,
          failureCount: failures.length,
          result: { successes, failures }
        }
      }
    );

    const scheduleInsert = await bulkInsertByTenant(
      WorkflowSchedule,
      scheduleDocs,
      (tenantId, message) => ({
        tenantId,
        workflowId: scheduleDocs.find((doc) => doc.tenantId === tenantId)?.workflowId,
        error: message
      })
    );
    failures.push(...scheduleInsert.failures);

    scheduleDocs
      .filter((doc) => scheduleInsert.succeededTenantIds.has(doc.tenantId))
      .forEach((doc) => {
        successes.push({
          tenantId: doc.tenantId,
          workflowId: doc.workflowId,
          scheduleGroupId
        });
      });

    await WorkflowJob.updateOne(
      { _id: jobId },
      {
        $set: {
          status: successes.length ? 'completed' : 'failed',
          processedCount: successes.length + failures.length,
          successCount: successes.length,
          failureCount: failures.length,
          result: { successes, failures },
          completedAt: new Date(),
          ...(successes.length ? {} : { error: 'no schedules were created' })
        }
      }
    );
  } catch (error) {
    await WorkflowJob.updateOne(
      { _id: jobId },
      {
        $set: {
          status: 'failed',
          error: error.message,
          completedAt: new Date(),
          result: { successes, failures },
          processedCount: successes.length + failures.length,
          successCount: successes.length,
          failureCount: failures.length
        }
      }
    );
  }
}

function enqueueBulkScheduleJob(jobId) {
  setImmediate(() => {
    processBulkScheduleJob(jobId).catch((error) => {
      console.error(`[workflow-bulk] async schedule job failed job=${jobId} error=${error.message}`);
    });
  });
}

const router = express.Router();

function denyUnauthorizedTenants(req, res, tenantIds) {
  const denied = deniedTenants(req.user, tenantIds);
  if (!denied.length) return false;
  res.status(403).json({ error: 'No access to one or more tenants', deniedTenantIds: denied });
  return true;
}

router.post('/bulk', async (req, res, next) => {
  try {
    const tenantIds = normalizeTenantIds(req.body?.tenantIds);
    if (!tenantIds.length) {
      return res.status(400).json({ error: 'tenantIds must include at least one tenant' });
    }
    if (denyUnauthorizedTenants(req, res, tenantIds)) return;

    const workflowId = generateWorkflowId();
    const definition = normalizeTenantWorkflowDefinition(
      {
        ...(req.body?.definition || {}),
        workflow_id: workflowId
      },
      tenantIds
    );

    const { ok, errors } = validateWorkflowDefinition(definition);
    if (!ok) {
      return res.status(400).json({ errors });
    }

    const tenantMap = await getTenantMap(tenantIds);
    const missingTenantIds = tenantIds.filter((tenantId) => !tenantMap.has(tenantId));
    if (missingTenantIds.length) {
      return res.status(400).json({
        error: 'one or more tenants were not found or inactive',
        missingTenantIds
      });
    }

    const workflow = await Workflow.create({
      tenantId: null,
      tenantIds,
      scope: 'tenant',
      workflowId,
      name: req.body?.name || definition.name || workflowId,
      latestVersion: definition.version,
      isActive: true
    });

    await WorkflowVersion.create({
      tenantId: null,
      tenantIds,
      scope: 'tenant',
      workflowId,
      version: definition.version,
      definitionJson: definition
    });

    res.status(201).json({
      workflowId,
      workflow,
      successes: tenantIds.map((tenantId) => ({ tenantId, workflowId })),
      failures: []
    });
  } catch (error) {
    next(error);
  }
});

router.get('/jobs/:jobId', async (req, res, next) => {
  try {
    const job = await WorkflowJob.findById(req.params.jobId).lean();
    if (!job || deniedTenants(req.user, job.tenantIds).length) {
      return res.status(404).json({ error: 'workflow job not found' });
    }

    res.json({ job: serializeJob(job) });
  } catch (error) {
    next(error);
  }
});

router.post('/:workflowId/schedules/bulk', async (req, res, next) => {
  try {
    const { workflowId } = req.params;
    const tenantIds = normalizeTenantIds(req.body?.tenantIds);
    if (denyUnauthorizedTenants(req, res, tenantIds)) return;
    const job = await createBulkScheduleJob({ workflowId, tenantIds, payload: req.body || {} });
    res.status(202).json({ job: serializeJob(job) });
  } catch (error) {
    if (error.details) {
      return res.status(error.status || 500).json({ error: error.message, ...error.details });
    }
    next(error);
  }
});

module.exports = router;
