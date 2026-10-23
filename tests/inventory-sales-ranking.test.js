const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const redisSales = require('../lib/redisSales');
const queryBuilder = require('../sql/QueryBuilder');
const queryExecutor = require('../sql/QueryExecutor');
const inventoryNode = require('../nodes/RecursiveDimensionBreakdownNode');
const { validateWorkflowDefinition } = require('../server/validation/workflowDefinition');
const Tenant = require('../server/models/Tenant');
const WorkflowSchedule = require('../server/models/WorkflowSchedule');
const { applyTenantToMeta } = require('../server/services/workflowExecutionService');

const { RedisSalesUnavailableError } = redisSales;
const NOW = Date.parse('2026-10-22T06:00:00Z');

// the shape the data pipeline writes to Redis
const salesPayload = (overrides = {}) => JSON.stringify({
  window_start_date: '2026-10-15',
  window_end_date_exclusive: '2026-10-22',
  updated_at: '2026-10-21T18:30:04Z',
  products: [
    { product_id: '8490730815658', product_title: 'Oud Series Perfume', sales: 2476507, rank: 1, source_rows: [{ product_variant_id: '1', gross_sales: 2476507 }] },
    { product_id: '8308792164522', product_title: 'Oud on the Rocks', sales: 1122820, rank: 2, source_rows: [{ product_variant_id: '2', gross_sales: 1000000 }, { product_variant_id: '3', gross_sales: 122820 }] },
    { product_id: '7771111111111', product_title: 'WISAL DHAHAB', sales: 192700, rank: 3, source_rows: [{ product_variant_id: '4', gross_sales: 192700 }] },
  ],
  ...overrides,
});

// ---------------------------------------------------------------- the Redis reader

test('the Redis payload is parsed into products ranked by sales, with the 7-day window', () => {
  const result = redisSales.parseSalesPayload(salesPayload(), { now: NOW });
  assert.deepEqual(result.products.map((p) => p.product_id), ['8490730815658', '8308792164522', '7771111111111']);
  assert.deepEqual(result.products.map((p) => p.rank), [1, 2, 3]);
  assert.equal(result.products[0].sales, 2476507);
  assert.equal(result.products[0].product_title, 'Oud Series Perfume');
  assert.equal(result.windowStart, '2026-10-15');
  assert.equal(result.windowEnd, '2026-10-22');
  assert.equal(result.updatedAt, '2026-10-21T18:30:04Z');
});

test('products are re-ranked by sales even if the stored order is off, ties keep the stored order', () => {
  const payload = JSON.stringify({
    updated_at: '2026-10-21T18:30:04Z',
    products: [
      { product_id: '1', sales: 10 },
      { product_id: '2', sales: 50 },
      { product_id: '3', sales: 10 },
    ],
  });
  const result = redisSales.parseSalesPayload(payload, { now: NOW });
  assert.deepEqual(result.products.map((p) => p.product_id), ['2', '1', '3']);
  assert.deepEqual(result.products.map((p) => p.rank), [1, 2, 3]);
});

test('sales falls back to the sum of the variant rows, and bad or repeated product ids are skipped', () => {
  const payload = JSON.stringify({
    products: [
      { product_id: '10', source_rows: [{ gross_sales: 30 }, { gross_sales: 20 }] },
      { product_id: '10', sales: 999 },
      { product_id: 'gid://shopify/Product/5', sales: 5 },
      { product_id: '', sales: 5 },
      { sales: 5 },
      { product_id: 11, sales: 7 },
    ],
  });
  const result = redisSales.parseSalesPayload(payload, { now: NOW });
  assert.deepEqual(result.products.map((p) => [p.product_id, p.sales]), [['10', 50], ['11', 7]]);
});

test('unusable Redis data is reported with a reason', () => {
  const reasonOf = (raw, options = { now: NOW }) => {
    try { redisSales.parseSalesPayload(raw, options); } catch (error) {
      assert.ok(error instanceof RedisSalesUnavailableError);
      return error.reason;
    }
    return 'no error';
  };
  assert.match(reasonOf('not json'), /not valid JSON/);
  assert.match(reasonOf('[1,2]'), /unexpected shape/);
  assert.match(reasonOf('{"products":"x"}'), /unexpected shape/);
  assert.match(reasonOf('null'), /unexpected shape/);
  assert.match(reasonOf('{"products":[]}'), /no products/);
  assert.match(reasonOf('{"products":[{"product_id":"abc"}]}'), /no products/);
  assert.match(reasonOf(salesPayload({ updated_at: '2026-10-10T00:00:00Z' })), /stale/);
});

