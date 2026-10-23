const WorkflowRun = require('../models/WorkflowRun');
const Insight = require('../models/Insight');
const { pruneWorkflowRuns } = require('../lib/retention');
const WorkflowRunner = require('../../engine/WorkflowRunner');
const workflowResolverService = require('./workflowResolverService');
const Tenant = require('../models/Tenant');
const { createCapturingSender } = require('../lib/notificationCapture');
const { collectWorkflowRecipients } = require('../lib/renderStateEmail');
const { isStateEngineEnabled } = require('../lib/stateEngine/defaults');
const { resolveTenantTimezone } = require('../../lib/runTimezone');
const { getDefaultStateEngineService } = require('./stateEngineService');
const { getRunTimeoutMs, createRunTimeoutError, createRunCanceledError, RUN_CANCELED_CODE } = require('../../lib/runTimeout');
const { getDefaultRecipientPolicy } = require('./recipientPolicy');

async function resolveWorkflowVersion({ tenantId, workflowId, version }) {
  return workflowResolverService.resolveWorkflowVersion({
    tenantId,
    workflowId,
    version,
    allowGlobalFallback: true,
    allowedScopes: ['tenant', 'global']
  });
}

async function persistFinalInsight({ tenantId, workflowId, runId, context }) {
  const finalInsight = context?.scratch?.finalInsight;
  if (!finalInsight) return;

  await Insight.create({
    tenantId,
    workflowId,
    runId,
    summary: finalInsight.summary || 'unknown',
    details: finalInsight.details || [],
    confidence: finalInsight.confidence
  });
}

// RCA workflows with state_config enabled have their email/insight/messaging sends
// (email and Telegram) captured
// instead of delivered, so the state engine can decide after the run whether to
// notify. Everything else -- daily insight/report workflows and RCA workflows not
// yet configured for state -- sends inline exactly as before.
function prepareNotificationMode(definition) {
  if (!isStateEngineEnabled(definition)) return { stateEngine: false, capture: null };
  return { stateEngine: true, capture: createCapturingSender() };
}

// Never throws: a state-engine problem is recorded on the run but must not fail an
// otherwise-successful run, since a failed run is retried and re-executed.
// Manual runs are dry runs unless the caller opted in (run.notifyLive): they report what the
// engine would decide but change no state and send nothing. Scheduled and alert-triggered
// runs are always live.
function isDryRun(run) {
  return run.triggerType === 'manual' && run.notifyLive !== true;
}

async function applyStateEngine({ run, result, intents, telegramIntents = [], stateEngine = getDefaultStateEngineService() }) {
  const definition = run.definitionJson || {};
  const meta = result.context?.meta || {};
  try {
    if (isDryRun(run)) {
      run.stateEvaluation = await stateEngine.previewExecution({
        tenantId: run.tenantId,
        workflowId: run.workflowId,
        triggerType: run.triggerType,
        context: result.context,
        config: definition.state_config,
        timezone: resolveTenantTimezone(meta.timezone)
      });
      run.stateEvaluationError = null;
      await run.save();
      return;
    }
    const outcome = await stateEngine.processExecution({
      tenantId: run.tenantId,
      workflowId: run.workflowId,
      executionId: String(run._id),
      triggerType: run.triggerType,
      context: result.context,
      config: definition.state_config,
      timezone: resolveTenantTimezone(meta.timezone),
      intents,
      telegramIntents,
      fallbackRecipients: collectWorkflowRecipients(definition),
      workflowName: meta.workflowName || definition.name,
      brandName: meta.brandName,
      branding: meta.emailBranding
    });
    run.stateEvaluation = outcome.summary;
    run.stateEvaluationError = null;
  } catch (error) {
    console.error(`[state-engine] evaluation failed run=${run._id} workflow=${run.workflowId} tenant=${run.tenantId} error=${error.message}`);
    run.stateEvaluation = null;
    run.stateEvaluationError = error.message;
  }
  await run.save();
}

// Copies the tenant's settings onto a run's context.meta.
function applyTenantToMeta(meta, tenant) {
  if (!meta.brandName && tenant?.name) {
    meta.brandName = tenant.name;
  }
  // Report emails format `currency` cards/columns in the tenant's currency. Always
  // taken from the tenant's current setting (never from the run's saved context),
  // so a rerun of an older run picks up a currency changed since.
  if (tenant?.settings?.currency) {
    meta.currency = tenant.settings.currency;
  }
  // The tenant's Shopify store, which the inventory sales ranking (Redis) is keyed by. Taken from
  // the tenant's current setting for the same reason as the currency.
  if (tenant?.settings?.shopifyDomain) {
    meta.shopifyDomain = tenant.settings.shopifyDomain;
  } else {
    delete meta.shopifyDomain;
  }
  if (!meta.emailBranding && tenant?.settings?.emailBranding) {
    meta.emailBranding = { ...tenant.settings.emailBranding };
  }
  return meta;
}

