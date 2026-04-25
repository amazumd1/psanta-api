// services/api/routes/auth.js
const express = require("express");
const { body, validationResult } = require("express-validator");
const { auth } = require("../middleware/auth");
const router = express.Router();
const crypto = require("crypto");
const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { firebaseAuth } = require("../middleware/firebaseAuth");
const { admin, ensureFirebaseAdmin } = require("../lib/firebaseAdminApp");
const { ensureUserTenantContext } = require("../lib/tenantBootstrap");

const {
  signUp,
  loginWithPassword,
  requestOTP,
  loginWithOTP,
  getCurrentUser,
  logout,
  refreshToken,
} = require("../controllers/authController");

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function isLegacyPasswordAuthEnabled() {
  return envFlag("ALLOW_LEGACY_PASSWORD_AUTH", process.env.NODE_ENV !== "production");
}

function isPublicRegisterEnabled() {
  return envFlag("ALLOW_PUBLIC_REGISTER", process.env.NODE_ENV !== "production");
}

function allowUnverifiedFirebaseSession() {
  return envFlag("ALLOW_UNVERIFIED_FIREBASE_SESSION", false);
}

function requireLegacyPasswordAuth(req, res, next) {
  if (!isLegacyPasswordAuthEnabled()) {
    return res.status(404).json({
      ok: false,
      error: "LEGACY_AUTH_DISABLED",
    });
  }
  return next();
}

function requireLegacyPublicRegister(req, res, next) {
  if (!isPublicRegisterEnabled()) {
    return res.status(404).json({
      ok: false,
      error: "PUBLIC_REGISTER_DISABLED",
    });
  }
  return next();
}

const FRONTPAGE_SERVICES_SCOPE = "frontpage_services";

function normalizeRequestedSessionScope(req) {
  const requested = String(req.headers?.["x-ps-session-scope"] || "").trim().toLowerCase();
  const entry = String(req.headers?.["x-ps-entry"] || "").trim().toLowerCase();

  if (requested === FRONTPAGE_SERVICES_SCOPE || entry === "frontpage-retail-setup") {
    return FRONTPAGE_SERVICES_SCOPE;
  }

  return "full_access";
}

function issueLegacyApiToken(user, options = {}) {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required for firebase-session bridge");
  }

  const authType = String(options.authType || "firebase");
  const sessionScope = String(options.sessionScope || "full_access");

  return jwt.sign(
    {
      userId: String(user._id),
      tokenVersion: Number(user.tokenVersion || 0),
      authType,
      emailVerified: !!user.emailVerified,
      sessionScope,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

function setLegacyAuthCookie(res, token) {
  res.cookie("authToken", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearLegacyAuthCookie(res) {
  res.clearCookie("authToken", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

function buildFallbackTenantSession(user) {
  const activeTenantIds = Array.isArray(user?.activeTenantIds)
    ? user.activeTenantIds.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  const currentTenantId =
    String(user?.defaultTenantId || "").trim() || activeTenantIds[0] || null;

  return {
    currentTenantId,
    activeTenantIds,
    memberships: activeTenantIds.map((tenantId) => ({
      tenantId,
      tenantName: tenantId,
      tenantSlug: "",
      tenantStatus: "active",
      plan: "free",
      billingStatus: "unknown",
      role: "viewer",
      status: "active",
      isDefault: tenantId === currentTenantId,
    })),
  };
}

function isQuotaExceededError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    msg.includes("quota exceeded") ||
    msg.includes("resource_exhausted") ||
    msg.includes("quota")
  );
}

async function upsertFirebaseUserFromLegacyUser({
  email,
  password,
  displayName,
  emailVerified,
}) {
  ensureFirebaseAdmin();

  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedName = String(displayName || "").trim();
  const safePassword = typeof password === "string" ? password : "";

  try {
    const existingUser = await admin.auth().getUserByEmail(normalizedEmail);
    const updatePayload = {
      displayName: normalizedName || existingUser.displayName || undefined,
      emailVerified: Boolean(existingUser.emailVerified || emailVerified),
      disabled: false,
    };

    if (safePassword) {
      updatePayload.password = safePassword;
    }

    return await admin.auth().updateUser(existingUser.uid, updatePayload);
  } catch (err) {
    if (err?.code !== "auth/user-not-found") {
      throw err;
    }

    const createPayload = {
      email: normalizedEmail,
      displayName: normalizedName || undefined,
      emailVerified: Boolean(emailVerified),
      disabled: false,
    };

    if (safePassword) {
      createPayload.password = safePassword;
    }

    return await admin.auth().createUser(createPayload);
  }
}

// Validators
const signUpValidation = [
  body("name").trim().notEmpty(),
  body("email").isEmail(),
  body("password").isLength({ min: 6 }),
];

const loginValidation = [
  body("email").isEmail(),
  body("password").isLength({ min: 6 }),
];

const otpRequestValidation = [body("email").isEmail()];
const otpLoginValidation = [
  body("email").isEmail(),
  body("otp").isLength({ min: 4, max: 8 }),
];

// Legacy routes
router.post(
  "/signup",
  requireLegacyPasswordAuth,
  requireLegacyPublicRegister,
  signUpValidation,
  signUp
);

router.post(
  "/login",
  requireLegacyPasswordAuth,
  loginValidation,
  loginWithPassword
);

router.post(
  "/firebase-legacy-login",
  requireLegacyPasswordAuth,
  loginValidation,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          ok: false,
          error: "VALIDATION_FAILED",
          details: errors.array(),
        });
      }

      const email = String(req.body?.email || "").trim().toLowerCase();
      const password = String(req.body?.password || "");

      const user = await User.findOne({ email, isActive: true }).select("+password");
      if (!user) {
        return res.status(401).json({
          ok: false,
          error: "INVALID_CREDENTIALS",
          message: "Invalid email or password",
        });
      }

      const isPasswordValid = await user.comparePassword(password);
      if (!isPasswordValid) {
        return res.status(401).json({
          ok: false,
          error: "INVALID_CREDENTIALS",
          message: "Invalid email or password",
        });
      }

      const firebaseUser = await upsertFirebaseUserFromLegacyUser({
        email: user.email,
        password,
        displayName: user.name,
        emailVerified: user.emailVerified,
      });

      user.firebaseUid = firebaseUser.uid;
      user.authProvider = user.password ? "hybrid" : "firebase";
      user.lastLogin = new Date();

      if (firebaseUser.emailVerified && !user.emailVerified) {
        user.emailVerified = true;
      }

      await user.save();

      const customToken = await admin.auth().createCustomToken(firebaseUser.uid, {
        legacyBridge: true,
        email: user.email,
      });

      return res.json({
        ok: true,
        customToken,
        firebaseUid: firebaseUser.uid,
        emailVerified: Boolean(firebaseUser.emailVerified || user.emailVerified),
      });
    } catch (e) {
      console.error("firebase-legacy-login error:", e);

      return res.status(500).json({
        ok: false,
        error: "FIREBASE_LEGACY_LOGIN_FAILED",
        message: e?.message || "Legacy login bridge failed",
      });
    }
  }
);
router.post(
  "/request-otp",
  requireLegacyPasswordAuth,
  otpRequestValidation,
  requestOTP
);

