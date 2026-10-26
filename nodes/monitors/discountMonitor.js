// Discount monitor (analysis_mode: 'discount' on a dimension breakdown node).
// Port of legacy discount_monitor/detect.py. Run it after a metric_compare node that requested the discount
// metrics (discount_rate, usage_rate, discount_amount, gross_sales, discounted_orders, unique_discount_codes):
// those totals feed the alert rules, and this node adds the drill-down (top code, new codes, UTM source shares,
// campaign and code under each flagged source) and ONE finding for the state engine.
const queryExecutor = require('../../sql/QueryExecutor');
const { discountGroupedQuery } = require('../../sql/templates/monitorQueries');
const { expandBaselineWindows } = require('../../lib/timeWindowUtils');
const { relativeDeltaPct } = require('../../lib/baselineAverage');

const DEFAULTS = {
  discountRateDeltaPct: 10,          // relative rise in the discount rate (brands with no absolute threshold)
  outpaceGapPct: 10,                 // discount growth must beat sales growth by this many points ...
  outpaceMinDiscountGrowthPct: 10,   // ... and itself be at least this much
  usageRateDeltaPct: 10,             // relative rise in the share of orders using a code
  newCodeMinSharePct: 15,            // % of discounted orders for a code with no baseline presence
  codeCardinalityGuardRatio: 0.15,   // unique codes / discounted orders above this = auto-generated codes
  utmMinCurrentShare: 5,
  utmUpliftDeltaPct: 30,
  utmMaxFlagged: 2,
  divergencePpToSplit: 15,
  minTotalOrders: 50,
  topCodes: 5
};

