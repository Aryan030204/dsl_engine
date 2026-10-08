const test = require('node:test');
const assert = require('node:assert/strict');

const WorkflowRunner = require('../engine/WorkflowRunner');
const { validateWorkflowDefinition } = require('../server/validation/workflowDefinition');
const { prepareNotificationMode, applyStateEngine } = require('../server/services/workflowExecutionService');
const { createStateEngineService } = require('../server/services/stateEngineService');
const { createFakeStateStore, createRecordingSender } = require('./helpers/fakeStateStore');

const stateConfig = {
  enabled: true,
  finding: { metric: 'cvr_delta_pct' },
  thresholds: { normal: -15, critical: -25 },
  cooldown: { triggered_minutes: 60, critical_minutes: 30 },
  quiet_hours: { enabled: true, start: '00:00', end: '23:59' } // always quiet
};

function definition(overrides = {}) {
  return {
    workflow_type: 'root_cause_analysis',
    version: '1.0',
    name: 'CVR drop',
    trigger: { type: 'alert', alertType: 'cvr_drop', brandScope: 'single', brandIds: ['t1'] },
    nodes: [
      {
        id: 'insight',
        type: 'insight',
        template: { summary: 'CVR moved {{cvr_delta_pct}}%', details: [] },
        email: { enabled: true, to: ['ops@example.com'], subject: 'CVR insight' },
        next: 'mail'
      },
      {
        id: 'mail',
        type: 'email',
        format: 'insight',
        subject: 'CVR report',
        to: ['team@example.com'],
        template: { insightSource: 'scratch.finalInsight' }
      }
    ],
    ...overrides
  };
}

function context(cvrDeltaPct) {
  return {
    meta: { tenantId: 't1', timezone: 'UTC' },
    metrics: { cvr_delta_pct: cvrDeltaPct },
    breakdowns: {},
    filters: [],
    scratch: {}
  };
}

test('daily_insight never goes through the state engine, even with state_config enabled', () => {
  const mode = prepareNotificationMode(definition({ workflow_purpose: 'daily_insight', state_config: stateConfig }));
  assert.equal(mode.stateEngine, false);
  assert.equal(mode.capture, null);
});

test('an RCA workflow without state_config keeps legacy inline sending', () => {
  assert.equal(prepareNotificationMode(definition()).stateEngine, false);
  assert.equal(prepareNotificationMode(definition({ workflow_purpose: 'rca' })).stateEngine, false);
  assert.equal(prepareNotificationMode(definition({ state_config: { ...stateConfig, enabled: false } })).stateEngine, false);
});

test('an RCA workflow with state_config enabled captures its email and insight sends', async () => {
  const def = definition({ workflow_purpose: 'rca', state_config: stateConfig });
  const mode = prepareNotificationMode(def);
  assert.equal(mode.stateEngine, true);

  const runner = new WorkflowRunner(def, { emailSender: mode.capture.sender });
  const result = await runner.executeWorkflow(context(-17));

  assert.equal(result.status, 'completed');
  assert.equal(mode.capture.intents.length, 2);
  assert.deepEqual(mode.capture.intents.map((intent) => intent.to), [['ops@example.com'], ['team@example.com']]);
  assert.equal(result.context.scratch.emailDeliveries.mail.status, 'deferred');
  assert.equal(result.context.scratch.finalInsightEmail.status, 'deferred');
});

test('daily_insight sends every run inline, inside quiet hours and with no state written', async () => {
  const def = definition({ workflow_purpose: 'daily_insight' });
  const sender = createRecordingSender();
  for (let i = 0; i < 3; i += 1) {
    const runner = new WorkflowRunner(def, { emailSender: prepareNotificationMode(def).capture?.sender || sender });
    const result = await runner.executeWorkflow(context(-30));
    assert.equal(result.status, 'completed');
  }
  // insight email + email node, three runs, nothing held back
  assert.equal(sender.calls.length, 6);
});

