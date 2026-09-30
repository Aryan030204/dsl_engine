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
  }
};
