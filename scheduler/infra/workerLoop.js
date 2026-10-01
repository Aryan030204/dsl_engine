const {
  claimNextRunnableRun,
  claimRunById,
  startLeaseHeartbeat,
  promoteDeferredRun,
  republishDueRetryRuns,
  bootstrapDispatchRunnableRuns,
  recoverExpiredRunningRuns
} = require('../app/runQueueService');
const { executeRun } = require('../../server/services/workflowExecutionService');
const { getRetryDelayMs } = require('../domain/retryPolicy');
const { getRabbitWorkflowRunQueue } = require('./runQueue/RabbitWorkflowRunQueue');

async function processOne(workerId) {
  const run = await claimNextRunnableRun(workerId);
  if (!run) return null;
  const workflowName = run.definitionJson?.name || 'unknown';
  console.log(`[scheduler-worker] claimed run=${run._id} workflow=${run.workflowId} workflowName="${workflowName}" tenant=${run.tenantId} attempt=${(run.attempt || 0) + 1}/${run.maxAttempts || 3} backend=mongo`);
  return processClaimedRun(run);
}

async function processClaimedRun(run) {
  if (!run) return null;

  const heartbeat = startLeaseHeartbeat({
    runId: run._id,
    workerId: run.leaseOwner
  });

  try {
    const workflowName = run.definitionJson?.name || 'unknown';
    console.log(`[scheduler-worker] executing run=${run._id} workflow=${run.workflowId} workflowName="${workflowName}" tenant=${run.tenantId} trigger=${run.triggerType || 'unknown'} attempt=${run.attempt}/${run.maxAttempts || 3}`);
    await executeRun({ run });
    console.log(`[scheduler-worker] completed run=${run._id} workflow=${run.workflowId} workflowName="${workflowName}" status=${run.status}`);
    await promoteDeferredRun(run.tenantId, run.workflowId, run.executionKey);
    return { runId: run._id, status: 'completed' };
  } catch (error) {
    const workflowName = run.definitionJson?.name || 'unknown';
    console.error(`[scheduler-worker] execution failed run=${run._id} workflow=${run.workflowId} workflowName="${workflowName}" attempt=${run.attempt}/${run.maxAttempts || 3} error=${error.message}`);
    const delayMs = getRetryDelayMs(
      { maxAttempts: run.maxAttempts || 3, backoffSeconds: [30, 120, 600] },
      run.attempt
    );

    if (delayMs === null) {
      run.status = 'dead_letter';
      run.finishedAt = new Date();
      run.lastError = error.message;
      run.leaseOwner = null;
      run.leaseExpiresAt = null;
      await run.save();
      console.error(`[scheduler-worker] dead-lettered run=${run._id} workflow=${run.workflowId} workflowName="${workflowName}" lastError=${run.lastError}`);
      await promoteDeferredRun(run.tenantId, run.workflowId, run.executionKey);
      return { runId: run._id, status: 'dead_letter' };
    }

    run.status = 'retrying';
    run.nextRetryAt = new Date(Date.now() + delayMs);
    run.lastError = error.message;
    run.finishedAt = null;
    run.leaseOwner = null;
    run.leaseExpiresAt = null;
    await run.save();
    console.warn(`[scheduler-worker] scheduled retry run=${run._id} workflow=${run.workflowId} workflowName="${workflowName}" nextRetryAt=${run.nextRetryAt.toISOString()} delayMs=${delayMs}`);
    return { runId: run._id, status: 'retrying' };
  } finally {
    await heartbeat.stop();
  }
}

function useRabbitRunQueue() {
  return process.env.SCHEDULER_RUN_QUEUE_BACKEND === 'rabbit';
}

async function runLoopMongo({ workerId, intervalMs = 2000, stopSignal }) {
  while (!stopSignal.stopped) {
    try {
      await recoverExpiredRunningRuns();
      const result = await processOne(workerId);
      if (!result) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    } catch (error) {
      console.error('[scheduler-worker] iteration failed', error);
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
}

async function runLoopRabbit({ workerId, intervalMs = 2000, stopSignal }) {
  const queue = getRabbitWorkflowRunQueue();
  let retryTimer = null;

  try {
    // Best-effort recovery: re-dispatch runnable DB-backed runs when worker starts.
    await bootstrapDispatchRunnableRuns();
    await recoverExpiredRunningRuns();

    const retryTickMs = Number(process.env.SCHEDULER_RETRY_TICK_MS || 2000);
    retryTimer = setInterval(async () => {
      try {
        await recoverExpiredRunningRuns();
        await republishDueRetryRuns();
      } catch (error) {
        console.error('[scheduler-worker] retry republish failed', error.message);
      }
    }, retryTickMs);

    await queue.consumeRuns({
      stopSignal,
      handler: async ({ runId }) => {
        const run = await claimRunById(runId, workerId);
        if (!run) {
          console.log(`[scheduler-worker] skipped rabbit message run=${runId} reason=not_claimable_or_missing`);
          return;
        }
        const workflowName = run.definitionJson?.name || 'unknown';
        console.log(`[scheduler-worker] claimed run=${run._id} workflow=${run.workflowId} workflowName="${workflowName}" tenant=${run.tenantId} attempt=${run.attempt}/${run.maxAttempts || 3} backend=rabbit`);
        await processClaimedRun(run);
      }
    });
  } catch (error) {
    console.error(`[scheduler-worker] RabbitMQ unavailable; falling back to Mongo polling error=${error.message}`);
    await runLoopMongo({ workerId, intervalMs, stopSignal });
  } finally {
    clearInterval(retryTimer);
    await queue.close();
  }
}

async function runLoop({ workerId, intervalMs = 2000, stopSignal }) {
  if (useRabbitRunQueue()) {
    return runLoopRabbit({ workerId, intervalMs, stopSignal });
  }
  return runLoopMongo({ workerId, intervalMs, stopSignal });
}

module.exports = {
  runLoop,
  processOne,
  processClaimedRun
};
