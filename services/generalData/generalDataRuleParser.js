const { convert } = require("html-to-text");

function normalizeWhitespace(value = "") {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function htmlToReadableText(html = "") {
  const safeHtml = String(html || "").trim();
  if (!safeHtml) return "";

  try {
    return normalizeWhitespace(
      convert(safeHtml, {
        wordwrap: false,
        selectors: [
          { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
          { selector: "img", format: "skip" },
        ],
      })
    );
  } catch {
    return normalizeWhitespace(
      safeHtml
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    );
  }
}

function extractMatches(text, regex, limit = 20) {
  const found = [];
  const safeText = String(text || "");
  let match;
  const seen = new Set();

  while ((match = regex.exec(safeText)) && found.length < limit) {
    const val = String(match[0] || "").trim();
    if (!val) continue;
    if (seen.has(val.toLowerCase())) continue;
    seen.add(val.toLowerCase());
    found.push(val);
  }

  regex.lastIndex = 0;
  return found;
}

function extractKeyValueLines(text = "") {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /[:\-]/.test(line) && line.length <= 160)
    .slice(0, 30);
}

function pickDocumentType(subject = "", text = "") {
  const hay = `${subject}\n${text}`.toLowerCase();
  const rules = [
    ["pricing_sheet", ["price list", "pricing", "rate card", "pricing sheet", "unit price"]],
    ["inventory_snapshot", ["inventory", "stock", "warehouse", "sku", "on hand", "qty"]],
    ["settlement_summary", ["settlement", "payout", "adjustment", "commission", "fee code"]],
    ["compliance_doc", ["certificate", "compliance", "iso", "msds", "coa", "declaration"]],
    ["shipment_doc", ["shipment", "carrier", "tracking", "freight", "dispatch", "parcel"]],
    ["vendor_profile", ["vendor", "supplier", "contact", "payment terms", "bank details"]],
    ["report", ["report", "summary", "weekly", "monthly", "forecast", "plan"]],
  ];

  for (const [type, words] of rules) {
    if (words.some((word) => hay.includes(word))) return type;
  }
  return "unknown";
}

function buildSummary(text = "") {
  const cleaned = normalizeWhitespace(text);
  if (!cleaned) return "No readable body text found.";
  const lines = cleaned.split(/\n+/).filter(Boolean);
  const best = lines.find((line) => line.length >= 30) || lines[0] || cleaned;
  return best.slice(0, 220);
}

function scoreConfidence({
  documentType,
  keyValueLines,
  emails,
  phones,
  urls,
  dates,
  currencies,
  percentages,
  skus,
  textLength,
}) {
  let score = 25;
  if (documentType !== "unknown") score += 20;
  if (keyValueLines.length >= 3) score += 15;
  if (emails.length) score += 8;
  if (phones.length) score += 6;
  if (urls.length) score += 4;
  if (dates.length) score += 8;
  if (currencies.length) score += 6;
  if (percentages.length) score += 3;
  if (skus.length) score += 10;
  if (textLength > 400) score += 8;
  return Math.max(0, Math.min(99, score));
}

function parseGeneralEmailDocument({
  sender = "",
  subject = "",
  text = "",
  html = "",
  emailPermalink = "",
  messageId = "",
  gmailId = "",
  inboxEmail = "",
  rawDate = "",
  messageDate = "",
} = {}) {
  const htmlText = htmlToReadableText(html);
  const bodyText = normalizeWhitespace(text || htmlText);
  const merged = normalizeWhitespace([subject, bodyText].filter(Boolean).join("\n\n"));

  const emails = extractMatches(merged, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, 20);
  const phones = extractMatches(merged, /(?:\+?\d[\d()\-\s]{7,}\d)/g, 12);
  const urls = extractMatches(merged, /https?:\/\/[^\s)]+/gi, 12);
  const dates = extractMatches(
    merged,
    /\b(?:\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}[\/-]\d{1,2}[\/-]\d{1,2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/gi,
    12
  );
  const currencies = extractMatches(merged, /(?:\$|usd\s?)\d[\d,]*(?:\.\d{1,2})?/gi, 20);
  const percentages = extractMatches(merged, /\b\d{1,3}(?:\.\d+)?%/g, 12);
  const skus = extractMatches(merged, /\b[A-Z]{2,}[A-Z0-9_-]{2,}\b/g, 20).filter((v) => /\d/.test(v));
  const keyValueLines = extractKeyValueLines(merged);
  const documentType = pickDocumentType(subject, merged);
  const confidence = scoreConfidence({
    documentType,
    keyValueLines,
    emails,
    phones,
    urls,
    dates,
    currencies,
    percentages,
    skus,
    textLength: merged.length,
  });

  const status =
    merged.length < 80 ? "FAILED" : confidence >= 70 ? "READY" : confidence >= 45 ? "REVIEW" : "FAILED";

  return {
    ok: status !== "FAILED",
    status,
    confidence,
    documentType,
    summary: buildSummary(merged),
    extractedData: {
      sender,
      emails,
      phones,
      urls,
      dates,
      currencies,
      percentages,
      skus,
      keyValueLines,
      bodyPreview: merged.slice(0, 4000),
    },
    rawText: bodyText,
    rawHtmlText: htmlText,
    pipelineType: "general_data",
    source: "gmail",
    senderEmail: sender,
    subject,
    emailPermalink,
    messageId,
    gmailId,
    inboxEmail,
    rawDate,
    messageDate,
    entityCount:
      emails.length +
      phones.length +
      urls.length +
      dates.length +
      currencies.length +
      percentages.length +
      skus.length +
      keyValueLines.length,
  };
}

module.exports = {
  normalizeWhitespace,
  htmlToReadableText,
  parseGeneralEmailDocument,
};