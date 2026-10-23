const test = require('node:test');
const assert = require('node:assert/strict');

const Tenant = require('../server/models/Tenant');
const WorkflowVersion = require('../server/models/WorkflowVersion');
const { resolveScopeChange, applyScopeChange } = require('../server/services/workflowScopeService');

function stubTenants(ids) {
  Tenant.find = () => ({ select: () => ({ lean: async () => ids.map((tenantId) => ({ tenantId })) }) });
}

function stubVersions() {
  const calls = [];
  WorkflowVersion.updateMany = async (filter, update) => { calls.push({ filter, update }); return {}; };
  return calls;
}

const fakeWorkflow = (fields) => ({ workflowId: 'wf_1', saved: 0, async save() { this.saved += 1; return this; }, ...fields });

test('global scope needs no tenants and clears the trigger brands', async () => {
  const change = await resolveScopeChange({ scope: 'global', tenantIds: ['A'] });
  assert.deepEqual(change, { scope: 'global', tenantId: null, tenantIds: [], brandScope: 'global', brandIds: [] });
});

test('one tenant is single, several are multiple, with the trigger following', async () => {
  stubTenants(['A']);
  assert.deepEqual(await resolveScopeChange({ scope: 'single', tenantIds: ['A'] }),
    { scope: 'tenant', tenantId: null, tenantIds: ['A'], brandScope: 'single', brandIds: ['A'] });
  stubTenants(['A', 'B']);
  const multi = await resolveScopeChange({ scope: 'multiple', tenantIds: ['A', 'B', 'A'] });
  assert.deepEqual(multi.tenantIds, ['A', 'B']);
  assert.equal(multi.brandScope, 'multiple');
});

test('bad requests are refused with a 400', async () => {
  stubTenants(['A']);
  await assert.rejects(() => resolveScopeChange({ scope: 'nope' }), { status: 400 });
  await assert.rejects(() => resolveScopeChange({ scope: 'multiple', tenantIds: [] }), { status: 400 });
  await assert.rejects(() => resolveScopeChange({ scope: 'single', tenantIds: ['A', 'B'] }), { status: 400 });
  await assert.rejects(() => resolveScopeChange({ scope: 'multiple', tenantIds: ['A', 'GHOST'] }), { status: 400, message: /GHOST/ });
});

test('tenant -> global rewrites the workflow and every version', async () => {
  const calls = stubVersions();
  const workflow = fakeWorkflow({ scope: 'tenant', tenantId: null, tenantIds: ['A'] });
  await applyScopeChange(workflow, await resolveScopeChange({ scope: 'global' }));
  assert.equal(workflow.scope, 'global');
  assert.equal(workflow.tenantId, null);
  assert.deepEqual(workflow.tenantIds, []);
  assert.equal(workflow.saved, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filter.workflowId, 'wf_1');
  assert.equal(calls[0].update.$set.scope, 'global');
  assert.equal(calls[0].update.$set['definitionJson.trigger.brandScope'], 'global');
  assert.deepEqual(calls[0].update.$set['definitionJson.trigger.brandIds'], []);
});

test('global -> selected tenants targets only the global versions', async () => {
  stubTenants(['A', 'B']);
  const calls = stubVersions();
  const workflow = fakeWorkflow({ scope: 'global', tenantId: null, tenantIds: [] });
  await applyScopeChange(workflow, await resolveScopeChange({ scope: 'multiple', tenantIds: ['A', 'B'] }));
  assert.equal(calls[0].filter.scope, 'global');
  assert.equal(calls[0].filter.tenantId, null);
  assert.deepEqual(workflow.tenantIds, ['A', 'B']);
  assert.equal(workflow.scope, 'tenant');
  assert.equal(calls[0].update.$set['definitionJson.trigger.brandScope'], 'multiple');
});
