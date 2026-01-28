// services/api/middleware/firebaseAuth.js
const admin = require("firebase-admin");

/**
 * Make sure you initialize firebase-admin ONCE in your server boot.
 * If already initialized elsewhere, keep that and remove init here.
 */
function ensureFirebaseAdmin() {
  if (admin.apps.length) return;
  const json = process.env.FIREBASE_ADMIN_JSON;
  if (!json) {
    throw new Error("FIREBASE_ADMIN_JSON not set");
  }
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(json)),
  });
}

// ✅ verifies Firebase ID token and sets req.firebaseUser
async function firebaseAuth(req, res, next) {
  try {
    ensureFirebaseAdmin();

    const h = req.headers.authorization || "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    const token = m?.[1];

    if (!token) {
      return res.status(401).json({ ok: false, error: "Missing Bearer token" });
    }

    const decoded = await admin.auth().verifyIdToken(token);
    req.firebaseUser = decoded; // contains uid, email (if any), etc.
    return next();
  } catch (e) {
    console.error("firebaseAuth error:", e?.message || e);
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}

// ✅ your function (as-is) — email OR uid allowlist
function requireOpsAdmin(req, res, next) {
  const email = String(req.firebaseUser?.email || "").toLowerCase().trim();
  const uid = String(req.firebaseUser?.uid || "").trim();

  const emailsRaw = String(process.env.OPS_ADMIN_EMAILS || "").trim();
  const uidsRaw = String(process.env.OPS_ADMIN_UIDS || "").trim();

  const allowEmails = emailsRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const allowUids = uidsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const emailOk =
    !!email &&
    allowEmails.some((a) => a === email || (a.startsWith("@") && email.endsWith(a)));

  const uidOk = !!uid && allowUids.includes(uid);

  if (!emailOk && !uidOk) {
    return res.status(403).json({
      ok: false,
      error: "Forbidden",
      userEmail: email || null,
      userUid: uid || null,
      hint: "Add email to OPS_ADMIN_EMAILS or uid to OPS_ADMIN_UIDS",
    });
  }

  return next();
}

module.exports = { firebaseAuth, requireOpsAdmin };
