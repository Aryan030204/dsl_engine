const test = require('node:test');
const assert = require('node:assert/strict');

const dimensionBreakdownQuery = require('../sql/templates/dimensionBreakdownQuery');
const queryExecutor = require('../sql/QueryExecutor');
const recursiveDimensionBreakdownNode = require('../nodes/RecursiveDimensionBreakdownNode');

const window = {
  start: '2026-08-01T18:30:00.000Z',
  end: '2026-08-02T18:30:00.000Z'
};
const baselineWindow = {
  start: '2026-07-31T18:30:00.000Z',
  end: '2026-08-01T18:30:00.000Z'
};

test('payment order counts are selected by product and UTM dimensions', () => {
  for (const dimension of ['product_id', 'utm_source', 'utm_campaign', 'utm_medium']) {
    const spec = dimensionBreakdownQuery({
      tenantId: 'TMC',
      dimension,
      window,
      baselineWindow,
      timezone: 'Asia/Kolkata',
      filters: [],
      includeOrders: true,
      includePaymentOrders: true
    });

    assert.match(spec.sql, /current_payment_classified/);
    assert.match(spec.sql, /baseline_payment_classified/);
    assert.match(spec.sql, /current_cod_orders/);
    assert.match(spec.sql, /current_ppcod_orders/);
    assert.match(spec.sql, /current_prepaid_orders/);
    assert.equal(spec.sql.split('?').length - 1, spec.params.length);
  }
});

