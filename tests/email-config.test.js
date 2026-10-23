const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { collectRecipients, addRecipient, removeRecipient } = require('../server/lib/notifierNodes');
const { createRecipientPolicy, suppressionReason } = require('../server/services/recipientPolicy');
const { createStateEngineService } = require('../server/services/stateEngineService');
const { createEmailConfigService, nextVersionAfter } = require('../server/services/emailConfigService');
const { createEmailConfigRouter } = require('../server/routes/emailConfig');
const EmailNode = require('../nodes/EmailNode');
const MessagingNode = require('../nodes/MessagingNode');
const { createFakeStateStore, createRecordingSender } = require('./helpers/fakeStateStore');

// ---------------------------------------------------------------- notifier nodes

const definitionWithRecipients = () => ({
  nodes: [
    { id: 'mail', type: 'email', to: ['Alok@trytechit.co'] },
    { id: 'insight_on', type: 'insight', email: { enabled: true, to: ['alok@trytechit.co', 'rk@trytechit.co'] } },
    { id: 'insight_off', type: 'insight', email: { enabled: false, to: ['hidden@trytechit.co'] } },
    { id: 'msg', type: 'messaging', channels: { email: true }, email: { to: [] } },
    { id: 'telegram_only', type: 'messaging', channels: { telegram: true } },
    { id: 'plain', type: 'metric_compare', metrics: ['cvr'] }
  ]
});

test('recipients are found on every kind of notifier node, ignoring case and nodes that do not send email', () => {
  const found = collectRecipients(definitionWithRecipients());
  assert.deepEqual([...found.keys()].sort(), ['alok@trytechit.co', 'rk@trytechit.co']);
  assert.deepEqual(found.get('alok@trytechit.co').map((n) => n.nodeId), ['mail', 'insight_on']);
  assert.ok(!found.has('hidden@trytechit.co'), 'an insight node with Email Insight off does not send');
});

test('adding a person puts them on every notifier node exactly once and leaves everything else alone', () => {
  const original = definitionWithRecipients();
  const { definition, changed } = addRecipient(original, 'New@trytechit.co');

  assert.equal(changed, true);
  assert.deepEqual(definition.nodes.find((n) => n.id === 'mail').to, ['Alok@trytechit.co', 'New@trytechit.co']);
  assert.deepEqual(definition.nodes.find((n) => n.id === 'insight_on').email.to, ['alok@trytechit.co', 'rk@trytechit.co', 'New@trytechit.co']);
  assert.deepEqual(definition.nodes.find((n) => n.id === 'msg').email.to, ['New@trytechit.co']);
  assert.deepEqual(definition.nodes.find((n) => n.id === 'insight_off').email.to, ['hidden@trytechit.co']);
  assert.equal(definition.nodes.find((n) => n.id === 'telegram_only').email, undefined);
  assert.deepEqual(original, definitionWithRecipients(), 'the input is not mutated');

  // adding again (different case) changes nothing
  assert.equal(addRecipient(definition, 'new@TRYTECHIT.co').changed, false);
});

test('removing a person takes them off every notifier node, case-insensitively', () => {
  const { definition, changed } = removeRecipient(definitionWithRecipients(), 'ALOK@trytechit.co');
  assert.equal(changed, true);
  assert.deepEqual(definition.nodes.find((n) => n.id === 'mail').to, []);
  assert.deepEqual(definition.nodes.find((n) => n.id === 'insight_on').email.to, ['rk@trytechit.co']);
  assert.equal(removeRecipient(definition, 'nobody@x.co').changed, false);
});

// ---------------------------------------------------------------- recipient policy

const NOW = new Date('2026-10-23T10:00:00Z');

function policyWith(preferences, { fail = false } = {}) {
  const store = {
    calls: 0,
    async findByEmails(emails) {
      store.calls += 1;
      if (fail) throw new Error('mongo down');
      return preferences.filter((pref) => emails.includes(pref.email));
    }
  };
  return { policy: createRecipientPolicy({ store, now: () => NOW }), store };
}

