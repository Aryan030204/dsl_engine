// sql/templates/dimensionBreakdownQuery.js

const {
  isFullDayAlignedWindow,
  listHourlyProductUnsupportedFilters,
  listHourlyLandingPagePathUnsupportedFilters,
  normalizeWindowForQuery
} = require('../../lib/timeWindowUtils');

// shopify_orders.created_date is a varchar(10) 'YYYY-MM-DD'. Comparing it with DATE(?) makes MySQL
// convert the column row by row (no index use, full table scan). LEFT(?, 10) yields the same
// 'YYYY-MM-DD' string, so the comparison stays string-to-string and the created_date indexes apply.
const ALLOWED_DIMENSIONS = new Set([
  'product_id',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'landing_page_path',
  'landing_page_type',
  'referrer_name'
]);
const PAYMENT_BREAKDOWN_DIMENSIONS = new Set([
  'product_id',
  'utm_source',
  'utm_campaign',
  'utm_medium'
]);

function buildPaymentOrderCtes({ dimension, filterSql, notNullSql, timestampMode }) {
  const timePredicate = timestampMode === 'hourly'
    ? `COALESCE(
        created_at,
        STR_TO_DATE(CONCAT(created_date, ' ', created_time), '%Y-%m-%d %H:%i:%s')
      ) >= ?
      AND COALESCE(
        created_at,
        STR_TO_DATE(CONCAT(created_date, ' ', created_time), '%Y-%m-%d %H:%i:%s')
      ) <  ?`
    : 'created_date >= LEFT(?, 10) AND created_date < LEFT(?, 10)';

  const classifiedCte = (period) => `${period}_payment_classified AS (
  SELECT
    ${dimension} AS dimension_value,
    order_name,
    CASE
      WHEN MAX(payment_gateway_names LIKE '%Gokwik PPCOD%') = 1 THEN 'ppcod_orders'
      WHEN MAX(
        payment_gateway_names IS NULL
        OR payment_gateway_names = ''
        OR payment_gateway_names LIKE '%Cash on Delivery (COD)%'
        OR payment_gateway_names LIKE '%cash_on_delivery%'
      ) = 1 THEN 'cod_orders'
      ELSE 'prepaid_orders'
    END AS payment_metric
  FROM shopify_orders
  WHERE ${timePredicate}
    AND order_name IS NOT NULL
    ${filterSql}
    ${notNullSql}
  GROUP BY ${dimension}, order_name
),
${period}_payment_orders AS (
  SELECT
    dimension_value,
    COALESCE(SUM(payment_metric = 'cod_orders'), 0) AS cod_orders,
    COALESCE(SUM(payment_metric = 'ppcod_orders'), 0) AS ppcod_orders,
    COALESCE(SUM(payment_metric = 'prepaid_orders'), 0) AS prepaid_orders
  FROM ${period}_payment_classified
  GROUP BY dimension_value
)`;

  return `${classifiedCte('current')},
${classifiedCte('baseline')}`;
}

function assertSafeDimension(dimension) {
  if (!dimension || typeof dimension !== 'string') {
    throw new Error('dimensionBreakdownQuery: dimension is required');
  }
  if (!ALLOWED_DIMENSIONS.has(dimension)) {
    throw new Error(`dimensionBreakdownQuery: unsupported dimension "${dimension}"`);
  }
}

function buildFilterWhere(filters = []) {
  const clauses = [];
  const params = [];

  for (const f of filters) {
    if (!f?.dimension || f.value === undefined) continue;
    if (!ALLOWED_DIMENSIONS.has(f.dimension)) continue;

    if (Array.isArray(f.value)) {
      const values = Array.from(new Set(f.value.filter((value) => value !== undefined && value !== null && value !== '')));
      if (!values.length) continue;
      clauses.push(`${f.dimension} IN (${values.map(() => '?').join(', ')})`);
      params.push(...values);
      continue;
    }

    clauses.push(`${f.dimension} = ?`);
    params.push(f.value);
  }

  return {
    whereSql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
    params
  };
}

function buildNotNullFilter(dimension) {
  if (dimension === 'product_id') {
    return ' AND product_id IS NOT NULL';
  }
  return '';
}

function shouldUseHourlyProductRollup({ dimension, window, baselineWindow }) {
  if (dimension !== 'product_id') return false;
  const currentIsFullDay = isFullDayAlignedWindow(window?.start, window?.end);
  const baselineIsFullDay = isFullDayAlignedWindow(baselineWindow?.start, baselineWindow?.end);
  return !(currentIsFullDay && baselineIsFullDay);
}

