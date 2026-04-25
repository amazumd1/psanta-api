// services/api/routes/psAiStr.js
// FINAL (Part 6 + Part 7 merged)
// - Gemini structured extraction (responseJsonSchema) via fetch
// - Feature flag PS_LLM_ENABLED (server kill-switch)
// - Rate limit per user/IP (PS_LLM_RPM)
// - PII redaction (default ON; allow_pii optional)
// - Timeout + 1 retry
// - Regex fallback if quota/timeout/down

const express = require("express");
const fetch = require("node-fetch"); // v2
const { authOptional } = require("../middleware/auth");

const router = express.Router();

/* ------------------------------ config ------------------------------ */

const PS_LLM_ENABLED = !["0", "false", "off", "no"].includes(
  String(process.env.PS_LLM_ENABLED || "1").trim().toLowerCase()
);

const GEMINI_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// per minute limit (per user or per IP)
const LLM_RPM = Math.max(3, Math.min(120, Number(process.env.PS_LLM_RPM || 18)));
const TIMEOUT_MS = Math.max(2000, Math.min(20000, Number(process.env.GEMINI_TIMEOUT_MS || 9000)));

/* ------------------------------ utils ------------------------------ */

function clampText(s, max = 1800) {
  const t = String(s || "").trim();
  return t.length > max ? t.slice(0, max) : t;
}

function getClientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.ip || req.connection?.remoteAddress || "";
}

function redactPII(text = "") {
  let s = String(text || "");

  // emails
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");

  // phones (best effort)
  s = s.replace(/(?:\+?\d[\d\s().-]{8,}\d)/g, "[REDACTED_PHONE]");

  // street-ish addresses (rough)
  s = s.replace(
    /\b\d{1,6}\s+[A-Za-z0-9.'\- ]{2,40}\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|way|pkwy|parkway|pl|place|ter|terrace|cir|circle)\b/gi,
    "[REDACTED_ADDRESS]"
  );

  // apt/unit
  s = s.replace(/\b(?:apt|unit|suite)\s*#?\s*\w+\b/gi, "[REDACTED_UNIT]");

  return s;
}

function safeJsonParse(s) {
  let t = String(s || "").trim();
  if (!t) return null;

  const fence = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence?.[1]) t = fence[1].trim();

  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/* ------------------------- rate limiter (memory) ------------------------- */

const buckets = new Map();

function rateLimit(req, res, next) {
  try {
    const now = Date.now();
    const uid = req.userId || req.user?._id || req.user?.id || "";
    const ip = getClientIp(req);
    const key = uid ? `u:${uid}` : `ip:${ip}`;

    const windowMs = 60 * 1000;
    let b = buckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }

    b.count += 1;

    res.setHeader("X-RateLimit-Limit", String(LLM_RPM));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, LLM_RPM - b.count)));

    if (b.count > LLM_RPM) {
      const retryAfterMs = Math.max(0, b.resetAt - now);
      res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
      return res.status(429).json({ ok: false, code: "rate_limited", retryAfterMs });
    }

    next();
  } catch {
    next();
  }
}

// cleanup old buckets
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets.entries()) {
    if (!b || now > b.resetAt + 60 * 1000) buckets.delete(k);
  }
}, 60 * 1000).unref?.();

/* -------------------------- JSON schema (Gemini) -------------------------- */
/**
 * IMPORTANT: schema uses your FRONTEND field names:
 * beds, baths, guestsMax, rules.party, standout, amenities[] etc.
 */

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    patch: {
      type: "object",
      additionalProperties: false,
      properties: {
        beds: { type: ["string", "number"] },
        baths: { type: ["string", "number"] },
        guestsMax: { type: ["string", "number"] },
        propertyType: { type: "string" },
        areaHint: { type: "string" },
        standout: { type: "string" },
        rules: {
          type: "object",
          additionalProperties: false,
          properties: {
            pets: { type: "string" },
            smoking: { type: "string" },
            party: { type: "string" },
          },
        },

        nightlyMin: { type: ["string", "number"] },
        nightlyMax: { type: ["string", "number"] },
        cleaningFee: { type: ["string", "number"] },
        securityDeposit: { type: ["string", "number"] },
        minNights: { type: ["string", "number"] },
        discounts: { type: "string" },

        checkInTime: { type: "string" },
        checkOutTime: { type: "string" },
        checkInMethod: { type: "string" },
        parkingType: { type: "string" },
        evCharger: { type: "string" },

        amenities: {
          type: "array",
          items: { type: "string" }, // keep flexible; frontend merges to canonical chips
        },
        wifiSpeedMbps: { type: ["string", "number"] },
      },
    },
    confidence: {
      type: "object",
      additionalProperties: false,
      properties: {
        beds: { type: "number" },
        baths: { type: "number" },
        guestsMax: { type: "number" },
        propertyType: { type: "number" },
        areaHint: { type: "number" },
        standout: { type: "number" },
        rules: { type: "number" },

        nightlyMin: { type: "number" },
        nightlyMax: { type: "number" },
        cleaningFee: { type: "number" },
        securityDeposit: { type: "number" },
        minNights: { type: "number" },
        discounts: { type: "number" },

        checkInTime: { type: "number" },
        checkOutTime: { type: "number" },
        checkInMethod: { type: "number" },
        parkingType: { type: "number" },
        evCharger: { type: "number" },

        amenities: { type: "number" },
        wifiSpeedMbps: { type: "number" },
      },
    },
    needsConfirmation: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "beds",
          "baths",
          "guestsMax",
          "propertyType",
          "areaHint",
          "standout",
          "rules",
          "nightlyMin",
          "nightlyMax",
          "cleaningFee",
          "securityDeposit",
          "minNights",
          "discounts",
          "checkInTime",
          "checkOutTime",
          "checkInMethod",
          "parkingType",
          "evCharger",
          "amenities",
          "wifiSpeedMbps",
        ],
      },
    },
  },
  required: ["patch"],
};

