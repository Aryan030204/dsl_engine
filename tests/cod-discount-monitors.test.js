const test = require('node:test');
const assert = require('node:assert/strict');

const queryExecutor = require('../sql/QueryExecutor');
const { productPaymentMixQuery, discountGroupedQuery } = require('../sql/templates/monitorQueries');
const breakdownNode = require('../nodes/RecursiveDimensionBreakdownNode');
const { averageShares } = require('../nodes/monitors/discountMonitor');
const { validateWorkflowDefinition } = require('../server/validation/workflowDefinition');

const WINDOW = { start: '2026-10-23 00:00:00', end: '2026-10-23 09:00:00' };
const BASELINE = { start: '2026-10-22 00:00:00', end: '2026-10-22 09:00:00' };

function withExecutor(handler) {
  const original = queryExecutor.execute;
  const calls = [];
  queryExecutor.execute = async (spec) => {
    calls.push(spec);
    return handler(spec, calls.length - 1);
  };
  return { calls, restore: () => { queryExecutor.execute = original; } };
}

const context = (metrics, meta = {}) => ({
  meta: { tenantId: 'VAMA', timezone: 'Asia/Kolkata', window: WINDOW, baselineWindow: BASELINE, baselineDays: 7, ...meta },
  metrics,
  scratch: {}
});

// ------------------------------------------------------------------ SQL

test('COD product query reads one range, one row per whitelisted product, and binds every value', () => {
  const q = productPaymentMixQuery({ tenantId: 'VAMA', range: WINDOW, timezone: 'Asia/Kolkata', productIds: ['8622333100210', 8715135189170] });
  assert.equal((q.sql.match(/\?/g) || []).length, q.params.length);
  assert.match(q.sql, /Gokwik PPCOD/);
  assert.match(q.sql, /GROUP BY order_id, product_id, payment_gateway_names/);
  assert.deepEqual(q.params.slice(4), ['8622333100210', '8715135189170']);
  assert.throws(() => productPaymentMixQuery({ tenantId: 'VAMA', range: WINDOW, productIds: [] }), /at least one product/);
  assert.throws(() => productPaymentMixQuery({ tenantId: 'VAMA', range: WINDOW, productIds: ["1; DROP TABLE x"] }), /at least one product/);
});

test('discount queries use fixed group expressions, and source/campaign values are bound, never inlined', () => {
  const q = discountGroupedQuery({ tenantId: 'VAMA', range: WINDOW, group: 'utm_campaign', scope: { source: "o'brien", campaign: 'spring' } });
  assert.equal((q.sql.match(/\?/g) || []).length, q.params.length);
  assert.equal(q.sql.includes("o'brien"), false);
  assert.deepEqual(q.params.slice(4), ["o'brien", 'spring']);
  assert.throws(() => discountGroupedQuery({ tenantId: 'VAMA', range: WINDOW, group: 'password' }), /unsupported/);
  const unknown = discountGroupedQuery({ tenantId: 'VAMA', range: WINDOW, group: 'discount_code', scope: { source: 'Direct/Unknown' } });
  assert.match(unknown.sql, /utm_source IS NULL OR TRIM\(utm_source\) = ''/);
});

// ------------------------------------------------------------------ COD monitor

const codRow = (productId, orders, cod, name = 'Product') => ({
  product_id: productId, product_name: name, total_orders: orders, cod_orders: cod, prepaid_orders: orders - cod, partial_orders: 0
});

const codDef = { type: 'recursive_dimension_breakdown', analysis_mode: 'payment_mix', product_ids: ['111', '222', '333'] };

test('COD monitor: relative rise vs the average of daily shares, noise filters and the alert score', async () => {
  const exec = withExecutor((spec, index) => {
    if (index === 0) return { rows: [codRow('111', 100, 50, 'Coin'), codRow('222', 10, 9), codRow('333', 60, 20)] }; // today
    // baseline days: 111 at 40% every day, 222 too small, 333 only 3 usable days
    const rows = [codRow('111', 100, 40), codRow('222', 5, 1)];
    if (index <= 3) rows.push(codRow('333', 60, 20));
    return { rows };
  });
  try {
    const result = await breakdownNode(codDef, context({ cod_pct_delta_pct: 14 }));
    assert.equal(result.status, 'pass');
    assert.equal(exec.calls.length, 8, 'today + 7 baseline days');
    const m = result.delta.metrics;
    const rows = result.delta.breakdowns.cod_products;
    assert.equal(rows.length, 1, 'only product 111 has enough orders and baseline days');
    assert.equal(rows[0].product_id, '111');
    assert.equal(rows[0].current_cod_pct, 50);
    assert.equal(rows[0].baseline_cod_pct, 40);
    assert.equal(rows[0].cod_delta_pct, 25);
    assert.equal(rows[0].flagged, true);
    assert.equal(result.delta.breakdowns.cod_products_flagged.length, 1);
    assert.equal(m.cod_products_not_checked, 2);
    // overall 14 / 7 = 2.0, product 25 / 11 = 2.27: the larger one is the score
    assert.ok(Math.abs(m.cod_alert_score - 25 / 11) < 1e-9);
    assert.equal(m.cod_overall_breached, 1);
  } finally {
    exec.restore();
  }
});

