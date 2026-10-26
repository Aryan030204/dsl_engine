const test = require('node:test');
const assert = require('node:assert/strict');

const queryExecutor = require('../sql/QueryExecutor');
const queryBuilder = require('../sql/QueryBuilder');
const metricCompare = require('../nodes/MetricCompareNode');
const { expandBaselineWindows, shiftSqlDateTimeByDays } = require('../lib/timeWindowUtils');
const { averageBaselineRows, relativeDeltaPct } = require('../lib/baselineAverage');
const { buildCronContext } = require('../scheduler/app/schedulerService');
const { SCHEDULE_WINDOW_MODE_VALUES } = require('../scheduler/app/scheduleWindowModes');

const WINDOW = { start: '2026-10-23 00:00:00', end: '2026-10-23 09:00:00' };
const BASELINE = { start: '2026-10-22 00:00:00', end: '2026-10-22 09:00:00' };

// ------------------------------------------------------------------ windows

test('a 7-day baseline expands into the same time-of-day range on each earlier day', () => {
  const windows = expandBaselineWindows(BASELINE, 7, 'Asia/Kolkata');
  assert.equal(windows.length, 7);
  assert.deepEqual(windows[0], BASELINE);
  assert.deepEqual(windows[6], { start: '2026-10-16 00:00:00', end: '2026-10-16 09:00:00' });
  windows.forEach((w) => assert.match(w.end, / 09:00:00$/));
});

test('baseline expansion crosses month and year boundaries and is off without a count', () => {
  assert.equal(shiftSqlDateTimeByDays('2027-01-02 09:00:00', -3), '2026-12-30 09:00:00');
  assert.equal(shiftSqlDateTimeByDays('2026-03-01 00:00:00', -1), '2026-02-28 00:00:00');
  assert.deepEqual(expandBaselineWindows(BASELINE, undefined), []);
  assert.deepEqual(expandBaselineWindows(BASELINE, 1), []);
  assert.deepEqual(expandBaselineWindows(null, 7), []);
});

test('the new schedule mode is accepted and builds a 7-day averaged context', () => {
  assert.ok(SCHEDULE_WINDOW_MODE_VALUES.includes('day_to_date_vs_7day_average'));
  const trigger = new Date('2026-10-23T06:03:00Z');
  const averaged = buildCronContext({ tenantId: 'VAMA', timezone: 'Asia/Kolkata', windowMode: 'day_to_date_vs_7day_average' }, trigger);
  const previous = buildCronContext({ tenantId: 'VAMA', timezone: 'Asia/Kolkata', windowMode: 'day_to_date_vs_previous_day' }, trigger);
  assert.equal(averaged.meta.baselineDays, 7);
  assert.equal('baselineDays' in previous.meta, false, 'existing modes are unchanged');
  assert.deepEqual(averaged.meta.window, previous.meta.window);
  assert.deepEqual(averaged.meta.baselineWindow, previous.meta.baselineWindow);
});

// ------------------------------------------------------------------ SQL

test('queries for existing metrics do not mention discounts, and placeholders always match params', () => {
  const plain = queryBuilder.buildMetricQuery({ tenantId: 'VAMA', metrics: ['orders', 'cod_orders', 'sales'], window: WINDOW, baselineWindow: BASELINE, timezone: 'Asia/Kolkata' });
  assert.equal(/discount/i.test(plain.sql), false);
  for (const metrics of [['orders'], ['cod_pct'], ['discount_rate'], ['discount_rate', 'cod_pct', 'sales']]) {
    const q = queryBuilder.buildMetricQuery({ tenantId: 'VAMA', metrics, window: WINDOW, baselineWindow: BASELINE, timezone: 'Asia/Kolkata' });
    assert.equal((q.sql.match(/\?/g) || []).length, q.params.length, metrics.join());
  }
});

test('discount metrics read order-level fields from shopify_orders, as the legacy monitor does', () => {
  const q = queryBuilder.buildMetricQuery({ tenantId: 'VAMA', metrics: ['discount_rate'], window: WINDOW, baselineWindow: BASELINE, timezone: 'Asia/Kolkata' });
  assert.match(q.sql, /SUM\(discount_amount\)/);
  assert.match(q.sql, /SUM\(total_price\)/);
  assert.match(q.sql, /COUNT\(DISTINCT order_id\)/);
  assert.match(q.sql, /discount_codes IS NOT NULL AND discount_codes != ''/);
});

// ------------------------------------------------------------------ averaging maths

const day = (fields) => ({ current_orders: 0, ...fields });

test('baseline sums are averaged over the days that had orders; a quiet day does not drag them down', () => {
  const avg = averageBaselineRows([
    day({ current_orders: 100, current_sessions: 1000 }),
    day({ current_orders: 200, current_sessions: 3000 }),
    day({ current_orders: 0, current_sessions: 0 }),
  ]);
  assert.equal(avg.baseline_days_seen, 2);
  assert.equal(avg.baseline_orders, 150);
  assert.equal(avg.baseline_sessions, 2000);
});