test('data a day old is fine, and data without an updated_at is not treated as stale', () => {
  assert.doesNotThrow(() => redisSales.parseSalesPayload(salesPayload({ updated_at: '2026-10-21T00:00:00Z' }), { now: NOW }));
  assert.doesNotThrow(() => redisSales.parseSalesPayload(salesPayload({ updated_at: undefined }), { now: NOW }));
});

test('store domains are normalised, and only myshopify.com domains are accepted', () => {
  const n = redisSales.normalizeStoreDomain;
  assert.equal(n('The-Man-Company.myshopify.com'), 'the-man-company.myshopify.com');
  assert.equal(n('  https://acme.myshopify.com/ '), 'acme.myshopify.com');
  for (const bad of ['', '   ', null, undefined, 42, 'acme.com', 'acme.myshopify.com.evil.com', 'a b.myshopify.com', 'acme.myshopify.com:443/x', '../x.myshopify.com']) {
    assert.equal(n(bad), '', String(bad));
  }
});

test('getTopProductSales reads the store\'s own key and explains every way it can come up empty', async () => {
  const seen = [];
  const fetchRaw = async (key) => { seen.push(key); return salesPayload(); };
  const result = await redisSales.getTopProductSales('HTTPS://Ajmal-Perfumes-India.myshopify.com/', { fetchRaw, now: NOW });
  assert.deepEqual(seen, ['inventory_top_product_sales:ajmal-perfumes-india.myshopify.com']);
  assert.equal(result.products.length, 3);

  const reasonOf = async (domain, fetch) => {
    try { await redisSales.getTopProductSales(domain, { fetchRaw: fetch, now: NOW }); } catch (error) {
      assert.ok(error instanceof RedisSalesUnavailableError, error.message);
      return error.reason;
    }
    return 'no error';
  };
  assert.match(await reasonOf(undefined, fetchRaw), /no valid Shopify store domain/);
  assert.match(await reasonOf('acme.com', fetchRaw), /no valid Shopify store domain/);
  assert.match(await reasonOf('acme.myshopify.com', async () => null), /no sales data in Redis for acme\.myshopify\.com/);
  assert.match(await reasonOf('acme.myshopify.com', async () => ''), /no sales data in Redis/);
  assert.match(await reasonOf('acme.myshopify.com', async () => { throw new RedisSalesUnavailableError('could not read Redis (timeout)'); }), /could not read Redis/);
});

test('without REDIS_URI the default reader says so instead of crashing', async () => {
  const saved = process.env.REDIS_URI;
  delete process.env.REDIS_URI;
  try {
    await assert.rejects(() => redisSales.getTopProductSales('acme.myshopify.com'), (error) => error instanceof RedisSalesUnavailableError && /REDIS_URI is not configured/.test(error.reason));
  } finally {
    if (saved !== undefined) process.env.REDIS_URI = saved;
  }
});

// ---------------------------------------------------------------- the query

test('the inventory query can be limited to given product ids, safely', () => {
  const plain = queryBuilder.buildInventoryProductQuery({ tenantId: 'AJMAL', topK: 10 });
  assert.doesNotMatch(plain.sql, /p\.product_id IN/, 'the plain query has no product filter');
  assert.deepEqual(plain.params, []);
  assert.match(plain.sql, /LIMIT 10\b/);

  const limited = queryBuilder.buildInventoryProductQuery({ tenantId: 'AJMAL', topK: 10, productIds: ['5', 7, '5', '9; DROP TABLE x', 'abc', ' 12 '] });
  assert.match(limited.sql, /WHERE p\.product_id IN \(\?\)/);
  assert.deepEqual(limited.params, [['5', '7', '12']]);
  assert.match(limited.sql, /LIMIT 3\b/);
  assert.doesNotMatch(limited.sql, /DROP/);
  assert.equal(limited.meta.tenantId, 'AJMAL');

  assert.throws(() => queryBuilder.buildInventoryProductQuery({ tenantId: 'AJMAL', productIds: [] }), /no valid product ids/);
  assert.throws(() => queryBuilder.buildInventoryProductQuery({ tenantId: 'AJMAL', productIds: ['x'] }), /no valid product ids/);
});

// ---------------------------------------------------------------- the node

const row = (id, title, { stock = 100, sold = 10, drr = 2, doh = 50 } = {}) => ({
  product_id: id, product_title: title, sku: `SKU-${id}`, sku_count: 1,
  inventory_available: stock, sold_units_7d: sold, drr_7d: drr, doh_7d: doh,
});

