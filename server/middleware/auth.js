const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { JWT_SECRET, isAllowedEmail } = require('../lib/authConfig');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF defence for cookie auth: browsers can't attach a custom header cross-site without a
// CORS preflight, which the origin allowlist rejects. The UI axios client always sends it.
function requireCsrfHeader(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.get('x-requested-with') !== 'XMLHttpRequest') {
    return res.status(403).json({ error: 'Missing CSRF header' });
  }
  next();
}

// Resolves the session cookie to a user. Returns null when absent/invalid/revoked.
async function resolveUser(req) {
  const token = req.cookies && req.cookies.token;
  if (!token || typeof token !== 'string') return null;

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return null;
  }

  const user = await User.findById(decoded.id).select('-password');
  if (!user) return null;
  // Existing sessions of accounts outside the allowed domain stop working immediately.
  if (!isAllowedEmail(user.email)) return null;
  if (user.role !== 'admin') {
    user.role = 'admin';
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
  }
  // Logout bumps tokenVersion, revoking every token issued before it.
  if ((decoded.tv || 0) !== (user.tokenVersion || 0)) return null;
  return user;
}

async function requireAuth(req, res, next) {
  if (req.ingestAuthorized) return next();
  try {
    const user = await resolveUser(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    req.user = user;
    requireCsrfHeader(req, res, next);
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).json({ error: 'Admin access required' });
}

function canAccessTenant(user, tenantId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const wanted = String(tenantId || '').trim().toUpperCase();
  return (user.tenantIds || []).some((id) => String(id).trim().toUpperCase() === wanted);
}

// Use on routes mounted under /tenants/:tenantId
function requireTenantAccess(req, res, next) {
  if (req.ingestAuthorized) return next();
  if (!canAccessTenant(req.user, req.params.tenantId)) {
    return res.status(403).json({ error: 'No access to this tenant' });
  }
  next();
}

// For bodies that carry a list of tenant ids. Returns the denied ids (empty when allowed).
function deniedTenants(user, tenantIds) {
  return (tenantIds || []).filter((id) => !canAccessTenant(user, id));
}

// Machine-to-machine gate for alert ingestion, shared with routes/alertsIngest.js.
// Fails closed in production when ALERTS_INGEST_TOKEN is unset.
function ingestTokenFrom(req) {
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i);
  return bearer ? bearer[1] : req.headers['x-alerts-ingest-token'] || null;
}

function ingestTokenValid(req) {
  const expected = process.env.ALERTS_INGEST_TOKEN;
  if (!expected) return process.env.NODE_ENV !== 'production';
  const provided = ingestTokenFrom(req);
  return Boolean(provided) && provided === expected;
}

// Lets a valid ingest token through; otherwise falls back to normal user auth downstream.
function allowIngestToken(req, res, next) {
  if (req.headers.authorization || req.headers['x-alerts-ingest-token']) {
    if (ingestTokenValid(req)) req.ingestAuthorized = true;
  }
  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireTenantAccess,
  requireCsrfHeader,
  canAccessTenant,
  deniedTenants,
  ingestTokenValid,
  allowIngestToken,
  resolveUser
};
