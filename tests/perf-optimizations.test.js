const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

// The executor builds its pools with mysql2; hand it a fake pool before it is loaded.
const queries = [];
let failNext = false;
mysql.createPool = () => ({
  pool: { on() {} },
  end: async () => {},
  query: async ({ sql }, params) => {
    queries.push({ sql, params });
    const n = queries.length;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (failNext) { failNext = false; throw new Error('boom'); }
    return [[{ n, sql_text: sql }]];
  }
});

const queryExecutor = require('../sql/QueryExecutor');
const recursiveDimensionBreakdownNode = require('../nodes/RecursiveDimensionBreakdownNode');
const { loadLatestDefinitions } = require('../server/services/workflowResolverService');
const { runLoopMongo, getWorkerConcurrency } = require('../scheduler/infra/workerLoop');
const WorkflowRunner = require('../engine/WorkflowRunner');

const spec = (sql, params = []) => ({ sql, params, meta: { tenantId: 'TMC', type: 't' } });

test('inside a run, identical queries (even concurrent ones) hit the database once', async () => {
  queries.length = 0;
  await queryExecutor.runWithQueryCache(async () => {
    const [a, b, c] = await Promise.all([
      queryExecutor.execute(spec('SELECT 1', [1])),
      queryExecutor.execute(spec('SELECT 1', [1])),
      queryExecutor.execute(spec('SELECT 1', [2]))
    ]);
    assert.equal(a.rows[0].n, b.rows[0].n, 'same result for identical queries');
    assert.notEqual(a.rows[0].n, c.rows[0].n, 'different parameters are a different query');
    await queryExecutor.execute(spec('SELECT 1', [1]));
    assert.equal(queries.length, 2);
    assert.equal(queryExecutor.getQueryStats().queryCount, 2);
  });
});

test('each caller gets its own copy of the rows', async () => {
  await queryExecutor.runWithQueryCache(async () => {
    const first = await queryExecutor.execute(spec('SELECT copy'));
    first.rows[0].n = 'changed';
    const second = await queryExecutor.execute(spec('SELECT copy'));
    assert.notEqual(second.rows[0].n, 'changed');
  });
});

test('a failed query is not remembered, and noCache / no run means no caching', async () => {
  queries.length = 0;
  await queryExecutor.runWithQueryCache(async () => {
    failNext = true;
    await assert.rejects(queryExecutor.execute(spec('SELECT fail')), /boom/);
    await queryExecutor.execute(spec('SELECT fail'));
    await queryExecutor.execute({ ...spec('SELECT nc'), meta: { tenantId: 'TMC', noCache: true } });
    await queryExecutor.execute({ ...spec('SELECT nc'), meta: { tenantId: 'TMC', noCache: true } });
    assert.equal(queries.length, 4);
  });
  queries.length = 0;
  await queryExecutor.execute(spec('SELECT plain'));
  await queryExecutor.execute(spec('SELECT plain'));
  assert.equal(queries.length, 2);
  assert.equal(queryExecutor.getQueryStats(), null);
});

test('two runs never share cached results', async () => {
  queries.length = 0;
  await Promise.all([
    queryExecutor.runWithQueryCache(() => queryExecutor.execute(spec('SELECT run'))),
    queryExecutor.runWithQueryCache(() => queryExecutor.execute(spec('SELECT run')))
  ]);
  assert.equal(queries.length, 2);
});

const WINDOW = { start: '2026-10-26 00:00:00', end: '2026-10-27 00:00:00' };
const BASE = { start: '2026-10-25 00:00:00', end: '2026-10-26 00:00:00' };
const row = (value, current, baseline) => ({
  dimension_value: value, product_title: value,
  current_sessions: 1000, baseline_sessions: 1000, current_orders: current, baseline_orders: baseline
});

