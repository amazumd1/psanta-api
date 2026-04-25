const RETAIL_TENANTS_ROOT = "tenants";
const RETAIL_SINGLETON_DOC_ID = "main";

const RETAIL_OWNER_MODE = "tenant";
const RETAIL_DASHBOARD_SCOPE = "company";
const RETAIL_DASHBOARD_CARDINALITY = "one_company_one_dashboard";
const RETAIL_DASHBOARD_OWNER_ENTITY = "tenant";
const RETAIL_MODEL_VERSION = "retail-company-dashboard-v1";
const RETAIL_DOC_ID_SEPARATOR = "__";
const RETAIL_PATH_CONTRACT_VERSION = "retail-path-contract-v1";

const RETAIL_CONNECTIONS_COLLECTION = "gmailConnections";
const RETAIL_SETTINGS_COLLECTION = "gmailReceiptSettings";
const RETAIL_ALLOWLIST_COLLECTION = "receiptAllowlist";
const RETAIL_RECEIPTS_COLLECTION = "retailReceipts";
const RETAIL_FAILURES_COLLECTION = "retailReceipts_failed";
const RETAIL_RUNS_COLLECTION = "retailReceiptRuns";
const RETAIL_SENDER_SUGGESTIONS_COLLECTION = "retailSenderSuggestions";

function safeRetailTenantId(retailTenantId) {
  const safe = String(retailTenantId || "").trim();
  if (!safe) throw new Error("Missing retailTenantId");
  return safe;
}

function safeRetailDocKey(value, label = "doc key") {
  const safe = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .slice(0, 300);

  if (!safe) throw new Error(`Missing ${label}`);
  return safe;
}

function buildRetailOwnerMeta(retailTenantId) {
  const safe = safeRetailTenantId(retailTenantId);

  return {
    tenantId: safe,
    workspaceId: safe,
    retailOwnerId: safe,
    retailTenantId: safe,
    ownerMode: RETAIL_OWNER_MODE,
    retailDashboardScope: RETAIL_DASHBOARD_SCOPE,
    retailDashboardCardinality: RETAIL_DASHBOARD_CARDINALITY,
    retailDashboardOwnerEntity: RETAIL_DASHBOARD_OWNER_ENTITY,
    retailModelVersion: RETAIL_MODEL_VERSION,
  };
}

function buildRetailScopedDocId(retailTenantId, rawId) {
  const tenantId = safeRetailTenantId(retailTenantId);
  const sourceId = safeRetailDocKey(rawId, "rawId");
  return `${tenantId}${RETAIL_DOC_ID_SEPARATOR}${sourceId}`;
}

function buildRetailReceiptDocId(retailTenantId, rawId) {
  return buildRetailScopedDocId(retailTenantId, rawId);
}

function buildRetailFailureDocId(retailTenantId, rawId) {
  return buildRetailScopedDocId(retailTenantId, rawId);
}

function buildRetailRunDocId(retailTenantId, runId) {
  return buildRetailScopedDocId(retailTenantId, runId);
}

function retailTenantPath(retailTenantId, ...segments) {
  return [RETAIL_TENANTS_ROOT, safeRetailTenantId(retailTenantId), ...segments]
    .filter(Boolean)
    .join("/");
}

function retailTenantDoc(db, retailTenantId, ...segments) {
  return db.doc(retailTenantPath(retailTenantId, ...segments));
}

function retailTenantCollection(db, retailTenantId, ...segments) {
  return db.collection(retailTenantPath(retailTenantId, ...segments));
}

