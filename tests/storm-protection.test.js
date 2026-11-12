const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { specConfig, step, runSequence } = require('./helpers/stateEngineHarness');
const { createStateEngineService } = require('../server/services/stateEngineService');
const { createFakeStateStore, createRecordingSender } = require('./helpers/fakeStateStore');
const { validateWorkflowDefinition } = require('../server/validation/workflowDefinition');
const { localDayKey } = require('../server/lib/stateEngine/localDay');

const loadStateConfig = () => import(pathToFileURL(path.join(__dirname, '../ui/src/utils/stateConfig.js')).href);

const STORM = (overrides = {}) => ({
  enabled: true,
  daily_limits: { triggered: 3, critical: 3, total: 6 },
  exceptional_alerts: {
    enabled: true,
    absolute: { enabled: true, value: -50 },
    difference: { enabled: true, value: 15 }
  },
  ...overrides
});
const cfg = (storm = STORM(), extra = {}) => specConfig({ storm_protection: storm, ...extra });
const hr = (h, day = '2026-01-01') => `${day}T${String(h).padStart(2, '0')}:00:00Z`;
const exhaustedPrior = (over = {}) => ({
  state: 'CRITICAL',
  cooldown: null,
  last_alert_at: null,
  last_value: -30,
  storm: { day: '2026-01-01', triggered_count: 3, critical_count: 3, total_count: 6, absolute_fired: false, difference_fired: false },
  ...over
});

// ---- Daily quota ---------------------------------------------------------------------

test('no storm_protection configured: behaviour is unchanged (reminders keep sending)', () => {
  const decisions = runSequence([-17, -17, -17, -17, -17].map((value, i) => ({ value, at: hr(i * 2) })), { config: specConfig() });
  assert.ok(decisions.every((d) => d.notification.should_send));
  assert.equal(decisions[0].storm, undefined);
  assert.equal(decisions[4].next.storm, undefined);
});

test('triggered quota: sends below the limit, suppresses at the limit, state still saved, cooldown not reset', () => {
  const decisions = runSequence([0, 2, 4, 6].map((h) => ({ value: -17, at: hr(h) })), { config: cfg() });
  assert.deepEqual(decisions.map((d) => d.notification.should_send), [true, true, true, false]);
  const held = decisions[3];
  assert.equal(held.notification.suppressed_by, 'daily_limit');
  assert.equal(held.storm.limit_type, 'triggered');
  assert.equal(held.storm.limit, 3);
  assert.equal(held.storm.used, 3);
  assert.equal(held.next.state, 'TRIGGERED');
  assert.deepEqual(held.next.cooldown, decisions[2].next.cooldown);
  assert.equal(held.next.last_alert_at, decisions[2].next.last_alert_at);
  assert.equal(held.next.storm.triggered_count, 3);
});

test('critical quota: below limit sends, at limit suppresses', () => {
  const decisions = runSequence([0, 1, 2, 3].map((h) => ({ value: -30, at: hr(h) })), { config: cfg() });
  assert.deepEqual(decisions.map((d) => d.notification.should_send), [true, true, true, false]);
  assert.equal(decisions[3].storm.limit_type, 'critical');
});

test('total quota suppresses even when the per-state limit has room', () => {
  const storm = STORM({ daily_limits: { triggered: 10, critical: 10, total: 2 } });
  const decisions = runSequence([0, 2, 4].map((h) => ({ value: -17, at: hr(h) })), { config: cfg(storm) });
  assert.deepEqual(decisions.map((d) => d.notification.should_send), [true, true, false]);
  assert.equal(decisions[2].storm.limit_type, 'total');
});

test('null limits are unlimited', () => {
  const storm = STORM({ daily_limits: { triggered: null, critical: null, total: null } });
  const decisions = runSequence([0, 2, 4, 6, 8, 10].map((h) => ({ value: -17, at: hr(h) })), { config: cfg(storm) });
  assert.ok(decisions.every((d) => d.notification.should_send));
});

