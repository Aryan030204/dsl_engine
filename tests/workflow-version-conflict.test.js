const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const Workflow = require('../server/models/Workflow');
const WorkflowVersion = require('../server/models/WorkflowVersion');
const Tenant = require('../server/models/Tenant');
const { saveNewVersion, compareVersions } = require('../server/services/workflowVersionService');

const duplicateKey = () => Object.assign(new Error('E11000 duplicate key error collection: dsl_engine.workflowversions'), { code: 11000 });

function stubVersions({ existing = [], failCreateWith = null } = {}) {
  const store = existing.map((version, index) => ({ _id: `v${index}`, version }));
  const calls = { created: [], deleted: [] };
  const original = { create: WorkflowVersion.create, find: WorkflowVersion.find, deleteOne: WorkflowVersion.deleteOne };
  WorkflowVersion.create = async (doc) => {
    if (failCreateWith) throw failCreateWith;
    if (store.some((entry) => entry.version === doc.version)) throw duplicateKey();
    const entry = { _id: `new-${doc.version}`, ...doc };
    store.push(entry);
    calls.created.push(doc.version);
    return entry;
  };
  WorkflowVersion.find = () => ({ select: () => ({ lean: async () => store.map(({ version }) => ({ version })) }) });
  WorkflowVersion.deleteOne = async ({ _id }) => { calls.deleted.push(_id); return {}; };
  return { calls, restore: () => Object.assign(WorkflowVersion, original) };
}

const fakeWorkflow = (fields = {}) => ({
  workflowId: 'wf_1', scope: 'tenant', tenantId: null, tenantIds: ['VAMA'], latestVersion: '1.2', name: 'Old', saves: 0,
  async save() { this.saves += 1; return this; },
  ...fields,
});

test('versions compare as numbers, so 1.10 is newer than 1.9', () => {
  assert.equal(compareVersions('1.10', '1.9'), 1);
  assert.equal(compareVersions('1.3', '1.3'), 0);
  assert.equal(compareVersions('2.0', '1.99'), 1);
  assert.equal(compareVersions('1', '1.0'), 0);
});

test('a new version is stored and the workflow moves to it, with its name', async () => {
  const versions = stubVersions({ existing: ['1.0', '1.1', '1.2'] });
  try {
    const workflow = fakeWorkflow();
    await saveNewVersion({ workflow, version: '1.3', name: 'New name', versionFields: { workflowId: 'wf_1' } });
    assert.equal(workflow.latestVersion, '1.3');
    assert.equal(workflow.name, 'New name');
    assert.deepEqual(versions.calls.created, ['1.3']);
  } finally {
    versions.restore();
  }
});

test('saving a version number that already exists is a 409 conflict naming the latest version, not a raw database error', async () => {
  const versions = stubVersions({ existing: ['1.0', '1.1', '1.2', '1.3'] });
  try {
    const workflow = fakeWorkflow({ latestVersion: '1.3' });
    await assert.rejects(
      () => saveNewVersion({ workflow, version: '1.3', versionFields: { workflowId: 'wf_1' } }),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, 'workflow_version_conflict');
        assert.equal(error.latestVersion, '1.3');
        assert.match(error.message, /newer version .*1\.3.*Reload/);
        assert.doesNotMatch(error.message, /E11000/);
        return true;
      }
    );
    assert.equal(workflow.saves, 0, 'nothing is rewritten when the pointer was already right');
  } finally {
    versions.restore();
  }
});

test('a workflow whose latestVersion was left behind by an earlier half-finished save is moved up to the real latest', async () => {
  // version 1.3 exists, but the workflow still says 1.2 (the second step of an earlier save failed)
  const versions = stubVersions({ existing: ['1.0', '1.1', '1.2', '1.3'] });
  try {
    const workflow = fakeWorkflow({ latestVersion: '1.2' });
    await assert.rejects(() => saveNewVersion({ workflow, version: '1.3', versionFields: {} }), { status: 409, latestVersion: '1.3' });
    assert.equal(workflow.latestVersion, '1.3', 'healed, so a reload shows 1.3 and the next save asks for 1.4');
    assert.equal(workflow.saves, 1);
  } finally {
    versions.restore();
  }
});

test('the highest version wins even when it is not the one asked for (1.10 vs 1.9)', async () => {
  const versions = stubVersions({ existing: ['1.9', '1.10'] });
  try {
    const workflow = fakeWorkflow({ latestVersion: '1.9' });
    await assert.rejects(() => saveNewVersion({ workflow, version: '1.9', versionFields: {} }), { status: 409, latestVersion: '1.10' });
    assert.equal(workflow.latestVersion, '1.10');
  } finally {
    versions.restore();
  }
});

test('if the workflow cannot be updated after the version was stored, the new version is removed again', async () => {
  const versions = stubVersions({ existing: ['1.2'] });
  try {
    const workflow = fakeWorkflow({ async save() { throw new Error('mongo went away'); } });
    await assert.rejects(() => saveNewVersion({ workflow, version: '1.3', versionFields: {} }), /mongo went away/);
    assert.deepEqual(versions.calls.deleted, ['new-1.3'], 'no orphan version is left behind');
  } finally {
    versions.restore();
  }
});

test('other database errors are passed through untouched', async () => {
  const versions = stubVersions({ failCreateWith: new Error('connection reset') });
  try {
    await assert.rejects(() => saveNewVersion({ workflow: fakeWorkflow(), version: '1.3', versionFields: {} }), /connection reset/);
  } finally {
    versions.restore();
  }
});

// ------------------------------------------------------------------ over HTTP (what the page receives)

