const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const {
  JWT_SECRET,
  resolveJwtSecret,
  readOrCreateDevSecret,
  sessionNeedsRenewal,
  SESSION_RENEW_AFTER_MS
} = require('../server/lib/authConfig');
const { buildCookieOptions } = require('../server/lib/cookieOptions');
const User = require('../server/models/User');
const authRouter = require('../server/routes/auth');

// ---------------------------------------------------------------- signing secret

test('without JWT_SECRET the dev secret is created once and reused, so restarts do not log users out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-secret-'));
  const file = path.join(dir, '.dev-jwt-secret');
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const first = resolveJwtSecret({ env: {}, file });
    const second = resolveJwtSecret({ env: {}, file }); // "restart"
    assert.equal(first, second);
    assert.ok(first.length >= 64);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), first);

    // a too-short or empty file is replaced, not trusted
    fs.writeFileSync(file, 'short');
    assert.ok(readOrCreateDevSecret(file).length >= 64);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a configured JWT_SECRET always wins, and production refuses to start without one', () => {
  assert.equal(resolveJwtSecret({ env: { JWT_SECRET: 'a-configured-secret-value' }, file: '/nonexistent/x' }), 'a-configured-secret-value');
  assert.throws(() => resolveJwtSecret({ env: { NODE_ENV: 'production' }, file: '/nonexistent/x' }), /JWT_SECRET must be set/);
  assert.throws(() => resolveJwtSecret({ env: { NODE_ENV: 'production', JWT_SECRET: 'short' }, file: '/nonexistent/x' }), /JWT_SECRET must be set/);
});

// ---------------------------------------------------------------- cookie attributes

test('the session cookie is one the browser will actually keep', () => {
  const env = { COOKIE_SECURE: 'true', COOKIE_SAMESITE: 'none' };
  const localhost = { secure: false, hostname: 'localhost' };
  const lanIp = { secure: false, hostname: '192.168.1.20' };
  const https = { secure: true, hostname: 'app.example.com' };

  // localhost is a secure context for browsers: Secure + SameSite=None is kept
  assert.deepEqual(
    (({ secure, sameSite }) => ({ secure, sameSite }))(buildCookieOptions(localhost, env)),
    { secure: true, sameSite: 'none' }
  );
  // plain http on any other host: a Secure cookie would be dropped, so fall back
  assert.deepEqual(
    (({ secure, sameSite }) => ({ secure, sameSite }))(buildCookieOptions(lanIp, env)),
    { secure: false, sameSite: 'lax' }
  );
  assert.equal(buildCookieOptions(https, env).secure, true);

  // production is never downgraded, whatever the request looks like
  assert.deepEqual(
    (({ secure, sameSite }) => ({ secure, sameSite }))(buildCookieOptions(lanIp, { ...env, NODE_ENV: 'production' })),
    { secure: true, sameSite: 'none' }
  );
  // production default: SameSite=None when Secure and nothing configured
  assert.equal(buildCookieOptions(https, { NODE_ENV: 'production', COOKIE_SECURE: 'true' }).sameSite, 'none');

  const options = buildCookieOptions(https, { COOKIE_DOMAIN: '.example.com' });
  assert.equal(options.httpOnly, true);
  assert.equal(options.domain, '.example.com');
  assert.equal(options.maxAge, 7 * 24 * 60 * 60 * 1000);
});

test('a session is renewed once its token is a day old, not before', () => {
  const now = Date.now();
  const issued = (agoMs) => ({ iat: Math.floor((now - agoMs) / 1000) });
  assert.equal(sessionNeedsRenewal(issued(60 * 1000), now), false);
  assert.equal(sessionNeedsRenewal(issued(SESSION_RENEW_AFTER_MS - 60 * 1000), now), false);
  assert.equal(sessionNeedsRenewal(issued(SESSION_RENEW_AFTER_MS + 60 * 1000), now), true);
  assert.equal(sessionNeedsRenewal({}, now), false);
});

// ---------------------------------------------------------------- /auth/me over HTTP

function startApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/auth', authRouter);
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(server));
  });
}

function me(server, token) {
  return fetch(`http://127.0.0.1:${server.address().port}/auth/me`, {
    headers: token ? { cookie: `token=${token}` } : {}
  });
}

const sign = (payload, options = {}) => jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: '7d', ...options });

function stubUser(user) {
  const original = { findById: User.findById, updateOne: User.updateOne };
  User.findById = () => ({
    select: async () => {
      if (user instanceof Error) throw user;
      return user;
    }
  });
  User.updateOne = async () => ({});
  return () => Object.assign(User, original);
}

const adminUser = (extra = {}) => ({
  _id: 'u1', name: 'Test', email: 'tester@trytechit.co', role: 'admin', tokenVersion: 0,
  toObject() { return { _id: 'u1', name: 'Test', email: 'tester@trytechit.co', role: 'admin', tokenVersion: 0, googleId: 'g' }; },
  ...extra
});

test('/auth/me: a valid session answers with the user; no cookie or a bad token is 401', async () => {
  const restore = stubUser(adminUser());
  const server = await startApp();
  try {
    const ok = await me(server, sign({ id: 'u1', tv: 0 }));
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.email, 'tester@trytechit.co');
    assert.equal(body.tokenVersion, undefined, 'internal fields are not exposed');
    assert.equal(body.googleId, undefined);
    assert.equal(ok.headers.get('set-cookie'), null, 'a fresh token is not re-issued');

    assert.equal((await me(server)).status, 401);
    assert.equal((await me(server, 'not-a-token')).status, 401);
    assert.equal((await me(server, jwt.sign({ id: 'u1', tv: 0 }, 'some-other-secret-value-1234'))).status, 401);
    assert.equal((await me(server, sign({ id: 'u1', tv: 0 }, { expiresIn: -10 }))).status, 401);
  } finally {
    restore();
    server.close();
  }
});

test('/auth/me: a logout elsewhere (token version bumped) or a removed user ends the session with 401', async () => {
  let restore = stubUser(adminUser({ tokenVersion: 3 }));
  let server = await startApp();
  try {
    assert.equal((await me(server, sign({ id: 'u1', tv: 2 }))).status, 401);
    assert.equal((await me(server, sign({ id: 'u1', tv: 3 }))).status, 200);
  } finally {
    restore();
    server.close();
  }

  restore = stubUser(null);
  server = await startApp();
  try {
    assert.equal((await me(server, sign({ id: 'u1', tv: 0 }))).status, 401);
  } finally {
    restore();
    server.close();
  }
});

test('/auth/me: a database failure is a 503, never "not signed in"', async () => {
  const restore = stubUser(new Error('connection timed out'));
  const originalError = console.error;
  console.error = () => {};
  const server = await startApp();
  try {
    const res = await me(server, sign({ id: 'u1', tv: 0 }));
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /temporarily unavailable/);
  } finally {
    console.error = originalError;
    restore();
    server.close();
  }
});

test('/auth/me: an active session is renewed when its token is more than a day old', async () => {
  const restore = stubUser(adminUser());
  const server = await startApp();
  try {
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;
    const res = await me(server, sign({ id: 'u1', tv: 0, iat: twoDaysAgo }));
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /^token=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Max-Age=604800/);

    // the renewed token is itself a valid session
    const renewed = /^token=([^;]+)/.exec(cookie)[1];
    assert.equal((await me(server, renewed)).status, 200);
    assert.equal(jwt.verify(renewed, JWT_SECRET).tv, 0);
  } finally {
    restore();
    server.close();
  }
});