test('cooldown-suppressed attempts do not consume quota', () => {
  const storm = STORM({ daily_limits: { triggered: 1, critical: null, total: null } });
  const [first, second] = runSequence([{ value: -17, at: '2026-01-01T10:00:00Z' }, { value: -17, at: '2026-01-01T10:10:00Z' }], { config: cfg(storm) });
  assert.equal(second.notification.suppressed_by, 'cooldown');
  assert.equal(second.next.storm.triggered_count, 1);
  assert.equal(first.next.storm.triggered_count, 1);
});

test('quota resets at tenant-local midnight (Asia/Kolkata, not UTC)', () => {
  const storm = STORM({ daily_limits: { triggered: 1, critical: null, total: null }, exceptional_alerts: { enabled: false } });
  const decisions = runSequence([
    { value: -17, at: '2026-01-01T10:00:00Z' }, // 15:30 IST
    { value: -17, at: '2026-01-01T17:00:00Z' }, // 22:30 IST, same local day
    { value: -17, at: '2026-01-01T19:00:00Z' }  // 00:30 IST next day
  ], { config: cfg(storm), timezone: 'Asia/Kolkata' });
  assert.deepEqual(decisions.map((d) => d.notification.should_send), [true, false, true]);
  assert.equal(decisions[2].next.storm.day, '2026-01-02');
});

test('a different tenant timezone resets at its own midnight (America/New_York)', () => {
  const storm = STORM({ daily_limits: { triggered: 1, critical: null, total: null }, exceptional_alerts: { enabled: false } });
  const decisions = runSequence([
    { value: -17, at: '2026-01-01T17:00:00Z' }, // 12:00 EST
    { value: -17, at: '2026-01-02T04:00:00Z' }, // 23:00 EST, same local day
    { value: -17, at: '2026-01-02T05:30:00Z' }  // 00:30 EST next day
  ], { config: cfg(storm), timezone: 'America/New_York' });
  assert.deepEqual(decisions.map((d) => d.notification.should_send), [true, false, true]);
  assert.equal(localDayKey(new Date('2026-01-02T04:59:00Z'), 'America/New_York'), '2026-01-01');
});

// ---- Exceptional alerts --------------------------------------------------------------

test('absolute exception: not reached -> no bypass; reached -> bypass, latch set, once per day', () => {
  const miss = step(exhaustedPrior(), -34, { at: hr(15), config: cfg() });
  assert.equal(miss.notification.should_send, false);
  assert.equal(miss.notification.suppressed_by, 'daily_limit');
  assert.equal(miss.storm.exceptional, false);

  const hit = step(exhaustedPrior({ last_value: -49 }), -51, { at: hr(16), config: cfg() });
  assert.equal(hit.notification.should_send, true);
  assert.equal(hit.notification.exceptional, true);
  assert.deepEqual(hit.notification.exception_reasons, ['absolute_threshold']);
  assert.equal(hit.notification.severity, 'CRITICAL');
  assert.equal(hit.resulting_state, 'CRITICAL');
  assert.equal(hit.storm.quota_bypassed, true);
  assert.equal(hit.next.storm.absolute_fired, true);
  assert.equal(hit.next.storm.difference_fired, false);

  const again = step(hit.next, -60, { at: hr(18), config: cfg(STORM({ exceptional_alerts: { enabled: true, absolute: { enabled: true, value: -50 }, difference: { enabled: false, value: 15 } } })) });
  assert.equal(again.notification.should_send, false);
  assert.equal(again.storm.absolute.latch_fired, true);
});

test('absolute exception can fire on a run with no previous value', () => {
  const prior = exhaustedPrior({ last_value: undefined });
  const storm = STORM({ exceptional_alerts: { enabled: true, absolute: { enabled: true, value: -50 }, difference: { enabled: false, value: null } } });
  const d = step(prior, -55, { at: hr(12), config: cfg(storm) });
  assert.equal(d.notification.should_send, true);
});