test('COD monitor: a quiet day is score 0, a fall never raises the score, and no data at all is inconclusive', async () => {
  const flat = withExecutor(() => ({ rows: [codRow('111', 100, 40)] }));
  try {
    const result = await breakdownNode(codDef, context({ cod_pct_delta_pct: -20 }));
    assert.equal(result.delta.metrics.cod_alert_score, 0, 'COD falling is not an alert (rises only)');
    assert.equal(result.delta.breakdowns.cod_products_flagged.length, 0);
  } finally {
    flat.restore();
  }
  const empty = withExecutor(() => ({ rows: [] }));
  try {
    const result = await breakdownNode(codDef, context({}));
    assert.equal(result.delta.metrics.cod_alert_score, null, 'no overall change and no product data -> no finding');
  } finally {
    empty.restore();
  }
});

test('COD monitor without a baseline-day count compares against the single baseline window', async () => {
  const exec = withExecutor(() => ({ rows: [codRow('111', 100, 50)] }));
  try {
    const result = await breakdownNode({ ...codDef, min_baseline_days: 1 }, context({ cod_pct_delta_pct: 1 }, { baselineDays: undefined }));
    assert.equal(exec.calls.length, 2);
    assert.equal(result.delta.breakdowns.cod_products[0].cod_delta_pct, 0);
  } finally {
    exec.restore();
  }
});

// ------------------------------------------------------------------ discount monitor

const discountMetrics = (overrides = {}) => ({
  current_total_orders: 400,
  baseline_total_orders: 380,
  current_discounted_orders: 261,
  baseline_discounted_orders: 222,
  current_discount_amount: 72072,
  baseline_discount_amount: 62944,
  current_gross_sales: 287000,
  baseline_gross_sales: 278000,
  current_unique_discount_codes: 5,
  current_discount_rate: 25.1,
  baseline_discount_rate: 22.6,
  discount_rate_delta_pct: 11,
  current_usage_rate: 65.2,
  baseline_usage_rate: 58.4,
  usage_rate_delta_pct: 12,
  discount_amount_delta_pct: 15,
  gross_sales_delta_pct: 3,
  ...overrides
});

const group = (rows) => ({ rows: rows.map(([grp, orders, amount]) => ({ grp, orders, amount })) });

const discountDef = {
  type: 'recursive_dimension_breakdown', analysis_mode: 'discount',
  discount_rate_absolute_pct: { VAMA: 5, PTS: 25 }
};

test('discount monitor fails clearly when the discount metrics were not computed first', async () => {
  const result = await breakdownNode(discountDef, context({}));
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /metric_compare/);
});

test('discount monitor skips a brand with too few orders so far, with no finding and no queries', async () => {
  const exec = withExecutor(() => ({ rows: [] }));
  try {
    const result = await breakdownNode(discountDef, context(discountMetrics({ current_total_orders: 20 })));
    assert.equal(result.delta.metrics.discount_alert_score, null);
    assert.equal(result.delta.metrics.discount_skipped_low_orders, 1);
    assert.equal(exec.calls.length, 0);
  } finally {
    exec.restore();
  }
});

test('a calm day scores below 1, fires nothing and runs no UTM or campaign drill-down', async () => {
  const exec = withExecutor(() => ({ rows: [] }));
  try {
    const result = await breakdownNode(
      { ...discountDef, discount_rate_absolute_pct: undefined },
      context(discountMetrics({ discount_rate_delta_pct: 2, usage_rate_delta_pct: 1, discount_amount_delta_pct: 2, gross_sales_delta_pct: 1 }))
    );
    assert.ok(result.delta.metrics.discount_alert_score < 1);
    assert.equal(result.delta.metrics.discount_alerts_fired, 0);
    // the code check always runs (a new code can appear on a calm day), but there is no UTM / campaign drill-down
    assert.ok(exec.calls.every((call) => call.meta.group === 'discount_code'));
  } finally {
    exec.restore();
  }
});

