const mongoose = require('mongoose');

const TERMINAL_STATUSES = new Set(['completed', 'terminated', 'failed', 'dead_letter', 'canceled']);
const DEFAULT_WORKFLOW_RUN_TTL_SECONDS = 7 * 24 * 60 * 60;

function getWorkflowRunTtlSeconds() {
  const raw = process.env.WORKFLOW_RUN_TTL_SECONDS;
  if (raw == null || raw === '') return DEFAULT_WORKFLOW_RUN_TTL_SECONDS;

  const ttlSeconds = Number(raw);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return null;
  return Math.floor(ttlSeconds);
}

const WorkflowRunSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    workflowId: { type: String, required: true },
    version: { type: String, required: true },
    status: { type: String, required: true },
    triggerType: {
      type: String,
      enum: ['manual', 'event', 'cron'],
      default: 'manual'
    },
    triggerRef: { type: mongoose.Schema.Types.Mixed, default: null },
    executionKey: { type: String, index: true },
    context: { type: Object, required: true },
    definitionJson: { type: Object, required: true },
    metrics: { type: Object },
    executionTrace: { type: Array },
    nodeOutputs: { type: Array },
    attempt: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    nextRetryAt: { type: Date, default: null },
    queuedAt: { type: Date },
    leaseOwner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date },
    retentionExpiresAt: { type: Date, default: null },
    // Summary of the state engine's decision for this run (full record lives in
    // workflow_state_evaluations, which outlives run pruning). A state-engine error
    // never changes the run's own status, so it is surfaced separately here.
    stateEvaluation: { type: mongoose.Schema.Types.Mixed, default: null },
    stateEvaluationError: { type: String, default: null }
  },
  { timestamps: true }
);

WorkflowRunSchema.pre('save', function applyRetentionExpiry(next) {
  const ttlSeconds = getWorkflowRunTtlSeconds();
  const isTerminal = TERMINAL_STATUSES.has(this.status);

  if (!ttlSeconds || !isTerminal || !this.finishedAt) {
    this.retentionExpiresAt = null;
    return next();
  }

  this.retentionExpiresAt = new Date(this.finishedAt.getTime() + (ttlSeconds * 1000));
  return next();
});

WorkflowRunSchema.index({ tenantId: 1, workflowId: 1, startedAt: -1 });
WorkflowRunSchema.index({ status: 1, queuedAt: 1 });
WorkflowRunSchema.index({ executionKey: 1, status: 1 });
WorkflowRunSchema.index({ retentionExpiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('WorkflowRun', WorkflowRunSchema);
