const CANONICAL_BI_CATEGORIES = Object.freeze([
  {
    key: "rental_income",
    label: "Rental Income",
    group: "income",
    direction: "income",
    aliases: ["rent income", "rental payout", "host payout", "airbnb payout", "vrbo payout"],
  },
  {
    key: "business_income",
    label: "Business Income",
    group: "income",
    direction: "income",
    aliases: ["income", "business revenue", "revenue", "sales income", "payout"],
  },
  {
    key: "retail_receipts",
    label: "Retail Receipts",
    group: "expense",
    direction: "expense",
    aliases: ["retail receipt", "receipt", "store receipt", "merchant receipt"],
  },
  {
    key: "utilities",
    label: "Utilities",
    group: "expense",
    direction: "expense",
    aliases: ["utility", "utilities", "power", "water", "internet", "gas", "trash", "sewer"],
  },
  {
    key: "maintenance",
    label: "Maintenance",
    group: "expense",
    direction: "expense",
    aliases: ["repair", "property maintenance", "maintenance expense", "service call", "plumbing", "hvac"],
  },
  {
    key: "professional_fees",
    label: "Professional Fees",
    group: "expense",
    direction: "expense",
    aliases: ["professional services", "professional fee", "consulting", "legal", "accounting", "bookkeeping", "cpa"],
  },
  {
    key: "taxes_compliance",
    label: "Taxes & Compliance",
    group: "expense",
    direction: "expense",
    aliases: ["tax", "taxes", "compliance", "permit", "license", "filing", "irs"],
  },
  {
    key: "insurance",
    label: "Insurance",
    group: "expense",
    direction: "expense",
    aliases: ["insurance", "premium", "coverage"],
  },
  {
    key: "software",
    label: "Software",
    group: "expense",
    direction: "expense",
    aliases: ["software", "subscription", "saas", "tooling"],
  },
  {
    key: "supplies_equipment",
    label: "Supplies & Equipment",
    group: "expense",
    direction: "expense",
    aliases: ["supplies", "equipment", "office supplies", "tools", "hardware"],
  },
  {
    key: "travel",
    label: "Travel",
    group: "expense",
    direction: "expense",
    aliases: ["travel", "lodging", "hotel", "flight", "transportation"],
  },
  {
    key: "payroll",
    label: "Payroll",
    group: "expense",
    direction: "expense",
    aliases: ["payroll", "salary", "wages", "employee pay"],
  },
  {
    key: "contractor_1099",
    label: "1099 Contractor",
    group: "expense",
    direction: "expense",
    aliases: ["1099", "1099 contractor", "contractor", "w-9", "w9", "nec"],
  },
  {
    key: "operations_monitoring",
    label: "Operations Monitoring",
    group: "operations",
    direction: "neutral",
    aliases: ["ops", "operations", "telemetry", "monitoring"],
  },
  {
    key: "incident_issue",
    label: "Incident / Issue",
    group: "operations",
    direction: "neutral",
    aliases: ["incident", "issue", "ticket", "alert", "leak", "failure"],
  },
  {
    key: "field_crop_reading",
    label: "Field / Crop Reading",
    group: "operations",
    direction: "neutral",
    aliases: ["ph", "soil", "crop", "field reading", "water test"],
  },
  {
    key: "temperature_monitoring",
    label: "Temperature Monitoring",
    group: "operations",
    direction: "neutral",
    aliases: ["temperature", "thermostat", "degrees", "climate"],
  },
  {
    key: "photo_evidence",
    label: "Photo Evidence",
    group: "evidence",
    direction: "neutral",
    aliases: ["photo", "image", "screenshot", "document evidence", "pdf"],
  },
  {
    key: "general_ops",
    label: "General Ops",
    group: "operations",
    direction: "neutral",
    aliases: ["business email", "ops note", "general operations"],
  },
  {
    key: "other_business_expense",
    label: "Other Business Expense",
    group: "expense",
    direction: "expense",
    aliases: ["business expense", "other expense", "misc expense", "expense"],
  },
]);

const RECEIPT_REVIEW_CATEGORY_KEYS = Object.freeze([
  "maintenance",
  "utilities",
  "professional_fees",
  "taxes_compliance",
  "insurance",
  "software",
  "supplies_equipment",
  "travel",
  "general_ops",
  "other_business_expense",
]);