test('people without settings receive everything; paused, muted and severity rules filter per person', async () => {
  const { policy } = policyWith([
    { email: 'paused@x.co', paused: true },
    { email: 'later@x.co', paused: true, pausedUntil: new Date('2026-10-24T00:00:00Z') },
    { email: 'back@x.co', paused: true, pausedUntil: new Date('2026-10-22T00:00:00Z') },
    { email: 'muted@x.co', mutedWorkflows: [{ tenantId: 'AJMAL', workflowId: 'wf_1' }] },
    { email: 'muted-other@x.co', mutedWorkflows: [{ tenantId: 'AJMAL', workflowId: 'wf_OTHER' }] },
    { email: 'shared@x.co', mutedWorkflows: [{ tenantId: null, workflowId: 'wf_1' }] },
    { email: 'critical@x.co', severityMin: 'CRITICAL' }
  ]);
  const recipients = ['Plain@x.co', 'PAUSED@x.co', 'later@x.co', 'back@x.co', 'muted@x.co', 'muted-other@x.co', 'shared@x.co', 'critical@x.co'];

  const triggered = await policy.applyRecipientPreferences({ recipients, tenantId: 'AJMAL', workflowId: 'wf_1', severity: 'TRIGGERED' });
  assert.deepEqual(triggered.allowed, ['Plain@x.co', 'back@x.co', 'muted-other@x.co']);
  assert.deepEqual(Object.fromEntries(triggered.suppressed.map((s) => [s.email, s.reason])), {
    'PAUSED@x.co': 'paused',
    'later@x.co': 'paused',
    'muted@x.co': 'workflow_muted',
    'shared@x.co': 'workflow_muted',
    'critical@x.co': 'severity_below_minimum'
  });

  // a CRITICAL alert still reaches the "critical only" person
  const critical = await policy.applyRecipientPreferences({ recipients, tenantId: 'AJMAL', workflowId: 'wf_1', severity: 'CRITICAL' });
  assert.ok(critical.allowed.includes('critical@x.co'));

  // a different tenant's run of the same workflow is not muted by a tenant-specific mute
  const otherTenant = await policy.applyRecipientPreferences({ recipients: ['muted@x.co'], tenantId: 'TMC', workflowId: 'wf_1' });
  assert.deepEqual(otherTenant.allowed, ['muted@x.co']);
});

test('the severity filter only applies when the send has a severity (alert-state workflows)', () => {
  const critical = { email: 'c@x.co', severityMin: 'CRITICAL' };
  assert.equal(suppressionReason(critical, { tenantId: 'T', workflowId: 'w', severity: null, now: NOW }), null);
  assert.equal(suppressionReason(critical, { tenantId: 'T', workflowId: 'w', severity: 'TRIGGERED', now: NOW }), 'severity_below_minimum');
  assert.equal(suppressionReason(null, { tenantId: 'T', workflowId: 'w', severity: 'TRIGGERED', now: NOW }), null);
});

test('preferences are cached briefly, cleared on change, and a database failure never swallows an alert', async () => {
  const { policy, store } = policyWith([{ email: 'a@x.co', paused: true }]);
  await policy.applyRecipientPreferences({ recipients: ['a@x.co'], workflowId: 'w' });
  await policy.applyRecipientPreferences({ recipients: ['a@x.co'], workflowId: 'w' });
  assert.equal(store.calls, 1, 'second send in the same half-minute reads the cache');
  policy.invalidate();
  await policy.applyRecipientPreferences({ recipients: ['a@x.co'], workflowId: 'w' });
  assert.equal(store.calls, 2);

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const broken = policyWith([], { fail: true }).policy;
    const result = await broken.applyRecipientPreferences({ recipients: ['a@x.co', 'b@x.co'], workflowId: 'w' });
    assert.deepEqual(result.allowed, ['a@x.co', 'b@x.co']);
    assert.deepEqual(result.suppressed, []);
  } finally {
    console.warn = originalWarn;
  }
});

