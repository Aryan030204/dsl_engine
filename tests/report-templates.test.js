const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const queryExecutor = require('../sql/QueryExecutor');
const inventoryNode = require('../nodes/RecursiveDimensionBreakdownNode');
const mergeContext = require('../engine/MergeContext');
const { renderEmail } = require('../server/lib/renderEmail');
const { validateWorkflowDefinition } = require('../server/validation/workflowDefinition');

const load = () => import(pathToFileURL(path.join(__dirname, '../ui/src/utils/reportTemplates.js')).href);

const inventoryRows = [
  { product_id: 1, product_title: 'Vitamin C Sheet Mask', sku: 'TMC-WEB-975', sku_count: 1, inventory_available: 0, sold_units_7d: 3556, drr_7d: 508, doh_7d: 0 },
  { product_id: 2, product_title: 'Eau De Toilette | Black', sku: 'TMC-WEB-4579', sku_count: 1, inventory_available: 278, sold_units_7d: 2328, drr_7d: 332.57, doh_7d: 0.84 },
  { product_id: 3, product_title: 'Beard Oil', sku: 'TMC-WEB-1', sku_count: 1, inventory_available: 900, sold_units_7d: 100, drr_7d: 14.3, doh_7d: 62.9 },
];

// Runs the real inventory node (database stubbed) and merges its output like the engine does.
async function runInventoryNode(def = {}) {
  const original = queryExecutor.execute;
  queryExecutor.execute = async () => ({ rows: inventoryRows });
  try {
    const context = {
      meta: {
        tenantId: 'TMC', brandName: 'The Man Company', timezone: 'Asia/Kolkata', currency: 'INR',
        window: { start: '2026-10-20T18:30:00.000Z', end: '2026-10-21T18:30:00.000Z' },
        baselineWindow: { start: '2026-10-19T18:30:00.000Z', end: '2026-10-20T18:30:00.000Z' },
      },
      metrics: { current_sessions: 18420, sessions_delta_pct: -8.4 },
      breakdowns: {},
      scratch: {},
    };
    const result = await inventoryNode({ id: 'inv', type: 'recursive_dimension_breakdown', analysis_mode: 'inventory', inventory_report_top_k: 3, ...def }, context);
    mergeContext(context, result.delta);
    return context;
  } finally {
    queryExecutor.execute = original;
  }
}

const resolve = (root, dotted) => dotted.split('.').reduce((value, key) => (value == null ? undefined : value[key]), root);

function templateWith(helpers, { metrics, tables }) {
  return {
    preset: 'performance_report_v1', eyebrow: 'Daily Report', title: 'Performance & Inventory', description: 'd',
    period: { current: 'meta.window', comparison: 'meta.baselineWindow' },
    metrics: [{ label: 'Sessions', value: 'metrics.current_sessions', change: 'metrics.sessions_delta_pct', format: 'integer', icon: 'sessions' }, ...metrics],
    tables,
  };
}

test('the editor\'s inventory KPI cards point at values the real inventory node produces', async () => {
  const helpers = await load();
  const context = await runInventoryNode();
  for (const card of helpers.buildInventoryKpiCards()) {
    assert.equal(typeof resolve(context, card.value), 'number', `${card.label} -> ${card.value}`);
  }
  assert.equal(resolve(context, 'metrics.inventory_critical_products'), 2);
});

test('the lowest-DOH table follows the inventory node\'s own output key', async () => {
  const helpers = await load();
  for (const outputKey of [undefined, 'my_stock_list']) {
    const context = await runInventoryNode(outputKey ? { output_key: outputKey } : {});
    const key = helpers.getInventoryOutputKeys([{ data: { analysis_mode: 'inventory', output_key: outputKey } }])[0];
    const table = helpers.buildLowestDohTable(key);
    const rows = resolve(context, table.source);
    assert.ok(Array.isArray(rows) && rows.length === 3, `${table.source} should be the lowest-DOH list`);
    table.columns.forEach((column) => assert.notEqual(resolve(rows[0], column.path), undefined, column.path));
  }
});

