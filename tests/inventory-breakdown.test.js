const test = require('node:test');
const assert = require('node:assert/strict');

const queryBuilder = require('../sql/QueryBuilder');
const queryExecutor = require('../sql/QueryExecutor');
const { summarizeSkus } = require('../lib/inventorySkus');
const recursiveDimensionBreakdownNode = require('../nodes/RecursiveDimensionBreakdownNode');

async function runWithRows(rows, def = {}) {
  const original = queryExecutor.execute;
  queryExecutor.execute = async () => ({ rows });
  try {
    return await recursiveDimensionBreakdownNode(
      { id: 'inv', type: 'recursive_dimension_breakdown', analysis_mode: 'inventory', ...def },
      { meta: { tenantId: 'TMC' }, scratch: {} }
    );
  } finally {
    queryExecutor.execute = original;
  }
}

test('inventory query reads the stored DOH and DRR, ignoring variants with no sales', () => {
  const { sql, meta } = queryBuilder.buildInventoryProductQuery({ tenantId: 'TMC', topK: 10 });
  // stored values are used as-is; nothing is recomputed from stock / sales
  assert.match(sql, /MIN\(CASE WHEN p\.drr_7d > 0 THEN p\.doh_7d END\) AS doh_7d/);
  assert.match(sql, /SUM\(p\.drr_7d\) AS drr_7d/);
  assert.doesNotMatch(sql, /inventory_available\)\s*\/\s*NULLIF/);
  // a plain MIN would pick up the 0 stored for variants that don't sell
  assert.doesNotMatch(sql, /MIN\(\s*(p\.)?doh_7d\s*\)/);
  assert.doesNotMatch(sql, /MAX\(\s*(p\.)?product_title\s*\)/);
  assert.match(sql, /ORDER BY t\.updated_at DESC/);
  assert.match(sql, /GROUP BY p\.product_id/);
  assert.match(sql, /LIMIT 10\b/);
  assert.equal(meta.tenantId, 'TMC');
});

test('a product with no sales is "No recent sales", never Critical at 0 days', async () => {
  const result = await runWithRows([
    { product_id: 1, product_title: 'Ultra Soft Men’s Trunks', sku: 'TMC-1', sku_count: 1, inventory_available: 325, sold_units_7d: 0, drr_7d: 0, doh_7d: null },
    { product_id: 2, product_title: 'Beard Oil', sku: 'TMC-2', sku_count: 1, inventory_available: 10, sold_units_7d: 14, drr_7d: 2, doh_7d: 5 },
  ]);
  assert.equal(result.status, 'pass');
  const report = result.delta.scratch.inventoryReport;
  const byId = Object.fromEntries(report.products.map((p) => [p.product_id, p]));
  assert.equal(byId['1'].status, 'No recent sales');
  assert.equal(byId['1'].doh_7d, null);
  assert.equal(byId['2'].status, 'Critical');
  assert.equal(report.critical_count, 1);
  assert.equal(report.no_velocity_count, 1);
  assert.deepEqual(report.lowest_doh_products.map((p) => p.product_id), ['2']);
});

test('SKUs are summarised instead of joined without limit', async () => {
  assert.equal(summarizeSkus('', 0), '—');
  assert.equal(summarizeSkus(null, 0), '—');
  assert.equal(summarizeSkus('A-1', 1), 'A-1');
  assert.equal(summarizeSkus('A-1, A-2, A-3', 3), 'A-1, A-2, A-3');
  assert.equal(summarizeSkus('INT-WEB-004, TMC-WEB-3610, TMC-WEB-4571, TMC-WEB-4572, TMC-WEB-4573', 5), 'INT-WEB-004, TMC-WEB-3610, TMC-WEB-4571 +2 more');
  // the joined list was cut off by group_concat_max_len; the SQL count still wins
  assert.equal(summarizeSkus('A, B, C, D', 40), 'A, B, C +37 more');

  const result = await runWithRows([
    { product_id: 7, product_title: 'Intimo', sku: 'INT-WEB-004, TMC-WEB-3610, TMC-WEB-4571, TMC-WEB-4572', sku_count: 4, inventory_available: 2928, sold_units_7d: 1, drr_7d: 0.14, doh_7d: 20914.29 },
  ]);
  assert.equal(result.delta.scratch.inventoryReport.products[0].sku, 'INT-WEB-004, TMC-WEB-3610, TMC-WEB-4571 +1 more');
});

