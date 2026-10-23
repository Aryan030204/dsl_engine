const mongoose = require('mongoose');
const { SCHEDULE_WINDOW_MODE_VALUES } = require('../../scheduler/app/scheduleWindowModes');

const RETRY_POLICY_SCHEMA = new mongoose.Schema(
  {
    maxAttempts: { type: Number, default: 3 },
    backoffSeconds: { type: [Number], default: [30, 120, 600] }
  },
  { _id: false }
);

const WorkflowScheduleSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    workflowId: { type: String, required: true, index: true },
    scheduleGroupId: { type: String, default: null, index: true },
    name: { type: String },
    triggerType: { type: String, enum: ['cron'], default: 'cron' },
    cronExpr: { type: String, required: true },
    timezone: { type: String, default: 'UTC' },
    windowMode: {
      type: String,
      enum: SCHEDULE_WINDOW_MODE_VALUES,
      default: 'previous_complete_day'
    },
    isActive: { type: Boolean, default: true, index: true },
    overlapPolicy: {
      type: String,
      enum: ['replace_running', 'queue_one_pending', 'skip_if_running', 'allow_parallel'],
      default: 'replace_running'
    },
    retryPolicy: { type: RETRY_POLICY_SCHEMA, default: () => ({}) },
    nextRunAt: { type: Date, index: true },
    lastEvaluatedAt: { type: Date },
    lastTriggeredAt: { type: Date },
    pausedAt: { type: Date },
    metadata: { type: Object, default: {} }
  },
  { timestamps: true }
);

WorkflowScheduleSchema.index({ tenantId: 1, workflowId: 1, isActive: 1 });
WorkflowScheduleSchema.index({ scheduleGroupId: 1, tenantId: 1, workflowId: 1 });

module.exports = mongoose.model('WorkflowSchedule', WorkflowScheduleSchema);
