const test = require('node:test');
const assert = require('node:assert/strict');

const WorkflowRunner = require('../engine/WorkflowRunner');
const queryExecutor = require('../sql/QueryExecutor');
const { validateWorkflowDefinition } = require('../server/validation/workflowDefinition');

// Workflows built only from validation nodes (no database): each node just passes, so the test sees purely
// how the runner schedules them. The order they ran in is read from the execution trace.
const check = (id, next) => ({
  id,
  type: 'validation',
  checks: [{ field: 'sessions', condition: 'current > 0' }],
  ...(next === undefined ? {} : { next })
});

const freshContext = () => ({
  meta: {
    tenantId: 'T', timezone: 'UTC', metric: 'cvr',
    window: { start: '2026-10-23 00:00:00', end: '2026-10-23 09:00:00' },
    baselineWindow: { start: '2026-10-22 00:00:00', end: '2026-10-22 09:00:00' }
  },
  metrics: { current_sessions: 10, baseline_sessions: 10, current_orders: 1, baseline_orders: 1 },
  breakdowns: {},
  scratch: {},
  executionTrace: []
});

async function run(nodes) {
  const runner = new WorkflowRunner({ workflow_id: 'wf_t', version: '1', name: 't', nodes });
  const result = await runner.executeWorkflow(freshContext());
  const order = result.context.executionTrace.filter((entry) => entry.nodeId && !entry.type.startsWith('workflow_ref')).map((entry) => entry.nodeId);
  return { result, order };
}

