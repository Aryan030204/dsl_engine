const test = require('node:test');
const assert = require('node:assert/strict');

const { isNonRetryableError } = require('../lib/runErrors');
const { processClaimedRun } = require('../scheduler/infra/workerLoop');

test('configuration errors are not retried; transient ones are', () => {
  for (const message of [
    'MessagingNode: missing required binding: breakdowns.cvr_utm_source_drops',
    'BranchNode: No rule matched and no default path defined',
    'Node not found: abc',
    'Unsupported node type: foo',
    'Workflow cycle detected at node: a',
    'unsupported value format: weird'
  ]) {
    assert.equal(isNonRetryableError(new Error(message)), true, message);
  }
  for (const message of [
    'Query timed out after 180s',
    'connect ETIMEDOUT 10.0.0.1:3306',
    'SMTP unavailable',
    'read ECONNRESET'
  ]) {
    assert.equal(isNonRetryableError(new Error(message)), false, message);
  }
  assert.equal(isNonRetryableError(Object.assign(new Error('x'), { code: 'WORKFLOW_CONFIG' })), true);
  assert.equal(isNonRetryableError(null), false);
});

function fakeRun() {
  return {
    _id: 'r1', tenantId: 'AJMAL', workflowId: 'wf_x', executionKey: 'k', attempt: 1, maxAttempts: 3,
    leaseOwner: 'w', definitionJson: { name: 'n' },
    saved: 0, async save() { this.saved += 1; }
  };
}

test('a misconfigured run fails at once instead of going through the retry backoff', async () => {
  const run = fakeRun();
  let promoted = 0;
  const result = await processClaimedRun(run, {
    execute: async () => { throw new Error('MessagingNode: missing required binding: breakdowns.nope'); },
    promote: async () => { promoted += 1; }
  });
  assert.equal(result.status, 'failed');
  assert.equal(run.status, 'failed');
  assert.match(run.lastError, /missing required binding/);
  assert.equal(run.nextRetryAt, undefined, 'no retry scheduled');
  assert.equal(run.leaseOwner, null);
  assert.equal(run.saved, 1);
  assert.equal(promoted, 1, 'a waiting run for the same workflow is released');
});

test('a transient failure still retries with backoff', async () => {
  const run = fakeRun();
  const result = await processClaimedRun(run, {
    execute: async () => { throw new Error('connect ETIMEDOUT 10.0.0.1:3306'); },
    promote: async () => {}
  });
  assert.equal(result.status, 'retrying');
  assert.equal(run.status, 'retrying');
  assert.ok(run.nextRetryAt instanceof Date);
});
