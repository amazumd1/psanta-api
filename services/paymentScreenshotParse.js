// services/api/services/paymentScreenshotParse.js
// Parse a payment screenshot (Zelle/Venmo/PayPal/bank app) into a normalized transaction object.
// Uses Gemini multimodal (vision).
const { GoogleGenerativeAI } = require("@google/generative-ai");

function normalizeJsonFromModel(text) {
  const raw = String(text || "").trim();

  // strip markdown fences if present
  const noFences = raw
    .replace(/```json\s*/gi, "")
    .replace(/```/g, "")
    .trim();

  // try: first {...} block
  const i = noFences.indexOf("{");
  const j = noFences.lastIndexOf("}");
  if (i >= 0 && j > i) {
    const slice = noFences.slice(i, j + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }

  // try parse whole
  try {
    return JSON.parse(noFences);
  } catch {
    return { _parseError: true, _raw: raw };
  }
}

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  return { mimeType: m[1], base64: m[2] };
}

function int2(n) {
  const x = Number(n || 0);
  return String(x).padStart(2, "0");
}

function normalizeDateISO(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // MM/DD/YYYY or M/D/YY
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let mm = int2(m[1]);
    let dd = int2(m[2]);
    let yy = String(m[3]);
    if (yy.length === 2) yy = String(2000 + Number(yy));
    return `${yy}-${mm}-${dd}`;
  }

  // month-name formats
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${int2(d.getMonth() + 1)}-${int2(d.getDate())}`;
  }
  return null;
}

async function parsePaymentScreenshot({ imageDataUrl, taxYearHint }) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing on server");

  const parsed = parseDataUrl(imageDataUrl);
  if (!parsed) {
    const err = new Error("Invalid imageDataUrl. Expected data:image/...;base64,...");
    err.status = 400;
    throw err;
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const modelName = process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash";
  const model = genAI.getGenerativeModel({ model: modelName });

  const sys = `
You are an expert bookkeeping assistant for US 1099 tracking.
Extract transaction details from the screenshot and return STRICT JSON ONLY (no markdown, no commentary).

Return this JSON schema:
{
  "amount": number | null,
  "currency": "USD" | null,
  "txnDate": "YYYY-MM-DD" | null,
  "merchant": string | null,
  "description": string | null,
  "referenceId": string | null,
  "paymentMethod": string | null,
  "emailsFound": string[],
  "phonesFound": string[],
  "confidence": number,
  "missing": string[]
}

Rules:
- If amounts show negative (debit), output positive amount paid.
- Normalize txnDate to YYYY-MM-DD.
- merchant should be the recipient, not the bank/app name.
- Prefer "sent/completed" date.
- taxYearHint (if provided) = ${taxYearHint || "null"} ; use it to disambiguate year if screenshot only shows month/day.
`;

  const result = await model.generateContent([
    { text: sys.trim() },
    { inlineData: { data: parsed.base64, mimeType: parsed.mimeType } },
  ]);

  const outText = result?.response?.text?.() || "";
  const obj = normalizeJsonFromModel(outText);

  const amount = typeof obj.amount === "number" ? obj.amount : Number(obj.amount);
  const normAmount = Number.isFinite(amount) ? Math.abs(amount) : null;
  const txnDate = normalizeDateISO(obj.txnDate) || normalizeDateISO(obj.date) || null;

  const merchant = obj.merchant ? String(obj.merchant).trim() : null;
  const description = obj.description ? String(obj.description).trim() : null;
  const referenceId = obj.referenceId ? String(obj.referenceId).trim() : null;
  const paymentMethod = obj.paymentMethod ? String(obj.paymentMethod).trim() : null;

  const emailsFound = Array.isArray(obj.emailsFound) ? obj.emailsFound.map(String) : [];
  const phonesFound = Array.isArray(obj.phonesFound) ? obj.phonesFound.map(String) : [];
  const confidence = Number.isFinite(Number(obj.confidence))
    ? Math.max(0, Math.min(1, Number(obj.confidence)))
    : 0.6;

  const missing = [];
  if (!normAmount) missing.push("amount");
  if (!txnDate) missing.push("txnDate");
  if (!merchant) missing.push("merchant");

  return {
    amount: normAmount,
    currency: "USD",
    txnDate,
    merchant,
    description,
    referenceId,
    paymentMethod,
    emailsFound,
    phonesFound,
    confidence,
    missing,
    _rawModelText: outText, // debugging; frontend can store
  };
}

module.exports = { parsePaymentScreenshot };
