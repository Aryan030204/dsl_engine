const test = require('node:test');
const assert = require('node:assert/strict');

const metricQuery = require('../sql/templates/metricQuery');
const queryExecutor = require('../sql/QueryExecutor');
const MetricCompareNode = require('../nodes/MetricCompareNode');
const { renderEmail } = require('../server/lib/renderEmail');
const { validateWorkflowDefinition } = require('../server/validation/workflowDefinition');

const window = { start: '2026-09-14 00:00:00', end: '2026-09-15 00:00:00' };
const baselineWindow = { start: '2026-09-13 00:00:00', end: '2026-09-14 00:00:00' };

test('sales tables are only queried when sales or aov is requested', () => {
  const plain = metricQuery({ tenantId: 'TMC', metrics: ['cvr', 'orders'], window, baselineWindow, timezone: 'UTC' });
  assert.doesNotMatch(plain.sql, /hour_wise_sales|overall_summary/);
  // sessions (4) + orders (4) + payment-type orders (4), no sales
  assert.equal(plain.params.length, 12);
  assert.equal(plain.meta.salesSources, null);
});

test('complete-day windows read sales from overall_summary by date', () => {
  for (const metric of ['sales', 'aov']) {
    const q = metricQuery({ tenantId: 'TMC', metrics: ['cvr', metric], window, baselineWindow, timezone: 'UTC' });
    assert.deepEqual(q.meta.salesSources, { current: 'overall_summary', baseline: 'overall_summary' });
    assert.match(q.sql, /FROM overall_summary/);
    assert.doesNotMatch(q.sql, /hour_wise_sales/);
    assert.match(q.sql, /SUM\(total_orders\)/);
    // [date >= start day, date < end day] for current, then baseline.
    assert.deepEqual(q.params.slice(12), ['2026-09-14', '2026-09-15', '2026-09-13', '2026-09-14']);
  }
});

test('multi-day complete windows also use overall_summary', () => {
  const q = metricQuery({
    tenantId: 'TMC', metrics: ['sales'], timezone: 'UTC',
    window: { start: '2026-08-15 00:00:00', end: '2026-09-14 00:00:00' },
    baselineWindow: { start: '2026-07-16 00:00:00', end: '2026-08-15 00:00:00' }
  });
  assert.deepEqual(q.meta.salesSources, { current: 'overall_summary', baseline: 'overall_summary' });
});

test('today-until-now vs yesterday-until-same-hour reads hour_wise_sales', () => {
  const q = metricQuery({
    tenantId: 'TMC', metrics: ['sales', 'aov'], timezone: 'UTC',
    window: { start: '2026-09-24 00:00:00', end: '2026-09-24 14:00:00' },
    baselineWindow: { start: '2026-09-23 00:00:00', end: '2026-09-23 14:00:00' }
  });
  assert.deepEqual(q.meta.salesSources, { current: 'hour_wise_sales', baseline: 'hour_wise_sales' });
  assert.doesNotMatch(q.sql, /overall_summary/);
  assert.match(q.sql, /SUM\(number_of_orders\)/);
  assert.deepEqual(q.params.slice(12), ['2026-09-24 00:00:00', '2026-09-24 14:00:00', '2026-09-23 00:00:00', '2026-09-23 14:00:00']);
});

test('the source is chosen per window: partial today vs complete baseline days', () => {
  const q = metricQuery({
    tenantId: 'TMC', metrics: ['sales'], timezone: 'UTC',
    window: { start: '2026-09-24 00:00:00', end: '2026-09-24 14:00:00' },
    baselineWindow: { start: '2026-08-25 00:00:00', end: '2026-09-24 00:00:00' }
  });
  assert.deepEqual(q.meta.salesSources, { current: 'hour_wise_sales', baseline: 'overall_summary' });
  assert.ok(q.sql.indexOf('current_sales AS') < q.sql.indexOf('baseline_sales AS'));
  assert.deepEqual(q.params.slice(12), ['2026-09-24 00:00:00', '2026-09-24 14:00:00', '2026-08-25', '2026-09-24']);
});