test('applyStateEngine records the decision on the run and never throws', async () => {
  const store = createFakeStateStore();
  const sender = createRecordingSender();
  const stateEngine = createStateEngineService({ store, sender, now: () => new Date('2026-01-01T10:00:00Z') });
  let saves = 0;
  const run = {
    _id: 'run-1', tenantId: 't1', workflowId: 'wf1', triggerType: 'cron',
    definitionJson: definition({ state_config: stateConfig }),
    save: async () => { saves += 1; }
  };

  // Always-quiet window: NORMAL -> CRITICAL still goes out (direct escalation bypass).
  await applyStateEngine({ run, result: { context: context(-30) }, intents: [], stateEngine });
  assert.equal(run.stateEvaluation.resulting_state, 'CRITICAL');
  assert.equal(run.stateEvaluation.delivery_status, 'sent');
  assert.deepEqual(sender.calls[0].to, ['ops@example.com', 'team@example.com']);
  assert.equal(saves, 1);

  const broken = { ...run, _id: 'run-2', save: async () => {} };
  await applyStateEngine({
    run: broken, result: { context: context(-30) }, intents: [],
    stateEngine: { processExecution: async () => { throw new Error('mongo down'); } }
  });
  assert.equal(broken.stateEvaluation, null);
  assert.equal(broken.stateEvaluationError, 'mongo down');
});

test('validation: workflow_purpose and state_config', () => {
  assert.equal(validateWorkflowDefinition(definition({ state_config: stateConfig })).ok, true);
  assert.equal(validateWorkflowDefinition(definition({ workflow_purpose: 'daily_insight' })).ok, true);

  const errorsFor = (overrides) => validateWorkflowDefinition(definition(overrides)).errors;

  assert.ok(errorsFor({ workflow_purpose: 'weekly' }).some((e) => /workflow_purpose must be one of/.test(e)));
  assert.ok(errorsFor({ workflow_purpose: 'daily_insight', state_config: stateConfig })
    .some((e) => /cannot be enabled for a daily_insight/.test(e)));
  // Negative thresholds (drop) and positive ones (rise) are both valid.
  assert.equal(validateWorkflowDefinition(definition({ state_config: { ...stateConfig, thresholds: { normal: 10, critical: 20 } } })).ok, true);
  assert.ok(errorsFor({ state_config: { ...stateConfig, thresholds: { normal: -25, critical: -25 } } })
    .some((e) => /critical must differ/.test(e)));
  assert.ok(errorsFor({ state_config: { ...stateConfig, thresholds: { normal: '-10', critical: -20 } } })
    .some((e) => /thresholds.normal must be a number/.test(e)));
  assert.ok(errorsFor({ state_config: { ...stateConfig, finding: { metric: 'cvr_delta_pct', direction: 'drop' } } })
    .some((e) => /direction is no longer supported/.test(e)));
  assert.ok(errorsFor({ state_config: { ...stateConfig, finding: { metric: 'CVR Delta' } } })
    .some((e) => /finding.metric/.test(e)));
  assert.ok(errorsFor({ state_config: { ...stateConfig, recovery: { required_evidence: 2 } } })
    .some((e) => /recovery is no longer supported/.test(e)));
  assert.ok(errorsFor({ state_config: { ...stateConfig, cooldown: { triggered_minutes: -5 } } })
    .some((e) => /cooldown.triggered_minutes/.test(e)));
  assert.ok(errorsFor({ state_config: { ...stateConfig, quiet_hours: { enabled: true, start: '7pm', end: '07:00' } } })
    .some((e) => /quiet_hours.start must be HH:MM/.test(e)));
  const noEmail = definition({ state_config: stateConfig });
  noEmail.nodes = [
    { ...noEmail.nodes[0], email: { ...noEmail.nodes[0].email, enabled: false }, next: undefined }
  ];
  assert.ok(validateWorkflowDefinition(noEmail).errors.some((e) => /no node sends a notification/.test(e)));
  // A disabled config is not validated beyond its shape.
  assert.equal(validateWorkflowDefinition(definition({ state_config: { enabled: false } })).ok, true);
});
