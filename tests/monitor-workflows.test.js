const test = require('node:test');
const assert = require('node:assert/strict');

const queryExecutor = require('../sql/QueryExecutor');
const metricCompare = require('../nodes/MetricCompareNode');
const breakdownNode = require('../nodes/RecursiveDimensionBreakdownNode');
const { renderEmail } = require('../server/lib/renderEmail');
const { validateWorkflowDefinition } = require('../server/validation/workflowDefinition');
const { classifySeverity } = require('../server/lib/stateEngine/severity');
const codWorkflow = require('../workflows/cod_monitor.json');
const discountWorkflow = require('../workflows/discount_monitor.json');

const WINDOW = { start: '2026-10-23 00:00:00', end: '2026-10-23 12:00:00' };
const BASELINE = { start: '2026-10-22 00:00:00', end: '2026-10-22 12:00:00' };

const node = (workflow, id) => workflow.nodes.find((n) => n.id === id);

// Runs the workflow's analysis nodes against a stubbed database, the way the runner chains them, and returns the
// context the email node would render.
async function runAnalysis(workflow, nodeIds, rowFor) {
  const original = queryExecutor.execute;
  queryExecutor.execute = async (spec) => rowFor(spec);
  const context = {
    meta: {
      tenantId: 'VAMA', brandName: 'VAMA', timezone: 'Asia/Kolkata', workflowName: workflow.name,
      window: WINDOW, baselineWindow: BASELINE, baselineDays: 7,
      emailBranding: { displayName: 'VAMA', primaryColor: '#b91c1c' }
    },
    metrics: {}, breakdowns: {}, scratch: {}
  };
  try {
    for (const id of nodeIds) {
      const fn = node(workflow, id).type === 'metric_compare' ? metricCompare : breakdownNode;
      const result = await fn(node(workflow, id), context);
      assert.equal(result.status, 'pass', result.reason);
      Object.assign(context.metrics, result.delta?.metrics);
      Object.assign(context.breakdowns, result.delta?.breakdowns);
      if (result.delta?.scratch) context.scratch = result.delta.scratch;
    }
  } finally {
    queryExecutor.execute = original;
  }
  return context;
}

const render = (workflow, emailId, context) => {
  const email = node(workflow, emailId);
  return renderEmail({ format: email.format, template: email.template, context, subject: email.subject });
};

test('both shipped monitor workflows pass the workflow validation', () => {
  for (const workflow of [codWorkflow, discountWorkflow]) {
    const { ok, errors } = validateWorkflowDefinition(workflow);
    assert.deepEqual(errors, [], workflow.workflow_id);
    assert.equal(ok, true);
  }
});

test('the alert score is a rising finding: 1 triggers, 2 is critical, below 1 is normal', () => {
  for (const workflow of [codWorkflow, discountWorkflow]) {
    const { thresholds } = workflow.state_config;
    assert.equal(classifySeverity(0.99, thresholds), 'NORMAL');
    assert.equal(classifySeverity(1, thresholds), 'TRIGGERED');
    assert.equal(classifySeverity(1.99, thresholds), 'TRIGGERED');
    assert.equal(classifySeverity(2, thresholds), 'CRITICAL');
  }
});

// ------------------------------------------------------------------ COD

const orderRow = (orders, cod) => ({
  current_orders: orders, baseline_orders: 0, current_sessions: 0, baseline_sessions: 0,
  current_atc_sessions: 0, baseline_atc_sessions: 0, current_adjusted_sessions: 0, baseline_adjusted_sessions: 0,
  current_cod_orders: cod, baseline_cod_orders: 0, current_ppcod_orders: 0, baseline_ppcod_orders: 0,
  current_prepaid_orders: orders - cod, baseline_prepaid_orders: 0
});

test('COD workflow end to end: 12% rise overall and a product 30% up gives a CRITICAL score and a rendered report', async () => {
  const context = await runAnalysis(codWorkflow, ['cod_overall', 'cod_products'], (spec) => {
    const today = spec.params[0] === WINDOW.start;
    if (spec.meta.type === 'cod_product_payment_mix') {
      const row = (id, name, orders, cod) => ({ product_id: id, product_name: name, total_orders: orders, cod_orders: cod, prepaid_orders: orders - cod, partial_orders: 0 });
      return { rows: [row('8715135189170', 'Rinmukteshwar Siddh Coin', 100, today ? 52 : 40), row('8622333100210', 'Other', 100, 40)] };
    }
    return { rows: [orderRow(135, today ? 61 : 54)] };
  });
  const m = context.metrics;
  assert.ok(Math.abs(m.current_cod_pct - (61 / 135) * 100) < 1e-9);
  assert.equal(m.baseline_cod_pct, 40);
  assert.ok(m.cod_alert_score >= 2, `score ${m.cod_alert_score} should be critical`);
  assert.equal(classifySeverity(m.cod_alert_score, codWorkflow.state_config.thresholds), 'CRITICAL');
  assert.equal(context.breakdowns.cod_products_flagged.length, 1);

  const rendered = render(codWorkflow, 'cod_email', context);
  assert.match(rendered.html, /Triggered products/);
  assert.match(rendered.html, /Rinmukteshwar Siddh Coin/);
  assert.match(rendered.html, /\+30\.00%/);
  assert.match(rendered.text, /COD/);
});