function shouldUseHourlyLandingPagePathAttribution({ dimension, window, baselineWindow }) {
  if (dimension !== 'landing_page_path') return false;
  const currentIsFullDay = isFullDayAlignedWindow(window?.start, window?.end);
  const baselineIsFullDay = isFullDayAlignedWindow(baselineWindow?.start, baselineWindow?.end);
  return !(currentIsFullDay && baselineIsFullDay);
}

function buildHourlyProductFilterWhere(filters = []) {
  const unsupportedDimensions = listHourlyProductUnsupportedFilters(filters);
  if (unsupportedDimensions.length) {
    throw new Error(
      `dimensionBreakdownQuery: hourly product analysis does not support filters on ${Array.from(new Set(unsupportedDimensions)).join(', ')}`
    );
  }

  return buildHourlyProductIdOnlyFilterWhere(filters);
}

function buildHourlyLandingPagePathFilterWhere(filters = []) {
  const unsupportedDimensions = listHourlyLandingPagePathUnsupportedFilters(filters);
  if (unsupportedDimensions.length) {
    throw new Error(
      `dimensionBreakdownQuery: hourly landing_page_path analysis does not support filters on ${Array.from(new Set(unsupportedDimensions)).join(', ')}`
    );
  }

  return buildHourlyProductIdOnlyFilterWhere(filters);
}

function buildHourlyProductIdOnlyFilterWhere(filters = []) {
  const clauses = [];
  const params = [];

  for (const f of filters) {
    if (f?.dimension !== 'product_id' || f.value === undefined) continue;

    if (Array.isArray(f.value)) {
      const values = Array.from(new Set(f.value.filter((value) => value !== undefined && value !== null && value !== '')));
      if (!values.length) continue;
      clauses.push(`product_id IN (${values.map(() => '?').join(', ')})`);
      params.push(...values);
      continue;
    }

    clauses.push('product_id = ?');
    params.push(f.value);
  }

  return {
    whereSql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
    params
  };
}

