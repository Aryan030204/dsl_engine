const express = require('express');
const WorkflowRun = require('../models/WorkflowRun');
const { validateRunContext } = require('../validation/runContext');
const {
  validateRunContextAgainstWorkflow
} = require('../validation/productPartialDayCompatibility');
const { resolveWorkflowVersion, executeRun } = require('../services/workflowExecutionService');
const { enqueueRun } = require('../../scheduler/app/runQueueService');
const { normalizeRerunContext } = require('../../lib/timeWindowUtils');
const Tenant = require('../models/Tenant');
const { resolveManualRunTimezone } = require('../../lib/runTimezone');

const router = express.Router({ mergeParams: true });

router.post('/:workflowId/runs', async (req, res, next) => {
  try {
    const { tenantId, workflowId } = req.params;
    const { version, context, rerun, notify } = req.body || {};
    // Manual runs only notify and update alert state when explicitly asked to.
    const notifyLive = notify === true;
    const mode = req.query.mode === 'async' ? 'async' : 'sync';
    const tenant = await Tenant.findOne({ tenantId }).lean();
    if (!tenant) return res.status(404).json({ error: 'tenant not found' });

    const effectiveTimezone = resolveManualRunTimezone({
      rerun,
      contextTimezone: context?.meta?.timezone,
      tenantTimezone: tenant.settings?.timezone
    });
    const contextWithTimezone = {
      ...(context || {}),
      meta: {
        ...(context?.meta || {}),
        tenantId,
        timezone: effectiveTimezone
      }
    };
    const effectiveContext = rerun
      ? normalizeRerunContext(contextWithTimezone, effectiveTimezone)
      : contextWithTimezone;

    const { ok, errors } = validateRunContext(effectiveContext);
    if (!ok) return res.status(400).json({ errors });
    if (effectiveContext.meta.tenantId !== tenantId) {
      return res.status(400).json({ error: 'tenantId mismatch in context' });
    }

    const { workflowVersion, versionId } = await resolveWorkflowVersion({
      tenantId,
      workflowId,
      version
    });

    const compatibility = validateRunContextAgainstWorkflow(effectiveContext, workflowVersion.definitionJson);
    if (!compatibility.ok) {
      return res.status(400).json({ errors: compatibility.errors });
    }

    if (mode === 'async') {
      const queued = await enqueueRun({
        tenantId,
        workflowId,
        version: versionId,
        context: effectiveContext,
        definitionJson: workflowVersion.definitionJson,
        triggerType: 'manual',
        triggerRef: null,
        notifyLive,
        overlapPolicy: 'queue_one_pending',
        maxAttempts: 3
      });

      if (!queued.enqueued) {
        return res.status(202).json({
          runId: null,
          status: 'skipped',
          reason: queued.reason
        });
      }

      return res.status(202).json({
        runId: queued.run._id,
        status: queued.run.status
      });
    }

    const run = await WorkflowRun.create({
      tenantId,
      workflowId,
      version: versionId,
      status: 'running',
      triggerType: 'manual',
      triggerRef: null,
      notifyLive,
      executionKey: `${tenantId}:${workflowId}`,
      context: effectiveContext,
      definitionJson: workflowVersion.definitionJson,
      metrics: {},
      executionTrace: [],
      nodeOutputs: [],
      attempt: 0,
      maxAttempts: 1,
      startedAt: new Date()
    });

    await executeRun({ run });

    res.status(201).json({ runId: run._id, status: run.status });
  } catch (err) {
    next(err);
  }
});

router.get('/:workflowId/runs', async (req, res, next) => {
  try {
    const { tenantId, workflowId } = req.params;
    // The list needs the summary and the context's meta/filters (Rerun); the definition, node
    // outputs, trace and derived values are ~15 KB per run and only the run page uses them.
    const runs = await WorkflowRun.find({ tenantId, workflowId })
      .select('-definitionJson -nodeOutputs -executionTrace -metrics -context.breakdowns -context.scratch -context.metrics -context.executionTrace -context.rootCausePath')
      .sort({ startedAt: -1 })
      .limit(20)
      .lean();
    res.json({ runs });
  } catch (err) {
    next(err);
  }
});

router.get('/:workflowId/runs/:runId', async (req, res, next) => {
  try {
    const { tenantId, workflowId, runId } = req.params;
    const run = await WorkflowRun.findOne({ _id: runId, tenantId, workflowId }).lean();
    if (!run) return res.status(404).json({ error: 'run not found' });
    res.json({ run });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
