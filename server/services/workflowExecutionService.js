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
async function applyStateEngine({ run, result, intents, telegramIntents = [], stateEngine = getDefaultStateEngineService() }) {
  const definition = run.definitionJson || {};
  const meta = result.context?.meta || {};
  try {
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

async function executeRun({ run, runId }) {
  const targetRun = run || await WorkflowRun.findById(runId);
  if (!targetRun) {
    throw new Error('run not found');
  }

  const nodeOutputs = [];
  const tenant = await Tenant.findOne({ tenantId: targetRun.tenantId }).lean();
  targetRun.context.meta = targetRun.context.meta || {};
  if (!targetRun.context.meta.brandName && tenant?.name) {
    targetRun.context.meta.brandName = tenant.name;
  }
  // Report emails format `currency` cards/columns in the tenant's currency. Always
  // taken from the tenant's current setting (never from the run's saved context),
  // so a rerun of an older run picks up a currency changed since.
  if (tenant?.settings?.currency) {
    targetRun.context.meta.currency = tenant.settings.currency;
  }
  if (!targetRun.context.meta.emailBranding && tenant?.settings?.emailBranding) {
    targetRun.context.meta.emailBranding = { ...tenant.settings.emailBranding };
  }
  targetRun.markModified('context');
  const notificationMode = prepareNotificationMode(targetRun.definitionJson);
  const runner = new WorkflowRunner(targetRun.definitionJson, {
    onNodeResult: payload => nodeOutputs.push(payload),
    workflowResolver: workflowResolverService,
    workflowIdentity: `${targetRun.tenantId}/${targetRun.workflowId}@${targetRun.version}`,
    emailSender: notificationMode.capture?.sender,
    telegramSender: notificationMode.capture?.telegramSender
  });

  const startedAt = targetRun.startedAt || new Date();

  try {
    const result = await runner.executeWorkflow(targetRun.context);

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
  prepareNotificationMode,
  applyStateEngine
};