test('COD workflow on a calm day: score below 1, so the state engine stays NORMAL (no email)', async () => {
  const context = await runAnalysis(codWorkflow, ['cod_overall', 'cod_products'], (spec) => {
    if (spec.meta.type === 'cod_product_payment_mix') {
      return { rows: [{ product_id: '8715135189170', product_name: 'Coin', total_orders: 100, cod_orders: 40, prepaid_orders: 60, partial_orders: 0 }] };
    }
    return { rows: [orderRow(135, 54)] };
  });
  assert.equal(context.metrics.cod_alert_score, 0);
  assert.equal(classifySeverity(context.metrics.cod_alert_score, codWorkflow.state_config.thresholds), 'NORMAL');
  const rendered = render(codWorkflow, 'cod_email', context);
  assert.match(rendered.html, /No data available/, 'an empty triggered-products table still renders');
});

// ------------------------------------------------------------------ discount

function discountRows(spec) {
  const today = spec.params[0] === WINDOW.start;
  if (spec.meta.type === 'discount_grouped') {
    const rows = (list) => ({ rows: list.map(([grp, orders, amount]) => ({ grp, orders, amount })) });
    if (spec.meta.group === 'discount_code') return rows(spec.params.length > 4 ? [['free gift', 60, 9000], ['comeback25', 40, 1000]] : [['free gift', 70, 65000], ['comeback25', 30, 7000]]);
    if (spec.meta.group === 'utm_source') return today ? rows([['meta', 100, 45000], ['google', 60, 27000]]) : rows([['meta', 100, 50000], ['google', 30, 10000]]);
    return today ? rows([['24274998189', 50, 25000]]) : rows([['24274998189', 40, 5000], ['other', 40, 5000]]);
  }
  // the metric query: one row with sessions/sales/discount columns for the window
  return {
    rows: [{
      current_sessions: 6926, baseline_sessions: 6900, current_atc_sessions: 1012, baseline_atc_sessions: 1050,
      current_adjusted_sessions: 0, baseline_adjusted_sessions: 0,
      current_orders: today ? 290 : 280, baseline_orders: 0,
      current_cod_orders: 0, baseline_cod_orders: 0, current_ppcod_orders: 0, baseline_ppcod_orders: 0,
      current_prepaid_orders: 0, baseline_prepaid_orders: 0,
      current_sales: today ? 287000 : 278000, baseline_sales: 0, current_sales_orders: today ? 290 : 280, baseline_sales_orders: 0,
      current_discount_orders: today ? 290 : 280, baseline_discount_orders: 0,
      current_discounted_orders: today ? 189 : 163, baseline_discounted_orders: 0,
      current_discount_amount: today ? 72072 : 62944, baseline_discount_amount: 0,
      current_gross_sales: today ? 287000 : 278000, baseline_gross_sales: 0,
      current_unique_discount_codes: 3, baseline_unique_discount_codes: 0
    }]
  };
}

test('discount workflow end to end on the legacy VAMA example', async () => {
  const context = await runAnalysis(discountWorkflow, ['discount_totals', 'discount_drilldown'], discountRows);
  const m = context.metrics;
  assert.ok(Math.abs(m.current_discount_rate - 25.1) < 0.05, `rate ${m.current_discount_rate}`);
  assert.ok(Math.abs(m.baseline_discount_rate - 22.6) < 0.05);
  assert.ok(Math.abs(m.discount_amount_delta_pct - 14.5) < 0.1, 'about +15% like the legacy email');
  assert.ok(Math.abs(m.gross_sales_delta_pct - 3.2) < 0.1);
  assert.equal(classifySeverity(m.discount_alert_score, discountWorkflow.state_config.thresholds), 'CRITICAL', 'VAMA 5% absolute limit');

  const alerts = context.breakdowns.discount_alerts.map((a) => a.type).sort();
  assert.deepEqual(alerts, ['DISCOUNT_OUTPACING_SALES', 'DISCOUNT_RATE_SPIKE', 'USAGE_RATE_SPIKE']);

  const rendered = render(discountWorkflow, 'discount_email', context);
  assert.match(rendered.html, /Discount Rate Spike/);
  assert.match(rendered.html, /Discount Usage Spike/);
  assert.match(rendered.html, /Discount Outpacing Sales/);
  assert.match(rendered.html, /Top discount code/);
  assert.match(rendered.html, /free gift/);
  assert.match(rendered.html, /FLAGGED/);
  assert.match(rendered.html, /google/);
  assert.match(rendered.html, /24274998189/);
  assert.match(rendered.html, /Campaign drill-down/);
});
