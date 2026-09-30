const queryBuilder = require('../sql/QueryBuilder');
const queryExecutor = require('../sql/QueryExecutor');
const {
  buildDefaultBreakdownOutputKey,
  detectOutputKeyMode,
} = require('../server/constants/workflowOutputKeys');

const PAYMENT_ORDER_METRICS = new Set(['cod_orders', 'ppcod_orders', 'prepaid_orders']);

async function RecursiveDimensionBreakdownNode(def, context) {
  const selectedMetrics = [...new Set(
    (Array.isArray(def.base_metrics) && def.base_metrics.length
      ? def.base_metrics
      : [def.base_metric || 'cvr'])
      .filter((metric) => typeof metric === 'string' && metric.trim())
  )];

  if (selectedMetrics.length <= 1) {
    return runSingleMetricBreakdown({
      ...def,
      base_metric: selectedMetrics[0] || def.base_metric || 'cvr'
    }, context);
  }

  const customOutputKey = normalizeOutputKey(def.output_key);
  const metricResults = await Promise.all(selectedMetrics.map((metric) => {
    const outputKey = customOutputKey
      ? `${customOutputKey}_${metric}`
      : buildDefaultBreakdownOutputKey({
          baseMetric: metric,
          dimension: (Array.isArray(def.dimensions) && def.dimensions.length
            ? def.dimensions
            : [def.dimension])[0],
          filterMode: def.filter_mode || 'drop'
        });
    return runSingleMetricBreakdown({
      ...def,
      base_metric: metric,
      base_metrics: undefined,
      output_key: outputKey
    }, context);
  }));

  const failedResult = metricResults.find((result) => result.status !== 'pass');
  if (failedResult) return failedResult;

  const combinedMetrics = Object.assign({}, ...metricResults.map((result) => result.delta?.metrics || {}));
  const combinedBreakdowns = Object.assign({}, ...metricResults.map((result) => result.delta?.breakdowns || {}));

  // A combined payment report is a single ranked list (Top K total), with all
  // payment modes shown on each row. Per-metric outputs remain available too.
  const primaryDimension = (Array.isArray(def.dimensions) && def.dimensions.length
    ? def.dimensions
    : [def.dimension])[0];
  const combinedOutputKey = customOutputKey || primaryDimension;
  const combinedCandidates = selectedMetrics.flatMap((metric, index) =>
    Object.values(metricResults[index].delta?.breakdowns || {})
      .flatMap((entries) => Array.isArray(entries) ? entries : [])
  );
  const isPaymentMetricSelection = selectedMetrics.every((metric) => PAYMENT_ORDER_METRICS.has(metric));
  const combinedEvidence = selectCombinedEvidence(combinedCandidates, {
    rankBy: def.rank_by || 'delta',
    rankOrder: def.rank_order || 'desc',
    topK: def.stop_conditions?.top_k ?? 1
  });

  if (combinedOutputKey) {
    if (isPaymentMetricSelection) {
      combinedMetrics[combinedOutputKey] = formatBaselineList(combinedEvidence, {
        rankBy: def.rank_by || 'delta',
        baseMetric: selectedMetrics[0],
        outputKey: combinedOutputKey,
        filterMode: def.filter_mode || 'all'
      });
    } else {
      combinedMetrics[combinedOutputKey] = selectedMetrics.map((metric) => {
        const metricLabel = metric === 'cod_orders' ? 'COD'
          : metric === 'ppcod_orders' ? 'PPCOD'
            : metric === 'prepaid_orders' ? 'Prepaid'
              : metric;
        const metricKey = customOutputKey ? `${customOutputKey}_${metric}` : null;
        const metricText = metricKey ? combinedMetrics[metricKey] : null;
        return metricText ? `${metricLabel}:\n${metricText}` : '';
      }).filter(Boolean).join('\n\n') || 'none';
    }
    combinedBreakdowns[combinedOutputKey] = combinedEvidence;
  }

  return {
    status: 'pass',
    delta: {
      metrics: combinedMetrics,
      breakdowns: combinedBreakdowns
    },
    next: def.next
  };
}

