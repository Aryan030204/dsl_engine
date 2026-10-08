const telegramBot = require('./telegramBot');

// Telegram's hard limits for one message's text and one photo's caption.
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

function normalizeUsers(users = []) {
  return (Array.isArray(users) ? users : [])
    .filter((user) => user && typeof user === 'object')
    .map((user) => ({
      ...(user.username ? { username: String(user.username).trim().replace(/^@/, '') } : {}),
      ...(user.telegramChatId ? { telegramChatId: String(user.telegramChatId).trim() } : {})
    }))
    .filter((user) => user.username || user.telegramChatId);
}

function validateTelegramUsers(users = []) {
  const normalized = normalizeUsers(users);
  if (!normalized.length) {
    return { ok: false, error: 'at least one username or telegramChatId is required' };
  }
  return { ok: true, users: normalized };
}

function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function severityTag(severity) {
  return severity ? `[${String(severity).toUpperCase()}]` : '';
}

// "[SEVERITY] title" on the first line, then the message body -- the same parts the
// standalone message service used, one per line instead of run together, and cut
// to Telegram's per-message limit.
function formatTelegramMessage({ title, message, severity }) {
  const header = [severityTag(severity), title || ''].filter(Boolean).join(' ');
  const text = [header, message || ''].filter(Boolean).join('\n').trim();
  return truncate(text, TELEGRAM_MAX_MESSAGE_LENGTH);
}

// Caption for one page of an image report: "[SEVERITY] title (n/m)".
function formatImageCaption({ title, severity, pageNumber, pageCount }) {
  const pageTitle = pageCount > 1 ? `${title || ''} (${pageNumber}/${pageCount})` : (title || '');
  return truncate([severityTag(severity), pageTitle].filter(Boolean).join(' ').trim(), TELEGRAM_MAX_CAPTION_LENGTH);
}

// Report pages arrive as data URLs from server/lib/renderTelegramImage.js
// ("data:image/jpeg;base64,..."); a bare base64 string is accepted too.
function decodeImage(image, index) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(image || ''));
  const contentType = match ? match[1] : 'image/jpeg';
  const data = Buffer.from(match ? match[2] : String(image || ''), 'base64');
  if (!data.length) throw new Error(`report page ${index + 1} is empty`);
  const extension = contentType.split('/')[1] || 'jpg';
  return { data, contentType, filename: `report-${index + 1}.${extension === 'jpeg' ? 'jpg' : extension}` };
}

/**
 * Sends one alert to Telegram users, in-process through the engine's own bot
 * (ported from the standalone message service's POST /alerts). Users are given by
 * `username` (resolved through links made with GET /telegram/link) or a raw
 * `telegramChatId`. Delivery is per user: one failure doesn't stop the others.
 *
 * With `images` (or a single `image`) -- rendered report pages -- each page is sent
 * as a photo captioned "[SEVERITY] title (n/m)"; a user counts as delivered only if
 * every page reached them. Otherwise `title` + `message` go out as one text message.
 *
 * Returns { status: 'sent' | 'partial' | 'failed', provider, users, results, error }.
 * `deps` lets tests swap the Telegram and database calls.
 */
async function sendTelegram({ title, message, image, images, severity = 'info', users, deps = telegramBot }) {
  const recipients = validateTelegramUsers(users);
  if (!recipients.ok) {
    return { status: 'failed', provider: 'telegram', error: recipients.error, users: [] };
  }
  if (!deps.isTelegramConfigured()) {
    return {
      status: 'failed',
      provider: 'telegram',
      users: recipients.users,
      error: 'TELEGRAM_BOT_TOKEN is not configured'
    };
  }

  const pages = Array.isArray(images) && images.length ? images : (image ? [image] : []);
  const text = pages.length ? null : formatTelegramMessage({ title, message, severity });
  if (!pages.length && !text) {
    return { status: 'failed', provider: 'telegram', users: recipients.users, error: 'alert has no title or message' };
  }

  try {
    const resolved = await deps.resolveChatIds(recipients.users);
    const sendable = resolved.filter((user) => user.telegramChatId);
    const unresolved = resolved
      .filter((user) => !user.telegramChatId)
      .map((user) => ({
        username: user.username,
        success: false,
        error: `no linked Telegram chat for "${user.username}" (send them a "Copy Telegram link" link and have them press Start)`
      }));

    let sent = [];
    if (sendable.length && pages.length) {
      sent = await sendPages(deps, sendable, pages, { title, severity });
    } else if (sendable.length) {
      sent = await deps.sendToUsers(sendable, text);
    }

    const results = [...sent, ...unresolved];
    const succeeded = results.filter((result) => result.success).length;

    let status = 'failed';
    if (succeeded === results.length) status = 'sent';
    else if (succeeded > 0) status = 'partial';

    return {
      status,
      provider: 'telegram',
      users: recipients.users,
      results,
      ...(pages.length ? { pages: pages.length } : {}),
      ...(status === 'sent' ? {} : { error: results.find((result) => !result.success)?.error || 'telegram delivery failed' })
    };
  } catch (error) {
    return {
      status: 'failed',
      provider: 'telegram',
      users: recipients.users,
      error: error?.message || 'telegram delivery failed'
    };
  }
}

// Sends every page, in order, to every user; folds the per-page results into one
// result per user (success only if all of that user's pages went through).
async function sendPages(deps, users, pages, { title, severity }) {
  const byChat = new Map(users.map((user) => [user.telegramChatId, { ...user, success: true, errors: [] }]));
  for (let index = 0; index < pages.length; index += 1) {
    const photo = decodeImage(pages[index], index);
    const caption = formatImageCaption({ title, severity, pageNumber: index + 1, pageCount: pages.length });
    const pageResults = await deps.sendPhotoToUsers(users, { photo, caption });
    for (const result of pageResults) {
      const entry = byChat.get(result.telegramChatId);
      if (entry && !result.success) {
        entry.success = false;
        entry.errors.push(`page ${index + 1}: ${result.error}`);
      }
    }
  }
  return [...byChat.values()].map(({ errors, ...entry }) => (
    entry.success ? entry : { ...entry, error: errors.join('; ') }
  ));
}

module.exports = {
  sendTelegram,
  validateTelegramUsers,
  formatTelegramMessage,
  formatImageCaption,
  TELEGRAM_MAX_MESSAGE_LENGTH
};
