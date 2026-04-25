const RETAIL_SCHEMA_VERSION = "retail-schema-v1";

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  return value;
}

function safeString(value, label, { allowEmpty = true, max = 5000 } = {}) {
  const safe = value == null ? "" : String(value);
  if (!allowEmpty && !safe.trim()) {
    throw new Error(`Invalid ${label}: required`);
  }
  if (safe.length > max) {
    throw new Error(`Invalid ${label}: too long`);
  }
  return safe;
}

function safeNumber(value, label, { min = 0 } = {}) {
  if (value == null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${label}: must be a number`);
  if (n < min) throw new Error(`Invalid ${label}: below minimum`);
  return n;
}

function safeStringArray(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}: must be an array`);
  return value.map((x) => safeString(x, `${label}[]`, { allowEmpty: false, max: 500 })).filter(Boolean);
}

function validateOwnerFields(payload, tenantId, label) {
  const safe = assertPlainObject(payload, label);
  const safeTenantId = safeString(tenantId, "tenantId", { allowEmpty: false, max: 300 }).trim();

  if ("tenantId" in safe && safeString(safe.tenantId, `${label}.tenantId`, { allowEmpty: false, max: 300 }).trim() !== safeTenantId) {
    throw new Error(`Invalid ${label}: tenantId mismatch`);
  }
  if ("workspaceId" in safe && safeString(safe.workspaceId, `${label}.workspaceId`, { allowEmpty: false, max: 300 }).trim() !== safeTenantId) {
    throw new Error(`Invalid ${label}: workspaceId must match tenantId`);
  }
  if ("retailOwnerId" in safe && safeString(safe.retailOwnerId, `${label}.retailOwnerId`, { allowEmpty: false, max: 300 }).trim() !== safeTenantId) {
    throw new Error(`Invalid ${label}: retailOwnerId must match tenantId`);
  }

  return {
    ...safe,
    retailSchemaVersion: RETAIL_SCHEMA_VERSION,
    tenantId: safeTenantId,
    workspaceId: safeTenantId,
    retailOwnerId: safeTenantId,
  };
}

function validateAllowlistPayload(payload, tenantId) {
  const next = validateOwnerFields(payload, tenantId, "retail allowlist");
  if ("type" in next) next.type = safeString(next.type, "allowlist.type", { allowEmpty: false, max: 40 }).trim();
  if ("pattern" in next) next.pattern = safeString(next.pattern, "allowlist.pattern", { allowEmpty: false, max: 500 }).trim().toLowerCase();
  return next;
}

function validateSettingsPayload(payload, tenantId) {
  const next = validateOwnerFields(payload, tenantId, "retail settings");
  if ("lane" in next) next.lane = safeString(next.lane, "settings.lane", { max: 100 }).trim();
  if ("daysDefault" in next) next.daysDefault = safeNumber(next.daysDefault, "settings.daysDefault", { min: 1 });
  if ("maxMessagesDefault" in next) next.maxMessagesDefault = safeNumber(next.maxMessagesDefault, "settings.maxMessagesDefault", { min: 1 });
  if ("allowlistInput" in next) next.allowlistInput = safeString(next.allowlistInput, "settings.allowlistInput", { max: 20000 });
  if ("allowlist" in next) {
    const allowlist = assertPlainObject(next.allowlist, "settings.allowlist");
    next.allowlist = {
      emails: safeStringArray(allowlist.emails, "settings.allowlist.emails").map((x) => x.toLowerCase()),
      domains: safeStringArray(allowlist.domains, "settings.allowlist.domains").map((x) => x.toLowerCase()),
    };
  }
  if ("onboardingCompleted" in next) next.onboardingCompleted = !!next.onboardingCompleted;
  if ("skipProcessed" in next) next.skipProcessed = !!next.skipProcessed;
  if ("processedLabel" in next) next.processedLabel = safeString(next.processedLabel, "settings.processedLabel", { allowEmpty: false, max: 200 }).trim();
  if ("receiptsLabel" in next) next.receiptsLabel = safeString(next.receiptsLabel, "settings.receiptsLabel", { allowEmpty: false, max: 200 }).trim();
  if ("lastHistoryId" in next) next.lastHistoryId = safeString(next.lastHistoryId, "settings.lastHistoryId", { max: 200 }).trim();
  if ("lastSyncCursorIso" in next) next.lastSyncCursorIso = safeString(next.lastSyncCursorIso, "settings.lastSyncCursorIso", { max: 100 }).trim();
  if ("syncOverlapMinutes" in next) next.syncOverlapMinutes = safeNumber(next.syncOverlapMinutes, "settings.syncOverlapMinutes", { min: 0 });
  return next;
}