test('latches reset at tenant-local midnight (and the quota with them)', () => {
  const day1 = step(exhaustedPrior(), -51, { at: '2026-01-01T12:00:00Z', config: cfg() });
  assert.equal(day1.next.storm.absolute_fired, true);
  // Next local day: counters zero, latch clear. Exhaust the critical quota again, then an exception fires again.
  const storm = STORM({ daily_limits: { triggered: null, critical: 1, total: null } });
  const decisions = runSequence([
    { value: -30, at: '2026-01-02T01:00:00Z' },
    { value: -31, at: '2026-01-02T03:00:00Z' },
    { value: -52, at: '2026-01-02T05:00:00Z' }
  ], { config: cfg(storm), prior: day1.next });
  assert.deepEqual(decisions.map((d) => d.notification.should_send), [true, false, true]);
  assert.equal(decisions[0].storm.absolute.latch_fired, false);
  assert.equal(decisions[2].notification.exceptional, true);
});

test('difference exception (DROP): below threshold no, exactly at threshold yes, then latched', () => {
  const storm = STORM({ daily_limits: { triggered: null, critical: 1, total: null }, exceptional_alerts: { enabled: true, absolute: { enabled: false, value: null }, difference: { enabled: true, value: 15 } } });
  const decisions = runSequence([-30, -31, -45, -60, -80].map((value, i) => ({ value, at: hr(i * 2) })), { config: cfg(storm) });
  assert.deepEqual(decisions.map((d) => d.notification.should_send), [true, false, false, true, false]);
  assert.equal(decisions[2].storm.difference.deterioration, 14);
  assert.equal(decisions[3].storm.difference.deterioration, 15);
  assert.deepEqual(decisions[3].notification.exception_reasons, ['difference_threshold']);
  assert.equal(decisions[4].storm.difference.deterioration, 20);
  assert.equal(decisions[4].storm.difference.latch_fired, true);
});

test('difference exception (RISE): deterioration is current - previous', () => {
  const rise = { thresholds: { normal: 15, critical: 25 } };
  const storm = STORM({ daily_limits: { triggered: null, critical: 1, total: null }, exceptional_alerts: { enabled: true, absolute: { enabled: false, value: null }, difference: { enabled: true, value: 15 } } });
  const decisions = runSequence([30, 31, 45, 60].map((value, i) => ({ value, at: hr(i * 2) })), { config: cfg(storm, rise) });
  assert.deepEqual(decisions.map((d) => d.notification.should_send), [true, false, false, true]);
  assert.equal(decisions[3].storm.difference.deterioration, 15);
});

test('RISE absolute exception compares in the opposite direction', () => {
  const rise = { thresholds: { normal: 15, critical: 25 } };
  const storm = STORM({ exceptional_alerts: { enabled: true, absolute: { enabled: true, value: 50 }, difference: { enabled: false, value: null } } });
  assert.equal(step(exhaustedPrior(), 49, { at: hr(12), config: cfg(storm, rise) }).notification.should_send, false);
  assert.equal(step(exhaustedPrior(), 50, { at: hr(12), config: cfg(storm, rise) }).notification.should_send, true);
});

test('difference exception needs a previous value', () => {
  const storm = STORM({ exceptional_alerts: { enabled: true, absolute: { enabled: false, value: null }, difference: { enabled: true, value: 15 } } });
  const d = step(exhaustedPrior({ last_value: undefined }), -80, { at: hr(12), config: cfg(storm) });
  assert.equal(d.notification.should_send, false);
  assert.equal(d.storm.difference.deterioration, null);
});

test('both exceptions in one run: ONE notification, both reasons, both latches', () => {
  const d = step(exhaustedPrior({ last_value: -30 }), -60, { at: hr(12), config: cfg() });
  assert.equal(d.notification.should_send, true);
  assert.deepEqual(d.notification.exception_reasons, ['absolute_threshold', 'difference_threshold']);
  assert.equal(d.next.storm.absolute_fired, true);
  assert.equal(d.next.storm.difference_fired, true);
});

