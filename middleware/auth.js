// services/api/middleware/auth.js
const jwt = require('jsonwebtoken');
const User = require('../models/User'); // adjust if your models path differs

/* ---------------------- RFC6750 deny helper ---------------------- */
function deny(res, code, description, status = 401, realm = 'api') {
  res.set(
    'WWW-Authenticate',
    `Bearer realm="${realm}", error="${code}", error_description="${String(description).replace(/"/g, '\\"')}"`
  );
  return res.status(status).json({ success: false, code, message: description });
}

/* ---------------- verify config (algs, key, iss/aud) ------------ */
function getVerifyConfig() {
  const algs = (process.env.JWT_ALGS || process.env.JWT_ALG || 'HS256')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const usingRSA = algs.some(a => a.toUpperCase().startsWith('RS'));
  const key = usingRSA ? process.env.JWT_PUBLIC_KEY : process.env.JWT_SECRET;

  if (!key) {
    throw new Error(
      usingRSA
        ? 'JWT_PUBLIC_KEY is required for RS* algorithms'
        : 'JWT_SECRET is required for HS* algorithms'
    );
  }

  const verifyOpts = {
    algorithms: algs,
    clockTolerance: Number(process.env.JWT_CLOCK_TOLERANCE || 5),
  };
  if (process.env.JWT_ISSUER) verifyOpts.issuer = process.env.JWT_ISSUER;
  if (process.env.JWT_AUDIENCE) verifyOpts.audience = process.env.JWT_AUDIENCE;

  return { key, verifyOpts };
}

/* --------------------------- token pickers ----------------------- */
function getBearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  if (!/^Bearer\s+/i.test(h)) return null;
  return h.replace(/^Bearer\s+/i, '').trim() || null;
}

const cookieNameCandidates = ['cp_jwt', 'authToken', 'token'];
function getCookieToken(req) {
  // via cookie-parser (unsigned + signed)
  const c = req.cookies || {};
  const sc = req.signedCookies || {};
  for (const name of cookieNameCandidates) {
    if (c[name]) return c[name];
    if (sc[name]) return sc[name];
  }

  // last fallback: parse raw Cookie header (covers odd proxy cases)
  const raw = req.headers?.cookie || '';
  if (raw) {
    const m = raw.match(
      new RegExp('(?:^|;\\s*)(' + cookieNameCandidates.join('|') + ')=([^;]+)', 'i')
    );
    if (m) return decodeURIComponent(m[2]);
  }
  return null;
}

/* ------------------------------ middleware ---------------------- */
const auth = async (req, res, next) => {
  try {
    // 1) Token from Authorization OR cookies
    const token = getBearerToken(req) || getCookieToken(req);
    if (!token) {
      return deny(res, 'invalid_token', 'Access denied. Missing bearer token.');
    }

    // 2) Verify token
    const { key, verifyOpts } = getVerifyConfig();
    let decoded;
    try {
      decoded = jwt.verify(token, key, verifyOpts);
    } catch (e) {
      if (e.name === 'TokenExpiredError') {
        return deny(res, 'invalid_token', 'Session expired. Please login again.');
      }
      if (e.name === 'JsonWebTokenError' || e.name === 'NotBeforeError') {
        return deny(res, 'invalid_token', 'Invalid or malformed token.');
      }
      return deny(res, 'invalid_token', 'Authentication failed.');
    }

    // 3) Resolve user
    const userId = decoded.userId || decoded.id || decoded.sub;
    if (!userId) {
      return deny(res, 'invalid_token', 'Token payload missing user identifier.');
    }

    const user = await User.findById(userId)
      .select('_id email role roles isActive tokenVersion profileCompleted')
      .lean();

    if (!user) {
      return deny(res, 'invalid_token', 'User not found for this token.');
    }
    if (user.isActive === false) {
      return deny(res, 'insufficient_scope', 'User is disabled.', 403);
    }

    // Optional: tokenVersion check (global logout)
    if (
      typeof user.tokenVersion === 'number' &&
      typeof decoded.tokenVersion === 'number' &&
      decoded.tokenVersion !== user.tokenVersion
    ) {
      return deny(res, 'invalid_token', 'Token has been revoked. Please login again.');
    }

    // 4) Attach to request/locals (backward compatible)
    req.user = { ...decoded, userId: String(user._id) };
    req.userId = String(user._id);
    req.userDoc = user;
    res.locals.userId = req.userId;

    // 5) Hardening
    res.set('Cache-Control', 'no-store');

    return next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    // Don’t leak details if keys misconfigured
    return res
      .status(500)
      .json({ success: false, code: 'auth_misconfig', message: 'Authentication service error.' });
  }
};

module.exports = { auth, deny };