router.post(
  "/login-otp",
  requireLegacyPasswordAuth,
  otpLoginValidation,
  loginWithOTP
);

router.get("/me", auth, getCurrentUser);
router.post("/logout", auth, logout);
router.post("/refresh", auth, refreshToken);

router.post("/firebase-session", firebaseAuth, async (req, res) => {
  try {
    const fb = req.firebaseUser || {};
    const firebaseUid = String(fb.uid || "").trim();
    const email = String(fb.email || "").trim().toLowerCase();
    const emailVerified = !!fb.email_verified;
    const requestedSessionScope = normalizeRequestedSessionScope(req);
    const displayName =
      String(fb.name || "").trim() ||
      (email ? email.split("@")[0] : "User");

    if (!firebaseUid || !email) {
      return res.status(400).json({
        ok: false,
        error: "FIREBASE_TOKEN_MISSING_IDENTITY",
      });
    }

    let user = await User.findOne({
      $or: [{ firebaseUid }, { email }],
    });

    if (!user) {
      user = new User({
        name: displayName,
        email,
        firebaseUid,
        authProvider: "firebase",
        emailVerified,
        isActive: true,
        lastLogin: new Date(),
      });
    } else {
      user.email = email;
      user.name = user.name || displayName;
      user.firebaseUid = firebaseUid;
      user.emailVerified = emailVerified;
      user.lastLogin = new Date();

      if (user.authProvider === "password" && user.password) {
        user.authProvider = "hybrid";
      } else {
        user.authProvider = "firebase";
      }
    }

    await user.save();

    const permitUnverifiedSession = allowUnverifiedFirebaseSession();

    if (!emailVerified && !permitUnverifiedSession) {
      clearLegacyAuthCookie(res);

      return res.json({
        ok: true,
        data: {
          token: null,
          user: user.toJSON(),
          firebaseUid,
          emailVerified: false,
          currentTenantId: null,
          activeTenantIds: Array.isArray(user.activeTenantIds)
            ? user.activeTenantIds
            : [],
          memberships: [],
          sessionState: "verification_pending",
          requiresEmailVerification: true,
          sessionScope: requestedSessionScope,
          legacyAuthBridgeIssued: false,
        },
      });
    }

    if (!emailVerified && permitUnverifiedSession) {
      console.warn(
        "firebase-session allowing unverified Firebase session in local/dev:",
        email
      );
    }

    let tenantContext;

    try {
      tenantContext = await ensureUserTenantContext(user, {
        firebaseUid,
        email,
        displayName,
      });
    } catch (err) {
      if (
        isQuotaExceededError(err) &&
        ((Array.isArray(user.activeTenantIds) && user.activeTenantIds.length) ||
          String(user.defaultTenantId || "").trim())
      ) {
        console.warn(
          "firebase-session tenant bootstrap fallback due to quota pressure:",
          err?.message || err
        );
        tenantContext = buildFallbackTenantSession(user);
      } else {
        throw err;
      }
    }

    const token = issueLegacyApiToken(user, {
      authType: "firebase",
      sessionScope: requestedSessionScope,
    });

    setLegacyAuthCookie(res, token);

    return res.json({
      ok: true,
      data: {
        token,
        user: user.toJSON(),
        firebaseUid,
        emailVerified: !!emailVerified,
        currentTenantId: tenantContext.currentTenantId,
        activeTenantIds: tenantContext.activeTenantIds,
        memberships: tenantContext.memberships,
        sessionState: emailVerified ? "authenticated" : "authenticated_unverified",
        requiresEmailVerification: !emailVerified,
        sessionScope: requestedSessionScope,
        legacyAuthBridgeIssued: true,
      },
    });
  } catch (e) {
    console.error("firebase-session error:", e);

    return res.status(500).json({
      ok: false,
      error: "FIREBASE_SESSION_BOOTSTRAP_FAILED",
      message: e?.message || "Firebase session bootstrap failed",
      debug: {
        message: e?.message || "Firebase session bootstrap failed",
        stack: process.env.NODE_ENV !== "production" ? e?.stack || "" : "",
      },
    });
  }
});