test('latches are independent: absolute first, difference can still fire later', () => {
  const first = step(exhaustedPrior({ last_value: -49 }), -51, { at: hr(12), config: cfg() }); // det 2: absolute only
  assert.deepEqual(first.notification.exception_reasons, ['absolute_threshold']);
  const second = step(first.next, -70, { at: hr(14), config: cfg() }); // det 19: difference only (absolute latched)
  assert.deepEqual(second.notification.exception_reasons, ['difference_threshold']);
  const third = step(second.next, -95, { at: hr(16), config: cfg() });
  assert.equal(third.notification.should_send, false);
});

test('exceptional sends still count toward the daily counters', () => {
  const d = step(exhaustedPrior(), -51, { at: hr(12), config: cfg() });
  assert.equal(d.next.storm.critical_count, 4);
  assert.equal(d.next.storm.total_count, 7);
});

test('a normal send that also meets an exception condition does not consume the latch', () => {
  const d = step(exhaustedPrior({ storm: { day: '2026-01-01', triggered_count: 0, critical_count: 0, total_count: 0 } }), -55, { at: hr(12), config: cfg() });
  assert.equal(d.notification.should_send, true);
  assert.equal(d.notification.exceptional, undefined);
  assert.equal(d.next.storm.absolute_fired, false);
});

// ---- Interaction with existing gates -------------------------------------------------

test('exceptional does not bypass an active cooldown', () => {
  const prior = exhaustedPrior({ cooldown: { state: 'CRITICAL', duration_minutes: 30, started_at: '2026-01-01T11:50:00Z' } });
  const d = step(prior, -60, { at: '2026-01-01T12:00:00Z', config: cfg() });
  assert.equal(d.notification.suppressed_by, 'cooldown');
  assert.equal(d.next.storm.absolute_fired, false);
});

test('exceptional does not bypass quiet hours', () => {
  const quiet = { quiet_hours: { enabled: true, start: '23:00', end: '07:00' } };
  const d = step(exhaustedPrior(), -60, { at: '2026-01-01T02:00:00Z', config: cfg(STORM(), quiet) });
  assert.equal(d.notification.suppressed_by, 'quiet_hours');
  assert.equal(d.next.storm.absolute_fired, false);
});

test('an escalation still bypasses cooldown but is subject to the quota', () => {
  const prior = {
    state: 'TRIGGERED',
    cooldown: { state: 'TRIGGERED', duration_minutes: 60, started_at: '2026-01-01T11:50:00Z' },
    storm: { day: '2026-01-01', triggered_count: 1, critical_count: 3, total_count: 4 }
  };
  const blocked = step(prior, -28, { at: '2026-01-01T12:00:00Z', config: cfg(STORM({ exceptional_alerts: { enabled: false } })) });
  assert.equal(blocked.notification.candidate_reason, 'ESCALATION');
  assert.equal(blocked.notification.suppressed_by, 'daily_limit');

  const open = step({ ...prior, storm: { ...prior.storm, critical_count: 0 } }, -28, { at: '2026-01-01T12:00:00Z', config: cfg() });
  assert.equal(open.notification.should_send, true);
  assert.equal(open.cooldown.bypassed, true);
});

test('NORMAL -> CRITICAL is held by quiet hours when storm protection is on', () => {
  const quiet = { quiet_hours: { enabled: true, start: '23:00', end: '07:00' } };
  const d = step({ state: 'NORMAL' }, -30, { at: '2026-01-01T02:00:00Z', config: cfg(STORM(), quiet) });
  assert.equal(d.notification.should_send, false);
  assert.equal(d.notification.suppressed_by, 'quiet_hours');
  assert.equal(d.next.storm.critical_count, 0);
});

test('de-escalation keeps working and counts as a triggered alert', () => {
  const d = step({ state: 'CRITICAL', cooldown: null }, -17, { at: hr(12), config: cfg() });
  assert.equal(d.notification.reason, 'DE_ESCALATION');
  assert.equal(d.next.storm.triggered_count, 1);
});

