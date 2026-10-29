const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const load = () => import(pathToFileURL(path.join(__dirname, '../ui/src/utils/workflowTransformers.js')).href);

const definition = () => ({
  name: 't', workflow_id: 'wf_t', version: '1.1', workflow_type: 'root_cause_analysis',
  nodes: [
    { id: 'a', type: 'insight', template: 'x', next: 'b' },
    { id: 'b', type: 'insight', template: 'y' },
    { id: 'c', type: 'insight', template: 'z' },
    { id: 'br', type: 'branch', rules: [{ _ruleId: 'r1', all: [], then: 'b' }], default: { then: 'b' } },
    { id: 'comp', type: 'composite', steps: ['b', 'c'], next: 'a' }
  ]
});

const draw = (edges, edge) => {
  // what the editor's onConnect does
  const { removeSupersededEdges } = global.__t;
  return [...removeSupersededEdges(edges, edge), edge];
};

const nodeOf = (json, id) => json.nodes.find((node) => node.id === id);

test.before(async () => { global.__t = await load(); });

test('saving a graph and loading it back keeps every connection', async () => {
  const { jsonToGraph, graphToJson } = global.__t;
  const original = definition();
  const { nodes, edges } = jsonToGraph(original);
  const saved = graphToJson(nodes, edges, original);

  assert.equal(nodeOf(saved, 'a').next, 'b');
  assert.equal(nodeOf(saved, 'br').rules[0].then, 'b');
  assert.equal(nodeOf(saved, 'br').default.then, 'b');
  assert.deepEqual(nodeOf(saved, 'comp').steps, ['b', 'c']);
  assert.equal(nodeOf(saved, 'comp').next, 'a');
});

test('drawing a second connection from a node ADDS it: the node now fans out to both targets', async () => {
  const { jsonToGraph, graphToJson } = global.__t;
  const original = definition();
  const { nodes, edges } = jsonToGraph(original);

  const redrawn = draw(edges, { id: 'a-c', source: 'a', target: 'c', type: 'deletable' });
  assert.equal(redrawn.filter((edge) => edge.source === 'a').length, 2, 'the old a -> b line is kept');
  assert.deepEqual(nodeOf(graphToJson(nodes, redrawn, original), 'a').next, ['b', 'c']);

  // and both survive the reload that follows a save
  const reloaded = jsonToGraph(graphToJson(nodes, redrawn, original));
  assert.ok(reloaded.edges.some((edge) => edge.source === 'a' && edge.target === 'c'));
  assert.ok(reloaded.edges.some((edge) => edge.source === 'a' && edge.target === 'b'));
});

test('drawing the same connection twice does not duplicate it, and a single connection still saves as one id', async () => {
  const { jsonToGraph, graphToJson } = global.__t;
  const original = definition();
  const { nodes, edges } = jsonToGraph(original);

  const again = draw(edges, { id: 'a-b-again', source: 'a', target: 'b', type: 'deletable' });
  assert.equal(again.filter((edge) => edge.source === 'a').length, 1);
  assert.equal(nodeOf(graphToJson(nodes, again, original), 'a').next, 'b', 'one target is saved as a plain id, as before');
});

test('removing one of several connections leaves the others (back to a single id when one is left)', async () => {
  const { jsonToGraph, graphToJson } = global.__t;
  const original = definition();
  original.nodes[0].next = ['b', 'c'];
  const { nodes, edges } = jsonToGraph(original);
  assert.equal(edges.filter((edge) => edge.source === 'a').length, 2);

  const afterDelete = edges.filter((edge) => !(edge.source === 'a' && edge.target === 'b'));
  assert.equal(nodeOf(graphToJson(nodes, afterDelete, original), 'a').next, 'c');
  const noneLeft = afterDelete.filter((edge) => edge.source !== 'a');
  assert.equal('next' in nodeOf(graphToJson(nodes, noneLeft, original), 'a'), false);
});

test('re-pointing a branch rule or the default path saves the new target', async () => {
  const { jsonToGraph, graphToJson } = global.__t;
  const original = definition();
  const { nodes, edges } = jsonToGraph(original);

  let next = draw(edges, { id: 'rule-c', source: 'br', sourceHandle: 'handle-rule-r1', target: 'c', type: 'deletable' });
  next = draw(next, { id: 'default-c', source: 'br', sourceHandle: 'handle-default', target: 'c', type: 'deletable' });

  assert.equal(next.filter((edge) => edge.source === 'br').length, 2, 'one line per handle');
  const saved = graphToJson(nodes, next, original);
  assert.equal(nodeOf(saved, 'br').rules[0].then, 'c');
  assert.equal(nodeOf(saved, 'br').default.then, 'c');
});

test('connecting a different handle or a different node does not disturb existing connections', async () => {
  const { jsonToGraph, graphToJson } = global.__t;
  const original = definition();
  const { nodes, edges } = jsonToGraph(original);

  // b has no connection yet
  const withNew = draw(edges, { id: 'b-c', source: 'b', target: 'c', type: 'deletable' });
  const saved = graphToJson(nodes, withNew, original);
  assert.equal(nodeOf(saved, 'b').next, 'c');
  assert.equal(nodeOf(saved, 'a').next, 'b', 'a keeps its own connection');
  assert.equal(nodeOf(saved, 'br').rules[0].then, 'b');
});

test('a composite keeps its step lines when another next connection is added', async () => {
  const { jsonToGraph, graphToJson } = global.__t;
  const original = definition();
  const { nodes, edges } = jsonToGraph(original);

  const redrawn = draw(edges, { id: 'comp-c', source: 'comp', target: 'c', type: 'deletable' });
  const saved = graphToJson(nodes, redrawn, original);
  assert.deepEqual(nodeOf(saved, 'comp').steps, ['b', 'c'], 'steps untouched');
  assert.deepEqual(nodeOf(saved, 'comp').next, ['a', 'c'], 'next now fans out to both');
});

test('a repeated line is saved once, and for a branch rule the newest line is what gets saved', async () => {
  const { jsonToGraph, graphToJson } = global.__t;
  const original = definition();
  const { nodes, edges } = jsonToGraph(original);

  // an editor draft that holds the same line twice
  const duplicated = [...edges, { id: 'a-b-2', source: 'a', target: 'b', type: 'deletable' }];
  assert.equal(nodeOf(graphToJson(nodes, duplicated, original), 'a').next, 'b');

  const ruleDup = [...edges, { id: 'rule-c', source: 'br', sourceHandle: 'handle-rule-r1', target: 'c', type: 'deletable' }];
  assert.equal(nodeOf(graphToJson(nodes, ruleDup, original), 'br').rules[0].then, 'c');
});
