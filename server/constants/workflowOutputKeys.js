const REQUIRED_OUTPUT_KEYS = [
  'orders_product_drops',
  'atc_rate_product_drops',
  'sessions_product_drops',
  'cvr_product_drops',
];

const OPTIONAL_OUTPUT_KEYS = [
  'baseline_top5_pages',
  'baseline_bottom5_pages',
  'top_pages',
  'bottom_pages',
  'top_segments',
  'bottom_segments',
];

const OUTPUT_KEY_SUGGESTIONS = [
  ...REQUIRED_OUTPUT_KEYS,
  ...OPTIONAL_OUTPUT_KEYS,
];
const PAYMENT_ORDER_METRICS = new Set(['cod_orders', 'ppcod_orders', 'prepaid_orders']);

function sanitizeOutputKeySegment(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'key';
}

function buildDefaultBreakdownOutputKey({ baseMetric, dimension, filterMode }) {
  const metricPart = sanitizeOutputKeySegment(baseMetric || 'cvr');
  const dimensionPart = sanitizeOutputKeySegment(dimension || 'dimension');
  let direction = 'all';
  if (filterMode === 'drop') direction = 'drops';
  else if (filterMode === 'increase') direction = 'increases';
  return `${metricPart}_${dimensionPart}_${direction}`;
}

function detectOutputKeyMode(baseMetric, outputKey) {
  const key = String(outputKey || '').toLowerCase();
  if (PAYMENT_ORDER_METRICS.has(baseMetric)) return baseMetric;
  if (baseMetric === 'atc_rate' || key.includes('atc_rate')) return 'atc_rate';
  if (baseMetric === 'atc_sessions' || key.includes('atc_sessions')) return 'atc_sessions';
  if (baseMetric === 'orders' || key.includes('orders')) return 'orders';
  if (baseMetric === 'sessions' || key.includes('sessions')) return 'sessions';
  return 'cvr';
}

module.exports = {
  REQUIRED_OUTPUT_KEYS,
  OPTIONAL_OUTPUT_KEYS,
  OUTPUT_KEY_SUGGESTIONS,
  sanitizeOutputKeySegment,
  buildDefaultBreakdownOutputKey,
  detectOutputKeyMode,
};
