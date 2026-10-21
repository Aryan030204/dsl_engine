const test = require('node:test');
const assert = require('node:assert/strict');

const { getNextRunAt, listMissedRuns, parseCronExpr, validateCronExpr } = require('../scheduler/app/cronUtils');
const { evaluateDueSchedules, buildCronContext } = require('../scheduler/app/schedulerService');

const iso = (date) => date.toISOString();

// ---------------------------------------------------------------- cron parsing and next-run search

test('next run times for common schedules (tenant time zone, DST-safe)', () => {
  const from = new Date('2026-10-21T06:30:00Z');
  assert.equal(iso(getNextRunAt('3 11,14,17,20,23 * * *', from, 'Asia/Kolkata')), '2026-10-21T08:33:00.000Z');
  assert.equal(iso(getNextRunAt('*/15 * * * *', from, 'UTC')), '2026-10-21T06:45:00.000Z');
  assert.equal(iso(getNextRunAt('0 9 1 * *', from, 'Asia/Kolkata')), '2026-11-01T03:30:00.000Z');
  assert.equal(iso(getNextRunAt('0 0 1 1 *', from, 'Asia/Kolkata')), '2026-12-31T18:30:00.000Z');
  // the cursor never returns the instant it started from
  assert.equal(iso(getNextRunAt('30 6 * * *', from, 'UTC')), '2026-10-22T06:30:00.000Z');
  // 02:30 does not exist on the US spring-forward day, so that day is skipped like standard cron
  const dates = listMissedRuns('30 2 * * *', new Date('2026-03-07T12:00:00Z'), new Date('2026-03-10T12:00:00Z'), 10, 'America/New_York').map(iso);
  assert.deepEqual(dates, ['2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z']);
});

test('weekday 7 is Sunday, ranges can have steps, and day-of-month OR weekday follows standard cron', () => {
  const from = new Date('2026-10-21T06:30:00Z'); // a Wednesday
  assert.equal(iso(getNextRunAt('0 9 * * 7', from, 'UTC')), '2026-10-25T09:00:00.000Z');
  assert.equal(iso(getNextRunAt('0 9 * * 0', from, 'UTC')), '2026-10-25T09:00:00.000Z');

  const days = listMissedRuns('0 9 1-10/3 * *', new Date('2026-10-01T00:00:00Z'), new Date('2026-10-12T00:00:00Z'), 50, 'UTC')
    .map((date) => date.getUTCDate());
  assert.deepEqual(days, [1, 4, 7, 10]);
  assert.deepEqual(
    listMissedRuns('0 0 5/10 * *', new Date('2026-10-01T00:00:00Z'), new Date('2026-10-31T00:00:00Z'), 50, 'UTC').map((d) => d.getUTCDate()),
    [5, 15, 25]
  );

  // "13th of the month OR a Friday": the next Friday (Oct 23) comes before Nov 13
  assert.equal(iso(getNextRunAt('0 9 13 * 5', from, 'UTC')), '2026-10-23T09:00:00.000Z');
  // only one of them restricted: still a plain match
  const weekdays = listMissedRuns('0 9 * * 1-5', new Date('2026-10-16T00:00:00Z'), new Date('2026-10-21T23:00:00Z'), 10, 'UTC')
    .map((date) => iso(date).slice(5, 10));
  assert.deepEqual(weekdays, ['10-16', '10-19', '10-20', '10-21']);
});

test('invalid cron expressions are rejected immediately instead of being ignored', () => {
  for (const bad of ['abc * * * *', '61 * * * *', '*/0 * * * *', '* * * 13 *', '* 24 * * *', '* * 0 * *', '* * * * 8', '5-1 * * * *', '1,,2 * * * *', '* * * *', '']) {
    assert.equal(validateCronExpr(bad).ok, false, bad);
    assert.throws(() => getNextRunAt(bad, new Date(), 'UTC'), undefined, bad);
  }
  assert.equal(validateCronExpr('*/5 * * * *').ok, true);
  assert.equal(validateCronExpr('3 11,14,17,20,23 * * 1-5').ok, true);
  assert.match(validateCronExpr('abc * * * *').error, /invalid cron minute "abc"/);
  assert.ok(parseCronExpr('0 9 * * 7').weekday.has(0));
});

test('searching ahead is fast even for rare expressions and long downtime windows', () => {
  const start = Date.now();
  getNextRunAt('0 0 29 2 *', new Date('2026-10-21T00:00:00Z'), 'Asia/Kolkata'); // next Feb 29
  const slots = listMissedRuns('*/15 * * * *', new Date('2026-10-08T11:33:00Z'), new Date('2026-10-21T06:30:00Z'), 5000, 'Asia/Kolkata');
  assert.equal(slots.length, 1228);
  assert.ok(Date.now() - start < 1500, `took ${Date.now() - start}ms`);
});