function buildHourlyProductRollupSql({ filterSql, notNullSql, includeOrders, includePaymentOrders }) {
  return `
WITH
current_sessions AS (
  SELECT
    product_id AS dimension_value,
    COALESCE(SUM(sessions), 0) AS sessions,
    COALESCE(SUM(sessions_with_cart_additions), 0) AS atc_sessions
  FROM hourly_product_performance_rollup
  WHERE date >= DATE(?)
    AND date <= DATE(?)
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') >= ?
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') <  ?
    ${filterSql}
    ${notNullSql}
  GROUP BY product_id
),
baseline_sessions AS (
  SELECT
    product_id AS dimension_value,
    COALESCE(SUM(sessions), 0) AS sessions,
    COALESCE(SUM(sessions_with_cart_additions), 0) AS atc_sessions
  FROM hourly_product_performance_rollup
  WHERE date >= DATE(?)
    AND date <= DATE(?)
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') >= ?
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') <  ?
    ${filterSql}
    ${notNullSql}
  GROUP BY product_id
),${includeOrders ? `
current_orders AS (
  SELECT
    product_id AS dimension_value,
    COALESCE(SUM(orders), 0) AS orders
  FROM hourly_product_performance_rollup
  WHERE date >= DATE(?)
    AND date <= DATE(?)
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') >= ?
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') <  ?
    ${filterSql}
    ${notNullSql}
  GROUP BY product_id
),
baseline_orders AS (
  SELECT
    product_id AS dimension_value,
    COALESCE(SUM(orders), 0) AS orders
  FROM hourly_product_performance_rollup
  WHERE date >= DATE(?)
    AND date <= DATE(?)
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') >= ?
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') <  ?
    ${filterSql}
    ${notNullSql}
  GROUP BY product_id
),` : ''}
${includePaymentOrders ? `${buildPaymentOrderCtes({
  dimension: 'product_id',
  filterSql,
  notNullSql,
  timestampMode: 'hourly'
})},` : ''}
product_titles AS (
  SELECT
    product_id AS dimension_value,
    MAX(product_title) AS product_title
  FROM hourly_product_performance_rollup
  WHERE date >= DATE(?)
    AND date <= DATE(?)
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') >= ?
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') <  ?
    ${filterSql}
    ${notNullSql}
  GROUP BY product_id
),
all_keys AS (
  SELECT dimension_value FROM current_sessions
  UNION
  SELECT dimension_value FROM baseline_sessions
  ${includeOrders ? `
  UNION
  SELECT dimension_value FROM current_orders
  UNION
  SELECT dimension_value FROM baseline_orders` : ''}
  ${includePaymentOrders ? `
  UNION
  SELECT dimension_value FROM current_payment_orders
  UNION
  SELECT dimension_value FROM baseline_payment_orders` : ''}
)
SELECT
  k.dimension_value,
  COALESCE(cs.sessions, 0) AS current_sessions,
  COALESCE(bs.sessions, 0) AS baseline_sessions,
  COALESCE(cs.atc_sessions, 0) AS current_atc_sessions,
  COALESCE(bs.atc_sessions, 0) AS baseline_atc_sessions,
  ${includeOrders ? 'COALESCE(co.orders, 0) AS current_orders,\n  COALESCE(bo.orders, 0) AS baseline_orders' : '0 AS current_orders,\n  0 AS baseline_orders'}${includePaymentOrders ? ',\n  COALESCE(cpo.cod_orders, 0) AS current_cod_orders,\n  COALESCE(bpo.cod_orders, 0) AS baseline_cod_orders,\n  COALESCE(cpo.ppcod_orders, 0) AS current_ppcod_orders,\n  COALESCE(bpo.ppcod_orders, 0) AS baseline_ppcod_orders,\n  COALESCE(cpo.prepaid_orders, 0) AS current_prepaid_orders,\n  COALESCE(bpo.prepaid_orders, 0) AS baseline_prepaid_orders' : ''},
  pt.product_title
FROM all_keys k
LEFT JOIN current_sessions cs ON cs.dimension_value = k.dimension_value
LEFT JOIN baseline_sessions bs ON bs.dimension_value = k.dimension_value
${includeOrders ? 'LEFT JOIN current_orders co ON co.dimension_value = k.dimension_value\nLEFT JOIN baseline_orders bo ON bo.dimension_value = k.dimension_value' : ''}
${includePaymentOrders ? 'LEFT JOIN current_payment_orders cpo ON cpo.dimension_value = k.dimension_value\nLEFT JOIN baseline_payment_orders bpo ON bpo.dimension_value = k.dimension_value' : ''}
LEFT JOIN product_titles pt ON pt.dimension_value = k.dimension_value
ORDER BY current_sessions DESC;
  `;
}