test('partial-day product payment counts use exact order timestamps', () => {
  const spec = dimensionBreakdownQuery({
    tenantId: 'TMC',
    dimension: 'product_id',
    window: {
      start: '2026-08-01T18:30:00.000Z',
      end: '2026-08-02T06:30:00.000Z'
    },
    baselineWindow: {
      start: '2026-07-31T18:30:00.000Z',
      end: '2026-08-01T06:30:00.000Z'
    },
    timezone: 'Asia/Kolkata',
    filters: [],
    includeOrders: true,
    includePaymentOrders: true
  });

  assert.match(spec.sql, /hourly_product_performance_rollup/);
  assert.match(spec.sql, /COALESCE\(\s*created_at,\s*STR_TO_DATE\(CONCAT\(created_date/);
  assert.equal(spec.sql.split('?').length - 1, spec.params.length);
});

test('payment order breakdown rejects unsupported dimensions explicitly', () => {
  assert.throws(() => dimensionBreakdownQuery({
    tenantId: 'TMC',
    dimension: 'landing_page_path',
    window,
    baselineWindow,
    timezone: 'Asia/Kolkata',
    includePaymentOrders: true
  }), /payment order breakdown does not support dimension/);
});

test('recursive breakdown ranks and emits COD order deltas for a dimension', async () => {
  const originalExecute = queryExecutor.execute;
  let querySpec;
  queryExecutor.execute = async (spec) => {
    querySpec = spec;
    return {
      rows: [{
        dimension_value: 'newsletter',
        current_sessions: 50,
        baseline_sessions: 45,
        current_atc_sessions: 10,
        baseline_atc_sessions: 9,
        current_orders: 8,
        baseline_orders: 6,
        current_cod_orders: 6,
        baseline_cod_orders: 3,
        current_ppcod_orders: 2,
        baseline_ppcod_orders: 1,
        current_prepaid_orders: 4,
        baseline_prepaid_orders: 2
      }]
    };
  };

  try {
    for (const metric of ['cod_orders', 'ppcod_orders', 'prepaid_orders']) {
      const result = await recursiveDimensionBreakdownNode({
        id: `${metric}_by_source`,
        dimension: 'utm_source',
        base_metric: metric,
        filter_mode: 'increase',
        rank_by: 'delta',
        stop_conditions: { max_depth: 1, min_sessions: 0, top_k: 1 }
      }, {
        meta: { tenantId: 'TMC', timezone: 'Asia/Kolkata', window, baselineWindow },
        metrics: {},
        filters: [],
        breakdowns: {},
        scratch: {}
      });

      const entry = result.delta.breakdowns[`${metric}_utm_source_increases`][0];
      assert.equal(querySpec.meta.dimension, 'utm_source');
      assert.match(querySpec.sql, /current_cod_orders/);
      assert.equal(result.status, 'pass');
      assert.equal(entry.deltas[`${metric}_delta_pct`], 100);
      const summary = result.delta.metrics[`${metric}_utm_source_increases`];
      assert.match(summary, /COD orders 3 -> 6/);
      assert.match(summary, /PPCOD orders 1 -> 2/);
      assert.match(summary, /Prepaid orders 2 -> 4/);
    }
  } finally {
    queryExecutor.execute = originalExecute;
  }
});

test('multiple selected payment metrics rank and filter contributors independently', async () => {
  const originalExecute = queryExecutor.execute;
  const rows = [
    {
      dimension_value: 'cod_drop', current_sessions: 40, baseline_sessions: 40,
      current_orders: 10, baseline_orders: 10,
      current_cod_orders: 5, baseline_cod_orders: 10,
      current_ppcod_orders: 3, baseline_ppcod_orders: 1,
      current_prepaid_orders: 10, baseline_prepaid_orders: 10
    },
    {
      dimension_value: 'ppcod_drop', current_sessions: 40, baseline_sessions: 40,
      current_orders: 10, baseline_orders: 10,
      current_cod_orders: 12, baseline_cod_orders: 10,
      current_ppcod_orders: 5, baseline_ppcod_orders: 10,
      current_prepaid_orders: 4, baseline_prepaid_orders: 1
    },
    {
      dimension_value: 'prepaid_drop', current_sessions: 40, baseline_sessions: 40,
      current_orders: 10, baseline_orders: 10,
      current_cod_orders: 3, baseline_cod_orders: 1,
      current_ppcod_orders: 2, baseline_ppcod_orders: 1,
      current_prepaid_orders: 5, baseline_prepaid_orders: 10
    }
  ];
  const querySpecs = [];
  queryExecutor.execute = async (spec) => {
    querySpecs.push(spec);
    return { rows };
  };

  try {
    const result = await recursiveDimensionBreakdownNode({
      id: 'all_payment_modes_by_source',
      dimension: 'utm_source',
      dimensions: ['utm_source'],
      base_metrics: ['cod_orders', 'ppcod_orders', 'prepaid_orders'],
      base_metric: 'cod_orders',
      output_key: 'payment_by_source',
      filter_mode: 'drop',
      rank_by: 'delta',
      stop_conditions: { max_depth: 1, min_sessions: 0, top_k: 1 }
    }, {
      meta: { tenantId: 'TMC', timezone: 'Asia/Kolkata', window, baselineWindow },
      metrics: {},
      filters: [],
      breakdowns: {},
      scratch: {}
    });

    assert.equal(querySpecs.length, 3);
    assert.deepEqual(
      Object.keys(result.delta.breakdowns).sort(),
      [
        'payment_by_source',
        'payment_by_source_cod_orders',
        'payment_by_source_ppcod_orders',
        'payment_by_source_prepaid_orders'
      ]
    );
    assert.equal(result.delta.breakdowns.payment_by_source_cod_orders[0].value, 'cod_drop');
    assert.equal(result.delta.breakdowns.payment_by_source_ppcod_orders[0].value, 'ppcod_drop');
    assert.equal(result.delta.breakdowns.payment_by_source_prepaid_orders[0].value, 'prepaid_drop');
    assert.equal(result.delta.breakdowns.payment_by_source.length, 1);
    assert.match(result.delta.metrics.payment_by_source_cod_orders, /COD orders/);
    assert.match(result.delta.metrics.payment_by_source_ppcod_orders, /PPCOD orders/);
    assert.match(result.delta.metrics.payment_by_source_prepaid_orders, /Prepaid orders/);
    assert.match(result.delta.metrics.payment_by_source, /COD orders/);
    assert.match(result.delta.metrics.payment_by_source, /PPCOD orders/);
    assert.match(result.delta.metrics.payment_by_source, /Prepaid orders/);
    assert.doesNotMatch(result.delta.metrics.payment_by_source, /\n2\./);
  } finally {
    queryExecutor.execute = originalExecute;
  }
});