// ---------------------------------------------------------------- due-schedule evaluation

function makeEnv(schedule) {
  const state = { ...schedule };
  const calls = { enqueue: [], missed: [], claims: 0, updates: [] };
  const matches = (filter) => {
    if (filter.nextRunAt && new Date(filter.nextRunAt).getTime() !== new Date(state.nextRunAt).getTime()) return false;
    if (filter.isActive !== undefined && state.isActive !== filter.isActive) return false;
    return true;
  };
  const scheduleModel = {
    find: () => ({ lean: async () => (state.isActive && new Date(state.nextRunAt) <= now() ? [{ ...state }] : []) }),
    async findOneAndUpdate(filter, update) {
      if (!matches(filter)) return null;
      calls.claims += 1;
      const before = { ...state };
      Object.assign(state, update.$set);
      return before;
    },
    async updateOne(filter, update) {
      calls.updates.push(update.$set);
      if (!matches(filter)) return;
      Object.assign(state, update.$set);
    }
  };
  let clock = new Date('2026-10-21T08:33:20Z');
  const now = () => clock;
  const deps = {
    scheduleModel,
    resolveVersion: async () => ({ workflowVersion: { definitionJson: { name: 'wf' } }, versionId: 'v1' }),
    enqueue: async (params) => { calls.enqueue.push(params); return { enqueued: true, reason: null, run: { _id: `run-${calls.enqueue.length}` } }; },
    recordMissed: async (id, from, to) => { calls.missed.push({ id, from, to }); return [{}, {}, {}]; }
  };
  return { state, calls, deps, setNow: (value) => { clock = new Date(value); }, now };
}

const baseSchedule = () => ({
  _id: 's1', tenantId: 'AJMAL', workflowId: 'wf_1', isActive: true, cronExpr: '3 11,14,17,20,23 * * *',
  timezone: 'Asia/Kolkata', windowMode: 'day_to_date_vs_previous_day', overlapPolicy: 'queue_one_pending',
  nextRunAt: new Date('2026-10-21T08:33:00Z'), lastTriggeredAt: new Date('2026-10-20T15:33:00Z')
});

test('an on-time schedule runs once, with windows built from the slot that was due', async () => {
  const env = makeEnv(baseSchedule());
  const results = await evaluateDueSchedules(env.now(), { deps: env.deps });

  assert.equal(results.length, 1);
  assert.equal(results[0].enqueued, true);
  assert.equal(env.calls.enqueue.length, 1);
  assert.equal(env.calls.missed.length, 0, 'an on-time run is not a missed trigger');
  assert.equal(iso(env.state.nextRunAt), '2026-10-21T11:33:00.000Z');
  assert.equal(iso(env.state.lastTriggeredAt), '2026-10-21T08:33:20.000Z');
  // 14:03 IST slot: today 00:00 to 14:00, built from the due time (not from the later "now")
  assert.equal(env.calls.enqueue[0].context.meta.window.end, '2026-10-21T08:30:00.000Z');
  assert.equal(env.calls.enqueue[0].triggerType, 'cron');

  // evaluated again right away: nothing is due, nothing is queued twice
  assert.equal((await evaluateDueSchedules(env.now(), { deps: env.deps })).length, 0);
  assert.equal(env.calls.enqueue.length, 1);
});

test('a schedule that is long overdue is skipped, recorded as missed, and moved to the next future slot', async () => {
  const env = makeEnv({ ...baseSchedule(), nextRunAt: new Date('2026-10-08T11:33:00Z') });
  const results = await evaluateDueSchedules(env.now(), { deps: env.deps });

  assert.equal(results[0].reason, 'stale_skipped');
  assert.equal(results[0].enqueued, false);
  assert.equal(results[0].missedCount, 3);
  assert.equal(env.calls.enqueue.length, 0, 'no run on a 13-day-old window');
  assert.equal(iso(env.calls.missed[0].from), '2026-10-08T11:32:59.999Z');
  assert.equal(iso(env.calls.missed[0].to), '2026-10-21T08:33:20.000Z');
  assert.equal(iso(env.state.nextRunAt), '2026-10-21T11:33:00.000Z');
  assert.equal(iso(env.state.lastTriggeredAt), '2026-10-20T15:33:00.000Z', 'lastTriggeredAt is not touched by a skip');
});