function buildHourlyLandingPagePathSql({ filterSql, includeOrders }) {
  return `
WITH
current_path_product_sessions AS (
  SELECT
    landing_page_path AS dimension_value,
    product_id,
    COALESCE(SUM(sessions), 0) AS sessions,
    COALESCE(SUM(sessions_with_cart_additions), 0) AS atc_sessions
  FROM hourly_product_sessions
  WHERE date >= DATE(?)
    AND date <= DATE(?)
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') >= ?
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') <  ?
    ${filterSql}
    AND product_id IS NOT NULL
  GROUP BY landing_page_path, product_id
),
baseline_path_product_sessions AS (
  SELECT
    landing_page_path AS dimension_value,
    product_id,
    COALESCE(SUM(sessions), 0) AS sessions,
    COALESCE(SUM(sessions_with_cart_additions), 0) AS atc_sessions
  FROM hourly_product_sessions
  WHERE date >= DATE(?)
    AND date <= DATE(?)
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') >= ?
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') <  ?
    ${filterSql}
    AND product_id IS NOT NULL
  GROUP BY landing_page_path, product_id
),
current_product_session_totals AS (
  SELECT product_id, SUM(sessions) AS total_sessions
  FROM current_path_product_sessions
  GROUP BY product_id
),
baseline_product_session_totals AS (
  SELECT product_id, SUM(sessions) AS total_sessions
  FROM baseline_path_product_sessions
  GROUP BY product_id
),${includeOrders ? `
current_product_orders AS (
  SELECT
    product_id,
    COALESCE(COUNT(DISTINCT order_name), 0) AS orders
  FROM shopify_orders
  WHERE created_date >= LEFT(?, 10)
    AND created_date <= LEFT(?, 10)
    AND COALESCE(
      created_at,
      STR_TO_DATE(CONCAT(created_date, ' ', created_time), '%Y-%m-%d %H:%i:%s')
    ) >= ?
    AND COALESCE(
      created_at,
      STR_TO_DATE(CONCAT(created_date, ' ', created_time), '%Y-%m-%d %H:%i:%s')
    ) <  ?
    ${filterSql}
    AND product_id IS NOT NULL
  GROUP BY product_id
),
baseline_product_orders AS (
  SELECT
    product_id,
    COALESCE(COUNT(DISTINCT order_name), 0) AS orders
  FROM shopify_orders
  WHERE created_date >= LEFT(?, 10)
    AND created_date <= LEFT(?, 10)
    AND COALESCE(
      created_at,
      STR_TO_DATE(CONCAT(created_date, ' ', created_time), '%Y-%m-%d %H:%i:%s')
    ) >= ?
    AND COALESCE(
      created_at,
      STR_TO_DATE(CONCAT(created_date, ' ', created_time), '%Y-%m-%d %H:%i:%s')
    ) <  ?
    ${filterSql}
    AND product_id IS NOT NULL
  GROUP BY product_id
),
current_allocated_orders AS (
  SELECT
    cps.dimension_value,
    SUM(
      CASE
        WHEN cst.total_sessions > 0
          THEN COALESCE(cpo.orders, 0) * (cps.sessions / cst.total_sessions)
        ELSE 0
      END
    ) AS orders
  FROM current_path_product_sessions cps
  LEFT JOIN current_product_session_totals cst ON cst.product_id = cps.product_id
  LEFT JOIN current_product_orders cpo ON cpo.product_id = cps.product_id
  GROUP BY cps.dimension_value
),
baseline_allocated_orders AS (
  SELECT
    bps.dimension_value,
    SUM(
      CASE
        WHEN bst.total_sessions > 0
          THEN COALESCE(bpo.orders, 0) * (bps.sessions / bst.total_sessions)
        ELSE 0
      END
    ) AS orders
  FROM baseline_path_product_sessions bps
  LEFT JOIN baseline_product_session_totals bst ON bst.product_id = bps.product_id
  LEFT JOIN baseline_product_orders bpo ON bpo.product_id = bps.product_id
  GROUP BY bps.dimension_value
),` : ''}
current_path_metrics AS (
  SELECT
    dimension_value,
    COALESCE(SUM(sessions), 0) AS sessions,
    COALESCE(SUM(atc_sessions), 0) AS atc_sessions
  FROM current_path_product_sessions
  GROUP BY dimension_value
),
baseline_path_metrics AS (
  SELECT
    dimension_value,
    COALESCE(SUM(sessions), 0) AS sessions,
    COALESCE(SUM(atc_sessions), 0) AS atc_sessions
  FROM baseline_path_product_sessions
  GROUP BY dimension_value
),
all_keys AS (
  SELECT dimension_value FROM current_path_metrics
  UNION
  SELECT dimension_value FROM baseline_path_metrics
  ${includeOrders ? `
  UNION
  SELECT dimension_value FROM current_allocated_orders
  UNION
  SELECT dimension_value FROM baseline_allocated_orders` : ''}
)
SELECT
  k.dimension_value,
  COALESCE(cm.sessions, 0) AS current_sessions,
  COALESCE(bm.sessions, 0) AS baseline_sessions,
  COALESCE(cm.atc_sessions, 0) AS current_atc_sessions,
  COALESCE(bm.atc_sessions, 0) AS baseline_atc_sessions,
  ${includeOrders ? 'COALESCE(cao.orders, 0) AS current_orders,\n  COALESCE(bao.orders, 0) AS baseline_orders' : '0 AS current_orders,\n  0 AS baseline_orders'}
FROM all_keys k
LEFT JOIN current_path_metrics cm ON cm.dimension_value = k.dimension_value
LEFT JOIN baseline_path_metrics bm ON bm.dimension_value = k.dimension_value
${includeOrders ? 'LEFT JOIN current_allocated_orders cao ON cao.dimension_value = k.dimension_value\nLEFT JOIN baseline_allocated_orders bao ON bao.dimension_value = k.dimension_value' : ''}
ORDER BY current_sessions DESC;
  `;
}