async function runSingleMetricBreakdown(def, context) {
  const {
    dimension,
    dimensions = [],
    base_metric = 'cvr',
    include_orders,
    stop_conditions = {},
    rank_by = 'delta',
    rank_order = 'desc',
    filter_mode = 'drop',
    min_sessions_mode = 'both_low',
    input_scope = 'global',
    input_key,
    output_key,
    next
  } = def;
  const debugEnabled = String(process.env.DEBUG_RECURSIVE_BREAKDOWN || '').toLowerCase() === 'true';
  const debugPrefix = `[recursive-breakdown:${def.id || 'unknown'}]`;
  const debugLog = (...args) => {
    if (debugEnabled) console.log(debugPrefix, ...args);
  };

  const {
    max_depth = 1,
    min_sessions = 0,
    min_current_sessions = min_sessions,
    min_baseline_sessions = min_sessions,
    min_impact_pct = 0,
    top_k = 1          // <--- ranking control (default MVP = 1)
  } = stop_conditions;

  const {
    meta,
    metrics,
    filters = [],
    breakdowns = {},
    scratch = {}
  } = context;

  const dimensionList = Array.isArray(dimensions) && dimensions.length
    ? dimensions
    : [dimension];
  const primaryDimension = dimensionList[0];
  const resolvedOutputKey = normalizeOutputKey(output_key)
    || buildDefaultBreakdownOutputKey({
      baseMetric: base_metric,
      dimension: primaryDimension,
      filterMode: filter_mode
    });

  if (!dimensionList[0] || typeof dimensionList[0] !== 'string') {
    return {
      status: 'fail',
      reason: 'RecursiveDimensionBreakdownNode: dimension is missing or invalid'
    };
  }

  if (!metrics || (base_metric === 'cvr' && metrics.cvr_delta_pct == null)) {
    debugLog('required global metrics missing', { base_metric });
    return {
      status: 'fail',
      reason: 'RecursiveDimensionBreakdownNode: global metrics missing'
    };
  }

  const evidence = [];
  const inheritedFilters = resolveInheritedFilters({
    inputScope: input_scope,
    inputKey: normalizeOutputKey(input_key),
    breakdowns,
    scratch
  });

  if (input_scope === 'breakdown' && inheritedFilters.error) {
    return {
      status: 'fail',
      reason: inheritedFilters.error
    };
  }

  /**
   * Internal recursive function
   * Recursion axis: filters + depth
   */
  async function recurse(activeFilters, depth, ancestry = []) {
    if (depth >= max_depth) return;
    if (depth >= dimensionList.length) return;

    const activeDimension = dimensionList[depth];

    const isPaymentOrderMetric = PAYMENT_ORDER_METRICS.has(base_metric);
    const needsOrders = base_metric === 'orders' || base_metric === 'cvr' || isPaymentOrderMetric;
    const includeOrders = include_orders ?? needsOrders;
    const includePaymentOrders = isPaymentOrderMetric;

    const scopedFilters = mergeFilters(activeFilters, inheritedFilters.filters || []);

    const querySpec = queryBuilder.buildDimensionBreakdownQuery({
      tenantId: meta.tenantId,
      dimension: activeDimension,
      window: meta.window,
      baselineWindow: meta.baselineWindow,
      timezone: meta.timezone,
      filters: scopedFilters,
      includeOrders,
      includePaymentOrders
    });

    const result = await queryExecutor.execute(querySpec);
    debugLog('query executed', {
      depth,
      dimension: activeDimension,
      filters: activeFilters,
      scopedFilters,
      rowCount: result?.rows?.length || 0
    });
    if (!result?.rows?.length) return;

    const candidates = [];
    const dropCounts = {
      minSessions: 0,
      cvrUnavailable: 0,
      atcUnavailable: 0,
      filterModeDrop: 0,
      filterModeIncrease: 0,
      baselineCvrRequired: 0
    };
    let totalBaselineSessions = 0;
    let totalCurrentSessions = 0;
    let totalBaselineOrders = 0;
    let totalCurrentOrders = 0;
    let totalBaselinePaymentOrders = 0;
    let totalCurrentPaymentOrders = 0;

    for (const row of result.rows) {
      const { baseline_sessions, current_sessions } = row;
      if (baseline_sessions > 0) {
        totalBaselineSessions += baseline_sessions;
      }
      if (current_sessions > 0) {
        totalCurrentSessions += current_sessions;
      }

      const { baseline_orders, current_orders } = row;
      if (baseline_orders > 0) {
        totalBaselineOrders += baseline_orders;
      }
      if (current_orders > 0) {
        totalCurrentOrders += current_orders;
      }

      if (isPaymentOrderMetric) {
        const baselinePaymentOrders = Number(row[`baseline_${base_metric}`] || 0);
        const currentPaymentOrders = Number(row[`current_${base_metric}`] || 0);
        totalBaselinePaymentOrders += baselinePaymentOrders;
        totalCurrentPaymentOrders += currentPaymentOrders;
      }
    }

    if (isPaymentOrderMetric) {
      if (totalBaselinePaymentOrders === 0 && totalCurrentPaymentOrders === 0) return;
    } else if (totalBaselineSessions === 0 && totalCurrentSessions === 0) {
      return;
    }

    // ---------- Phase 1: collect candidates ----------
    for (const row of result.rows) {
      const {
        dimension_value,
        product_title,
        current_orders,
        baseline_orders,
        current_sessions,
        baseline_sessions,
        current_atc_sessions,
        baseline_atc_sessions,
        current_cod_orders = 0,
        baseline_cod_orders = 0,
        current_ppcod_orders = 0,
        baseline_ppcod_orders = 0,
        current_prepaid_orders = 0,
        baseline_prepaid_orders = 0
      } = row;

      const paymentOrders = {
        cod_orders: {
          current: Number(current_cod_orders),
          baseline: Number(baseline_cod_orders)
        },
        ppcod_orders: {
          current: Number(current_ppcod_orders),
          baseline: Number(baseline_ppcod_orders)
        },
        prepaid_orders: {
          current: Number(current_prepaid_orders),
          baseline: Number(baseline_prepaid_orders)
        }
      };

      const currentLow = current_sessions < min_current_sessions;
      const baselineLow = baseline_sessions < min_baseline_sessions;
      if (min_sessions_mode === 'baseline_only') {
        if (baselineLow) {
          dropCounts.minSessions += 1;
          continue;
        }
      } else if (min_sessions_mode === 'either_low') {
        if (currentLow || baselineLow) {
          dropCounts.minSessions += 1;
          continue;
        }
      } else {
        if (currentLow && baselineLow) {
          dropCounts.minSessions += 1;
          continue;
        }
      }

      const current_cvr =
        current_sessions === 0 ? null : current_orders / current_sessions;

      const baseline_cvr_calc =
        baseline_sessions === 0
          ? null
          : baseline_orders / baseline_sessions;

      const baseline_cvr =
        baseline_sessions === 0
          ? metrics.baseline_cvr
          : baseline_orders / baseline_sessions;

      const current_atc_rate =
        current_sessions === 0 ? null : current_atc_sessions / current_sessions;

      const baseline_atc_rate =
        baseline_sessions === 0
          ? (metrics.baseline_atc_rate || null)
          : baseline_atc_sessions / baseline_sessions;

      // Validation should depend on the metric we are analyzing.
      // Sessions/order breakdowns do not require a valid CVR to be considered.
      const isAtcMetric = (base_metric === 'atc_rate');
      const isCvrMetric = (base_metric === 'cvr');
      if (isCvrMetric && (current_cvr == null || baseline_cvr == null)) {
        dropCounts.cvrUnavailable += 1;
        continue;
      }
      if (isCvrMetric && baseline_cvr === 0) {
        dropCounts.baselineCvrRequired += 1;
        continue;
      }
      if (isAtcMetric && (current_atc_rate == null || baseline_atc_rate == null)) {
        dropCounts.atcUnavailable += 1;
        continue;
      }
      if (isAtcMetric && baseline_atc_rate === 0) {
        dropCounts.atcUnavailable += 1;
        continue;
      }

      const cvr_delta_pct =
        (baseline_cvr == null || baseline_cvr === 0)
          ? null
          : ((current_cvr - baseline_cvr) / baseline_cvr) * 100;

      const atc_rate_delta_pct =
        (baseline_atc_rate == null || baseline_atc_rate === 0)
          ? null
          : ((current_atc_rate - baseline_atc_rate) / baseline_atc_rate) * 100;

      const atc_sessions_delta_pct =
        baseline_atc_sessions === 0
          ? null
          : ((current_atc_sessions - baseline_atc_sessions) / baseline_atc_sessions) * 100;

      if (rank_by === 'baseline_cvr' && baseline_cvr_calc == null) {
        dropCounts.baselineCvrRequired += 1;
        continue;
      }

      const orders_delta_pct =
        baseline_orders === 0
          ? null
          : ((current_orders - baseline_orders) / baseline_orders) * 100;

      const sessions_delta_pct =
        baseline_sessions === 0
          ? null
          : ((current_sessions - baseline_sessions) / baseline_sessions) * 100;

      const paymentOrderDeltas = Object.fromEntries(
        Object.entries(paymentOrders).map(([metric, values]) => [
          `${metric}_delta_pct`,
          values.baseline === 0 ? null : ((values.current - values.baseline) / values.baseline) * 100
        ])
      );

      const directionalDeltaPct = (
        isPaymentOrderMetric ? paymentOrderDeltas[`${base_metric}_delta_pct`]
          : base_metric === 'sessions' ? sessions_delta_pct
          : base_metric === 'orders' ? orders_delta_pct
            : base_metric === 'atc_rate' ? atc_rate_delta_pct
              : base_metric === 'atc_sessions' ? atc_sessions_delta_pct
                : cvr_delta_pct
      );

      if (filter_mode === 'drop') {
        if (directionalDeltaPct == null || directionalDeltaPct >= 0) {
          dropCounts.filterModeDrop += 1;
          continue;
        }
      }

      if (filter_mode === 'increase') {
        if (directionalDeltaPct == null || directionalDeltaPct <= 0) {
          dropCounts.filterModeIncrease += 1;
          continue;
        }
      }

      const baselineShare =
        totalBaselineSessions === 0 ? 0 : baseline_sessions / totalBaselineSessions;
      const currentShare =
        totalCurrentSessions === 0 ? 0 : current_sessions / totalCurrentSessions;
      const sessionShare = Math.max(baselineShare, currentShare);

      const baselineOrderShare =
        totalBaselineOrders === 0 ? 0 : baseline_orders / totalBaselineOrders;
      const currentOrderShare =
        totalCurrentOrders === 0 ? 0 : current_orders / totalCurrentOrders;
      const orderShare = Math.max(baselineOrderShare, currentOrderShare);

      const selectedPaymentOrders = paymentOrders[base_metric];
      const baselinePaymentShare = isPaymentOrderMetric && totalBaselinePaymentOrders > 0
        ? selectedPaymentOrders.baseline / totalBaselinePaymentOrders
        : 0;
      const currentPaymentShare = isPaymentOrderMetric && totalCurrentPaymentOrders > 0
        ? selectedPaymentOrders.current / totalCurrentPaymentOrders
        : 0;
      const paymentOrderShare = Math.max(baselinePaymentShare, currentPaymentShare);

      const displayValue =
        activeDimension === 'product_id' && product_title
          ? product_title
          : dimension_value;

      const currentPath = [
        ...ancestry,
        {
          dimension: activeDimension,
          value: dimension_value,
          display_value: displayValue
        }
      ];

      candidates.push({
        dimension: activeDimension,
        value: dimension_value,
        display_value: displayValue,
        depth,
        ancestry: ancestry.map((item) => ({ ...item })),
        parent: ancestry.length ? { ...ancestry[ancestry.length - 1] } : null,
        path: currentPath,
        current: {
          orders: current_orders,
          ...Object.fromEntries(Object.entries(paymentOrders).map(([metric, values]) => [metric, values.current])),
          sessions: current_sessions,
          atc_sessions: current_atc_sessions,
          cvr: current_cvr,
          atc_rate: current_atc_rate
        },
        baseline: {
          orders: baseline_orders,
          ...Object.fromEntries(Object.entries(paymentOrders).map(([metric, values]) => [metric, values.baseline])),
          sessions: baseline_sessions,
          atc_sessions: baseline_atc_sessions,
          cvr: baseline_cvr_calc ?? baseline_cvr,
          atc_rate: baseline_atc_rate
        },
        deltas: {
          cvr_delta_pct,
          atc_rate_delta_pct,
          atc_sessions_delta_pct,
          orders_delta_pct,
          sessions_delta_pct,
          ...paymentOrderDeltas
        },
        sessionShare,
        orderShare,
        baselineSessionShare: baselineShare,
        baselineOrderShare,
        baselinePaymentShare,
        paymentOrderShare,
        base_metric
      });
    }

    debugLog('candidate filtering result', {
      depth,
      dimension: activeDimension,
      candidateCount: candidates.length,
      dropCounts
    });
    if (!candidates.length) return;

    const filteredCandidates = candidates;

    // ---------- Phase 2: rank ----------
    const scoreFor = (entry) => {
      const baselineSessionShare = entry.baselineSessionShare ?? 0;
      const baselineOrderShare = entry.baselineOrderShare ?? 0;

      if (rank_by === 'baseline_cvr') {
        const pct = entry.baseline?.cvr;
        return pct == null ? -Infinity : Math.abs(pct) * baselineSessionShare;
      }
      if (rank_by === 'baseline_sessions') {
        return baselineSessionShare || 0;
      }
      if (rank_by === 'baseline_orders') {
        return baselineOrderShare || 0;
      }

      const metric = entry.base_metric || base_metric || 'cvr';
      if (PAYMENT_ORDER_METRICS.has(metric)) {
        const pct = entry.deltas[`${metric}_delta_pct`];
        return pct == null ? -Infinity : Math.abs(pct) * (entry.paymentOrderShare || 0);
      }
      if (metric === 'orders') {
        const pct = entry.deltas.orders_delta_pct;
        return pct == null ? -Infinity : Math.abs(pct) * baselineOrderShare;
      }
      if (metric === 'sessions') {
        const pct = entry.deltas.sessions_delta_pct;
        return pct == null ? -Infinity : Math.abs(pct) * baselineSessionShare;
      }
      if (metric === 'atc_rate') {
        const pct = entry.deltas.atc_rate_delta_pct;
        return pct == null ? -Infinity : Math.abs(pct) * baselineSessionShare;
      }
      // default cvr
      const pct = entry.deltas.cvr_delta_pct;
      return pct == null ? -Infinity : Math.abs(pct) * baselineSessionShare;
    };

    filteredCandidates.sort((a, b) => {
      const aScore = scoreFor(a);
      const bScore = scoreFor(b);
      return rank_order === 'asc' ? aScore - bScore : bScore - aScore;
    });

    const topCandidates = filteredCandidates.slice(0, top_k);
    debugLog('ranking result', {
      depth,
      dimension: activeDimension,
      topK: top_k,
      selectedCount: topCandidates.length
    });

    // ---------- Phase 3: store evidence + recurse ----------
    for (const entry of topCandidates) {
      evidence.push(entry);

      await recurse(
        [...activeFilters, { dimension: activeDimension, value: entry.value }],
        depth + 1,
        entry.path || ancestry
      );
    }
  }

  // Kick off recursion
  await recurse(filters, 0, []);

  const mergedEvidenceMap = new Map();
  for (const entry of evidence) {
    const key = JSON.stringify({
      dimension: entry.dimension,
      value: entry.value,
      depth: entry.depth,
      path: Array.isArray(entry.path)
        ? entry.path.map((item) => [item.dimension, item.value])
        : []
    });
    const existing = mergedEvidenceMap.get(key);
    if (!existing || entry.sessionShare > existing.sessionShare) {
      mergedEvidenceMap.set(key, entry);
    }
  }

  const mergedEvidence = Array.from(mergedEvidenceMap.values());

  const scoreForEntry = (entry) => {
    const baselineSessionShare = entry.baselineSessionShare ?? 0;
    const baselineOrderShare = entry.baselineOrderShare ?? 0;

    if (rank_by === 'baseline_cvr') {
      const pct = entry.baseline?.cvr;
      return pct == null ? -Infinity : Math.abs(pct) * baselineSessionShare;
    }
    if (rank_by === 'baseline_sessions') {
      return baselineSessionShare || 0;
    }
    if (rank_by === 'baseline_orders') {
      return baselineOrderShare || 0;
    }

    const metric = entry.base_metric || base_metric || 'cvr';
    if (PAYMENT_ORDER_METRICS.has(metric)) {
      const pct = entry.deltas?.[`${metric}_delta_pct`];
      return pct == null ? -Infinity : Math.abs(pct) * (entry.paymentOrderShare || 0);
    }
    if (metric === 'orders') {
      const pct = entry.deltas?.orders_delta_pct;
      return pct == null ? -Infinity : Math.abs(pct) * baselineOrderShare;
    }
    if (metric === 'sessions') {
      const pct = entry.deltas?.sessions_delta_pct;
      return pct == null ? -Infinity : Math.abs(pct) * baselineSessionShare;
    }
    if (metric === 'atc_rate') {
      const pct = entry.deltas?.atc_rate_delta_pct;
      return pct == null ? -Infinity : Math.abs(pct) * baselineSessionShare;
    }
    const pct = entry.deltas?.cvr_delta_pct;
    return pct == null ? -Infinity : Math.abs(pct) * baselineSessionShare;
  };

  const rankedEvidence = [...mergedEvidence].sort((a, b) => {
    const aScore = scoreForEntry(a);
    const bScore = scoreForEntry(b);
    return rank_order === 'asc' ? aScore - bScore : bScore - aScore;
  });
  const topEvidence = rankedEvidence[0] || null;
  debugLog('final evidence summary', {
    mergedEvidenceCount: mergedEvidence.length,
    rankedEvidenceCount: rankedEvidence.length,
    hasTopEvidence: Boolean(topEvidence)
  });

  const outputMetrics = topEvidence
    ? {
        top_dimension: topEvidence.dimension,
        top_value: topEvidence.value,
        top_display_value: topEvidence.display_value ?? topEvidence.value,
        top_sessions_delta_pct: topEvidence.deltas?.sessions_delta_pct,
        top_orders_delta_pct: topEvidence.deltas?.orders_delta_pct,
        top_cod_orders_delta_pct: topEvidence.deltas?.cod_orders_delta_pct,
        top_ppcod_orders_delta_pct: topEvidence.deltas?.ppcod_orders_delta_pct,
        top_prepaid_orders_delta_pct: topEvidence.deltas?.prepaid_orders_delta_pct,
        top_cvr_delta_pct: topEvidence.deltas?.cvr_delta_pct,
        top_atc_rate_delta_pct: topEvidence.deltas?.atc_rate_delta_pct,
        top_atc_sessions_delta_pct: topEvidence.deltas?.atc_sessions_delta_pct,
        top_current_sessions: topEvidence.current?.sessions,
        top_baseline_sessions: topEvidence.baseline?.sessions,
        top_current_orders: topEvidence.current?.orders,
        top_baseline_orders: topEvidence.baseline?.orders,
        top_current_cod_orders: topEvidence.current?.cod_orders,
        top_baseline_cod_orders: topEvidence.baseline?.cod_orders,
        top_current_ppcod_orders: topEvidence.current?.ppcod_orders,
        top_baseline_ppcod_orders: topEvidence.baseline?.ppcod_orders,
        top_current_prepaid_orders: topEvidence.current?.prepaid_orders,
        top_baseline_prepaid_orders: topEvidence.baseline?.prepaid_orders,
        top_current_atc_sessions: topEvidence.current?.atc_sessions,
        top_baseline_atc_sessions: topEvidence.baseline?.atc_sessions,
        top_current_atc_rate: topEvidence.current?.atc_rate,
        top_baseline_atc_rate: topEvidence.baseline?.atc_rate
      }
    : {};

  outputMetrics[resolvedOutputKey] = formatBaselineList(rankedEvidence, {
    rankBy: rank_by,
    baseMetric: base_metric,
    outputKey: resolvedOutputKey,
    filterMode: filter_mode
  });

  // Preserve legacy behavior for workflows that still read dimension keys directly.
  if (!output_key && primaryDimension && primaryDimension !== resolvedOutputKey) {
    outputMetrics[primaryDimension] = outputMetrics[resolvedOutputKey];
  }

  const breakdownDelta = {
    [resolvedOutputKey]: rankedEvidence
  };
  if (!output_key && primaryDimension && primaryDimension !== resolvedOutputKey) {
    breakdownDelta[primaryDimension] = rankedEvidence;
  }

  return {
    status: 'pass',
    delta: {
      metrics: outputMetrics,
      breakdowns: breakdownDelta
    },
    next
  };
}

