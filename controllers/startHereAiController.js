const startHereAiCache = require("../services/startHereAiCache");

function loadGoogleGenerativeAI() {
  try {
    return require("@google/generative-ai").GoogleGenerativeAI;
  } catch (error) {
    console.warn("[start-here-ai] @google/generative-ai is not installed. Run npm install in services/api.");
    return null;
  }
}

function getGeminiApiKey() {
  return String(
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_AI_API_KEY ||
    ""
  ).trim();
}

function getGeminiModelCandidates() {
  const raw =
    process.env.START_HERE_GEMINI_MODELS ||
    process.env.GEMINI_MODELS ||
    process.env.START_HERE_GEMINI_MODEL ||
    process.env.GEMINI_MODEL ||
    "gemini-2.0-flash-lite,gemini-2.0-flash,gemini-2.5-flash-lite";

  const models = String(raw)
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  return Array.from(new Set(models));
}

function getGeminiModel() {
  return getGeminiModelCandidates()[0] || "gemini-2.0-flash-lite";
}

function getGeminiTimeoutMs() {
  return Math.max(
    2500,
    Math.min(
      20000,
      Number(process.env.START_HERE_GEMINI_TIMEOUT_MS || process.env.GEMINI_TIMEOUT_MS || 9000)
    )
  );
}

const allowedIntent = new Set(["cleaning", "str", "listing", "pros", "addons", "unknown"]);
const allowedStage = new Set([
  "discovering_intent",
  "collecting_location",
  "collecting_property_details",
  "collecting_timing",
  "collecting_addons",
  "ready_for_handoff",
]);
const allowedCta = new Set(["cleaning", "str", "listing", "pros"]);

const SERVICE_REQUIRED_FIELDS = {
  cleaning: ["zip", "propertyType", "bedrooms", "bathrooms", "serviceType", "timing"],
  str: ["zip", "propertyType", "bedrooms", "bathrooms", "serviceType", "timing", "addons"],
  listing: ["zip", "propertyType", "bedrooms", "bathrooms", "propertyLink"],
  pros: ["zip", "serviceType", "urgency", "notes"],
  addons: ["zip", "serviceType", "addons"],
  unknown: ["intent", "zip"],
};

function asString(value, max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes|y|1)$/i.test(value.trim())) return true;
    if (/^(false|no|n|0)$/i.test(value.trim())) return false;
  }
  return false;
}

function extractZip(text = "") {
  const match = String(text || "").match(/\b\d{5}(?:-\d{4})?\b/);
  return match ? match[0].slice(0, 5) : "";
}

function extractBedrooms(text = "") {
  const lower = String(text || "").toLowerCase();
  const match = lower.match(/\b(\d+(?:\.5)?)\s*(?:br|bed|beds|bedroom|bedrooms)\b/);
  return match ? toNumber(match[1]) : null;
}

function extractBathrooms(text = "") {
  const lower = String(text || "").toLowerCase();
  const match = lower.match(/\b(\d+(?:\.5)?)\s*(?:ba|bath|baths|bathroom|bathrooms)\b/);
  return match ? toNumber(match[1]) : null;
}

function detectPropertyType(text = "") {
  const lower = String(text || "").toLowerCase();
  if (/\b(apartment|apt)\b/.test(lower)) return "apartment";
  if (/\b(condo|condominium)\b/.test(lower)) return "condo";
  if (/\b(townhome|townhouse)\b/.test(lower)) return "townhouse";
  if (/\b(single family|house|home|villa)\b/.test(lower)) return "house";
  if (/\b(studio)\b/.test(lower)) return "studio";
  return "";
}

function detectUrgency(text = "") {
  const lower = String(text || "").toLowerCase();
  if (/\b(now|today|asap|urgent|emergency|same day|right away)\b/.test(lower)) return "urgent";
  if (/\b(tomorrow|next day|this week|soon)\b/.test(lower)) return "soon";
  if (/\b(monthly|weekly|recurring|ongoing)\b/.test(lower)) return "recurring";
  return "normal";
}