function buildDefaultDimensionSql({ dimension, filterSql, notNullSql, includeOrders, includePaymentOrders, includeProductTitle }) {
  return `
WITH
current_sessions AS (
  SELECT
    ${dimension} AS dimension_value,
    COALESCE(SUM(sessions), 0) AS sessions,
    COALESCE(SUM(sessions_with_cart_additions), 0) AS atc_sessions
  FROM product_sessions_snapshot
  WHERE date >= DATE(?)
    AND date <  DATE(?)
    ${filterSql}
    ${notNullSql}
  GROUP BY ${dimension}
),
baseline_sessions AS (
  SELECT
    ${dimension} AS dimension_value,
    COALESCE(SUM(sessions), 0) AS sessions,
    COALESCE(SUM(sessions_with_cart_additions), 0) AS atc_sessions
  FROM product_sessions_snapshot
  WHERE date >= DATE(?)
    AND date <  DATE(?)
    ${filterSql}
    ${notNullSql}
  GROUP BY ${dimension}
),${includeOrders ? `
current_orders AS (
  SELECT
    ${dimension} AS dimension_value,
    COALESCE(COUNT(DISTINCT order_name), 0) AS orders
  FROM shopify_orders
  WHERE created_date >= LEFT(?, 10)
    AND created_date <  LEFT(?, 10)
    ${filterSql}
  GROUP BY ${dimension}
),
baseline_orders AS (
  SELECT
    ${dimension} AS dimension_value,
    COALESCE(COUNT(DISTINCT order_name), 0) AS orders
  FROM shopify_orders
  WHERE created_date >= LEFT(?, 10)
    AND created_date <  LEFT(?, 10)
    ${filterSql}
  GROUP BY ${dimension}
),` : ''}
${includePaymentOrders ? `${buildPaymentOrderCtes({
  dimension,
  filterSql,
  notNullSql,
  timestampMode: 'daily'
})},` : ''}
${includeProductTitle ? `product_titles AS (
  SELECT
    product_id AS dimension_value,
    MAX(product_title) AS product_title
  FROM product_sessions_snapshot
  WHERE date >= DATE(?)
    AND date <  DATE(?)
    ${filterSql}
    ${notNullSql}
  GROUP BY product_id
),` : ''}
all_keys AS (
  SELECT dimension_value FROM current_sessions
  UNION
  SELECT dimension_value FROM baseline_sessions
  ${includeOrders ? `
  UNION
  SELECT dimension_value FROM current_orders
  UNION
  SELECT dimension_value FROM baseline_orders` : ''}
  ${includePaymentOrders ? `
  UNION
  SELECT dimension_value FROM current_payment_orders
  UNION
  SELECT dimension_value FROM baseline_payment_orders` : ''}
)
SELECT
  k.dimension_value,
  COALESCE(cs.sessions, 0) AS current_sessions,
  COALESCE(bs.sessions, 0) AS baseline_sessions,
  COALESCE(cs.atc_sessions, 0) AS current_atc_sessions,
  COALESCE(bs.atc_sessions, 0) AS baseline_atc_sessions,
  ${includeOrders ? 'COALESCE(co.orders, 0) AS current_orders,\n  COALESCE(bo.orders, 0) AS baseline_orders' : '0 AS current_orders,\n  0 AS baseline_orders'}${includePaymentOrders ? ',\n  COALESCE(cpo.cod_orders, 0) AS current_cod_orders,\n  COALESCE(bpo.cod_orders, 0) AS baseline_cod_orders,\n  COALESCE(cpo.ppcod_orders, 0) AS current_ppcod_orders,\n  COALESCE(bpo.ppcod_orders, 0) AS baseline_ppcod_orders,\n  COALESCE(cpo.prepaid_orders, 0) AS current_prepaid_orders,\n  COALESCE(bpo.prepaid_orders, 0) AS baseline_prepaid_orders' : ''}${includeProductTitle ? ',\n  pt.product_title' : ''}
FROM all_keys k
LEFT JOIN current_sessions cs ON cs.dimension_value = k.dimension_value
LEFT JOIN baseline_sessions bs ON bs.dimension_value = k.dimension_value
${includeOrders ? 'LEFT JOIN current_orders co ON co.dimension_value = k.dimension_value\nLEFT JOIN baseline_orders bo ON bo.dimension_value = k.dimension_value' : ''}
${includePaymentOrders ? 'LEFT JOIN current_payment_orders cpo ON cpo.dimension_value = k.dimension_value\nLEFT JOIN baseline_payment_orders bpo ON bpo.dimension_value = k.dimension_value' : ''}
${includeProductTitle ? 'LEFT JOIN product_titles pt ON pt.dimension_value = k.dimension_value' : ''}
ORDER BY current_sessions DESC;
  `;
}

