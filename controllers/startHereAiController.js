const fetchImpl = global.fetch || require("node-fetch");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = Math.max(2500, Math.min(20000, Number(process.env.OPENAI_TIMEOUT_MS || 9000)));

const allowedIntent = new Set(["cleaning", "str", "listing", "pros", "addons", "unknown"]);
const allowedCta = new Set(["cleaning", "str", "listing", "pros"]);

function asString(value, max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function extractZip(text = "") {
  const match = String(text || "").match(/\b\d{5}(?:-\d{4})?\b/);
  return match ? match[0].slice(0, 5) : "";
}

function makeChip(id, label, prompt) {
  return {
    id: asString(id, 48),
    label: asString(label, 40),
    prompt: asString(prompt || label, 180),
  };
}

function normalizeChips(chips, fallback = []) {
  const list = Array.isArray(chips) ? chips : [];
  const clean = list
    .map((chip, index) => {
      if (typeof chip === "string") return makeChip(`chip_${index}`, chip, chip);
      return makeChip(chip?.id || `chip_${index}`, chip?.label, chip?.prompt || chip?.label);
    })
    .filter((chip) => chip.label && chip.prompt)
    .slice(0, 5);

  return clean.length ? clean : fallback;
}

function baseFallback(message = "") {
  const raw = asString(message, 2000);
  const text = raw.toLowerCase();
  const zip = extractZip(raw);
  const zipLine = zip ? ` I caught ZIP ${zip}, so we can keep the next step local.` : "";

  if (/airbnb|vrbo|str|short.?term|turnover|checkout|check.?in|guest/.test(text)) {
    return {
      ok: true,
      source: "fallback",
      reply: `Great — this sounds like short-term rental support.${zipLine} I can help with turnover cleaning, laundry, restocks, calendar-based prep, guest-ready reset details, and backup cleaner coverage.`,
      intent: "str",
      confidence: zip ? 0.78 : 0.72,
      extracted: { zip, serviceType: "str_turnover", addons: [], urgency: "normal" },
      chips: [
        makeChip("str-clean", "Turnover cleaning", "I need STR turnover cleaning"),
        makeChip("laundry", "Laundry / restock", "I need laundry and restock add-ons"),
        makeChip("backup", "Backup cleaner", "I need backup cleaner support"),
      ],
      ctaKey: "str",
      shouldCreateLead: false,
      handoff: false,
    };
  }

  if (/clean|maid|deep|move.?out|move.?in|standard|housekeeping|sanitize/.test(text)) {
    return {
      ok: true,
      source: "fallback",
      reply: `Perfect — cleaning is the fastest path.${zipLine} I’d collect property type, bedrooms/bathrooms, service type, timing, and add-ons like laundry, fridge, oven, linens, pet hair, and priority scheduling.`,
      intent: "cleaning",
      confidence: zip ? 0.82 : 0.76,
      extracted: { zip, serviceType: "cleaning", addons: [], urgency: "normal" },
      chips: [
        makeChip("standard", "Standard clean", "I need standard cleaning"),
        makeChip("deep", "Deep clean", "I need deep cleaning"),
        makeChip("move", "Move-in / move-out", "I need move in or move out cleaning"),
      ],
      ctaKey: "cleaning",
      shouldCreateLead: false,
      handoff: false,
    };
  }

  if (/list|listing|tenant|renter|rent|zillow|property link|publish|match/.test(text)) {
    return {
      ok: true,
      source: "fallback",
      reply: `Nice — for listing and matches, I’d collect the property link, city/ZIP, rent type, bedrooms/bathrooms, photos if available, and who you want to match with.${zipLine}`,
      intent: "listing",
      confidence: zip ? 0.78 : 0.7,
      extracted: { zip, serviceType: "listing_matches", addons: [], urgency: "normal" },
      chips: [
        makeChip("paste-link", "I have a property link", "I have a property link to paste"),
        makeChip("tenant", "Find tenants", "I want to find tenant matches"),
        makeChip("owner", "Owner listing help", "I need owner listing help"),
      ],
      ctaKey: "listing",
      shouldCreateLead: false,
      handoff: false,
    };
  }

  if (/pro|vendor|handyman|maintenance|repair|plumb|electric|local|contractor|service provider/.test(text)) {
    return {
      ok: true,
      source: "fallback",
      reply: `Got it — local pro support should collect ZIP, service category, urgency, photos/notes, and whether you want a quote, visit, or ongoing support.${zipLine}`,
      intent: "pros",
      confidence: zip ? 0.78 : 0.7,
      extracted: { zip, serviceType: "local_pro", addons: [], urgency: "normal" },
      chips: [
        makeChip("maintenance", "Maintenance", "I need maintenance help"),
        makeChip("handyman", "Handyman", "I need a handyman"),
        makeChip("urgent", "Urgent help", "I need urgent local support"),
      ],
      ctaKey: "pros",
      shouldCreateLead: false,
      handoff: false,
    };
  }

  if (/add.?on|extra|laundry|linen|towel|restock|pet|oven|fridge|window|garage|trash/.test(text)) {
    return {
      ok: true,
      source: "fallback",
      reply:
        "Yes — service add-ons should be captured inside the chat and passed into the request. Good add-ons include laundry, linens, towels, pet hair, fridge, oven, trash haul, restock, damage photo check, and priority scheduling.",
      intent: "addons",
      confidence: 0.68,
      extracted: { zip, serviceType: "addon_selection", addons: [], urgency: "normal" },
      chips: [
        makeChip("add-str", "Add to STR flow", "Add these to STR turnover"),
        makeChip("add-cleaning", "Add to cleaning", "Add these to cleaning request"),
      ],
      ctaKey: "cleaning",
      shouldCreateLead: false,
      handoff: false,
    };
  }

  return {
    ok: true,
    source: "fallback",
    reply: `I can help with cleaning, STR turnovers, listing/matches, tenants, local pros, or service add-ons.${zipLine} Tell me your ZIP and what you need, and I’ll route you to the right flow.`,
    intent: "unknown",
    confidence: zip ? 0.45 : 0.3,
    extracted: { zip, serviceType: "", addons: [], urgency: "normal" },
    chips: [
      makeChip("cleaning", "Cleaning", "I need cleaning help"),
      makeChip("str", "STR turnover", "I need short-term rental turnover help"),
      makeChip("listing", "Listing help", "I want listing help"),
      makeChip("pros", "Local pros", "Find local pros"),
    ],
    ctaKey: null,
    shouldCreateLead: false,
    handoff: false,
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {}

  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function sanitizeAiResponse(raw, message) {
  const fallback = baseFallback(message);
  const data = raw && typeof raw === "object" ? raw : {};
  const intent = allowedIntent.has(data.intent) ? data.intent : fallback.intent;
  const ctaKey = allowedCta.has(data.ctaKey) ? data.ctaKey : fallback.ctaKey;
  const extracted = data.extracted && typeof data.extracted === "object" ? data.extracted : {};
  const zip = extractZip(extracted.zip || message) || fallback.extracted.zip || "";

  return {
    ok: true,
    source: "openai",
    reply: asString(data.reply, 900) || fallback.reply,
    intent,
    confidence: Math.max(0, Math.min(1, Number(data.confidence || fallback.confidence || 0.5))),
    extracted: {
      zip,
      serviceType: asString(extracted.serviceType || fallback.extracted.serviceType, 80),
      propertyType: asString(extracted.propertyType || "", 80),
      urgency: asString(extracted.urgency || fallback.extracted.urgency || "normal", 40),
      role: asString(extracted.role || "", 40),
      addons: Array.isArray(extracted.addons)
        ? extracted.addons.map((x) => asString(x, 60)).filter(Boolean).slice(0, 10)
        : [],
    },
    chips: normalizeChips(data.chips, fallback.chips),
    ctaKey,
    shouldCreateLead: Boolean(data.shouldCreateLead),
    handoff: Boolean(data.handoff),
  };
}

function buildHistory(messages = []) {
  if (!Array.isArray(messages)) return [];

  return messages
    .slice(-10)
    .map((m) => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      content: asString(m?.text || m?.content || "", 600),
    }))
    .filter((m) => m.content);
}

async function callOpenAi({ message, messages, page, visitor }) {
  if (!OPENAI_API_KEY) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const payload = {
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      temperature: 0.25,
      messages: [
        {
          role: "system",
          content:
            "You are Santa AI, a concise PropertySanta website intake assistant. Help visitors choose between cleaning, STR turnover, property listing/matches, local pros, and service add-ons. Ask only one practical next question when details are missing. Do not invent prices. Do not promise booking completion. When ready, suggest the right CTA route. Return JSON only with keys: reply, intent, confidence, extracted, chips, ctaKey, shouldCreateLead, handoff. Valid intent values: cleaning, str, listing, pros, addons, unknown. Valid ctaKey values: cleaning, str, listing, pros, or null. chips must be an array of {id,label,prompt}. extracted may include zip, serviceType, propertyType, addons, urgency, role.",
        },
        ...buildHistory(messages),
        {
          role: "user",
          content: JSON.stringify({
            page: page || "StartHere",
            visitor: visitor || {},
            message: asString(message, 2000),
          }),
        },
      ],
    };

    const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn("[start-here-ai] OpenAI failed", response.status, body.slice(0, 300));
      return null;
    }

    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content || "";
    return safeJsonParse(content);
  } catch (error) {
    console.warn("[start-here-ai] OpenAI unavailable", error?.message || error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function startHereChat(req, res) {
  try {
    const message = asString(req.body?.message, 2000);
    if (!message) {
      return res.status(400).json({
        ok: false,
        code: "message_required",
        message: "Message is required.",
      });
    }

    const page = asString(req.body?.page || "StartHere", 80);
    const visitor = req.body?.visitor && typeof req.body.visitor === "object" ? req.body.visitor : {};
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];

    const aiRaw = await callOpenAi({ message, messages, page, visitor });
    const reply = aiRaw ? sanitizeAiResponse(aiRaw, message) : baseFallback(message);

    return res.json({
      ...reply,
      conversationId: asString(req.body?.conversationId, 128) || null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[start-here-ai] chat error", error);
    const fallback = baseFallback(req.body?.message || "");
    return res.status(200).json({
      ...fallback,
      source: "fallback_error",
      timestamp: new Date().toISOString(),
    });
  }
}

module.exports = {
  startHereChat,
  isStartHerePayload(body = {}) {
    const source = String(body?.source || body?.page || "").toLowerCase();
    if (source.includes("starthere") || source.includes("start_here")) return true;
    if (body?.visitor || body?.conversationId) return true;
    return false;
  },
};