const crypto = require('crypto');

// No hardcoded fallback: a known secret in the repo lets anyone forge session tokens.
// Production must set JWT_SECRET; dev gets a random per-process secret (sessions reset on restart).
function resolveJwtSecret() {
  const configured = process.env.JWT_SECRET;
  if (configured && configured.length >= 16) return configured;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set (min 16 chars) in production');
  }

  console.warn('[auth] JWT_SECRET not set; using a random dev secret. Sessions reset on restart.');
  return crypto.randomBytes(48).toString('hex');
}

const JWT_SECRET = resolveJwtSecret();

// Only this email domain may sign in; everyone who does is an admin.
const ALLOWED_EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'trytechit.co').toLowerCase();

const isAllowedEmail = (email) =>
  typeof email === 'string' && email.trim().toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);

module.exports = { JWT_SECRET, ALLOWED_EMAIL_DOMAIN, isAllowedEmail };
