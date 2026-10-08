// In-memory stand-in for stateEngineService's Mongo store, with the same
// compare-and-set and unique-key semantics. Values are deep-cloned in and out so a
// test can't accidentally mutate "persisted" state through a shared reference.
const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

function createFakeStateStore() {
  const states = new Map();
  const evaluations = new Map();
  const stateKey = (tenantId, workflowId) => `${tenantId}|${workflowId}`;
  const evalKey = (tenantId, workflowId, executionId) => `${tenantId}|${workflowId}|${executionId}`;

  const store = {
    states,
    evaluations,
    async getState(tenantId, workflowId) {
      return clone(states.get(stateKey(tenantId, workflowId)) || null);
    },
    async insertState(doc) {
      const key = stateKey(doc.tenantId, doc.workflowId);
      if (states.has(key)) return false;
      states.set(key, clone(doc));
      return true;
    },
    async compareAndSetState(tenantId, workflowId, expectedVersion, fields) {
      const key = stateKey(tenantId, workflowId);
      const current = states.get(key);
      if (!current || current.version !== expectedVersion) return false;
      states.set(key, { ...current, ...clone(fields), version: current.version + 1 });
      return true;
    },
    async getEvaluation(tenantId, workflowId, executionId) {
      return clone(evaluations.get(evalKey(tenantId, workflowId, executionId)) || null);
    },
    async insertEvaluation(row) {
      const key = evalKey(row.tenantId, row.workflowId, row.executionId);
      if (!evaluations.has(key)) evaluations.set(key, clone(row));
      return clone(evaluations.get(key));
    },
    async claimDelivery(tenantId, workflowId, executionId) {
      const row = evaluations.get(evalKey(tenantId, workflowId, executionId));
      if (!row || row.delivery?.status !== 'pending') return null;
      row.delivery.status = 'sending';
      return clone(row);
    },
    async updateDelivery(tenantId, workflowId, executionId, fields) {
      const row = evaluations.get(evalKey(tenantId, workflowId, executionId));
      if (row) row.delivery = { ...row.delivery, ...clone(fields) };
    },
    async listEvaluations(tenantId, workflowId) {
      return [...evaluations.values()].filter((row) => row.tenantId === tenantId && row.workflowId === workflowId).map(clone);
    }
  };
  return store;
}

// A sender that records every call and answers with a scripted status.
function createRecordingSender(statuses = []) {
  const calls = [];
  async function sender(message) {
    calls.push(message);
    const status = statuses.length ? statuses.shift() : 'sent';
    return status === 'sent'
      ? { status: 'sent', messageId: `msg-${calls.length}` }
      : { status: 'failed', error: 'smtp down' };
  }
  sender.calls = calls;
  return sender;
}

module.exports = { createFakeStateStore, createRecordingSender };
