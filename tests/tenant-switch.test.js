const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const load = () => import(pathToFileURL(path.join(__dirname, '../ui/src/utils/tenantSwitch.js')).href);

test('switching tenant from a workflow page opens the workflow list', async () => {
  const { planTenantSwitch } = await load();
  for (const pathname of [
    '/workflows/wf_99f5333c105f/edit/visual',
    '/workflows/wf_99f5333c105f',
    '/workflows/wf_99f5333c105f/runs/abc',
    '/workflows/new/visual',
    '/runs',
    '/insights',
    '/settings',
  ]) {
    assert.deepEqual(
      planTenantSwitch({ nextTenantId: 'PTS', currentTenantId: 'AJMAL', pathname, isDirty: false }),
      { setTenantNow: true, navigateTo: '/workflows', deferTenantChange: false },
      pathname
    );
  }
});

test('already on the workflow list: just change the tenant, no navigation', async () => {
  const { planTenantSwitch } = await load();
  for (const pathname of ['/workflows', '/workflows/']) {
    assert.deepEqual(
      planTenantSwitch({ nextTenantId: 'PTS', currentTenantId: 'AJMAL', pathname, isDirty: false }),
      { setTenantNow: true, navigateTo: null, deferTenantChange: false }
    );
  }
});

test('picking the current tenant does nothing', async () => {
  const { planTenantSwitch } = await load();
  assert.deepEqual(
    planTenantSwitch({ nextTenantId: 'AJMAL', currentTenantId: 'AJMAL', pathname: '/workflows/x/edit/visual', isDirty: false }),
    { setTenantNow: false, navigateTo: null, deferTenantChange: false }
  );
  assert.deepEqual(
    planTenantSwitch({ nextTenantId: '', currentTenantId: 'AJMAL', pathname: '/workflows', isDirty: false }),
    { setTenantNow: false, navigateTo: null, deferTenantChange: false }
  );
});

test('with unsaved edits the tenant change waits until the unsaved-changes prompt is resolved', async () => {
  const { planTenantSwitch } = await load();
  assert.deepEqual(
    planTenantSwitch({ nextTenantId: 'PTS', currentTenantId: 'AJMAL', pathname: '/workflows/wf_1/edit/visual', isDirty: true }),
    { setTenantNow: false, navigateTo: '/workflows', deferTenantChange: true }
  );
});

test('unsaved edits do not matter once already on the workflow list', async () => {
  const { planTenantSwitch } = await load();
  assert.deepEqual(
    planTenantSwitch({ nextTenantId: 'PTS', currentTenantId: 'AJMAL', pathname: '/workflows', isDirty: true }),
    { setTenantNow: true, navigateTo: null, deferTenantChange: false }
  );
});
