const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const { renderEmail } = require('../server/lib/renderEmail');
const { validateWorkflowDefinition } = require('../server/validation/workflowDefinition');

const loadHelpers = () => import(pathToFileURL(path.join(__dirname, '../ui/src/utils/reportTemplates.js')).href);

function context() {
  return {
    meta: {
      tenantId: 'T', brandName: 'Acme', timezone: 'UTC',
      window: { start: '2026-10-20T00:00:00.000Z', end: '2026-10-21T00:00:00.000Z' },
      baselineWindow: { start: '2026-10-19T00:00:00.000Z', end: '2026-10-20T00:00:00.000Z' },
    },
    metrics: {
      current_sessions: 100,
      inventory_products_analyzed: 49,
      inventory_critical_products: 8, inventory_medium_products: 9, inventory_healthy_products: 32,
    },
    breakdowns: {
      stock: [
        { product_title: 'WISAL DHAHAB', status: 'Critical' },
        { product_title: 'Beard Oil', status: 'Low stock' },
        { product_title: 'Charcoal Soap', status: 'Healthy' },
        { product_title: 'Mystery <b>item</b>', status: 'No recent sales' },
      ],
    },
    scratch: {},
  };
}

const template = (metrics, statusFormat = 'status') => ({
  preset: 'performance_report_v1', eyebrow: 'E', title: 'T',
  period: { current: 'meta.window', comparison: 'meta.baselineWindow' },
  metrics,
  tables: [{ title: 'Stock', source: 'breakdowns.stock', tone: 'negative', limit: 10, columns: [
    { label: 'Product', path: 'product_title', format: 'text' },
    { label: 'Status', path: 'status', format: statusFormat },
  ] }],
});

const render = (tpl) => renderEmail({ format: 'report', template: tpl, context: context(), subject: 'R' });
const card = (label, value) => ({ label, value, format: 'integer', icon: 'metric' });
// the KPI card section only (the table below has its own colored status chips)
const cardsOf = (html) => html.slice(html.indexOf('rpt-kpis'), html.indexOf('rpt-panel"'));

