const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createStateEngineService } = require('../server/services/stateEngineService');
const { createRecipientPolicy } = require('../server/services/recipientPolicy');
const { applyStateEngine, isDryRun } = require('../server/services/workflowExecutionService');
const { createRecordingSender } = require('./helpers/fakeStateStore');

const NOW = new Date('2026-01-01T10:00:00Z');
const stateConfig = {
  enabled: true,
  finding: { metric: 'cvr_delta_pct' },
  thresholds: { normal: -8, critical: -12 },
  cooldown: { triggered_minutes: 240, critical_minutes: 120 },
  // quiet hours cover NOW, to prove they do not gate a test
  quiet_hours: { enabled: true, start: '09:00', end: '12:00' }
};

// A state store that fails the test if anything touches it.
const untouchableStore = new Proxy({}, {
  get: (_target, name) => () => { throw new Error(`testing mode must not touch the state store (${String(name)})`); }
});

function policyWith(preferences) {
  return createRecipientPolicy({
    store: { findByEmails: async (emails) => preferences.filter((pref) => emails.includes(pref.email)) },
    now: () => NOW
  });
}

function harness({ preferences = [] } = {}) {
  const sender = createRecordingSender();
  const telegramCalls = [];
  const service = createStateEngineService({
    store: untouchableStore,
    sender,
    telegramSender: async (message) => { telegramCalls.push(message); return { status: 'sent' }; },
    recipientPolicy: policyWith(preferences),
    now: () => NOW
  });
  const run = (overrides = {}) => service.deliverTestExecution({
    tenantId: 'AJMAL', workflowId: 'wf_1',
    context: { metrics: { cvr_delta_pct: -20 } },
    config: stateConfig,
    intents: [{ to: ['me@x.co'], subject: '[TEST] CVR drop', html: '<p>x</p>', text: 'x' }],
    telegramIntents: [],
    audience: 'me',
    workflowName: 'CVR drop',
    ...overrides
  });
  return { service, sender, telegramCalls, run };
}

test('a test run sends even in quiet hours, and never reads or writes the state store', async () => {
  const { sender, run } = harness();
  const summary = await run();
  assert.equal(summary.delivery_status, 'sent');
  assert.equal(summary.test_mode, true);
  assert.equal(summary.dry_run, false);
  assert.equal(sender.calls.length, 1);
  assert.deepEqual(sender.calls[0].to, ['me@x.co']);
  assert.equal(sender.calls[0].subject, '[TEST] CVR drop');
  assert.equal(summary.finding.severity, 'CRITICAL');
});

test('a finding below the alert threshold is still sent: the workflow\'s own branches decided to email', async () => {
  const { sender, run } = harness();
  const summary = await run({ context: { metrics: { cvr_delta_pct: -2 } } });
  assert.equal(summary.finding.severity, 'NORMAL');
  assert.equal(summary.delivery_status, 'sent');
  assert.equal(sender.calls.length, 1);
});

test('a run whose path reached no email node sends nothing and says so', async () => {
  const { sender, run } = harness();
  const summary = await run({ intents: [] });
  assert.equal(summary.delivery_status, 'none');
  assert.equal(summary.delivery_skipped_reason, 'no_notification_on_path');
  assert.equal(sender.calls.length, 0);
});

test('"only me" ignores pause settings and never messages Telegram; "team" respects pause and sends Telegram', async () => {
  const preferences = [{ email: 'me@x.co', paused: true }, { email: 'off@x.co', paused: true }];

  const me = harness({ preferences });
  const meSummary = await me.run({ audience: 'me', telegramIntents: [{ title: 't', message: 'm', users: [{ username: 'u' }] }] });
  assert.equal(meSummary.delivery_status, 'sent');
  assert.deepEqual(me.sender.calls[0].to, ['me@x.co'], 'paused or not, it is the tester\'s own mailbox');
  assert.equal(me.telegramCalls.length, 0);

  const team = harness({ preferences });
  const teamSummary = await team.run({
    audience: 'team',
    intents: [{ to: ['on@x.co', 'off@x.co'], subject: '[TEST] CVR drop', html: '<p>x</p>', text: 'x' }],
    telegramIntents: [{ title: 't', message: 'm', users: [{ username: 'u' }] }]
  });
  assert.equal(teamSummary.delivery_status, 'sent');
  assert.deepEqual(team.sender.calls[0].to, ['on@x.co'], 'a paused person is still left out of a team test');
  assert.equal(team.telegramCalls.length, 1);
});