module.exports = RecursiveDimensionBreakdownNode;

function selectCombinedEvidence(entries, { rankBy = 'delta', rankOrder = 'desc', topK = 1 } = {}) {
  const scoreFor = (entry) => {
    const baselineSessionShare = entry.baselineSessionShare ?? 0;
    const baselineOrderShare = entry.baselineOrderShare ?? 0;

    if (rankBy === 'baseline_cvr') {
      const value = entry.baseline?.cvr;
      return value == null ? -Infinity : Math.abs(value) * baselineSessionShare;
    }
    if (rankBy === 'baseline_sessions') return baselineSessionShare;
    if (rankBy === 'baseline_orders') return baselineOrderShare;

    const metric = entry.base_metric || 'cvr';
    if (PAYMENT_ORDER_METRICS.has(metric)) {
      const value = entry.deltas?.[`${metric}_delta_pct`];
      return value == null ? -Infinity : Math.abs(value) * (entry.paymentOrderShare || 0);
    }
    if (metric === 'orders') {
      const value = entry.deltas?.orders_delta_pct;
      return value == null ? -Infinity : Math.abs(value) * baselineOrderShare;
    }
    if (metric === 'sessions') {
      const value = entry.deltas?.sessions_delta_pct;
      return value == null ? -Infinity : Math.abs(value) * baselineSessionShare;
    }
    if (metric === 'atc_rate') {
      const value = entry.deltas?.atc_rate_delta_pct;
      return value == null ? -Infinity : Math.abs(value) * baselineSessionShare;
    }
    if (metric === 'atc_sessions') {
      const value = entry.deltas?.atc_sessions_delta_pct;
      return value == null ? -Infinity : Math.abs(value) * baselineSessionShare;
    }
    const value = entry.deltas?.cvr_delta_pct;
    return value == null ? -Infinity : Math.abs(value) * baselineSessionShare;
  };

  const unique = new Map();
  for (const entry of entries) {
    const key = JSON.stringify({
      dimension: entry.dimension,
      value: entry.value,
      path: Array.isArray(entry.path) ? entry.path.map(({ dimension, value }) => [dimension, value]) : []
    });
    const existing = unique.get(key);
    const score = scoreFor(entry);
    const existingScore = existing ? scoreFor(existing) : null;
    const isBetter = !existing || (rankOrder === 'asc' ? score < existingScore : score > existingScore);
    if (isBetter) unique.set(key, entry);
  }

  const ranked = [...unique.values()].sort((a, b) => {
    const difference = scoreFor(a) - scoreFor(b);
    return rankOrder === 'asc' ? difference : -difference;
  });
  const parsedTopK = Number.parseInt(topK, 10);
  return ranked.slice(0, Number.isFinite(parsedTopK) && parsedTopK > 0 ? parsedTopK : 1);
}

