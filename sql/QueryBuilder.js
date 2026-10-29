// sql/QueryBuilder.js
const templates = require('./templates');

// A window bound as the brand's local { date: 'YYYY-MM-DD', time: 'HH:mm:ss' }. Scheduler windows
// are UTC instants ('...Z'); a bare 'YYYY-MM-DD HH:mm:ss' is already local.
function localDateTime(value, timezone) {
  const text = String(value || '');
  const bare = text.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?(?:\.\d+)?$/);
  if (bare) return { date: bare[1], time: bare[2] || '00:00:00' };
  const instant = new Date(text);
  if (!text || Number.isNaN(instant.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

// The brand's local days a window covers. `date` columns are local days: a window that ends at
// local midnight excludes that day, one that ends mid-day includes it.
function localDayRange(window, timezone, label) {
  const start = localDateTime(window?.start, timezone);
  const end = localDateTime(window?.end, timezone);
  if (!start || !end) {
    throw new Error(`${label}: window.start and window.end must be valid dates (YYYY-MM-DD...)`);
  }
  return { start: start.date, end: end.date, endOperator: end.time === '00:00:00' ? '<' : '<=' };
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

  // With `productIds` the query covers exactly those products (the caller already ranked them,
  // e.g. by sales) and ignores the units ranking; without it, the top `topK` products by units sold.
  buildInventoryProductQuery({ tenantId, topK = 50, productIds } = {}) {
    if (!tenantId) throw new Error('inventoryProductQuery: tenantId is required (db selector)');
    const safeTopK = Math.max(1, Math.min(100, Math.floor(Number(topK) || 50)));
    const ids = Array.isArray(productIds)
      ? [...new Set(productIds.map((id) => String(id).trim()).filter((id) => /^\d{1,20}$/.test(id)))].slice(0, 100)
      : null;
    if (ids && ids.length === 0) throw new Error('inventoryProductQuery: productIds has no valid product ids');
    return {
      // The table is one row per variant, and drr_7d / doh_7d are precomputed there, so they
      // are read, not recalculated. A product's DOH is its lowest stored variant DOH, but only
      // among variants that actually sell: the table stores doh_7d = 0 for a variant with no
      // sales, and counting that would flag the whole product as Critical. If no variant
      // sells, DOH is NULL ("No recent sales"). The title comes from the most recently
      // updated variant rather than the alphabetically last one.
      sql: `
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
          SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN p.drr_7d > 0 THEN NULLIF(p.sku, '') END ORDER BY p.doh_7d ASC, p.sku ASC SEPARATOR '|'), '|', 1) AS doh_sku,
          SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN p.drr_7d > 0 THEN p.drr_7d END ORDER BY p.doh_7d ASC, p.sku ASC SEPARATOR '|'), '|', 1) AS worst_drr_7d,
          SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN p.drr_7d > 0 THEN p.inventory_available END ORDER BY p.doh_7d ASC, p.sku ASC SEPARATOR '|'), '|', 1) AS worst_inventory_available,
          SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN p.drr_7d > 0 THEN p.sold_units_7d END ORDER BY p.doh_7d ASC, p.sku ASC SEPARATOR '|'), '|', 1) AS worst_sold_units_7d,
          SUM(p.inventory_available) AS inventory_available,
          SUM(p.sold_units_7d) AS sold_units_7d,
          SUM(p.drr_7d) AS drr_7d,
          MIN(CASE WHEN p.drr_7d > 0 THEN p.doh_7d END) AS doh_7d,
          MAX(p.updated_at) AS updated_at
        FROM top_products_inventory p
        ${ids ? 'WHERE p.product_id IN (?)' : ''}
        GROUP BY p.product_id
        ORDER BY SUM(p.sold_units_7d) DESC, p.product_id ASC
        LIMIT ${ids ? ids.length : safeTopK}
      `,
      params: ids ? [ids] : [],
      meta: { tenantId, type: 'inventory_product_breakdown', topK: ids ? ids.length : safeTopK }
    };
  },

  // Page speed per page over a day range. web_vitals_summary holds a few snapshots per day
  // (each the top pages by same-day cumulative sessions), so the score is averaged over the
  // snapshots a page appears in. The caller ranks the pages (by full-day sessions), so up to
  // `limit` pages come back unranked. INP is not selected: the source never fills it.
  buildWebVitalsQuery({ tenantId, window, timezone = 'UTC', limit = 50 } = {}) {
    if (!tenantId) throw new Error('webVitalsQuery: tenantId is required (db selector)');
    const days = localDayRange(window, timezone, 'webVitalsQuery');
    const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 50)));
    return {
      sql: `
        SELECT
          page_name,
          MAX(url) AS url,
          MAX(sessions) AS sessions,
          AVG(performance) AS performance,
          COUNT(*) AS snapshots
        FROM web_vitals_summary
        WHERE \`date\` >= ? AND \`date\` ${days.endOperator} ?
        GROUP BY page_name
        ORDER BY MAX(sessions) DESC, page_name ASC
        LIMIT ${safeLimit}
      `,
      params: [days.start, days.end],
      meta: { tenantId, type: 'web_vitals_pages', limit: safeLimit }
    };
  },

  // Full-day sessions and conversion rate per landing page path. conversion_rate_pct is already a
  // percentage per path and day, so a multi-day window weights it by sessions. product_id is NULL
  // for non-product paths (home, collections), whose rate the table does not track.
  buildPagePathCvrQuery({ tenantId, window, timezone = 'UTC', paths } = {}) {
    if (!tenantId) throw new Error('pagePathCvrQuery: tenantId is required (db selector)');
    const days = localDayRange(window, timezone, 'pagePathCvrQuery');
    const safePaths = Array.isArray(paths)
      ? [...new Set(paths.map((path) => String(path)).filter(Boolean))].slice(0, 100)
      : [];
    if (!safePaths.length) throw new Error('pagePathCvrQuery: paths is required');
    return {
      sql: `
        SELECT
          landing_page_path,
          MAX(product_id) AS product_id,
          SUM(sessions) AS sessions,
          SUM(sessions * conversion_rate_pct) / NULLIF(SUM(sessions), 0) AS cvr_pct
        FROM mv_product_sessions_by_path_daily
        WHERE \`date\` >= ? AND \`date\` ${days.endOperator} ? AND landing_page_path IN (?)
        GROUP BY landing_page_path
      `,
      params: [days.start, days.end, safePaths],
      meta: { tenantId, type: 'page_path_cvr', paths: safePaths.length }
    };
  }
};
