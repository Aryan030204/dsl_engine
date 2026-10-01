// sql/templates/metricQuery.js
const { normalizeWindowForQuery, isFullDayAlignedWindow } = require('../../lib/timeWindowUtils');

// Sales source for one window (tenant-local "YYYY-MM-DD HH:MM:SS" bounds):
//   - whole days (midnight to midnight) -> overall_summary, the daily rollup
//   - anything else (e.g. today until the scheduled hour) -> hour_wise_sales
// Decided per window, so "today vs last 30-day average" reads today from
// hour_wise_sales and the 30 days from overall_summary. AOV's order count comes
// from the same table as the sales it divides.
function salesCte(name, range) {
  if (isFullDayAlignedWindow(range.start, range.end)) {
    return {
      source: 'overall_summary',
      sql: `${name} AS (
  SELECT
    COALESCE(SUM(total_sales), 0) AS sales,
    COALESCE(SUM(total_orders), 0) AS orders
  FROM overall_summary
  WHERE date >= ?
    AND date <  ?
)`,
      params: [range.start.slice(0, 10), range.end.slice(0, 10)]
    };
  }
  return {
    source: 'hour_wise_sales',
    sql: `${name} AS (
  SELECT
    COALESCE(SUM(total_sales), 0) AS sales,
    COALESCE(SUM(number_of_orders), 0) AS orders
  FROM hour_wise_sales
  WHERE CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') >= ?
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') <  ?
)`,
    params: [range.start, range.end]
  };
}