// stubs the database and the Redis reader, runs the node, restores both
async function runNode(def, { sales, tableRows, redisError } = {}) {
  const originalExecute = queryExecutor.execute;
  const originalSales = redisSales.getTopProductSales;
  const queries = [];
  const redisCalls = [];
  queryExecutor.execute = async (spec) => {
    queries.push(spec);
    const ids = spec.params[0];
    // rows come back in the "wrong" (reversed) order, as a database may return them
    return { rows: Array.isArray(ids) ? tableRows.filter((r) => ids.includes(String(r.product_id))).reverse() : tableRows };
  };
  redisSales.getTopProductSales = async (domain) => {
    redisCalls.push(domain);
    if (redisError) throw redisError;
    return sales;
  };
  try {
    const result = await inventoryNode(
      { id: 'inv', type: 'recursive_dimension_breakdown', analysis_mode: 'inventory', ...def },
      { meta: { tenantId: 'AJMAL', shopifyDomain: 'ajmal-perfumes-india.myshopify.com' }, scratch: {} }
    );
    return { result, queries, redisCalls, report: result.delta?.scratch?.inventoryReport };
  } finally {
    queryExecutor.execute = originalExecute;
    redisSales.getTopProductSales = originalSales;
  }
}

const ranking = (...ids) => ({
  products: ids.map((id, index) => ({ product_id: String(id), product_title: `P${id}`, sales: 1000 - index * 100, rank: index + 1 })),
  windowStart: '2026-10-15', windowEnd: '2026-10-22', updatedAt: '2026-10-21T18:30:04Z',
});
const tableRows = [
  row(1, 'Alpha', { doh: 3, drr: 5, stock: 15 }),      // Critical
  row(2, 'Beta', { doh: 10, drr: 4, stock: 40 }),      // Low stock
  row(3, 'Gamma', { doh: 60, drr: 1, stock: 60 }),     // Healthy
  row(4, 'Delta (gift)', { doh: 0, drr: 99, stock: 0, sold: 99999 }), // a high-units gift/bundle, not in the sales ranking
];

test('sales ranking: the products are the ones Redis ranks, in Redis order, with their sales', async () => {
  const { result, queries, redisCalls, report } = await runNode({ inventory_ranking: 'sales' }, { sales: ranking(3, 1, 2), tableRows });
  assert.equal(result.status, 'pass');
  assert.deepEqual(redisCalls, ['ajmal-perfumes-india.myshopify.com']);
  assert.deepEqual(queries[0].params, [['3', '1', '2']], 'only the ranked products are read from the table');
  assert.deepEqual(report.products.map((p) => p.product_title), ['Gamma', 'Alpha', 'Beta'], 'Redis order, not the database order');
  assert.deepEqual(report.products.map((p) => p.gross_sales), [1000, 900, 800]);
  assert.deepEqual(report.products.map((p) => p.sales_rank), [1, 2, 3]);
  assert.ok(!report.products.some((p) => /gift/.test(p.product_title)), 'the high-units gift is not picked');
  assert.equal(report.ranking_source, 'sales');
  assert.equal(report.sales_window_start, '2026-10-15');
  assert.equal(report.sales_window_end, '2026-10-22');
  assert.equal(report.missing_from_inventory, 0);
  assert.equal(report.ranking_fallback_reason, undefined);
});

test('sales ranking: stock, DOH, statuses and counts are computed exactly as before', async () => {
  const { report, result } = await runNode({ inventory_ranking: 'sales' }, { sales: ranking(1, 2, 3), tableRows });
  assert.deepEqual(report.products.map((p) => p.status), ['Critical', 'Low stock', 'Healthy']);
  assert.equal(report.analyzed_count, 3);
  assert.equal(report.critical_count, 1);
  assert.equal(report.medium_count, 1);
  assert.equal(report.healthy_count, 1);
  assert.deepEqual(report.lowest_doh_products.map((p) => p.product_title), ['Alpha', 'Beta'], 'lowest DOH first, report_top_k = 2');
  assert.deepEqual(Object.keys(result.delta.metrics).sort(), [
    'inventory_critical_products', 'inventory_healthy_products', 'inventory_medium_products', 'inventory_no_velocity_products', 'inventory_products_analyzed',
  ]);
  assert.ok(result.delta.breakdowns.inventory_top_products && result.delta.breakdowns.inventory_top_products_lowest_doh);
});

test('sales ranking: the top-N setting cuts the Redis list', async () => {
  const { queries, report } = await runNode({ inventory_ranking: 'sales', inventory_top_k: 2 }, { sales: ranking(3, 1, 2), tableRows });
  assert.deepEqual(queries[0].params, [['3', '1']]);
  assert.deepEqual(report.products.map((p) => p.product_title), ['Gamma', 'Alpha']);
});