function formatBaselineList(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return 'none';

  const {
    rankBy = 'delta',
    baseMetric = 'cvr',
    outputKey = '',
    filterMode = 'all'
  } = options;
  const mode = detectOutputKeyMode(baseMetric, outputKey);
  const directionLabel = filterMode === 'drop'
    ? 'drop'
    : filterMode === 'increase'
      ? 'increase'
      : 'change';

  return entries.map((entry, idx) => {
    const label = entry.display_value ?? entry.value;

    const baselineCvrValue = entry.baseline?.cvr;
    const currentCvrValue = entry.current?.cvr;
    const baselineCvr = baselineCvrValue == null ? 'unknown' : formatPct(baselineCvrValue * 100);
    const currentCvr = currentCvrValue == null ? 'unknown' : formatPct(currentCvrValue * 100);

    const baselineSessions = entry.baseline?.sessions ?? 0;
    const currentSessions = entry.current?.sessions ?? 0;
    const baselineOrders = entry.baseline?.orders ?? 0;
    const currentOrders = entry.current?.orders ?? 0;
    const baselineAtcSessions = entry.baseline?.atc_sessions ?? 0;
    const currentAtcSessions = entry.current?.atc_sessions ?? 0;
    const baselineAtcRateValue = entry.baseline?.atc_rate;
    const currentAtcRateValue = entry.current?.atc_rate;
    const baselineAtcRate = baselineAtcRateValue == null ? 'unknown' : formatPct(baselineAtcRateValue * 100);
    const currentAtcRate = currentAtcRateValue == null ? 'unknown' : formatPct(currentAtcRateValue * 100);

    const cvrDelta = formatPct(entry.deltas?.cvr_delta_pct);
    const atcRateDelta = formatPct(entry.deltas?.atc_rate_delta_pct);
    const atcSessionsDelta = formatPct(entry.deltas?.atc_sessions_delta_pct);
    const sessionsDelta = formatPct(entry.deltas?.sessions_delta_pct);
    const ordersDelta = formatPct(entry.deltas?.orders_delta_pct);

    const showSessionsOnly = rankBy === 'baseline_sessions' || baseMetric === 'sessions';
    const showOrdersOnly = rankBy === 'baseline_orders' || baseMetric === 'orders';

    const parts = [`${idx + 1}. ${label}`];

    if (PAYMENT_ORDER_METRICS.has(mode)) {
      for (const [metric, label] of [
        ['cod_orders', 'COD'],
        ['ppcod_orders', 'PPCOD'],
        ['prepaid_orders', 'Prepaid']
      ]) {
        const baselinePaymentOrders = entry.baseline?.[metric] ?? 0;
        const currentPaymentOrders = entry.current?.[metric] ?? 0;
        const paymentDelta = entry.deltas?.[`${metric}_delta_pct`];
        const paymentDirection = paymentDelta == null
          ? 'change'
          : paymentDelta < 0
            ? 'drop'
            : paymentDelta > 0
              ? 'increase'
              : 'no change';
        parts.push(
          `${label} orders ${baselinePaymentOrders} -> ${currentPaymentOrders} (${paymentDirection} ${formatPct(paymentDelta)})`
        );
      }
      return parts.join(' | ');
    }

    if (mode === 'atc_rate') {
      parts.push(`ATC rate ${baselineAtcRate} -> ${currentAtcRate} (${directionLabel} ${atcRateDelta})`);
      parts.push(`ATC sessions ${baselineAtcSessions} -> ${currentAtcSessions} (${atcSessionsDelta})`);
      parts.push(`sessions ${baselineSessions} -> ${currentSessions} (${sessionsDelta})`);
      return parts.join(' | ');
    }

    if (mode === 'atc_sessions') {
      parts.push(`ATC sessions ${baselineAtcSessions} -> ${currentAtcSessions} (${directionLabel} ${atcSessionsDelta})`);
      parts.push(`ATC rate ${baselineAtcRate} -> ${currentAtcRate} (${atcRateDelta})`);
      parts.push(`sessions ${baselineSessions} -> ${currentSessions} (${sessionsDelta})`);
      return parts.join(' | ');
    }

    if (mode === 'orders') {
      parts.push(`orders ${baselineOrders} -> ${currentOrders} (${directionLabel} ${ordersDelta})`);
      parts.push(`sessions ${baselineSessions} -> ${currentSessions} (${sessionsDelta})`);
      parts.push(`CVR ${baselineCvr} -> ${currentCvr} (${cvrDelta})`);
      return parts.join(' | ');
    }

    if (mode === 'sessions') {
      parts.push(`sessions ${baselineSessions} -> ${currentSessions} (${directionLabel} ${sessionsDelta})`);
      parts.push(`orders ${baselineOrders} -> ${currentOrders} (${ordersDelta})`);
      parts.push(`CVR ${baselineCvr} -> ${currentCvr} (${cvrDelta})`);
      return parts.join(' | ');
    }

    // Default/cvr mode
    parts.push(`CVR ${baselineCvr} -> ${currentCvr} (${directionLabel} ${cvrDelta})`);

    if (showOrdersOnly) {
      parts.push(`orders ${baselineOrders} -> ${currentOrders} (${ordersDelta})`);
    } else if (showSessionsOnly) {
      parts.push(`sessions ${baselineSessions} -> ${currentSessions} (${sessionsDelta})`);
    } else {
      parts.push(`sessions ${baselineSessions} -> ${currentSessions} (${sessionsDelta})`);
      parts.push(`orders ${baselineOrders} -> ${currentOrders} (${ordersDelta})`);
    }

    return parts.join(' | ');
  }).join('\n');
}

