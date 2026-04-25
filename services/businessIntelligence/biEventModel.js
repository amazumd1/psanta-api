const crypto = require("crypto");
const {
  resolveCanonicalBiCategory,
  getCategoryByKey,
} = require("./biCategories");
const { normString } = require("../../middleware/tenantAccess");

const BI_EVENT_MODEL_VERSION = 1;

const SOURCE_LABELS = Object.freeze({
  gmail: "Gmail",
  sheets: "Google Sheets",
  api: "API / Webhook",
  manual: "Manual Entry",
  upload: "Upload",
});

function cleanUndefined(value) {
  if (Array.isArray(value)) return value.map(cleanUndefined).filter((item) => item !== undefined);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [key, next] of Object.entries(value)) {
      const cleaned = cleanUndefined(next);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return value === undefined ? undefined : value;
}

function parsePayload(value) {
  if (value == null) return { rawText: "", structured: null };
  if (typeof value === "object") return { rawText: JSON.stringify(value), structured: value };

  const text = String(value || "").trim();
  if (!text) return { rawText: "", structured: null };

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return { rawText: text, structured: parsed };
    }
  } catch {
    // noop
  }

  return { rawText: text, structured: null };
}

function flattenStructuredValue(value, bucket = []) {
  if (value == null) return bucket;
  if (Array.isArray(value)) {
    value.forEach((item) => flattenStructuredValue(item, bucket));
    return bucket;
  }
  if (typeof value === "object") {
    Object.entries(value).forEach(([key, next]) => {
      bucket.push(String(key));
      flattenStructuredValue(next, bucket);
    });
    return bucket;
  }
  bucket.push(String(value));
  return bucket;
}

function extractFirstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const text = String(value || "");
    const match = text.match(/-?\d+(?:\.\d+)?/);
    if (match) {
      const num = Number(match[0]);
      if (Number.isFinite(num)) return num;
    }
  }
  return null;
}

function parseTrustedNumericValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const raw = String(value || "").trim();
  if (!raw) return null;

  const normalized = raw
    .replace(/^\((.*)\)$/, "-$1")
    .replace(/[$,]/g, "")
    .replace(/\s+/g, "");

  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;

  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

function pickTrustedNumericValue(...values) {
  for (const value of values) {
    const num = parseTrustedNumericValue(value);
    if (num != null) return num;
  }
  return null;
}

function pickTrustedFinanceAmount({ manualEntry = {}, structured = {} } = {}) {
  return pickTrustedNumericValue(
    manualEntry?.amount,
    manualEntry?.total,
    manualEntry?.metricValue,
    structured?.amount,
    structured?.total,
    structured?.metricValue,
    structured?.nonemployeeCompensation,
    structured?.totalPay,
    structured?.netPay,
    structured?.balance,
    structured?.payout,
    structured?.income,
    structured?.revenue
  );
}

function isFinanceMetricKey(metricKey = "") {
  const key = String(metricKey || "").trim().toLowerCase();
  return [
    "income",
    "expense",
    "utilities",
    "maintenance",
    "payroll",
    "professionalfees",
    "professional_fees",
  ].includes(key);
}

function normalizeObservedAt(...values) {
  for (const value of values) {
    if (!value) continue;
    const text = String(value).trim();
    if (!text) continue;
    const ts = new Date(text).getTime();
    if (Number.isFinite(ts)) return new Date(ts).toISOString();
  }
  return new Date().toISOString();
}

function detectSignals(text = "") {
  const signals = [];
  const add = (label) => {
    if (!signals.includes(label)) signals.push(label);
  };

  if (/(temperature|thermostat|sensor|hvac|climate|degree)/i.test(text)) add("temperature");
  if (/(^|[^a-z])ph([^a-z]|$)|soil|water test|crop/i.test(text)) add("ph");
  if (/(income|invoice|rent|revenue|airbnb|booking|payout)/i.test(text)) add("income");
  if (/(expense|vendor|receipt|bill|payment|payroll|1099|utility|maintenance|repair)/i.test(text)) add("expense");
  if (/(incident|ticket|issue|alert|leak|repair|failure)/i.test(text)) add("incident");
  if (/(photo|image|screenshot|pdf|evidence)/i.test(text)) add("photo");
  if (/(property|tenant|rent|plumbing|utility|landlord)/i.test(text)) add("property");
  if (/(manual|operator|note|inspection)/i.test(text)) add("manual");
  if (/(sheet|spreadsheet|row dataset|column map)/i.test(text)) add("sheets");
  if (/(webhook|api|json payload|endpoint)/i.test(text)) add("api");
  return signals;
}

function chooseRecordType(text = "", sourceKey = "") {
  if (/(photo|image|screenshot|pdf|evidence)/i.test(text) || sourceKey === "upload") return "photo_evidence";
  if (/(temperature|thermostat|sensor|degree|ph|soil|water test)/i.test(text) || sourceKey === "api" || sourceKey === "sheets") return "telemetry_reading";
  if (/(incident|ticket|issue|alert|leak)/i.test(text)) return "incident";
  if (/(vendor|receipt|invoice|expense|payroll|1099|income|bill|payment)/i.test(text)) return "finance_event";
  return "business_event";
}