test('a failed send is reported, not hidden', async () => {
  const service = createStateEngineService({
    store: untouchableStore,
    sender: async () => ({ status: 'failed', error: 'SMTP down' }),
    recipientPolicy: policyWith([]),
    now: () => NOW
  });
  const summary = await service.deliverTestExecution({
    tenantId: 'T', workflowId: 'w', context: { metrics: { cvr_delta_pct: -20 } }, config: stateConfig,
    intents: [{ to: ['me@x.co'], subject: 's', html: 'h', text: 't' }], audience: 'me'
  });
  assert.equal(summary.delivery_status, 'failed');
  assert.match(summary.delivery_error, /SMTP down/);
});

function fakeRun(fields = {}) {
  return {
    _id: 'r1', tenantId: 'AJMAL', workflowId: 'wf_1', triggerType: 'manual', notifyLive: false,
    definitionJson: { name: 'CVR drop', state_config: stateConfig, nodes: [] },
    saved: 0, async save() { this.saved += 1; },
    ...fields
  };
}

test('a test run is neither a dry run nor a live run: it takes the test path', async () => {
  assert.equal(isDryRun(fakeRun()), true);
  assert.equal(isDryRun(fakeRun({ testMode: true })), false);

  const calls = [];
  const stateEngine = {
    previewExecution: async () => { calls.push('preview'); return {}; },
    processExecution: async () => { calls.push('live'); return { summary: {} }; },
    deliverTestExecution: async (params) => { calls.push(['test', params.audience]); return { test_mode: true }; }
  };
  const run = fakeRun({ testMode: true, testAudience: 'team' });
  await applyStateEngine({ run, result: { context: { meta: {}, metrics: {} } }, intents: [], stateEngine });
  assert.deepEqual(calls, [['test', 'team']]);
  assert.deepEqual(run.stateEvaluation, { test_mode: true });

  const dry = fakeRun();
  await applyStateEngine({ run: dry, result: { context: { meta: {}, metrics: {} } }, intents: [], stateEngine });
  const live = fakeRun({ notifyLive: true });
  await applyStateEngine({ run: live, result: { context: { meta: {}, metrics: {} } }, intents: [], stateEngine });
  assert.deepEqual(calls.slice(1), ['preview', 'live']);
});

test('a scheduled run can never be a test run', async () => {
  const calls = [];
  const stateEngine = {
    previewExecution: async () => ({}),
    processExecution: async () => { calls.push('live'); return { summary: {} }; },
    deliverTestExecution: async () => { calls.push('test'); return {}; }
  };
  const run = fakeRun({ triggerType: 'cron', testMode: true });
  await applyStateEngine({ run, result: { context: { meta: {}, metrics: {} } }, intents: [], stateEngine });
  assert.deepEqual(calls, ['live']);
});

// ---------------------------------------------------------------- the route