function detectAddons(text = "") {
  const lower = String(text || "").toLowerCase();
  const addons = [];
  const add = (value, regex) => {
    if (regex.test(lower) && !addons.includes(value)) addons.push(value);
  };

  add("laundry", /laundry|washer|dryer|linen wash/);
  add("linens", /linen|sheet|towel|bedding/);
  add("restock", /restock|supply|supplies|toilet paper|soap|coffee/);
  add("pet_hair", /pet|dog|cat|hair/);
  add("oven", /oven/);
  add("fridge", /fridge|refrigerator/);
  add("trash", /trash|garbage|haul/);
  add("damage_photos", /photo|picture|damage|inspection/);
  add("priority_scheduling", /urgent|asap|same day|priority/);

  return addons;
}

function detectIntent(text = "") {
  const lower = String(text || "").toLowerCase();
  if (/airbnb|vrbo|str|short.?term|turnover|checkout|check.?in|guest/.test(lower)) return "str";
  if (/clean|maid|deep|move.?out|move.?in|standard|housekeeping|sanitize/.test(lower)) return "cleaning";
  if (/list|listing|tenant|renter|rent|zillow|property link|publish|match/.test(lower)) return "listing";
  if (/pro|vendor|handyman|maintenance|repair|plumb|electric|local|contractor|service provider/.test(lower)) return "pros";
  if (/add.?on|extra|laundry|linen|towel|restock|pet|oven|fridge|window|garage|trash/.test(lower)) return "addons";
  return "unknown";
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

function normalizeList(value, max = 12) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item, 80)).filter(Boolean).slice(0, max);
}

function getRequiredFields(intent) {
  return SERVICE_REQUIRED_FIELDS[intent] || SERVICE_REQUIRED_FIELDS.unknown;
}

function fieldIsPresent(field, extracted = {}) {
  if (field === "intent") return false;
  if (field === "addons") return Array.isArray(extracted.addons) && extracted.addons.length > 0;
  if (field === "bedrooms" || field === "bathrooms" || field === "squareFeet") {
    return Number.isFinite(Number(extracted[field])) && Number(extracted[field]) > 0;
  }
  return Boolean(asString(extracted[field], 160));
}

function buildCompletenessFromFields(requiredFields = [], extracted = {}) {
  const safeRequiredFields = normalizeList(requiredFields, 12);
  const missingFields = safeRequiredFields.filter((field) => !fieldIsPresent(field, extracted));
  const collected = safeRequiredFields.length - missingFields.length;
  const total = safeRequiredFields.length;

  return {
    requiredFields: safeRequiredFields,
    missingFields,
    completeness: {
      collected,
      total,
      score: total ? Number((collected / total).toFixed(2)) : 0,
    },
  };
}

function buildCompleteness(intent, extracted = {}) {
  return buildCompletenessFromFields(getRequiredFields(intent), extracted);
}

function pickStage(intent, missingFields = []) {
  if (intent === "unknown") return "discovering_intent";
  if (missingFields.includes("zip")) return "collecting_location";
  if (
    missingFields.includes("propertyType") ||
    missingFields.includes("bedrooms") ||
    missingFields.includes("bathrooms") ||
    missingFields.includes("propertyLink")
  ) {
    return "collecting_property_details";
  }
  if (missingFields.includes("timing") || missingFields.includes("urgency")) return "collecting_timing";
  if (missingFields.includes("addons")) return "collecting_addons";
  return "ready_for_handoff";
}

function nextQuestionFor(intent, missingFields = []) {
  const first = missingFields[0];
  if (first === "intent") return "What do you need help with — cleaning, Airbnb turnover, listing, or local pros?";
  if (first === "zip") return "What ZIP code is this property in?";
  if (first === "propertyType") return "What type of property is it — apartment, condo, townhouse, or house?";
  if (first === "bedrooms") return "How many bedrooms does the property have?";
  if (first === "bathrooms") return "How many bathrooms does it have?";
  if (first === "serviceType") {
    if (intent === "pros") return "What local pro service do you need — handyman, maintenance, plumbing, electrical, or something else?";
    return "What service type do you want — standard clean, deep clean, move-out, or STR turnover?";
  }
  if (first === "timing") return "When do you need this done — today, tomorrow, this week, or a recurring schedule?";
  if (first === "addons") return "Any add-ons needed, like laundry, linens, restock, fridge, oven, pet hair, or damage photos?";
  if (first === "propertyLink") return "Do you have a property link to paste, or should we start from basic property details?";
  if (first === "urgency") return "How urgent is this — today, this week, or normal priority?";
  if (first === "notes") return "Can you share one quick note or photo description of what needs to be done?";
  return "I have the main details. Would you like me to open the right PropertySanta flow now?";
}