function chooseMetricKey(text = "", sourceKey = "", explicit = "") {
  const metric = String(explicit || "").trim().toLowerCase();
  if (metric) return metric;
  if (/(temperature|thermostat|degree|sensor|climate)/i.test(text)) return "temperature";
  if (/(^|[^a-z])ph([^a-z]|$)|soil|water test|crop/i.test(text)) return "ph";
  if (/(incident|ticket|issue|alert|leak)/i.test(text)) return "incidentCount";
  if (/(utility|water|electric|power|gas|internet|phone|trash|sewer)/i.test(text)) return "utilities";
  if (/(maintenance|repair|plumbing|hvac|electrical)/i.test(text)) return "maintenance";
  if (/(payroll)/i.test(text)) return "payroll";
  if (/(income|invoice|rent|revenue|payout)/i.test(text)) return "income";
  if (/(expense|vendor|receipt|bill|payment|1099)/i.test(text)) return "expense";
  if (sourceKey === "upload") return "documentEvidence";
  return "generalOps";
}

function chooseUnit(text = "", explicit = "") {
  const unit = String(explicit || "").trim();
  if (unit) return unit;
  if (/(temperature|thermostat|degree)/i.test(text)) return "degrees";
  if (/(^|[^a-z])ph([^a-z]|$)|soil|water test/i.test(text)) return "pH";
  if (/(income|expense|vendor|receipt|bill|payment|payroll|1099|rent|revenue|payout)/i.test(text)) return "USD";
  return "count";
}

function deriveAnomalies({ metricKey, metricValue, signals, text }) {
  const anomalies = [];
  const add = (label) => {
    if (!anomalies.includes(label)) anomalies.push(label);
  };

  if (metricKey === "temperature" && metricValue != null) {
    if (metricValue >= 90 || metricValue <= 32) add("Temperature outside normal band");
  }
  if (metricKey === "ph" && metricValue != null) {
    if (metricValue < 5.5 || metricValue > 7.5) add("pH outside nominal band");
  }
  if (["expense", "utilities", "maintenance", "payroll"].includes(metricKey) && metricValue != null) {
    if (metricValue >= 1000) add("High-cost payload");
  }
  if (signals.includes("incident") || /(urgent|critical|leak|failure|down)/i.test(text)) add("Operational incident signal");
  if (signals.includes("photo") && !signals.includes("expense") && !signals.includes("incident")) add("Evidence payload needs interpretation");
  return anomalies;
}

function chooseDirection({ category, metricKey, text }) {
  if (category?.direction && category.direction !== "neutral") return category.direction;
  if (metricKey === "income") return "income";
  if (["expense", "utilities", "maintenance", "payroll"].includes(metricKey)) return "expense";
  if (/(income|rent|revenue|payout|payment received)/i.test(text)) return "income";
  if (/(expense|bill|receipt|vendor|invoice|payment due|amount due|1099|payroll)/i.test(text)) return "expense";
  return "neutral";
}

function chooseSummary({ sourceKey, sourceLabel, recordType, metricKey, observedAt, category, amount, text }) {
  const base = `${sourceLabel || SOURCE_LABELS[sourceKey] || String(sourceKey || "source").toUpperCase()} normalized as ${category?.label || metricKey || "business event"}`;
  const datePart = ` for ${String(observedAt || "").slice(0, 10)}`;
  const amountPart = Number.isFinite(Number(amount)) ? ` with amount ${Number(amount).toFixed(2)}` : "";
  const detail = text ? " BI extracted a dashboard-ready event from the provided payload." : " BI created a normalization shell from the configured source definition.";
  const recordHint = recordType && recordType !== "business_event" ? ` (${recordType})` : "";
  return `${base}${recordHint}${datePart}${amountPart}.${detail}`;
}

function inferCategory({ explicitCategory = "", text = "", metricKey = "", sourceKey = "" }) {
  const candidateText = [explicitCategory, metricKey, text, sourceKey].filter(Boolean).join(" \n ");
  const matched = resolveCanonicalBiCategory({
    value: explicitCategory,
    text: candidateText,
    fallbackLabel: sourceKey === "upload" ? "Photo Evidence" : sourceKey === "gmail" ? "General Ops" : "Operations Monitoring",
  });

  if (matched) return matched;
  if (sourceKey === "upload") return getCategoryByKey("photo_evidence");
  if (["api", "sheets"].includes(sourceKey)) return getCategoryByKey("operations_monitoring");
  return getCategoryByKey("general_ops");
}

function buildFingerprint(parts = []) {
  const stable = parts
    .flatMap((item) => (Array.isArray(item) ? item : [item]))
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join("||")
    .slice(0, 6000);

  return crypto.createHash("sha1").update(stable || `${Date.now()}`).digest("hex");
}