const retailPaths = {
  tenantRoot: (retailTenantId) => retailTenantPath(retailTenantId),
  connectionDoc: (retailTenantId) =>
    retailTenantPath(
      retailTenantId,
      RETAIL_CONNECTIONS_COLLECTION,
      RETAIL_SINGLETON_DOC_ID
    ),
  settingsDoc: (retailTenantId) =>
    retailTenantPath(
      retailTenantId,
      RETAIL_SETTINGS_COLLECTION,
      RETAIL_SINGLETON_DOC_ID
    ),
  allowlistCollection: (retailTenantId) =>
    retailTenantPath(retailTenantId, RETAIL_ALLOWLIST_COLLECTION),
  allowlistDoc: (retailTenantId, docId) =>
    retailTenantPath(retailTenantId, RETAIL_ALLOWLIST_COLLECTION, docId),
  receiptsCollection: (retailTenantId) =>
    retailTenantPath(retailTenantId, RETAIL_RECEIPTS_COLLECTION),
  receiptDoc: (retailTenantId, docId) =>
    retailTenantPath(retailTenantId, RETAIL_RECEIPTS_COLLECTION, docId),
  failuresCollection: (retailTenantId) =>
    retailTenantPath(retailTenantId, RETAIL_FAILURES_COLLECTION),
  failureDoc: (retailTenantId, docId) =>
    retailTenantPath(retailTenantId, RETAIL_FAILURES_COLLECTION, docId),
  runsCollection: (retailTenantId) =>
    retailTenantPath(retailTenantId, RETAIL_RUNS_COLLECTION),
  runDoc: (retailTenantId, docId) =>
    retailTenantPath(retailTenantId, RETAIL_RUNS_COLLECTION, docId),
  senderSuggestionsCollection: (retailTenantId) =>
    retailTenantPath(retailTenantId, RETAIL_SENDER_SUGGESTIONS_COLLECTION),
  senderSuggestionDoc: (retailTenantId, docId) =>
    retailTenantPath(retailTenantId, RETAIL_SENDER_SUGGESTIONS_COLLECTION, docId),
};

function retailConnectionDoc(db, retailTenantId) {
  return retailTenantDoc(
    db,
    retailTenantId,
    RETAIL_CONNECTIONS_COLLECTION,
    RETAIL_SINGLETON_DOC_ID
  );
}

function retailSettingsDoc(db, retailTenantId) {
  return retailTenantDoc(
    db,
    retailTenantId,
    RETAIL_SETTINGS_COLLECTION,
    RETAIL_SINGLETON_DOC_ID
  );
}

function retailAllowlistCollection(db, retailTenantId) {
  return retailTenantCollection(db, retailTenantId, RETAIL_ALLOWLIST_COLLECTION);
}

function retailAllowlistDoc(db, retailTenantId, docId) {
  return retailTenantDoc(db, retailTenantId, RETAIL_ALLOWLIST_COLLECTION, docId);
}

function retailReceiptsCollection(db, retailTenantId) {
  return retailTenantCollection(db, retailTenantId, RETAIL_RECEIPTS_COLLECTION);
}

function retailReceiptDoc(db, retailTenantId, rawIdOrDocId) {
  const sourceId = String(rawIdOrDocId || "").trim();
  const docId = sourceId.includes(RETAIL_DOC_ID_SEPARATOR)
    ? sourceId
    : buildRetailReceiptDocId(retailTenantId, sourceId);

  return retailTenantDoc(db, retailTenantId, RETAIL_RECEIPTS_COLLECTION, docId);
}

function retailFailuresCollection(db, retailTenantId) {
  return retailTenantCollection(db, retailTenantId, RETAIL_FAILURES_COLLECTION);
}

function retailFailureDoc(db, retailTenantId, rawIdOrDocId) {
  const sourceId = String(rawIdOrDocId || "").trim();
  const docId = sourceId.includes(RETAIL_DOC_ID_SEPARATOR)
    ? sourceId
    : buildRetailFailureDocId(retailTenantId, sourceId);

  return retailTenantDoc(db, retailTenantId, RETAIL_FAILURES_COLLECTION, docId);
}

function retailRunsCollection(db, retailTenantId) {
  return retailTenantCollection(db, retailTenantId, RETAIL_RUNS_COLLECTION);
}

function retailSenderSuggestionsCollection(db, retailTenantId) {
  return retailTenantCollection(db, retailTenantId, RETAIL_SENDER_SUGGESTIONS_COLLECTION);
}

