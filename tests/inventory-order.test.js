const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const { validateWorkflowDefinition } = require('../server/validation/workflowDefinition');

const loadEditorCheck = () => import(pathToFileURL(path.join(__dirname, '../ui/src/utils/workflowValidation.js')).href);

const reportTemplate = (overrides = {}) => ({
  preset: 'performance_report_v1', eyebrow: 'Daily Report', title: 'Performance & Inventory',
  period: { current: 'meta.window', comparison: 'meta.baselineWindow' },
  metrics: [
    { label: 'Sessions', value: 'metrics.current_sessions', change: 'metrics.sessions_delta_pct', format: 'integer', icon: 'sessions' },
    { label: 'Critical Products', value: 'metrics.inventory_critical_products', format: 'integer', icon: 'metric' },
  ],
  tables: [
    { title: 'Top Performers', source: 'breakdowns.top_3_utm', tone: 'positive', limit: 3, columns: [{ label: 'Source', path: 'display_value', format: 'text' }] },
    { title: 'Lowest DOH', source: 'breakdowns.inventory_top_products_lowest_doh', tone: 'negative', limit: 3, columns: [{ label: 'Product', path: 'product_title', format: 'text' }] },
  ],
  ...overrides,
});

const email = (id, template, extra = {}) => ({ id, type: 'email', format: 'report', subject: 'Report', to: ['ops@example.com'], template, ...extra });
const inventory = (id, extra = {}) => ({ id, type: 'recursive_dimension_breakdown', analysis_mode: 'inventory', ...extra });

const wrap = (nodes) => ({
  workflow_type: 'root_cause_analysis', version: '1',
  trigger: { type: 'alert', alertType: 'daily', brandScope: 'single', brandIds: ['AJMAL'] },
  nodes,
});

const inventoryErrors = (nodes) => validateWorkflowDefinition(wrap(nodes)).errors.filter((e) => /inventory/i.test(e));

// the shape saved in the failing run: the combined report ran before the inventory node
const failingChain = () => [
  { id: 'validate_data', type: 'validation', next: 'compare', checks: [{ field: 'sessions', condition: 'current > 0' }], on_fail: { action: 'terminate', reason: 'no data' } },
  { id: 'compare', type: 'metric_compare', metrics: ['sessions', 'orders'], next: 'final_insight' },
  { id: 'final_insight', type: 'insight', template: 'done', next: 'new_email_7200' },
  email('new_email_7200', reportTemplate(), { next: 'inventory' }),
  inventory('inventory', { next: 'branch' }),
  { id: 'branch', type: 'branch', rules: [{ condition: 'x', then: 'mail_a' }], default: { then: 'mail_b' } },
  email('mail_a', { preset: 'inventory_alert_v1', eyebrow: 'E', title: 'T' }),
  email('mail_b', { preset: 'inventory_alert_v1', eyebrow: 'E', title: 'T' }),
];

test('a report that shows inventory data but runs BEFORE the inventory node is rejected (the run that failed)', () => {
  const errors = inventoryErrors(failingChain());
  assert.equal(errors.length, 1, errors.join(' | '));
  assert.match(errors[0], /new_email_7200/);
  assert.match(errors[0], /runs before the inventory breakdown node/);
});

test('the same workflow is accepted once the report comes after the inventory node', () => {
  const fixed = [
    ...failingChain().slice(0, 2),
    { id: 'final_insight', type: 'insight', template: 'done', next: 'inventory' },
    inventory('inventory', { next: 'new_email_7200' }),
    email('new_email_7200', reportTemplate()),
  ];
  assert.deepEqual(inventoryErrors(fixed), []);
});

test('reports placed after a Logic Branch that follows the inventory node are fine', () => {
  const nodes = [
    inventory('inventory', { next: 'branch' }),
    { id: 'branch', type: 'branch', rules: [{ condition: 'x', then: 'critical_mail' }], default: { then: 'weekly_mail' } },
    email('critical_mail', reportTemplate()),
    email('weekly_mail', reportTemplate()),
  ];
  assert.deepEqual(inventoryErrors(nodes), []);
});