test('decision matrix', () => {
  const cases = [
    // [label, prior, value, extra config, expected]
    ['TRIGGERED, quota exhausted, absolute reached, latch unused -> SEND exceptional',
      exhaustedPrior({ state: 'TRIGGERED', last_value: -48 }), -51, {}, { send: true, exceptional: true }],
    ['CRITICAL, quota exhausted, absolute reached, latch used -> SUPPRESS',
      exhaustedPrior({ storm: { ...exhaustedPrior().storm, absolute_fired: true } }), -55, { diff: false }, { send: false, by: 'daily_limit' }],
    ['CRITICAL, quota exhausted, no exception -> SUPPRESS',
      exhaustedPrior(), -33, {}, { send: false, by: 'daily_limit' }],
    ['CRITICAL, quota exhausted, cooldown active -> SUPPRESS by cooldown',
      exhaustedPrior({ cooldown: { state: 'CRITICAL', duration_minutes: 30, started_at: '2026-01-01T11:50:00Z' } }), -55, {}, { send: false, by: 'cooldown' }],
    ['CRITICAL, quota open -> SEND normal',
      exhaustedPrior({ storm: { day: '2026-01-01', triggered_count: 0, critical_count: 0, total_count: 0 } }), -33, {}, { send: true, exceptional: false }]
  ];
  for (const [label, prior, value, extra, expected] of cases) {
    const storm = extra.diff === false
      ? STORM({ exceptional_alerts: { enabled: true, absolute: { enabled: true, value: -50 }, difference: { enabled: false, value: null } } })
      : STORM();
    const d = step(prior, value, { at: '2026-01-01T12:00:00Z', config: cfg(storm) });
    assert.equal(d.notification.should_send, expected.send, label);
    if (expected.by) assert.equal(d.notification.suppressed_by, expected.by, label);
    if (expected.exceptional !== undefined) assert.equal(Boolean(d.notification.exceptional), expected.exceptional, label);
  }
});

// ---- Service: concurrency, replay, delivery ------------------------------------------

function serviceSetup({ statuses, telegramSender } = {}) {
  const store = createFakeStateStore();
  const sender = createRecordingSender(statuses);
  let clock = new Date('2026-01-01T12:00:00Z');
  const service = createStateEngineService({ store, sender, telegramSender, now: () => new Date(clock) });
  const run = (executionId, value, extra = {}) => service.processExecution({
    tenantId: 't1', workflowId: 'wf1', executionId, triggerType: 'cron',
    context: { metrics: { cvr_delta_pct: value } },
    config: { enabled: true, finding: { metric: 'cvr_delta_pct' }, thresholds: { normal: -15, critical: -25 }, cooldown: { triggered_minutes: 60, critical_minutes: 30 }, storm_protection: STORM() },
    intents: [{ to: ['ops@example.com'], subject: 'S', html: '<p>x</p>', text: 'x' }],
    workflowName: 'wf', ...extra
  });
  const seed = async (doc) => { await store.insertState({ tenantId: 't1', workflowId: 'wf1', version: 1, ...doc }); };
  return { store, sender, service, run, seed, setClock: (iso) => { clock = new Date(iso); } };
}

test('concurrent workers cannot exceed the critical quota', async () => {
  const { store, sender, run, seed } = serviceSetup();
  await seed({ state: 'TRIGGERED', cooldown: null, last_value: -17, storm: { day: '2026-01-01', triggered_count: 0, critical_count: 2, total_count: 2, absolute_fired: false, difference_fired: false } });
  const results = await Promise.all([run('a', -30), run('b', -30)]);
  const state = await store.getState('t1', 'wf1');
  assert.equal(sender.calls.length, 1);
  assert.equal(state.storm.critical_count, 3);
  assert.equal(results.filter((r) => r.delivery.status === 'sent').length, 1);
});

