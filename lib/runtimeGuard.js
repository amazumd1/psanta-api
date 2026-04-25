function hasValue(name) {
  return String(process.env[name] ?? "").trim().length > 0;
}

function hasAny(names = []) {
  return names.some((name) => hasValue(name));
}

function validateRuntimeEnv() {
  const isProd = process.env.NODE_ENV === "production";
  const errors = [];
  const warnings = [];

  const pushMissing = (name, bucket = errors) => {
    bucket.push(name);
  };

  if (!hasValue("MONGODB_URI")) pushMissing("MONGODB_URI");
  if (!hasValue("JWT_SECRET")) pushMissing("JWT_SECRET");

  const hasFirebaseAdmin =
    hasAny([
      "FIREBASE_ADMIN_JSON_B64",
      "FIREBASE_ADMIN_JSON",
      "FIREBASE_SERVICE_ACCOUNT_JSON",
    ]) ||
    process.env.FIREBASE_USE_APPLICATION_DEFAULT === "true" ||
    Boolean(
      process.env.VERCEL ||
      process.env.FLY_APP_NAME ||
      process.env.K_SERVICE ||
      process.env.FUNCTION_TARGET ||
      process.env.FUNCTIONS_EMULATOR
    );

  if (isProd && !hasValue("COOKIE_SECRET")) pushMissing("COOKIE_SECRET");
  if (isProd && !hasValue("PAYROLL_CRON_SECRET")) pushMissing("PAYROLL_CRON_SECRET");
  if (isProd && !hasFirebaseAdmin) {
    pushMissing(
      "Firebase admin credentials (FIREBASE_ADMIN_JSON_B64 / FIREBASE_ADMIN_JSON / FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_USE_APPLICATION_DEFAULT=true)"
    );
  }

  if (!hasFirebaseAdmin) {
    warnings.push(
      "Firebase admin credentials are not configured in local env yet."
    );
  }

  if (isProd && !hasValue("CORS_ORIGINS")) {
    warnings.push("CORS_ORIGINS is empty. Set your exact production frontend origins.");
  }

  if (isProd && !hasAny(["OPS_ADMIN_EMAILS", "OPS_ADMIN_UIDS"])) {
    warnings.push("Set OPS_ADMIN_EMAILS and/or OPS_ADMIN_UIDS for invite/admin protection.");
  }

  if (isProd && !hasValue("PORTAL_BASE_URL")) {
    warnings.push("PORTAL_BASE_URL is empty.");
  }

  if (isProd && !hasValue("API_BASE_URL")) {
    warnings.push("API_BASE_URL is empty.");
  }

  return {
    ok: errors.length === 0,
    isProd,
    errors,
    warnings,
  };
}

function assertRuntimeEnv() {
  const result = validateRuntimeEnv();

  for (const warning of result.warnings) {
    console.warn("[env-warning]", warning);
  }

  if (!result.ok) {
    throw new Error(
      `Runtime env validation failed: ${result.errors.join(", ")}`
    );
  }

  return result;
}

module.exports = {
  validateRuntimeEnv,
  assertRuntimeEnv,
};