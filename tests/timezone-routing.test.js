const test = require('node:test');
const assert = require('node:assert/strict');

const dimensionBreakdownQuery = require('../sql/templates/dimensionBreakdownQuery');
const metricQuery = require('../sql/templates/metricQuery');
const {
  buildDefaultContext,
  buildPreviousCompleteDayContext,
} = require('../scheduler/app/schedulerService');
const { normalizeRerunContext } = require('../lib/timeWindowUtils');
const { resolveManualRunTimezone } = require('../lib/runTimezone');
const { validateRunContext } = require('../server/validation/runContext');
const {
  validateRunContextAgainstWorkflow,
} = require('../server/validation/productPartialDayCompatibility');

function buildProductQuery({ timezone, window, baselineWindow }) {
  return dimensionBreakdownQuery({
    tenantId: 'TMC',
    dimension: 'product_id',
    timezone,
    window,
    baselineWindow,
    filters: [],
    includeOrders: true,
  });
}

const istCurrent = {
  start: '2026-07-31T18:30:00.000Z',
  end: '2026-08-01T18:30:00.000Z',
};
const istBaseline = {
  start: '2026-07-30T18:30:00.000Z',
  end: '2026-07-31T18:30:00.000Z',
};

test('completed Asia/Kolkata days use exact Shopify product orders', () => {
  const spec = buildProductQuery({
    timezone: 'Asia/Kolkata',
    window: istCurrent,
    baselineWindow: istBaseline,
  });

  assert.match(spec.sql, /FROM shopify_orders/);
  assert.doesNotMatch(spec.sql, /FROM hourly_product_performance_rollup/);
  assert.match(spec.sql, /COUNT\(DISTINCT order_name\)/);
  assert.match(spec.sql, /created_date >= LEFT\(\?, 10\)/);
  assert.doesNotMatch(spec.sql, /created_date\s*(>=|<|<=)\s*DATE\(\?\)/);
  assert.doesNotMatch(spec.sql, /WHERE created_at >= \?/);
  assert.deepEqual(spec.params.slice(0, 4), [
    '2026-08-01 00:00:00',
    '2026-08-02 00:00:00',
    '2026-07-31 00:00:00',
    '2026-08-01 00:00:00',
  ]);
});