test('concurrent workers cannot both claim the same exceptional latch', async () => {
  const { store, sender, run, seed } = serviceSetup();
  await seed({ ...exhaustedPrior(), version: 1 });
  await Promise.all([run('a', -60), run('b', -61)]);
  const state = await store.getState('t1', 'wf1');
  assert.equal(sender.calls.length, 1);
  assert.equal(state.storm.absolute_fired, true);
});

test('a replayed execution neither increments counters nor fires the exception twice', async () => {
  const { store, sender, run, seed } = serviceSetup();
  await seed({ ...exhaustedPrior(), version: 1 });
  await run('a', -60);
  const before = await store.getState('t1', 'wf1');
  const replay = await run('a', -90);
  const after = await store.getState('t1', 'wf1');
  assert.equal(replay.replayed, true);
  assert.deepEqual(after.storm, before.storm);
  assert.equal(after.version, before.version);
  assert.equal(sender.calls.length, 1);
});

test('failed delivery hands quota and exception latch back', async () => {
  const { store, sender, run, seed } = serviceSetup({ statuses: ['failed'] });
  const prior = exhaustedPrior();
  await seed({ ...prior, version: 1 });
  const result = await run('a', -60);
  assert.equal(result.delivery.status, 'failed');
  assert.equal(result.delivery.rolledBack, true);
  const state = await store.getState('t1', 'wf1');
  assert.deepEqual(state.storm, prior.storm);
  assert.equal(state.storm.absolute_fired, false);
  assert.equal(sender.calls.length, 1);
});

test('partial delivery (Telegram got through) keeps the quota consumed', async () => {
  const { store, run, seed } = serviceSetup({ statuses: ['failed'], telegramSender: async () => ({ status: 'sent' }) });
  await seed({ ...exhaustedPrior(), version: 1 });
  const result = await run('a', -60, { telegramIntents: [{ chat: 1, text: 'x' }] });
  assert.equal(result.delivery.status, 'partial');
  const state = await store.getState('t1', 'wf1');
  assert.equal(state.storm.absolute_fired, true);
});

test('a run with no notifier on its path consumes no quota', async () => {
  const { store, run, seed } = serviceSetup();
  await seed({ state: 'NORMAL', cooldown: null, storm: { day: '2026-01-01', triggered_count: 0, critical_count: 0, total_count: 0 }, last_value: -2 });
  await run('a', -17, { intents: [] });
  assert.equal((await store.getState('t1', 'wf1')).storm.triggered_count, 0);
});

test('previous value is persisted from the last conclusive finding, even when nothing was sent', async () => {
  const { store, run } = serviceSetup();
  await run('a', -17);
  await run('b', -18);
  assert.equal((await store.getState('t1', 'wf1')).last_value, -18);
});

// ---- Backend validation --------------------------------------------------------------

function stormErrors(storm) {
  const definition = {
    name: 'x', nodes: [{ id: 'e', type: 'email', to: ['a@b.com'] }],
    state_config: { enabled: true, finding: { metric: 'cvr_delta_pct' }, thresholds: { normal: -15, critical: -25 }, storm_protection: storm }
  };
  const result = validateWorkflowDefinition(definition);
  return (Array.isArray(result) ? result : result?.errors || []).filter((e) => /storm_protection/.test(e));
}

test('backend validation accepts a valid block and a missing block', () => {
  assert.deepEqual(stormErrors(STORM()), []);
  assert.deepEqual(stormErrors(undefined), []);
});

test('backend validation rejects bad limits and exception values', () => {
  assert.ok(stormErrors(STORM({ daily_limits: { triggered: 0 } })).length);
  assert.ok(stormErrors(STORM({ daily_limits: { critical: -1 } })).length);
  assert.ok(stormErrors(STORM({ daily_limits: { total: 1.5 } })).length);
  assert.ok(stormErrors(STORM({ exceptional_alerts: { enabled: true, difference: { enabled: true, value: 0 } } })).length);
  assert.ok(stormErrors(STORM({ exceptional_alerts: { enabled: true, absolute: { enabled: true, value: 'x' } } })).length);
  // a disabled toggle may hold a stale value
  assert.deepEqual(stormErrors(STORM({ exceptional_alerts: { enabled: true, difference: { enabled: false, value: 0 } } })), []);
});