// Legacy forgot/reset only
router.post("/request-reset", requireLegacyPasswordAuth, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ ok: false, error: "EMAIL_REQUIRED" });
    }

    const user = await User.findOne({
      email: String(email).toLowerCase().trim(),
    });

    if (!user) return res.json({ ok: true });

    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 15 * 60 * 1000);

    user.resetPasswordToken = token;
    user.resetPasswordExpires = expires;
    await user.save();

    const devToken = process.env.NODE_ENV === "production" ? undefined : token;
    return res.json({ ok: true, devToken });
  } catch (e) {
    console.error("request-reset error", e);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

router.post("/reset-password", requireLegacyPasswordAuth, async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};

    if (!token || !newPassword) {
      return res.status(400).json({ ok: false, error: "BAD_REQUEST" });
    }

    if (
      String(newPassword).length < 8 ||
      !/[A-Za-z]/.test(newPassword) ||
      !/[0-9]/.test(newPassword)
    ) {
      return res.status(400).json({
        ok: false,
        error: "WEAK_PASSWORD",
        message: "Min 8 chars with letters & numbers",
      });
    }

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({
        ok: false,
        error: "TOKEN_INVALID_OR_EXPIRED",
      });
    }

    user.password = String(newPassword);
    user.mustSetPassword = false;
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();

    return res.json({ ok: true });
  } catch (e) {
    console.error("reset-password error", e);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

router.post("/firebase-bridge-token", auth, async (req, res) => {
  try {
    const userId = String(req.user?.userId || req.userId || "").trim();
    const user = await User.findById(userId);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "USER_NOT_FOUND",
      });
    }

    if (!user.emailVerified) {
      return res.status(403).json({
        ok: false,
        error: "EMAIL_NOT_VERIFIED",
        message: "Email verification is required before opening the workspace.",
      });
    }

    const firebaseUser = await upsertFirebaseUserFromLegacyUser({
      email: user.email,
      displayName: user.name,
      emailVerified: true,
    });

    if (String(user.firebaseUid || "").trim() !== String(firebaseUser.uid || "").trim()) {
      user.firebaseUid = firebaseUser.uid;
      if (user.authProvider === "password" && user.password) {
        user.authProvider = "hybrid";
      } else if (!user.authProvider || user.authProvider === "legacy") {
        user.authProvider = "firebase";
      }
      await user.save();
    }

    let tenantContext;

    try {
      tenantContext = await ensureUserTenantContext(user, {
        firebaseUid: firebaseUser.uid,
        userId: String(user._id),
        email: user.email,
        displayName: user.name,
      });
    } catch (err) {
      if (
        isQuotaExceededError(err) &&
        ((Array.isArray(user.activeTenantIds) && user.activeTenantIds.length) ||
          String(user.defaultTenantId || "").trim())
      ) {
        console.warn(
          "firebase-bridge-token tenant bootstrap fallback due to quota pressure:",
          err?.message || err
        );
        tenantContext = buildFallbackTenantSession(user);
      } else {
        throw err;
      }
    }

    const customToken = await admin.auth().createCustomToken(firebaseUser.uid, {
      legacyUserId: String(user._id),
      email: user.email,
      emailVerified: true,
    });

    return res.json({
      ok: true,
      customToken,
      firebaseUid: firebaseUser.uid,
      currentTenantId: tenantContext.currentTenantId,
      activeTenantIds: tenantContext.activeTenantIds,
      memberships: tenantContext.memberships,
    });
  } catch (e) {
    console.error("firebase-bridge-token error:", e);
    return res.status(500).json({
      ok: false,
      error: "FIREBASE_BRIDGE_TOKEN_FAILED",
      message: e?.message || "Could not create Firebase bridge token.",
    });
  }
});


module.exports = router;