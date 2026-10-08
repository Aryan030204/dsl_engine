const mongoose = require('mongoose');

// Mutable runtime state of the workflow state engine (docs/workflow-state-engine.md),
// one document per (tenant, workflow) -- global and multi-tenant workflows run per
// tenant, so each tenant has its own incident state. Deliberately keyed without the
// workflow version so editing a workflow never resets an open incident.
//
// Every write goes through stateEngineService's compare-and-set on `version`; never
// update this collection without matching the version you read.
const WorkflowStateSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    workflowId: { type: String, required: true },
    state: { type: String, enum: ['NORMAL', 'TRIGGERED', 'CRITICAL'], default: 'NORMAL' },
    cooldown: {
      type: new mongoose.Schema(
        {
          state: { type: String },
          duration_minutes: { type: Number },
          started_at: { type: Date }
        },
        { _id: false }
      ),
      default: null
    },
    last_evaluated_at: { type: Date, default: null },
    last_alert_at: { type: Date, default: null },
    last_execution_id: { type: String, default: null },
    // Full decision of the execution that last wrote this doc, so a retry of that
    // execution can recover its decision even if the audit row write never landed.
    last_decision: { type: mongoose.Schema.Types.Mixed, default: null },
    version: { type: Number, default: 0 }
  },
  { timestamps: true, collection: 'workflow_states' }
);

WorkflowStateSchema.index({ tenantId: 1, workflowId: 1 }, { unique: true });

module.exports = mongoose.model('WorkflowState', WorkflowStateSchema);