test('legacy VAMA example: rate 25.1% against a 5% absolute limit is CRITICAL, usage and outpacing also fire', async () => {
  const exec = withExecutor(() => ({ rows: [] }));
  try {
    const result = await breakdownNode(discountDef, context(discountMetrics({ current_total_orders: 400 }), { baselineDays: 7 }));
    const alerts = result.delta.breakdowns.discount_alerts;
    const byType = Object.fromEntries(alerts.map((a) => [a.type, a]));
    assert.equal(byType.DISCOUNT_RATE_SPIKE.severity, 'CRITICAL');
    assert.ok(Math.abs(byType.DISCOUNT_RATE_SPIKE.ratio - 25.1 / 5) < 1e-9);
    assert.equal(byType.USAGE_RATE_SPIKE.severity, 'TRIGGERED');
    assert.ok(Math.abs(byType.USAGE_RATE_SPIKE.ratio - 1.2) < 1e-9);
    assert.equal(byType.DISCOUNT_OUTPACING_SALES.severity, 'TRIGGERED');
    assert.match(byType.DISCOUNT_RATE_SPIKE.message, /25\.1% vs 22\.6% baseline \(\+11%\)/);
    assert.equal(result.delta.metrics.discount_alert_score, 25.1 / 5);
    assert.equal(result.delta.metrics.discount_rate_threshold_mode, 'absolute');
  } finally {
    exec.restore();
  }
});

test('a brand without an absolute limit uses the relative rise (10% default)', async () => {
  const exec = withExecutor(() => ({ rows: [] }));
  try {
    const result = await breakdownNode(discountDef, context(discountMetrics({ discount_rate_delta_pct: 25, usage_rate_delta_pct: 0 }), { tenantId: 'BBB' }));
    assert.equal(result.delta.metrics.discount_rate_threshold_mode, 'relative');
    assert.equal(result.delta.metrics.discount_alert_score, 2.5);
  } finally {
    exec.restore();
  }
});

test('outpacing needs BOTH enough discount growth and enough of a gap over sales growth', async () => {
  const exec = withExecutor(() => ({ rows: [] }));
  try {
    const metrics = discountMetrics({ discount_rate_delta_pct: 0, usage_rate_delta_pct: 0, discount_amount_delta_pct: 12, gross_sales_delta_pct: 8, current_discount_rate: 1 });
    const result = await breakdownNode({ ...discountDef, discount_rate_absolute_pct: undefined }, context(metrics));
    assert.equal(result.delta.metrics.discount_alerts_fired, 0, 'growth is 12 but the gap is only 4');
    assert.ok(Math.abs(result.delta.metrics.discount_alert_score - 0.4) < 1e-9);
  } finally {
    exec.restore();
  }
});

test('drill-down: top code, new code, flagged UTM source, then its campaign and codes', async () => {
  // Order of grouped queries: codes (today + 7 days), sources (today + 7 days), campaigns of google (today + 7 days),
  // then codes of the top campaign (today only). Today is always first in each batch.
  const exec = withExecutor((spec) => {
    const type = spec.meta.group;
    const isToday = spec.params[0] === '2026-10-23 00:00:00';
    if (type === 'discount_code') {
      if (spec.params.length > 4) return group([['free gift', 60, 9000], ['comeback25', 40, 1000]]); // campaign scope
      return isToday ? group([['free gift', 60, 70000], ['NEWCODE', 40, 2000]]) : group([['free gift', 50, 60000]]);
    }
    if (type === 'utm_source') {
      return isToday ? group([['meta', 100, 40000], ['google', 60, 30000]]) : group([['meta', 100, 50000], ['google', 30, 10000]]);
    }
    return isToday ? group([['24274998189', 50, 25000], ['other', 10, 5000]]) : group([['24274998189', 40, 5000], ['other', 40, 5000]]);
  });
  try {
    const result = await breakdownNode(discountDef, context(discountMetrics({ current_unique_discount_codes: 5, current_discounted_orders: 100 })));
    const b = result.delta.breakdowns;
    assert.equal(b.discount_top_code[0].code, 'free gift');
    assert.ok(Math.abs(b.discount_top_code[0].amount_share_pct - (70000 / 72000) * 100) < 1e-9);
    assert.deepEqual(b.discount_new_codes.map((c) => c.code), ['NEWCODE']);
    assert.equal(b.discount_new_codes[0].orders_share_pct, 40);

    const utm = Object.fromEntries(b.discount_utm_sources.map((r) => [r.source, r]));
    assert.equal(utm.google.flagged, true, 'google share 30/70 -> 42.9% vs baseline 16.7% is a big uplift');
    assert.equal(utm.meta.flagged, false);
    assert.ok(Math.abs(utm.google.baseline_share - (10000 / 60000) * 100) < 1e-9);

    const drill = b.discount_campaigns[0];
    assert.equal(drill.source, 'google');
    assert.equal(drill.campaign, '24274998189');
    assert.ok(Math.abs(drill.current_share - (25000 / 30000) * 100) < 1e-9);
    assert.ok(Math.abs(drill.baseline_share - 50) < 1e-9);
    assert.equal(drill.codes[0].code, 'free gift');
    assert.match(drill.codes_text, /free gift · 90% amt \(60% orders\)/, 'amount and order shares differ by 15+ points so both show');
  } finally {
    exec.restore();
  }
});

