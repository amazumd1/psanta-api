const crypto = require("crypto");

function getEncryptionKey() {
  const raw = String(process.env.GOOGLE_GMAIL_TOKEN_ENC_KEY || process.env.OAUTH_TOKEN_ENC_KEY || "").trim();
  if (!raw) {
    throw new Error("GOOGLE_GMAIL_TOKEN_ENC_KEY is required");
  }
  return crypto.createHash("sha256").update(raw).digest();
}

function encryptString(plainText) {
  const text = String(plainText || "");
  if (!text) return null;

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ciphertext.toString("base64"),
  };
}

function decryptString(payload) {
  if (!payload || typeof payload !== "object") return "";

  const iv = Buffer.from(String(payload.iv || ""), "base64");
  const tag = Buffer.from(String(payload.tag || ""), "base64");
  const data = Buffer.from(String(payload.data || ""), "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
  decipher.setAuthTag(tag);

  const plain = Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]);

  return plain.toString("utf8");
}

module.exports = {
  encryptString,
  decryptString,
};