const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const load = () => import(pathToFileURL(path.join(__dirname, '../ui/src/utils/workflowName.js')).href);

test('a typed name replaces the name inside the pasted JSON', async () => {
  const { applyTypedWorkflowName } = await load();
  const pasted = { name: 'ATC rate drop > 5%(PTS)', workflow_id: 'wf_76ee1c46f032', nodes: [{ id: 'a' }] };
  const result = applyTypedWorkflowName(pasted, '  My New Name  ');
  assert.equal(result.name, 'My New Name');
  assert.deepEqual(result.nodes, pasted.nodes);
  assert.equal(result.workflow_id, 'wf_76ee1c46f032');
});

test('without a typed name the JSON keeps its own name', async () => {
  const { applyTypedWorkflowName } = await load();
  const pasted = { name: 'From JSON', nodes: [] };
  for (const typed of ['', '   ', undefined, null]) {
    assert.equal(applyTypedWorkflowName(pasted, typed).name, 'From JSON');
  }
});

test('a typed name also fills in JSON that has no name', async () => {
  const { applyTypedWorkflowName } = await load();
  assert.equal(applyTypedWorkflowName({ nodes: [] }, 'Typed').name, 'Typed');
});

test('the pasted object is never modified', async () => {
  const { applyTypedWorkflowName } = await load();
  const pasted = { name: 'Original', nodes: [] };
  applyTypedWorkflowName(pasted, 'Changed');
  assert.equal(pasted.name, 'Original');
});

test('JSON that is not an object is passed through untouched', async () => {
  const { applyTypedWorkflowName } = await load();
  assert.equal(applyTypedWorkflowName(null, 'x'), null);
  assert.deepEqual(applyTypedWorkflowName([1, 2], 'x'), [1, 2]);
  assert.equal(applyTypedWorkflowName('text', 'x'), 'text');
});