test('partial-day landing-page attribution falls back to line-item date and time', () => {
  const spec = dimensionBreakdownQuery({
    tenantId: 'TMC',
    dimension: 'landing_page_path',
    timezone: 'Asia/Kolkata',
    window: {
      start: '2026-08-01T18:30:00.000Z',
      end: '2026-08-02T06:30:00.000Z',
    },
    baselineWindow: {
      start: '2026-07-31T18:30:00.000Z',
      end: '2026-08-01T06:30:00.000Z',
    },
    filters: [],
    includeOrders: true,
  });

  assert.match(spec.sql, /COALESCE\(\s*created_at,\s*STR_TO_DATE\(CONCAT\(created_date, ' ', created_time\)/);
  assert.equal((spec.sql.match(/\?/g) || []).length, spec.params.length);
});

test('overall metrics use the same timezone-normalized boundaries', () => {
  const spec = metricQuery({
    tenantId: 'TMC',
    metrics: ['sessions', 'orders', 'cvr'],
    timezone: 'Asia/Kolkata',
    window: istCurrent,
    baselineWindow: istBaseline,
  });
  // sessions: current window (date range + exact hour bounds), then baseline
  assert.deepEqual(spec.params.slice(0, 8), [
    '2026-08-01 00:00:00',
    '2026-08-02 00:00:00',
    '2026-08-01 00:00:00',
    '2026-08-02 00:00:00',
    '2026-07-31 00:00:00',
    '2026-08-01 00:00:00',
    '2026-07-31 00:00:00',
    '2026-08-01 00:00:00',
  ]);
});

test('a genuine partial day uses the hourly product rollup', () => {
  const spec = buildProductQuery({
    timezone: 'Asia/Kolkata',
    window: {
      start: '2026-08-01T18:30:00.000Z',
      end: '2026-08-02T06:30:00.000Z',
    },
    baselineWindow: istCurrent,
  });

  assert.match(spec.sql, /FROM hourly_product_performance_rollup/);
  assert.doesNotMatch(spec.sql, /FROM shopify_orders/);
});

test('one partial comparison window makes the complete comparison hourly', () => {
  const spec = buildProductQuery({
    timezone: 'UTC',
    window: {
      start: '2026-08-01T00:00:00.000Z',
      end: '2026-08-02T00:00:00.000Z',
    },
    baselineWindow: {
      start: '2026-07-31T00:00:00.000Z',
      end: '2026-07-31T12:00:00.000Z',
    },
  });

  assert.match(spec.sql, /FROM hourly_product_performance_rollup/);
});

test('UTC and DST-transition calendar days are recognized as full days', () => {
  const utcSpec = buildProductQuery({
    timezone: 'UTC',
    window: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-02T00:00:00.000Z' },
    baselineWindow: { start: '2026-07-31T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z' },
  });
  const dstSpec = buildProductQuery({
    timezone: 'America/New_York',
    window: { start: '2026-03-08T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z' },
    baselineWindow: { start: '2026-03-07T05:00:00.000Z', end: '2026-03-08T05:00:00.000Z' },
  });

  assert.doesNotMatch(utcSpec.sql, /FROM hourly_product_performance_rollup/);
  assert.doesNotMatch(dstSpec.sql, /FROM hourly_product_performance_rollup/);
});

test('alert context uses the authoritative tenant timezone', () => {
  const context = buildDefaultContext('TMC', {
    context: {
      meta: {
        tenantId: 'OTHER',
        timezone: 'America/New_York',
        window: istCurrent,
        baselineWindow: istBaseline,
      },
    },
  }, 'Asia/Kolkata');

  assert.equal(context.meta.tenantId, 'TMC');
  assert.equal(context.meta.timezone, 'Asia/Kolkata');
});

test('cron context records the schedule timezone', () => {
  const context = buildPreviousCompleteDayContext(
    'TMC',
    '2026-08-02T03:00:00.000Z',
    {},
    'Asia/Kolkata'
  );
  assert.equal(context.meta.timezone, 'Asia/Kolkata');
});

test('manual runs use tenant timezone while reruns preserve the original timezone', () => {
  assert.equal(resolveManualRunTimezone({
    rerun: false,
    contextTimezone: 'America/New_York',
    tenantTimezone: 'Asia/Kolkata',
  }), 'Asia/Kolkata');
  assert.equal(resolveManualRunTimezone({
    rerun: true,
    contextTimezone: 'America/New_York',
    tenantTimezone: 'Asia/Kolkata',
  }), 'America/New_York');
  assert.equal(resolveManualRunTimezone({
    rerun: true,
    tenantTimezone: 'Asia/Kolkata',
  }), 'Asia/Kolkata');
});

test('legacy rerun normalization records its resolved timezone', () => {
  const context = normalizeRerunContext({
    meta: { tenantId: 'TMC', window: istCurrent, baselineWindow: istBaseline },
  }, 'Asia/Kolkata');
  assert.equal(context.meta.timezone, 'Asia/Kolkata');
});

test('compatibility validation classifies the same normalized full day as SQL routing', () => {
  const definition = {
    nodes: [{
      id: 'nested_product',
      type: 'recursive_dimension_breakdown',
      dimensions: ['utm_source', 'product_id'],
      stop_conditions: { max_depth: 2 },
    }],
  };
  const fullDay = validateRunContextAgainstWorkflow({
    meta: {
      timezone: 'Asia/Kolkata',
      window: istCurrent,
      baselineWindow: istBaseline,
    },
    filters: [],
  }, definition);
  const partialDay = validateRunContextAgainstWorkflow({
    meta: {
      timezone: 'Asia/Kolkata',
      window: { start: '2026-08-01T18:30:00.000Z', end: '2026-08-02T06:30:00.000Z' },
      baselineWindow: istCurrent,
    },
    filters: [],
  }, definition);

  assert.equal(fullDay.ok, true);
  assert.equal(partialDay.ok, false);
});

test('run context requires a supported resolved IANA timezone', () => {
  const baseContext = {
    meta: {
      tenantId: 'TMC',
      timezone: 'Asia/Kolkata',
      window: { start: '2026-08-01 00:00:00', end: '2026-08-02 00:00:00' },
      baselineWindow: { start: '2026-07-31 00:00:00', end: '2026-08-01 00:00:00' },
    },
  };
  assert.equal(validateRunContext(baseContext).ok, true);
  assert.equal(validateRunContext({
    ...baseContext,
    meta: { ...baseContext.meta, timezone: 'Mars/Olympus' },
  }).ok, false);
});
