const test = require('node:test');
const assert = require('node:assert/strict');

const { createStateEngineService } = require('../server/services/stateEngineService');
const { createFakeStateStore, createRecordingSender } = require('./helpers/fakeStateStore');

const config = {
  enabled: true,
  finding: { metric: 'cvr_delta_pct' },
  thresholds: { normal: -15, critical: -25 },
  cooldown: { triggered_minutes: 60, critical_minutes: 30 },
  quiet_hours: { enabled: false, start: '23:00', end: '07:00' }
};

function setup({ statuses, clockStart = '2026-01-01T10:00:00Z' } = {}) {
  const store = createFakeStateStore();
  const sender = createRecordingSender(statuses);
  let clock = new Date(clockStart);
  const service = createStateEngineService({ store, sender, now: () => new Date(clock) });
  const setClock = (iso) => { clock = new Date(iso); };
  const run = (executionId, cvrDeltaPct, extra = {}) => service.processExecution({
    tenantId: 't1',
    workflowId: 'wf1',
    executionId,
    triggerType: 'cron',
    context: { metrics: { cvr_delta_pct: cvrDeltaPct } },
    config,
    intents: [{ to: ['ops@example.com'], subject: 'CVR RCA', html: '<html><body><p>analysis</p></body></html>', text: 'analysis' }],
    workflowName: 'CVR drop',
    ...extra
  });
  return { store, sender, service, run, setClock };
}

test('sends the captured email exactly as rendered, once, and persists the transition', async () => {
  const { store, sender, run } = setup();
  const result = await run('run-1', -17);

  assert.equal(result.delivery.status, 'sent');
  assert.equal(sender.calls.length, 1);
  assert.deepEqual(sender.calls[0].to, ['ops@example.com']);
  // No state banner or [STATE] prefix: subject and body are the workflow's own.
  assert.equal(sender.calls[0].subject, 'CVR RCA');
  assert.equal(sender.calls[0].html, '<html><body><p>analysis</p></body></html>');
  assert.equal(sender.calls[0].text, 'analysis');

  const state = await store.getState('t1', 'wf1');
  assert.equal(state.state, 'TRIGGERED');
  assert.equal(state.version, 1);
  assert.equal(state.last_execution_id, 'run-1');
  assert.equal(result.summary.delivery_status, 'sent');
  assert.equal(result.summary.finding.value, -17);
});

test('a retry of the same execution neither transitions again nor resends', async () => {
  const { store, sender, run } = setup();
  await run('run-1', -17);
  // The retry sees a different number (the workflow re-ran from node one), but the
  // decision is the one already made for this execution.
  const retry = await run('run-1', -30);

  assert.equal(retry.replayed, true);
  assert.equal(retry.delivery.status, 'sent');
  assert.equal(sender.calls.length, 1);
  const state = await store.getState('t1', 'wf1');
  assert.equal(state.state, 'TRIGGERED');
  assert.equal(state.version, 1);
});

test('a crash between the state write and the audit row is recovered from last_decision', async () => {
  const { store, sender, run } = setup();
  const realInsert = store.insertEvaluation;
  store.insertEvaluation = async () => { throw new Error('process crashed'); };
  await assert.rejects(run('run-1', -17), /process crashed/);
  store.insertEvaluation = realInsert;

  // Delivery can only claim an existing audit row, so nothing was sent yet.
  assert.equal(sender.calls.length, 0);
  assert.equal((await store.getState('t1', 'wf1')).state, 'TRIGGERED');

  // The retry re-runs the workflow and sees a different number, but replays the
  // decision already committed to state instead of transitioning again.
  const retry = await run('run-1', -30);
  assert.equal((await store.getState('t1', 'wf1')).version, 1);
  assert.equal(retry.evaluation.previous_state, 'NORMAL');
  assert.equal(retry.evaluation.resulting_state, 'TRIGGERED');
  assert.equal(retry.evaluation.finding.value, -17);
  assert.equal(sender.calls.length, 1);
});

test('a row left in `sending` by a crashed attempt becomes uncertain and is not resent', async () => {
  const { store, sender, service } = setup();
  const { evaluation } = await service.applyExecution({
    tenantId: 't1', workflowId: 'wf1', executionId: 'run-1', triggerType: 'cron',
    context: { metrics: { cvr_delta_pct: -17 } }, config
  });
  await store.claimDelivery('t1', 'wf1', 'run-1'); // crashed right after claiming

  const delivery = await service.deliver({ evaluation: await store.getEvaluation('t1', 'wf1', 'run-1'), intents: [] });
  assert.equal(delivery.status, 'uncertain');
  assert.equal(sender.calls.length, 0);
  assert.equal((await store.getEvaluation('t1', 'wf1', 'run-1')).delivery.status, 'uncertain');
  assert.equal(evaluation.delivery.status, 'pending');
});

