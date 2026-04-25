const { serverTimestamp } = require("../../lib/firebaseAdminApp");
const { tenantCollection, tenantDoc } = require("../../lib/tenantFirestore");
const { buildBiNormalizedEvent, cleanUndefined } = require("./biEventModel");

async function readBiMainDoc(db, tenantId) {
  const snap = await tenantDoc(db, tenantId, "businessIntelligence", "main").get();
  return snap.exists ? snap.data() || {} : {};
}

async function persistBiNormalizedRows(db, tenantId, rows = [], extra = {}) {
  const ids = [];
  for (const row of rows) {
    const ref = await tenantCollection(db, tenantId, "businessIntelligenceNormalized").add({
      ...row,
      ...extra,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    ids.push(ref.id);
  }
  return ids;
}

function summarizeBiRows(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  return {
    anomalies: Array.from(new Set(safeRows.flatMap((row) => row.anomalies || []))),
    signals: Array.from(new Set(safeRows.flatMap((row) => row.signals || []))),
    categories: Array.from(new Set(safeRows.map((row) => row.canonicalCategoryLabel || row.category).filter(Boolean))),
  };
}

async function createBiRun(db, tenantId, data = {}) {
  const payload = cleanUndefined({
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  const ref = await tenantCollection(db, tenantId, "businessIntelligenceRuns").add(payload);
  return ref.id;
}

async function ingestBiSingleEvent({
  db,
  tenantId,
  sourceKey,
  payload,
  onboarding = {},
  registryEntry = {},
  manualEntry = null,
  persistNormalized = true,
  normalizedExtra = {},
  createRun = false,
  runType = "normalize",
  runExtra = {},
  extraContext = {},
}) {
  const normalized = buildBiNormalizedEvent({
    tenantId,
    sourceKey,
    payload,
    onboarding,
    registryEntry,
    manualEntry,
    extraContext,
  });

  let normalizedId = null;
  if (persistNormalized) {
    const ids = await persistBiNormalizedRows(db, tenantId, [{ ...normalized, ...normalizedExtra }]);
    normalizedId = ids[0] || null;
  }

  let runId = null;
  if (createRun) {
    runId = await createBiRun(db, tenantId, {
      runType,
      sourceKey,
      normalizedId,
      summary: normalized.summary,
      anomalies: normalized.anomalies || [],
      signals: normalized.signals || [],
      categories: normalized.canonicalCategoryLabel ? [normalized.canonicalCategoryLabel] : [],
      ...runExtra,
    });
  }

  return { normalized, normalizedId, runId };
}

async function ingestBiBatchEvents({
  db,
  tenantId,
  sourceKey,
  rows = [],
  onboarding = {},
  registryEntry = {},
  persistNormalized = true,
  normalizedExtra = {},
  createRun = false,
  runType = "normalize-batch",
  runExtra = {},
}) {
  const normalizedRows = (Array.isArray(rows) ? rows : []).map((payload) => buildBiNormalizedEvent({
    tenantId,
    sourceKey,
    payload,
    onboarding,
    registryEntry,
  }));

  const normalizedIds = persistNormalized
    ? await persistBiNormalizedRows(
      db,
      tenantId,
      normalizedRows.map((row) => ({ ...row, ...normalizedExtra }))
    )
    : [];

  let runId = null;
  if (createRun) {
    const summary = summarizeBiRows(normalizedRows);
    runId = await createBiRun(db, tenantId, {
      runType,
      sourceKey,
      rowCount: normalizedRows.length,
      normalizedIds,
      summary: `${String(sourceKey || "source")} normalized ${normalizedRows.length} BI event(s).`,
      anomalies: summary.anomalies,
      signals: summary.signals,
      categories: summary.categories,
      ...runExtra,
    });
  }

  return { normalizedRows, normalizedIds, runId };
}

module.exports = {
  readBiMainDoc,
  persistBiNormalizedRows,
  summarizeBiRows,
  createBiRun,
  ingestBiSingleEvent,
  ingestBiBatchEvents,
};