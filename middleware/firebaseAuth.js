const { admin, ensureFirebaseAdmin } = require("../lib/firebaseAdminApp");

function getBearerToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1] || null;
}

function isDev() {
  return process.env.NODE_ENV !== "production";
}

async function firebaseAuth(req, res, next) {
  try {
    ensureFirebaseAdmin();

    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({
        ok: false,
        error: "Missing Bearer token",
      });
    }

    const decoded = await admin.auth().verifyIdToken(token);
    req.firebaseUser = decoded;
    return next();
  } catch (e) {
    const message = e?.message || "Invalid token";
    const code = e?.code || "firebase-auth-failed";

    console.error("firebaseAuth error:", {
      code,
      message,
      projectId:
        admin.apps[0]?.options?.projectId ||
        process.env.FIREBASE_PROJECT_ID ||
        null,
    });

    return res.status(401).json({
      ok: false,
      error: "Invalid token",
      ...(isDev()
        ? {
            debug: {
              code,
              message,
              projectId:
                admin.apps[0]?.options?.projectId ||
                process.env.FIREBASE_PROJECT_ID ||
                null,
            },
          }
        : {}),
    });
  }
}

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