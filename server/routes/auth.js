const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const { JWT_SECRET, ALLOWED_EMAIL_DOMAIN, isAllowedEmail } = require('../lib/authConfig');
const { requireCsrfHeader, resolveUser } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// 1 Week Cookie Expiry: 7 days * 24 hours * 60 mins * 60 secs * 1000 ms
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

const parseBoolean = (value) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return Boolean(value);

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
};

const buildCookieOptions = () => {
  const isProd = process.env.NODE_ENV === 'production';
  const configuredSecure = parseBoolean(process.env.COOKIE_SECURE);
  const configuredSameSite = process.env.COOKIE_SAMESITE;
  const domain = process.env.COOKIE_DOMAIN;

  let sameSite = configuredSameSite || 'lax';
  let secure = configuredSecure;

  if (secure === undefined) {
    secure = isProd;
  }

  // In production, default to SameSite=None for compatibility with split UI/API domains.
  if (!configuredSameSite && isProd && secure) {
    sameSite = 'none';
  }

  // Browsers reject SameSite=None cookies unless Secure=true.
  if (sameSite === 'none' && !secure) {
    sameSite = 'lax';
  }

  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: COOKIE_MAX_AGE,
    path: '/'
  };

  if (domain) {
    cookieOptions.domain = domain;
  }

  return cookieOptions;
};

// Helper to generate token and set cookie
const domainError = `Only @${ALLOWED_EMAIL_DOMAIN} accounts can sign in`;

// Domain members are admins; keep the stored role in sync on every login.
const ensureAdmin = async (user) => {
  if (user.role !== 'admin') {
    user.role = 'admin';
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
  }
};

const generateTokenAndSetCookie = (res, user) => {
  const token = jwt.sign({ id: user._id, tv: user.tokenVersion || 0 }, JWT_SECRET, {
    expiresIn: '7d',
    algorithm: 'HS256'
  });
  res.cookie('token', token, buildCookieOptions());
  return token;
};

const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  avatar: user.avatar
});

// Reject non-strings so operator objects (e.g. {"$ne": null}) never reach a Mongo query.
const asString = (value) => (typeof value === 'string' ? value : '');
const normalizeEmail = (value) => asString(value).trim().toLowerCase();

const DUMMY_HASH = bcrypt.hashSync('dummy-password', 12);

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72; // bcrypt ignores bytes past 72

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyFn: (req) => normalizeEmail(req.body && req.body.email)
});

// All state-changing auth endpoints require the CSRF header (also blocks login CSRF).
router.use(requireCsrfHeader);

// @route   POST /auth/signup
// @desc    Register user with Email & Password
router.post('/signup', authLimiter, async (req, res) => {
  try {
    const name = asString(req.body.name).trim();
    const email = normalizeEmail(req.body.email);
    const password = asString(req.body.password);

    if (!isAllowedEmail(email)) {
      return res.status(403).json({ error: domainError });
    }
    // Email ownership isn't verified here, so a password signup could claim any
    // @domain address and become admin. Domain members must use Google sign-in.
    if (process.env.ALLOW_PASSWORD_SIGNUP !== 'true') {
      return res.status(403).json({ error: 'Password signup is disabled. Please sign in with Google.' });
    }

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Please provide all details' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email' });
    }
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`
      });
    }

    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ error: 'User already exists with this email' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // role and tenantIds are never taken from the request body.
    user = new User({ name, email, password: hashedPassword, role: 'admin' });
    await user.save();

    generateTokenAndSetCookie(res, user);

    res.status(201).json({
      message: 'User registered successfully',
      user: publicUser(user)
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(400).json({ error: 'User already exists with this email' });
    }
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Server error during signup' });
  }
});

// @route   POST /auth/login
// @desc    Login user with Email & Password
router.post('/login', authLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = asString(req.body.password);

    if (!email || !password) {
      return res.status(400).json({ error: 'Please provide email and password' });
    }

    if (!isAllowedEmail(email)) {
      return res.status(403).json({ error: domainError });
    }

    const user = await User.findOne({ email });
    // Compare against a dummy hash for unknown/Google-only users so timing doesn't reveal them.
    const isMatch = await bcrypt.compare(
      password,
      (user && user.password) || DUMMY_HASH
    );
    if (!user || !user.password || !isMatch) {
      return res.status(401).json({ error: 'Invalid Credentials' });
    }

    await ensureAdmin(user);
    generateTokenAndSetCookie(res, user);

    res.json({ message: 'Logged in successfully', user: publicUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// @route   POST /auth/google
// @desc    Google Sign-In via Access Token
router.post('/google', authLimiter, async (req, res) => {
  try {
    const accessToken = asString(req.body.idToken); // Named idToken from frontend to keep payload compatible

    if (!GOOGLE_CLIENT_ID) {
      return res.status(503).json({ error: 'Google sign-in is not configured' });
    }
    if (!accessToken) {
      return res.status(400).json({ error: 'No Google Token provided' });
    }

    // Confirm the token was issued to OUR client, not some other app's.
    let tokenInfo;
    try {
      tokenInfo = await client.getTokenInfo(accessToken);
    } catch {
      return res.status(401).json({ error: 'Failed to verify Google Token' });
    }
    if (tokenInfo.aud !== GOOGLE_CLIENT_ID) {
      return res.status(401).json({ error: 'Google token was not issued for this app' });
    }

    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) {
      return res.status(401).json({ error: 'Failed to verify Google Token' });
    }

    const payload = await response.json();
    const { sub: googleId, name, picture: avatar } = payload;
    const email = normalizeEmail(payload.email);

    if (!email || !googleId) {
      return res.status(400).json({ error: 'Google did not provide an email' });
    }
    if (!isAllowedEmail(email)) {
      return res.status(403).json({ error: domainError });
    }
    if (payload.email_verified !== true) {
      return res.status(401).json({ error: 'Google email is not verified' });
    }

    let user = await User.findOne({ $or: [{ googleId }, { email }] });

    if (user) {
      if (user.googleId && user.googleId !== googleId) {
        return res.status(401).json({ error: 'Account is linked to a different Google identity' });
      }
      if (!user.googleId) {
        // Linking onto an email/password account whose email was never verified: drop the
        // password so whoever pre-registered the address can no longer log in with it.
        user.googleId = googleId;
        user.password = undefined;
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        if (!user.avatar) user.avatar = avatar;
        await user.save();
      }
    } else {
      user = new User({ name: name || email, email, googleId, avatar, role: 'admin' });
      await user.save();
    }

    await ensureAdmin(user);
    generateTokenAndSetCookie(res, user);

    res.json({ message: 'Logged in via Google successfully', user: publicUser(user) });
  } catch (err) {
    console.error('Google Auth error:', err);
    res.status(500).json({ error: 'Google authentication failed' });
  }
});

// @route   GET /auth/me
// @desc    Get Current User from Cookie
router.get('/me', async (req, res) => {
  try {
    const user = await resolveUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const { tokenVersion, googleId, ...rest } = user.toObject();
    res.json(rest);
  } catch (err) {
    res.status(401).json({ error: 'Session invalid or expired' });
  }
});

// @route   POST /auth/logout
// @desc    Logout, revoke issued tokens and clear cookie
router.post('/logout', async (req, res) => {
  try {
    const user = await resolveUser(req);
    if (user) {
      await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
    }
  } catch (err) {
    console.error('Logout revoke error:', err);
  }
  const cookieOptions = buildCookieOptions();
  res.clearCookie('token', {
    path: cookieOptions.path,
    domain: cookieOptions.domain,
    secure: cookieOptions.secure,
    sameSite: cookieOptions.sameSite
  });
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;