// ---- Frontend config contract --------------------------------------------------------

test('UI: storm protection round-trips and unrelated state_config fields survive', async () => {
  const { withStateConfigDefaults } = await loadStateConfig();
  const saved = {
    enabled: true, finding: { metric: 'sessions_delta_pct' }, thresholds: { normal: -10, critical: -20 },
    cooldown: { triggered_minutes: 45, critical_minutes: 15 }, quiet_hours: { enabled: true, start: '22:00', end: '06:00' },
    storm_protection: STORM()
  };
  const once = withStateConfigDefaults(saved);
  assert.deepEqual(once, saved);
  assert.deepEqual(withStateConfigDefaults(once), saved);
});

test('UI: workflows without storm_protection do not acquire one', async () => {
  const { withStateConfigDefaults, getStateConfigErrors } = await loadStateConfig();
  const config = withStateConfigDefaults({ enabled: true, thresholds: { normal: -15, critical: -25 } });
  assert.equal('storm_protection' in config, false);
  const errors = getStateConfigErrors({ state_config: config, nodes: [{ type: 'email', to: ['a@b.com'] }] });
  assert.deepEqual(errors, []);
});

test('UI: disabled toggles keep their values and runtime fields are never carried', async () => {
  const { withStormProtectionDefaults, withStateConfigDefaults } = await loadStateConfig();
  const storm = withStormProtectionDefaults({
    enabled: false,
    daily_limits: { triggered: 4, critical: null, total: 9 },
    exceptional_alerts: { enabled: false, absolute: { enabled: false, value: -60 }, difference: { enabled: false, value: 12 } },
    // runtime bookkeeping must be dropped
    day: '2026-01-01', triggered_count: 2, absolute_fired: true, difference_fired: true
  });
  assert.equal(storm.daily_limits.triggered, 4);
  assert.equal(storm.exceptional_alerts.absolute.value, -60);
  assert.equal(storm.exceptional_alerts.difference.value, 12);
  const serialized = JSON.stringify(withStateConfigDefaults({ enabled: true, storm_protection: { ...storm, storm: { absolute_fired: true }, last_value: -3 } }));
  for (const key of ['absolute_fired', 'difference_fired', 'triggered_count', 'critical_count', 'total_count', 'last_value', '"day"']) {
    assert.equal(serialized.includes(key), false, key);
  }
});

test('UI: invalid values are flagged', async () => {
  const { getStormProtectionErrors } = await loadStateConfig();
  assert.deepEqual(getStormProtectionErrors(STORM()), []);
  assert.equal(getStormProtectionErrors(STORM({ daily_limits: { triggered: 0, critical: 2.5, total: '' } })).length, 3);
  assert.equal(getStormProtectionErrors(STORM({ exceptional_alerts: { enabled: true, absolute: { enabled: true, value: '' }, difference: { enabled: true, value: -1 } } })).length, 2);
});

test('end to end: UI config -> backend normalization -> engine -> runtime state, kept separate', async () => {
  const { withStateConfigDefaults } = await loadStateConfig();
  const uiConfig = withStateConfigDefaults({ enabled: true, thresholds: { normal: -15, critical: -25 }, storm_protection: STORM() });
  assert.deepEqual(stormErrors(uiConfig.storm_protection), []);
  const { store, run } = (() => serviceSetup())();
  const result = await run('e2e', -17, {
    config: { ...uiConfig, cooldown: { triggered_minutes: 60, critical_minutes: 30 } }
  });
  const state = await store.getState('t1', 'wf1');
  assert.equal(result.delivery.status, 'sent');
  assert.equal(state.storm.triggered_count, 1);
  // runtime state never leaks into the config the UI round-trips
  assert.equal('storm' in uiConfig, false);
  assert.equal('triggered_count' in uiConfig.storm_protection, false);
});