function validateConnectionPayload(payload, tenantId) {
  const next = validateOwnerFields(payload, tenantId, "retail gmail connection");
  if ("gmailEmail" in next) next.gmailEmail = safeString(next.gmailEmail, "connection.gmailEmail", { max: 320 }).trim().toLowerCase();
  if ("email" in next) next.email = safeString(next.email, "connection.email", { max: 320 }).trim().toLowerCase();
  if ("connectionEmail" in next) next.connectionEmail = safeString(next.connectionEmail, "connection.connectionEmail", { max: 320 }).trim().toLowerCase();
  if ("historyId" in next) next.historyId = safeString(next.historyId, "connection.historyId", { max: 200 }).trim();
  if ("lastHistoryId" in next) next.lastHistoryId = safeString(next.lastHistoryId, "connection.lastHistoryId", { max: 200 }).trim();
  if ("lastSyncCursorIso" in next) next.lastSyncCursorIso = safeString(next.lastSyncCursorIso, "connection.lastSyncCursorIso", { max: 100 }).trim();
  if ("syncOverlapMinutes" in next) next.syncOverlapMinutes = safeNumber(next.syncOverlapMinutes, "connection.syncOverlapMinutes", { min: 0 });
  if ("scopes" in next) next.scopes = safeStringArray(next.scopes, "connection.scopes");
  if ("connectedByUid" in next) next.connectedByUid = safeString(next.connectedByUid, "connection.connectedByUid", { max: 200 }).trim();
  return next;
}

function validateReceiptPayload(payload, tenantId) {
  const next = validateOwnerFields(payload, tenantId, "retail receipt");
  if ("id" in next) next.id = safeString(next.id, "receipt.id", { allowEmpty: false, max: 400 }).trim();
  if ("messageId" in next) next.messageId = safeString(next.messageId, "receipt.messageId", { max: 400 }).trim();
  if ("merchant" in next) next.merchant = safeString(next.merchant, "receipt.merchant", { max: 500 }).trim();
  if ("senderEmail" in next) next.senderEmail = safeString(next.senderEmail, "receipt.senderEmail", { max: 320 }).trim().toLowerCase();
  if ("orderDate" in next) next.orderDate = safeString(next.orderDate, "receipt.orderDate", { max: 100 }).trim();
  if ("orderId" in next) next.orderId = safeString(next.orderId, "receipt.orderId", { max: 200 }).trim();
  if ("category" in next) next.category = safeString(next.category || "Other", "receipt.category", { allowEmpty: false, max: 120 }).trim() || "Other";
  if ("vendorAddress" in next) next.vendorAddress = safeString(next.vendorAddress, "receipt.vendorAddress", { max: 1000 }).trim();
  if ("subtotal" in next) next.subtotal = safeNumber(next.subtotal, "receipt.subtotal", { min: 0 });
  if ("tax" in next) next.tax = safeNumber(next.tax, "receipt.tax", { min: 0 });
  if ("shipping" in next) next.shipping = safeNumber(next.shipping, "receipt.shipping", { min: 0 });
  if ("total" in next) next.total = safeNumber(next.total, "receipt.total", { min: 0 });
  if ("items" in next && !Array.isArray(next.items)) throw new Error("Invalid receipt.items: must be an array");
  if ("status" in next) next.status = safeString(next.status, "receipt.status", { allowEmpty: false, max: 60 }).trim().toUpperCase();
  return next;
}

function validateFailurePayload(payload, tenantId) {
  const next = validateReceiptPayload(payload, tenantId);
  if ("reviewStatus" in next) next.reviewStatus = safeString(next.reviewStatus, "failure.reviewStatus", { allowEmpty: false, max: 60 }).trim().toUpperCase();
  if ("opsNote" in next) next.opsNote = safeString(next.opsNote, "failure.opsNote", { max: 2000 }).trim();
  return next;
}

function validateRunPayload(payload, tenantId) {
  const next = validateOwnerFields(payload, tenantId, "retail run");
  if ("runId" in next) next.runId = safeString(next.runId, "run.runId", { allowEmpty: false, max: 200 }).trim();
  if ("type" in next) next.type = safeString(next.type, "run.type", { allowEmpty: false, max: 60 }).trim();
  if ("inboxEmail" in next) next.inboxEmail = safeString(next.inboxEmail, "run.inboxEmail", { max: 320 }).trim().toLowerCase();
  if ("requested" in next) next.requested = safeNumber(next.requested, "run.requested", { min: 0 });
  if ("matched" in next) next.matched = safeNumber(next.matched, "run.matched", { min: 0 });
  if ("filteredOut" in next) next.filteredOut = safeNumber(next.filteredOut, "run.filteredOut", { min: 0 });
  if ("queryCount" in next) next.queryCount = safeNumber(next.queryCount, "run.queryCount", { min: 0 });
  if ("queries" in next && !Array.isArray(next.queries)) throw new Error("Invalid run.queries: must be an array");
  return next;
}

function validateRetailDocForSave(kind, payload, tenantId) {
  switch (String(kind || "").trim()) {
    case "settings":
      return validateSettingsPayload(payload, tenantId);
    case "connection":
      return validateConnectionPayload(payload, tenantId);
    case "allowlist":
      return validateAllowlistPayload(payload, tenantId);
    case "receipt":
      return validateReceiptPayload(payload, tenantId);
    case "failure":
      return validateFailurePayload(payload, tenantId);
    case "run":
      return validateRunPayload(payload, tenantId);
    default:
      return validateOwnerFields(payload, tenantId, "retail doc");
  }
}

module.exports = {
  RETAIL_SCHEMA_VERSION,
  validateRetailDocForSave,
  validateSettingsPayload,
  validateConnectionPayload,
  validateAllowlistPayload,
  validateReceiptPayload,
  validateFailurePayload,
  validateRunPayload,
};