test('codes that look auto-generated per order skip the top-code and new-code checks (cardinality guard)', async () => {
  const exec = withExecutor((spec) => (spec.meta.group === 'utm_source' ? group([['meta', 10, 1000]]) : group([])));
  try {
    const result = await breakdownNode(discountDef, context(discountMetrics({ current_unique_discount_codes: 90, current_discounted_orders: 100 })));
    assert.deepEqual(result.delta.breakdowns.discount_top_code, []);
    assert.deepEqual(result.delta.breakdowns.discount_new_codes, []);
    assert.ok(exec.calls.every((call) => call.meta.group !== 'discount_code'), 'no code queries at all');
  } finally {
    exec.restore();
  }
});

test('baseline shares average the daily shares over days that had discounts', () => {
  const shares = averageShares([
    group([['a', 1, 80], ['b', 1, 20]]),
    group([['a', 1, 40], ['b', 1, 60]]),
    group([]),
  ]);
  assert.equal(shares.get('a'), 60);
  assert.equal(shares.get('b'), 40);
});

// ------------------------------------------------------------------ validation

const monitorWorkflow = (node) => ({
  workflow_type: 'root_cause_analysis', version: '1',
  trigger: { type: 'alert', alertType: 'cod_monitor', brandScope: 'single', brandIds: ['VAMA'] },
  nodes: [{ id: 'm', type: 'metric_compare', metrics: ['cod_pct'], next: 'b' }, { id: 'b', type: 'recursive_dimension_breakdown', ...node }]
});

test('validation accepts the monitor modes and rejects bad options', () => {
  const ok = (node) => validateWorkflowDefinition(monitorWorkflow(node)).errors;
  assert.deepEqual(ok({ analysis_mode: 'payment_mix', product_ids: ['8622333100210'], min_orders: 20 }), []);
  assert.deepEqual(ok({ analysis_mode: 'discount', discount_rate_absolute_pct: { VAMA: 5 } }), []);
  assert.deepEqual(ok({ analysis_mode: 'discount' }), []);
  assert.ok(ok({ analysis_mode: 'payment_mix' }).some((e) => /product_ids/.test(e)));
  assert.ok(ok({ analysis_mode: 'payment_mix', product_ids: ['abc'] }).some((e) => /numeric/.test(e)));
  assert.ok(ok({ analysis_mode: 'payment_mix', product_ids: ['1'], min_orders: -1 }).some((e) => /min_orders/.test(e)));
  assert.ok(ok({ analysis_mode: 'discount', discount_rate_absolute_pct: { VAMA: 0 } }).some((e) => /discount_rate_absolute_pct/.test(e)));
  assert.ok(ok({ analysis_mode: 'nope' }).some((e) => /analysis_mode/.test(e)));
});

test('a new code with no baseline presence is its own alert and lifts the score, even on a calm day', async () => {
  const exec = withExecutor((spec) => {
    const isToday = spec.params[0] === '2026-10-23 00:00:00';
    return isToday ? group([['free gift', 70, 60000], ['FLASH50', 30, 5000]]) : group([['free gift', 80, 70000]]);
  });
  try {
    const result = await breakdownNode(
      { ...discountDef, discount_rate_absolute_pct: undefined },
      context(discountMetrics({ discount_rate_delta_pct: 1, usage_rate_delta_pct: 1, discount_amount_delta_pct: 1, gross_sales_delta_pct: 1, current_discounted_orders: 100, current_unique_discount_codes: 2 }))
    );
    const alert = result.delta.breakdowns.discount_alerts.find((a) => a.type === 'NEW_CODE');
    assert.ok(alert, 'NEW_CODE alert');
    assert.equal(alert.severity, 'CRITICAL', '30% is twice the 15% threshold');
    assert.match(alert.message, /FLASH50 — 30%/);
    assert.equal(result.delta.metrics.discount_alert_score, 2);
    assert.deepEqual(result.delta.breakdowns.discount_new_codes.map((c) => c.code), ['FLASH50']);
  } finally {
    exec.restore();
  }
});
