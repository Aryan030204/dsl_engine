const DEFAULT_TIMEOUT_MS = 10000;

function normalizeUsers(users = []) {
  return (Array.isArray(users) ? users : [])
    .filter((user) => user && typeof user === 'object')
    .map((user) => ({
      ...(user.username ? { username: String(user.username).trim() } : {}),
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

async function sendTelegram({ title, message, image, images, severity = 'info', users, fetchImpl = fetch }) {
  const recipients = validateTelegramUsers(users);
  if (!recipients.ok) {
    return { status: 'failed', provider: 'telegram', error: recipients.error, users: [] };
  }

  const baseUrl = process.env.TELEGRAM_SERVICE_URL;
  const secret = process.env.TELEGRAM_SERVICE_SECRET;
  if (!baseUrl || !secret) {
    return {
      status: 'failed',
      provider: 'telegram',
      users: recipients.users,
      error: 'TELEGRAM_SERVICE_URL and TELEGRAM_SERVICE_SECRET are required'
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const imagesToSend = Array.isArray(images) && images.length ? images : (image ? [image] : []);
    const pageCount = imagesToSend.length;
    const responses = [];
    const failures = [];

    for (let pageIndex = 0; pageIndex < pageCount || (pageCount === 0 && pageIndex === 0); pageIndex += 1) {
      const pageImage = imagesToSend[pageIndex];
      const pageTitle = pageCount > 1 ? `${title} (${pageIndex + 1}/${pageCount})` : title;
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/alerts`, {
        method: 'POST',
        headers: {
          'x-shared-secret': secret,
          'x-drains': 'TELEGRAM',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          alert: {
            title: pageTitle,
            message: pageImage ? undefined : message,
            image: pageImage,
            imageMimeType: pageImage ? 'image/jpeg' : undefined,
            severity,
            delivery: pageImage ? 'image' : 'text'
          },
          users: recipients.users
        }),
        signal: controller.signal
      });

      const responseText = await response.text();
      let responseBody;
      try {
        responseBody = responseText ? JSON.parse(responseText) : null;
      } catch {
        responseBody = responseText;
      }

      responses.push(responseBody);
      const failedResults = Array.isArray(responseBody?.results)
        ? responseBody.results.filter((result) => result && result.success === false)
        : [];
      if (!response.ok || failedResults.length) {
        failures.push(failedResults[0]?.error || responseBody?.error || `Telegram service returned ${response.status}`);
      }
    }

    if (failures.length) {
      return {
        status: responses.some((response) => response?.results?.some((result) => result?.success)) ? 'partial' : 'failed',
        provider: 'telegram',
        users: recipients.users,
        error: failures[0],
        response: responses
      };
    }

    return { status: 'sent', provider: 'telegram', users: recipients.users, response: responses };
  } catch (error) {
    return {
      status: 'failed',
      provider: 'telegram',
      users: recipients.users,
      error: error.name === 'AbortError' ? 'Telegram service request timed out' : error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { sendTelegram, validateTelegramUsers };