test('a node with a single next runs exactly as before', async () => {
  const { result, order } = await run([check('a', 'b'), check('b', 'c'), check('c')]);
  assert.equal(result.status, 'completed');
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('a node can connect to several nodes: all of them run, in the listed order', async () => {
  const { result, order } = await run([check('a', ['b', 'c', 'd']), check('b'), check('c'), check('d')]);
  assert.equal(result.status, 'completed');
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
});

test('each branch is followed to its end before the next branch starts', async () => {
  const { order } = await run([check('a', ['b', 'c']), check('b', 'b2'), check('b2', 'b3'), check('b3'), check('c', 'c2'), check('c2')]);
  assert.deepEqual(order, ['a', 'b', 'b2', 'b3', 'c', 'c2']);
});

test('a node that several branches lead into runs ONCE, after every one of them has finished', async () => {
  // a -> b -> b2 -> join, a -> c -> join : the join must wait for the longer branch
  const { order } = await run([
    check('a', ['b', 'c']), check('b', 'b2'), check('b2', 'join'), check('c', 'join'), check('join', 'end'), check('end')
  ]);
  assert.deepEqual(order, ['a', 'b', 'b2', 'c', 'join', 'end']);
  assert.equal(order.filter((id) => id === 'join').length, 1);
});

test('a join waits even when the shorter branch is listed first', async () => {
  const { order } = await run([
    check('a', ['c', 'b']), check('b', 'b2'), check('b2', 'join'), check('c', 'join'), check('join')
  ]);
  assert.deepEqual(order, ['a', 'c', 'b', 'b2', 'join']);
});

test('branches can fan out again (a tree), and every leaf runs once', async () => {
  const { order } = await run([
    check('a', ['b', 'c']), check('b', ['d', 'e']), check('c', 'f'), check('d'), check('e'), check('f')
  ]);
  assert.deepEqual(order, ['a', 'b', 'd', 'e', 'c', 'f']);
});

test('a branch node that picks one route does not make a join wait for the route it did not take', async () => {
  // fan out to a branch node and to c; the branch node routes to x (not y); join is fed by x, y and c
  const nodes = [
    check('start', ['route', 'c']),
    {
      id: 'route', type: 'branch',
      rules: [{ all: [{ metric: 'current_sessions', op: '>', value: 0 }], then: 'x' }],
      default: { then: 'y' }
    },
    check('x', 'join'), check('y', 'join'), check('c', 'join'), check('join')
  ];
  const { result, order } = await run(nodes);
  assert.equal(result.status, 'completed');
  assert.deepEqual(order.filter((id) => id !== 'route'), ['start', 'x', 'c', 'join']);
  assert.ok(!order.includes('y'));
});

test('a connection back to a node that already ran is still reported as a cycle', async () => {
  await assert.rejects(() => run([check('a', ['b', 'c']), check('b', 'a'), check('c')]), /cycle detected at node: a/);
  await assert.rejects(() => run([check('a', 'a')]), /cycle detected/);
});

// A node that fails: a metric_compare whose query returns no rows.
const failingNode = (id, extra = {}) => ({ id, type: 'metric_compare', metrics: ['orders'], ...extra });
async function withEmptyDatabase(fn) {
  const original = queryExecutor.execute;
  queryExecutor.execute = async () => ({ rows: [] });
  try {
    return await fn();
  } finally {
    queryExecutor.execute = original;
  }
}

test('a failing branch stops the whole run with its error, as a single chain does', async () => {
  await withEmptyDatabase(async () => {
    await assert.rejects(() => run([check('a', ['ok', 'bad']), check('ok'), failingNode('bad')]), /Missing current or baseline data/);
    const { result, order } = await run([
      check('a', ['ok', 'bad', 'never']), check('ok'),
      failingNode('bad', { on_fail: { action: 'terminate', reason: 'not enough data' } }), check('never')
    ]);
    assert.equal(result.status, 'terminated');
    assert.equal(result.reason, 'not enough data');
    assert.deepEqual(order, ['a', 'ok', 'bad']);
  });
});

test('the execution step limit still applies across branches', async () => {
  const runner = new WorkflowRunner({ nodes: [check('a', ['b', 'c']), check('b'), check('c')] }, { maxExecutionSteps: 2 });
  await assert.rejects(() => runner.executeWorkflow(freshContext()), /maximum execution steps/);
});

// ------------------------------------------------------------------ validation

const definition = (nodes) => ({
  workflow_type: 'root_cause_analysis', version: '1',
  trigger: { type: 'alert', alertType: 'x', brandScope: 'global', brandIds: [] },
  nodes
});
const errorsFor = (nodes) => validateWorkflowDefinition(definition(nodes)).errors;

test('validation accepts a next list and a single next', () => {
  assert.deepEqual(errorsFor([check('a', ['b', 'c']), check('b'), check('c')]), []);
  assert.deepEqual(errorsFor([check('a', 'b'), check('b')]), []);
});

test('validation rejects a next list that is empty, repeats, points at itself, at nothing, or is too long', () => {
  const has = (nodes, pattern) => assert.ok(errorsFor(nodes).some((e) => pattern.test(e)), String(pattern));
  has([check('a', []), check('b')], /at least one node id/);
  has([check('a', ['b', 'b']), check('b')], /more than once/);
  has([check('a', ['a', 'b']), check('b')], /cannot connect to itself/);
  has([check('a', ['b', 'ghost']), check('b')], /unknown node ghost/);
  has([check('a', [1, 'b']), check('b')], /only contain node ids/);
  has([check('a', { x: 1 }), check('b')], /node id or a list/);
  const many = Array.from({ length: 11 }, (_, i) => `n${i}`);
  has([check('a', many), ...many.map((id) => check(id))], /at most 10/);
  has([{ id: 'br', type: 'branch', rules: [{ all: [], then: 'b' }], next: ['b', 'c'] }, check('b'), check('c')], /branch node br routes through its rules/);
});

test('the inventory-before-report ordering check follows every branch of a fan-out', () => {
  const inventory = { id: 'inv', type: 'recursive_dimension_breakdown', analysis_mode: 'inventory', next: 'report' };
  const report = {
    id: 'report', type: 'email', format: 'report', to: ['a@b.co'], subject: 's',
    template: { preset: 'performance_report_v1', title: 't', description: 'd', period: { current: 'meta.window', comparison: 'meta.baselineWindow' }, includeInventory: true,
      metrics: [{ label: 'Sessions', value: 'metrics.current_sessions', format: 'integer', icon: 'sessions' }], tables: [] }
  };
  // inventory is one branch of a fan-out and the report comes after it: fine
  const ok = errorsFor([check('start', ['inv', 'other']), inventory, check('other'), report]);
  assert.ok(!ok.some((e) => /inventory/i.test(e)), ok.join('; '));
  // the report is on a different branch that never goes through inventory: rejected
  const bad = errorsFor([check('start', ['inv', 'rep2']), { ...inventory, next: undefined }, { ...report, id: 'rep2' }]);
  assert.ok(bad.some((e) => /inventory/i.test(e)), 'report not after the inventory node');
});
