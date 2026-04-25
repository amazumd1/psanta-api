// services/api/utils/pii.js
function clampStr(s, max = 4000) {
  const out = String(s || "");
  return out.length > max ? out.slice(0, max) : out;
}

function redactPII(text) {
  let s = String(text || "");
  if (!s) return "";

  s = s.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");

  s = s.replace(
    /\b(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
    "[REDACTED_PHONE]"
  );

  s = s.replace(
    /\b\d{1,6}\s+[A-Za-z0-9#.,'\-\s]{2,40}\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|circle|cir|parkway|pkwy|place|pl|terrace|ter)\b\.?/gi,
    "[REDACTED_ADDRESS]"
  );

  s = s.replace(/\b(?:apt|unit|suite)\s*#?\s*\w+\b/gi, "[REDACTED_UNIT]");
  return s;
}

function redactMetaPII(meta, depth = 0) {
  if (depth > 5) return { _truncated: true };
  if (meta == null) return meta;
  if (typeof meta === "string") return redactPII(meta);
  if (typeof meta === "number" || typeof meta === "boolean") return meta;
  if (Array.isArray(meta)) return meta.slice(0, 60).map((x) => redactMetaPII(x, depth + 1));
  if (typeof meta !== "object") return String(meta);

  const out = {};
  const entries = Object.entries(meta).slice(0, 80);
  for (const [k, v] of entries) out[String(k).slice(0, 64)] = redactMetaPII(v, depth + 1);
  if (Object.keys(meta).length > entries.length) out._truncated = true;
  return out;
}

module.exports = { clampStr, redactPII, redactMetaPII };
