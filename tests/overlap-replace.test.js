const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateOverlap } = require('../scheduler/domain/overlapPolicy');
const { enqueueRun } = require('../scheduler/app/runQueueService');
const { executeWithTimeout } = require('../server/services/workflowExecutionService');
const { RUN_CANCELED_CODE } = require('../lib/runTimeout');
const WorkflowRunner = require('../engine/WorkflowRunner');
const WorkflowSchedule = require('../server/models/WorkflowSchedule');

const run = (status) => ({ _id: `r-${status}`, status });

test('every overlap policy decides as documented', () => {
  // replace_running: anything running or waiting is replaced; an idle workflow just queues
  assert.deepEqual(evaluateOverlap({ overlapPolicy: 'replace_running' }), { action: 'queue' });
  assert.deepEqual(evaluateOverlap({ overlapPolicy: 'replace_running', activeRun: run('running') }), { action: 'replace' });
  assert.deepEqual(evaluateOverlap({ overlapPolicy: 'replace_running', pendingRun: run('queued') }), { action: 'replace' });
  assert.deepEqual(evaluateOverlap({ overlapPolicy: 'replace_running', activeRun: run('running'), pendingRun: run('deferred') }), { action: 'replace' });

  // the existing policies are unchanged
  assert.deepEqual(evaluateOverlap({ overlapPolicy: 'queue_one_pending', activeRun: run('running') }), { action: 'defer' });
  assert.deepEqual(evaluateOverlap({ overlapPolicy: 'queue_one_pending', activeRun: run('running'), pendingRun: run('deferred') }), { action: 'skip', reason: 'pending_run_exists' });
  assert.deepEqual(evaluateOverlap({ overlapPolicy: 'skip_if_running', activeRun: run('running') }), { action: 'skip', reason: 'active_run_exists' });
  assert.deepEqual(evaluateOverlap({ overlapPolicy: 'allow_parallel', activeRun: run('running') }), { action: 'queue' });
});

test('new schedules cancel the previous run by default', () => {
  assert.equal(WorkflowSchedule.schema.path('overlapPolicy').defaultValue, 'replace_running');
  assert.ok(WorkflowSchedule.schema.path('overlapPolicy').enumValues.includes('replace_running'));
});

function fakeRunModel({ active = null, pending = null } = {}) {
  const calls = { updateMany: [], created: [] };
  return {
    calls,
    findOne(query) {
      const wantsActive = query.status.$in.includes('running');
      return { sort: async () => (wantsActive ? active : pending) };
    },
    async updateMany(filter, update) {
      calls.updateMany.push({ filter, update });
      return { modifiedCount: (active ? 1 : 0) + (pending ? 1 : 0) };
    },
    async create(doc) {
      calls.created.push(doc);
      return { _id: 'new-run', ...doc };
    }
  };
}

const params = (model, overlapPolicy) => ({
  tenantId: 'AJMAL', workflowId: 'wf_1', version: 'v1', context: { meta: {} }, definitionJson: {},
  triggerType: 'cron', triggerRef: 's1', overlapPolicy, model
});

test('a due cron run cancels the run still going (and anything waiting) and starts straight away', async () => {
  const model = fakeRunModel({ active: run('running'), pending: run('deferred') });
  const originalWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await enqueueRun(params(model, 'replace_running'));
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.enqueued, true);
  assert.equal(result.replacedCount, 2);
  assert.equal(model.calls.updateMany.length, 1);
  const { filter, update } = model.calls.updateMany[0];
  assert.equal(filter.tenantId, 'AJMAL');
  assert.equal(filter.workflowId, 'wf_1');
  assert.equal(filter.executionKey, 'AJMAL:wf_1');
  assert.deepEqual([...filter.status.$in].sort(), ['deferred', 'queued', 'retrying', 'running']);
  assert.equal(update.$set.status, 'canceled');
  assert.equal(update.$set.leaseOwner, null);
  assert.match(update.$set.lastError, /replaced by a newer scheduled run/);
  // the new run is queued right away, not deferred behind the old one
  assert.equal(model.calls.created[0].status, 'queued');
});

test('with nothing running there is nothing to cancel; other policies still wait or skip', async () => {
  const idle = fakeRunModel();
  const result = await enqueueRun(params(idle, 'replace_running'));
  assert.equal(result.replacedCount, 0);
  assert.equal(idle.calls.updateMany.length, 0);
  assert.equal(idle.calls.created[0].status, 'queued');

  const busy = fakeRunModel({ active: run('running') });
  const waits = await enqueueRun(params(busy, 'queue_one_pending'));
  assert.equal(busy.calls.created[0].status, 'deferred');
  assert.equal(busy.calls.updateMany.length, 0, 'queue_one_pending never cancels');
  assert.equal(waits.replacedCount, 0);

  const skip = await enqueueRun(params(fakeRunModel({ active: run('running') }), 'skip_if_running'));
  assert.equal(skip.enqueued, false);
});

test('a cancelled run is cut off promptly, even while a node is stuck', async () => {
  let canceled = false;
  setTimeout(() => { canceled = true; }, 30);
  const stuck = new Promise(() => {});
  const started = Date.now();
  await assert.rejects(
    executeWithTimeout(stuck, 0, { isCanceled: async () => canceled, pollMs: 10 }),
    (error) => error.code === RUN_CANCELED_CODE
  );
  assert.ok(Date.now() - started < 1000);

  // not cancelled: the run's own result comes through, and the poller is cleaned up
  assert.deepEqual(await executeWithTimeout(Promise.resolve({ status: 'completed' }), 0, { isCanceled: async () => false, pollMs: 10 }), { status: 'completed' });
  // a failing status read never ends the run
  assert.deepEqual(await executeWithTimeout(new Promise((resolve) => setTimeout(() => resolve({ status: 'completed' }), 40)), 0, {
    isCanceled: async () => { throw new Error('mongo blip'); }, pollMs: 10
  }), { status: 'completed' });
});

test('the runner stops before the next node once the run is cancelled, so nothing further is sent', async () => {
  const sent = [];
  const definition = {
    workflow_id: 'wf_t', name: 't', version: '1', workflow_type: 'root_cause_analysis',
    nodes: [
      { id: 'a', type: 'insight', template: 'first', next: 'b' },
      { id: 'b', type: 'insight', template: 'second', email: { enabled: true, to: ['x@example.com'], subject: 's' } }
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

  let checks = 0;
  const runner = new WorkflowRunner(definition, {
    emailSender: async (message) => { sent.push(message); return { status: 'sent' }; },
    shouldStop: async () => { checks += 1; return checks > 1; } // cancelled after the first node
  });
  await assert.rejects(runner.executeWorkflow(context()), (error) => error.code === RUN_CANCELED_CODE);
  assert.equal(sent.length, 0, 'the email node never ran');

  const ok = await new WorkflowRunner(definition, { shouldStop: async () => false, emailSender: async () => ({ status: 'sent' }) }).executeWorkflow(context());
  assert.equal(ok.status, 'completed');
});
