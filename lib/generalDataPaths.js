const { buildRetailOwnerMeta, buildRetailScopedDocId, retailTenantDoc, retailTenantCollection } = require("./retailPaths");

const GENERAL_SETTINGS_COLLECTION = "generalDataSettings";
const GENERAL_ALLOWLIST_COLLECTION = "generalDataAllowlist";
const GENERAL_DOCUMENTS_COLLECTION = "generalDocuments";
const GENERAL_FAILURES_COLLECTION = "generalDocuments_failed";
const GENERAL_RUNS_COLLECTION = "generalDocumentRuns";
const GENERAL_SINGLETON_DOC_ID = "main";

function generalSettingsDoc(db, tenantId) {
  return retailTenantDoc(db, tenantId, GENERAL_SETTINGS_COLLECTION, GENERAL_SINGLETON_DOC_ID);
}

function generalAllowlistCollection(db, tenantId) {
  return retailTenantCollection(db, tenantId, GENERAL_ALLOWLIST_COLLECTION);
}

function generalAllowlistDoc(db, tenantId, docId) {
  return retailTenantDoc(db, tenantId, GENERAL_ALLOWLIST_COLLECTION, docId);
}

function generalDocumentsCollection(db, tenantId) {
  return retailTenantCollection(db, tenantId, GENERAL_DOCUMENTS_COLLECTION);
}

function generalDocumentDoc(db, tenantId, rawIdOrDocId) {
  const sourceId = String(rawIdOrDocId || "").trim();
  const docId = sourceId.includes("__") ? sourceId : buildRetailScopedDocId(tenantId, sourceId);
  return retailTenantDoc(db, tenantId, GENERAL_DOCUMENTS_COLLECTION, docId);
}

function generalFailuresCollection(db, tenantId) {
  return retailTenantCollection(db, tenantId, GENERAL_FAILURES_COLLECTION);
}

function generalFailureDoc(db, tenantId, rawIdOrDocId) {
  const sourceId = String(rawIdOrDocId || "").trim();
  const docId = sourceId.includes("__") ? sourceId : buildRetailScopedDocId(tenantId, rawIdOrDocId);
  return retailTenantDoc(db, tenantId, GENERAL_FAILURES_COLLECTION, docId);
}

function generalRunsCollection(db, tenantId) {
  return retailTenantCollection(db, tenantId, GENERAL_RUNS_COLLECTION);
}

function generalRunDoc(db, tenantId, rawIdOrDocId) {
  const sourceId = String(rawIdOrDocId || "").trim();
  const docId = sourceId.includes("__") ? sourceId : buildRetailScopedDocId(tenantId, rawIdOrDocId);
  return retailTenantDoc(db, tenantId, GENERAL_RUNS_COLLECTION, docId);
}

function buildGeneralOwnedPayload(tenantId, extra = {}) {
  return {
    ...buildRetailOwnerMeta(tenantId),
    pipelineType: "general_data",
    ...extra,
  };
}

module.exports = {
  GENERAL_SETTINGS_COLLECTION,
  GENERAL_ALLOWLIST_COLLECTION,
  GENERAL_DOCUMENTS_COLLECTION,
  GENERAL_FAILURES_COLLECTION,
  GENERAL_RUNS_COLLECTION,
  GENERAL_SINGLETON_DOC_ID,
  generalSettingsDoc,
  generalAllowlistCollection,
  generalAllowlistDoc,
  generalDocumentsCollection,
  generalDocumentDoc,
  generalFailuresCollection,
  generalFailureDoc,
  generalRunsCollection,
  generalRunDoc,
  buildGeneralOwnedPayload,
};