test('sales ranking: products Redis ranks but the table does not have are skipped and counted', async () => {
  const { report } = await runNode({ inventory_ranking: 'sales' }, { sales: ranking(1, 999, 2), tableRows });
  assert.deepEqual(report.products.map((p) => p.product_title), ['Alpha', 'Beta']);
  assert.deepEqual(report.products.map((p) => p.sales_rank), [1, 2], 'ranks are consecutive over what is shown');
  assert.equal(report.missing_from_inventory, 1);
  assert.equal(report.analyzed_count, 2);
});

test('the default is unchanged: without the setting the units ranking runs and Redis is never touched', async () => {
  for (const def of [{}, { inventory_ranking: 'units' }]) {
    const { report, queries, redisCalls } = await runNode(def, { sales: ranking(3, 1, 2), tableRows });
    assert.deepEqual(redisCalls, []);
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].params, [], 'the plain top-N query');
    assert.equal(report.ranking_source, 'units');
    assert.equal(report.products.length, 4, 'every row of the units query');
    assert.equal(report.products[0].gross_sales, undefined);
    assert.equal(report.missing_from_inventory, undefined);
  }
});

test('when Redis cannot be used the report falls back to the units ranking and says why', async () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const reasons = ['no sales data in Redis for ajmal-perfumes-india.myshopify.com', 'could not read Redis (timeout)', 'the sales data in Redis is stale (last updated 2026-10-01)'];
    for (const reason of reasons) {
      const { result, report, queries } = await runNode({ inventory_ranking: 'sales' }, { tableRows, redisError: new RedisSalesUnavailableError(reason) });
      assert.equal(result.status, 'pass', reason);
      assert.equal(report.ranking_source, 'units');
      assert.equal(report.ranking_fallback_reason, reason);
      assert.equal(queries.length, 1);
      assert.deepEqual(queries[0].params, []);
      assert.equal(report.products.length, 4);
    }
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /AJMAL/);
  } finally {
    console.warn = warn;
  }
});

test('if none of Redis\'s products are in the inventory table it also falls back', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { result, report, queries } = await runNode({ inventory_ranking: 'sales' }, { sales: ranking(900, 901), tableRows });
    assert.equal(result.status, 'pass');
    assert.equal(report.ranking_source, 'units');
    assert.match(report.ranking_fallback_reason, /none of the products ranked by sales/);
    assert.equal(queries.length, 2, 'the sales query, then the units query');
  } finally {
    console.warn = warn;
  }
});

test('a real bug is not hidden by the fallback', async () => {
  await assert.rejects(
    () => runNode({ inventory_ranking: 'sales' }, { tableRows, redisError: new TypeError('boom') }),
    /boom/
  );
});

test('a tenant without a store still gets a report (units ranking) instead of a failure', async () => {
  const warn = console.warn;
  console.warn = () => {};
  const originalExecute = queryExecutor.execute;
  queryExecutor.execute = async () => ({ rows: tableRows });
  try {
    const result = await inventoryNode(
      { id: 'inv', type: 'recursive_dimension_breakdown', analysis_mode: 'inventory', inventory_ranking: 'sales' },
      { meta: { tenantId: 'AJMAL' }, scratch: {} }
    );
    assert.equal(result.status, 'pass');
    assert.equal(result.delta.scratch.inventoryReport.ranking_source, 'units');
    assert.match(result.delta.scratch.inventoryReport.ranking_fallback_reason, /no valid Shopify store domain/);
  } finally {
    queryExecutor.execute = originalExecute;
    console.warn = warn;
  }
});

// ---------------------------------------------------------------- workflow validation

test('inventory_ranking accepts sales and units and rejects anything else', () => {
  const definition = (inventory_ranking) => ({
    workflow_type: 'root_cause_analysis', version: '1',
    trigger: { type: 'alert', alertType: 'daily', brandScope: 'single', brandIds: ['AJMAL'] },
    nodes: [{ id: 'inv', type: 'recursive_dimension_breakdown', analysis_mode: 'inventory', ...(inventory_ranking === undefined ? {} : { inventory_ranking }) }],
  });
  const errorsFor = (value) => validateWorkflowDefinition(definition(value)).errors.filter((e) => /inventory_ranking/.test(e));
  assert.deepEqual(errorsFor(undefined), []);
  assert.deepEqual(errorsFor('sales'), []);
  assert.deepEqual(errorsFor('units'), []);
  for (const bad of ['revenue', '', null, 5]) {
    assert.equal(errorsFor(bad).length, 1, String(bad));
  }
});

