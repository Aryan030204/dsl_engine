// Building blocks for the report editor (Messaging / Email node, "Performance report" layout).
// The report reads any context path, so these only save typing: they fill in the paths the
// inventory breakdown node writes. Pure functions, unit tested with node --test.

// KPI cards have no upper limit. Tables are capped at four, matching the server validation.
export const MAX_REPORT_TABLES = 4;

export const DEFAULT_INVENTORY_OUTPUT_KEY = 'inventory_top_products';

// KPI cards for the counts an inventory-mode Dimension Breakdown node produces.
export function buildInventoryKpiCards() {
  return [
    { label: 'Critical Products', value: 'metrics.inventory_critical_products', format: 'integer', icon: 'metric' },
    { label: 'Low Stock', value: 'metrics.inventory_medium_products', format: 'integer', icon: 'metric' },
    { label: 'Healthy Products', value: 'metrics.inventory_healthy_products', format: 'integer', icon: 'metric' },
  ];
}

// The lowest-DOH product list the same node writes to breakdowns.<output key>_lowest_doh.
export function buildLowestDohTable(outputKey = DEFAULT_INVENTORY_OUTPUT_KEY) {
  const key = String(outputKey || '').trim() || DEFAULT_INVENTORY_OUTPUT_KEY;
  return {
    title: 'Top Products with Lowest DOH',
    source: `breakdowns.${key}_lowest_doh`,
    tone: 'negative',
    limit: 3,
    columns: [
      { label: 'Product', path: 'product_title', format: 'text' },
      { label: 'SKU', path: 'sku', format: 'text' },
      { label: 'DRR (7 days)', path: 'drr_7d', format: 'decimal' },
      { label: 'DOH (7 days)', path: 'doh_7d', format: 'decimal' },
      { label: 'Status', path: 'status', format: 'status' },
    ],
  };
}

// Appends the inventory KPI cards that are not already present.
// Returns { metrics, added } so the editor can say how many went in.
export function addInventoryKpiCards(metrics = []) {
  const existing = new Set(metrics.map((metric) => metric?.value));
  const toAdd = buildInventoryKpiCards().filter((card) => !existing.has(card.value));
  return { metrics: [...metrics, ...toAdd], added: toAdd.length };
}

// Value-path suggestions for KPI cards (dropdown hints; any path can still be typed).
export const KPI_PATH_SUGGESTIONS = [
  'metrics.current_sessions',
  'metrics.current_orders',
  'metrics.current_cvr',
  'metrics.current_atc_sessions',
  'metrics.current_sales',
  'metrics.current_aov',
  'metrics.inventory_products_analyzed',
  'metrics.inventory_critical_products',
  'metrics.inventory_medium_products',
  'metrics.inventory_healthy_products',
  'metrics.inventory_no_velocity_products',
];

// The output key of every inventory-mode breakdown node in the workflow (its own setting, or the
// node's default when none is set). Accepts editor nodes ({ data }) or saved node definitions.
export function getInventoryOutputKeys(nodes = []) {
  const keys = [];
  (nodes || []).forEach((node) => {
    const def = node?.data || node;
    if (def?.analysis_mode !== 'inventory') return;
    const key = typeof def.output_key === 'string' && def.output_key.trim() ? def.output_key.trim() : DEFAULT_INVENTORY_OUTPUT_KEY;
    if (!keys.includes(key)) keys.push(key);
  });
  return keys;
}

// Table-source suggestions: every breakdown output key in the workflow, plus the lists each
// inventory node in the workflow produces (falling back to the default key when there is none).
export function buildTableSourceSuggestions(breakdownOutputKeys = [], inventoryOutputKeys = []) {
  const sources = new Set();
  (breakdownOutputKeys || []).forEach((key) => {
    if (typeof key === 'string' && key.trim()) sources.add(`breakdowns.${key.trim()}`);
  });
  const inventoryKeys = (inventoryOutputKeys || []).length ? inventoryOutputKeys : [DEFAULT_INVENTORY_OUTPUT_KEY];
  inventoryKeys.forEach((key) => {
    sources.add(`breakdowns.${key}`);
    sources.add(`breakdowns.${key}_lowest_doh`);
  });
  return [...sources].sort();
}

// The default "Daily dashboard report" (dashboard_report_v1): two hero cards, a strip of KPI cells,
// top / bottom performer tables with a share-of-sessions bar, and the inventory health block.
// The data paths are the usual ones; every label, path and format stays editable.
export const DASHBOARD_SHARE_TOTAL_PATH = 'metrics.current_sessions';

export function createDashboardTemplate() {
  const performerColumns = () => [
    { label: 'Source', path: 'display_value', format: 'text' },
    { label: 'Sessions', path: 'current.sessions', format: 'integer' },
    { label: 'Share', path: 'current.sessions', format: 'share_bar', of: DASHBOARD_SHARE_TOTAL_PATH },
    { label: 'Orders', path: 'current.orders', format: 'integer' },
    { label: 'CVR', path: 'current.cvr', format: 'percent_ratio' },
    { label: 'Change', path: 'deltas.cvr_delta_pct', format: 'delta_percent' },
  ];
  return {
    preset: 'dashboard_report_v1',
    headerLabel: 'Daily Report',
    heroCount: 2,
    period: { current: 'meta.window', comparison: 'meta.baselineWindow' },
    metrics: [
      { label: 'Total Sales', value: 'metrics.current_sales', change: 'metrics.sales_delta_pct', format: 'currency', icon: 'sales' },
      { label: 'Conversion Rate', value: 'metrics.current_cvr', change: 'metrics.cvr_delta_pct', format: 'percent_ratio', icon: 'conversion' },
      { label: 'Sessions', value: 'metrics.current_sessions', change: 'metrics.sessions_delta_pct', format: 'integer', icon: 'sessions' },
      { label: 'Orders', value: 'metrics.current_orders', change: 'metrics.orders_delta_pct', format: 'integer', icon: 'orders' },
      { label: 'ATC Sessions', value: 'metrics.current_atc_sessions', change: 'metrics.atc_sessions_delta_pct', format: 'integer', icon: 'cart' },
      { label: 'AOV', value: 'metrics.current_aov', change: 'metrics.aov_delta_pct', format: 'currency_whole', icon: 'aov' },
    ],
    tables: [
      { title: 'Top Performers', source: 'breakdowns.top_utm_sources', tone: 'positive', limit: 3, columns: performerColumns() },
      { title: 'Bottom Performers', source: 'breakdowns.bottom_utm_sources', tone: 'negative', limit: 3, columns: performerColumns() },
    ],
    inventory: { enabled: true, title: 'Inventory health', listTitle: 'Act first · lowest days on hand' },
  };
}