test('the inline sender drops opted-out people, and reports "skipped" (not failed) when nobody is left', async () => {
  const { policy } = policyWith([{ email: 'off@x.co', paused: true }]);
  const sent = [];
  const base = async (message) => { sent.push(message); return { status: 'sent', to: message.to }; };
  const sender = policy.createPreferenceAwareSender(base, { tenantId: 'T', workflowId: 'w' });

  const partial = await sender({ to: ['on@x.co', 'off@x.co'], subject: 's', html: '<p/>', text: 't' });
  assert.equal(partial.status, 'sent');
  assert.deepEqual(sent[0].to, ['on@x.co']);
  assert.deepEqual(partial.suppressed, [{ email: 'off@x.co', reason: 'paused' }]);

  const nobody = await sender({ to: ['off@x.co'], subject: 's', html: '<p/>', text: 't' });
  assert.equal(nobody.status, 'skipped');
  assert.equal(sent.length, 1, 'nothing was sent');

  // a skipped send is a pass for the email and messaging nodes
  const context = { meta: { brandName: 'B' }, metrics: {}, scratch: {} };
  const emailNode = await EmailNode({ id: 'n', type: 'email', to: ['off@x.co'], subject: 'Hi', format: 'insight', template: { insightSource: 'scratch.finalInsight' } },
    { ...context, scratch: { finalInsight: { summary: 'x', details: [] } } }, { emailSender: sender });
  assert.equal(emailNode.status, 'pass');

  const messaging = await MessagingNode({ id: 'm', type: 'messaging', channels: { email: true }, email: { to: ['off@x.co'] }, subject: 'Hi', format: 'insight', template: { insightSource: 'scratch.finalInsight' } },
    { ...context, scratch: { finalInsight: { summary: 'x', details: [] } } }, { emailSender: sender });
  assert.equal(messaging.status, 'pass');
});

// ---------------------------------------------------------------- state engine delivery

const stateConfig = {
  enabled: true,
  finding: { metric: 'cvr_delta_pct' },
  thresholds: { normal: -15, critical: -25 },
  cooldown: { triggered_minutes: 60, critical_minutes: 30 },
  quiet_hours: { enabled: false, start: '23:00', end: '07:00' }
};

function stateHarness(preferences) {
  const store = createFakeStateStore();
  const sender = createRecordingSender();
  const { policy } = policyWith(preferences);
  const service = createStateEngineService({ store, sender, recipientPolicy: policy, now: () => new Date('2026-01-01T10:00:00Z') });
  const run = (executionId, value, to) => service.processExecution({
    tenantId: 'AJMAL', workflowId: 'wf_1', executionId, triggerType: 'cron',
    context: { metrics: { cvr_delta_pct: value } },
    config: stateConfig,
    intents: [{ to, subject: 'CVR drop', html: '<p>x</p>', text: 'x' }],
    workflowName: 'CVR drop'
  });
  return { store, sender, run };
}

test('an alert goes only to people who still want it, and the opted-out ones are recorded on the evaluation', async () => {
  const { store, sender, run } = stateHarness([{ email: 'off@x.co', paused: true }]);
  const result = await run('run-1', -17, ['on@x.co', 'off@x.co']);

  assert.equal(result.delivery.status, 'sent');
  assert.deepEqual(sender.calls[0].to, ['on@x.co']);
  const evaluation = (await store.listEvaluations('AJMAL', 'wf_1'))[0];
  assert.deepEqual(evaluation.delivery.suppressed_recipients, [{ email: 'off@x.co', reason: 'paused' }]);
});

test('the "critical only" setting holds back a TRIGGERED alert but not a CRITICAL one', async () => {
  const { sender, run } = stateHarness([{ email: 'crit@x.co', severityMin: 'CRITICAL' }]);
  await run('run-1', -17, ['crit@x.co', 'all@x.co']);
  assert.deepEqual(sender.calls[0].to, ['all@x.co']);

  const second = stateHarness([{ email: 'crit@x.co', severityMin: 'CRITICAL' }]);
  await second.run('run-2', -30, ['crit@x.co', 'all@x.co']);
  assert.deepEqual(second.sender.calls[0].to, ['crit@x.co', 'all@x.co']);
});

test('if everyone on an alert has opted out, nothing is sent and the cooldown is handed back', async () => {
  const { store, sender, run } = stateHarness([{ email: 'a@x.co', paused: true }, { email: 'b@x.co', paused: true }]);
  const result = await run('run-1', -17, ['a@x.co', 'b@x.co']);

  assert.equal(result.delivery.status, 'none');
  assert.equal(result.delivery.skippedReason, 'recipients_opted_out');
  assert.equal(result.delivery.rolledBack, true);
  assert.equal(sender.calls.length, 0);
  const state = await store.getState('AJMAL', 'wf_1');
  assert.equal(state.state, 'TRIGGERED', 'the state itself still moved');
  assert.equal(state.cooldown, null, 'but it did not start a cooldown');
  assert.equal(result.summary.delivery_skipped_reason, 'recipients_opted_out');
});

// ---------------------------------------------------------------- service (edit recipients) with an in-memory store

