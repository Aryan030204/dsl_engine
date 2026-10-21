const { SESSION_MAX_AGE_MS } = require('./authConfig');

const parseBoolean = (value) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return Boolean(value);

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
};

// Browsers treat these hosts as secure contexts, so they accept Secure cookies even over plain http.
const isLocalHost = (hostname) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(hostname || '').toLowerCase());

// Session cookie attributes from the environment, adjusted for the request actually being served.
function buildCookieOptions(req, env = process.env) {
  const isProd = env.NODE_ENV === 'production';
  const configuredSecure = parseBoolean(env.COOKIE_SECURE);
  const configuredSameSite = env.COOKIE_SAMESITE;
  const domain = env.COOKIE_DOMAIN;

  let sameSite = configuredSameSite || 'lax';
  let secure = configuredSecure;

  if (secure === undefined) {
    secure = isProd;
  }

  // In production, default to SameSite=None for compatibility with split UI/API domains.
  if (!configuredSameSite && isProd && secure) {
    sameSite = 'none';
  }

  // Outside production, a Secure cookie served over plain http on a host other than localhost (a LAN IP
  // or a dev domain) is silently dropped by the browser: login looks fine, then the next refresh has no
  // cookie and the user is logged out. Fall back to a cookie the browser will keep.
  if (!isProd && secure && req) {
    const requestIsSecure = Boolean(req.secure) || isLocalHost(req.hostname);
    if (!requestIsSecure) {
      secure = false;
    }
  }

  // Browsers reject SameSite=None cookies unless Secure=true.
  if (sameSite === 'none' && !secure) {
    sameSite = 'lax';
  }

  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: SESSION_MAX_AGE_MS,
    path: '/'
  };

  if (domain) {
    cookieOptions.domain = domain;
  }

  return cookieOptions;
}

module.exports = { buildCookieOptions, parseBoolean, isLocalHost };
