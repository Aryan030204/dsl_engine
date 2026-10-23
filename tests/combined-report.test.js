const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const { renderEmail } = require('../server/lib/renderEmail');
const { renderTelegramImages } = require('../server/lib/renderTelegramImage');
const { validateWorkflowDefinition } = require('../server/validation/workflowDefinition');
const MessagingNode = require('../nodes/MessagingNode');

const lowest = [
  { product_id: '1', product_title: 'Cotton Kurta Set', sku: 'TMC-1', status: 'Critical', doh_7d: 2.1, drr_7d: 3.2 },
  { product_id: '2', product_title: 'Denim Jacket', sku: 'TMC-2', status: 'Low stock', doh_7d: 9.5, drr_7d: 3.2 },
];

function context({ withInventory = true } = {}) {
  return {
    meta: {
      tenantId: 'T', brandName: 'Acme', timezone: 'Asia/Kolkata', workflowName: 'Daily report',
      emailBranding: { displayName: 'Acme', primaryColor: '#0f766e' },
      window: { start: '2026-08-12T18:30:00.000Z', end: '2026-08-13T18:30:00.000Z' },
      baselineWindow: { start: '2026-08-11T18:30:00.000Z', end: '2026-08-12T18:30:00.000Z' },
    },
    metrics: { current_sessions: 18420, sessions_delta_pct: -8.4 },
    breakdowns: { top: [{ display_value: 'google', current: { sessions: 9004 }, deltas: { cvr_delta_pct: 12.8 } }] },
    scratch: withInventory ? {
      inventoryReport: {
        products: lowest, lowest_doh_products: lowest, analyzed_count: 50, critical_count: 1, medium_count: 1,
        healthy_count: 48, no_velocity_count: 0, critical_threshold_days: 7, healthy_threshold_days: 15,
        report_top_k: 2, as_of: '2026-10-12T00:00:00.000Z',
      },
    } : {},
  };
}

function performanceTemplate(extra = {}) {
  return {
    preset: 'performance_report_v1', eyebrow: 'UTM Source Report', title: 'Top UTM Sources', description: 'Traffic.',
    period: { current: 'meta.window', comparison: 'meta.baselineWindow' },
    metrics: [{ label: 'Sessions', value: 'metrics.current_sessions', change: 'metrics.sessions_delta_pct', format: 'integer', icon: 'sessions' }],
    tables: [{ title: 'Top sources', source: 'breakdowns.top', tone: 'positive', limit: 3, columns: [
      { label: 'Source', path: 'display_value', format: 'text' },
      { label: 'Change', path: 'deltas.cvr_delta_pct', format: 'delta_percent' },
    ] }],
    ...extra,
  };
}

const render = (template, ctx = context()) => renderEmail({ format: 'report', template, context: ctx, subject: 'Daily report' });

test('without the option the performance report has no inventory section', () => {
  const rendered = render(performanceTemplate());
  assert.doesNotMatch(rendered.html, /inventory-section|Inventory report/);
  assert.doesNotMatch(rendered.text, /Inventory/);
  assert.equal(rendered.viewModel.inventorySection, undefined);
});

test('turning the option off again gives exactly the same email as never having it', () => {
  const never = render(performanceTemplate());
  const off = render(performanceTemplate({ includeInventory: false }));
  assert.equal(off.html, never.html);
  assert.equal(off.text, never.text);
});

