const test = require('node:test');
const assert = require('node:assert/strict');

const queryBuilder = require('../sql/QueryBuilder');
const queryExecutor = require('../sql/QueryExecutor');
const topProductsCache = require('../server/services/topProductsCache');
const recursiveDimensionBreakdownNode = require('../nodes/RecursiveDimensionBreakdownNode');
const { renderEmail } = require('../server/lib/renderEmail');
const { normalizeShopifyDomain } = require('../lib/shopifyDomain');
const { normalizeRerunContext } = require('../lib/timeWindowUtils');

const { parseTopProducts, getTopProducts, TopProductsCacheError } = topProductsCache;
const NOW = new Date('2026-10-17T10:00:00Z');

function payload(overrides = {}) {
  return JSON.stringify({
    window_start_date: '2026-10-10',
    window_end_date_exclusive: '2026-10-17',
    updated_at: '2026-10-16T18:30:02Z',
    products: [
      { product_id: '30', product_title: 'Third', sales: 100, rank: 3, source_rows: [] },
      { product_id: '10', product_title: 'First', sales: 900, rank: 1, source_rows: [] },
      { product_id: '20', product_title: 'Second', sales: 500, rank: 2, source_rows: [] }
    ],
    ...overrides
  });
}

function reasonOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof TopProductsCacheError);
    return error.reason;
  }
  return null;
}

test('cached top products are sorted by rank and cut to top_k', () => {
  const all = parseTopProducts(payload(), { now: NOW });
  assert.deepEqual(all.products.map((p) => p.product_id), ['10', '20', '30']);
  assert.equal(all.products[0].sales, 900);
  assert.equal(all.updatedAt, '2026-10-16T18:30:02.000Z');
  assert.equal(all.windowStart, '2026-10-10');

  const top2 = parseTopProducts(payload(), { topK: 2, now: NOW });
  assert.deepEqual(top2.products.map((p) => p.product_id), ['10', '20']);
});

test('an unusable cache entry is rejected with a specific reason', () => {
  assert.equal(reasonOf(() => parseTopProducts(null, { now: NOW })), 'key_missing');
  assert.equal(reasonOf(() => parseTopProducts('{nope', { now: NOW })), 'bad_payload');
  assert.equal(reasonOf(() => parseTopProducts('{}', { now: NOW })), 'bad_payload');
  assert.equal(reasonOf(() => parseTopProducts(payload({ products: [{ rank: 1 }] }), { now: NOW })), 'bad_payload');
  assert.equal(reasonOf(() => parseTopProducts(payload({ products: [] }), { now: NOW })), 'empty');
  assert.equal(reasonOf(() => parseTopProducts(payload({ updated_at: '2026-10-01T00:00:00Z' }), { now: NOW })), 'stale');
});

test('getTopProducts reads the per-store key and maps Redis failures to reasons', async () => {
  const seen = [];
  const redis = { status: 'ready', get: async (key) => { seen.push(key); return payload(); } };
  const result = await getTopProducts({ shopDomain: 'the-man-company.myshopify.com', topK: 2, redis, now: NOW });
  assert.deepEqual(seen, ['inventory_top_product_sales:the-man-company.myshopify.com']);
  assert.equal(result.products.length, 2);

  const reason = async (args) => {
    try {
      await getTopProducts({ now: NOW, ...args });
    } catch (error) {
      return error.reason;
    }
    return null;
  };
  assert.equal(await reason({ shopDomain: 'a.myshopify.com', redis: { status: 'ready', get: async () => null } }), 'key_missing');
  assert.equal(await reason({ shopDomain: 'a.myshopify.com', redis: { status: 'ready', get: async () => { throw new Error('Command timed out'); } } }), 'timeout');
  assert.equal(await reason({ shopDomain: 'a.myshopify.com', redis: { status: 'ready', get: async () => { throw new Error('ECONNREFUSED'); } } }), 'connect_failed');
  assert.equal(await reason({ shopDomain: 'a.myshopify.com', env: {} }), 'no_redis_uri');
  assert.equal(await reason({ shopDomain: '' }), 'no_shop_domain');
});

