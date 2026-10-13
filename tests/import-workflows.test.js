const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const load = () => import(pathToFileURL(path.join(__dirname, '../ui/src/utils/importWorkflows.js')).href);

test('import workflow options drop inactive and id-less workflows and sort by name', async () => {
  const { buildImportWorkflowOptions } = await load();
  const options = buildImportWorkflowOptions([
    { workflowId: 'wf_b', name: 'Zeta', scope: 'global', latestVersion: 3 },
    { workflowId: 'wf_a', name: 'alpha' },
    { workflowId: 'wf_off', name: 'Off', isActive: false },
    { name: 'No id' },
    { workflowId: 'wf_noname' },
  ]);
  assert.deepEqual(options.map((o) => o.workflowId), ['wf_a', 'wf_noname', 'wf_b']);
  assert.equal(options[2].scope, 'global');
  assert.equal(options[0].scope, 'tenant');
  assert.equal(options[1].name, 'wf_noname');
  assert.deepEqual(buildImportWorkflowOptions(undefined), []);
});

test('tenant options are sorted, labelled with their name and skip entries without an id', async () => {
  const { buildImportTenantOptions } = await load();
  const options = buildImportTenantOptions([
    { tenantId: 'TMC', name: 'The Moms Co' },
    { tenantId: 'ACME', name: 'ACME' },
    { name: 'broken' },
    { tenantId: 'ZED' },
  ]);
  assert.deepEqual(options.map((o) => o.tenantId), ['ACME', 'TMC', 'ZED']);
  assert.equal(options[0].label, 'ACME');
  assert.equal(options[1].label, 'TMC — The Moms Co');
  assert.deepEqual(buildImportTenantOptions(null), []);
});

test('import dialog starts on the current tenant, else the first one', async () => {
  const { pickInitialImportTenant } = await load();
  const options = [{ tenantId: 'A' }, { tenantId: 'B' }];
  assert.equal(pickInitialImportTenant(options, 'B'), 'B');
  assert.equal(pickInitialImportTenant(options, 'MISSING'), 'A');
  assert.equal(pickInitialImportTenant([], 'B'), '');
});
