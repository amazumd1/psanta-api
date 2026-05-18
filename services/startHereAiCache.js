const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 500;

const memory = {
  loaded: false,
  records: {},
};

function asString(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isCacheEnabled() {
  const raw = String(process.env.START_HERE_AI_CACHE_ENABLED ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

function getCacheTtlMs() {
  return Math.max(
    60 * 1000,
    Math.min(30 * 24 * 60 * 60 * 1000, asNumber(process.env.START_HERE_AI_CACHE_TTL_MS, DEFAULT_TTL_MS))
  );
}

function getMaxRecords() {
  return Math.max(25, Math.min(5000, asNumber(process.env.START_HERE_AI_CACHE_MAX_RECORDS, DEFAULT_MAX_RECORDS)));
}

function getCacheFilePath() {
  return (
    process.env.START_HERE_AI_CACHE_FILE ||
    path.join(__dirname, "..", ".runtime", "start-here-ai-cache.json")
  );
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeList(value, max = 20) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => asString(item, 80)).filter(Boolean)))
    .sort()
    .slice(0, max);
}

function getFieldShape(extracted = {}) {
  return {
    hasZip: Boolean(asString(extracted.zip, 20)),
    hasPropertyType: Boolean(asString(extracted.propertyType, 80)),
    hasBedrooms: Number.isFinite(Number(extracted.bedrooms)) && Number(extracted.bedrooms) > 0,
    hasBathrooms: Number.isFinite(Number(extracted.bathrooms)) && Number(extracted.bathrooms) > 0,
    hasSquareFeet: Number.isFinite(Number(extracted.squareFeet)) && Number(extracted.squareFeet) > 0,
    hasServiceType: Boolean(asString(extracted.serviceType, 80)),
    hasTiming: Boolean(asString(extracted.timing, 120)),
    hasPropertyLink: Boolean(asString(extracted.propertyLink, 500)),
    hasUrgency: Boolean(asString(extracted.urgency, 40)),
    hasNotes: Boolean(asString(extracted.notes, 500)),
    hasAddons: Array.isArray(extracted.addons) && extracted.addons.length > 0,
  };
}

function makePatternSignature(state = {}) {
  const extracted = state.extracted || {};
  const payload = {
    version: CACHE_VERSION,
    intent: asString(state.intent || "unknown", 40),
    stage: asString(state.stage || "", 80),
    requiredFields: normalizeList(state.requiredFields, 12),
    missingFields: normalizeList(state.missingFields, 12),
    fieldShape: getFieldShape(extracted),
    propertyType: asString(extracted.propertyType, 80).toLowerCase(),
    serviceType: asString(extracted.serviceType, 80).toLowerCase(),
    urgency: asString(extracted.urgency, 40).toLowerCase(),
    addons: normalizeList(extracted.addons, 12),
  };

  return JSON.stringify(payload);
}

function makeCacheKey(state = {}) {
  return sha256(makePatternSignature(state)).slice(0, 32);
}

function ensureLoaded() {
  if (memory.loaded) return;

  memory.loaded = true;
  memory.records = {};

  const file = getCacheFilePath();
  if (!fs.existsSync(file)) return;

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed.records === "object" && parsed.records) {
      memory.records = parsed.records;
    }
  } catch (error) {
    console.warn("[start-here-ai-cache] failed to load cache", error?.message || error);
    memory.records = {};
  }
}

function persist() {
  if (!isCacheEnabled()) return;

  const file = getCacheFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          version: CACHE_VERSION,
          updatedAt: new Date().toISOString(),
          records: memory.records,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.warn("[start-here-ai-cache] failed to persist cache", error?.message || error);
  }
}

function prune() {
  ensureLoaded();

  const now = Date.now();
  const ttlMs = getCacheTtlMs();
  const records = Object.entries(memory.records)
    .filter(([, record]) => record && now - Number(record.updatedAtMs || 0) <= ttlMs)
    .sort((a, b) => Number(b[1].lastHitAtMs || b[1].updatedAtMs || 0) - Number(a[1].lastHitAtMs || a[1].updatedAtMs || 0))
    .slice(0, getMaxRecords());

  memory.records = Object.fromEntries(records);
}

