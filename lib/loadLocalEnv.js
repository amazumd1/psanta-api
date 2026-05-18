const fs = require("fs");
const path = require("path");

function isManagedRuntime() {
  return Boolean(
    process.env.VERCEL ||
      process.env.FLY_APP_NAME ||
      process.env.K_SERVICE ||
      process.env.FUNCTION_TARGET
  );
}

function hasText(value) {
  return String(value ?? "").trim().length > 0;
}

function applyEnvFile(file, { override = false } = {}) {
  if (!fs.existsSync(file)) return false;

  const dotenv = require("dotenv");
  const parsed = dotenv.parse(fs.readFileSync(file));

  for (const [key, value] of Object.entries(parsed)) {
    // Blank values ko ignore karo, warna .env.local ka GEMINI_API_KEY=
    // real .env wali key ko block kar sakta hai.
    if (!hasText(value)) continue;

    const currentHasValue = hasText(process.env[key]);
    if (override || !currentHasValue) {
      process.env[key] = value;
    }
  }

  return true;
}

function loadLocalEnv() {
  if (process.env.NODE_ENV === "production" || isManagedRuntime()) {
    return;
  }

  const apiRoot = path.resolve(__dirname, "..");

  // Base files first, then .env.local non-empty values override.
  const loaded = [];

  for (const file of [
    path.join(apiRoot, "config.env"),
    path.join(apiRoot, ".env"),
  ]) {
    if (applyEnvFile(file, { override: false })) loaded.push(path.basename(file));
  }

  const localFile = path.join(apiRoot, ".env.local");
  if (applyEnvFile(localFile, { override: true })) loaded.push(path.basename(localFile));

  if (process.env.NODE_ENV !== "production") {
    console.log("[env] loaded local env files:", loaded.length ? loaded.join(", ") : "none");
    console.log("[env] GEMINI_API_KEY loaded?", hasText(process.env.GEMINI_API_KEY));
  }
}

module.exports = { loadLocalEnv };