function mergeExtractedFromText(text = "", extracted = {}) {
  const zip = extractZip(extracted.zip || text);
  const propertyType = asString(extracted.propertyType, 80) || detectPropertyType(text);
  const bedrooms = toNumber(extracted.bedrooms) || extractBedrooms(text);
  const bathrooms = toNumber(extracted.bathrooms) || extractBathrooms(text);
  const addons = normalizeList(extracted.addons, 12);
  const detectedAddons = detectAddons(text);

  return {
    zip,
    city: asString(extracted.city, 80),
    state: asString(extracted.state, 40),
    role: asString(extracted.role, 40),
    serviceType: asString(extracted.serviceType, 80),
    propertyType,
    bedrooms,
    bathrooms,
    squareFeet: toNumber(extracted.squareFeet),
    urgency: asString(extracted.urgency, 40) || detectUrgency(text),
    timing: asString(extracted.timing, 120),
    propertyLink: asString(extracted.propertyLink, 500),
    addons: Array.from(new Set([...addons, ...detectedAddons])).slice(0, 12),
    photosAvailable: toBool(extracted.photosAvailable),
    notes: asString(extracted.notes, 500),
  };
}

function ctaForIntent(intent) {
  if (!allowedCta.has(intent)) return null;
  return intent;
}

function fallbackChipsFor(intent, missingFields = []) {
    if (missingFields.includes("timing")) {
    return [
      makeChip("timing_today", "Today", "I need this done today"),
      makeChip("timing_tomorrow", "Tomorrow", "I need this done tomorrow"),
      makeChip("timing_this_week", "This week", "I need this done this week"),
      makeChip("timing_recurring", "Recurring", "I need this on a recurring schedule"),
    ];
  }

  if (missingFields.includes("addons")) {
    return [
      makeChip("addon_none", "No add-ons", "No add-ons needed"),
      makeChip("addon_laundry", "Laundry", "Add laundry"),
      makeChip("addon_linen_restock", "Linens + restock", "Add linens and restock"),
      makeChip("addon_photos", "Damage photos", "Add damage photo check"),
    ];
  }
  
  if (missingFields.includes("zip")) {
    return [
      makeChip("zip_33334", "ZIP 33334", "My ZIP is 33334"),
      makeChip("zip_33076", "ZIP 33076", "My ZIP is 33076"),
      makeChip("not_sure", "Not sure", "I am not sure of the ZIP yet"),
    ];
  }

  if (intent === "str") {
    return [
      makeChip("str_turnover", "Turnover cleaning", "I need STR turnover cleaning"),
      makeChip("laundry_restock", "Laundry + restock", "Add laundry, linens, and restock"),
      makeChip("damage_photos", "Damage photos", "I need damage photo check too"),
    ];
  }

  if (intent === "cleaning") {
    return [
      makeChip("standard", "Standard clean", "I need standard cleaning"),
      makeChip("deep", "Deep clean", "I need deep cleaning"),
      makeChip("move", "Move-out clean", "I need move-out cleaning"),
    ];
  }

  if (intent === "listing") {
    return [
      makeChip("paste_link", "Paste property link", "I have a property link to paste"),
      makeChip("tenant_match", "Find tenants", "I want tenant matches"),
      makeChip("owner_listing", "Owner listing help", "I need owner listing help"),
    ];
  }

  if (intent === "pros") {
    return [
      makeChip("handyman", "Handyman", "I need a handyman"),
      makeChip("maintenance", "Maintenance", "I need maintenance help"),
      makeChip("urgent", "Urgent help", "I need urgent local support"),
    ];
  }

  return [
    makeChip("cleaning", "Cleaning", "I need cleaning help"),
    makeChip("str", "STR turnover", "I need short-term rental turnover help"),
    makeChip("listing", "Listing help", "I want listing help"),
    makeChip("pros", "Local pros", "Find local pros"),
  ];
}

