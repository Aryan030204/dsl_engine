const test = require('node:test');
const assert = require('node:assert/strict');
const { applyRecipientOverride } = require('../server/services/workflowExecutionService');
const { getExecutionKey } = require('../scheduler/app/runQueueService');

test('a schedule with recipients replaces the addressees of every email in its run', async () => {
  const sent = [];
  const sender = applyRecipientOverride(async (message) => { sent.push(message); return { status: 'sent' }; }, ['a@x.com', 'b@x.com']);
  await sender({ to: ['workflow@x.com'], subject: 'S', html: '<p>h</p>' });
  assert.deepEqual(sent[0].to, ['a@x.com', 'b@x.com']);
  assert.equal(sent[0].subject, 'S');
});

test('no recipients on the schedule leaves the sender untouched', () => {
  const sender = async () => {};
  assert.equal(applyRecipientOverride(sender, []), sender);
  assert.equal(applyRecipientOverride(sender, undefined), sender);
});

test('schedules with their own recipients queue independently; others share the workflow lane', () => {
  const base = { tenantId: 'T', workflowId: 'wf' };
  assert.equal(getExecutionKey(base), 'T:wf');
  assert.equal(getExecutionKey({ ...base, triggerRef: 's1' }), 'T:wf');
  assert.equal(getExecutionKey({ ...base, triggerRef: 's1', scopeToTrigger: true }), 'T:wf:s1');
  assert.notEqual(
    getExecutionKey({ ...base, triggerRef: 's1', scopeToTrigger: true }),
    getExecutionKey({ ...base, triggerRef: 's2', scopeToTrigger: true })
  );
});
