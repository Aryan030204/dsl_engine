const test = require('node:test');
const assert = require('node:assert/strict');

const { renderEmail } = require('../server/lib/renderEmail');
const { normalizeRerunContext } = require('../lib/timeWindowUtils');

// An inventory report as the inventory breakdown node leaves it in scratch.inventoryReport.
function inventoryReport(products) {
  const lowest = products.filter((product) => product.doh_7d != null).sort((a, b) => a.doh_7d - b.doh_7d);
  return {
    products,
    lowest_doh_products: lowest,
    analyzed_count: products.length,
    critical_count: products.filter((p) => p.status === 'Critical').length,
    medium_count: products.filter((p) => p.status === 'Low stock').length,
    healthy_count: products.filter((p) => p.status === 'Healthy').length,
    no_velocity_count: products.filter((p) => p.status === 'No recent sales').length,
    critical_threshold_days: 7,
    healthy_threshold_days: 15,
    report_top_k: 5,
    as_of: '2026-10-17T03:00:00.000Z'
  };
}

const product = (id, title, extra = {}) => ({
  product_id: id, product_title: title, sku: `SKU-${id}`, inventory_available: 100, sold_units_7d: 10,
  drr_7d: 2, doh_7d: 50, status: 'Healthy', updated_at: '2026-10-17T03:00:00.000Z', ...extra
});

const render = (scratch) => renderEmail({
  format: 'report',
  template: { preset: 'inventory_alert_v1' },
  context: { meta: { tenantId: 'TMC', brandName: 'TMC', timezone: 'UTC' }, scratch },
  subject: 'Inventory'
});

test('the inventory email shows a Current Inventory column on desktop, mobile, text and Telegram rows', () => {
  const report = inventoryReport([
    product('1', 'First', { inventory_available: 11652, drr_7d: 71.44, doh_7d: 0, status: 'Critical' }),
    product('2', 'Second', { inventory_available: null })
  ]);
  const rendered = render({ inventoryReport: report });

  assert.match(rendered.html, /<th align="right" style="padding:11px;">Current Inventory<\/th>/);
  // stock cell in the desktop table and again in the mobile card, with a thousands separator
  assert.equal((rendered.html.match(/>11,652</g) || []).length, 2);
  assert.match(rendered.html, /Current Inventory<\/div>/);
  assert.match(rendered.text, /\| Inventory 11,652 \| DRR 71\.44 \| DOH 0\.00 \|/);
  // unknown stock is a dash, not 0
  assert.match(rendered.text, /\| Inventory — \|/);

  const table = rendered.viewModel.tables[0];
  assert.deepEqual(table.columns.map((c) => c.label), ['Product', 'SKU', 'Current Inventory', 'DRR (7 days)', 'DOH (7 days)', 'Status']);
  assert.equal(table.rows[0].cells.length, 6);
  assert.equal(table.rows[0].cells[2].value, '11,652');
});

test('the empty-state row spans every column, including the inventory one', () => {
  const report = inventoryReport([product('1', 'No sales yet', { doh_7d: null, status: 'No recent sales' })]);
  assert.match(render({ inventoryReport: report }).html, /colspan="7"/);
});

test('a rerun never reuses a Shopify domain saved on the earlier run', () => {
  const rerun = normalizeRerunContext({
    meta: {
      tenantId: 'TMC', shopifyDomain: 'old-store.myshopify.com', currency: 'USD',
      window: { start: '2026-10-10 00:00:00', end: '2026-10-17 00:00:00' },
      baselineWindow: { start: '2026-10-03 00:00:00', end: '2026-10-10 00:00:00' }
    }
  }, 'UTC');
  assert.equal(rerun.meta.shopifyDomain, undefined);
  assert.equal(rerun.meta.currency, undefined);
  assert.equal(rerun.meta.tenantId, 'TMC');
});
