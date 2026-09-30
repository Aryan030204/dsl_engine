const INSIGHT_TOP_TOKEN_COUNT = 4;

const INSIGHT_TOP_TOKEN_SUFFIXES = [
  'dimension',
  'dimension_label',
  'value',
  'parent_dimension',
  'parent_dimension_label',
  'parent_value',
  'path',
  'path_labels',
  'cvr_delta_pct_fmt',
  'atc_rate_delta_pct_fmt',
  'sessions_delta_pct',
  'sessions_delta_pct_fmt',
  'orders_delta_pct',
  'orders_delta_pct_fmt',
  'cod_orders_delta_pct',
  'cod_orders_delta_pct_fmt',
  'ppcod_orders_delta_pct',
  'ppcod_orders_delta_pct_fmt',
  'prepaid_orders_delta_pct',
  'prepaid_orders_delta_pct_fmt',
  'current_cod_orders',
  'baseline_cod_orders',
  'current_ppcod_orders',
  'baseline_ppcod_orders',
  'current_prepaid_orders',
  'baseline_prepaid_orders',
];

const DIMENSION_LABELS = {
  product_id: 'Product',
  utm_source: 'UTM Source',
  utm_medium: 'UTM Medium',
  utm_campaign: 'UTM Campaign',
  utm_content: 'UTM Content',
  utm_term: 'UTM Term',
  landing_page_path: 'Landing Page',
  landing_page_type: 'Landing Page Type',
  referrer_name: 'Referrer',
};

module.exports = {
  INSIGHT_TOP_TOKEN_COUNT,
  INSIGHT_TOP_TOKEN_SUFFIXES,
  DIMENSION_LABELS,
};