// ---------------------------------------------------------------- tenant store setting

async function withTenantApi(fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { role: 'admin', tenantIds: [] }; next(); });
  app.use('/tenants', require('../server/routes/tenants'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/tenants`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const originals = { findOne: Tenant.findOne, create: Tenant.create, schedules: WorkflowSchedule.find };
  // a timezone in the settings makes the route re-time the tenant's schedules; there are none here
  WorkflowSchedule.find = async () => [];
  try {
    return await fn(call);
  } finally {
    Tenant.findOne = originals.findOne;
    Tenant.create = originals.create;
    WorkflowSchedule.find = originals.schedules;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('creating a tenant stores a normalised Shopify store, and refuses a bad one', async () => {
  await withTenantApi(async (call) => {
    let created = null;
    Tenant.findOne = async () => null;
    Tenant.create = async (doc) => { created = doc; return doc; };

    const ok = await call('POST', '/', { tenantId: 'tmc', name: 'The Man Company', settings: { currency: 'INR', timezone: 'Asia/Kolkata', shopifyDomain: ' HTTPS://The-Man-Company.myshopify.com/ ' } });
    assert.equal(ok.status, 201);
    assert.equal(created.settings.shopifyDomain, 'the-man-company.myshopify.com');
    assert.equal(created.tenantId, 'TMC');

    created = null;
    const bad = await call('POST', '/', { tenantId: 'x', name: 'X', settings: { shopifyDomain: 'not-a-shop.com' } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Shopify store domain/);
    assert.equal(created, null, 'nothing was created');

    const none = await call('POST', '/', { tenantId: 'y', name: 'Y', settings: { shopifyDomain: '' } });
    assert.equal(none.status, 201);
    assert.equal('shopifyDomain' in created.settings, false, 'an empty value is not stored');
  });
});

test('updating a tenant sets, keeps and clears the Shopify store', async () => {
  await withTenantApi(async (call) => {
    const tenant = { tenantId: 'TMC', settings: { currency: 'INR', timezone: 'Asia/Kolkata' }, async save() { return this; } };
    Tenant.findOne = async () => tenant;

    const set = await call('PATCH', '/TMC', { settings: { shopifyDomain: 'The-Man-Company.myshopify.com' } });
    assert.equal(set.status, 200);
    assert.equal(tenant.settings.shopifyDomain, 'the-man-company.myshopify.com');
    assert.equal(tenant.settings.currency, 'INR', 'other settings are kept');

    // a save from another Settings control sends the whole settings object back
    const other = await call('PATCH', '/TMC', { settings: { ...tenant.settings, currency: 'USD' } });
    assert.equal(other.status, 200);
    assert.equal(tenant.settings.currency, 'USD');
    assert.equal(tenant.settings.shopifyDomain, 'the-man-company.myshopify.com', 'the store survives');

    const invalid = await call('PATCH', '/TMC', { settings: { shopifyDomain: 'nope.example.com' } });
    assert.equal(invalid.status, 400);
    assert.equal(tenant.settings.shopifyDomain, 'the-man-company.myshopify.com', 'a refused change changes nothing');

    const cleared = await call('PATCH', '/TMC', { settings: { ...tenant.settings, shopifyDomain: '' } });
    assert.equal(cleared.status, 200);
    assert.equal('shopifyDomain' in tenant.settings, false, 'emptied');
    assert.equal(tenant.settings.currency, 'USD');
  });
});

// ---------------------------------------------------------------- run context

test('a run gets its tenant\'s Shopify store from the current tenant setting, not from a stale saved context', () => {
  const withStore = applyTenantToMeta({ tenantId: 'TMC' }, { name: 'The Man Company', settings: { currency: 'INR', shopifyDomain: 'the-man-company.myshopify.com' } });
  assert.equal(withStore.shopifyDomain, 'the-man-company.myshopify.com');
  assert.equal(withStore.brandName, 'The Man Company');
  assert.equal(withStore.currency, 'INR');

  const staleRerun = applyTenantToMeta({ tenantId: 'TMC', shopifyDomain: 'old-store.myshopify.com' }, { name: 'TMC', settings: { currency: 'INR' } });
  assert.equal('shopifyDomain' in staleRerun, false, 'a store removed from the tenant is removed from a rerun too');

  const changed = applyTenantToMeta({ shopifyDomain: 'old-store.myshopify.com' }, { settings: { shopifyDomain: 'new-store.myshopify.com' } });
  assert.equal(changed.shopifyDomain, 'new-store.myshopify.com');
});
