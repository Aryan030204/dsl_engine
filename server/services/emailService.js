const nodemailer = require('nodemailer');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 25;

function normalizeRecipients(recipients = []) {
  return (Array.isArray(recipients) ? recipients : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function validateRecipients(recipients = []) {
  const normalized = normalizeRecipients(recipients);
  if (!normalized.length) {
    return { ok: false, error: 'at least one recipient is required' };
  }
  if (normalized.length > MAX_RECIPIENTS) {
    return { ok: false, error: `recipient count exceeds limit of ${MAX_RECIPIENTS}` };
  }
  const invalid = normalized.filter((email) => !EMAIL_REGEX.test(email));
  if (invalid.length) {
    return { ok: false, error: `invalid email recipient(s): ${invalid.join(', ')}` };
  }
  return { ok: true, recipients: normalized };
}

function isTestMode() {
  return String(process.env.TEST_MODE || '').toLowerCase() === 'true';
}

function getTestModeRecipients() {
  return String(process.env.TEST_USERS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function createTransport() {
  const user = process.env.GMAIL_USER || process.env.SMTP_USER;
  const pass = process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS;

  if (!user) throw new Error('GMAIL_USER is not configured');
  if (!pass) throw new Error('GMAIL_APP_PASSWORD is not configured');

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user,
      pass
    }
  });
}

async function sendEmail({ to, subject, html, text }) {
  const recipients = isTestMode() ? getTestModeRecipients() : to;
  const recipientsResult = validateRecipients(recipients);
  if (!recipientsResult.ok) {
    return {
      status: 'failed',
      provider: 'smtp',
      to: normalizeRecipients(recipients),
      error: recipientsResult.error
    };
  }

  const from = process.env.EMAIL_FROM;

  if (!from) {
    return {
      status: 'failed',
      provider: 'smtp',
      to: recipientsResult.recipients,
      error: 'EMAIL_FROM is not configured'
    };
  }

  try {
    const transport = createTransport();
    const delivery = await transport.sendMail({
      from,
      to: recipientsResult.recipients.join(', '),
      subject,
      html,
      text: text || ''
    });

    return {
      status: 'sent',
      provider: 'smtp',
      to: recipientsResult.recipients,
      subject,
      messageId: delivery.messageId || null
    };
  } catch (error) {
    return {
      status: 'failed',
      provider: 'smtp',
      to: recipientsResult.recipients,
      subject,
      error: error.message
    };
  }
}

module.exports = {
  sendEmail,
  validateRecipients,
};
