// services/api/middleware/firebaseAuth.js
const admin = require("firebase-admin");

function getBearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  if (!/^Bearer\s+/i.test(h)) return null;
  return h.replace(/^Bearer\s+/i, "").trim() || null;
}

function ensureFirebaseAdmin() {
  if (admin.apps.length) return;
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

function firebaseAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ ok: false, error: "Missing bearer token" });

    ensureFirebaseAdmin();

    admin
      .auth()
      .verifyIdToken(token)
      .then((decoded) => {
        req.firebaseUser = decoded; // { email, uid, ... }
        next();
      })
      .catch((e) => {
        console.error("firebaseAuth verifyIdToken failed:", e?.message || e);
        return res.status(401).json({ ok: false, error: "Invalid token" });
      });
  } catch (e) {
    console.error("firebaseAuth error:", e);
    return res.status(500).json({ ok: false, error: "Auth service error" });
  }
}

function requireOpsAdmin(req, res, next) {
  const email = String(req.firebaseUser?.email || "").toLowerCase();
  const allow = String(process.env.OPS_ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (!email || !allow.includes(email)) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }
  next();
}

module.exports = { firebaseAuth, requireOpsAdmin };