function fakeModels() {
  const workflows = [
    { _id: 'k1', workflowId: 'wf_1', name: 'CVR drop (AJMAL)', tenantId: 'AJMAL', tenantIds: [], scope: 'tenant', latestVersion: '1.9', isActive: true },
    { _id: 'k2', workflowId: 'wf_2', name: 'Daily report (GLOBAL)', tenantId: null, tenantIds: [], scope: 'global', latestVersion: '2.1', isActive: true },
    { _id: 'k3', workflowId: 'wf_3', name: 'Telegram only', tenantId: 'TMC', tenantIds: [], scope: 'tenant', latestVersion: '1.1', isActive: true }
  ];
  const baseDefinition = (id, version, extra = {}) => ({
    workflow_id: id, version, name: id, workflow_type: 'root_cause_analysis',
    trigger: { type: 'alert', alertType: 'cvr_drop', brandScope: 'global', brandIds: [] },
    nodes: [
      { id: 'validate', type: 'validation', checks: [{ field: 'sessions', condition: 'current > 0' }], next: 'mail' },
      { id: 'mail', type: 'email', format: 'insight', to: ['alok@trytechit.co'], subject: 's', template: { insightSource: 'scratch.finalInsight' } }
    ],
    ...extra
  });
  const versions = [
    { workflowId: 'wf_1', scope: 'tenant', tenantId: 'AJMAL', version: '1.9', definitionJson: baseDefinition('wf_1', '1.9') },
    { workflowId: 'wf_1', scope: 'tenant', tenantId: 'AJMAL', version: '1.10', definitionJson: baseDefinition('wf_1', '1.10') },
    { workflowId: 'wf_2', scope: 'global', tenantId: null, version: '2.1', definitionJson: baseDefinition('wf_2', '2.1') },
    { workflowId: 'wf_3', scope: 'tenant', tenantId: 'TMC', version: '1.1', definitionJson: { ...baseDefinition('wf_3', '1.1'), nodes: [{ id: 'validate', type: 'validation', checks: [{ field: 'sessions', condition: 'current > 0' }] }] } }
  ];
  const preferences = [];
  const events = [];
  const users = [{ name: 'Alok', email: 'alok@trytechit.co' }, { name: 'Jiya', email: 'jiya@trytechit.co' }];

  const matchVersion = (query) => (row) => row.workflowId === query.workflowId && (query.version === undefined || row.version === query.version);
  const chain = (rows) => ({ lean: async () => rows, sort() { return chain(rows); }, limit() { return chain(rows); }, select() { return chain(rows); } });

  return {
    state: { workflows, versions, preferences, events },
    models: {
      Workflow: {
        find: () => chain(workflows.filter((w) => w.isActive)),
        findById: (id) => ({ lean: async () => workflows.find((w) => w._id === id) || null }),
        updateOne: async (filter, update) => { Object.assign(workflows.find((w) => w._id === filter._id), update.$set); }
      },
      WorkflowVersion: {
        findOne: (query) => ({ lean: async () => versions.find(matchVersion(query)) || null }),
        create: async (doc) => { versions.push(doc); return doc; }
      },
      User: { find: () => chain(users) },
      Preference: {
        find: () => chain(preferences),
        findOneAndUpdate(filter, update) {
          let pref = preferences.find((p) => p.email === filter.email);
          if (!pref) { pref = { email: filter.email, mutedWorkflows: [] }; preferences.push(pref); }
          Object.assign(pref, update.$set);
          return { lean: async () => pref };
        },
        async updateOne(filter, update) {
          let pref = preferences.find((p) => p.email === filter.email);
          if (!pref && update.$setOnInsert) { pref = { email: filter.email, mutedWorkflows: [] }; preferences.push(pref); }
          if (!pref) return;
          if (update.$pull) {
            const { workflowId, tenantId } = update.$pull.mutedWorkflows;
            pref.mutedWorkflows = pref.mutedWorkflows.filter((m) => !(m.workflowId === workflowId && m.tenantId === tenantId));
          }
          if (update.$push) pref.mutedWorkflows.push(update.$push.mutedWorkflows);
          if (update.$set) Object.assign(pref, update.$set);
        }
      },
      Event: { create: async (doc) => { events.push({ at: new Date(), ...doc }); }, find: () => chain([...events].reverse()) }
    }
  };
}

