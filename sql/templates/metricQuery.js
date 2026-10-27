// sql/templates/metricQuery.js
const { normalizeWindowForQuery, isFullDayAlignedWindow } = require('../../lib/timeWindowUtils');

const PAYMENT_METRICS = new Set(['cod_orders', 'ppcod_orders', 'prepaid_orders', 'cod_pct', 'prepaid_pct', 'partial_pct']);
// Order-level discount figures (shopify_orders): discount amount, gross sales (sum of order totals), orders that used a code.
const DISCOUNT_METRICS = new Set(['discount_amount', 'gross_sales', 'discounted_orders', 'unique_discount_codes', 'discount_rate', 'usage_rate']);

// Hourly tables keep date and hour in separate columns. The CONCAT predicate gives the exact
// hour boundary but cannot use an index, so a plain `date` range (same bounds, widened to
// whole days) is added in front of it to let MySQL range-scan instead of reading every row.
const HOURLY_TS = "CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00')";
function hourlyWhere() {
  return `date >= DATE(?)
    AND date <= DATE(?)
    AND ${HOURLY_TS} >= ?
    AND ${HOURLY_TS} <  ?`;
}
function hourlyParams(range) {
  return [range.start, range.end, range.start, range.end];
}

// shopify_orders has no index that starts with created_at, but created_date is indexed. A plain
// created_date range (string compare against 'YYYY-MM-DD', widened to whole days) narrows the scan
// to the right days; the exact created_at bounds still decide which orders count.
function ordersWhere() {
  return `created_date >= LEFT(?, 10)
      AND created_date <= LEFT(?, 10)
      AND created_at >= ?
      AND created_at <  ?`;
}
function ordersParams(start, end) {
  return [start, end, start, end];
}

// Discount figures for one window. discount_amount, total_price and the discount code are order-level values
// stored on one line item per order, so plain sums already give per-order totals (same as the legacy monitor).
function discountCte(name) {
  return `${name} AS (
  SELECT
    COALESCE(COUNT(DISTINCT order_id), 0) AS orders,
    COALESCE(COUNT(DISTINCT CASE WHEN discount_codes IS NOT NULL AND discount_codes != '' THEN order_id END), 0) AS discounted_orders,
    COALESCE(SUM(discount_amount), 0) AS discount_amount,
    COALESCE(SUM(total_price), 0) AS gross_sales,
    COALESCE(COUNT(DISTINCT CASE WHEN discount_codes IS NOT NULL AND discount_codes != '' THEN discount_codes END), 0) AS unique_codes
  FROM shopify_orders
  WHERE ${ordersWhere()}
)`;
}

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
  WHERE ${hourlyWhere()}
)`,
    params: hourlyParams(range)
  };
}

// Sessions, add-to-cart sessions and orders for one window.
//   - whole days (midnight to midnight) -> overall_summary, one row per day (verified to match the
//     hourly sums and the shopify_orders order count)
//   - anything else (today until the scheduled hour, the zero-length empty baseline) -> the hourly
//     table and shopify_orders, because the daily table can't answer "until 14:00"
// Both CTEs keep the same output columns whichever source is used.
function sessionsCte(name, range) {
  if (isFullDayAlignedWindow(range.start, range.end)) {
    return {
      source: 'overall_summary',
      sql: `${name} AS (
  SELECT
    COALESCE(SUM(total_sessions), 0) AS sessions,
    COALESCE(SUM(total_atc_sessions), 0) AS atc_sessions,
    COALESCE(SUM(adjusted_total_sessions), 0) AS adjusted_sessions
  FROM overall_summary
  WHERE date >= ?
    AND date <  ?
)`,
      params: [range.start.slice(0, 10), range.end.slice(0, 10)]
    };
  }
  return {
    source: 'hourly',
    sql: `${name} AS (
  SELECT
    COALESCE(SUM(number_of_sessions), 0) AS sessions,
    COALESCE(SUM(number_of_atc_sessions), 0) AS atc_sessions,
    COALESCE(SUM(adjusted_number_of_sessions), 0) AS adjusted_sessions
  FROM hourly_sessions_summary_shopify
  WHERE ${hourlyWhere()}
)`,
    params: hourlyParams(range)
  };
}

function ordersCte(name, range) {
  if (isFullDayAlignedWindow(range.start, range.end)) {
    return {
      source: 'overall_summary',
      sql: `${name} AS (
  SELECT
    COALESCE(SUM(total_orders), 0) AS orders
  FROM overall_summary
  WHERE date >= ?
    AND date <  ?
)`,
      params: [range.start.slice(0, 10), range.end.slice(0, 10)]
    };
  }
  return {
    source: 'shopify_orders',
    sql: `${name} AS (
  SELECT
    COALESCE(COUNT(DISTINCT order_name), 0) AS orders
  FROM shopify_orders
  WHERE ${ordersWhere()}
)`,
    params: ordersParams(range.start, range.end)
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
  // The COD/PPCOD/Prepaid classification re-scans shopify_orders (GROUP BY order_name plus
  // wildcard LIKEs), so it only runs when a payment metric is actually requested.
  const includePayment = metrics.some((metric) => PAYMENT_METRICS.has(metric));
  const includeDiscount = metrics.some((metric) => DISCOUNT_METRICS.has(metric));
  const currentSales = includeSales ? salesCte('current_sales', normalizedWindow) : null;
  const baselineSales = includeSales ? salesCte('baseline_sales', normalizedBaselineWindow) : null;

  const currentSessions = sessionsCte('current_sessions', normalizedWindow);
  const baselineSessions = sessionsCte('baseline_sessions', normalizedBaselineWindow);
  const currentOrders = ordersCte('current_orders', normalizedWindow);
  const baselineOrders = ordersCte('baseline_orders', normalizedBaselineWindow);

  const sql = `
