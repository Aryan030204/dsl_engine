const mongoose = require('mongoose');

const LINK_TTL_SECONDS = 10 * 60;

// An issued-but-unused Telegram link: waiting for the user to press Start on the
// bot. Single use (consumed with findOneAndDelete) and expires after 10 minutes via
// the TTL index on createdAt, so an abandoned link cleans itself up.
const pendingTelegramLinkSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: LINK_TTL_SECONDS }
  },
  { collection: 'pending_telegram_links' }
);

module.exports = mongoose.model('PendingTelegramLink', pendingTelegramLinkSchema);