test('the people list covers recipients and app users, with workflow counts and settings', async () => {
  const { models, state } = fakeModels();
  state.preferences.push({ email: 'alok@trytechit.co', paused: true, severityMin: 'CRITICAL', mutedWorkflows: [], updatedBy: 'me@x.co' });
  const service = createEmailConfigService({ models });
  const people = await service.listRecipients();

  const alok = people.find((p) => p.email === 'alok@trytechit.co');
  assert.equal(alok.workflowCount, 2);
  assert.deepEqual(alok.tenants, ['AJMAL', 'GLOBAL']);
  assert.equal(alok.paused, true);
  assert.equal(alok.severityMin, 'CRITICAL');
  assert.equal(alok.isAppUser, true);
  assert.equal(alok.name, 'Alok');
  // an app user who is on no workflow is still listed, so they can be added
  assert.equal(people.find((p) => p.email === 'jiya@trytechit.co').workflowCount, 0);
  assert.equal(people[0].email, 'alok@trytechit.co', 'busiest first');
});

test('a person\'s detail lists the workflows they are on, the ones they could be added to, and their mutes', async () => {
  const { models } = fakeModels();
  const service = createEmailConfigService({ models });
  await service.setMute('alok@trytechit.co', 'k1', true, 'admin@trytechit.co');

  const detail = await service.getRecipient('Alok@trytechit.co');
  // global workflows (no tenant) sort first, then by tenant and name
  assert.deepEqual(detail.workflows.map((w) => [w.key, w.muted]), [['k2', false], ['k1', true]]);
  assert.deepEqual(detail.availableWorkflows.map((w) => w.key), ['k3']);
  assert.equal(detail.preferences.mutedCount, 1);
  assert.equal(detail.events[0].action, 'workflow_muted');
  assert.equal(detail.events[0].by, 'admin@trytechit.co');

  await service.setMute('alok@trytechit.co', 'k1', false, 'admin@trytechit.co');
  assert.ok((await service.getRecipient('alok@trytechit.co')).workflows.every((w) => w.muted === false));
});

