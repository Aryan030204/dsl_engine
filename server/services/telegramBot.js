const crypto = require('crypto');
const { Api, Bot } = require('node-telegram-bot-api');

// Telegram bot plumbing, ported from the standalone message service
// (message_service_datum): the Api client that sends messages, and the long-polling
// link bot that completes "/start <token>" links. Configured by TELEGRAM_BOT_TOKEN.
//
// Models are required lazily so this module (and anything that imports it) loads
// without a database connection, e.g. in unit tests.

let api = null;
let bot = null;
let cachedBotUsername = null;

function getBotToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  return token;
}

function isTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

function getApi() {
  if (!api) api = new Api(getBotToken());
  return api;
}

/** The bot's own @username, needed for https://t.me/<bot>?start=... links. */
async function getBotUsername() {
  if (!cachedBotUsername) {
    const me = await getApi().getMe();
    cachedBotUsername = me.username;
  }
  return cachedBotUsername;
}

/**
 * Sends `text` to each user's chat and reports per-user success/failure rather
 * than failing the whole batch when one delivery fails.
 * users: [{ telegramChatId, username }]
 */
async function sendToUsers(users, text) {
  const client = getApi();
  const results = await Promise.allSettled(
    users.map((user) => client.sendMessage({ chat_id: user.telegramChatId, text }))
  );
  return results.map((result, index) => {
    const user = users[index];
    if (result.status === 'fulfilled') {
      return { telegramChatId: user.telegramChatId, username: user.username, success: true };
    }
    return {
      telegramChatId: user.telegramChatId,
      username: user.username,
      success: false,
      error: result.reason?.message || String(result.reason)
    };
  });
}

/**
 * Sends one photo to each user's chat, per-user success/failure like sendToUsers.
 * photo: { data: Buffer|Uint8Array, filename, contentType }; caption: plain text.
 */
async function sendPhotoToUsers(users, { photo, caption }) {
  const { InputFile } = require('node-telegram-bot-api');
  const client = getApi();
  const results = await Promise.allSettled(
    users.map((user) => client.sendPhoto({
      chat_id: user.telegramChatId,
      // A fresh InputFile per send: each upload is its own multipart request.
      photo: new InputFile(photo.data, { filename: photo.filename, contentType: photo.contentType }),
      ...(caption ? { caption } : {})
    }))
  );
  return results.map((result, index) => {
    const user = users[index];
    if (result.status === 'fulfilled') {
      return { telegramChatId: user.telegramChatId, username: user.username, success: true };
    }
    return {
      telegramChatId: user.telegramChatId,
      username: user.username,
      success: false,
      error: result.reason?.message || String(result.reason)
    };
  });
}

/**
 * Chat ids for the given users: a raw telegramChatId is used as-is, a username is
 * looked up among linked users. Unlinked usernames come back with a null chat id.
 */
async function resolveChatIds(users) {
  const TelegramUser = require('../models/TelegramUser');
  const usernames = users.filter((user) => !user.telegramChatId && user.username).map((user) => user.username);

  let chatIdByUsername = {};
  if (usernames.length) {
    const docs = await TelegramUser.find({ username: { $in: usernames } }).lean();
    chatIdByUsername = Object.fromEntries(docs.map((doc) => [doc.username, doc.chatId]));
  }

  return users.map((user) => ({
    telegramChatId: user.telegramChatId || chatIdByUsername[user.username] || null,
    username: user.username
  }));
}

/**
 * Issues a single-use, 10-minute link that connects `username` to whoever presses
 * Start on it. Re-requesting a link for the same username replaces any older,
 * unused one. Telegram's /start payload only allows [A-Za-z0-9_-] up to 64 chars,
 * so the payload is a random token rather than the username itself.
 */
async function createLink(username) {
  const PendingTelegramLink = require('../models/PendingTelegramLink');
  const token = crypto.randomBytes(18).toString('base64url');
  await PendingTelegramLink.findOneAndUpdate(
    { username },
    { token, username, createdAt: new Date() },
    { upsert: true }
  );
  const botUsername = await getBotUsername();
  return `https://t.me/${botUsername}?start=${token}`;
}

function buildLinkBot() {
  const PendingTelegramLink = require('../models/PendingTelegramLink');
  const TelegramUser = require('../models/TelegramUser');
  const linkBot = new Bot(getBotToken());

  linkBot.command('start', async (ctx) => {
    const token = (ctx.match || '').toString().trim();
    const chatId = ctx.chatId;

    if (!token) {
      await ctx.reply('Hi! Open this bot from the "Copy Telegram link" link you were sent to subscribe to alerts.');
      return;
    }

    // Atomic find+delete: a token can only ever complete one link, even under a race.
    const pending = await PendingTelegramLink.findOneAndDelete({ token });
    if (!pending) {
      await ctx.reply('This link is invalid or has expired. Please ask for a new one.');
      return;
    }

    await TelegramUser.findOneAndUpdate(
      { username: pending.username },
      { username: pending.username, chatId: String(chatId) },
      { upsert: true, new: true }
    );

    await ctx.reply(`You're linked as "${pending.username}". You'll receive alerts here from now on.`);
  });

  linkBot.catch((err) => {
    console.error('[telegram] link bot handler error:', err);
  });

  return linkBot;
}

/**
 * Starts long-polling for /start commands in the background. Telegram allows only
 * one poller per bot token, so this runs in the API server only (never the worker),
 * and can be switched off with TELEGRAM_LINK_BOT_ENABLED=false -- e.g. on extra API
 * replicas, or while the old standalone message service is still running.
 */
function startLinkBot() {
  if (!isTelegramConfigured()) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set; Telegram delivery and linking are disabled');
    return false;
  }
  if (String(process.env.TELEGRAM_LINK_BOT_ENABLED || '').toLowerCase() === 'false') {
    console.log('[telegram] link bot disabled (TELEGRAM_LINK_BOT_ENABLED=false); sending still works');
    return false;
  }
  if (bot) return true;
  bot = buildLinkBot();
  bot.startPolling().catch((err) => {
    console.error('[telegram] link bot polling stopped unexpectedly:', err);
  });
  console.log('[telegram] link bot polling for /start commands');
  return true;
}

function stopLinkBot() {
  if (bot) {
    bot.stop();
    bot = null;
  }
}

module.exports = {
  isTelegramConfigured,
  getBotUsername,
  sendToUsers,
  sendPhotoToUsers,
  resolveChatIds,
  createLink,
  startLinkBot,
  stopLinkBot
};
