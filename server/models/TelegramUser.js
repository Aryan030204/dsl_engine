const mongoose = require('mongoose');

// A Telegram username linked to the chat the bot should message (created when the
// user presses Start on a link from GET /telegram/link). Ported from the standalone
// message service, which used this same database and collection, so links made
// there keep working. Named TelegramUser because `User` is the engine's login
// account model (collection user_accounts).
const telegramUserSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    chatId: { type: String, required: true }
  },
  { collection: 'users', timestamps: true }
);

module.exports = mongoose.model('TelegramUser', telegramUserSchema);
