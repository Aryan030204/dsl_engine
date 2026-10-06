// sql/QueryBuilder.js
const templates = require('./templates');

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
      sql: `
        SELECT
          product_id,
          MAX(product_title) AS product_title,
          GROUP_CONCAT(DISTINCT NULLIF(sku, '') ORDER BY sku SEPARATOR ', ') AS sku,
          SUM(inventory_available) AS inventory_available,
          SUM(sold_units_7d) AS sold_units_7d,
          SUM(drr_7d) AS drr_7d,
          MIN(doh_7d) AS doh_7d,
          MAX(updated_at) AS updated_at
        FROM top_products_inventory
        GROUP BY product_id
        ORDER BY SUM(sold_units_7d) DESC, product_id ASC
        LIMIT ${safeTopK}
      `,
      params: [],
      meta: { tenantId, type: 'inventory_product_breakdown', topK: safeTopK }
    };
  }
};