// Cuts a run off at the time limit, or as soon as it is cancelled (isCanceled), even if a node is
// stuck on a slow query. The runner also stops itself between nodes, so whatever is still in flight
// finishes harmlessly in the background.
function executeWithTimeout(promise, timeoutMs, { isCanceled = null, pollMs = 2000 } = {}) {
  promise.catch(() => {});
  const timers = [];
  const guards = [];

  if (timeoutMs > 0) {
    guards.push(new Promise((_, reject) => {
      const timer = setTimeout(() => reject(createRunTimeoutError(timeoutMs)), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      timers.push(timer);
    }));
  }
  if (typeof isCanceled === 'function') {
    guards.push(new Promise((_, reject) => {
      const timer = setInterval(async () => {
        try {
          if (await isCanceled()) reject(createRunCanceledError());
        } catch (error) {
          // a failed status read must not end the run; try again on the next poll
        }
      }, pollMs);
      if (typeof timer.unref === 'function') timer.unref();
      timers.push(timer);
    }));
  }

  if (!guards.length) return promise;
  return Promise.race([promise, ...guards]).finally(() => {
    timers.forEach((timer) => { clearTimeout(timer); clearInterval(timer); });
  });
}

async function executeRun({ run, runId }) {
  const targetRun = run || await WorkflowRun.findById(runId);
  if (!targetRun) {
    throw new Error('run not found');
  }

  const nodeOutputs = [];
  const tenant = await Tenant.findOne({ tenantId: targetRun.tenantId }).lean();
  targetRun.context.meta = targetRun.context.meta || {};
  applyTenantToMeta(targetRun.context.meta, tenant);
  targetRun.markModified('context');
  const notificationMode = prepareNotificationMode(targetRun.definitionJson);
  const timeoutMs = getRunTimeoutMs();
  // A newer scheduled run replaces this one by setting its status to `canceled` (enqueueRun).
  const isCanceled = async () => {
    const current = await WorkflowRun.findById(targetRun._id).select('status').lean();
    // A run deleted from the database while it executes counts as cancelled too.
    return !current || current.status === 'canceled';
  };
  const runner = new WorkflowRunner(targetRun.definitionJson, {
    shouldStop: isCanceled,
    timeoutMs,
    deadlineAt: timeoutMs > 0 ? Date.now() + timeoutMs : null,
    onNodeResult: payload => nodeOutputs.push(payload),
    workflowResolver: workflowResolverService,
    workflowIdentity: `${targetRun.tenantId}/${targetRun.workflowId}@${targetRun.version}`,
    // State-engine workflows capture sends (filtered per person when delivered). Everything else sends
    // inline, so pause / mute are applied here.
    emailSender: notificationMode.capture?.sender
      || getDefaultRecipientPolicy().createPreferenceAwareSender(
        (message) => require('./emailService').sendEmail(message),
        { tenantId: targetRun.tenantId, workflowId: targetRun.workflowId }
      ),
    telegramSender: notificationMode.capture?.telegramSender
  });

  const startedAt = targetRun.startedAt || new Date();

  try {
    const result = await executeWithTimeout(runner.executeWorkflow(targetRun.context), timeoutMs, { isCanceled });

    // Cancelled while its last node was running: leave it `canceled`, record nothing, notify no one.
    if (await isCanceled()) throw createRunCanceledError();

    targetRun.status = result.status;
    targetRun.context = result.context;
    targetRun.metrics = result.context?.metrics;
    targetRun.executionTrace = result.context?.executionTrace || [];
    targetRun.nodeOutputs = nodeOutputs;
    targetRun.startedAt = startedAt;
    targetRun.finishedAt = new Date();
    targetRun.lastError = undefined;
    targetRun.leaseOwner = null;
    targetRun.leaseExpiresAt = null;

    await targetRun.save();

    await persistFinalInsight({
      tenantId: targetRun.tenantId,
      workflowId: targetRun.workflowId,
      runId: targetRun._id,
      context: result.context
    });

    if (notificationMode.stateEngine) {
      await applyStateEngine({
        run: targetRun,
        result,
        intents: notificationMode.capture.intents,
        telegramIntents: notificationMode.capture.telegramIntents
      });
    }

    const removedRunIds = await pruneWorkflowRuns(
      WorkflowRun,
      targetRun.tenantId,
      targetRun.workflowId,
      4
    );

    if (removedRunIds.length) {
      await Insight.deleteMany({ runId: { $in: removedRunIds } });
    }

    return targetRun;
  } catch (error) {
    // The run was cancelled by a newer one: its status is already `canceled`. Don't overwrite it.
    if (error.code === RUN_CANCELED_CODE) throw error;

    targetRun.status = 'failed';
    targetRun.executionTrace = targetRun.context?.executionTrace || [];
    targetRun.nodeOutputs = nodeOutputs;
    targetRun.markModified('context');
    targetRun.startedAt = startedAt;
    targetRun.finishedAt = new Date();
    targetRun.lastError = error.message;
    targetRun.leaseOwner = null;
    targetRun.leaseExpiresAt = null;
    await targetRun.save();
    throw error;
  }
}

module.exports = {
  resolveWorkflowVersion,
  executeRun,
  applyTenantToMeta,
  prepareNotificationMode,
  applyStateEngine,
  isDryRun,
  executeWithTimeout
};