WITH
${currentSessions.sql},
${baselineSessions.sql},
${currentOrders.sql},
${baselineOrders.sql}${includePayment ? `,
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
    WHERE ${ordersWhere()}
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
    WHERE ${ordersWhere()}
      AND order_name IS NOT NULL
    GROUP BY order_name
  ) classified
)` : ''}${includeDiscount ? `,
${discountCte('current_discount')},
${discountCte('baseline_discount')}` : ''}${includeSales ? `,
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
  ${includePayment ? `cpo.cod_orders AS current_cod_orders,
  bpo.cod_orders AS baseline_cod_orders,
  cpo.ppcod_orders AS current_ppcod_orders,
  bpo.ppcod_orders AS baseline_ppcod_orders,
  cpo.prepaid_orders AS current_prepaid_orders,
  bpo.prepaid_orders AS baseline_prepaid_orders` : `0 AS current_cod_orders,
  0 AS baseline_cod_orders,
  0 AS current_ppcod_orders,
  0 AS baseline_ppcod_orders,
  0 AS current_prepaid_orders,
  0 AS baseline_prepaid_orders`}${includeDiscount ? `,

  cd.orders AS current_discount_orders,
  bd.orders AS baseline_discount_orders,
  cd.discounted_orders AS current_discounted_orders,
  bd.discounted_orders AS baseline_discounted_orders,
  cd.discount_amount AS current_discount_amount,
  bd.discount_amount AS baseline_discount_amount,
  cd.gross_sales AS current_gross_sales,
  bd.gross_sales AS baseline_gross_sales,
  cd.unique_codes AS current_unique_discount_codes,
  bd.unique_codes AS baseline_unique_discount_codes` : ''}${includeSales ? `,

  csl.sales AS current_sales,
  bsl.sales AS baseline_sales,
  csl.orders AS current_sales_orders,
  bsl.orders AS baseline_sales_orders` : ''}
FROM current_sessions cs
CROSS JOIN baseline_sessions bs
CROSS JOIN current_orders co
CROSS JOIN baseline_orders bo${includePayment ? `
CROSS JOIN current_payment_orders cpo
CROSS JOIN baseline_payment_orders bpo` : ''}${includeDiscount ? `
CROSS JOIN current_discount cd
CROSS JOIN baseline_discount bd` : ''}${includeSales ? `
CROSS JOIN current_sales csl
CROSS JOIN baseline_sales bsl` : ''};
  `;

  const params = [
    ...currentSessions.params,
    ...baselineSessions.params,
    ...currentOrders.params,
    ...baselineOrders.params,
    // payment-type orders (only when requested): current window, then baseline window
    ...(includePayment ? [...ordersParams(windowStart, windowEnd), ...ordersParams(baselineStart, baselineEnd)] : []),
    // discount figures (only when requested): current window, then baseline window
    ...(includeDiscount ? [...ordersParams(windowStart, windowEnd), ...ordersParams(baselineStart, baselineEnd)] : []),
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
      salesSources: includeSales ? { current: currentSales.source, baseline: baselineSales.source } : null,
      kpiSources: {
        sessions: { current: currentSessions.source, baseline: baselineSessions.source },
        orders: { current: currentOrders.source, baseline: baselineOrders.source }
      }
    }
  };
};