module.exports = function dimensionBreakdownQuery({
  tenantId,
  dimension,
  window,
  baselineWindow,
  timezone,
  filters = [],
  includeOrders = true,
  includePaymentOrders = false
}) {
  if (!tenantId) throw new Error('dimensionBreakdownQuery: tenantId is required (db selector)');
  if (!window?.start || !window?.end) throw new Error('dimensionBreakdownQuery: window.start/window.end required');
  if (!baselineWindow?.start || !baselineWindow?.end) throw new Error('dimensionBreakdownQuery: baselineWindow.start/window.end required');

  assertSafeDimension(dimension);
  if (includePaymentOrders && !PAYMENT_BREAKDOWN_DIMENSIONS.has(dimension)) {
    throw new Error(`dimensionBreakdownQuery: payment order breakdown does not support dimension "${dimension}"`);
  }

  const normalizedWindow = normalizeWindowForQuery(window, timezone);
  const normalizedBaselineWindow = normalizeWindowForQuery(baselineWindow, timezone);
  const useHourlyProductRollup = shouldUseHourlyProductRollup({
    dimension,
    window: normalizedWindow,
    baselineWindow: normalizedBaselineWindow
  });
  const useHourlyLandingPagePathAttribution = shouldUseHourlyLandingPagePathAttribution({
    dimension,
    window: normalizedWindow,
    baselineWindow: normalizedBaselineWindow
  });
  const { whereSql: filterSql, params: filterParams } = useHourlyProductRollup
    ? buildHourlyProductFilterWhere(filters)
    : useHourlyLandingPagePathAttribution
      ? buildHourlyLandingPagePathFilterWhere(filters)
      : buildFilterWhere(filters);

  const notNullSql = buildNotNullFilter(dimension);
  const windowStart = normalizedWindow.start;
  const windowEnd = normalizedWindow.end;
  const baselineStart = normalizedBaselineWindow.start;
  const baselineEnd = normalizedBaselineWindow.end;
  const includeProductTitle = dimension === 'product_id';
  const titleStart = baselineStart;
  const titleEnd = windowEnd;

  const sql = useHourlyProductRollup
    ? buildHourlyProductRollupSql({ filterSql, notNullSql, includeOrders, includePaymentOrders })
    : useHourlyLandingPagePathAttribution
      ? buildHourlyLandingPagePathSql({ filterSql, includeOrders })
      : buildDefaultDimensionSql({ dimension, filterSql, notNullSql, includeOrders, includePaymentOrders, includeProductTitle });

  const params = useHourlyProductRollup ? [
    windowStart, windowEnd, windowStart, windowEnd,
    ...filterParams,

    baselineStart, baselineEnd, baselineStart, baselineEnd,
    ...filterParams,

    ...(includeOrders ? [
      windowStart, windowEnd, windowStart, windowEnd,
      ...filterParams,

      baselineStart, baselineEnd, baselineStart, baselineEnd,
      ...filterParams
    ] : []),

    ...(includePaymentOrders ? [
      windowStart, windowEnd,
      ...filterParams,
      baselineStart, baselineEnd,
      ...filterParams
    ] : []),

    titleStart, titleEnd, titleStart, titleEnd,
    ...filterParams
  ] : useHourlyLandingPagePathAttribution ? [
    windowStart, windowEnd, windowStart, windowEnd,
    ...filterParams,

    baselineStart, baselineEnd, baselineStart, baselineEnd,
    ...filterParams,

    ...(includeOrders ? [
      windowStart, windowEnd,
      windowStart, windowEnd,
      ...filterParams,

      baselineStart, baselineEnd,
      baselineStart, baselineEnd,
      ...filterParams
    ] : [])
  ] : [
    windowStart, windowEnd,
    ...filterParams,

    baselineStart, baselineEnd,
    ...filterParams,

    ...(includeOrders ? [
      windowStart, windowEnd,
      ...filterParams,
      baselineStart, baselineEnd,
      ...filterParams
    ] : []),
    ...(includePaymentOrders ? [
      windowStart, windowEnd,
      ...filterParams,
      baselineStart, baselineEnd,
      ...filterParams
    ] : []),
    ...(includeProductTitle ? [titleStart, titleEnd, ...filterParams] : [])
  ];

  return {
    sql,
    params,
    meta: {
      tenantId,
      type: 'dimension_breakdown',
      dimension
    }
  };
};