module.exports = function metricQuery({ tenantId, metrics = [], window, baselineWindow, timezone }) {
  if (!tenantId) throw new Error('metricQuery: tenantId is required (db selector)');
  if (!window?.start || !window?.end) throw new Error('metricQuery: window.start/window.end required');
  if (!baselineWindow?.start || !baselineWindow?.end) throw new Error('metricQuery: baselineWindow.start/window.end required');

  const normalizedWindow = normalizeWindowForQuery(window, timezone);
  const normalizedBaselineWindow = normalizeWindowForQuery(baselineWindow, timezone);
  const windowStart = normalizedWindow.start;
  const windowEnd = normalizedWindow.end;
  const baselineStart = normalizedBaselineWindow.start;
  const baselineEnd = normalizedBaselineWindow.end;

  // Sales tables aren't guaranteed in every tenant database -- only query them when
  // the workflow asks for sales or AOV.
  const includeSales = metrics.includes('sales') || metrics.includes('aov');
  const currentSales = includeSales ? salesCte('current_sales', normalizedWindow) : null;
  const baselineSales = includeSales ? salesCte('baseline_sales', normalizedBaselineWindow) : null;

  const sql = `
WITH
current_sessions AS (
  SELECT
    COALESCE(SUM(number_of_sessions), 0) AS sessions,
    COALESCE(SUM(number_of_atc_sessions), 0) AS atc_sessions,
    COALESCE(SUM(adjusted_number_of_sessions), 0) AS adjusted_sessions
  FROM hourly_sessions_summary_shopify
  WHERE CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') >= ?
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') <  ?
),
baseline_sessions AS (
  SELECT
    COALESCE(SUM(number_of_sessions), 0) AS sessions,
    COALESCE(SUM(number_of_atc_sessions), 0) AS atc_sessions,
    COALESCE(SUM(adjusted_number_of_sessions), 0) AS adjusted_sessions
  FROM hourly_sessions_summary_shopify
  WHERE CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') >= ?
    AND CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00') <  ?
),
current_orders AS (
  SELECT
    COALESCE(COUNT(DISTINCT order_name), 0) AS orders
  FROM shopify_orders
  WHERE created_at >= ?
    AND created_at <  ?
),
baseline_orders AS (
  SELECT
    COALESCE(COUNT(DISTINCT order_name), 0) AS orders
  FROM shopify_orders
  WHERE created_at >= ?
    AND created_at <  ?
),
current_payment_orders AS (
  SELECT
    COALESCE(SUM(payment_type = 'COD'), 0) AS cod_orders,
    COALESCE(SUM(payment_type = 'PPCOD'), 0) AS ppcod_orders,
    COALESCE(SUM(payment_type = 'Prepaid'), 0) AS prepaid_orders
  FROM (
    SELECT
      order_name,
      CASE
        WHEN MAX(payment_gateway_names LIKE '%Gokwik PPCOD%') = 1 THEN 'PPCOD'
        WHEN MAX(
          payment_gateway_names IS NULL
          OR payment_gateway_names = ''
          OR payment_gateway_names LIKE '%Cash on Delivery (COD)%'
          OR payment_gateway_names LIKE '%cash_on_delivery%'
        ) = 1 THEN 'COD'
        ELSE 'Prepaid'
      END AS payment_type
    FROM shopify_orders
    WHERE created_at >= ?
      AND created_at <  ?
      AND order_name IS NOT NULL
    GROUP BY order_name
  ) classified
),
baseline_payment_orders AS (
  SELECT
    COALESCE(SUM(payment_type = 'COD'), 0) AS cod_orders,
    COALESCE(SUM(payment_type = 'PPCOD'), 0) AS ppcod_orders,
    COALESCE(SUM(payment_type = 'Prepaid'), 0) AS prepaid_orders
  FROM (
    SELECT
      order_name,
      CASE
        WHEN MAX(payment_gateway_names LIKE '%Gokwik PPCOD%') = 1 THEN 'PPCOD'
        WHEN MAX(
          payment_gateway_names IS NULL
          OR payment_gateway_names = ''
          OR payment_gateway_names LIKE '%Cash on Delivery (COD)%'
          OR payment_gateway_names LIKE '%cash_on_delivery%'
        ) = 1 THEN 'COD'
        ELSE 'Prepaid'
      END AS payment_type
    FROM shopify_orders
    WHERE created_at >= ?
      AND created_at <  ?
      AND order_name IS NOT NULL
    GROUP BY order_name
  ) classified
)${includeSales ? `,
${currentSales.sql},
${baselineSales.sql}` : ''}
SELECT
  cs.sessions AS current_sessions,
  bs.sessions AS baseline_sessions,

  cs.atc_sessions AS current_atc_sessions,
  bs.atc_sessions AS baseline_atc_sessions,

  cs.adjusted_sessions AS current_adjusted_sessions,
  bs.adjusted_sessions AS baseline_adjusted_sessions,

  co.orders AS current_orders,
  bo.orders AS baseline_orders,
  cpo.cod_orders AS current_cod_orders,
  bpo.cod_orders AS baseline_cod_orders,
  cpo.ppcod_orders AS current_ppcod_orders,
  bpo.ppcod_orders AS baseline_ppcod_orders,
  cpo.prepaid_orders AS current_prepaid_orders,
  bpo.prepaid_orders AS baseline_prepaid_orders${includeSales ? `,

  csl.sales AS current_sales,
  bsl.sales AS baseline_sales,
  csl.orders AS current_sales_orders,
  bsl.orders AS baseline_sales_orders` : ''}
FROM current_sessions cs
CROSS JOIN baseline_sessions bs
CROSS JOIN current_orders co
CROSS JOIN baseline_orders bo
CROSS JOIN current_payment_orders cpo
CROSS JOIN baseline_payment_orders bpo${includeSales ? `
CROSS JOIN current_sales csl
CROSS JOIN baseline_sales bsl` : ''};
  `;

  const params = [
    windowStart, windowEnd,
    baselineStart, baselineEnd,
    windowStart, windowEnd,
    baselineStart, baselineEnd,
    // payment-type orders: current window, then baseline window
    windowStart, windowEnd,
    baselineStart, baselineEnd,
    // optional sales: current, then baseline (dates or datetimes per salesCte)
    ...(includeSales ? [...currentSales.params, ...baselineSales.params] : [])
  ];

  return {
    sql,
    params,
    meta: {
      tenantId, // db name selector
      type: 'metric',
      metricsRequested: metrics,
      salesSources: includeSales ? { current: currentSales.source, baseline: baselineSales.source } : null
    }
  };
};