const normalizeOutputKey = (key) => (typeof key === 'string' ? key.trim() : '');
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function signed(value) {
  return isNum(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(0)}%` : 'n/a';
}

function oneDecimal(value) {
  return isNum(value) ? value.toFixed(1) : '-';
}

// One range's grouped figures: Map(group -> { orders, amount }).
function toGroups(result) {
  const groups = new Map();
  for (const row of result?.rows || []) {
    groups.set(String(row.grp), { orders: Number(row.orders) || 0, amount: Number(row.amount) || 0 });
  }
  return groups;
}

// Each group's share (%) of its day's discount amount, averaged over the baseline days that had any
// discount (legacy fetch_baseline_grouped_share). Map(group -> average share %).
function averageShares(dayResults) {
  const days = dayResults.map(toGroups).filter((groups) => [...groups.values()].some((g) => g.amount > 0));
  if (!days.length) return new Map();
  const sums = new Map();
  for (const groups of days) {
    const total = [...groups.values()].reduce((sum, g) => sum + g.amount, 0);
    if (total <= 0) continue;
    for (const [group, stats] of groups) sums.set(group, (sums.get(group) || 0) + (stats.amount / total) * 100);
  }
  return new Map([...sums].map(([group, sum]) => [group, sum / days.length]));
}

// Groups seen on any baseline day (for "new code" detection).
function seenGroups(dayResults) {
  const seen = new Set();
  for (const result of dayResults) for (const group of toGroups(result).keys()) seen.add(group);
  return seen;
}

async function runDiscountMonitor(def, context) {
  const { tenantId, window, baselineWindow, timezone } = context?.meta || {};
  const metrics = context?.metrics || {};
  const outputKey = normalizeOutputKey(def.output_key) || 'discount';

  const cfg = {
    discountRateDeltaPct: positive(def.discount_rate_delta_pct, DEFAULTS.discountRateDeltaPct),
    outpaceGapPct: positive(def.outpace_gap_pct, DEFAULTS.outpaceGapPct),
    outpaceMinDiscountGrowthPct: positive(def.outpace_min_discount_growth_pct, DEFAULTS.outpaceMinDiscountGrowthPct),
    usageRateDeltaPct: positive(def.usage_rate_delta_pct, DEFAULTS.usageRateDeltaPct),
    newCodeMinSharePct: positive(def.new_code_min_share_pct, DEFAULTS.newCodeMinSharePct),
    codeCardinalityGuardRatio: positive(def.code_cardinality_guard_ratio, DEFAULTS.codeCardinalityGuardRatio),
    utmMinCurrentShare: positive(def.utm_min_current_share, DEFAULTS.utmMinCurrentShare),
    utmUpliftDeltaPct: positive(def.utm_uplift_delta_pct, DEFAULTS.utmUpliftDeltaPct),
    utmMaxFlagged: Math.floor(positive(def.utm_max_flagged, DEFAULTS.utmMaxFlagged)),
    divergencePpToSplit: positive(def.divergence_pp_to_split, DEFAULTS.divergencePpToSplit),
    minTotalOrders: positive(def.min_total_orders, DEFAULTS.minTotalOrders)
  };

  // Per-brand absolute rate threshold (% of gross sales), as { TENANT: 5 } or one number for every brand.
  // A brand with one skips the relative check, like legacy discount_rate_absolute_pct.
  const absolute = def.discount_rate_absolute_pct;
  const perBrand = absolute && typeof absolute === 'object' ? Number(absolute[tenantId]) : Number(absolute);
  const rateAbsoluteThreshold = Number.isFinite(perBrand) && perBrand > 0 ? perBrand : null;

  if (!isNum(metrics.current_discount_rate)) {
    return { status: 'fail', reason: 'Discount monitor: run a metric_compare node with the discount metrics (discount_rate, usage_rate, ...) first' };
  }

  const breakdownKeys = ['alerts', 'top_code', 'new_codes', 'utm_sources', 'campaigns'];
  const emptyBreakdowns = Object.fromEntries(breakdownKeys.map((key) => [`${outputKey}_${key}`, []]));

  // Too few orders so far today: legacy skips the brand. No finding, so the state engine records "inconclusive".
  if ((metrics.current_total_orders ?? 0) < cfg.minTotalOrders) {
    return {
      status: 'pass',
      delta: {
        metrics: {
          discount_alert_score: null,
          discount_alerts_fired: 0,
          discount_skipped_low_orders: 1,
          discount_orders_so_far: metrics.current_total_orders ?? 0
        },
        breakdowns: emptyBreakdowns
      },
      next: def.next
    };
  }

  // ---- alert rules (legacy decide_alerts) ----
  const rateValue = rateAbsoluteThreshold != null ? metrics.current_discount_rate : metrics.discount_rate_delta_pct;
  const rateThreshold = rateAbsoluteThreshold != null ? rateAbsoluteThreshold : cfg.discountRateDeltaPct;
  const discountGrowth = metrics.discount_amount_delta_pct;
  const salesGrowth = metrics.gross_sales_delta_pct;
  const usageDelta = metrics.usage_rate_delta_pct;

  // How close each rule is to firing, in threshold units: 1 = at the threshold (TRIGGERED), 2 = double (CRITICAL).
  const ratio = (value, threshold) => (isNum(value) ? Math.max(0, value / threshold) : null);
  const outpaceGap = isNum(discountGrowth) && isNum(salesGrowth) ? discountGrowth - salesGrowth : null;
  const checks = [
    {
      type: 'DISCOUNT_RATE_SPIKE',
      label: 'Discount Rate Spike',
      ratio: ratio(rateValue, rateThreshold),
      message: `Discount rate is ${oneDecimal(metrics.current_discount_rate)}% vs ${oneDecimal(metrics.baseline_discount_rate)}% baseline`
        + `${isNum(metrics.discount_rate_delta_pct) ? ` (${signed(metrics.discount_rate_delta_pct)})` : ''} — more of each sale is being given away.`
    },
    {
      type: 'USAGE_RATE_SPIKE',
      label: 'Discount Usage Spike',
      ratio: ratio(usageDelta, cfg.usageRateDeltaPct),
      message: `${oneDecimal(metrics.current_usage_rate)}% of orders used a discount vs ${oneDecimal(metrics.baseline_usage_rate)}% baseline`
        + `${isNum(usageDelta) ? ` (${signed(usageDelta)})` : ''} — more orders are using a code, even if the amount looks flat.`
    },
    {
      type: 'DISCOUNT_OUTPACING_SALES',
      label: 'Discount Outpacing Sales',
      // both conditions must hold, so the weaker one decides how close the alert is
      ratio: isNum(discountGrowth) && isNum(outpaceGap)
        ? Math.max(0, Math.min(discountGrowth / cfg.outpaceMinDiscountGrowthPct, outpaceGap / cfg.outpaceGapPct))
        : null,
      message: `Discount amount is ${signed(discountGrowth)} vs baseline while total sales are ${signed(salesGrowth)} — discounts are growing faster than revenue.`
    }
  ];
  // ---- code checks: always run, like legacy (a new code can show up on an otherwise calm day) ----
  const days = expandBaselineWindows(baselineWindow, context.meta?.baselineDays, timezone);
  const baselineRanges = days.length ? days : [baselineWindow];
  const grouped = (range, group, scope) => queryExecutor.execute(discountGroupedQuery({ tenantId, range, timezone, group, scope }));
  const groupedAll = async (group, scope) => {
    const [today, ...baseline] = await Promise.all([window, ...baselineRanges].map((range) => grouped(range, group, scope)));
    return { today: toGroups(today), baseline };
  };

  const drill = { topCode: [], newCodes: [], utm: [], campaigns: [] };
  const discountedOrders = metrics.current_discounted_orders ?? 0;
  const uniqueCodes = metrics.current_unique_discount_codes ?? 0;
  // Codes generated per order (one-off bundle codes) say nothing about campaigns, so skip the code checks.
  const codesLookGenerated = discountedOrders > 0 && uniqueCodes / discountedOrders > cfg.codeCardinalityGuardRatio;

  if (!codesLookGenerated) {
    const codes = await groupedAll('discount_code');
    const totalAmount = [...codes.today.values()].reduce((sum, g) => sum + g.amount, 0) || 1;
    const top = [...codes.today].sort((a, b) => b[1].amount - a[1].amount)[0];
    if (top) {
      drill.topCode.push({
        code: top[0],
        orders: top[1].orders,
        amount: top[1].amount,
        amount_share_pct: (top[1].amount / totalAmount) * 100,
        orders_share_pct: discountedOrders ? (top[1].orders / discountedOrders) * 100 : 0
      });
    }
    // A code with no presence in the baseline that already takes a real share of today's discounted orders.
    const seen = seenGroups(codes.baseline);
    for (const [code, stats] of codes.today) {
      if (seen.has(code)) continue;
      const ordersShare = discountedOrders ? (stats.orders / discountedOrders) * 100 : 0;
      if (ordersShare >= cfg.newCodeMinSharePct) {
        drill.newCodes.push({
          code,
          orders: stats.orders,
          amount: stats.amount,
          orders_share_pct: ordersShare,
          severity: ordersShare >= cfg.newCodeMinSharePct * 2 ? 'CRITICAL' : 'TRIGGERED'
        });
      }
    }
    drill.newCodes.sort((a, b) => b.orders_share_pct - a.orders_share_pct);
  }
  if (drill.newCodes.length) {
    const biggest = drill.newCodes[0];
    checks.push({
      type: 'NEW_CODE',
      label: 'New Discount Code',
      ratio: biggest.orders_share_pct / cfg.newCodeMinSharePct,
      message: `${drill.newCodes.map((c) => `${c.code} — ${c.orders_share_pct.toFixed(0)}% of today's discounted orders`).join('; ')} (not used in the baseline days).`
    });
  }

  const alerts = checks
    .filter((check) => check.ratio != null && check.ratio >= 1)
    .map((check) => ({ ...check, severity: check.ratio >= 2 ? 'CRITICAL' : 'TRIGGERED' }));
  const ratios = checks.map((check) => check.ratio).filter((value) => value != null);
  const score = ratios.length ? Math.max(...ratios) : null;

  // ---- drill-down by UTM source and campaign: only when something fired, like legacy (keeps quiet runs cheap) ----
  if (alerts.length) {
    // UTM source share of today's discount vs its usual share
    const sources = await groupedAll('utm_source');
    const sourceTotal = [...sources.today.values()].reduce((sum, g) => sum + g.amount, 0) || 1;
    const baselineSourceShare = averageShares(sources.baseline);
    const sourceRows = [...sources.today].map(([source, stats]) => {
      const currentShare = (stats.amount / sourceTotal) * 100;
      const baselineShare = baselineSourceShare.get(source) ?? 0;
      return {
        source,
        current_share: currentShare,
        baseline_share: baselineShare,
        delta_pct: relativeDeltaPct(currentShare, baselineShare),
        orders: stats.orders,
        amount: stats.amount
      };
    }).sort((a, b) => b.current_share - a.current_share);
    const flagged = sourceRows
      .filter((row) => row.current_share >= cfg.utmMinCurrentShare && row.delta_pct != null && row.delta_pct >= cfg.utmUpliftDeltaPct)
      .sort((a, b) => b.delta_pct - a.delta_pct)
      .slice(0, cfg.utmMaxFlagged);
    const flaggedNames = new Set(flagged.map((row) => row.source));
    drill.utm = sourceRows.map((row) => ({
      ...row,
      flagged: flaggedNames.has(row.source),
      // the UTM table prints this next to the source name
      source_label: flaggedNames.has(row.source) ? `${row.source}  ▲ FLAGGED` : row.source
    }));

    // For each flagged source: its top campaign, and the codes under that campaign
    for (const row of flagged) {
      const campaigns = await groupedAll('utm_campaign', { source: row.source });
      if (!campaigns.today.size) continue;
      const campaignTotal = [...campaigns.today.values()].reduce((sum, g) => sum + g.amount, 0) || 1;
      const [campaign, stats] = [...campaigns.today].sort((a, b) => b[1].amount - a[1].amount)[0];
      const currentShare = (stats.amount / campaignTotal) * 100;
      const baselineShare = averageShares(campaigns.baseline).get(campaign) ?? 0;

      const codesToday = toGroups(await grouped(window, 'discount_code', { source: row.source, campaign }));
      const amountTotal = [...codesToday.values()].reduce((sum, g) => sum + g.amount, 0) || 1;
      const ordersTotal = [...codesToday.values()].reduce((sum, g) => sum + g.orders, 0) || 1;
      const codes = [...codesToday].map(([code, c]) => {
        const amountShare = (c.amount / amountTotal) * 100;
        const ordersShare = (c.orders / ordersTotal) * 100;
        return {
          code,
          amount_share_pct: amountShare,
          orders_share_pct: ordersShare,
          diverges: Math.abs(amountShare - ordersShare) >= cfg.divergencePpToSplit
        };
      }).sort((a, b) => b.amount_share_pct - a.amount_share_pct).slice(0, DEFAULTS.topCodes);

      drill.campaigns.push({
        source: row.source,
        campaign,
        current_share: currentShare,
        baseline_share: baselineShare,
        delta_pct: relativeDeltaPct(currentShare, baselineShare),
        codes,
        codes_text: codes.map((c) => (c.diverges
          ? `${c.code} · ${c.amount_share_pct.toFixed(0)}% amt (${c.orders_share_pct.toFixed(0)}% orders)`
          : `${c.code} · ${c.amount_share_pct.toFixed(0)}%`)).join('   ')
      });
    }
  }

  return {
    status: 'pass',
    delta: {
      metrics: {
        discount_alert_score: score,
        discount_alerts_fired: alerts.length,
        discount_new_codes_found: drill.newCodes.length,
        discount_rate_threshold: rateThreshold,
        discount_rate_threshold_mode: rateAbsoluteThreshold != null ? 'absolute' : 'relative',
        discount_outpace_gap_pct: outpaceGap
      },
      breakdowns: {
        [`${outputKey}_alerts`]: alerts,
        [`${outputKey}_top_code`]: drill.topCode,
        [`${outputKey}_new_codes`]: drill.newCodes,
        [`${outputKey}_utm_sources`]: drill.utm,
        [`${outputKey}_campaigns`]: drill.campaigns
      }
    },
    next: def.next
  };
}

module.exports = { runDiscountMonitor, averageShares, DEFAULTS };