test('the by-ids inventory query uses the same aggregation without ranking', () => {
  const { sql, params, meta } = queryBuilder.buildInventoryProductsByIdsQuery({ tenantId: 'TMC', productIds: ['10', '20', 20, ''] });
  assert.deepEqual(params, ['10', '20']);
  assert.match(sql, /WHERE p\.product_id IN \(\?, \?\)/);
  assert.match(sql, /MIN\(CASE WHEN p\.drr_7d > 0 THEN p\.doh_7d END\) AS doh_7d/);
  assert.match(sql, /GROUP BY p\.product_id/);
  // no ranking or top-K cut here: the cache decides which products and in what order
  assert.doesNotMatch(sql, /ORDER BY SUM\(/);
  assert.doesNotMatch(sql, /LIMIT 50/);
  assert.equal(meta.type, 'inventory_product_by_ids');
  assert.throws(() => queryBuilder.buildInventoryProductsByIdsQuery({ tenantId: 'TMC', productIds: [] }), /at least one product id/);
  assert.throws(() => queryBuilder.buildInventoryProductsByIdsQuery({ productIds: ['1'] }), /tenantId is required/);
});

function inventoryRow(id, title, extra = {}) {
  return { product_id: id, product_title: title, sku: `SKU-${id}`, sku_count: 1, inventory_available: 100, sold_units_7d: 10, drr_7d: 2, doh_7d: 50, updated_at: '2026-10-17T03:00:00Z', ...extra };
}

async function runNode({ meta = {}, cache, rows, dbRows = [inventoryRow('99', 'DB top')] }) {
  const originalExecute = queryExecutor.execute;
  const originalGet = topProductsCache.getTopProducts;
  const executed = [];
  queryExecutor.execute = async (spec) => {
    executed.push(spec.meta.type);
    return { rows: spec.meta.type === 'inventory_product_by_ids' ? rows : dbRows };
  };
  topProductsCache.getTopProducts = async (args) => {
    executed.push('cache');
    if (cache instanceof Error) throw cache;
    return cache;
  };
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  try {
    const result = await recursiveDimensionBreakdownNode(
      { id: 'inv', type: 'recursive_dimension_breakdown', analysis_mode: 'inventory', inventory_report_top_k: 5 },
      { meta: { tenantId: 'TMC', ...meta }, scratch: {} }
    );
    return { result, executed, warnings };
  } finally {
    queryExecutor.execute = originalExecute;
    topProductsCache.getTopProducts = originalGet;
    console.warn = originalWarn;
  }
}

const cached = {
  products: [
    { product_id: '10', product_title: 'First', rank: 1, sales: 900 },
    { product_id: '20', product_title: 'Second', rank: 2, sales: 500 },
    { product_id: '30', product_title: 'Third', rank: 3, sales: 100 }
  ],
  updatedAt: '2026-10-16T18:30:02.000Z'
};

test('top products come from the cache in rank order; stock comes from the DB', async () => {
  const { result, executed, warnings } = await runNode({
    meta: { shopifyDomain: 'the-man-company.myshopify.com' },
    cache: cached,
    // the DB returns them in a different order, and has no row for product 30
    rows: [inventoryRow('20', 'Second', { inventory_available: 11652 }), inventoryRow('10', 'First', { inventory_available: 8420 })]
  });

  assert.deepEqual(executed, ['cache', 'inventory_product_by_ids']);
  assert.equal(warnings.length, 0);
  const report = result.delta.scratch.inventoryReport;
  assert.deepEqual(report.products.map((p) => p.product_id), ['10', '20']);
  assert.deepEqual(report.products.map((p) => p.rank), [1, 2]);
  assert.deepEqual(report.products.map((p) => p.sales_7d), [900, 500]);
  assert.equal(report.products[1].inventory_available, 11652);
  assert.equal(report.top_products_source, 'redis');
  assert.equal(report.top_products_fallback_reason, null);
  assert.equal(report.not_in_inventory_count, 1);
  assert.equal(report.top_products_cache_updated_at, '2026-10-16T18:30:02.000Z');
  assert.equal(result.delta.metrics.inventory_top_products_from_cache, 1);
  assert.equal(result.delta.metrics.inventory_not_in_inventory_products, 1);
});

test('any unusable cache falls back to the DB ranking and the report still builds', async () => {
  for (const reason of ['no_redis_uri', 'connect_failed', 'timeout', 'key_missing', 'stale', 'bad_payload', 'empty']) {
    const { result, executed, warnings } = await runNode({
      meta: { shopifyDomain: 'the-man-company.myshopify.com' },
      cache: new TopProductsCacheError(reason),
      rows: []
    });
    assert.deepEqual(executed, ['cache', 'inventory_product_breakdown'], reason);
    assert.equal(result.status, 'pass', reason);
    const report = result.delta.scratch.inventoryReport;
    assert.equal(report.top_products_source, 'db', reason);
    assert.equal(report.top_products_fallback_reason, reason);
    assert.equal(report.products[0].product_id, '99');
    assert.equal(report.products[0].rank, 1);
    assert.equal(result.delta.metrics.inventory_top_products_from_cache, 0);
    assert.match(warnings[0], new RegExp(`DB fallback: ${reason}`));
  }
});

test('a cache whose products have no inventory rows also falls back; no shop domain skips the cache', async () => {
  const none = await runNode({ meta: { shopifyDomain: 'a.myshopify.com' }, cache: cached, rows: [] });
  assert.deepEqual(none.executed, ['cache', 'inventory_product_by_ids', 'inventory_product_breakdown']);
  assert.equal(none.result.delta.scratch.inventoryReport.top_products_fallback_reason, 'no_inventory_rows');

  const noDomain = await runNode({ meta: {}, cache: cached, rows: [] });
  assert.deepEqual(noDomain.executed, ['inventory_product_breakdown']);
  assert.equal(noDomain.warnings.length, 0);
  assert.equal(noDomain.result.delta.scratch.inventoryReport.top_products_fallback_reason, 'no_shop_domain');
});

test('an unexpected error from the cache layer is not swallowed', async () => {
  await assert.rejects(runNode({ meta: { shopifyDomain: 'a.myshopify.com' }, cache: new TypeError('boom'), rows: [] }), /boom/);
});

test('the inventory email shows a Current Inventory column on desktop, mobile, text and Telegram rows', async () => {
  const { result } = await runNode({
    meta: { shopifyDomain: 'a.myshopify.com' },
    cache: cached,
    rows: [inventoryRow('10', 'First', { inventory_available: 11652, drr_7d: 71.44, doh_7d: 0 }), inventoryRow('20', 'Second', { inventory_available: null })]
  });
  const render = (scratch) => renderEmail({
    format: 'report',
    template: { preset: 'inventory_alert_v1' },
    context: { meta: { tenantId: 'TMC', brandName: 'TMC', timezone: 'UTC' }, scratch },
    subject: 'Inventory'
  });
  // an unknown stock figure must show a dash, not 0
  const scratch = JSON.parse(JSON.stringify(result.delta.scratch));
  scratch.inventoryReport.lowest_doh_products[1].inventory_available = null;
  const rendered = render(scratch);

  assert.match(rendered.html, /<th align="right" style="padding:11px;">Current Inventory<\/th>/);
  // stock cell in the desktop table and again in the mobile card, with a thousands separator
  assert.equal((rendered.html.match(/>11,652</g) || []).length, 2);
  assert.match(rendered.html, /Current Inventory<\/div>/);
  assert.match(rendered.text, /\| Inventory 11,652 \| DRR 71\.44 \| DOH 0\.00 \|/);
  assert.match(rendered.text, /\| Inventory — \|/);

  // the empty-state row spans every column, including the new one
  const empty = JSON.parse(JSON.stringify(result.delta.scratch));
  empty.inventoryReport.lowest_doh_products = [];
  assert.match(render(empty).html, /colspan="7"/);

  const table = rendered.viewModel.tables[0];
  assert.deepEqual(table.columns.map((c) => c.label), ['Product', 'SKU', 'Current Inventory', 'DRR (7 days)', 'DOH (7 days)', 'Status']);
  assert.equal(table.rows[0].cells.length, 6);
  assert.equal(table.rows[0].cells[2].value, '11,652');
});

test('the Shopify domain is normalised and validated', () => {
  assert.deepEqual(normalizeShopifyDomain(' The-Man-Company.myshopify.com '), { ok: true, value: 'the-man-company.myshopify.com' });
  assert.deepEqual(normalizeShopifyDomain(''), { ok: true, value: '' });
  assert.deepEqual(normalizeShopifyDomain(undefined), { ok: true, value: '' });
  for (const bad of ['the-man-company.com', 'https://a.myshopify.com', 'a.myshopify.com/admin', '.myshopify.com', 42]) {
    assert.equal(normalizeShopifyDomain(bad).ok, false, String(bad));
  }
});

test('a rerun never reuses a Shopify domain saved on the earlier run', () => {
  const rerun = normalizeRerunContext({
    meta: { tenantId: 'TMC', shopifyDomain: 'old-store.myshopify.com', currency: 'USD', window: { start: '2026-10-10 00:00:00', end: '2026-10-17 00:00:00' }, baselineWindow: { start: '2026-10-03 00:00:00', end: '2026-10-10 00:00:00' } }
  }, 'UTC');
  assert.equal(rerun.meta.shopifyDomain, undefined);
  assert.equal(rerun.meta.currency, undefined);
  assert.equal(rerun.meta.tenantId, 'TMC');
});
