const test = require('node:test');
const assert = require('node:assert/strict');

const InsightNode = require('../nodes/InsightNode');

function context(utmRows) {
  return {
    meta: { tenantId: 't1' },
    metrics: {
      cvr_delta_pct: -12.15, current_cvr: 0.0118, orders_delta_pct: -14.08,
      // Whatever breakdown ran last writes metrics.top_*; here that's the products one.
      top_display_value: 'White Oud - 100 ML', top_cvr_delta_pct: -30
    },
    breakdowns: {
      orders_product_id_drops: [
        { dimension: 'product_id', value: '101', display_value: 'Oud Nirvana 30 ML', deltas: { orders_delta_pct: -41.35, cvr_delta_pct: -20 } },
        { dimension: 'product_id', value: '102', display_value: 'White Oud - 100 ML', deltas: { orders_delta_pct: -19.67, cvr_delta_pct: -5 } }
      ],
      cvr_utm_source_drops: utmRows
    },
    scratch: {}
  };
}

const template = {
  summary: 'The CVR today is {{current_cvr_pct}}, a drop of {{cvr_delta_pct_fmt}}. The top traffic source behind the drop was {{cvr_utm_source_drops_top1_value}} ({{cvr_utm_source_drops_top1_cvr_delta_pct_fmt}} CVR), and the most impacted product was {{orders_product_id_drops_top1_value}} ({{orders_product_id_drops_top1_orders_delta_pct_fmt}} orders).',
  details: []
};

test('an insight can name the top row of any breakdown by its output key', async () => {
  const result = await InsightNode({ template, output_key: 'orders_product_id_drops' }, context([
    { dimension: 'utm_source', value: 'PM_Facebook_Ad', display_value: 'PM_Facebook_Ad', deltas: { cvr_delta_pct: -19.72 } },
    { dimension: 'utm_source', value: 'google', display_value: 'google', deltas: { cvr_delta_pct: -8 } }
  ]));
  assert.equal(
    result.delta.scratch.finalInsight.summary,
    'The CVR today is 1.18%, a drop of -12.15%. The top traffic source behind the drop was PM_Facebook_Ad (-19.72% CVR), and the most impacted product was Oud Nirvana 30 ML (-41.35% orders).'
  );
});

test('an empty breakdown never borrows another breakdown\'s top row', async () => {
  const result = await InsightNode({ template, output_key: 'orders_product_id_drops' }, context([]));
  assert.match(result.delta.scratch.finalInsight.summary, /top traffic source behind the drop was unknown/);
  assert.doesNotMatch(result.delta.scratch.finalInsight.summary, /was White Oud/);
});
