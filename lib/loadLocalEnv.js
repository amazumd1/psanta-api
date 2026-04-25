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

function loadLocalEnv() {
  if (process.env.NODE_ENV === "production" || isManagedRuntime()) {
    return;
  }

  const dotenv = require("dotenv");

  const candidates = [
    path.resolve(__dirname, "../.env.local"),
    path.resolve(__dirname, "../.env"),
  ];

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      dotenv.config({ path: file, override: false });
    }
  }
}

module.exports = { loadLocalEnv };