function buildBiNormalizedEvent({ tenantId, sourceKey, payload, onboarding = {}, registryEntry = {}, manualEntry = null, extraContext = {} }) {
  const parsed = parsePayload(payload);
  const structured = parsed.structured || {};
  const flattened = flattenStructuredValue(structured).join(" ");
  const text = [
    parsed.rawText,
    flattened,
    onboarding.companyAlias,
    onboarding.businessSummary,
    onboarding.monitoringGoals,
    onboarding.sourcePlan,
    onboarding.apiPlan,
    onboarding.photoPlan,
    onboarding.manualPlan,
    onboarding.serviceIntent,
    registryEntry.datasetName,
    registryEntry.dataShape,
    registryEntry.targetMetric,
    registryEntry.businessQuestion,
    registryEntry.sampleFieldMap,
    registryEntry.sourceLocator,
    registryEntry.columnMap,
    manualEntry?.title,
    manualEntry?.body,
    manualEntry?.metricName,
    manualEntry?.metricUnit,
    extraContext?.notes,
  ].filter(Boolean).join(" ");

  const genericMetricValue = pickTrustedNumericValue(
    manualEntry?.metricValue,
    structured.metricValue,
    structured.value,
    structured.reading,
    structured.temperature,
    structured.ph,
    structured.incidentCount
  );

  const recordType = chooseRecordType(text, sourceKey);
  const metricKey = chooseMetricKey(text, sourceKey, manualEntry?.metricName || registryEntry.targetMetric);
  const category = inferCategory({
    explicitCategory: manualEntry?.category || structured.category || structured.metricCategory || registryEntry.targetMetric,
    text,
    metricKey,
    sourceKey,
  });
  const direction = chooseDirection({ category, metricKey, text });
  const observedAt = normalizeObservedAt(
    manualEntry?.observedAt,
    structured.observedAt,
    structured.timestamp,
    structured.date,
    structured.eventAt,
    structured.createdAt
  );
  const metricUnit = chooseUnit(text, manualEntry?.metricUnit || structured.metricUnit || structured.unit);
  const signals = detectSignals(text);
  const trustedFinanceAmount = pickTrustedFinanceAmount({ manualEntry, structured });
  const financeLikeMetric = isFinanceMetricKey(metricKey);
  const metricValue =
    financeLikeMetric || direction !== "neutral"
      ? (trustedFinanceAmount ?? genericMetricValue)
      : genericMetricValue;
  const anomalies = deriveAnomalies({ metricKey, metricValue, signals, text });
  const sourceLabel = SOURCE_LABELS[sourceKey] || normString(sourceKey || "") || "Source";
  const amount = direction === "neutral" ? null : trustedFinanceAmount;
  const financeApproved =
    amount != null &&
    financeLikeMetric &&
    ["income", "expense"].includes(String(direction || "").trim());

  return cleanUndefined({
    tenantId,
    eventVersion: BI_EVENT_MODEL_VERSION,
    ingestionFingerprint: buildFingerprint([
      tenantId,
      sourceKey,
      observedAt,
      category?.label,
      metricKey,
      metricValue,
      parsed.rawText,
      JSON.stringify(structured || {}),
    ]),
    sourceKey: normString(sourceKey || "manual") || "manual",
    sourceLabel,
    recordType,
    entityType: recordType,
    direction,
    canonicalCategoryKey: category?.key || null,
    canonicalCategoryLabel: category?.label || null,
    categoryGroup: category?.group || null,
    category: category?.label || null,
    metricKey,
    metricValue,
    metricUnit,
    amount,
    currency: amount != null ? "USD" : null,
    financeApproved,
    financeApprovalSource: financeApproved ? "explicit_amount_field" : null,
    observedAt,
    summary: chooseSummary({ sourceKey, sourceLabel, recordType, metricKey, observedAt, category, amount, text }),
    evidenceText: String(text || "").slice(0, 4000),
    signals,
    anomalies,
    reviewStatus: "normalized",
    registry: {
      datasetName: normString(registryEntry.datasetName || ""),
      dataShape: normString(registryEntry.dataShape || ""),
      targetMetric: normString(registryEntry.targetMetric || ""),
      businessQuestion: normString(registryEntry.businessQuestion || ""),
      sourceLocator: normString(registryEntry.sourceLocator || ""),
      columnMap: normString(registryEntry.columnMap || ""),
    },
    onboardingContext: {
      companyAlias: normString(onboarding.companyAlias || ""),
      profileHint: normString(onboarding.monitoringGoals || ""),
    },
    rawPayload: structured || parsed.rawText || null,
    sourceMeta: cleanUndefined(extraContext.sourceMeta || {}),
    createdAtIso: new Date().toISOString(),
  });
}

module.exports = {
  BI_EVENT_MODEL_VERSION,
  SOURCE_LABELS,
  cleanUndefined,
  parsePayload,
  flattenStructuredValue,
  extractFirstNumber,
  parseTrustedNumericValue,
  pickTrustedNumericValue,
  pickTrustedFinanceAmount,
  isFinanceMetricKey,
  normalizeObservedAt,
  detectSignals,
  chooseRecordType,
  chooseMetricKey,
  chooseUnit,
  deriveAnomalies,
  buildBiNormalizedEvent,
};