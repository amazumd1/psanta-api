// services/api/lib/secretBox.js
const crypto = require("crypto");

function getKey() {
  const secret = String(process.env.RETAIL_GMAIL_TOKEN_SECRET || "").trim();
  if (!secret) {
    throw new Error("RETAIL_GMAIL_TOKEN_SECRET is required");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptText(plainText) {
  const iv = crypto.randomBytes(12);
  const key = getKey();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const enc = Buffer.concat([
    cipher.update(String(plainText || ""), "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: enc.toString("base64"),
  };
}

function decryptText(payload) {
  if (!payload || !payload.iv || !payload.tag || !payload.data) {
    return "";
  }

  const key = getKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64")
  );

  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));

  const out = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]);

  return out.toString("utf8");
}

module.exports = {
  encryptText,
  decryptText,
};