const TEXT_CATEGORY_RULES = Object.freeze([
  { key: "contractor_1099", test: /(1099|w-9|w9|tax form|irs|nec form|misc form|contractor payment|tax document)/i },
  { key: "rental_income", test: /(airbnb|vrbo|booking\.com|reservation payout|host payout|rental payout|rent payment|income statement)/i },
  { key: "payroll", test: /(payroll|salary|wages|employee pay|timesheet)/i },
  { key: "utilities", test: /(utility|water bill|electric bill|power bill|gas bill|internet bill|phone bill|trash service|sewer|comcast|xfinity|verizon|at&t|fpl|duke energy)/i },
  { key: "maintenance", test: /(maintenance|repair|plumbing|hvac|electrical repair|service call|landscaping|pest control|roof repair|handyman|cleaning service|appliance repair)/i },
  { key: "insurance", test: /(insurance|policy premium|coverage invoice)/i },
  { key: "professional_fees", test: /(legal invoice|accounting fee|professional fee|consulting invoice|service invoice|attorney|bookkeeping|cpa|law firm|advisor)/i },
  { key: "taxes_compliance", test: /(tax|irs|filing|permit|license|registration|compliance)/i },
  { key: "software", test: /(software|subscription|saas|google workspace|microsoft|aws|amazon web services|openai|chatgpt|notion|zoom|slack|adobe|quickbooks|xero)/i },
  { key: "travel", test: /(travel|hotel|flight|airline|uber|lyft|marriott|hilton|transportation|lodging)/i },
  { key: "supplies_equipment", test: /(amazon|office depot|staples|walmart|costco|supply order|office supply|purchase order|equipment|tool|hardware|lowe's|home depot)/i },
  { key: "photo_evidence", test: /(photo|image|screenshot|pdf|evidence)/i },
  { key: "temperature_monitoring", test: /(temperature|thermostat|degree|sensor|climate)/i },
  { key: "field_crop_reading", test: /((^|[^a-z])ph([^a-z]|$)|soil|water test|crop)/i },
  { key: "incident_issue", test: /(incident|ticket|issue|alert|leak|failure|urgent|critical)/i },
  { key: "business_income", test: /(income|invoice paid|revenue|sales|payment received|deposit)/i },
  { key: "other_business_expense", test: /(invoice|amount due|bill|statement|receipt|payment confirmation|expense|vendor)/i },
  { key: "general_ops", test: /(business|operations|manual|operator|inspection|note)/i },
]);

const CATEGORY_BY_KEY = new Map(CANONICAL_BI_CATEGORIES.map((item) => [item.key, item]));
const CATEGORY_BY_TOKEN = new Map();

function normalizeCategoryToken(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

for (const item of CANONICAL_BI_CATEGORIES) {
  CATEGORY_BY_TOKEN.set(normalizeCategoryToken(item.label), item);
  (item.aliases || []).forEach((alias) => {
    CATEGORY_BY_TOKEN.set(normalizeCategoryToken(alias), item);
  });
}

function cloneCategory(def) {
  return def ? { ...def, aliases: [...(def.aliases || [])] } : null;
}

function getCanonicalBiCategories() {
  return CANONICAL_BI_CATEGORIES.map((item) => cloneCategory(item));
}

function findCanonicalBiCategory(value = "") {
  const normalized = normalizeCategoryToken(value);
  if (!normalized) return null;
  return cloneCategory(CATEGORY_BY_TOKEN.get(normalized) || null);
}

function getCategoryByKey(key = "") {
  return cloneCategory(CATEGORY_BY_KEY.get(String(key || "").trim()) || null);
}

function resolveBiCategoryFromText(text = "", fallbackLabel = "") {
  const haystack = String(text || "").trim();
  for (const rule of TEXT_CATEGORY_RULES) {
    if (rule.test.test(haystack)) {
      return getCategoryByKey(rule.key);
    }
  }
  return fallbackLabel ? findCanonicalBiCategory(fallbackLabel) : null;
}

function resolveCanonicalBiCategory({ value = "", text = "", fallbackLabel = "" } = {}) {
  return findCanonicalBiCategory(value) || resolveBiCategoryFromText(text, fallbackLabel) || null;
}

function getReceiptReviewBiCategories() {
  return RECEIPT_REVIEW_CATEGORY_KEYS.map((key) => getCategoryByKey(key)).filter(Boolean);
}

function isExpenseBiCategory(value = "") {
  const item = typeof value === "string" ? findCanonicalBiCategory(value) : value;
  return item?.direction === "expense";
}

function isIncomeBiCategory(value = "") {
  const item = typeof value === "string" ? findCanonicalBiCategory(value) : value;
  return item?.direction === "income";
}

module.exports = {
  CANONICAL_BI_CATEGORIES,
  RECEIPT_REVIEW_CATEGORY_KEYS,
  getCanonicalBiCategories,
  getReceiptReviewBiCategories,
  normalizeCategoryToken,
  findCanonicalBiCategory,
  getCategoryByKey,
  resolveBiCategoryFromText,
  resolveCanonicalBiCategory,
  isExpenseBiCategory,
  isIncomeBiCategory,
};