test('a report with nine KPI cards and three tables passes validation and renders from real inventory output', async () => {
  const helpers = await load();
  const context = await runInventoryNode();
  context.metrics = { ...context.metrics, current_orders: 310, orders_delta_pct: 2.1, current_cvr: 0.0168, cvr_delta_pct: 11.2, current_atc_sessions: 2210, current_sales: 412000, current_aov: 1329 };
  context.breakdowns.top_utm = [{ display_value: 'google', current: { sessions: 9004 }, deltas: { cvr_delta_pct: 12.8 } }];
  context.breakdowns.bottom_utm = [{ display_value: 'facebook', current: { sessions: 5000 }, deltas: { cvr_delta_pct: -9.1 } }];
  const utmColumns = [{ label: 'Source', path: 'display_value', format: 'text' }, { label: 'Sessions', path: 'current.sessions', format: 'integer' }, { label: 'Change', path: 'deltas.cvr_delta_pct', format: 'delta_percent' }];
  const metrics = [
    { label: 'Orders', value: 'metrics.current_orders', change: 'metrics.orders_delta_pct', format: 'integer', icon: 'orders' },
    { label: 'Conversion Rate', value: 'metrics.current_cvr', format: 'percent_ratio', icon: 'conversion' },
    { label: 'ATC Sessions', value: 'metrics.current_atc_sessions', format: 'integer', icon: 'cart' },
    { label: 'Total Sales', value: 'metrics.current_sales', format: 'currency', icon: 'sales' },
    { label: 'AOV', value: 'metrics.current_aov', format: 'currency', icon: 'aov' },
    ...helpers.buildInventoryKpiCards(),
  ];
  const template = templateWith(helpers, {
    metrics,
    tables: [
      { title: 'Top Performers', source: 'breakdowns.top_utm', tone: 'positive', limit: 3, columns: utmColumns },
      { title: 'Bottom Performers', source: 'breakdowns.bottom_utm', tone: 'negative', limit: 3, columns: utmColumns },
      helpers.buildLowestDohTable('inventory_top_products'),
    ],
  });
  assert.equal(template.metrics.length, 9);

  const validation = validateWorkflowDefinition({
    workflow_type: 'root_cause_analysis', version: '1',
    trigger: { type: 'alert', alertType: 'daily', brandScope: 'single', brandIds: ['TMC'] },
    nodes: [
      { id: 'inv', type: 'recursive_dimension_breakdown', analysis_mode: 'inventory', next: 'notify' },
      { id: 'notify', type: 'messaging', channels: { email: true, telegram: false }, format: 'report', subject: 'Report', template, email: { to: ['ops@example.com'] } },
    ],
  });
  assert.ok(!validation.errors.some((e) => /template|metric|table/i.test(e)), validation.errors.join(' | '));

  const rendered = renderEmail({ format: 'report', template, context, subject: 'Report' });
  assert.equal(rendered.html.split('rpt-kpi-card"').length - 1, 9, 'nine KPI cards');
  const order = ['Top Performers', 'Bottom Performers', 'Top Products with Lowest DOH'].map((title) => rendered.html.toUpperCase().indexOf(title.toUpperCase()));
  assert.ok(order.every((index) => index > 0) && order[0] < order[1] && order[1] < order[2], 'tables in the configured order');
  assert.match(rendered.html, /Critical Products/);
  assert.match(rendered.html, /Vitamin C Sheet Mask/);
  assert.match(rendered.text, /Healthy Products: 1/);
});

