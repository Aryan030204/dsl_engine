// COD monitor, product level (analysis_mode: 'payment_mix' on a dimension breakdown node).
// Port of legacy cod_monitor: for each whitelisted product, today's COD share of its orders against the average
// of its daily COD shares over the baseline days; relative change, noise filters, and one alert score.
//
// Run it after a metric_compare node that requested `cod_pct`: that node's overall change
// (metrics.cod_pct_delta_pct) is the overall half of the alert score.
const queryExecutor = require('../../sql/QueryExecutor');
const { productPaymentMixQuery } = require('../../sql/templates/monitorQueries');
const { expandBaselineWindows } = require('../../lib/timeWindowUtils');
const { relativeDeltaPct, pct } = require('../../lib/baselineAverage');

const DEFAULTS = {
  overallThresholdPct: 7,
  productThresholdPct: 11,
  minOrders: 20,
  minBaselineDays: 4
};

const normalizeOutputKey = (key) => (typeof key === 'string' ? key.trim() : '');

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function mean(values) {
  const usable = values.filter((value) => value != null && Number.isFinite(value));
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

async function runCodProductMonitor(def, context) {
  const { tenantId, window, baselineWindow, timezone } = context?.meta || {};
  const overallThreshold = positive(def.overall_threshold_pct, DEFAULTS.overallThresholdPct);
  const productThreshold = positive(def.product_threshold_pct, DEFAULTS.productThresholdPct);
  const minOrders = Math.floor(positive(def.min_orders, DEFAULTS.minOrders));
  const minBaselineDays = Math.floor(positive(def.min_baseline_days, DEFAULTS.minBaselineDays));
  const productIds = (Array.isArray(def.product_ids) ? def.product_ids : []).map((id) => String(id).trim()).filter(Boolean);
  const outputKey = normalizeOutputKey(def.output_key) || 'cod_products';

  if (!window?.start || !baselineWindow?.start) {
    return { status: 'fail', reason: 'COD product monitor: the run has no window / baselineWindow' };
  }
  if (!productIds.length) {
    return { status: 'fail', reason: 'COD product monitor: product_ids must list at least one product' };
  }

  const dayRanges = expandBaselineWindows(baselineWindow, context.meta?.baselineDays, timezone);
  const baselineRanges = dayRanges.length ? dayRanges : [baselineWindow];
  const run = (range) => queryExecutor.execute(productPaymentMixQuery({ tenantId, range, timezone, productIds }));
  const [todayResult, ...baselineResults] = await Promise.all([window, ...baselineRanges].map(run));

  const byProduct = (result) => new Map((result?.rows || []).map((row) => [String(row.product_id), row]));
  const today = byProduct(todayResult);
  const baselineDays = baselineResults.map(byProduct);

  const shares = (row) => {
    const total = num(row.total_orders);
    return { cod: pct(num(row.cod_orders), total), prepaid: pct(num(row.prepaid_orders), total), partial: pct(num(row.partial_orders), total) };
  };

  const rows = [];
  const notChecked = [];
  for (const productId of productIds) {
    const current = today.get(productId);
    if (!current || num(current.total_orders) < minOrders) {
      notChecked.push(productId);
      continue;
    }
    // Each baseline day only counts when the product had enough orders that day (legacy HAVING).
    const usableDays = baselineDays
      .map((day) => day.get(productId))
      .filter((row) => row && num(row.total_orders) >= minOrders)
      .map(shares);
    if (usableDays.length < minBaselineDays) {
      notChecked.push(productId);
      continue;
    }

    const now = shares(current);
    const baseline = {
      cod: mean(usableDays.map((day) => day.cod)),
      prepaid: mean(usableDays.map((day) => day.prepaid)),
      partial: mean(usableDays.map((day) => day.partial))
    };
    const delta = relativeDeltaPct(now.cod, baseline.cod);
    rows.push({
      product_id: productId,
      product_name: current.product_name || '-',
      orders: num(current.total_orders),
      cod_orders: num(current.cod_orders),
      current_cod_pct: now.cod,
      baseline_cod_pct: baseline.cod,
      cod_delta_pct: delta,
      current_prepaid_pct: now.prepaid,
      baseline_prepaid_pct: baseline.prepaid,
      prepaid_delta_pct: relativeDeltaPct(now.prepaid, baseline.prepaid),
      current_partial_pct: now.partial,
      baseline_partial_pct: baseline.partial,
      partial_delta_pct: relativeDeltaPct(now.partial, baseline.partial),
      baseline_days: usableDays.length,
      flagged: delta != null && delta > productThreshold
    });
  }

  // Biggest rise first; products with no usable change go last.
  rows.sort((a, b) => (b.cod_delta_pct ?? -Infinity) - (a.cod_delta_pct ?? -Infinity));
  const flagged = rows.filter((row) => row.flagged);

  // One finding for the state engine, in "threshold units": 1 = at the TRIGGERED threshold, 2 = CRITICAL (2x).
  const overallDelta = context?.metrics?.cod_pct_delta_pct;
  const overallValue = Number.isFinite(overallDelta) ? overallDelta : null;
  const topProductDelta = rows.length ? rows[0].cod_delta_pct : null;
  const components = [];
  if (overallValue != null) components.push(overallValue / overallThreshold);
  if (topProductDelta != null) components.push(topProductDelta / productThreshold);
  const score = components.length ? Math.max(0, ...components) : null;

  return {
    status: 'pass',
    delta: {
      metrics: {
        cod_alert_score: score,
        cod_overall_threshold_pct: overallThreshold,
        cod_product_threshold_pct: productThreshold,
        cod_overall_breached: overallValue != null && overallValue > overallThreshold ? 1 : 0,
        cod_products_checked: rows.length,
        cod_products_flagged: flagged.length,
        cod_products_not_checked: notChecked.length,
        cod_top_product_delta_pct: topProductDelta
      },
      breakdowns: {
        [outputKey]: rows,
        [`${outputKey}_flagged`]: flagged
      },
      scratch: { ...(context?.scratch || {}), codProductsNotChecked: notChecked }
    },
    next: def.next
  };
}

module.exports = { runCodProductMonitor, DEFAULTS };