test('preferences are validated, saved, and audited', async () => {
  const { models, state } = fakeModels();
  let changes = 0;
  const service = createEmailConfigService({ models, onChange: () => { changes += 1; } });

  const saved = await service.updatePreferences('New@trytechit.co', { paused: true, pausedUntil: '2026-11-01T00:00:00Z', severityMin: 'CRITICAL' }, 'me@trytechit.co');
  assert.equal(saved.paused, true);
  assert.equal(saved.severityMin, 'CRITICAL');
  assert.equal(new Date(saved.pausedUntil).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(state.preferences[0].email, 'new@trytechit.co');
  assert.equal(state.events[0].by, 'me@trytechit.co');
  assert.equal(changes, 1, 'the send-time cache is told to refresh');

  const resumed = await service.updatePreferences('new@trytechit.co', { paused: false });
  assert.equal(resumed.paused, false);
  assert.equal(resumed.pausedUntil, null, 'un-pausing clears the resume date');

  await assert.rejects(service.updatePreferences('not-an-email', { paused: true }), /valid email/);
  await assert.rejects(service.updatePreferences('a@x.co', { severityMin: 'LOW' }), /severityMin/);
  await assert.rejects(service.updatePreferences('a@x.co', { paused: 'yes' }), /true or false/);
  await assert.rejects(service.updatePreferences('a@x.co', {}), /nothing to update/);
});

test('adding and removing people saves new, validated workflow versions', async () => {
  const { models, state } = fakeModels();
  const service = createEmailConfigService({ models });

  const added = await service.applyWorkflowChanges('jiya@trytechit.co', { add: ['k1', 'k2'] }, 'admin@trytechit.co');
  assert.deepEqual(added.map((r) => [r.key, r.changed, r.version]), [['k1', true, '1.11'], ['k2', true, '2.2']]);
  const k1 = state.versions.find((v) => v.workflowId === 'wf_1' && v.version === '1.11');
  assert.deepEqual(k1.definitionJson.nodes.find((n) => n.id === 'mail').to, ['alok@trytechit.co', 'jiya@trytechit.co']);
  assert.equal(k1.definitionJson.version, '1.11');
  assert.equal(state.workflows.find((w) => w._id === 'k1').latestVersion, '1.11');
  // a global workflow's version stays global
  const k2 = state.versions.find((v) => v.workflowId === 'wf_2' && v.version === '2.2');
  assert.equal(k2.scope, 'global');
  assert.equal(k2.tenantId, null);

  // adding again is a no-op, not a new version
  const again = await service.applyWorkflowChanges('jiya@trytechit.co', { add: ['k1'] });
  assert.equal(again[0].changed, false);
  assert.equal(state.versions.filter((v) => v.workflowId === 'wf_1').length, 3);

  // removing also drops that person's mute for the workflow
  await service.setMute('jiya@trytechit.co', 'k1', true);
  const removed = await service.applyWorkflowChanges('jiya@trytechit.co', { remove: ['k1'] }, 'admin@trytechit.co');
  assert.equal(removed[0].changed, true);
  assert.deepEqual(state.versions.find((v) => v.version === '1.12').definitionJson.nodes.find((n) => n.id === 'mail').to, ['alok@trytechit.co']);
  assert.equal(state.preferences.find((p) => p.email === 'jiya@trytechit.co').mutedWorkflows.length, 0);
  assert.ok(state.events.some((e) => e.action === 'removed_from_workflow' && e.by === 'admin@trytechit.co'));
});

test('a workflow with no email node cannot be added to, and one bad workflow does not stop the others', async () => {
  const { models } = fakeModels();
  const service = createEmailConfigService({ models });
  const results = await service.applyWorkflowChanges('jiya@trytechit.co', { add: ['k3', 'k1', 'missing'] });
  assert.match(results[0].error, /no email notification node/);
  assert.equal(results[1].changed, true);
  assert.match(results[2].error, /not found/);
});

test('the next version skips numbers that already exist', () => {
  assert.deepEqual(nextVersionAfter('1.9'), { major: '1', minor: 9 });
  assert.deepEqual(nextVersionAfter(undefined), { major: '1', minor: 0 });
});

test('the reverse view lists each workflow with its recipients and their status', async () => {
  const { models, state } = fakeModels();
  state.preferences.push({ email: 'alok@trytechit.co', paused: false, severityMin: 'CRITICAL', mutedWorkflows: [{ tenantId: 'AJMAL', workflowId: 'wf_1' }] });
  const workflows = await createEmailConfigService({ models }).listWorkflows();
  const wf1 = workflows.find((w) => w.key === 'k1');
  assert.deepEqual(wf1.recipients.map((r) => [r.email, r.muted, r.severityMin]), [['alok@trytechit.co', true, 'CRITICAL']]);
  assert.equal(workflows.find((w) => w.key === 'k3').recipients.length, 0);
});

// ---------------------------------------------------------------- HTTP routes

async function withApi(service, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { email: 'tester@trytechit.co', role: 'admin' }; next(); });
  app.use('/email-config', createEmailConfigRouter({ service }));
  const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
  const call = (method, path, body) => fetch(`http://127.0.0.1:${server.address().port}/email-config${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  try { await fn(call); } finally { server.close(); }
}

test('the API lists people, saves settings as the signed-in user, and rejects bad input with 400', async () => {
  const { models, state } = fakeModels();
  const service = createEmailConfigService({ models });
  await withApi(service, async (call) => {
    const list = await (await call('GET', '/recipients')).json();
    assert.equal(list.recipients.find((p) => p.email === 'alok@trytechit.co').workflowCount, 2);

    const put = await call('PUT', '/recipients/alok%40trytechit.co/preferences', { paused: true, severityMin: 'CRITICAL' });
    assert.equal(put.status, 200);
    assert.equal(state.events.at(-1).by, 'tester@trytechit.co');

    const bad = await call('PUT', '/recipients/alok%40trytechit.co/preferences', { severityMin: 'NOPE' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /severityMin/);

    const detail = await (await call('GET', '/recipients/alok%40trytechit.co')).json();
    assert.equal(detail.preferences.paused, true);
    assert.equal(detail.workflows.length, 2);

    const mute = await call('PUT', '/recipients/alok%40trytechit.co/workflows/k1/mute', { muted: true });
    assert.equal(mute.status, 200);
    assert.equal((await call('PUT', '/recipients/alok%40trytechit.co/workflows/nope/mute', { muted: true })).status, 404);

    const changes = await (await call('POST', '/recipients/jiya%40trytechit.co/workflows', { add: ['k1'] })).json();
    assert.equal(changes.results[0].changed, true);
    assert.equal((await call('POST', '/recipients/jiya%40trytechit.co/workflows', { add: 'k1' })).status, 400);

    const byWorkflow = await (await call('GET', '/workflows')).json();
    assert.equal(byWorkflow.workflows.length, 3);
  });
});
