// Stands in for sendEmail / sendTelegram while a state-engine workflow executes.
// Email, insight and messaging nodes render exactly as they normally would, but
// nothing leaves the process: each would-be send is recorded as an intent, and the
// state engine decides after the run whether any of it is delivered (see
// stateEngineService.deliver).
function createCapturingSender() {
  const intents = [];
  const telegramIntents = [];

  async function sender({ to, subject, html, text }) {
    intents.push({ to: Array.isArray(to) ? [...to] : [], subject, html, text });
    return {
      status: 'deferred',
      provider: 'state_engine',
      to: Array.isArray(to) ? to : [],
      subject
    };
  }

  async function telegramSender({ title, message, image, images, severity, users }) {
    telegramIntents.push({
      title,
      message,
      // Rendered report pages (data URLs), when the messaging node produced them.
      ...(Array.isArray(images) && images.length ? { images: [...images] } : {}),
      ...(image ? { image } : {}),
      severity,
      users: Array.isArray(users) ? users.map((user) => ({ ...user })) : []
    });
    return { status: 'deferred', provider: 'state_engine', users: Array.isArray(users) ? users : [] };
  }

  return { sender, intents, telegramSender, telegramIntents };
}

module.exports = { createCapturingSender };