test('the versions route answers 409 with a code and the latest version for a duplicate', async () => {
  const originals = { tenantFindOne: Tenant.findOne, workflowFindOne: Workflow.findOne };
  const versions = stubVersions({ existing: ['1.0', '1.1', '1.2', '1.3'] });
  const workflow = fakeWorkflow({ latestVersion: '1.3' });
  Tenant.findOne = async () => ({ tenantId: 'VAMA', isActive: true });
  Workflow.findOne = async () => workflow;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { role: 'admin', tenantIds: [] }; next(); });
  app.use('/tenants/:tenantId/workflows', require('../server/routes/workflows'));
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({
      error: err.message,
      ...(err.code === 'workflow_version_conflict' ? { code: err.code, latestVersion: err.latestVersion } : {}),
    });
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const definition = {
      workflow_id: 'wf_1', workflow_type: 'root_cause_analysis', version: '1.3', name: 'W',
      trigger: { type: 'alert', alertType: 'cvr_drop', brandScope: 'single', brandIds: ['VAMA'] },
      nodes: [{ id: 'm', type: 'metric_compare', metrics: ['cvr'] }],
    };
    const res = await fetch(`http://127.0.0.1:${server.address().port}/tenants/VAMA/workflows/wf_1/versions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(definition),
    });
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.equal(body.code, 'workflow_version_conflict');
    assert.equal(body.latestVersion, '1.3');
    assert.doesNotMatch(body.error, /E11000/);
  } finally {
    Tenant.findOne = originals.tenantFindOne;
    Workflow.findOne = originals.workflowFindOne;
    versions.restore();
    await new Promise((resolve) => server.close(resolve));
  }
});

// ------------------------------------------------------------------ the page's next version number

test('the next version is one step above the newest version the page knows, not just the one inside the definition', async () => {
  const { nextWorkflowVersion } = await import(require('node:url').pathToFileURL(require('node:path').join(__dirname, '../ui/src/utils/workflowVersion.js')).href);
  // the definition inside the latest version still says 1.1 although the workflow is at 1.2: asking for 1.2 again was the bug
  assert.equal(nextWorkflowVersion({ latestVersion: '1.2', definitionVersion: '1.1' }), '1.3');
  assert.equal(nextWorkflowVersion({ definitionVersion: '1.1', versions: [{ version: '1.0' }, { version: '1.2' }] }), '1.3');
  assert.equal(nextWorkflowVersion({ latestVersion: '1.9', versions: [{ version: '1.10' }] }), '1.11', 'numeric, so 1.10 is newer than 1.9');
  assert.equal(nextWorkflowVersion({ latestVersion: '2.0' }), '2.1');
  assert.equal(nextWorkflowVersion({}), '1.1');
  assert.equal(nextWorkflowVersion({ latestVersion: '1.2', definitionVersion: '1.3' }), '1.4');
});

// ------------------------------------------------------------------ per-tenant copies that share a workflowId

test('a per-tenant copy of a shared workflowId keeps its versions under its own tenant, so other tenants never collide with it', async () => {
  const { getVersionTenantId } = require('../server/services/workflowResolverService');
  // legacy copies: one Workflow document per tenant, all with the same workflowId (wf_1c1af41ac506 in production)
  assert.equal(getVersionTenantId({ tenantId: 'TMC', tenantIds: ['TMC'] }), 'TMC');
  assert.equal(getVersionTenantId({ tenantId: 'VAMA', tenantIds: ['VAMA'] }), 'VAMA');
  // a document of its own (unique workflowId), for one or many tenants, is unchanged
  assert.equal(getVersionTenantId({ tenantId: null, tenantIds: ['BBB'] }), null);
  assert.equal(getVersionTenantId({ tenantId: null, tenantIds: ['A', 'B'] }), null);
  assert.equal(getVersionTenantId({}), null);

  // and the route stores that tenantId on the new version
  const originals = { tenantFindOne: Tenant.findOne, workflowFindOne: Workflow.findOne, create: WorkflowVersion.create };
  const created = [];
  WorkflowVersion.create = async (doc) => { created.push(doc); return doc; };
  Tenant.findOne = async () => ({ tenantId: 'TMC', isActive: true });
  const workflow = fakeWorkflow({ tenantId: 'TMC', tenantIds: ['TMC'], latestVersion: '1.2' });
  Workflow.findOne = async () => workflow;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { role: 'admin', tenantIds: [] }; next(); });
  app.use('/tenants/:tenantId/workflows', require('../server/routes/workflows'));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const definition = {
      workflow_id: 'wf_1', workflow_type: 'root_cause_analysis', version: '1.3', name: 'W',
      trigger: { type: 'alert', alertType: 'cvr_drop', brandScope: 'single', brandIds: ['TMC'] },
      nodes: [{ id: 'm', type: 'metric_compare', metrics: ['cvr'] }],
    };
    const res = await fetch(`http://127.0.0.1:${server.address().port}/tenants/TMC/workflows/wf_1/versions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(definition),
    });
    assert.equal(res.status, 201);
    assert.equal(created.length, 1);
    assert.equal(created[0].tenantId, 'TMC', 'stored under TMC, not the shared null namespace');
    assert.deepEqual(created[0].tenantIds, ['TMC']);
    assert.equal(workflow.latestVersion, '1.3');
  } finally {
    Tenant.findOne = originals.tenantFindOne;
    Workflow.findOne = originals.workflowFindOne;
    WorkflowVersion.create = originals.create;
    await new Promise((resolve) => server.close(resolve));
  }
});
