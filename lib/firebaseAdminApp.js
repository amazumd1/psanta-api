const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

function parseServiceAccount(raw, label) {
  let parsed;

  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }

  if (parsed?.private_key) {
    parsed.private_key = String(parsed.private_key).replace(/\\n/g, "\n");
  }

  return parsed;
}

function resolveServiceAccountFromEnv() {
  if (process.env.FIREBASE_ADMIN_JSON_B64) {
    const decoded = Buffer.from(
      process.env.FIREBASE_ADMIN_JSON_B64,
      "base64"
    ).toString("utf8");
    return parseServiceAccount(decoded, "FIREBASE_ADMIN_JSON_B64");
  }

  if (process.env.FIREBASE_ADMIN_JSON) {
    return parseServiceAccount(
      process.env.FIREBASE_ADMIN_JSON,
      "FIREBASE_ADMIN_JSON"
    );
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return parseServiceAccount(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
      "FIREBASE_SERVICE_ACCOUNT_JSON"
    );
  }

  return null;
}

function isLocalFileCredsAllowed() {
  if (process.env.NODE_ENV === "production") return false;
  return String(process.env.FIREBASE_ALLOW_LOCAL_FILE_CREDENTIALS || "").trim() === "true";
}

function resolveServiceAccountPath() {
  const raw =
    process.env.FIREBASE_ADMIN_CREDENTIALS_PATH ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    "";

  const value = String(raw).trim();
  if (!value) return null;

  if (path.isAbsolute(value)) return value;
  return path.resolve(process.cwd(), value);
}

function resolveServiceAccountFromFile() {
  if (!isLocalFileCredsAllowed()) return null;

  const filePath = resolveServiceAccountPath();
  if (!filePath) return null;

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Firebase admin credentials file not found at: ${filePath}`
    );
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return parseServiceAccount(raw, "FIREBASE_ADMIN_CREDENTIALS_PATH");
}

function shouldUseApplicationDefault() {
  return (
    process.env.FIREBASE_USE_APPLICATION_DEFAULT === "true" ||
    Boolean(process.env.K_SERVICE) ||
    Boolean(process.env.FLY_APP_NAME) ||
    Boolean(process.env.FUNCTION_TARGET) ||
    Boolean(process.env.FUNCTIONS_EMULATOR)
  );
}

function ensureFirebaseAdmin() {
  if (admin.apps.length) return admin;

  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT;

  const serviceAccount =
    resolveServiceAccountFromEnv() || resolveServiceAccountFromFile();

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId:
        projectId || serviceAccount.project_id || serviceAccount.projectId,
    });
    return admin;
  }

  if (shouldUseApplicationDefault()) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId,
    });
    return admin;
  }

  throw new Error(
    "Firebase admin credentials not configured. Use FIREBASE_ADMIN_JSON_B64 / FIREBASE_ADMIN_JSON / FIREBASE_SERVICE_ACCOUNT_JSON, or enable local file creds with FIREBASE_ALLOW_LOCAL_FILE_CREDENTIALS=true + FIREBASE_ADMIN_CREDENTIALS_PATH, or set FIREBASE_USE_APPLICATION_DEFAULT=true on a managed runtime."
  );
}

function getFirestore() {
  ensureFirebaseAdmin();
  return admin.firestore();
}

function serverTimestamp() {
  ensureFirebaseAdmin();
  return admin.firestore.FieldValue.serverTimestamp();
}

module.exports = {
  admin,
  ensureFirebaseAdmin,
  getFirestore,
  serverTimestamp,
};