function buildPrompt({ text, draft }) {
  const safeDraft = draft && typeof draft === "object" ? draft : {};
  const hint = {
    beds: safeDraft.beds,
    baths: safeDraft.baths,
    guestsMax: safeDraft.guestsMax,
    propertyType: safeDraft.propertyType,
  };

  return [
    "Extract structured STR listing details from the user message.",
    "Return ONLY JSON matching the schema.",
    "Rules:",
    "- Do NOT invent facts. If unclear, omit the field.",
    "- Never output exact street address / phone / email (use areaHint only).",
    "- If multiple prices are given (weekday/weekend), map to nightlyMin/nightlyMax.",
    "- amenities should be a list of short labels (e.g., 'Kitchen', 'Washer/Dryer', 'Pool', 'Gym', 'Workspace', 'Air conditioning', 'Heating').",
    "",
    `Existing draft hints: ${JSON.stringify(hint)}`,
    "",
    `User message: ${text}`,
  ].join("\n");
}

function modelPath(m) {
  const s = String(m || "").trim();
  if (!s) return `models/${GEMINI_MODEL}`;
  return s.startsWith("models/") ? s : `models/${s}`;
}

/* --------------------- normalize (align to frontend) --------------------- */

function normalizeResponse(obj) {
  const patch = obj?.patch && typeof obj.patch === "object" ? obj.patch : {};
  const confidence = obj?.confidence && typeof obj.confidence === "object" ? obj.confidence : {};
  const needs = Array.isArray(obj?.needsConfirmation) ? obj.needsConfirmation : [];
  const summary = typeof obj?.summary === "string" ? obj.summary.trim() : "";

  // normalize types
  const out = { ...patch };

  ["beds", "baths", "guestsMax", "nightlyMin", "nightlyMax", "cleaningFee", "securityDeposit", "minNights", "wifiSpeedMbps"].forEach(
    (k) => {
      if (typeof out[k] === "number") out[k] = String(out[k]);
      if (typeof out[k] === "string") out[k] = out[k].trim();
    }
  );

  // rules
  if (out.rules && typeof out.rules === "object") {
    out.rules = {
      pets: out.rules.pets ? String(out.rules.pets).slice(0, 40) : undefined,
      smoking: out.rules.smoking ? String(out.rules.smoking).slice(0, 40) : undefined,
      party: out.rules.party ? String(out.rules.party).slice(0, 40) : undefined,
    };
    Object.keys(out.rules).forEach((k) => out.rules[k] === undefined && delete out.rules[k]);
    if (!Object.keys(out.rules).length) delete out.rules;
  } else {
    delete out.rules;
  }

  // amenities
  if (Array.isArray(out.amenities)) {
    out.amenities = out.amenities
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .slice(0, 20);
  } else {
    delete out.amenities;
  }

  // confidence clamp 0..1
  const outConf = {};
  for (const k of Object.keys(confidence || {})) {
    const n = Number(confidence[k]);
    if (!Number.isFinite(n)) continue;
    outConf[k] = Math.max(0, Math.min(1, n));
  }

  const outNeeds = needs.map((x) => String(x || "").trim()).filter(Boolean);

  return { patch: out, confidence: outConf, needsConfirmation: outNeeds, summary };
}

/* -------------------------- Gemini call (retry) -------------------------- */