test('nested breakdown gives the same evidence in parallel as one candidate at a time', async () => {
  const original = queryExecutor.execute;
  const sources = ['a', 'b', 'c'];
  let inFlight = 0;
  let peak = 0;
  queryExecutor.execute = async (query) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    // later candidates answer first, so completion order differs from candidate order
    const owner = (query.params || []).find((p) => sources.includes(p));
    await new Promise((resolve) => setTimeout(resolve, owner ? (4 - sources.indexOf(owner)) * 15 : 5));
    inFlight -= 1;
    if (query.meta.dimension === 'utm_source') {
      return { rows: sources.map((s, i) => row(s, 10, 30 - i)) };
    }
    return { rows: [row(`${owner}-1`, 5, 20), row(`${owner}-2`, 6, 15)] };
  };
  const run = () => recursiveDimensionBreakdownNode({
    id: 'nested', dimensions: ['utm_source', 'product_id'], base_metric: 'orders', filter_mode: 'drop',
    output_key: 'out', stop_conditions: { max_depth: 2, top_k: 3, min_sessions: 0 }
  }, { meta: { tenantId: 'TMC', timezone: 'UTC', window: WINDOW, baselineWindow: BASE }, metrics: {}, filters: [], breakdowns: {}, scratch: {} });
  const saved = process.env.BREAKDOWN_CONCURRENCY;
  try {
    process.env.BREAKDOWN_CONCURRENCY = '1';
    peak = 0;
    const sequential = await run();
    assert.equal(peak, 1, 'one query at a time');
    process.env.BREAKDOWN_CONCURRENCY = '4';
    peak = 0;
    const parallel = await run();
    assert.ok(peak > 1, 'queries overlapped');
    assert.equal(sequential.status, 'pass');
    assert.ok(sequential.delta.breakdowns.out.length >= 6, 'children were found');
    assert.deepEqual(parallel.delta, sequential.delta);
  } finally {
    if (saved === undefined) delete process.env.BREAKDOWN_CONCURRENCY;
    else process.env.BREAKDOWN_CONCURRENCY = saved;
    queryExecutor.execute = original;
  }
});

test('latest definitions are loaded with one query and matched back per workflow', async () => {
  let calls = 0;
  const model = {
    find: (query) => {
      calls += 1;
      assert.equal(query.$or.length, 3);
      return {
        lean: async () => ([
          { scope: 'tenant', workflowId: 'wf_a', version: '1.2', definitionJson: { name: 'A' } },
          { scope: 'global', workflowId: 'wf_g', version: '2.0', definitionJson: { name: 'G' } }
        ])
      };
    }
  };
  const loaded = await loadLatestDefinitions([
    { workflowId: 'wf_a', latestVersion: '1.2', tenantIds: ['TMC'] },
    { workflowId: 'wf_g', latestVersion: '2.0', scope: 'global', tenantId: null },
    { workflowId: 'wf_missing', latestVersion: '1.0', tenantIds: ['TMC'] }
  ], model);
  assert.equal(calls, 1);
  assert.deepEqual(loaded.map((item) => item.definition && item.definition.name), ['A', 'G', null]);
  assert.deepEqual(await loadLatestDefinitions([], model), []);
});

test('the worker runs several runs at once, drains on stop, and does housekeeping on its own tick', async () => {
  const stopSignal = { stopped: false };
  let active = 0;
  let peak = 0;
  let handled = 0;
  let maintenance = 0;
  const processor = async () => {
    if (handled >= 6) { stopSignal.stopped = true; return null; }
    handled += 1;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return { status: 'completed' };
  };
  await runLoopMongo({ workerId: 'w', intervalMs: 5, stopSignal, concurrency: 3, processor, maintenance: async () => { maintenance += 1; } });
  assert.equal(handled, 6);
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.equal(maintenance, 1, 'once at start, not before every poll');
});

test('worker concurrency comes from the environment, default 3', () => {
  const saved = process.env.SCHEDULER_WORKER_CONCURRENCY;
  try {
    delete process.env.SCHEDULER_WORKER_CONCURRENCY;
    assert.equal(getWorkerConcurrency(), 3);
    process.env.SCHEDULER_WORKER_CONCURRENCY = '1';
    assert.equal(getWorkerConcurrency(), 1);
    process.env.SCHEDULER_WORKER_CONCURRENCY = 'junk';
    assert.equal(getWorkerConcurrency(), 3);
  } finally {
    if (saved === undefined) delete process.env.SCHEDULER_WORKER_CONCURRENCY;
    else process.env.SCHEDULER_WORKER_CONCURRENCY = saved;
  }
});

test('every node records its duration and the queries it sent', async () => {
  queries.length = 0;
  const definition = {
    workflow_id: 'wf_t', name: 't', version: '1', workflow_type: 'root_cause_analysis',
    nodes: [{ id: 'a', type: 'insight', template: 'first', next: 'b' }, { id: 'b', type: 'insight', template: 'second' }]
  };
  const context = { meta: { tenantId: 'T', timezone: 'UTC', window: WINDOW, baselineWindow: BASE }, metrics: {}, filters: [], breakdowns: {}, rootCausePath: [], scratch: {} };
  const outputs = [];
  const runner = new WorkflowRunner(definition, { onNodeResult: (payload) => outputs.push(payload) });
  const result = await queryExecutor.runWithQueryCache(() => runner.executeWorkflow(context));
  for (const entry of result.context.executionTrace) {
    assert.equal(typeof entry.durationMs, 'number');
    assert.equal(entry.queryCount, 0);
  }
  assert.ok(outputs.every((output) => typeof output.durationMs === 'number'));
});