test('UTC ISO windows are classified in the tenant timezone', () => {
  // 18:30Z to 18:30Z is midnight to midnight in Asia/Kolkata.
  const q = metricQuery({
    tenantId: 'TMC', metrics: ['sales'], timezone: 'Asia/Kolkata',
    window: { start: '2026-09-23T18:30:00.000Z', end: '2026-09-24T18:30:00.000Z' },
    baselineWindow: { start: '2026-09-22T18:30:00.000Z', end: '2026-09-23T18:30:00.000Z' }
  });
  assert.deepEqual(q.meta.salesSources, { current: 'overall_summary', baseline: 'overall_summary' });
  assert.deepEqual(q.params.slice(12), ['2026-09-24', '2026-09-25', '2026-09-23', '2026-09-24']);
});

async function runCompare(metrics, row) {
  const original = queryExecutor.execute;
  queryExecutor.execute = async () => ({ rows: [row] });
  try {
    return await MetricCompareNode({ metrics, next: 'n' }, { meta: { tenantId: 'TMC', window, baselineWindow, timezone: 'UTC' } });
  } finally {
    queryExecutor.execute = original;
  }
}

const baseRow = {
  current_sessions: 1000, baseline_sessions: 1000,
  current_atc_sessions: 100, baseline_atc_sessions: 100,
  current_orders: 20, baseline_orders: 25
};

test('metric_compare derives total sales and AOV (sales / orders) with deltas', async () => {
  const result = await runCompare(['sales', 'aov'], {
    ...baseRow,
    current_sales: 18000, baseline_sales: 20000,
    current_sales_orders: 20, baseline_sales_orders: 25
  });
  const { metrics } = result.delta;
  assert.equal(metrics.current_sales, 18000);
  assert.equal(metrics.baseline_sales, 20000);
  assert.equal(metrics.sales_delta_pct, -10);
  assert.equal(metrics.current_aov, 900);
  assert.equal(metrics.baseline_aov, 800);
  assert.equal(metrics.aov_delta_pct, 12.5);
});

test('AOV and its delta are null when a window has no orders', async () => {
  const { metrics } = (await runCompare(['aov'], {
    ...baseRow, current_sales: 0, baseline_sales: 5000, current_sales_orders: 0, baseline_sales_orders: 5
  })).delta;
  assert.equal(metrics.current_aov, null);
  assert.equal(metrics.aov_delta_pct, null);
  assert.equal(metrics.sales_delta_pct, -100);
});

test('workflows that do not ask for sales get no sales metrics', async () => {
  const { metrics } = (await runCompare(['cvr'], baseRow)).delta;
  assert.equal('current_sales' in metrics, false);
  assert.equal('aov_delta_pct' in metrics, false);
});

function reportContext(overrides = {}) {
  return {
    meta: { brandName: 'Ajmal', timezone: 'Asia/Kolkata', currency: 'INR', window, baselineWindow },
    metrics: {
      current_sessions: 83030, sessions_delta_pct: -2.2,
      current_orders: 976, orders_delta_pct: -14.08,
      current_cvr: 0.0118, cvr_delta_pct: -12.15,
      current_atc_sessions: 5019, atc_sessions_delta_pct: -9.39,
      current_sales: 1234567.5, sales_delta_pct: -11.2,
      current_aov: 1264.9, aov_delta_pct: 3.4
    },
    breakdowns: { rows: [] },
    ...overrides
  };
}

const sixCards = [
  { label: 'Sessions', value: 'metrics.current_sessions', change: 'metrics.sessions_delta_pct', format: 'integer', icon: 'sessions' },
  { label: 'Orders', value: 'metrics.current_orders', change: 'metrics.orders_delta_pct', format: 'integer', icon: 'orders' },
  { label: 'Conversion rate', value: 'metrics.current_cvr', change: 'metrics.cvr_delta_pct', format: 'percent_ratio', icon: 'conversion' },
  { label: 'ATC sessions', value: 'metrics.current_atc_sessions', change: 'metrics.atc_sessions_delta_pct', format: 'integer', icon: 'cart' },
  { label: 'Total sales', value: 'metrics.current_sales', change: 'metrics.sales_delta_pct', format: 'currency', icon: 'sales' },
  { label: 'AOV', value: 'metrics.current_aov', change: 'metrics.aov_delta_pct', format: 'currency', icon: 'aov' }
];