test('there is no limit on KPI cards: any number validates and renders, but at least one is required', () => {
  const card = (n) => ({ label: `M${n}`, value: 'metrics.current_sessions', format: 'integer', icon: 'metric' });
  const templateFor = (count) => ({
    preset: 'performance_report_v1', eyebrow: 'E', title: 'T', period: { current: 'meta.window', comparison: 'meta.baselineWindow' },
    metrics: Array.from({ length: count }, (_, i) => card(i)),
    tables: [{ title: 'T', source: 'breakdowns.x', tone: 'neutral', limit: 3, columns: [{ label: 'Name', path: 'display_value', format: 'text' }] }],
  });
  const definition = (count) => ({
    workflow_type: 'root_cause_analysis', version: '1',
    trigger: { type: 'alert', alertType: 'daily', brandScope: 'single', brandIds: ['TMC'] },
    nodes: [{
      id: 'notify', type: 'messaging', channels: { email: true, telegram: false }, format: 'report', subject: 'R',
      email: { to: ['ops@example.com'] }, template: templateFor(count),
    }],
  });
  for (const count of [1, 9, 10, 25, 60]) {
    assert.ok(!validateWorkflowDefinition(definition(count)).errors.some((e) => /metrics must contain/.test(e)), `${count} cards`);
  }
  const none = validateWorkflowDefinition(definition(0)).errors.find((e) => /metrics must contain/.test(e));
  assert.match(none, /at least one item/);

  // and they all render, in rows of three on desktop
  const context = {
    meta: { tenantId: 'T', brandName: 'Acme', timezone: 'UTC', window: { start: '2026-10-20T00:00:00.000Z', end: '2026-10-21T00:00:00.000Z' }, baselineWindow: { start: '2026-10-19T00:00:00.000Z', end: '2026-10-20T00:00:00.000Z' } },
    metrics: { current_sessions: 100 },
    breakdowns: { x: [{ display_value: 'a' }] },
    scratch: {},
  };
  const rendered = renderEmail({ format: 'report', template: templateFor(25), context, subject: 'R' });
  assert.equal(rendered.html.split('rpt-kpi-card"').length - 1, 25);
  assert.equal((rendered.html.match(/class="rpt-kpi-card" style="[^"]*width:33\.3333%/g) || []).length, 25);
});

test('adding inventory KPIs never duplicates a card and is not limited by how many cards exist', async () => {
  const { addInventoryKpiCards } = await load();
  const base = (n) => Array.from({ length: n }, (_, i) => ({ label: `M${i}`, value: `metrics.m${i}`, format: 'integer' }));

  const first = addInventoryKpiCards(base(3));
  assert.equal(first.added, 3);
  assert.equal(first.metrics.length, 6);
  const again = addInventoryKpiCards(first.metrics);
  assert.equal(again.added, 0);
  assert.equal(again.metrics.length, 6);

  const crowded = addInventoryKpiCards(base(40));
  assert.equal(crowded.added, 3);
  assert.equal(crowded.metrics.length, 43);

  // a card that is already there is not added a second time, the others still are
  const partial = addInventoryKpiCards([{ label: 'Mine', value: 'metrics.inventory_critical_products', format: 'integer' }]);
  assert.equal(partial.added, 2);
  assert.equal(partial.metrics.filter((m) => m.value === 'metrics.inventory_critical_products').length, 1);
});

test('inventory output keys come from the workflow\'s own nodes', async () => {
  const { getInventoryOutputKeys, buildTableSourceSuggestions, buildLowestDohTable } = await load();
  assert.deepEqual(getInventoryOutputKeys([]), []);
  assert.deepEqual(getInventoryOutputKeys([{ data: { analysis_mode: 'inventory' } }]), ['inventory_top_products']);
  assert.deepEqual(
    getInventoryOutputKeys([
      { data: { analysis_mode: 'inventory', output_key: '  stock_a ' } },
      { analysis_mode: 'inventory', output_key: 'stock_b' },
      { data: { analysis_mode: 'inventory', output_key: 'stock_a' } },
      { data: { type: 'recursive_dimension_breakdown', output_key: 'not_inventory' } },
    ]),
    ['stock_a', 'stock_b']
  );
  assert.equal(buildLowestDohTable('stock_a').source, 'breakdowns.stock_a_lowest_doh');
  assert.equal(buildLowestDohTable('  ').source, 'breakdowns.inventory_top_products_lowest_doh');

  assert.deepEqual(buildTableSourceSuggestions(['top_utm'], ['stock_a']), [
    'breakdowns.stock_a', 'breakdowns.stock_a_lowest_doh', 'breakdowns.top_utm',
  ]);
  assert.ok(buildTableSourceSuggestions([], []).includes('breakdowns.inventory_top_products_lowest_doh'));
});

test('every preset the editor adds is plain data the user can change', async () => {
  const { buildInventoryKpiCards, buildLowestDohTable } = await load();
  const a = buildInventoryKpiCards();
  a[0].label = 'Changed';
  assert.equal(buildInventoryKpiCards()[0].label, 'Critical Products', 'each call returns fresh objects');
  const table = buildLowestDohTable();
  table.columns.push({ label: 'x', path: 'x', format: 'text' });
  assert.equal(buildLowestDohTable().columns.length, 5);
});
