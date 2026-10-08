const test = require('node:test');
const assert = require('node:assert/strict');

const WorkflowRunner = require('../engine/WorkflowRunner');
const { prepareNotificationMode } = require('../server/services/workflowExecutionService');
const { createStateEngineService } = require('../server/services/stateEngineService');
const { validateWorkflowDefinition } = require('../server/validation/workflowDefinition');
const { createFakeStateStore } = require('./helpers/fakeStateStore');

const stateConfig = {
  enabled: true,
  finding: { metric: 'cvr_delta_pct' },
  thresholds: { normal: -15, critical: -25 },
  cooldown: { triggered_minutes: 60, critical_minutes: 30 },
  quiet_hours: { enabled: false, start: '23:00', end: '07:00' }
};

function messagingNode(channels = { email: true, telegram: true }, overrides = {}) {
  return {
    id: 'notify',
    type: 'messaging',
    channels,
    format: 'insight',
    subject: 'CVR alert',
    template: { insightSource: 'scratch.finalInsight' },
    email: { to: ['ops@example.com'] },
    telegram: { users: [{ username: 'ops_lead' }], severity: 'critical' },
    ...overrides
  };
}

function definition(nodes, overrides = {}) {
  return {
    workflow_type: 'root_cause_analysis',
    version: '1.0',
    name: 'CVR drop',
    trigger: { type: 'alert', alertType: 'cvr_drop', brandScope: 'single', brandIds: ['t1'] },
    nodes,
    ...overrides
  };
}

function runContext(cvrDeltaPct = -17) {
  return {
    meta: { tenantId: 't1', brandName: 'Brand', timezone: 'UTC' },
    metrics: { cvr_delta_pct: cvrDeltaPct },
    breakdowns: {},
    filters: [],
    rootCausePath: [],
    scratch: { finalInsight: { summary: 'CVR dropped', details: [] } }
  };
}

function recordingSender(statuses = []) {
  const calls = [];
  const sender = async (message) => {
    calls.push(message);
    const status = statuses.length ? statuses.shift() : 'sent';
    return status === 'sent' ? { status: 'sent', messageId: `m${calls.length}` } : { status, error: `${status} delivery` };
  };
  sender.calls = calls;
  return sender;
}

test('with alert state on, a messaging node captures email and Telegram and the run completes', async () => {
  const def = definition([messagingNode()], { state_config: stateConfig });
  const mode = prepareNotificationMode(def);
  assert.equal(mode.stateEngine, true);

  const runner = new WorkflowRunner(def, { emailSender: mode.capture.sender, telegramSender: mode.capture.telegramSender });
  const result = await runner.executeWorkflow(runContext());

  assert.equal(result.status, 'completed');
  assert.equal(mode.capture.intents.length, 1);
  assert.deepEqual(mode.capture.intents[0].to, ['ops@example.com']);
  assert.equal(mode.capture.telegramIntents.length, 1);
  const telegramIntent = mode.capture.telegramIntents[0];
  assert.equal(telegramIntent.title, 'CVR alert');
  assert.equal(telegramIntent.severity, 'critical');
  assert.deepEqual(telegramIntent.users, [{ username: 'ops_lead' }]);
  assert.match(telegramIntent.message, /CVR dropped/);
  // The rendered report pages are captured too, so they survive the alert-state hold.
  assert.match(telegramIntent.images[0], /^data:image\/jpeg;base64,/);
  assert.equal(result.context.scratch.messagingDeliveries.notify.telegram.status, 'deferred');
});

function setup({ emailStatuses, telegramStatuses, quiet = false } = {}) {
  const store = createFakeStateStore();
  const sender = recordingSender(emailStatuses);
  const telegramSender = recordingSender(telegramStatuses);
  let clock = new Date('2026-01-01T10:00:00Z');
  const service = createStateEngineService({ store, sender, telegramSender, now: () => new Date(clock) });
  const config = quiet ? { ...stateConfig, quiet_hours: { enabled: true, start: '00:00', end: '23:59' } } : stateConfig;
  const run = (executionId, cvr, { email = true, telegram = true } = {}) => service.processExecution({
    tenantId: 't1', workflowId: 'wf1', executionId, triggerType: 'cron',
    context: { metrics: { cvr_delta_pct: cvr } }, config,
    intents: email ? [{ to: ['ops@example.com'], subject: 'CVR alert', html: '<p>a</p>', text: 'a' }] : [],
    telegramIntents: telegram ? [{ title: 'CVR alert', message: 'a', severity: 'critical', users: [{ username: 'ops_lead' }] }] : [],
    workflowName: 'CVR drop'
  });
  return { store, sender, telegramSender, run, setClock: (iso) => { clock = new Date(iso); } };
}