function reportTemplate(metrics = sixCards) {
  return {
    preset: 'performance_report_v1', eyebrow: 'CVR drop alert', title: 'Conversion rate drop',
    period: { current: 'meta.window', comparison: 'meta.baselineWindow' },
    metrics,
    tables: [{ title: 'Products', source: 'breakdowns.rows', limit: 3, columns: [{ label: 'Name', path: 'display_value', format: 'text' }] }]
  };
}

test('six KPI cards render three per row on desktop and two per row on phones, with currency in the tenant currency', () => {
  const rendered = renderEmail({ format: 'report', context: reportContext(), template: reportTemplate(), subject: 'Report' });
  const cards = rendered.html.match(/class="rpt-kpi-card" style="[^"]*width:33\.3333%/g) || [];
  assert.equal(cards.length, 6);
  assert.match(rendered.html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(rendered.html, /@media only screen and \(max-width: 600px\)[\s\S]*\.rpt-kpi-card \{ width: 50% !important;/);
  assert.match(rendered.text, /Total sales: ₹12,34,567\.5 \(-11\.20%\)/);
  assert.match(rendered.text, /AOV: ₹1,264\.9 \(\+3\.40%\)/);
  assert.match(rendered.text, /ATC sessions: 5,019 \(-9\.39%\)/);
});

test('currency falls back to USD formatting or a plain number', () => {
  const usd = renderEmail({ format: 'report', context: reportContext({ meta: { ...reportContext().meta, currency: 'USD' } }), template: reportTemplate(), subject: 'R' });
  assert.match(usd.text, /Total sales: \$1,234,567\.5/);
  const bogus = renderEmail({ format: 'report', context: reportContext({ meta: { ...reportContext().meta, currency: 'NOPE' } }), template: reportTemplate(), subject: 'R' });
  assert.match(bogus.text, /Total sales: 1,234,567\.5/);
});

test('a card whose metric exists but is empty shows a dash; an unknown path still fails', () => {
  const ctx = reportContext();
  ctx.metrics.current_aov = null;
  ctx.metrics.aov_delta_pct = null;
  const rendered = renderEmail({ format: 'report', context: ctx, template: reportTemplate(), subject: 'R' });
  assert.match(rendered.text, /AOV: —\n/);

  const broken = reportTemplate([{ label: 'Oops', value: 'metrics.not_a_metric', format: 'integer' }]);
  assert.throws(() => renderEmail({ format: 'report', context: reportContext(), template: broken, subject: 'R' }), /missing required binding: metrics\.not_a_metric/);
});

test('validation allows up to six KPI cards and the currency format', () => {
  const definition = (metrics) => ({
    workflow_type: 'root_cause_analysis', version: '1',
    trigger: { type: 'alert', alertType: 'daily', brandScope: 'single', brandIds: ['TMC'] },
    nodes: [{ id: 'mail', type: 'email', format: 'report', to: ['ops@example.com'], subject: 'R', template: reportTemplate(metrics) }]
  });
  assert.equal(validateWorkflowDefinition(definition(sixCards)).ok, true);
  const seven = [...sixCards, sixCards[0]];
  assert.ok(validateWorkflowDefinition(definition(seven)).errors.some((e) => /one to 6 items/.test(e)));
});

test('four or fewer KPI cards share one desktop row', () => {
  const rendered = renderEmail({ format: 'report', context: reportContext(), template: reportTemplate(sixCards.slice(0, 4)), subject: 'R' });
  assert.equal((rendered.html.match(/class="rpt-kpi-card" style="[^"]*width:25\.0000%/g) || []).length, 4);
});

test('table numbers never wrap (a change stays with its arrow); text cells may wrap', () => {
  const ctx = reportContext({
    breakdowns: { rows: [{ display_value: 'Oud Nirvana, Oud Rocks & White Oud Perfume 90 ML', deltas: { cvr_delta_pct: -35.02 } }] }
  });
  const template = reportTemplate();
  template.tables[0].columns.push({ label: 'CVR change', path: 'deltas.cvr_delta_pct', format: 'delta_percent' });
  const rendered = renderEmail({ format: 'report', context: ctx, template, subject: 'R' });
  assert.match(rendered.html, /white-space:nowrap;">↓ -35\.02%<\/td>/);
  assert.match(rendered.html, /word-break:break-word;">Oud Nirvana, Oud Rocks &amp; White Oud Perfume 90 ML<\/td>/);
});
