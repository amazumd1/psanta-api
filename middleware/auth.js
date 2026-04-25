const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { admin, ensureFirebaseAdmin } = require("../lib/firebaseAdminApp");

/* ---------------------- RFC6750 deny helper ---------------------- */
function deny(res, code, description, status = 401, realm = "api") {
  res.set(
    "WWW-Authenticate",
    `Bearer realm="${realm}", error="${code}", error_description="${String(description).replace(/"/g, '\\"')}"`
  );
  return res.status(status).json({ success: false, code, message: description });
}

/* ---------------- verify config (algs, key, iss/aud) ------------ */
function getVerifyConfig() {
  const algs = (process.env.JWT_ALGS || process.env.JWT_ALG || "HS256")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const usingRSA = algs.some((a) => a.toUpperCase().startsWith("RS"));
  const key = usingRSA ? process.env.JWT_PUBLIC_KEY : process.env.JWT_SECRET;

  if (!key) {
    throw new Error(
      usingRSA
        ? "JWT_PUBLIC_KEY is required for RS* algorithms"
        : "JWT_SECRET is required for HS* algorithms"
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
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  if (!/^Bearer\s+/i.test(h)) return null;
  return h.replace(/^Bearer\s+/i, "").trim() || null;
}

const cookieNameCandidates = ["cp_jwt", "authToken", "token"];

function getCookieToken(req) {
  const c = req.cookies || {};
  const sc = req.signedCookies || {};

  for (const name of cookieNameCandidates) {
    if (c[name]) return c[name];
    if (sc[name]) return sc[name];
  }

  const raw = req.headers?.cookie || "";
  if (raw) {
    const m = raw.match(
      new RegExp('(?:^|;\\s*)(' + cookieNameCandidates.join("|") + ')=([^;]+)', "i")
    );
    if (m) return decodeURIComponent(m[2]);
  }

  return null;
}

function attachUserContext(req, res, user, decoded, extra = {}) {
  const resolvedAuthType = extra.authType || decoded?.authType || "legacy";
  const resolvedSessionScope = extra.sessionScope || decoded?.sessionScope || null;

  req.user = {
    ...decoded,
    ...extra,
    userId: String(user._id),
    email: user.email || decoded?.email || null,
    role: user.role || decoded?.role || null,
    firebaseUid: user.firebaseUid || decoded?.uid || null,
    defaultTenantId: user.defaultTenantId || null,
    activeTenantIds: Array.isArray(user.activeTenantIds)
      ? user.activeTenantIds
      : [],
    emailVerified: Boolean(user.emailVerified),
    authType: resolvedAuthType,
    sessionScope: resolvedSessionScope,
  };

  req.userId = String(user._id);
  req.userDoc = user;
  res.locals.userId = req.userId;
  res.set("Cache-Control", "no-store");
}

async function resolveActiveUserById(userId) {
  const user = await User.findById(userId)
    .select("_id email role roles isActive tokenVersion profileCompleted firebaseUid emailVerified defaultTenantId activeTenantIds")
    .lean();

  if (!user) {
    return { ok: false, code: "invalid_token", message: "User not found for this token.", status: 401 };
  }

  if (user.isActive === false) {
    return { ok: false, code: "insufficient_scope", message: "User is disabled.", status: 403 };
  }

  return { ok: true, user };
}

async function resolveActiveUserByFirebase(decoded) {
  const firebaseUid = String(decoded?.uid || "").trim();
  const email = String(decoded?.email || "").trim().toLowerCase();

  if (!firebaseUid && !email) {
    return { ok: false, code: "invalid_token", message: "Firebase token missing user identity.", status: 401 };
  }

  if (!decoded?.email_verified) {
    return { ok: false, code: "insufficient_scope", message: "Email is not verified.", status: 403 };
  }

  const user = await User.findOne({
    $or: [
      ...(firebaseUid ? [{ firebaseUid }] : []),
      ...(email ? [{ email }] : []),
    ],
  })
    .select("_id email role roles isActive tokenVersion profileCompleted firebaseUid emailVerified defaultTenantId activeTenantIds")
    .lean();

  if (!user) {
    return { ok: false, code: "invalid_token", message: "No local user found for this Firebase account.", status: 401 };
  }

  if (user.isActive === false) {
    return { ok: false, code: "insufficient_scope", message: "User is disabled.", status: 403 };
  }

  return { ok: true, user };
}

function tryVerifyLegacyJwt(token) {
  try {
    const { key, verifyOpts } = getVerifyConfig();
    const decoded = jwt.verify(token, key, verifyOpts);
    return { ok: true, decoded };
  } catch (e) {
    return { ok: false, error: e };
  }
}

const FRONTPAGE_SERVICES_SCOPE = "frontpage_services";
const FRONTPAGE_ALLOWED_API_PREFIXES = [
  "/api/auth/me",
  "/api/auth/firebase-bridge-token",
  "/api/workspaces/session",
  "/api/workspaces/switch",
  "/api/receipts/google",
  "/api/general-data/google",
];

function normalizeSessionScope(value) {
  return String(value || "").trim().toLowerCase();
}

function isSessionScopeAllowedForRequest(sessionScope, req) {
  const normalized = normalizeSessionScope(sessionScope);

  if (!normalized || normalized === "full_access") return true;

  const requestPath = String(req.originalUrl || req.url || "").split("?")[0];

  if (normalized === FRONTPAGE_SERVICES_SCOPE) {
    return FRONTPAGE_ALLOWED_API_PREFIXES.some(
      (prefix) => requestPath === prefix || requestPath.startsWith(`${prefix}/`)
    );
  }

  return false;
}

function getSessionScopeErrorMessage(sessionScope) {
  if (normalizeSessionScope(sessionScope) === FRONTPAGE_SERVICES_SCOPE) {
    return "This session only allows Retail Receipts and General Data services.";
  }
  return "This session is not allowed to access this resource.";
}

async function tryVerifyFirebaseToken(token) {
  try {
    ensureFirebaseAdmin();
    const decoded = await admin.auth().verifyIdToken(token);
    return { ok: true, decoded };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/* ------------------------------ middleware ---------------------- */
const auth = async (req, res, next) => {
  try {
    const token = getBearerToken(req) || getCookieToken(req);

    if (!token) {
      return deny(res, "invalid_token", "Access denied. Missing bearer token.");
    }

    /* 1) Try legacy app JWT first */
    const legacy = tryVerifyLegacyJwt(token);
    if (legacy.ok) {
      const decoded = legacy.decoded;
      const userId = decoded.userId || decoded.id || decoded.sub;

      if (userId) {
        const resolved = await resolveActiveUserById(userId);
        if (!resolved.ok) {
          return deny(res, resolved.code, resolved.message, resolved.status);
        }

        const user = resolved.user;

        if (
          typeof user.tokenVersion === "number" &&
          typeof decoded.tokenVersion === "number" &&
          decoded.tokenVersion !== user.tokenVersion
        ) {
          return deny(res, "invalid_token", "Token has been revoked. Please login again.");
        }

        if (decoded.sessionScope && !isSessionScopeAllowedForRequest(decoded.sessionScope, req)) {
          return deny(
            res,
            "insufficient_scope",
            getSessionScopeErrorMessage(decoded.sessionScope),
            403
          );
        }

        if (decoded.emailVerified === false) {
          return deny(
            res,
            "insufficient_scope",
            "Email is not verified.",
            403
          );
        }

        if (decoded.authType === "firebase" && user.emailVerified === false) {
          return deny(
            res,
            "insufficient_scope",
            "Email is not verified.",
            403
          );
        }

        attachUserContext(req, res, user, decoded, {
          authType: decoded.authType || "legacy",
          sessionScope: decoded.sessionScope || null,
        });
        return next();
      }
    }

    /* 2) Fallback: accept raw Firebase ID token */
    const fb = await tryVerifyFirebaseToken(token);
    if (fb.ok) {
      const resolved = await resolveActiveUserByFirebase(fb.decoded);
      if (!resolved.ok) {
        return deny(res, resolved.code, resolved.message, resolved.status);
      }

      attachUserContext(req, res, resolved.user, fb.decoded, {
        authType: "firebase",
        firebaseUid: fb.decoded.uid,
      });

      req.firebaseUser = fb.decoded;
      return next();
    }

    /* 3) Final deny */
    const legacyErr = legacy.error;
    if (legacyErr?.name === "TokenExpiredError") {
      return deny(res, "invalid_token", "Session expired. Please login again.");
    }

    return deny(res, "invalid_token", "Invalid or malformed token.");
  } catch (error) {
    console.error("Auth middleware error:", error);
    return res
      .status(500)
      .json({ success: false, code: "auth_misconfig", message: "Authentication service error." });
  }
};

/* -------------------------- optional auth ---------------------- */
const authOptional = async (req, res, next) => {
  try {
    const token = getBearerToken(req) || getCookieToken(req);
    if (!token) return next();

    const legacy = tryVerifyLegacyJwt(token);
    if (legacy.ok) {
      const decoded = legacy.decoded;
      const userId = decoded.userId || decoded.id || decoded.sub;

      if (userId) {
        const resolved = await resolveActiveUserById(userId);
        if (resolved.ok) {
          const user = resolved.user;

          if (
            typeof user.tokenVersion === "number" &&
            typeof decoded.tokenVersion === "number" &&
            decoded.tokenVersion === user.tokenVersion
          ) {
            attachUserContext(req, res, user, decoded, { authType: "legacy" });
            return next();
          }
        }
      }
    }

    const fb = await tryVerifyFirebaseToken(token);
    if (fb.ok) {
      const resolved = await resolveActiveUserByFirebase(fb.decoded);
      if (resolved.ok) {
        attachUserContext(req, res, resolved.user, fb.decoded, {
          authType: "firebase",
          firebaseUid: fb.decoded.uid,
        });
        req.firebaseUser = fb.decoded;
      }
    }

    return next();
  } catch (e) {
    console.error("authOptional error:", e);
    return next();
  }
};

module.exports = { auth, authOptional, deny };