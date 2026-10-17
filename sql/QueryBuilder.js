// sql/QueryBuilder.js
const templates = require('./templates');

// One row per product, aggregated from the per-variant table top_products_inventory. drr_7d and
// doh_7d are precomputed there, so they are read, not recalculated. A product's DOH is its lowest
// stored variant DOH, but only among variants that actually sell: the table stores doh_7d = 0 for
// a variant with no sales, and counting that would flag the whole product as Critical. If no
// variant sells, DOH is NULL ("No recent sales"). The title comes from the most recently updated
// variant rather than the alphabetically last one.
function inventoryProductSql({ where, tail }) {
  return `
        SELECT
          p.product_id,
          (
            SELECT t.product_title
            FROM top_products_inventory t
            WHERE t.product_id = p.product_id
            ORDER BY t.updated_at DESC, t.variant_id DESC
            LIMIT 1
          ) AS product_title,
          GROUP_CONCAT(DISTINCT NULLIF(p.sku, '') ORDER BY p.sku SEPARATOR ', ') AS sku,
          COUNT(DISTINCT NULLIF(p.sku, '')) AS sku_count,
          SUM(p.inventory_available) AS inventory_available,
          SUM(p.sold_units_7d) AS sold_units_7d,
          SUM(p.drr_7d) AS drr_7d,
          MIN(CASE WHEN p.drr_7d > 0 THEN p.doh_7d END) AS doh_7d,
          MAX(p.updated_at) AS updated_at
        FROM top_products_inventory p
        ${where}
        GROUP BY p.product_id
        ${tail}
      `;
}

module.exports = {
  buildMetricQuery({ tenantId, metrics, window, baselineWindow, timezone, filters = [] }) {
    return templates.metricQuery({
      tenantId,
      metrics,
      window,
      baselineWindow,
      timezone,
      filters
    });
  },

  buildDimensionBreakdownQuery({ tenantId, dimension, window, baselineWindow, timezone, filters, includeOrders, includePaymentOrders }) {
    return templates.dimensionBreakdownQuery({
      tenantId,
      dimension,
      window,
      baselineWindow,
      timezone,
      filters,
      includeOrders,
      includePaymentOrders
    });
  },

  buildInventoryProductQuery({ tenantId, topK = 50 }) {
    if (!tenantId) throw new Error('inventoryProductQuery: tenantId is required (db selector)');
    const safeTopK = Math.max(1, Math.min(100, Math.floor(Number(topK) || 50)));
    return {
      // Fallback ranking when the Redis top-products cache is unavailable: the top products by
      // stored 7-day units sold. See inventoryProductSql for how each product row is built.
      sql: inventoryProductSql({
        where: '',
        tail: `ORDER BY SUM(p.sold_units_7d) DESC, p.product_id ASC
        LIMIT ${safeTopK}`
      }),
      params: [],
      meta: { tenantId, type: 'inventory_product_breakdown', topK: safeTopK }
    };
  },

  // Stock / DRR / DOH for a given list of products (the ids come from the Redis top-products
  // cache). Same per-product aggregation as buildInventoryProductQuery, but no ranking: the
  // caller restores the cache's order. Uses the product_id index.
  buildInventoryProductsByIdsQuery({ tenantId, productIds = [] }) {
    if (!tenantId) throw new Error('inventoryProductQuery: tenantId is required (db selector)');
    const ids = Array.from(new Set(
      (Array.isArray(productIds) ? productIds : []).map((id) => String(id ?? '').trim()).filter(Boolean)
    )).slice(0, 500);
    if (!ids.length) throw new Error('inventoryProductQuery: at least one product id is required');
    return {
      sql: inventoryProductSql({
        where: `WHERE p.product_id IN (${ids.map(() => '?').join(', ')})`,
        tail: 'ORDER BY p.product_id ASC'
      }),
      params: ids,
      meta: { tenantId, type: 'inventory_product_by_ids', productCount: ids.length }
    };
  }
};