test('COD share baseline is the average of the daily percentages, not the pooled share', () => {
  const avg = averageBaselineRows([
    day({ current_orders: 10, current_cod_orders: 5, current_ppcod_orders: 0, current_prepaid_orders: 5 }),
    day({ current_orders: 1000, current_cod_orders: 100, current_ppcod_orders: 0, current_prepaid_orders: 900 }),
  ]);
  assert.equal(avg.baseline_cod_pct, 30);
  assert.equal(avg.baseline_prepaid_pct, 70);
});

test('no baseline days at all gives no percentages (never a crash) and relative change guards zero', () => {
  const avg = averageBaselineRows([]);
  assert.equal(avg.baseline_days_seen, 0);
  assert.equal(relativeDeltaPct(5, null), null);
  assert.equal(relativeDeltaPct(5, 0), null);
  assert.equal(relativeDeltaPct(110, 100), 10);
});

// ------------------------------------------------------------------ the node

async function runNode(def, meta, rowFor) {
  const original = queryExecutor.execute;
  const calls = [];
  queryExecutor.execute = async (spec) => {
    calls.push(spec);
    return { rows: [rowFor(spec, calls.length - 1)] };
  };
  try {
    const result = await metricCompare(def, { meta: { tenantId: 'VAMA', timezone: 'Asia/Kolkata', window: WINDOW, baselineWindow: BASELINE, ...meta } });
    return { result, calls };
  } finally {
    queryExecutor.execute = original;
  }
}

const baseRow = {
  current_sessions: 0, baseline_sessions: 0, current_atc_sessions: 0, baseline_atc_sessions: 0,
  current_adjusted_sessions: 0, baseline_adjusted_sessions: 0,
  current_orders: 0, baseline_orders: 0,
  current_cod_orders: 0, baseline_cod_orders: 0, current_ppcod_orders: 0, baseline_ppcod_orders: 0,
  current_prepaid_orders: 0, baseline_prepaid_orders: 0,
};

test('COD share: today against the 7-day average of the daily shares, as a relative change', async () => {
  const { result, calls } = await runNode(
    { metrics: ['cod_pct', 'prepaid_pct'] },
    { baselineDays: 7 },
    (spec, index) => (index === 0
      ? { ...baseRow, current_orders: 100, current_cod_orders: 46, current_prepaid_orders: 54 }
      : { ...baseRow, current_orders: 100, current_cod_orders: 40, current_prepaid_orders: 60 })
  );
  assert.equal(calls.length, 8, 'one current query + one per baseline day');
  const m = result.delta.metrics;
  assert.equal(m.current_cod_pct, 46);
  assert.equal(m.baseline_cod_pct, 40);
  assert.ok(Math.abs(m.cod_pct_delta_pct - 15) < 1e-9, '46 vs 40 is +15% relative');
  assert.equal(m.baseline_days_seen, 7);
  assert.equal(m.current_payment_orders, 100);
});

test('without baselineDays the node still makes a single query and the old outputs are unchanged', async () => {
  const { result, calls } = await runNode(
    { metrics: ['orders', 'cod_orders'] },
    {},
    () => ({ ...baseRow, current_orders: 120, baseline_orders: 100, current_cod_orders: 60, baseline_cod_orders: 50 })
  );
  assert.equal(calls.length, 1);
  assert.equal(result.delta.metrics.orders_delta_pct, 20);
  assert.equal('cod_pct_delta_pct' in result.delta.metrics, false);
  assert.equal('current_discount_rate' in result.delta.metrics, false);
  assert.equal('baseline_days_seen' in result.delta.metrics, false);
});

test('discount figures: rate, usage, growth and the growth gap use ratios of the averaged sums', async () => {
  const discountDay = { ...baseRow, current_orders: 100, current_discount_orders: 100, current_discounted_orders: 60, current_discount_amount: 6000, current_gross_sales: 100000, current_unique_discount_codes: 3 };
  const { result } = await runNode(
    { metrics: ['discount_rate', 'usage_rate', 'discount_amount', 'gross_sales'] },
    { baselineDays: 3 },
    (spec, index) => (index === 0
      ? { ...baseRow, current_orders: 100, current_discount_orders: 100, current_discounted_orders: 65, current_discount_amount: 7200, current_gross_sales: 103000, current_unique_discount_codes: 4 }
      : discountDay)
  );
  const m = result.delta.metrics;
  assert.ok(Math.abs(m.current_discount_rate - (7200 / 103000) * 100) < 1e-9);
  assert.equal(m.baseline_discount_rate, 6);
  assert.ok(Math.abs(m.discount_rate_delta_pct - ((7200 / 103000 * 100 - 6) / 6) * 100) < 1e-9);
  assert.equal(m.current_usage_rate, 65);
  assert.equal(m.baseline_usage_rate, 60);
  assert.ok(Math.abs(m.usage_rate_delta_pct - (5 / 60) * 100) < 1e-9);
  assert.equal(m.discount_amount_delta_pct, 20);
  assert.ok(Math.abs(m.gross_sales_delta_pct - 3) < 1e-9);
  assert.ok(Math.abs(m.discount_vs_sales_gap_pct - 17) < 1e-9);
  assert.equal(m.current_total_orders, 100);
  assert.equal(m.baseline_total_orders, 100);
});