test('Telegram is delivered once, together with email, when the state engine decides to notify', async () => {
  const { sender, telegramSender, run, store } = setup();
  const result = await run('run-1', -17);

  assert.equal(result.delivery.status, 'sent');
  assert.equal(sender.calls.length, 1);
  assert.equal(telegramSender.calls.length, 1);
  assert.deepEqual(telegramSender.calls[0].users, [{ username: 'ops_lead' }]);
  assert.equal(result.summary.telegram_status, 'sent');
  assert.equal((await store.getEvaluation('t1', 'wf1', 'run-1')).delivery.telegram.status, 'sent');
});

test('Telegram is held back by cooldown exactly like email', async () => {
  const { sender, telegramSender, run, setClock } = setup();
  await run('run-1', -17);
  setClock('2026-01-01T10:10:00Z');
  const second = await run('run-2', -18);

  assert.equal(second.evaluation.notification.suppressed_by, 'cooldown');
  assert.equal(sender.calls.length, 1);
  assert.equal(telegramSender.calls.length, 1);
});

test('Telegram is held back by quiet hours exactly like email', async () => {
  const { sender, telegramSender, run } = setup({ quiet: true });
  const result = await run('run-1', -17);
  assert.equal(result.evaluation.notification.suppressed_by, 'quiet_hours');
  assert.equal(sender.calls.length, 0);
  assert.equal(telegramSender.calls.length, 0);
});

test('a retry of the same execution sends neither channel again', async () => {
  const { sender, telegramSender, run } = setup();
  await run('run-1', -17);
  await run('run-1', -17);
  assert.equal(sender.calls.length, 1);
  assert.equal(telegramSender.calls.length, 1);
});

test('one channel failing is partial and keeps the cooldown', async () => {
  const { store, run } = setup({ telegramStatuses: ['failed'] });
  const result = await run('run-1', -17);

  assert.equal(result.delivery.status, 'partial');
  assert.equal(result.delivery.rolledBack, false);
  assert.match(result.delivery.error, /^telegram: /);
  assert.ok((await store.getState('t1', 'wf1')).cooldown);
});

test('every channel failing is failed and hands the cooldown back', async () => {
  const { store, run } = setup({ emailStatuses: ['failed'], telegramStatuses: ['failed'] });
  const result = await run('run-1', -17);

  assert.equal(result.delivery.status, 'failed');
  assert.equal(result.delivery.rolledBack, true);
  assert.equal((await store.getState('t1', 'wf1')).cooldown, null);
});

test('a Telegram-only run sends Telegram and no email (not even the fallback)', async () => {
  const { sender, telegramSender, run } = setup();
  const result = await run('run-1', -17, { email: false });

  assert.equal(result.delivery.status, 'sent');
  assert.equal(sender.calls.length, 0);
  assert.equal(telegramSender.calls.length, 1);
});

test('a Telegram-only messaging workflow can enable alert state', () => {
  const telegramOnly = definition(
    [messagingNode({ email: false, telegram: true }, { email: { to: [] } })],
    { state_config: stateConfig }
  );
  assert.deepEqual(validateWorkflowDefinition(telegramOnly).errors, []);
});

test('a messaging node in report format gets the full report template checks', () => {
  const badReport = definition([messagingNode(undefined, {
    format: 'report',
    template: { preset: 'performance_report_v1', eyebrow: 'x', title: 'y', period: { current: 'meta.window', comparison: 'meta.baselineWindow' }, metrics: [], tables: [] }
  })]);
  const { errors } = validateWorkflowDefinition(badReport);
  assert.ok(errors.some((e) => /messaging node notify template\.metrics must contain/.test(e)));
  assert.ok(errors.some((e) => /messaging node notify template\.tables must contain/.test(e)));
});

test('without alert state (e.g. daily insight) the messaging node still sends inline on every run', async () => {
  const def = definition([messagingNode()], { workflow_purpose: 'daily_insight' });
  assert.equal(prepareNotificationMode(def).stateEngine, false);
  const emailSender = recordingSender();
  const telegramSender = recordingSender();
  for (let i = 0; i < 2; i += 1) {
    const result = await new WorkflowRunner(def, { emailSender, telegramSender }).executeWorkflow(runContext());
    assert.equal(result.status, 'completed');
  }
  assert.equal(emailSender.calls.length, 2);
  assert.equal(telegramSender.calls.length, 2);
});

test('a messaging step inside a composite node gets the runtime senders', async () => {
  const def = definition([
    { id: 'group', type: 'composite', steps: ['notify'] },
    messagingNode()
  ], { state_config: stateConfig });
  const mode = prepareNotificationMode(def);
  const result = await new WorkflowRunner(def, { emailSender: mode.capture.sender, telegramSender: mode.capture.telegramSender })
    .executeWorkflow(runContext());
  assert.equal(result.status, 'completed');
  assert.equal(mode.capture.telegramIntents.length, 1);
});
