const queryBuilder = require('../sql/QueryBuilder');
const queryExecutor = require('../sql/QueryExecutor');

async function MetricCompareNode(def, context) {
  const requestedMetrics = new Set(Array.isArray(def.metrics) ? def.metrics : []);
  const needsRates = requestedMetrics.has('cvr') || requestedMetrics.has('atc_rate');
  const { window, baselineWindow, tenantId, timezone } = context.meta || {};

  // --- 1. Build query specs (intent only) ---
  const querySpec = queryBuilder.buildMetricQuery({
    tenantId,
    metrics: def.metrics,
    window,
    baselineWindow,
    timezone
  });

  // --- 2. Execute queries (execution only) ---
  const result = await queryExecutor.execute(querySpec);

  // --- 3. Validate results (fail loudly, never guess) ---
  if (
    !result?.rows?.length
  ) {
    return {
      status: 'fail',
      reason: 'MetricCompareNode: Missing current or baseline data'
    };
  }

  const row = result.rows[0];

  const {
    current_orders,
    baseline_orders,
    current_sessions,
    baseline_sessions,
    current_atc_sessions,
    baseline_atc_sessions,
    current_cod_orders,
    baseline_cod_orders,
    current_ppcod_orders,
    baseline_ppcod_orders,
    current_prepaid_orders,
    baseline_prepaid_orders
  } = row;

  const currentOrdersNum = Number(current_orders);
  const baselineOrdersNum = Number(baseline_orders);
  const currentSessionsNum = Number(current_sessions);
  const baselineSessionsNum = Number(baseline_sessions);
  const currentAtcSessionsNum = Number(current_atc_sessions);
  const baselineAtcSessionsNum = Number(baseline_atc_sessions);
  const currentCodOrdersNum = Number(current_cod_orders);
  const baselineCodOrdersNum = Number(baseline_cod_orders);
  const currentPpcodOrdersNum = Number(current_ppcod_orders);
  const baselinePpcodOrdersNum = Number(baseline_ppcod_orders);
  const currentPrepaidOrdersNum = Number(current_prepaid_orders);
  const baselinePrepaidOrdersNum = Number(baseline_prepaid_orders);

  if (needsRates && (
    baselineSessionsNum === 0 ||
    currentSessionsNum === 0
  )) {
    return {
      status: 'fail',
      reason: 'MetricCompareNode: Sessions count is zero, cannot compute CVR'
    };
  }

  // --- 4. Derive metrics (pure math, deterministic) ---
  const current_cvr = currentSessionsNum === 0 ? null : currentOrdersNum / currentSessionsNum;
  const baseline_cvr = baselineSessionsNum === 0 ? null : baselineOrdersNum / baselineSessionsNum;

  const current_atc_rate = currentSessionsNum === 0 ? null : currentAtcSessionsNum / currentSessionsNum;
  const baseline_atc_rate = baselineSessionsNum === 0 ? null : baselineAtcSessionsNum / baselineSessionsNum;

  const orders_delta_pct =
    baselineOrdersNum === 0
      ? null
      : ((currentOrdersNum - baselineOrdersNum) / baselineOrdersNum) * 100;

  const sessions_delta_pct =
    baselineSessionsNum === 0
      ? null
      : ((currentSessionsNum - baselineSessionsNum) / baselineSessionsNum) * 100;

  const atc_sessions_delta_pct =
    baselineAtcSessionsNum === 0
      ? null
      : ((currentAtcSessionsNum - baselineAtcSessionsNum) / baselineAtcSessionsNum) * 100;

  const cvr_delta_pct =
    baseline_cvr == null || baseline_cvr === 0
      ? null
      : ((current_cvr - baseline_cvr) / baseline_cvr) * 100;

  const atc_rate_delta_pct =
    baseline_atc_rate == null || baseline_atc_rate === 0
      ? null
      : ((current_atc_rate - baseline_atc_rate) / baseline_atc_rate) * 100;

  const cod_orders_delta_pct = baselineCodOrdersNum === 0
    ? null
    : ((currentCodOrdersNum - baselineCodOrdersNum) / baselineCodOrdersNum) * 100;
  const ppcod_orders_delta_pct = baselinePpcodOrdersNum === 0
    ? null
    : ((currentPpcodOrdersNum - baselinePpcodOrdersNum) / baselinePpcodOrdersNum) * 100;
  const prepaid_orders_delta_pct = baselinePrepaidOrdersNum === 0
    ? null
    : ((currentPrepaidOrdersNum - baselinePrepaidOrdersNum) / baselinePrepaidOrdersNum) * 100;

  // Sales metrics only exist when the node asked for 'sales' or 'aov' (see
  // metricQuery's includeSales). AOV = total sales / orders, both taken from
  // hour_wise_sales so numerator and denominator come from the same source.
  const salesMetrics = row.current_sales === undefined ? {} : deriveSalesMetrics(row);

  // --- 5. Return full ground truth (single return, complete facts) ---
  return {
    status: 'pass',
    delta: {
      metrics: {
        // raw aggregates
        current_orders: currentOrdersNum,
        baseline_orders: baselineOrdersNum,
        current_sessions: currentSessionsNum,
        baseline_sessions: baselineSessionsNum,
        current_atc_sessions: currentAtcSessionsNum,
        baseline_atc_sessions: baselineAtcSessionsNum,
        current_cod_orders: currentCodOrdersNum,
        baseline_cod_orders: baselineCodOrdersNum,
        current_ppcod_orders: currentPpcodOrdersNum,
        baseline_ppcod_orders: baselinePpcodOrdersNum,
        current_prepaid_orders: currentPrepaidOrdersNum,
        baseline_prepaid_orders: baselinePrepaidOrdersNum,

        // derived
        current_cvr,
        baseline_cvr,
        current_atc_rate,
        baseline_atc_rate,

        // deltas
        orders_delta_pct,
        sessions_delta_pct,
        atc_sessions_delta_pct,
        cvr_delta_pct,
        atc_rate_delta_pct,
        cod_orders_delta_pct,
        ppcod_orders_delta_pct,
        prepaid_orders_delta_pct,
        ...salesMetrics
      }
    },
    next: def.next
  };
}

function deltaPct(current, baseline) {
  if (current == null || baseline == null || baseline === 0) return null;
  return ((current - baseline) / baseline) * 100;
}

function deriveSalesMetrics(row) {
  const current_sales = Number(row.current_sales) || 0;
  const baseline_sales = Number(row.baseline_sales) || 0;
  const currentSalesOrders = Number(row.current_sales_orders) || 0;
  const baselineSalesOrders = Number(row.baseline_sales_orders) || 0;
  const current_aov = currentSalesOrders ? current_sales / currentSalesOrders : null;
  const baseline_aov = baselineSalesOrders ? baseline_sales / baselineSalesOrders : null;

  return {
    current_sales,
    baseline_sales,
    current_aov,
    baseline_aov,
    sales_delta_pct: deltaPct(current_sales, baseline_sales),
    aov_delta_pct: deltaPct(current_aov, baseline_aov)
  };
}

module.exports = MetricCompareNode;