// each card renders as: icon, label, value -- all three carry the card's color
const cardColors = (html, label) => {
  const block = cardsOf(html).split('rpt-kpi-card"').find((part) => part.includes(`>${label}</div>`));
  return [...block.matchAll(/(?:aria-hidden="true"|class="rpt-kpi-label"|class="rpt-kpi-value") style="[^"]*?color:(#[0-9a-fA-F]{6});/g)].map((m) => m[1]);
};

test('the inventory counts have fixed colors: Critical red, Low stock orange, Healthy green', () => {
  const html = render(template([
    card('Critical Products', 'metrics.inventory_critical_products'),
    card('Low Stock', 'metrics.inventory_medium_products'),
    card('Healthy Products', 'metrics.inventory_healthy_products'),
  ])).html;
  assert.deepEqual(cardColors(html, 'Critical Products'), ['#dc2626', '#dc2626', '#dc2626'], 'icon, label and value are red');
  assert.deepEqual(cardColors(html, 'Low Stock'), ['#ea580c', '#ea580c', '#ea580c'], 'orange');
  assert.deepEqual(cardColors(html, 'Healthy Products'), ['#059669', '#059669', '#059669'], 'green');
});

test('the color follows the data, not the label', () => {
  const html = render(template([
    card('Out of stock', 'metrics.inventory_critical_products'),
    card('Whatever you call it', 'metrics.inventory_healthy_products'),
  ])).html;
  assert.deepEqual(cardColors(html, 'Out of stock'), ['#dc2626', '#dc2626', '#dc2626']);
  assert.deepEqual(cardColors(html, 'Whatever you call it'), ['#059669', '#059669', '#059669']);
});

test('every other card keeps the default look', () => {
  const html = render(template([card('Sessions', 'metrics.current_sessions'), card('Analysed', 'metrics.inventory_products_analyzed')])).html;
  const cards = cardsOf(html);
  assert.doesNotMatch(cards, /color:#dc2626|color:#ea580c|color:#059669/);
  assert.match(cards, /rpt-kpi-value" style="[^"]*color:#111827;/);
});

test('there is no per-card color setting: a "color" on a card is ignored by the email and refused on save', () => {
  const sneaky = { label: 'Sessions', value: 'metrics.current_sessions', format: 'integer', color: 'red;background:url(//evil.example/x)' };
  const rendered = render(template([sneaky]));
  assert.doesNotMatch(rendered.html, /evil\.example|color:red/);
  assert.equal(rendered.viewModel.metrics[0].color, undefined);

  const result = validateWorkflowDefinition({
    workflow_type: 'root_cause_analysis', version: '1',
    trigger: { type: 'alert', alertType: 'daily', brandScope: 'single', brandIds: ['T'] },
    nodes: [{ id: 'mail', type: 'email', format: 'report', subject: 'R', to: ['ops@example.com'], template: template([sneaky]) }],
  });
  assert.ok(result.errors.some((e) => /unsupported field color/.test(e)), result.errors.join(' | '));
});

test('the status format shows Critical in red, Low stock in orange, Healthy in green and never wraps', () => {
  const html = render(template([card('S', 'metrics.current_sessions')])).html;
  assert.match(html, /background:#fee2e2;color:#dc2626;font-weight:700;white-space:nowrap;">Critical</);
  assert.match(html, /background:#ffedd5;color:#ea580c;font-weight:700;white-space:nowrap;">Low stock</);
  assert.match(html, /background:#d1fae5;color:#059669;font-weight:700;white-space:nowrap;">Healthy</);
  assert.match(html, /background:#f1f5f9;color:#64748b;font-weight:700;white-space:nowrap;">No recent sales</);
});

test('the status format escapes its text', () => {
  const html = render(template([card('S', 'metrics.current_sessions')])).html;
  assert.doesNotMatch(html, /<b>item<\/b>/);
  assert.match(html, /Mystery &lt;b&gt;item&lt;\/b&gt;/);
});

test('the inventory Status column is colored automatically, even when its format was left as text', () => {
  const html = render(template([card('S', 'metrics.current_sessions')], 'text')).html;
  assert.match(html, /background:#fee2e2;color:#dc2626;font-weight:700;white-space:nowrap;">Critical</);
  assert.match(html, /background:#ffedd5;color:#ea580c;font-weight:700;white-space:nowrap;">Low stock</);
  assert.match(html, /background:#d1fae5;color:#059669;font-weight:700;white-space:nowrap;">Healthy</);
  assert.match(html, /word-break:break-word;">WISAL DHAHAB<\/td>/, 'the product column stays plain text');
});

test('only the inventory statuses are colored automatically', () => {
  const tpl = (path) => ({
    ...template([card('S', 'metrics.current_sessions')], 'text'),
    tables: [{ title: 'T', source: 'breakdowns.rows', tone: 'neutral', limit: 5, columns: [{ label: 'Status', path, format: 'text' }] }],
  });
  const ctx = context();
  ctx.breakdowns.rows = [{ status: 'Shipped', state: 'Critical' }, { status: 'Critical', state: 'Critical' }];
  const render2 = (path) => renderEmail({ format: 'report', template: tpl(path), context: ctx, subject: 'R' }).html;

  const byStatus = render2('status');
  assert.match(byStatus, /word-break:break-word;">Shipped<\/td>/, 'another kind of status stays text');
  assert.match(byStatus, />Critical<\/span>/, 'an inventory status is a chip');

  const byOtherPath = render2('state');
  assert.doesNotMatch(byOtherPath, /border-radius:16px;padding:4px 10px/, 'a column that is not called status is never changed');
});

test('the status format is accepted when saving a workflow', () => {
  const result = validateWorkflowDefinition({
    workflow_type: 'root_cause_analysis', version: '1',
    trigger: { type: 'alert', alertType: 'daily', brandScope: 'single', brandIds: ['T'] },
    nodes: [{ id: 'mail', type: 'email', format: 'report', subject: 'R', to: ['ops@example.com'], template: template([card('S', 'metrics.current_sessions')]) }],
  });
  assert.ok(!result.errors.some((e) => /format|color/.test(e)), result.errors.join(' | '));
});

test('the editor\'s inventory cards carry no color setting, and its status column uses the status format', async () => {
  const { buildInventoryKpiCards, buildLowestDohTable, addInventoryKpiCards } = await loadHelpers();
  buildInventoryKpiCards().forEach((card) => assert.equal(card.color, undefined, card.label));
  assert.equal(buildLowestDohTable().columns.find((c) => c.label === 'Status').format, 'status');
  const result = addInventoryKpiCards([{ label: 'Sessions', value: 'metrics.current_sessions', format: 'integer' }]);
  assert.equal(result.added, 3);
  assert.equal(result.colored, undefined);
});
