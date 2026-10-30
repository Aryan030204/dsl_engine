const {
  claimNextRunnableRun,
  claimRunById,
  startLeaseHeartbeat,
  promoteDeferredRun,
  republishDueRetryRuns,
  bootstrapDispatchRunnableRuns,
  recoverExpiredRunningRuns,
  failTimedOutRuns
} = require('../app/runQueueService');
const { executeRun } = require('../../server/services/workflowExecutionService');
const { getRetryDelayMs } = require('../domain/retryPolicy');
const { RUN_TIMEOUT_CODE, RUN_CANCELED_CODE } = require('../../lib/runTimeout');
const { isNonRetryableError } = require('../../lib/runErrors');
const { getRabbitWorkflowRunQueue } = require('./runQueue/RabbitWorkflowRunQueue');

async function processOne(workerId) {
  const run = await claimNextRunnableRun(workerId);
  if (!run) return null;
  const workflowName = run.definitionJson?.name || 'unknown';
  console.log(`[scheduler-worker] claimed run=${run._id} workflow=${run.workflowId} workflowName="${workflowName}" tenant=${run.tenantId} attempt=${(run.attempt || 0) + 1}/${run.maxAttempts || 3} backend=mongo`);
  return processClaimedRun(run);
}

async function processClaimedRun(run, { execute = executeRun, promote = promoteDeferredRun } = {}) {
  if (!run) return null;

  const heartbeat = startLeaseHeartbeat({
    runId: run._id,
    workerId: run.leaseOwner
  });

  try {
    const workflowName = run.definitionJson?.name || 'unknown';
    console.log(`[scheduler-worker] executing run=${run._id} workflow=${run.workflowId} workflowName="${workflowName}" tenant=${run.tenantId} trigger=${run.triggerType || 'unknown'} attempt=${run.attempt}/${run.maxAttempts || 3}`);
    await execute({ run });
    console.log(`[scheduler-worker] completed run=${run._id} workflow=${run.workflowId} workflowName="${workflowName}" status=${run.status}`);
    await promote(run.tenantId, run.workflowId, run.executionKey);
    return { runId: run._id, status: 'completed' };
  } catch (error) {
    const workflowName = run.definitionJson?.name || 'unknown';
    console.error(`[scheduler-worker] execution failed run=${run._id} workflow=${run.workflowId} workflowName="${workflowName}" attempt=${run.attempt}/${run.maxAttempts || 3} error=${error.message}`);
    // Replaced by a newer scheduled run: already marked `canceled`, and the replacement is queued.
    // Nothing to save, retry or promote.
    if (error.code === RUN_CANCELED_CODE) {
      console.warn(`[scheduler-worker] canceled run=${run._id} workflow=${run.workflowId} workflowName="${workflowName}" (replaced by a newer run)`);
      return { runId: run._id, status: 'canceled' };
    }

    // A run that hit the time limit is final: retrying would just burn the limit again.
    if (error.code === RUN_TIMEOUT_CODE) {
      run.status = 'failed';
      run.finishedAt = new Date();
      run.lastError = error.message;
      run.leaseOwner = null;
      run.leaseExpiresAt = null;
      await run.save();
      console.error(`[scheduler-worker] timed out run=${run._id} workflow=${run.workflowId} workflowName="${workflowName}" lastError=${run.lastError}`);
      await promote(run.tenantId, run.workflowId, run.executionKey);
      return { runId: run._id, status: 'failed' };
    }

    // A misconfigured workflow fails the same way every time: fail it now instead of retrying.
    if (isNonRetryableError(error)) {
      run.status = 'failed';
      run.finishedAt = new Date();
      run.lastError = error.message;
      run.leaseOwner = null;
      run.leaseExpiresAt = null;
      await run.save();
      console.error(`[scheduler-worker] failed run=${run._id} workflow=${run.workflowId} workflowName="${workflowName}" (configuration error, not retried) lastError=${run.lastError}`);
      await promote(run.tenantId, run.workflowId, run.executionKey);
      return { runId: run._id, status: 'failed' };
    }

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
      await promote(run.tenantId, run.workflowId, run.executionKey);
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

// How many runs one worker executes at once (SCHEDULER_WORKER_CONCURRENCY, default 3). Claiming is an
// atomic findOneAndUpdate, so lanes never take the same run, and runs of one workflow are still
// serialised by the overlap policy.
function getWorkerConcurrency() {
  const value = Math.floor(Number(process.env.SCHEDULER_WORKER_CONCURRENCY));
  return Number.isFinite(value) && value >= 1 ? Math.min(value, 20) : 3;
}

// Housekeeping (expired leases, runs past their time limit). It used to run before every 2 s poll;
// it only needs to run every so often.
async function runMaintenance() {
  await recoverExpiredRunningRuns();
  await failTimedOutRuns();
}

async function runLoopMongo({
  workerId, intervalMs = 2000, stopSignal, concurrency = getWorkerConcurrency(), processor = processOne, maintenance = runMaintenance
}) {
  const maintenanceTickMs = Number(process.env.SCHEDULER_MAINTENANCE_TICK_MS) || 30000;
  const maintain = async () => {
    try {
      await maintenance();
    } catch (error) {
      console.error('[scheduler-worker] maintenance failed', error.message);
    }
  };
  await maintain();
  const maintenanceTimer = setInterval(maintain, maintenanceTickMs);
  if (typeof maintenanceTimer.unref === 'function') maintenanceTimer.unref();

  const lane = async () => {
    while (!stopSignal.stopped) {
      try {
        const result = await processor(workerId);
        if (!result) {
          await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
      } catch (error) {
        console.error('[scheduler-worker] iteration failed', error);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, lane));
  } finally {
    clearInterval(maintenanceTimer);
  }
}

async function runLoopRabbit({ workerId, intervalMs = 2000, stopSignal }) {
  const queue = getRabbitWorkflowRunQueue();
  let retryTimer = null;

  try {
    // Best-effort recovery: re-dispatch runnable DB-backed runs when worker starts.
    await bootstrapDispatchRunnableRuns();
    await recoverExpiredRunningRuns();
    await failTimedOutRuns();

    const retryTickMs = Number(process.env.SCHEDULER_RETRY_TICK_MS || 2000);
    retryTimer = setInterval(async () => {
      try {
        await recoverExpiredRunningRuns();
        await failTimedOutRuns();
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
  runLoopMongo,
  getWorkerConcurrency,
  processOne,
  processClaimedRun
};
