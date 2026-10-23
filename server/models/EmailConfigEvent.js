const mongoose = require('mongoose');

// Audit trail for the Email Configurations panel: who changed which person's settings, and when.
const EmailConfigEventSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, index: true },
    by: { type: String, default: null },
    email: { type: String, required: true, index: true },
    action: { type: String, required: true },
    details: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { collection: 'email_config_events' }
);

module.exports = mongoose.model('EmailConfigEvent', EmailConfigEventSchema);
