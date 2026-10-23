const test = require('node:test');
const assert = require('node:assert/strict');

const queryBuilder = require('../sql/QueryBuilder');
const queryExecutor = require('../sql/QueryExecutor');
const inventoryNode = require('../nodes/RecursiveDimensionBreakdownNode');
const { validateWorkflowDefinition } = require('../server/validation/workflowDefinition');
const { applyTenantToMeta } = require('../server/services/workflowExecutionService');

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
  for (const bad of ['revenue', '', null, 5]) assert.equal(errorsFor(bad).length, 1, String(bad));
});

test('inventory_ranking "units" ranks by units sold from the database and never uses the Redis cache', async () => {
  const original = queryExecutor.execute;
  const queries = [];
  queryExecutor.execute = async (query) => {
    queries.push(query.meta?.type);
    return { rows: [{ product_id: '1', product_title: 'A', sku: 'A-1', sku_count: 1, inventory_available: 10, sold_units_7d: 7, drr_7d: 1, doh_7d: 10, updated_at: '2026-10-22T00:00:00Z' }] };
  };
  try {
    const result = await inventoryNode(
      { id: 'inv', type: 'recursive_dimension_breakdown', analysis_mode: 'inventory', inventory_ranking: 'units' },
      { meta: { tenantId: 'AJMAL', shopifyDomain: 'ajmal.myshopify.com' }, scratch: {} }
    );
    assert.equal(result.status, 'pass');
    assert.deepEqual(queries, ['inventory_product_breakdown'], 'only the units-ranking query ran');
    assert.equal(result.delta.scratch.inventoryReport.top_products_source, 'db');
    assert.equal(result.delta.scratch.inventoryReport.top_products_fallback_reason, 'ranking_by_units');
  } finally {
    queryExecutor.execute = original;
  }
});

test('a run gets its tenant\'s Shopify store from the current tenant setting, not from a stale saved context', () => {
  const withStore = applyTenantToMeta({ tenantId: 'TMC' }, { name: 'The Man Company', settings: { currency: 'INR', shopifyDomain: 'the-man-company.myshopify.com' } });
  assert.equal(withStore.shopifyDomain, 'the-man-company.myshopify.com');
  assert.equal(withStore.brandName, 'The Man Company');
  assert.equal(withStore.currency, 'INR');
  const staleRerun = applyTenantToMeta({ tenantId: 'TMC', shopifyDomain: 'old-store.myshopify.com' }, { name: 'TMC', settings: { currency: 'INR' } });
  assert.equal('shopifyDomain' in staleRerun, false);
});