function buildCachedReply({ fallbackState, record }) {
  const responseTemplate = record.responseTemplate || {};
  const reply = {
    ...fallbackState,
    ok: true,
    source: "cache",
    confidence: Math.max(Number(fallbackState.confidence || 0), Number(responseTemplate.confidence || 0) - 0.05, 0.72),
    cache: {
      hit: true,
      key: record.key,
      sampleCount: Number(record.sampleCount || 0),
      hitCount: Number(record.hitCount || 0) + 1,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      basedOnModel: record.model || null,
    },
  };

  // Keep current user's extracted values authoritative. Reuse only safe structural template fields.
  reply.requiredFields = fallbackState.requiredFields || responseTemplate.requiredFields || [];
  reply.missingFields = fallbackState.missingFields || responseTemplate.missingFields || [];
  reply.completeness = fallbackState.completeness || responseTemplate.completeness || null;
  reply.nextQuestion = fallbackState.nextQuestion || responseTemplate.nextQuestion || "";
  reply.chips = Array.isArray(fallbackState.chips) && fallbackState.chips.length ? fallbackState.chips : responseTemplate.chips || [];
  reply.ctaKey = fallbackState.ctaKey || responseTemplate.ctaKey || null;
  reply.shouldCreateLead = Boolean(fallbackState.shouldCreateLead);
  reply.handoff = Boolean(fallbackState.handoff);
  reply.leadDraft = fallbackState.leadDraft || responseTemplate.leadDraft || null;
  reply.safetyNotice = fallbackState.safetyNotice || responseTemplate.safetyNotice || "";

  return reply;
}

function getCachedReply({ message, fallbackState }) {
  if (!isCacheEnabled()) return null;
  if (!fallbackState || fallbackState.intent === "unknown") return null;

  ensureLoaded();
  prune();

  const key = makeCacheKey(fallbackState);
  const record = memory.records[key];
  if (!record) return null;

  const now = Date.now();
  if (now - Number(record.updatedAtMs || 0) > getCacheTtlMs()) {
    delete memory.records[key];
    persist();
    return null;
  }

  record.hitCount = Number(record.hitCount || 0) + 1;
  record.lastHitAt = new Date(now).toISOString();
  record.lastHitAtMs = now;
  record.lastMessageHash = sha256(asString(message, 2000));
  persist();

  return buildCachedReply({ fallbackState, record });
}

function storeGeminiResponse({ message, fallbackState, response, model, aiDiagnostics }) {
  if (!isCacheEnabled()) return null;
  if (!response || response.source !== "gemini") return null;
  if (!fallbackState || response.intent === "unknown") return null;
  if (Number(response.confidence || 0) < Number(process.env.START_HERE_AI_CACHE_MIN_CONFIDENCE || 0.65)) return null;

  ensureLoaded();
  prune();

  const key = makeCacheKey(fallbackState);
  const now = Date.now();
  const existing = memory.records[key] || {};

  const record = {
    ...existing,
    key,
    version: CACHE_VERSION,
    signature: makePatternSignature(fallbackState),
    messageHash: sha256(asString(message, 2000)),
    intent: asString(response.intent || fallbackState.intent, 40),
    stage: asString(response.stage || fallbackState.stage, 80),
    fieldShape: getFieldShape(fallbackState.extracted || {}),
    addons: normalizeList(fallbackState.extracted?.addons || response.extracted?.addons, 12),
    missingFields: normalizeList(response.missingFields || fallbackState.missingFields, 12),
    responseTemplate: {
      intent: response.intent,
      stage: response.stage,
      confidence: Number(response.confidence || 0),
      requiredFields: normalizeList(response.requiredFields, 12),
      missingFields: normalizeList(response.missingFields, 12),
      completeness: response.completeness || null,
      nextQuestion: asString(response.nextQuestion, 220),
      chips: Array.isArray(response.chips) ? response.chips.slice(0, 5) : [],
      ctaKey: response.ctaKey || null,
      safetyNotice: asString(response.safetyNotice, 220),
    },
    model: model || aiDiagnostics?.model || null,
    modelDiagnosticsReason: aiDiagnostics?.reason || null,
    sampleCount: Number(existing.sampleCount || 0) + 1,
    hitCount: Number(existing.hitCount || 0),
    createdAt: existing.createdAt || new Date(now).toISOString(),
    createdAtMs: existing.createdAtMs || now,
    updatedAt: new Date(now).toISOString(),
    updatedAtMs: now,
  };

  memory.records[key] = record;
  persist();

  return {
    stored: true,
    key,
    sampleCount: record.sampleCount,
  };
}

function getStats() {
  ensureLoaded();
  prune();

  const records = Object.values(memory.records);
  return {
    enabled: isCacheEnabled(),
    file: getCacheFilePath(),
    ttlMs: getCacheTtlMs(),
    maxRecords: getMaxRecords(),
    count: records.length,
    totalHits: records.reduce((sum, record) => sum + Number(record.hitCount || 0), 0),
    intents: records.reduce((acc, record) => {
      const intent = record.intent || "unknown";
      acc[intent] = (acc[intent] || 0) + 1;
      return acc;
    }, {}),
  };
}

module.exports = {
  getCachedReply,
  storeGeminiResponse,
  getStats,
  makeCacheKey,
};