const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const load = () => import(pathToFileURL(path.join(__dirname, '../ui/src/utils/unsavedChanges.js')).href);

test('navigation is blocked only when dirty and leaving the current page', async () => {
  const { shouldBlockNavigation } = await load();
  assert.equal(shouldBlockNavigation({ isDirty: true, currentPathname: '/workflows/a/edit/visual', nextPathname: '/workflows' }), true);
  assert.equal(shouldBlockNavigation({ isDirty: false, currentPathname: '/workflows/a/edit/visual', nextPathname: '/workflows' }), false);
  // query-string-only change stays on the same page
  assert.equal(shouldBlockNavigation({ isDirty: true, currentPathname: '/workflows/a/edit/visual', nextPathname: '/workflows/a/edit/visual' }), false);
});

test('saving an existing workflow requires unsaved changes', async () => {
  const { canSaveWorkflow } = await load();
  assert.equal(canSaveWorkflow({ isEditing: true, isDirty: false }), false);
  assert.equal(canSaveWorkflow({ isEditing: true, isDirty: true }), true);
});

test('new workflows and restored historical versions can save without edits', async () => {
  const { canSaveWorkflow } = await load();
  assert.equal(canSaveWorkflow({ isEditing: false, isDirty: false }), true);
  assert.equal(canSaveWorkflow({ isEditing: true, isDirty: false, allowSaveWithoutChanges: true }), true);
});

test('a refetch of the same workflow does not reset unsaved edits', async () => {
  const { shouldResetFromServer } = await load();
  assert.equal(shouldResetFromServer({ isDirty: true, loadedWorkflowId: 'wf_1', incomingWorkflowId: 'wf_1' }), false);
  assert.equal(shouldResetFromServer({ isDirty: false, loadedWorkflowId: 'wf_1', incomingWorkflowId: 'wf_1' }), true);
  assert.equal(shouldResetFromServer({ isDirty: true, loadedWorkflowId: 'wf_1', incomingWorkflowId: 'wf_2' }), true);
  // new-workflow template has no id on either side
  assert.equal(shouldResetFromServer({ isDirty: true, loadedWorkflowId: undefined, incomingWorkflowId: undefined }), false);
  assert.equal(shouldResetFromServer({ isDirty: false, loadedWorkflowId: null, incomingWorkflowId: 'wf_1' }), true);
});