test('a lost compare-and-set re-reads and recomputes from the winning write', async () => {
  const { store, run } = setup();
  await run('run-1', -17); // TRIGGERED, version 1

  // Another worker writes CRITICAL between our read and our write, exactly once.
  const realCas = store.compareAndSetState;
  let interfered = false;
  store.compareAndSetState = async (tenantId, workflowId, expectedVersion, fields) => {
    if (!interfered) {
      interfered = true;
      await realCas(tenantId, workflowId, expectedVersion, { state: 'CRITICAL', last_execution_id: 'other-run' });
      return false;
    }
    return realCas(tenantId, workflowId, expectedVersion, fields);
  };

  const result = await run('run-2', -5);
  assert.equal(result.evaluation.previous_state, 'CRITICAL');
  assert.equal(result.evaluation.resulting_state, 'NORMAL');
  assert.equal((await store.getState('t1', 'wf1')).version, 3);
});

test('gives up after repeated conflicts instead of overwriting', async () => {
  const { store, run } = setup();
  await run('run-1', -17);
  store.compareAndSetState = async () => false;
  await assert.rejects(run('run-2', -20), /could not update state/);
});

test('an inconclusive run records an audit row but leaves state untouched', async () => {
  const { store, sender, run } = setup();
  await run('run-1', -17);
  const result = await run('run-2', undefined);

  assert.equal(result.evaluation.conclusive, false);
  assert.equal(result.evaluation.previous_state, 'TRIGGERED');
  assert.equal(result.delivery.status, 'none');
  assert.equal((await store.getState('t1', 'wf1')).version, 1);
  assert.equal(sender.calls.length, 1);
});

test('SMTP failure rolls back the cooldown so the next reminder is not blocked', async () => {
  const { store, sender, run, setClock } = setup({ statuses: ['sent', 'failed', 'sent'] });
  await run('run-1', -17); // INITIAL_TRIGGER sent at 10:00
  setClock('2026-01-01T11:00:00Z');
  const failed = await run('run-2', -18); // REMINDER due, SMTP fails

  assert.equal(failed.delivery.status, 'failed');
  assert.equal(failed.delivery.rolledBack, true);
  const afterFailure = await store.getState('t1', 'wf1');
  assert.equal(afterFailure.state, 'TRIGGERED');
  assert.equal(new Date(afterFailure.cooldown.started_at).toISOString(), '2026-01-01T10:00:00.000Z');
  assert.equal((await store.getEvaluation('t1', 'wf1', 'run-2')).delivery.rolled_back, true);

  setClock('2026-01-01T11:05:00Z');
  const retried = await run('run-3', -18);
  assert.equal(retried.evaluation.notification.reason, 'REMINDER');
  assert.equal(retried.delivery.status, 'sent');
  assert.equal(sender.calls.length, 3);
});

test('rollback never undoes a newer execution\'s alert', async () => {
  const { store, service, run, setClock } = setup();
  await run('run-1', -17);
  setClock('2026-01-01T11:00:00Z');
  const { evaluation } = await service.applyExecution({
    tenantId: 't1', workflowId: 'wf1', executionId: 'run-2', triggerType: 'cron',
    context: { metrics: { cvr_delta_pct: -18 } }, config
  });
  // A later execution alerts before run-2's delivery attempt fails.
  setClock('2026-01-01T11:10:00Z');
  await run('run-3', -30);

  const rolledBack = await service.rollbackBookkeeping({ tenantId: 't1', workflowId: 'wf1', decision: evaluation.decision });
  assert.equal(rolledBack, false);
  assert.equal((await store.getState('t1', 'wf1')).state, 'CRITICAL');
});

test('with no captured email, the built-in email goes to the workflow recipients', async () => {
  const { sender, run } = setup();
  const result = await run('run-1', -28, { intents: [], fallbackRecipients: ['team@example.com'] });

  assert.equal(result.delivery.status, 'sent');
  const mail = sender.calls.at(-1);
  assert.deepEqual(mail.to, ['team@example.com']);
  assert.equal(mail.subject, 'CVR drop');
  assert.match(mail.text, /cvr_delta_pct is -28, at or below the critical threshold of -25\./);
});

test('returning to NORMAL records the transition and sends nothing', async () => {
  const { sender, run, setClock } = setup();
  await run('run-1', -17);
  setClock('2026-01-01T10:10:00Z');
  const back = await run('run-2', -3);
  setClock('2026-01-01T10:20:00Z');
  const still = await run('run-3', -2);

  assert.equal(back.evaluation.previous_state, 'TRIGGERED');
  assert.equal(back.evaluation.resulting_state, 'NORMAL');
  assert.equal(back.delivery.status, 'none');
  assert.equal(still.delivery.status, 'none');
  assert.equal(sender.calls.length, 1);
});

test('no recipients fails clearly without calling SMTP, and hands the cooldown back', async () => {
  const { store, sender, run } = setup();
  const result = await run('run-1', -17, { intents: [], fallbackRecipients: [] });

  assert.equal(result.delivery.status, 'failed');
  assert.match(result.delivery.error, /Email Insight/);
  assert.equal(result.delivery.rolledBack, true);
  assert.equal(sender.calls.length, 0);
  const state = await store.getState('t1', 'wf1');
  assert.equal(state.state, 'TRIGGERED');
  assert.equal(state.cooldown, null);
});