test('a report after a composite that contains the inventory node is fine', () => {
  const nodes = [
    { id: 'group', type: 'composite', steps: ['inventory'], next: 'report_mail' },
    inventory('inventory'),
    email('report_mail', reportTemplate()),
  ];
  assert.deepEqual(inventoryErrors(nodes), []);
});

test('inventory data without any inventory node says so', () => {
  const errors = inventoryErrors([email('report_mail', reportTemplate())]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no inventory breakdown node/);
});

test('any of the three ways to show inventory data triggers the rule', () => {
  const noInventoryNode = (template) => inventoryErrors([email('m', template)]);
  const plain = reportTemplate({ metrics: [{ label: 'Sessions', value: 'metrics.current_sessions', format: 'integer' }], tables: [reportTemplate().tables[0]] });
  assert.deepEqual(noInventoryNode(plain), [], 'a report with no inventory data is never flagged');
  assert.equal(noInventoryNode({ ...plain, includeInventory: true }).length, 1, 'the inventory section');
  assert.equal(noInventoryNode({ ...plain, metrics: [{ label: 'C', value: 'x', change: 'metrics.inventory_healthy_products', format: 'integer' }] }).length, 1, 'an inventory KPI in the change path');
  assert.equal(noInventoryNode({ ...plain, tables: [{ ...plain.tables[0], source: 'breakdowns.inventory_top_products' }] }).length, 1, 'the inventory table');
});

test('a custom inventory output key is recognised, in either order', () => {
  const table = { title: 'Stock', source: 'breakdowns.my_stock_lowest_doh', tone: 'negative', limit: 3, columns: [{ label: 'P', path: 'product_title', format: 'text' }] };
  const plain = reportTemplate({ metrics: [{ label: 'Sessions', value: 'metrics.current_sessions', format: 'integer' }], tables: [table] });
  const before = [email('m', plain, { next: 'inventory' }), inventory('inventory', { output_key: 'my_stock' })];
  const after = [inventory('inventory', { output_key: 'my_stock', next: 'm' }), email('m', plain)];
  assert.equal(inventoryErrors(before).length, 1);
  assert.deepEqual(inventoryErrors(after), []);
});

test('reports that do not show inventory data are unaffected by where they sit', () => {
  const plain = reportTemplate({ metrics: [{ label: 'Sessions', value: 'metrics.current_sessions', format: 'integer' }], tables: [reportTemplate().tables[0]] });
  assert.deepEqual(inventoryErrors([email('before', plain, { next: 'inventory' }), inventory('inventory')]), []);
  assert.deepEqual(inventoryErrors([email('only', plain)]), []);
});

test('the editor check gives the same answers as the server', async () => {
  const { getInventorySectionErrors } = await loadEditorCheck();
  const cases = {
    'before the inventory node': failingChain(),
    'after the inventory node': [inventory('inventory', { next: 'm' }), email('m', reportTemplate())],
    'no inventory node': [email('m', reportTemplate())],
    'after a branch': [inventory('inventory', { next: 'b' }), { id: 'b', type: 'branch', rules: [{ condition: 'x', then: 'm' }] }, email('m', reportTemplate())],
    'inside a composite': [{ id: 'g', type: 'composite', steps: ['inventory'], next: 'm' }, inventory('inventory'), email('m', reportTemplate())],
  };
  for (const [label, nodes] of Object.entries(cases)) {
    assert.equal(getInventorySectionErrors({ nodes }).length, inventoryErrors(nodes).length, label);
  }
  assert.match(getInventorySectionErrors({ nodes: failingChain() })[0], /runs before the inventory breakdown node/);
  assert.deepEqual(getInventorySectionErrors({}), []);
});