function resolveInheritedFilters({ inputScope, inputKey, breakdowns = {}, scratch = {} }) {
  if (inputScope !== 'breakdown') {
    return { filters: [] };
  }

  if (!inputKey) {
    return { error: 'RecursiveDimensionBreakdownNode: input breakdown key is required' };
  }

  const entries = Array.isArray(breakdowns?.[inputKey]) ? breakdowns[inputKey] : [];

  if (!entries.length) {
    return {
      error: `RecursiveDimensionBreakdownNode: input breakdown '${inputKey}' not found or empty`
    };
  }

  const filter = breakdownEntriesToFilter(entries);
  if (!filter) {
    return {
      error: `RecursiveDimensionBreakdownNode: input breakdown '${inputKey}' cannot be converted into a filter`
    };
  }

  return { filters: [filter] };
}

function breakdownEntriesToFilter(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  const first = entries[0];
  if (!first?.dimension) {
    return null;
  }

  const dimension = first.dimension;
  const values = Array.from(new Set(entries
    .filter((entry) => entry?.dimension === dimension && entry?.value != null && entry.value !== '')
    .map((entry) => entry.value)));

  if (!values.length) {
    return null;
  }

  return {
    dimension,
    operator: '=',
    value: values.length === 1 ? values[0] : values
  };
}

function mergeFilters(baseFilters = [], inheritedFilters = []) {
  const merged = [];
  const seen = new Set();

  [...baseFilters, ...inheritedFilters].forEach((filter) => {
    if (!filter || !filter.dimension) return;
    const key = JSON.stringify([
      filter.dimension,
      filter.operator || '=',
      filter.value
    ]);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(filter);
  });

  return merged;
}

function formatPct(value) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) {
    return 'unknown';
  }
  return `${Number(value).toFixed(2)}%`;
}

function normalizeOutputKey(key) {
  if (typeof key !== 'string') return '';
  return key.trim();
}
