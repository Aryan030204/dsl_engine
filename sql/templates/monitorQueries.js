// sql/templates/monitorQueries.js
// Queries for the COD and Discount monitors (ported from the legacy cod_monitor / discount_monitor).
// Both read shopify_orders for ONE time range per query; the monitor modules run it for today and for each
// baseline day and combine the results, so the same SQL serves every window.
const { normalizeQueryDateTime } = require('../../lib/timeWindowUtils');

// Same ordersWhere() shape as metricQuery.js: the created_date range lets MySQL use its index, the exact
// created_at bounds decide which orders count.
function ordersRangeWhere() {
  return `created_date >= LEFT(?, 10)
      AND created_date <= LEFT(?, 10)
      AND created_at >= ?
      AND created_at <  ?`;
}

function rangeParams(range, timezone) {
  const start = normalizeQueryDateTime(range.start, timezone);
  const end = normalizeQueryDateTime(range.end, timezone);
  return [start, end, start, end];
}

function assertTenant(tenantId) {
  if (!tenantId) throw new Error('monitorQuery: tenantId is required (db selector)');
}

// Legacy per-line payment classification (cod_monitor/queries.py _PAYMENT_CASE).
const PAYMENT_CASE = `CASE
        WHEN payment_gateway_names LIKE '%Gokwik PPCOD%' THEN 'Partial'
        WHEN payment_gateway_names IS NULL
          OR payment_gateway_names = ''
          OR payment_gateway_names LIKE '%Cash on Delivery (COD)%'
          OR payment_gateway_names LIKE '%cash_on_delivery%' THEN 'COD'
        ELSE 'Prepaid'
      END`;

// One row per whitelisted product in the range: total / COD / prepaid / partial orders (each order once per
// product) and a product name. Used for today and for every baseline day.
function productPaymentMixQuery({ tenantId, range, timezone, productIds }) {
  assertTenant(tenantId);
  const ids = Array.from(new Set((Array.isArray(productIds) ? productIds : [])
    .map((id) => String(id ?? '').trim())
    .filter((id) => /^\d{1,20}$/.test(id))));
  if (!ids.length) throw new Error('monitorQuery: product_ids must list at least one product id');

  return {
    sql: `
SELECT
  product_id,
  MAX(product_name) AS product_name,
  COUNT(DISTINCT order_id) AS total_orders,
  COUNT(DISTINCT CASE WHEN payment_type = 'COD' THEN order_id END) AS cod_orders,
  COUNT(DISTINCT CASE WHEN payment_type = 'Prepaid' THEN order_id END) AS prepaid_orders,
  COUNT(DISTINCT CASE WHEN payment_type = 'Partial' THEN order_id END) AS partial_orders
FROM (
  SELECT
    order_id,
    product_id,
    MIN(line_item) AS product_name,
    ${PAYMENT_CASE} AS payment_type
  FROM shopify_orders
  WHERE ${ordersRangeWhere()}
    AND product_id IN (${ids.map(() => '?').join(', ')})
  GROUP BY order_id, product_id, payment_gateway_names
) classified
GROUP BY product_id
  `,
    params: [...rangeParams(range, timezone), ...ids],
    meta: { tenantId, type: 'cod_product_payment_mix', productCount: ids.length }
  };
}

// Group expressions are fixed here (never taken from the workflow), as in legacy detect.py.
const DISCOUNT_GROUPS = {
  discount_code: 'discount_codes',
  utm_source: "COALESCE(NULLIF(TRIM(utm_source), ''), 'Direct/Unknown')",
  utm_campaign: "COALESCE(NULLIF(TRIM(utm_campaign), ''), 'Unknown')"
};

// Optional narrowing: only orders from one source / one campaign (values are bound as parameters; the
// "Direct/Unknown" and "Unknown" labels match empty values, like legacy campaign_drill).
function discountScopeWhere({ source, campaign } = {}) {
  const clauses = [];
  const params = [];
  if (source !== undefined && source !== null) {
    if (source === 'Direct/Unknown') clauses.push("(utm_source IS NULL OR TRIM(utm_source) = '')");
    else { clauses.push('TRIM(utm_source) = ?'); params.push(source); }
  }
  if (campaign !== undefined && campaign !== null) {
    if (campaign === 'Unknown') clauses.push("(utm_campaign IS NULL OR TRIM(utm_campaign) = '')");
    else { clauses.push('TRIM(utm_campaign) = ?'); params.push(campaign); }
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

// Discounted orders and discount amount per group (code / source / campaign) in one range.
function discountGroupedQuery({ tenantId, range, timezone, group, scope }) {
  assertTenant(tenantId);
  const expression = DISCOUNT_GROUPS[group];
  if (!expression) throw new Error(`monitorQuery: unsupported discount group "${group}"`);
  const narrowing = discountScopeWhere(scope);

  return {
    sql: `
SELECT
  ${expression} AS grp,
  COUNT(DISTINCT order_id) AS orders,
  COALESCE(SUM(discount_amount), 0) AS amount
FROM shopify_orders
WHERE ${ordersRangeWhere()}
  AND discount_codes IS NOT NULL AND discount_codes != ''${narrowing.sql}
GROUP BY grp
  `,
    params: [...rangeParams(range, timezone), ...narrowing.params],
    meta: { tenantId, type: 'discount_grouped', group }
  };
}

module.exports = { productPaymentMixQuery, discountGroupedQuery, DISCOUNT_GROUPS };
