const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Local, git-ignored file holding the dev signing secret so it survives restarts.
const DEV_SECRET_FILE = path.join(__dirname, '..', '..', '.dev-jwt-secret');
const MIN_SECRET_LENGTH = 16;

// Dev without JWT_SECRET: a random secret used to be generated on every start. nodemon restarts the
// API on every code change, so every restart invalidated all session cookies and the next page
// refresh logged the user out. The secret is now generated once and kept in a git-ignored file.
// There is still no hardcoded fallback in the repo: a known secret would let anyone forge sessions.
function readOrCreateDevSecret(file = DEV_SECRET_FILE) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // no file yet
  }

  const secret = crypto.randomBytes(48).toString('hex');
  try {
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn(`[auth] could not save the dev JWT secret (${error.message}); sessions will reset on restart.`);
  }
  return secret;
}

// Production must set JWT_SECRET.
function resolveJwtSecret({ env = process.env, file = DEV_SECRET_FILE } = {}) {
  const configured = env.JWT_SECRET;
  if (configured && configured.length >= MIN_SECRET_LENGTH) return configured;

  if (env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set (min 16 chars) in production');
  }

  console.warn('[auth] JWT_SECRET not set; using a persisted dev secret (.dev-jwt-secret). Set JWT_SECRET in .env to silence this.');
  return readOrCreateDevSecret(file);
}

const JWT_SECRET = resolveJwtSecret();

// Only this email domain may sign in; everyone who does is an admin.
const ALLOWED_EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'trytechit.co').toLowerCase();

const isAllowedEmail = (email) =>
  typeof email === 'string' && email.trim().toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);

// Sessions last 7 days from the last renewal. An active user's cookie is renewed once it is a day old,
// so people who use the app regularly are not logged out on a fixed 7-day deadline.
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

function sessionNeedsRenewal(decoded, now = Date.now()) {
  const issuedAtMs = Number(decoded?.iat) * 1000;
  return Number.isFinite(issuedAtMs) && now - issuedAtMs >= SESSION_RENEW_AFTER_MS;
}

module.exports = {
  JWT_SECRET,
  ALLOWED_EMAIL_DOMAIN,
  isAllowedEmail,
  resolveJwtSecret,
  readOrCreateDevSecret,
  SESSION_MAX_AGE_MS,
  SESSION_RENEW_AFTER_MS,
  sessionNeedsRenewal
};
