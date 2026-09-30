const {
  INSIGHT_TOP_TOKEN_COUNT,
  INSIGHT_TOP_TOKEN_SUFFIXES,
  DIMENSION_LABELS,
} = require('../constants/insightTokens');

function computeEvidenceScore(entry) {
  const metric = entry.base_metric || 'cvr';

  if (metric === 'orders') {
    const pct = entry.deltas?.orders_delta_pct;
    const share = entry.orderShare ?? entry.sessionShare ?? 0;
    return pct == null ? -Infinity : Math.abs(pct) * share;
  }

  if (metric === 'cod_orders' || metric === 'ppcod_orders' || metric === 'prepaid_orders') {
    const pct = entry.deltas?.[`${metric}_delta_pct`];
    const share = entry.paymentOrderShare ?? entry.orderShare ?? 0;
    return pct == null ? -Infinity : Math.abs(pct) * share;
  }

  if (metric === 'sessions') {
    const pct = entry.deltas?.sessions_delta_pct;
    return pct == null ? -Infinity : Math.abs(pct);
  }

  if (metric === 'atc_rate') {
    const pct = entry.deltas?.atc_rate_delta_pct;
    const share = entry.sessionShare ?? 0;
    return pct == null ? -Infinity : Math.abs(pct) * share;
  }

  if (metric === 'atc_sessions') {
    const pct = entry.deltas?.atc_sessions_delta_pct;
    const share = entry.sessionShare ?? 0;
    return pct == null ? -Infinity : Math.abs(pct) * share;
  }

  const pct = entry.deltas?.cvr_delta_pct;
  const share = entry.sessionShare ?? 0;
  return pct == null ? -Infinity : Math.abs(pct) * share;
}

function buildTopEvidenceTokens(selected) {
  const tokens = {};
  const list = Array.isArray(selected) ? selected : [];

  for (let index = 0; index < INSIGHT_TOP_TOKEN_COUNT; index++) {
    const prefix = `top${index + 1}`;
    const entry = list[index];

    INSIGHT_TOP_TOKEN_SUFFIXES.forEach((suffix) => {
      const key = `${prefix}_${suffix}`;
      tokens[key] = resolveTopTokenValue(entry, suffix);
    });
  }

  return tokens;
}

function resolveTopTokenValue(entry, suffix) {
  switch (suffix) {
    case 'dimension':
      return entry?.dimension;
    case 'dimension_label':
      return formatDimensionLabel(entry?.dimension);
    case 'value':
      return formatDisplayValue(entry);
    case 'parent_dimension':
      return entry?.parent?.dimension;
    case 'parent_dimension_label':
      return formatDimensionLabel(entry?.parent?.dimension);
    case 'parent_value':
      return formatPathItemValue(entry?.parent);
    case 'path':
      return formatEvidencePath(entry);
    case 'path_labels':
      return formatEvidencePath(entry, { includeLabels: true });
    case 'cvr_delta_pct_fmt':
      return formatPct(entry?.deltas?.cvr_delta_pct);
    case 'atc_rate_delta_pct_fmt':
      return formatPct(entry?.deltas?.atc_rate_delta_pct);
    case 'sessions_delta_pct':
      return entry?.deltas?.sessions_delta_pct;
    case 'sessions_delta_pct_fmt':
      return formatPct(entry?.deltas?.sessions_delta_pct);
    case 'orders_delta_pct':
      return entry?.deltas?.orders_delta_pct;
    case 'orders_delta_pct_fmt':
      return formatPct(entry?.deltas?.orders_delta_pct);
    case 'cod_orders_delta_pct':
      return entry?.deltas?.cod_orders_delta_pct;
    case 'cod_orders_delta_pct_fmt':
      return formatPct(entry?.deltas?.cod_orders_delta_pct);
    case 'ppcod_orders_delta_pct':
      return entry?.deltas?.ppcod_orders_delta_pct;
    case 'ppcod_orders_delta_pct_fmt':
      return formatPct(entry?.deltas?.ppcod_orders_delta_pct);
    case 'prepaid_orders_delta_pct':
      return entry?.deltas?.prepaid_orders_delta_pct;
    case 'prepaid_orders_delta_pct_fmt':
      return formatPct(entry?.deltas?.prepaid_orders_delta_pct);
    case 'current_cod_orders':
      return entry?.current?.cod_orders;
    case 'baseline_cod_orders':
      return entry?.baseline?.cod_orders;
    case 'current_ppcod_orders':
      return entry?.current?.ppcod_orders;
    case 'baseline_ppcod_orders':
      return entry?.baseline?.ppcod_orders;
    case 'current_prepaid_orders':
      return entry?.current?.prepaid_orders;
    case 'baseline_prepaid_orders':
      return entry?.baseline?.prepaid_orders;
    default:
      return undefined;
  }
}

function formatPct(value) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) {
    return 'unknown';
  }
  return `${Number(value).toFixed(2)}%`;
}

function formatDisplayValue(entry) {
  if (!entry) return undefined;
  return entry.display_value ?? entry.value;
}

function formatPathItemValue(item) {
  if (!item) return undefined;
  return item.display_value ?? item.value;
}

function formatDimensionLabel(dimension) {
  if (!dimension) return undefined;
  return DIMENSION_LABELS[dimension] || dimension;
}

function formatEvidencePath(entry, options = {}) {
  const path = Array.isArray(entry?.path) ? entry.path : [];
  if (!path.length) return undefined;

  const includeLabels = options.includeLabels === true;
  return path.map((item) => {
    const value = formatPathItemValue(item);
    if (!includeLabels) return value;
    const label = formatDimensionLabel(item?.dimension);
    if (!label) return value;
    return `${label}: ${value}`;
  }).filter(Boolean).join(' -> ');
}

function makeEvidenceKey(entry) {
  if (!entry) return 'unknown';
  const dimension = entry.dimension || 'unknown_dimension';
  const value = entry.value ?? entry.display_value ?? 'unknown_value';
  const path = Array.isArray(entry.path)
    ? entry.path.map((item) => `${item.dimension || 'unknown'}=${String(item.value ?? item.display_value ?? 'unknown')}`).join('>')
    : '';
  return `${dimension}::${String(value)}::${path}`;
}

module.exports = {
  computeEvidenceScore,
  buildTopEvidenceTokens,
  formatPct,
  formatDisplayValue,
  formatDimensionLabel,
  formatEvidencePath,
  makeEvidenceKey,
};