function buildReplyFromState({ intent, extracted = {}, missingFields = [], nextQuestion = "" }) {
  const zipText = extracted.zip ? ` in ${extracted.zip}` : "";

  const propertyParts = [
    extracted.bedrooms ? `${extracted.bedrooms} bed` : "",
    extracted.bathrooms ? `${extracted.bathrooms} bath` : "",
    extracted.propertyType || "",
  ].filter(Boolean);

  const propertyText = propertyParts.length ? ` for your ${propertyParts.join(", ")}` : "";

  const addonLabels = {
    laundry: "laundry",
    linens: "linens",
    restock: "restock",
    pet_hair: "pet hair",
    oven: "oven cleaning",
    fridge: "fridge cleaning",
    trash: "trash removal",
    damage_photos: "damage photos",
    priority_scheduling: "priority scheduling",
  };

  const addons = Array.isArray(extracted.addons)
    ? Array.from(new Set(extracted.addons))
        .map((addon) => addonLabels[addon] || String(addon).replace(/_/g, " "))
        .filter(Boolean)
    : [];

  const addonText = addons.length ? ` with ${addons.join(", ")}` : "";

  const ask =
    nextQuestion ||
    (missingFields.length
      ? "Can you share the next detail?"
      : "Would you like me to open the right PropertySanta flow now?");

  if (intent === "str") {
    return `Got it! I can help with Airbnb turnover cleaning${zipText}${propertyText}${addonText}. ${ask}`;
  }

  if (intent === "cleaning") {
    return `Got it! I can help with cleaning${zipText}${propertyText}${addonText}. ${ask}`;
  }

  if (intent === "listing") {
    return `Got it! I can help with your PropertySanta listing or renter match${zipText}${propertyText}. ${ask}`;
  }

  if (intent === "pros") {
    return `Got it! I can help find the right local pro${zipText}. ${ask}`;
  }

  if (intent === "addons") {
    return `Got it! I can capture those add-ons${zipText}${addonText}. ${ask}`;
  }

  return `I can help route this into cleaning, Airbnb turnover, listing, local pros, or add-ons. ${ask}`;
}