test('with the option on, the inventory report sits below the performance report in one email', () => {
  const rendered = render(performanceTemplate({ includeInventory: true }));
  const html = rendered.html;
  const utm = html.indexOf('Top sources');
  const inventory = html.indexOf('Inventory report');
  const overview = html.indexOf('Inventory Overview');
  const lowestTable = html.indexOf('Products with Lowest DOH');
  const footer = html.lastIndexOf('ACME');
  assert.ok(utm > 0 && inventory > utm && overview > inventory && lowestTable > overview, 'UTM first, then inventory');
  assert.ok(footer > lowestTable, 'one footer, after both');
  assert.equal(html.split('<!doctype html>').length - 1, 1, 'a single document');
  assert.match(html, /Cotton Kurta Set/);
  assert.match(html, /Inventory as of/);
  assert.match(html, /\.inventory-mobile-product \{ display:block/);
  // plain-text alternative carries both
  assert.ok(rendered.text.indexOf('Top sources') < rendered.text.indexOf('Inventory report'));
  assert.match(rendered.text, /Cotton Kurta Set \| SKU TMC-1/);
});

test('the combined view model keeps inventory under its own key so Telegram still draws the performance pages', () => {
  const view = render(performanceTemplate({ includeInventory: true })).viewModel;
  assert.equal(view.inventory, undefined);
  assert.equal(view.inventorySection.inventory.analyzed_count, 50);
  assert.ok(Array.isArray(view.tables) && view.tables.length === 1);
});

test('including inventory without an inventory report fails clearly', () => {
  assert.throws(
    () => render(performanceTemplate({ includeInventory: true }), context({ withInventory: false })),
    /missing inventory report data at scratch\.inventoryReport/
  );
});

test('the inventory-only preset is unaffected by the option', () => {
  const rendered = render({ preset: 'inventory_alert_v1', eyebrow: 'Inventory Alert', title: 'Top Products Inventory Report' });
  assert.match(rendered.html, /Inventory Overview/);
  assert.equal(rendered.viewModel.inventorySection, undefined);
  assert.ok(rendered.viewModel.inventory);
});

test('drawn Telegram pages for a combined report: performance pages first, then the inventory pages', async () => {
  const performanceOnly = await renderTelegramImages({ title: 'T', reportViewModel: render(performanceTemplate()).viewModel, workflowName: 'W' });
  const combined = await renderTelegramImages({ title: 'T', reportViewModel: render(performanceTemplate({ includeInventory: true })).viewModel, workflowName: 'W' });
  const inventoryOnly = await renderTelegramImages({ title: 'T', reportViewModel: render({ preset: 'inventory_alert_v1', eyebrow: 'e', title: 't' }).viewModel, workflowName: 'W' });
  assert.equal(combined.length, performanceOnly.length + inventoryOnly.length);
  assert.deepEqual(combined.slice(0, performanceOnly.length), performanceOnly);
  combined.forEach((image) => assert.match(image, /^data:image\/jpeg;base64,/));
});

test('the messaging node sends the combined email and still reaches Telegram', async () => {
  const sent = {};
  const original = process.env.TELEGRAM_RENDER_MODE;
  process.env.TELEGRAM_RENDER_MODE = 'email_screenshot';
  try {
    const result = await MessagingNode({
      id: 'notify', type: 'messaging', channels: { email: true, telegram: true }, format: 'report',
      subject: 'Daily report', template: performanceTemplate({ includeInventory: true }),
      email: { to: ['a@b.com'] }, telegram: { users: [{ username: 'u' }] },
    }, context(), {
      emailSender: async (payload) => { sent.email = payload; return { status: 'sent' }; },
      emailScreenshotRenderer: async ({ html }) => { sent.screenshotHtml = html; return ['data:image/jpeg;base64,AAAA']; },
      telegramSender: async (payload) => { sent.telegram = payload; return { status: 'sent' }; },
    });
    assert.equal(result.status, 'pass');
    assert.match(sent.email.html, /Top sources/);
    assert.match(sent.email.html, /Inventory Overview/);
    assert.equal(sent.screenshotHtml, sent.email.html, 'Telegram shows the very same email');
    assert.deepEqual(sent.telegram.images, ['data:image/jpeg;base64,AAAA']);
  } finally {
    if (original === undefined) delete process.env.TELEGRAM_RENDER_MODE;
    else process.env.TELEGRAM_RENDER_MODE = original;
  }
});

function definitionWith({ includeInventory, withInventoryNode, preset }) {
  const nodes = [{
    id: 'notify', type: 'messaging', channels: { email: true, telegram: false }, format: 'report', subject: 'Report',
    template: preset ? { preset, eyebrow: 'E', title: 'T', includeInventory } : performanceTemplate(includeInventory === undefined ? {} : { includeInventory }),
    email: { to: ['ops@example.com'] },
  }];
  if (withInventoryNode) nodes.unshift({ id: 'inv', type: 'recursive_dimension_breakdown', analysis_mode: 'inventory', next: 'notify' });
  return {
    workflow_type: 'root_cause_analysis', version: '1',
    trigger: { type: 'alert', alertType: 'daily', brandScope: 'single', brandIds: ['T'] },
    nodes,
  };
}

test('validation: includeInventory must be a boolean', () => {
  const bad = validateWorkflowDefinition(definitionWith({ includeInventory: 'yes', withInventoryNode: true }));
  assert.ok(bad.errors.some((e) => /includeInventory must be true or false/.test(e)), bad.errors.join(' | '));
  const good = validateWorkflowDefinition(definitionWith({ includeInventory: true, withInventoryNode: true }));
  assert.ok(!good.errors.some((e) => /includeInventory/.test(e)), good.errors.join(' | '));
});

test('validation: the inventory section needs an inventory breakdown node in the workflow', () => {
  const missing = validateWorkflowDefinition(definitionWith({ includeInventory: true, withInventoryNode: false }));
  assert.ok(missing.errors.some((e) => /no inventory breakdown node/.test(e)), missing.errors.join(' | '));
  const present = validateWorkflowDefinition(definitionWith({ includeInventory: true, withInventoryNode: true }));
  assert.ok(!present.errors.some((e) => /no inventory breakdown node/.test(e)), present.errors.join(' | '));
  const off = validateWorkflowDefinition(definitionWith({ includeInventory: false, withInventoryNode: false }));
  assert.ok(!off.errors.some((e) => /inventory/i.test(e)), off.errors.join(' | '));
});

test('validation: the inventory-only preset still rejects the option', () => {
  const result = validateWorkflowDefinition(definitionWith({ includeInventory: true, withInventoryNode: true, preset: 'inventory_alert_v1' }));
  assert.ok(result.errors.some((e) => /unsupported field includeInventory/.test(e)), result.errors.join(' | '));
});

test('editor check mirrors the server rule', async () => {
  const { getInventorySectionErrors } = await import(pathToFileURL(path.join(__dirname, '../ui/src/utils/workflowValidation.js')).href);
  const withOption = { nodes: [{ id: 'notify', type: 'messaging', format: 'report', template: { includeInventory: true } }] };
  assert.equal(getInventorySectionErrors(withOption).length, 1);
  assert.deepEqual(getInventorySectionErrors({ nodes: [{ id: 'inv', analysis_mode: 'inventory', next: 'notify' }, ...withOption.nodes] }), []);
  assert.deepEqual(getInventorySectionErrors({ nodes: [{ id: 'notify', type: 'messaging', format: 'report', template: {} }] }), []);
  assert.deepEqual(getInventorySectionErrors({}), []);
});