test('critical and healthy thresholds still classify rolled-up DOH', async () => {
  const result = await runWithRows([
    { product_id: 1, product_title: 'A', sku: 'A', sku_count: 1, inventory_available: 7, sold_units_7d: 7, drr_7d: 1, doh_7d: 7 },
    { product_id: 2, product_title: 'B', sku: 'B', sku_count: 1, inventory_available: 10, sold_units_7d: 7, drr_7d: 1, doh_7d: 10 },
    { product_id: 3, product_title: 'C', sku: 'C', sku_count: 1, inventory_available: 30, sold_units_7d: 7, drr_7d: 1, doh_7d: 30 },
  ], { inventory_report_top_k: 5 });
  const statuses = result.delta.scratch.inventoryReport.products.map((p) => p.status);
  assert.deepEqual(statuses, ['Critical', 'Low stock', 'Healthy']);
});

test('the inventory query runs against the tenant the workflow was run for', async () => {
  const original = queryExecutor.execute;
  const seen = [];
  queryExecutor.execute = async (spec) => { seen.push(spec.meta.tenantId); return { rows: [] }; };
  try {
    for (const tenantId of ['TMC', 'PTS', 'AJMAL']) {
      await recursiveDimensionBreakdownNode(
        { id: 'inv', type: 'recursive_dimension_breakdown', analysis_mode: 'inventory' },
        { meta: { tenantId }, scratch: {} }
      );
    }
  } finally {
    queryExecutor.execute = original;
  }
  assert.deepEqual(seen, ['TMC', 'PTS', 'AJMAL']);
});

test('the inventory query refuses to run without a tenant instead of falling back to another one', () => {
  assert.throws(() => queryBuilder.buildInventoryProductQuery({ tenantId: undefined }), /tenantId is required/);
  assert.throws(() => queryBuilder.buildInventoryProductQuery({ tenantId: '' }), /tenantId is required/);
});

test('a multi-variant product shows the SKU that sets its DOH, the others only counted', () => {
  const { summarizeDohSku } = require('../lib/inventorySkus');
  assert.equal(summarizeDohSku('TMC-1', 'TMC-1, TMC-2, TMC-3', 3), 'TMC-1');
  assert.equal(summarizeDohSku('TMC-1', 'TMC-1', 1), 'TMC-1');
  assert.equal(summarizeDohSku(null, 'A, B', 2), 'A, B', 'no selling variant: plain list');
  assert.equal(summarizeDohSku('', '', 0), '—');
});

test('a product row carries the worst variant\'s own DRR, DOH and stock, not the product total', async () => {
  const row = { product_id: 9, product_title: 'Vitamin C', sku: 'A, B, C', sku_count: 3, doh_sku: 'B',
    inventory_available: 500, sold_units_7d: 700, drr_7d: 100, doh_7d: 0,
    worst_inventory_available: '0', worst_sold_units_7d: '70', worst_drr_7d: '10' };
  const original = queryExecutor.execute;
  queryExecutor.execute = async () => ({ rows: [row] });
  try {
    const node = require('../nodes/RecursiveDimensionBreakdownNode');
    const run = node.execute || node.run || node;
    const result = await (typeof run === 'function' ? run : run.execute).call(node, { id: 'inv', type: 'recursive_dimension_breakdown', analysis_mode: 'inventory', top_k: 5 },
      { meta: { tenantId: 'T' }, metrics: {}, breakdowns: {}, scratch: {} });
    const product = result.delta.scratch.inventoryReport.products[0];
    assert.equal(product.sku, 'B');
    assert.equal(product.drr_7d, 10);
    assert.equal(product.inventory_available, 0);
  } finally { queryExecutor.execute = original; }
});