async function callGeminiStructured({ text, draft }) {
  if (!PS_LLM_ENABLED) return { ok: false, fallback: true, error: "llm_disabled" };
  if (!GEMINI_KEY) return { ok: false, fallback: true, error: "gemini_key_missing" };

  const model = modelPath(GEMINI_MODEL);
  const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;

  const payload = {
    contents: [{ role: "user", parts: [{ text: buildPrompt({ text, draft }) }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 900,
      responseMimeType: "application/json",
      responseJsonSchema: RESPONSE_SCHEMA,
    },
  };

  const runOnce = async () => {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_KEY,
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });

      const status = resp.status;
      const data = await resp.json().catch(() => null);

      if (!resp.ok) {
        const msg =
          data?.error?.message ||
          (status === 429 ? "quota_exceeded" : status === 401 ? "unauthorized" : "gemini_error");
        return { ok: false, fallback: true, status, error: msg };
      }

      const outText =
        (data?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || "").join("") || "";
      const parsed = safeJsonParse(outText);
      if (!parsed) return { ok: false, fallback: true, status, error: "invalid_json" };

      return { ok: true, ...normalizeResponse(parsed), model: model.replace(/^models\//, "") };
    } catch (e) {
      const isAbort = String(e?.name || "").toLowerCase().includes("abort");
      return { ok: false, fallback: true, error: isAbort ? "timeout" : "network_error" };
    } finally {
      clearTimeout(to);
    }
  };

  // 1 retry for transient failures
  const r1 = await runOnce();
  if (r1.ok) return r1;

  const transient = ["timeout", "network_error", "quota_exceeded"].some((x) =>
    String(r1.error || "").toLowerCase().includes(x)
  );
  if (!transient) return r1;

  await new Promise((r) => setTimeout(r, 250));
  return await runOnce();
}

/* ------------------------------ regex fallback ------------------------------ */

function cleanMoney(v, max = 6) {
  return String(v || "").replace(/[^\d]/g, "").slice(0, max);
}

function regexFallback(text = "") {
  const t = String(text || "").toLowerCase();
  const patch = {};

  const bed = t.match(/\b(\d+(?:\.\d+)?)\s*(?:bed|beds|bd|br)\b/);
  const bath = t.match(/\b(\d+(?:\.\d+)?)\s*(?:bath|baths|ba)\b/);
  const sleep = t.match(/\b(?:sleeps|max\s*guests?|guests?)\s*[:=]?\s*(\d{1,2})\b/);

  if (bed?.[1]) patch.beds = bed[1];
  if (bath?.[1]) patch.baths = bath[1];
  if (sleep?.[1]) patch.guestsMax = sleep[1];

  const nightly = t.match(/\$?(\d{2,5})(?:\s*(?:-|–|to)\s*\$?(\d{2,5}))?\s*(?:\/\s*night|per\s*night|nightly)\b/);
  if (nightly?.[1]) patch.nightlyMin = cleanMoney(nightly[1], 5);
  if (nightly?.[2]) patch.nightlyMax = cleanMoney(nightly[2], 5);

  const cleaning = t.match(/\bcleaning(?:\s*fee)?\s*[:=]?\s*\$?(\d{1,5})\b/);
  if (cleaning?.[1]) patch.cleaningFee = cleanMoney(cleaning[1], 5);

  const minN = t.match(/\bmin(?:imum)?\s*(?:stay)?\s*[:=]?\s*(\d{1,2})\s*(?:night|nights)\b/);
  if (minN?.[1]) patch.minNights = cleanMoney(minN[1], 2);

  return { patch };
}

/* ------------------------------ routes ------------------------------ */

// GET /api/ps/ai/str/flags
router.get("/flags", (req, res) => {
  res.json({
    ok: true,
    llmEnabled: !!(PS_LLM_ENABLED && GEMINI_KEY),
    model: GEMINI_MODEL,
    rpm: LLM_RPM,
    timeoutMs: TIMEOUT_MS,
  });
});

// POST /api/ps/ai/str/extract
// Body: { text: string, draft?: object, allow_pii?: boolean }
router.post("/extract", authOptional, rateLimit, async (req, res) => {
  const raw = String(req.body?.text || req.body?.message || "").trim();
  if (!raw) return res.status(400).json({ ok: false, error: "missing_text" });

  const allowPII = req.body?.allow_pii === true;

  const text = allowPII ? clampText(raw, 1800) : redactPII(clampText(raw, 1800));
  const draft = req.body?.draft && typeof req.body.draft === "object" ? req.body.draft : {};

  const r = await callGeminiStructured({ text, draft });

  if (r.ok) {
    return res.json({
      ok: true,
      used: "gemini",
      redacted: !allowPII,
      ...r,
    });
  }

  // fallback: regex (frontend still has its own regex too, but this keeps API usable)
  const rf = regexFallback(text);
  return res.json({
    ok: true,
    used: r.error ? "regex_fallback" : "regex",
    redacted: !allowPII,
    error: r.error || "fallback",
    patch: rf.patch || {},
    confidence: {},
    needsConfirmation: Object.keys(rf.patch || {}),
    summary: "",
  });
});

module.exports = router;