function retailSenderSuggestionDoc(db, retailTenantId, docId) {
  return retailTenantDoc(
    db,
    retailTenantId,
    RETAIL_SENDER_SUGGESTIONS_COLLECTION,
    safeRetailDocKey(docId, "suggestion docId")
  );
}

function retailRunDoc(db, retailTenantId, runIdOrDocId) {
  const sourceId = String(runIdOrDocId || "").trim();
  const docId = sourceId.includes(RETAIL_DOC_ID_SEPARATOR)
    ? sourceId
    : buildRetailRunDocId(retailTenantId, sourceId);

  return retailTenantDoc(db, retailTenantId, RETAIL_RUNS_COLLECTION, docId);
}

const retailPathContract = Object.freeze({
  version: RETAIL_PATH_CONTRACT_VERSION,
  tenantRoot: RETAIL_TENANTS_ROOT,
  singletonDocId: RETAIL_SINGLETON_DOC_ID,
  connectionDoc: `tenants/{tenantId}/${RETAIL_CONNECTIONS_COLLECTION}/${RETAIL_SINGLETON_DOC_ID}`,
  settingsDoc: `tenants/{tenantId}/${RETAIL_SETTINGS_COLLECTION}/${RETAIL_SINGLETON_DOC_ID}`,
  allowlistDoc: `tenants/{tenantId}/${RETAIL_ALLOWLIST_COLLECTION}/{docId}`,
  receiptDoc: `tenants/{tenantId}/${RETAIL_RECEIPTS_COLLECTION}/{tenantId__rawId}`,
  failureDoc: `tenants/{tenantId}/${RETAIL_FAILURES_COLLECTION}/{tenantId__rawId}`,
  runDoc: `tenants/{tenantId}/${RETAIL_RUNS_COLLECTION}/{tenantId__runId}`,
  receiptDocIdFormat: `{tenantId}${RETAIL_DOC_ID_SEPARATOR}{rawId}`,
  failureDocIdFormat: `{tenantId}${RETAIL_DOC_ID_SEPARATOR}{rawId}`,
  runDocIdFormat: `{tenantId}${RETAIL_DOC_ID_SEPARATOR}{runId}`,
});

function buildRetailOwnedPayload(retailTenantId, extra = {}) {
  const safeId = safeRetailTenantId(retailTenantId);

  return {
    ...buildRetailOwnerMeta(safeId),
    retailPathContractVersion: RETAIL_PATH_CONTRACT_VERSION,
    ...extra,
  };
}

module.exports = {
  RETAIL_TENANTS_ROOT,
  RETAIL_SINGLETON_DOC_ID,
  RETAIL_OWNER_MODE,
  RETAIL_DASHBOARD_SCOPE,
  RETAIL_DASHBOARD_CARDINALITY,
  RETAIL_DASHBOARD_OWNER_ENTITY,
  RETAIL_MODEL_VERSION,
  RETAIL_DOC_ID_SEPARATOR,
  RETAIL_PATH_CONTRACT_VERSION,
  RETAIL_CONNECTIONS_COLLECTION,
  RETAIL_SETTINGS_COLLECTION,
  RETAIL_ALLOWLIST_COLLECTION,
  RETAIL_RECEIPTS_COLLECTION,
  RETAIL_FAILURES_COLLECTION,
  RETAIL_RUNS_COLLECTION,
  retailTenantPath,
  retailTenantDoc,
  retailTenantCollection,
  retailPaths,
  retailConnectionDoc,
  retailSettingsDoc,
  retailAllowlistCollection,
  retailAllowlistDoc,
  retailReceiptsCollection,
  retailReceiptDoc,
  retailFailuresCollection,
  retailFailureDoc,
  retailRunsCollection,
  retailRunDoc,
  buildRetailOwnerMeta,
  buildRetailScopedDocId,
  buildRetailReceiptDocId,
  buildRetailFailureDocId,
  buildRetailRunDocId,
  retailPathContract,
  buildRetailOwnedPayload,
  RETAIL_SENDER_SUGGESTIONS_COLLECTION,
  retailSenderSuggestionsCollection,
  retailSenderSuggestionDoc,
};