test('a slot just inside the grace period still runs', async () => {
  const env = makeEnv({ ...baseSchedule(), nextRunAt: new Date('2026-10-21T08:30:00Z') }); // due 3m20s ago
  const results = await evaluateDueSchedules(env.now(), { deps: env.deps });
  assert.equal(results[0].enqueued, true);
  assert.equal(env.calls.missed.length, 0);

  const late = makeEnv({ ...baseSchedule(), nextRunAt: new Date('2026-10-21T08:20:00Z') }); // due 13m20s ago
  assert.equal((await evaluateDueSchedules(late.now(), { deps: late.deps }))[0].reason, 'stale_skipped');
  // and the grace period is configurable
  const wide = makeEnv({ ...baseSchedule(), nextRunAt: new Date('2026-10-21T08:20:00Z') });
  assert.equal((await evaluateDueSchedules(wide.now(), { staleGraceMs: 30 * 60 * 1000, deps: wide.deps }))[0].enqueued, true);
});

test('a slot another worker already claimed is not queued a second time', async () => {
  const env = makeEnv(baseSchedule());
  const original = env.deps.scheduleModel.findOneAndUpdate;
  env.deps.scheduleModel.findOneAndUpdate = async () => null; // lost the race
  const results = await evaluateDueSchedules(env.now(), { deps: env.deps });
  assert.equal(results[0].reason, 'claimed_elsewhere');
  assert.equal(env.calls.enqueue.length, 0);
  env.deps.scheduleModel.findOneAndUpdate = original;
});

test('if queueing fails the slot is handed back so the next tick retries it', async () => {
  const env = makeEnv(baseSchedule());
  env.deps.enqueue = async () => { throw new Error('mongo hiccup'); };
  const originalError = console.error;
  console.error = () => {};
  let results;
  try {
    results = await evaluateDueSchedules(env.now(), { deps: env.deps });
  } finally {
    console.error = originalError;
  }
  assert.equal(results[0].reason, 'schedule_evaluation_failed');
  assert.equal(iso(env.state.nextRunAt), '2026-10-21T08:33:00.000Z', 'still due');
  assert.equal(env.state.isActive, true);
  assert.equal(env.calls.updates.at(-1)['metadata.lastScheduleError'], 'mongo hiccup');
});

test('a stored schedule with an invalid cron fails before anything is queued, every tick', async () => {
  const env = makeEnv({ ...baseSchedule(), cronExpr: 'abc * * * *' });
  const originalError = console.error;
  console.error = () => {};
  let results;
  try {
    results = await evaluateDueSchedules(env.now(), { deps: env.deps });
  } finally {
    console.error = originalError;
  }
  assert.equal(results[0].reason, 'schedule_evaluation_failed');
  assert.match(results[0].error, /invalid cron minute/);
  assert.equal(env.calls.enqueue.length, 0);
  assert.equal(env.calls.claims, 0);
});

test('a schedule whose workflow no longer exists is deactivated', async () => {
  const env = makeEnv(baseSchedule());
  env.deps.resolveVersion = async () => { const error = new Error('workflow not found'); error.status = 404; throw error; };
  const originalError = console.error;
  console.error = () => {};
  try {
    await evaluateDueSchedules(env.now(), { deps: env.deps });
  } finally {
    console.error = originalError;
  }
  assert.equal(env.state.isActive, false);
});

test('day-to-date windows are built from the slot time in the tenant time zone', () => {
  const context = buildCronContext(
    { tenantId: 'AJMAL', timezone: 'Asia/Kolkata', windowMode: 'day_to_date_vs_previous_day' },
    new Date('2026-10-21T08:33:00Z'),
    {}
  );
  assert.equal(context.meta.window.start, '2026-10-20T18:30:00.000Z');
  assert.equal(context.meta.window.end, '2026-10-21T08:30:00.000Z');
  assert.equal(context.meta.baselineWindow.start, '2026-10-19T18:30:00.000Z');
  assert.equal(context.meta.baselineWindow.end, '2026-10-20T08:30:00.000Z');
});

test('a due run that cannot be queued (previous run still going) leaves a visible reason and clears it once a run is queued', async () => {
  const env = makeEnv(baseSchedule());
  env.deps.enqueue = async () => ({ enqueued: false, reason: 'pending_run_exists', run: null });
  const originalWarn = console.warn;
  console.warn = () => {};
  let results;
  try {
    results = await evaluateDueSchedules(env.now(), { deps: env.deps });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(results[0].enqueued, false);
  assert.equal(results[0].reason, 'pending_run_exists');
  assert.equal(env.state['metadata.lastSkipReason'], 'pending_run_exists');
  assert.equal(iso(env.state['metadata.lastSkippedAt']), '2026-10-21T08:33:20.000Z');
  assert.equal(env.state.lastTriggeredAt.toISOString(), '2026-10-20T15:33:00.000Z', 'a skipped run is not a trigger');

  // next slot queues fine: the warning goes away
  env.deps.enqueue = async () => ({ enqueued: true, reason: null, run: { _id: 'r2' } });
  env.setNow('2026-10-21T11:33:10Z');
  await evaluateDueSchedules(env.now(), { deps: env.deps });
  assert.equal(env.state['metadata.lastSkipReason'], null);
});