async function withRunsApp(user, fn) {
  const queue = require('../scheduler/app/runQueueService');
  const execution = require('../server/services/workflowExecutionService');
  const Tenant = require('../server/models/Tenant');
  const originals = { enqueueRun: queue.enqueueRun, resolve: execution.resolveWorkflowVersion, tenant: Tenant.findOne };
  const enqueued = [];
  queue.enqueueRun = async (params) => { enqueued.push(params); return { enqueued: true, run: { _id: 'run1', status: 'queued' } }; };
  execution.resolveWorkflowVersion = async () => ({ workflowVersion: { definitionJson: { nodes: [] } }, versionId: '1.0' });
  Tenant.findOne = () => ({ lean: async () => ({ tenantId: 'AJMAL', settings: { timezone: 'Asia/Kolkata' } }) });
  delete require.cache[require.resolve('../server/routes/runs')];
  const router = require('../server/routes/runs');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/tenants/:tenantId/workflows', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/tenants/AJMAL/workflows/wf_1/runs?mode=async`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  try {
    await fn({ post, enqueued });
  } finally {
    server.close();
    queue.enqueueRun = originals.enqueueRun;
    execution.resolveWorkflowVersion = originals.resolve;
    Tenant.findOne = originals.tenant;
    delete require.cache[require.resolve('../server/routes/runs')];
  }
}

const runContext = (meta = {}) => ({
  meta: {
    window: { start: '2026-11-03 00:00:00', end: '2026-11-04 00:00:00' },
    baselineWindow: { start: '2026-11-02 00:00:00', end: '2026-11-03 00:00:00' },
    ...meta
  },
  filters: [], metrics: {}, rootCausePath: [], scratch: {}
});

test('the route queues a test run: "me" sends only to the signed-in user and never goes live', async () => {
  await withRunsApp({ email: 'tester@x.co' }, async ({ post, enqueued }) => {
    const res = await post({ context: runContext(), testMode: true, notify: true });
    assert.equal(res.status, 202);
    const queued = enqueued[0];
    assert.equal(queued.testMode, true);
    assert.equal(queued.testAudience, 'me');
    assert.equal(queued.notifyLive, false, 'testing mode supersedes live notifications');
    assert.deepEqual(queued.context.meta.recipientOverride, ['tester@x.co']);

    await post({ context: runContext(), testMode: true, testAudience: 'team' });
    assert.equal(enqueued[1].testAudience, 'team');
    assert.equal(enqueued[1].context.meta.recipientOverride, undefined, 'the real recipients are used');
  });
});

test('the route rejects a bad audience, and a normal run is not a test run', async () => {
  await withRunsApp({ email: 'tester@x.co' }, async ({ post, enqueued }) => {
    const bad = await post({ context: runContext(), testMode: true, testAudience: 'everyone' });
    assert.equal(bad.status, 400);

    const normal = await post({ context: runContext(), notify: true });
    assert.equal(normal.status, 202);
    assert.equal(enqueued[0].testMode, false);
    assert.equal(enqueued[0].notifyLive, true);
  });
});

test('a rerun of a test run does not inherit its "only me" recipients', async () => {
  await withRunsApp({ email: 'tester@x.co' }, async ({ post, enqueued }) => {
    const res = await post({ context: runContext({ testRun: true, recipientOverride: ['tester@x.co'] }), rerun: true });
    assert.equal(res.status, 202);
    assert.equal(enqueued[0].context.meta.recipientOverride, undefined);
    assert.equal(enqueued[0].context.meta.testRun, undefined);
  });
});

test('rerunning a test run as a test run keeps its settings: "me" goes to the user again, "team" keeps the real recipients', async () => {
  await withRunsApp({ email: 'tester@x.co' }, async ({ post, enqueued }) => {
    const previous = runContext({ testRun: true, recipientOverride: ['tester@x.co'] });

    await post({ context: previous, rerun: true, testMode: true, testAudience: 'me' });
    assert.equal(enqueued[0].testMode, true);
    assert.equal(enqueued[0].testAudience, 'me');
    assert.deepEqual(enqueued[0].context.meta.recipientOverride, ['tester@x.co']);
    assert.equal(enqueued[0].context.meta.testRun, true);

    await post({ context: previous, rerun: true, testMode: true, testAudience: 'team' });
    assert.equal(enqueued[1].testAudience, 'team');
    assert.equal(enqueued[1].context.meta.recipientOverride, undefined);
    assert.equal(enqueued[1].notifyLive, false);
  });
});
