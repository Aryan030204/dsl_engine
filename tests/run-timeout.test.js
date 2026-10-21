const test = require('node:test');
const assert = require('node:assert/strict');

const { getRunTimeoutMs, runTimeoutMessage, createRunTimeoutError, RUN_TIMEOUT_CODE, DEFAULT_RUN_TIMEOUT_MS } = require('../lib/runTimeout');
const { executeWithTimeout } = require('../server/services/workflowExecutionService');
const { failTimedOutRuns } = require('../scheduler/app/runQueueService');
const WorkflowRunner = require('../engine/WorkflowRunner');

test('the run time limit defaults to 10 minutes and can be configured or disabled', () => {
  assert.equal(DEFAULT_RUN_TIMEOUT_MS, 600000);
  assert.equal(getRunTimeoutMs({}), 600000);
  assert.equal(getRunTimeoutMs({ WORKFLOW_RUN_TIMEOUT_MS: '' }), 600000);
  assert.equal(getRunTimeoutMs({ WORKFLOW_RUN_TIMEOUT_MS: '120000' }), 120000);
  assert.equal(getRunTimeoutMs({ WORKFLOW_RUN_TIMEOUT_MS: '0' }), 0);
  assert.equal(getRunTimeoutMs({ WORKFLOW_RUN_TIMEOUT_MS: 'abc' }), 600000);
  assert.equal(getRunTimeoutMs({ WORKFLOW_RUN_TIMEOUT_MS: '-5' }), 600000);
  assert.equal(runTimeoutMessage(600000), 'Run exceeded the 10 minute limit and was stopped');
  assert.equal(createRunTimeoutError(600000).code, RUN_TIMEOUT_CODE);
});

test('executeWithTimeout cuts off a stuck run, passes through a normal one, and swallows late failures', async () => {
  assert.deepEqual(await executeWithTimeout(Promise.resolve({ status: 'completed' }), 200), { status: 'completed' });
  assert.deepEqual(await executeWithTimeout(Promise.resolve({ status: 'completed' }), 0), { status: 'completed' });
  await assert.rejects(executeWithTimeout(Promise.reject(new Error('node failed')), 200), /node failed/);

  // a node that never returns: the run is cut off at the limit with the dedicated error code
  const stuck = new Promise(() => {});
  await assert.rejects(executeWithTimeout(stuck, 30), (error) => error.code === RUN_TIMEOUT_CODE && /limit/.test(error.message));

  // the in-flight work failing after the cut-off must not become an unhandled rejection
  let rejectLate;
  const late = new Promise((_, reject) => { rejectLate = reject; });
  await assert.rejects(executeWithTimeout(late, 20), (error) => error.code === RUN_TIMEOUT_CODE);
  rejectLate(new Error('too late'));
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test('the runner stops between nodes once the deadline has passed', async () => {
  const definition = {
    workflow_id: 'wf_t', name: 't', version: '1', workflow_type: 'root_cause_analysis',
    nodes: [
      { id: 'a', type: 'insight', template: 'first', next: 'b' },
      { id: 'b', type: 'insight', template: 'second' }
    ]
  };
  const context = () => ({
    meta: {
      tenantId: 'T', metric: 'cvr', timezone: 'UTC',
      window: { start: '2026-10-20T00:00:00.000Z', end: '2026-10-21T00:00:00.000Z' },
      baselineWindow: { start: '2026-10-19T00:00:00.000Z', end: '2026-10-20T00:00:00.000Z' }
    },
    metrics: {}, filters: [], breakdowns: {}, rootCausePath: [], scratch: {}
  });

  await assert.rejects(
    new WorkflowRunner(definition, { deadlineAt: Date.now() - 1, timeoutMs: 600000 }).executeWorkflow(context()),
    (error) => error.code === RUN_TIMEOUT_CODE
  );
  const ok = await new WorkflowRunner(definition, { deadlineAt: Date.now() + 60000, timeoutMs: 600000 }).executeWorkflow(context());
  assert.equal(ok.status, 'completed');
});

function fakeRunModel(runs) {
  return {
    async findOneAndUpdate(filter, update) {
      const cutoff = filter.startedAt.$lt;
      const match = runs
        .filter((run) => run.status === filter.status && run.startedAt < cutoff)
        .sort((a, b) => a.startedAt - b.startedAt)[0];
      if (!match) return null;
      Object.assign(match, update.$set);
      return match;
    }
  };
}

test('failTimedOutRuns fails only runs older than the limit and promotes the next deferred run', async () => {
  const now = new Date('2026-10-21T10:00:00Z');
  const minutesAgo = (m) => new Date(now.getTime() - m * 60000);
  const runs = [
    { _id: 'old1', tenantId: 'AJMAL', workflowId: 'wf1', executionKey: 'AJMAL:wf1', status: 'running', startedAt: minutesAgo(11000) },
    { _id: 'old2', tenantId: 'TMC', workflowId: 'wf2', executionKey: 'TMC:wf2', status: 'running', startedAt: minutesAgo(11) },
    { _id: 'fresh', tenantId: 'TMC', workflowId: 'wf3', executionKey: 'TMC:wf3', status: 'running', startedAt: minutesAgo(9) },
    { _id: 'queued', tenantId: 'TMC', workflowId: 'wf4', executionKey: 'TMC:wf4', status: 'queued', startedAt: minutesAgo(500) }
  ];
  const promoted = [];
  const result = await failTimedOutRuns({
    timeoutMs: 600000, now, model: fakeRunModel(runs),
    promote: async (tenantId, workflowId, executionKey) => { promoted.push(`${tenantId}/${workflowId}/${executionKey}`); }
  });

  assert.equal(result.count, 2);
  assert.deepEqual(result.failed.map((r) => r.runId), ['old1', 'old2']);
  const byId = Object.fromEntries(runs.map((run) => [run._id, run]));
  assert.equal(byId.old1.status, 'failed');
  assert.equal(byId.old1.lastError, 'Run exceeded the 10 minute limit and was stopped');
  assert.equal(byId.old1.leaseOwner, null);
  assert.equal(byId.fresh.status, 'running');
  assert.equal(byId.queued.status, 'queued');
  assert.deepEqual(promoted, ['AJMAL/wf1/AJMAL:wf1', 'TMC/wf2/TMC:wf2']);

  // disabled limit: nothing is touched
  assert.equal((await failTimedOutRuns({ timeoutMs: 0, now, model: fakeRunModel(runs) })).count, 0);
});
