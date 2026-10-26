const queryBuilder = require('../sql/QueryBuilder');
const queryExecutor = require('../sql/QueryExecutor');
const { expandBaselineWindows } = require('../lib/timeWindowUtils');
const { averageBaselineRows, relativeDeltaPct, pct } = require('../lib/baselineAverage');

const COD_FAMILY = new Set(['cod_pct', 'prepaid_pct', 'partial_pct']);
const DISCOUNT_FAMILY = new Set(['discount_amount', 'gross_sales', 'discounted_orders', 'unique_discount_codes', 'discount_rate', 'usage_rate']);

async function MetricCompareNode(def, context) {
  const requestedMetrics = new Set(Array.isArray(def.metrics) ? def.metrics : []);
  const needsRates = requestedMetrics.has('cvr') || requestedMetrics.has('atc_rate');
  const { window, baselineWindow, tenantId, timezone } = context.meta || {};

  // Day-averaged baseline ("today vs the last N days at the same time of day"): the baseline is the average of
  // N daily windows. The current window runs once with an empty baseline; each baseline day runs on its own
  // (empty baseline too, so no window is scanned twice) and the daily rows are averaged below.
  const baselineDayWindows = expandBaselineWindows(baselineWindow, context.meta?.baselineDays, timezone);
  const averaged = baselineDayWindows.length > 0;
  const emptyBaseline = (range) => ({ start: range.start, end: range.start });

  // --- 1. Build query specs (intent only) ---
  const querySpec = queryBuilder.buildMetricQuery({
    tenantId,
    metrics: def.metrics,
    window,
    baselineWindow: averaged ? emptyBaseline(window) : baselineWindow,
    timezone
  });

  // --- 2. Execute queries (execution only) ---
  const result = await queryExecutor.execute(querySpec);
  let dayResults = [];
  if (averaged) {
    dayResults = await Promise.all(baselineDayWindows.map((dayWindow) => queryExecutor.execute(
      queryBuilder.buildMetricQuery({
        tenantId,
        metrics: def.metrics,
        window: dayWindow,
        baselineWindow: emptyBaseline(dayWindow),
        timezone
      })
    )));
  }

  // --- 3. Validate results (fail loudly, never guess) ---
  if (
    !result?.rows?.length
  ) {
    return {
      status: 'fail',
      reason: 'MetricCompareNode: Missing current or baseline data'
    };
  }

  let row = result.rows[0];
  if (averaged) {
    row = { ...row, ...averageBaselineRows(dayResults.map((dayResult) => dayResult?.rows?.[0] || {})) };
  }

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
  const paymentShareMetrics = deriveCodFamily(row, requestedMetrics, averaged);
  const discountMetrics = deriveDiscountFamily(row, requestedMetrics);

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
        ...salesMetrics,
        ...paymentShareMetrics,
        ...discountMetrics,
        ...(averaged ? { baseline_days_seen: row.baseline_days_seen } : {})
      }
    },
    next: def.next
  };
}

// COD / prepaid / partial share of orders, in percent. Current = this window's share. Baseline = the average of the
// daily shares when the baseline is day-averaged (legacy parity), otherwise the baseline window's own share.
function deriveCodFamily(row, requestedMetrics, averaged) {
  const wanted = [...COD_FAMILY].filter((metric) => requestedMetrics.has(metric));
  if (!wanted.length) return {};

  const total = (prefix) => Number(row[`${prefix}_cod_orders`] || 0)
    + Number(row[`${prefix}_ppcod_orders`] || 0)
    + Number(row[`${prefix}_prepaid_orders`] || 0);
  const shareOf = (prefix, field) => pct(Number(row[`${prefix}_${field}`] || 0), total(prefix));
  const sources = { cod_pct: 'cod_orders', prepaid_pct: 'prepaid_orders', partial_pct: 'ppcod_orders' };

  const out = { current_payment_orders: total('current') };
  if (!averaged) out.baseline_payment_orders = total('baseline');
  for (const metric of wanted) {
    const current = shareOf('current', sources[metric]);
    const baseline = averaged ? (row[`baseline_${metric}`] ?? null) : shareOf('baseline', sources[metric]);
    out[`current_${metric}`] = current;
    out[`baseline_${metric}`] = baseline;
    out[`${metric}_delta_pct`] = relativeDeltaPct(current, baseline);
  }
  return out;
}

// Discount figures from shopify_orders. Rates are percentages. As in the legacy monitor, the rates are ratios of
// the (averaged) sums, and the baseline figures are per-day averages.
function deriveDiscountFamily(row, requestedMetrics) {
  if (![...DISCOUNT_FAMILY].some((metric) => requestedMetrics.has(metric))) return {};

  const read = (prefix, field) => Number(row[`${prefix}_${field}`] || 0);
  const figures = (prefix) => ({
    orders: read(prefix, 'discount_orders'),
    discountedOrders: read(prefix, 'discounted_orders'),
    discountAmount: read(prefix, 'discount_amount'),
    grossSales: read(prefix, 'gross_sales'),
    uniqueCodes: read(prefix, 'unique_discount_codes')
  });
  const current = figures('current');
  const baseline = figures('baseline');
  const rate = (f) => pct(f.discountAmount, f.grossSales);
  const usage = (f) => pct(f.discountedOrders, f.orders);

  const discountAmountDelta = relativeDeltaPct(current.discountAmount, baseline.discountAmount);
  const grossSalesDelta = relativeDeltaPct(current.grossSales, baseline.grossSales);
  return {
    current_total_orders: current.orders,
    baseline_total_orders: baseline.orders,
    current_discounted_orders: current.discountedOrders,
    baseline_discounted_orders: baseline.discountedOrders,
    current_discount_amount: current.discountAmount,
    baseline_discount_amount: baseline.discountAmount,
    current_gross_sales: current.grossSales,
    baseline_gross_sales: baseline.grossSales,
    current_unique_discount_codes: current.uniqueCodes,
    current_discount_rate: rate(current),
    baseline_discount_rate: rate(baseline),
    discount_rate_delta_pct: relativeDeltaPct(rate(current), rate(baseline)),
    current_usage_rate: usage(current),
    baseline_usage_rate: usage(baseline),
    usage_rate_delta_pct: relativeDeltaPct(usage(current), usage(baseline)),
    discount_amount_delta_pct: discountAmountDelta,
    gross_sales_delta_pct: grossSalesDelta,
    // how far discounts are growing ahead of sales (both relative changes, in points)
    discount_vs_sales_gap_pct: discountAmountDelta == null || grossSalesDelta == null ? null : discountAmountDelta - grossSalesDelta
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