function buildLeadDraft(intent, extracted, missingFields) {
  const ready = intent !== "unknown" && missingFields.length === 0;
  const titleParts = [intent === "str" ? "STR turnover" : intent, extracted.zip].filter(Boolean);

  return {
    ready,
    type: intent,
    title: titleParts.join(" · ") || "PropertySanta request",
    priority: extracted.urgency === "urgent" ? "high" : "normal",
    summary: [
      extracted.propertyType,
      extracted.bedrooms ? `${extracted.bedrooms} bed` : "",
      extracted.bathrooms ? `${extracted.bathrooms} bath` : "",
      extracted.timing,
      extracted.addons?.length ? `Add-ons: ${extracted.addons.join(", ")}` : "",
      extracted.notes,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

function buildHistory(messages = []) {
  if (!Array.isArray(messages)) return [];

  return messages
    .slice(-10)
    .map((m) => ({
      role: m?.role === "assistant" ? "model" : "user",
      text: asString(m?.text || m?.content || "", 600),
      intent: asString(m?.intent, 40),
      stage: asString(m?.stage, 80),
      extracted: m?.extracted && typeof m.extracted === "object" ? m.extracted : undefined,
      missingFields: Array.isArray(m?.missingFields) ? m.missingFields.slice(0, 12) : undefined,
    }))
    .filter((m) => m.text);
}

function buildPlainHistory(messages = []) {
  return buildHistory(messages)
    .map((m) => `${m.role === "model" ? "assistant" : "user"}: ${m.text}`)
    .join("\n");
}

function baseFallback(message = "", messages = []) {
  const historyText = buildPlainHistory(messages);
  const allText = `${historyText}\n${message}`.trim();
  const intent = detectIntent(allText);
  const extracted = mergeExtractedFromText(allText, {
    serviceType:
      intent === "str"
        ? "str_turnover"
        : intent === "cleaning"
          ? "cleaning"
          : intent === "listing"
            ? "listing_matches"
            : intent === "pros"
              ? "local_pro"
              : "",
  });

  const { requiredFields, missingFields, completeness } = buildCompleteness(intent, extracted);
  const stage = pickStage(intent, missingFields);
  const nextQuestion = nextQuestionFor(intent, missingFields);
  const leadDraft = buildLeadDraft(intent, extracted, missingFields);

  return {
    ok: true,
    source: "fallback",
    reply: buildReplyFromState({ intent, extracted, missingFields, nextQuestion }),
    intent,
    stage,
    confidence: intent === "unknown" ? (extracted.zip ? 0.45 : 0.32) : extracted.zip ? 0.82 : 0.72,
    extracted,
    requiredFields,
    missingFields,
    completeness,
    nextQuestion,
    chips: fallbackChipsFor(intent, missingFields),
    ctaKey: ctaForIntent(intent),
    shouldCreateLead: leadDraft.ready,
    handoff: stage === "ready_for_handoff",
    leadDraft,
    safetyNotice: "AI guidance only. Final pricing, availability, and booking are confirmed in the service flow.",
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch { }

  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function sanitizeAiResponse(raw, message, messages = []) {
  const fallback = baseFallback(message, messages);
  const data = raw && typeof raw === "object" ? raw : {};

  const intent = allowedIntent.has(data.intent) ? data.intent : fallback.intent;
  const textForExtraction = `${buildPlainHistory(messages)}\n${message}`.trim();

  const extracted = mergeExtractedFromText(
    textForExtraction,
    data.extracted && typeof data.extracted === "object" ? data.extracted : fallback.extracted
  );

  // Backend owns the final intake state.
  // Gemini may say extracted.addons=["laundry"] but still return missingFields=["addons"].
  // So do NOT trust Gemini missingFields/completeness/stage/leadDraft blindly.
  const requiredFields = getRequiredFields(intent);
  const computed = buildCompletenessFromFields(requiredFields, extracted);
  const missingFields = computed.missingFields;
  const completeness = computed.completeness;
  const stage = pickStage(intent, missingFields);
  const nextQuestion = nextQuestionFor(intent, missingFields);

  const serverLeadDraft = buildLeadDraft(intent, extracted, missingFields);

  const serverReply = buildReplyFromState({
    intent,
    extracted,
    missingFields,
    nextQuestion,
  });

  return {
    ok: true,
    source: "gemini",
    reply: asString(data.reply, 900) || serverReply || fallback.reply,
    intent,
    stage,
    confidence: Math.max(0, Math.min(1, Number(data.confidence || fallback.confidence || 0.5))),
    extracted,
    requiredFields,
    missingFields,
    completeness,
    nextQuestion,
    chips: fallbackChipsFor(intent, missingFields),
    ctaKey: ctaForIntent(intent),
    shouldCreateLead: Boolean(serverLeadDraft.ready),
    handoff: stage === "ready_for_handoff",
    leadDraft: {
      ready: Boolean(serverLeadDraft.ready),
      type: asString(serverLeadDraft.type || intent, 40),
      title: asString(serverLeadDraft.title, 160),
      priority: asString(serverLeadDraft.priority || "normal", 40),
      summary: asString(serverLeadDraft.summary, 600),
    },
    safetyNotice:
      asString(data.safetyNotice, 220) ||
      "AI guidance only. Final pricing, availability, and booking are confirmed in the service flow.",
  };
}

function buildGeminiPrompt({ message, messages, page, visitor }) {
  const history = buildHistory(messages);
  const currentMessage = asString(message, 2000);

  return `You are Santa AI, PropertySanta's professional website intake assistant.

Goal:
- Route the visitor to one of: cleaning, short-term rental turnover, listing/matches, local pros, add-ons, or unknown.
- Collect a structured intake object for handoff.
- Ask exactly one practical next question when details are missing.
- Never invent prices, confirmed availability, vendor names, or booking completion.
- Keep reply warm, concise, professional, and under 90 words.

Allowed enums:
intent = cleaning | str | listing | pros | addons | unknown
stage = discovering_intent | collecting_location | collecting_property_details | collecting_timing | collecting_addons | ready_for_handoff
ctaKey = cleaning | str | listing | pros | null

Required fields by intent:
${JSON.stringify(SERVICE_REQUIRED_FIELDS, null, 2)}

Return JSON only, exactly with this shape:
{
  "reply": "short user-facing answer + one next question",
  "intent": "cleaning|str|listing|pros|addons|unknown",
  "stage": "discovering_intent|collecting_location|collecting_property_details|collecting_timing|collecting_addons|ready_for_handoff",
  "confidence": 0.0,
  "extracted": {
    "zip": "",
    "city": "",
    "state": "",
    "role": "owner|host|tenant|property_manager|cleaner|unknown",
    "serviceType": "",
    "propertyType": "",
    "bedrooms": null,
    "bathrooms": null,
    "squareFeet": null,
    "urgency": "normal|soon|urgent|recurring",
    "timing": "",
    "propertyLink": "",
    "addons": [],
    "photosAvailable": false,
    "notes": ""
  },
  "requiredFields": [],
  "missingFields": [],
  "completeness": { "collected": 0, "total": 0, "score": 0.0 },
  "nextQuestion": "one next question only",
  "chips": [{ "id": "", "label": "", "prompt": "" }],
  "ctaKey": null,
  "shouldCreateLead": false,
  "handoff": false,
  "leadDraft": { "ready": false, "type": "", "title": "", "priority": "normal", "summary": "" },
  "safetyNotice": "AI guidance only. Final pricing, availability, and booking are confirmed in the service flow."
}

Context JSON:
${JSON.stringify(
    {
      page: page || "StartHere",
      visitor: visitor || {},
      history,
      currentMessage,
    },
    null,
    2
  )}`;
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function getGeminiFailureReason(error) {
  const message = asString(error?.message || error, 500);
  const status = error?.status || error?.statusCode || error?.response?.status;

  if (status === 400) return `bad_request_or_model_config: ${message}`;
  if (status === 401 || status === 403) return `invalid_or_unauthorized_api_key: ${message}`;
  if (status === 404) return `model_not_found_or_not_enabled: ${message}`;
  if (status === 429) return `quota_or_rate_limit: ${message}`;
  if (status >= 500) return `gemini_server_error: ${message}`;
  return message || "unknown_gemini_error";
}

async function callGemini({ message, messages, page, visitor }) {
  const diagnostics = {
    hasGeminiKey: false,
    model: getGeminiModel(),
    modelsTried: [],
    packageLoaded: false,
    reason: "not_started",
  };

  const geminiApiKey = getGeminiApiKey();
  const modelCandidates = getGeminiModelCandidates();
  const geminiTimeoutMs = getGeminiTimeoutMs();

  diagnostics.hasGeminiKey = Boolean(geminiApiKey);
  diagnostics.model = modelCandidates[0] || getGeminiModel();

  if (!geminiApiKey) {
    diagnostics.reason = "missing_GEMINI_API_KEY";
    console.warn("[start-here-ai] Gemini skipped: GEMINI_API_KEY is missing");
    return { data: null, diagnostics };
  }

  try {
    const GoogleGenerativeAI = loadGoogleGenerativeAI();
    diagnostics.packageLoaded = Boolean(GoogleGenerativeAI);

    if (!GoogleGenerativeAI) {
      diagnostics.reason = "missing_@google/generative-ai_package";
      return { data: null, diagnostics };
    }

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const prompt = buildGeminiPrompt({ message, messages, page, visitor });

    for (const geminiModel of modelCandidates) {
      const attempt = {
        model: geminiModel,
        ok: false,
        reason: "not_started",
      };

      diagnostics.modelsTried.push(attempt);

      try {
        const model = genAI.getGenerativeModel({
          model: geminiModel,
          generationConfig: {
            temperature: 0.2,
            topP: 0.9,
            maxOutputTokens: 1400,
            responseMimeType: "application/json",
          },
        });

        const result = await withTimeout(model.generateContent(prompt), geminiTimeoutMs);

        if (result?.__timeout) {
          attempt.reason = `timeout_after_${geminiTimeoutMs}ms`;
          console.warn(`[start-here-ai] Gemini model ${geminiModel} skipped: ${attempt.reason}`);
          continue;
        }

        const text = result?.response?.text?.() || "";
        const parsed = safeJsonParse(text);

        if (!parsed) {
          attempt.reason = "gemini_returned_non_json";
          attempt.preview = text.slice(0, 200);
          console.warn("[start-here-ai] Gemini returned non-JSON text", {
            model: geminiModel,
            preview: attempt.preview,
          });
          continue;
        }

        attempt.ok = true;
        attempt.reason = "ok";
        diagnostics.model = geminiModel;
        diagnostics.reason = "ok";

        return { data: parsed, diagnostics };
      } catch (error) {
        attempt.reason = getGeminiFailureReason(error);
        console.warn(`[start-here-ai] Gemini model ${geminiModel} unavailable`, attempt.reason);

        // Keep trying next model on temporary service/quota/model issues.
        continue;
      }
    }

    diagnostics.reason =
      diagnostics.modelsTried
        .map((item) => `${item.model}: ${item.reason}`)
        .join(" | ") || "all_gemini_models_failed";

    return { data: null, diagnostics };
  } catch (error) {
    diagnostics.reason = getGeminiFailureReason(error);
    console.warn("[start-here-ai] Gemini unavailable", diagnostics.reason);
    return { data: null, diagnostics };
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

    // Build a deterministic local intake state first. This powers cache lookup and safe fallback.
    const fallbackState = baseFallback(message, messages);

    const cachedReply = startHereAiCache.getCachedReply({ message, fallbackState });
    if (cachedReply) {
      return res.json({
        ...cachedReply,
        model: null,
        aiDiagnostics: process.env.NODE_ENV === "production" ? undefined : {
          reason: "cache_hit_gemini_skipped",
          cache: cachedReply.cache,
        },
        sanitizeError: process.env.NODE_ENV === "production" ? undefined : null,
        conversationId: asString(req.body?.conversationId, 128) || null,
        timestamp: new Date().toISOString(),
      });
    }

    const geminiResult = await callGemini({ message, messages, page, visitor });
    const aiRaw = geminiResult?.data || null;
    const aiDiagnostics = geminiResult?.diagnostics || null;

    let reply;
    let sanitizeError = null;
    let cacheWrite = null;

    if (aiRaw) {
      try {
        reply = sanitizeAiResponse(aiRaw, message, messages);
        cacheWrite = startHereAiCache.storeGeminiResponse({
          message,
          fallbackState,
          response: reply,
          model: aiDiagnostics?.model || getGeminiModel(),
          aiDiagnostics,
        });
      } catch (error) {
        sanitizeError = {
          name: error?.name || "SanitizeError",
          message: asString(error?.message || error, 500),
        };

        console.error("[start-here-ai] sanitize error", sanitizeError);
        reply = {
          ...fallbackState,
          source: "fallback_sanitize_error",
        };
      }
    } else {
      reply = fallbackState;
    }

    return res.json({
      ...reply,
      model: aiRaw && !sanitizeError ? aiDiagnostics?.model || getGeminiModel() : null,
      aiDiagnostics: process.env.NODE_ENV === "production" ? undefined : aiDiagnostics,
      sanitizeError: process.env.NODE_ENV === "production" ? undefined : sanitizeError,
      cacheWrite: process.env.NODE_ENV === "production" ? undefined : cacheWrite,
      conversationId: asString(req.body?.conversationId, 128) || null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const controllerError = {
      name: error?.name || "ControllerError",
      message: asString(error?.message || error, 500),
    };

    console.error("[start-here-ai] chat error", controllerError);

    const fallback = baseFallback(req.body?.message || "", req.body?.messages || []);

    return res.status(200).json({
      ...fallback,
      source: "fallback_error",
      controllerError: process.env.NODE_ENV === "production" ? undefined : controllerError,
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