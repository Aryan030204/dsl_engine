const mongoose = require('mongoose');

// Per-person email settings, layered on top of the recipient lists inside workflow definitions.
// No document for an address means "receives everything". See server/services/recipientPolicy.js.
const MutedWorkflowSchema = new mongoose.Schema(
  {
    // null = applies to every tenant the workflow runs for (global / multi-tenant workflows)
    tenantId: { type: String, default: null },
    workflowId: { type: String, required: true },
    mutedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const EmailRecipientPreferenceSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Master switch: no emails at all while paused. pausedUntil (optional) resumes automatically.
    paused: { type: Boolean, default: false },
    pausedUntil: { type: Date, default: null },
    // TRIGGERED = every alert; CRITICAL = only critical alerts (alert-state workflows only).
    severityMin: { type: String, enum: ['TRIGGERED', 'CRITICAL'], default: 'TRIGGERED' },
    mutedWorkflows: { type: [MutedWorkflowSchema], default: [] },
    updatedBy: { type: String, default: null }
  },
  { timestamps: true, collection: 'email_recipient_preferences' }
);

module.exports = mongoose.model('EmailRecipientPreference', EmailRecipientPreferenceSchema);
