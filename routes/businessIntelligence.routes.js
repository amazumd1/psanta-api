const express = require("express");
const fetch = require("node-fetch");

const { getFirestore, serverTimestamp } = require("../lib/firebaseAdminApp");
const { tenantCollection } = require("../lib/tenantFirestore");
const { requireTenantRole, normString } = require("../middleware/tenantAccess");
const { parsePaymentScreenshot } = require("../services/paymentScreenshotParse");
const { buildRetailSenderReviewSummary } = require("../services/retailSenderReviewService");
const {
  getCanonicalBiCategories,
  getReceiptReviewBiCategories,
} = require("../services/businessIntelligence/biCategories");
const {
  cleanUndefined,
  pickTrustedNumericValue,
  normalizeObservedAt,
  BI_EVENT_MODEL_VERSION,
} = require("../services/businessIntelligence/biEventModel");
const {
  readBiMainDoc,
  createBiRun,
  ingestBiSingleEvent,
  ingestBiBatchEvents,
} = require("../services/businessIntelligence/biIngestionService");
const {
  readBiCategoryMemory,
  learnBiCategoryMemory,
} = require("../services/businessIntelligence/biCategoryMemoryService");
const { buildFinanceRollups } = require("../services/businessIntelligence/biFinanceRollupService");
const { categorizeBusinessSignal } = require("../services/businessIntelligence/biUnifiedCategorization");

const {
  buildSourceAgnosticDashboard,
  listBiAlerts,
  listBiNotifications,
  acknowledgeBiNotification,
  readBiSchedulerSettings,
  saveBiSchedulerSettings,
  resolveBiReviewQueueItem,
  syncBiAlertsAndNotifications,
  buildReviewQueueRows,
  listLatestNormalizedEvents,
} = require("../services/businessIntelligence/biProductizationService");
const {
  buildPropertyOpsMetrics,
  buildBiRecommendations,
  buildBiCeoBridge,
  runBiLlmAnalysis,
} = require("../services/businessIntelligence/biExpansionService");

const router = express.Router();

function clampInt(value, fallback = 8, min = 1, max = 100) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function parseObjectLike(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseCsv(text = "") {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const input = String(text || "");

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      if (row.some((item) => String(item).trim() !== "")) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell || row.length) {
    row.push(cell);
    if (row.some((item) => String(item).trim() !== "")) rows.push(row);
  }

  if (!rows.length) return [];
  const headers = rows[0].map((item) => String(item || "").trim());
  return rows.slice(1).map((cols) => {
    const out = {};
    headers.forEach((header, idx) => {
      out[header || `col_${idx + 1}`] = cols[idx] == null ? "" : String(cols[idx]);
    });
    return out;
  });
}

function normalizeGoogleSheetCsvUrl(sheetUrl = "", gid = "") {
  const raw = String(sheetUrl || "").trim();
  if (!raw) return "";
  const idMatch = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!idMatch) return raw;
  let resolvedGid = String(gid || "").trim();
  if (!resolvedGid) {
    const gidMatch = raw.match(/[?#&]gid=([0-9]+)/);
    resolvedGid = gidMatch ? gidMatch[1] : "0";
  }
  return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv&gid=${resolvedGid || "0"}`;
}

async function loadGoogleSheetRows({ sheetUrl = "", gid = "", sampleRowsText = "" } = {}) {
  const sampleText = String(sampleRowsText || "").trim();
  if (sampleText) {
    try {
      const parsed = JSON.parse(sampleText);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return parseCsv(sampleText);
    }
  }

  const csvUrl = normalizeGoogleSheetCsvUrl(sheetUrl, gid);
  if (!csvUrl) return [];
  const response = await fetch(csvUrl, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Google Sheets fetch failed with HTTP ${response.status}`);
  }
  const csv = await response.text();
  return parseCsv(csv);
}

function mapRowByColumnMap(row = {}, columnMap = {}) {
  const mapping = parseObjectLike(columnMap);
  if (!Object.keys(mapping).length) return row;
  const mapped = {};
  Object.entries(mapping).forEach(([targetKey, sourceKey]) => {
    mapped[targetKey] = row?.[sourceKey] ?? "";
  });
  return mapped;
}

async function validateWebhookAccess(db, tenantId, sourceKey, req) {
  const mainDoc = await readBiMainDoc(db, tenantId);
  const registryEntry = mainDoc?.sourceRegistry?.[sourceKey] || {};
  const configuredKey = String(registryEntry.webhookKey || "").trim();
  const suppliedKey = String(req.headers["x-bi-webhook-key"] || req.query?.key || req.body?.webhookKey || "").trim();

  if (!configuredKey) {
    throw Object.assign(new Error(`No webhook key is configured for ${sourceKey}.`), { status: 400 });
  }
  if (!suppliedKey || suppliedKey !== configuredKey) {
    throw Object.assign(new Error("Webhook key is invalid for this BI source."), { status: 403 });
  }

  return { mainDoc, registryEntry };
}

router.get("/meta", async (_req, res) => {
  return res.json({
    ok: true,
    eventModelVersion: BI_EVENT_MODEL_VERSION,
    categories: getCanonicalBiCategories(),
    receiptReviewCategories: getReceiptReviewBiCategories(),
  });
});

router.get('/category-memory', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const memory = await readBiCategoryMemory(db, req.tenantId);
    return res.json({ ok: true, memory });
  } catch (err) {
    console.error('GET /api/business-intelligence/category-memory failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not load BI category memory.' });
  }
});

router.post('/category-memory/learn', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const body = req.body || {};
    const memory = await learnBiCategoryMemory(db, req.tenantId, {
      senderEmail: body.senderEmail,
      senderDomain: body.senderDomain,
      keywordHints: body.keywordHints,
      category: body.category,
      note: body.note,
      confidence: body.confidence,
      source: body.source,
      actorUid: req.userId || null,
      actorEmail: req.userDoc?.email || null,
    });

    return res.json({ ok: true, memory });
  } catch (err) {
    console.error('POST /api/business-intelligence/category-memory/learn failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not learn BI category memory.' });
  }
});

router.post('/categorize', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const body = req.body || {};
    const memory = await readBiCategoryMemory(db, req.tenantId);
    const result = categorizeBusinessSignal({
      currentCategory: body.currentCategory,
      explicitCategory: body.explicitCategory,
      senderEmail: body.senderEmail,
      senderDomain: body.senderDomain,
      text: body.text,
      amount: body.amount,
      memory,
    });
    return res.json({ ok: true, result });
  } catch (err) {
    console.error('POST /api/business-intelligence/categorize failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not categorize the BI payload.' });
  }
});

router.get('/finance-rollups', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const rollups = await buildFinanceRollups(db, req.tenantId, {
      rangeKey: req.query?.rangeKey || '30d',
      year: req.query?.year || '',
      limit: req.query?.limit || 500,
    });
    return res.json({ ok: true, rollups });
  } catch (err) {
    console.error('GET /api/business-intelligence/finance-rollups failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not load BI finance rollups.' });
  }
});

router.get('/dashboard', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const dashboard = await buildSourceAgnosticDashboard(db, req.tenantId, {
      rangeKey: req.query?.rangeKey || '30d',
      year: req.query?.year || '',
      limit: req.query?.limit || 500,
    });
    return res.json({ ok: true, dashboard });
  } catch (err) {
    console.error('GET /api/business-intelligence/dashboard failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not load BI dashboard.' });
  }
});

router.get('/sender-review-summary', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const summary = await buildRetailSenderReviewSummary(req.tenantId, {
      status: req.query?.status || 'pending',
      preview: req.query?.preview || 5,
      summaryLimit: req.query?.summaryLimit || 100,
    });
    return res.json({ ok: true, summary });
  } catch (err) {
    console.error('GET /api/business-intelligence/sender-review-summary failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not load BI sender review summary.' });
  }
});

router.get('/property-ops', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const metrics = await buildPropertyOpsMetrics(db, req.tenantId, {
      rangeKey: req.query?.rangeKey || '30d',
      year: req.query?.year || '',
      propertyId: req.query?.propertyId || '',
      limit: req.query?.limit || 500,
    });
    return res.json({ ok: true, metrics });
  } catch (err) {
    console.error('GET /api/business-intelligence/property-ops failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not load property and ops metrics.' });
  }
});

router.get('/recommendations', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const payload = await buildBiRecommendations(db, req.tenantId, {
      rangeKey: req.query?.rangeKey || '30d',
      year: req.query?.year || '',
      propertyId: req.query?.propertyId || '',
      limit: req.query?.limit || 500,
    });
    return res.json({ ok: true, ...payload });
  } catch (err) {
    console.error('GET /api/business-intelligence/recommendations failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not load BI recommendations.' });
  }
});

router.get('/ceo-bridge', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const payload = await buildBiCeoBridge(db, req.tenantId, {
      rangeKey: req.query?.rangeKey || '30d',
      year: req.query?.year || '',
      propertyId: req.query?.propertyId || '',
      limit: req.query?.limit || 500,
    });
    return res.json({ ok: true, ...payload });
  } catch (err) {
    console.error('GET /api/business-intelligence/ceo-bridge failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not load BI CEO bridge data.' });
  }
});

router.post('/llm/analyze', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const payload = await runBiLlmAnalysis(db, req.tenantId, {
      question: req.body?.question || '',
      rangeKey: req.body?.rangeKey || '30d',
      year: req.body?.year || '',
      propertyId: req.body?.propertyId || '',
      limit: req.body?.limit || 500,
    });
    return res.json({ ok: true, analysis: payload });
  } catch (err) {
    console.error('POST /api/business-intelligence/llm/analyze failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not run BI LLM analysis.' });
  }
});

router.get('/review-queue', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const rows = await listLatestNormalizedEvents(db, req.tenantId, { limit: req.query?.limit || 50 });
    return res.json({ ok: true, rows: buildReviewQueueRows(rows) });
  } catch (err) {
    console.error('GET /api/business-intelligence/review-queue failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not load BI review queue.' });
  }
});

router.post('/review-queue/:itemId/resolve', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const row = await resolveBiReviewQueueItem(db, req.tenantId, req.params?.itemId, req.body || {});
    return res.json({ ok: true, row });
  } catch (err) {
    console.error('POST /api/business-intelligence/review-queue/:itemId/resolve failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not resolve BI review queue item.' });
  }
});

router.get('/alerts', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const rows = await listBiAlerts(db, req.tenantId, { limit: req.query?.limit || 20 });
    return res.json({ ok: true, rows });
  } catch (err) {
    console.error('GET /api/business-intelligence/alerts failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not load BI alerts.' });
  }
});

router.post('/alerts/sync', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const payload = await syncBiAlertsAndNotifications(db, req.tenantId, {
      rangeKey: req.body?.rangeKey || '30d',
      year: req.body?.year || '',
      limit: req.body?.limit || 500,
    });
    return res.json({ ok: true, ...payload });
  } catch (err) {
    console.error('POST /api/business-intelligence/alerts/sync failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not sync BI alerts.' });
  }
});

router.get('/notifications', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const rows = await listBiNotifications(db, req.tenantId, { limit: req.query?.limit || 20 });
    return res.json({ ok: true, rows });
  } catch (err) {
    console.error('GET /api/business-intelligence/notifications failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not load BI notifications.' });
  }
});

router.post('/notifications/:notificationId/ack', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const row = await acknowledgeBiNotification(db, req.tenantId, req.params?.notificationId, { read: req.body?.read !== false });
    return res.json({ ok: true, row });
  } catch (err) {
    console.error('POST /api/business-intelligence/notifications/:notificationId/ack failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not acknowledge BI notification.' });
  }
});

router.get('/scheduler', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const scheduler = await readBiSchedulerSettings(db, req.tenantId);
    return res.json({ ok: true, scheduler });
  } catch (err) {
    console.error('GET /api/business-intelligence/scheduler failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not load BI scheduler settings.' });
  }
});

router.post('/scheduler', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const db = getFirestore();
    const scheduler = await saveBiSchedulerSettings(db, req.tenantId, req.body || {});
    return res.json({ ok: true, scheduler });
  } catch (err) {
    console.error('POST /api/business-intelligence/scheduler failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not save BI scheduler settings.' });
  }
});

router.post('/import-hub/run', requireTenantRole(['owner', 'admin', 'ops', 'accountant']), async (req, res) => {
  try {
    const body = req.body || {};
    const sourceKey = normString(body.sourceKey || 'manual') || 'manual';
    const db = getFirestore();
    const mainDoc = await readBiMainDoc(db, req.tenantId);
    const onboarding = mainDoc?.onboarding || {};
    const registryEntry = { ...(mainDoc?.sourceRegistry?.[sourceKey] || {}), ...(body.registryOverride || {}) };
    const sourceConfig = mainDoc?.sourceConfig?.[sourceKey] || {};

    if (sourceConfig.enabled === false) {
      return res.status(400).json({ ok: false, error: `The ${sourceKey} source is currently paused in BI settings.` });
    }

    if (sourceKey === 'sheets') {
      const rows = await loadGoogleSheetRows({
        sheetUrl: body.sheetUrl || registryEntry.sourceLocator,
        gid: body.gid,
        sampleRowsText: body.sampleRowsText,
      });
      const limit = clampInt(body.rowLimit, 12, 1, 50);
      const limitedRows = rows.slice(0, limit);
      const mappedRows = limitedRows.map((row) => mapRowByColumnMap(row, body.columnMap || registryEntry.columnMap));
      const result = await ingestBiBatchEvents({
        db,
        tenantId: req.tenantId,
        sourceKey,
        rows: mappedRows,
        onboarding,
        registryEntry: { ...registryEntry, columnMap: body.columnMap || registryEntry.columnMap },
        persistNormalized: body.persistNormalized !== false,
        normalizedExtra: { runKind: 'import-hub' },
        createRun: true,
        runType: 'import-hub-sheets',
      });
      return res.json({ ok: true, sourceKey, result, mappedRowsPreview: mappedRows.slice(0, 5) });
    }

    if (sourceKey === 'upload') {
      let visionResult = null;
      if (body.imageDataUrl) {
        try {
          visionResult = await parsePaymentScreenshot({ imageDataUrl: body.imageDataUrl, taxYearHint: body.taxYearHint });
        } catch (err) {
          visionResult = { _visionError: err.message || String(err) };
        }
      }
      const result = await ingestBiSingleEvent({
        db,
        tenantId: req.tenantId,
        sourceKey,
        payload: cleanUndefined({ fileName: body.fileName, notes: body.notes, imageText: body.imageText, vision: visionResult }),
        onboarding,
        registryEntry,
        persistNormalized: body.persistNormalized !== false,
        normalizedExtra: { runKind: 'import-hub' },
        createRun: true,
        runType: 'import-hub-upload',
      });
      return res.json({ ok: true, sourceKey, result, visionResult });
    }

    if (sourceKey === 'manual') {
      const result = await ingestBiSingleEvent({
        db,
        tenantId: req.tenantId,
        sourceKey,
        payload: body.payload || body,
        onboarding,
        registryEntry,
        manualEntry: {
          title: body.title,
          body: body.body || body.notes,
          metricName: body.metricName,
          metricValue: body.metricValue,
          metricUnit: body.metricUnit,
          observedAt: body.observedAt,
          category: body.category,
        },
        persistNormalized: body.persistNormalized !== false,
        normalizedExtra: { runKind: 'import-hub' },
        createRun: true,
        runType: 'import-hub-manual',
      });
      return res.json({ ok: true, sourceKey, result });
    }

    const result = await ingestBiSingleEvent({
      db,
      tenantId: req.tenantId,
      sourceKey,
      payload: body.payload || body.samplePayload || registryEntry,
      onboarding,
      registryEntry,
      persistNormalized: body.persistNormalized !== false,
      normalizedExtra: { runKind: 'import-hub' },
      createRun: true,
      runType: `import-hub-${sourceKey}`,
    });
    return res.json({ ok: true, sourceKey, result });
  } catch (err) {
    console.error('POST /api/business-intelligence/import-hub/run failed:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not run the BI import hub.' });
  }
});

router.post("/webhook/:tenantId/:sourceKey", async (req, res) => {
  try {
    const tenantId = normString(req.params?.tenantId || "");
    const sourceKey = normString(req.params?.sourceKey || "api") || "api";
    if (!tenantId) return res.status(400).json({ ok: false, error: "tenantId is required in the webhook path." });

    const db = getFirestore();
    const { mainDoc, registryEntry } = await validateWebhookAccess(db, tenantId, sourceKey, req);
    const sourceConfig = mainDoc?.sourceConfig?.[sourceKey] || {};
    if (sourceConfig.enabled === false) {
      return res.status(400).json({ ok: false, error: `The ${sourceKey} source is currently paused in BI settings.` });
    }

    const result = await ingestBiSingleEvent({
      db,
      tenantId,
      sourceKey,
      payload: req.body,
      onboarding: mainDoc?.onboarding || {},
      registryEntry,
      persistNormalized: true,
      normalizedExtra: { runKind: "webhook" },
      createRun: true,
      runType: "webhook",
    });

    return res.json({
      ok: true,
      runId: result.runId,
      normalizedId: result.normalizedId,
      normalized: result.normalized,
    });
  } catch (err) {
    console.error("POST /api/business-intelligence/webhook/:tenantId/:sourceKey failed:", err);
    return res.status(err.status || 500).json({ ok: false, error: err.message || "Could not ingest BI webhook payload." });
  }
});

router.use(requireTenantRole(["owner", "admin", "ops", "accountant"]));

router.get("/manual-entries", async (req, res) => {
  try {
    const db = getFirestore();
    const limit = clampInt(req.query.limit, 8, 1, 50);
    const snap = await tenantCollection(db, req.tenantId, "businessIntelligenceManualEntries")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const rows = snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
    return res.json({ ok: true, rows });
  } catch (err) {
    console.error("GET /api/business-intelligence/manual-entries failed:", err);
    return res.status(500).json({ ok: false, error: err.message || "Could not load manual BI entries." });
  }
});

router.get("/runs", async (req, res) => {
  try {
    const db = getFirestore();
    const limit = clampInt(req.query.limit, 8, 1, 50);
    const snap = await tenantCollection(db, req.tenantId, "businessIntelligenceRuns")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const rows = snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
    return res.json({ ok: true, rows });
  } catch (err) {
    console.error("GET /api/business-intelligence/runs failed:", err);
    return res.status(500).json({ ok: false, error: err.message || "Could not load BI registry runs." });
  }
});

router.post("/normalize", async (req, res) => {
  try {
    const db = getFirestore();
    const mainDoc = await readBiMainDoc(db, req.tenantId);
    const sourceKey = normString(req.body?.sourceKey || "manual") || "manual";
    const registryEntry = req.body?.registryOverride || mainDoc?.sourceRegistry?.[sourceKey] || {};

    const result = await ingestBiSingleEvent({
      db,
      tenantId: req.tenantId,
      sourceKey,
      payload: req.body?.payload,
      onboarding: mainDoc?.onboarding || {},
      registryEntry,
      persistNormalized: req.body?.persist === true,
      normalizedExtra: { runKind: "normalize-preview" },
    });

    return res.json({ ok: true, normalizedId: result.normalizedId, normalized: result.normalized });
  } catch (err) {
    console.error("POST /api/business-intelligence/normalize failed:", err);
    return res.status(500).json({ ok: false, error: err.message || "Could not normalize BI payload." });
  }
});

router.post("/image/normalize", async (req, res) => {
  try {
    const db = getFirestore();
    const mainDoc = await readBiMainDoc(db, req.tenantId);
    const sourceKey = normString(req.body?.sourceKey || "upload") || "upload";
    const registryEntry = mainDoc?.sourceRegistry?.[sourceKey] || {};

    let visionResult = null;
    if (req.body?.imageDataUrl) {
      try {
        visionResult = await parsePaymentScreenshot({
          imageDataUrl: req.body.imageDataUrl,
          taxYearHint: req.body.taxYearHint,
        });
      } catch (err) {
        visionResult = { _visionError: err.message || String(err) };
      }
    }

    const payload = cleanUndefined({
      fileName: req.body?.fileName,
      notes: req.body?.notes,
      imageText: req.body?.imageText,
      vision: visionResult,
    });

    const result = await ingestBiSingleEvent({
      db,
      tenantId: req.tenantId,
      sourceKey,
      payload,
      onboarding: mainDoc?.onboarding || {},
      registryEntry,
      persistNormalized: req.body?.persist === true,
      normalizedExtra: { runKind: "image-normalization" },
      createRun: req.body?.persist === true,
      runType: "image-normalization",
    });

    return res.json({ ok: true, normalizedId: result.normalizedId, normalized: result.normalized, visionResult });
  } catch (err) {
    console.error("POST /api/business-intelligence/image/normalize failed:", err);
    return res.status(500).json({ ok: false, error: err.message || "Could not normalize BI image payload." });
  }
});

router.post("/google-sheets/preview", async (req, res) => {
  try {
    const db = getFirestore();
    const mainDoc = await readBiMainDoc(db, req.tenantId);
    const sourceKey = "sheets";
    const registryEntry = { ...(mainDoc?.sourceRegistry?.[sourceKey] || {}), ...(req.body?.registryOverride || {}) };
    const onboarding = mainDoc?.onboarding || {};

    const rows = await loadGoogleSheetRows({
      sheetUrl: req.body?.sheetUrl || registryEntry.sourceLocator,
      gid: req.body?.gid,
      sampleRowsText: req.body?.sampleRowsText,
    });
    const limit = clampInt(req.body?.rowLimit, 12, 1, 50);
    const limitedRows = rows.slice(0, limit);
    const mappedRows = limitedRows.map((row) => mapRowByColumnMap(row, req.body?.columnMap || registryEntry.columnMap));

    const result = await ingestBiBatchEvents({
      db,
      tenantId: req.tenantId,
      sourceKey,
      rows: mappedRows,
      onboarding,
      registryEntry: { ...registryEntry, columnMap: req.body?.columnMap || registryEntry.columnMap },
      persistNormalized: false,
    });

    return res.json({
      ok: true,
      rowCount: mappedRows.length,
      mappedRowsPreview: mappedRows.slice(0, 5),
      normalizedPreview: result.normalizedRows.slice(0, 5),
    });
  } catch (err) {
    console.error("POST /api/business-intelligence/google-sheets/preview failed:", err);
    return res.status(500).json({ ok: false, error: err.message || "Could not preview the Google Sheets mapper." });
  }
});

router.post("/google-sheets/run", async (req, res) => {
  try {
    const db = getFirestore();
    const mainDoc = await readBiMainDoc(db, req.tenantId);
    const sourceKey = "sheets";
    const sourceConfig = mainDoc?.sourceConfig?.[sourceKey] || {};
    if (sourceConfig.enabled === false) {
      return res.status(400).json({ ok: false, error: "The sheets source is currently paused in BI settings." });
    }

    const registryEntry = { ...(mainDoc?.sourceRegistry?.[sourceKey] || {}), ...(req.body?.registryOverride || {}) };
    const onboarding = mainDoc?.onboarding || {};
    const rows = await loadGoogleSheetRows({
      sheetUrl: req.body?.sheetUrl || registryEntry.sourceLocator,
      gid: req.body?.gid,
      sampleRowsText: req.body?.sampleRowsText,
    });
    const limit = clampInt(req.body?.rowLimit, 12, 1, 50);
    const limitedRows = rows.slice(0, limit);
    const mappedRows = limitedRows.map((row) => mapRowByColumnMap(row, req.body?.columnMap || registryEntry.columnMap));

    const result = await ingestBiBatchEvents({
      db,
      tenantId: req.tenantId,
      sourceKey,
      rows: mappedRows,
      onboarding,
      registryEntry: { ...registryEntry, columnMap: req.body?.columnMap || registryEntry.columnMap },
      persistNormalized: req.body?.persistNormalized !== false,
      normalizedExtra: { runKind: "google-sheets" },
      createRun: true,
      runType: "google-sheets",
      runExtra: {
        sourceConfig: cleanUndefined({ enabled: sourceConfig.enabled !== false, cadence: sourceConfig.cadence || "manual" }),
        registrySnapshot: cleanUndefined({ ...registryEntry, columnMap: req.body?.columnMap || registryEntry.columnMap }),
      },
    });

    return res.json({
      ok: true,
      runId: result.runId,
      rowCount: result.normalizedRows.length,
      persistedCount: result.normalizedIds.length,
      mappedRowsPreview: mappedRows.slice(0, 5),
      normalizedPreview: result.normalizedRows.slice(0, 5),
      normalizedIds: result.normalizedIds,
    });
  } catch (err) {
    console.error("POST /api/business-intelligence/google-sheets/run failed:", err);
    return res.status(500).json({ ok: false, error: err.message || "Could not run the Google Sheets mapper." });
  }
});

router.post("/manual-entry", async (req, res) => {
  try {
    const db = getFirestore();
    const mainDoc = await readBiMainDoc(db, req.tenantId);
    const onboarding = mainDoc?.onboarding || {};
    const sourceKey = "manual";
    const registryEntry = mainDoc?.sourceRegistry?.[sourceKey] || {};
    const body = req.body || {};

    const manualMetricValue = pickTrustedNumericValue(body.metricValue);
    const manualAmount = pickTrustedNumericValue(body.amount, body.total, body.metricValue);

    const entry = cleanUndefined({
      sourceKey,
      title: normString(body.title || "") || "Manual BI entry",
      body: normString(body.body || body.notes || ""),
      observedAt: normalizeObservedAt(body.observedAt),
      metricName: normString(body.metricName || ""),
      metricValue: manualMetricValue,
      amount: manualAmount,
      metricUnit: normString(body.metricUnit || ""),
      tags: Array.isArray(body.tags)
        ? body.tags.map((item) => normString(item)).filter(Boolean)
        : String(body.tags || "").split(",").map((item) => normString(item)).filter(Boolean),
      actorUserId: req.userId || null,
      actorEmail: req.userDoc?.email || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const entryRef = await tenantCollection(db, req.tenantId, "businessIntelligenceManualEntries").add({
      ...entry,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const result = await ingestBiSingleEvent({
      db,
      tenantId: req.tenantId,
      sourceKey,
      payload: {
        title: entry.title,
        body: entry.body,
        observedAt: entry.observedAt,
        metricValue: entry.metricValue,
        amount: entry.amount,
        metricName: body.metricName,
        metricUnit: body.metricUnit,
        tags: entry.tags,
      },
      onboarding,
      registryEntry,
      manualEntry: {
        title: entry.title,
        body: entry.body,
        metricName: body.metricName,
        metricValue: entry.metricValue,
        amount: entry.amount,
        metricUnit: body.metricUnit,
        observedAt: entry.observedAt,
        category: body.category,
      },
      persistNormalized: body.persistNormalized !== false,
      normalizedExtra: { sourceEntryId: entryRef.id, runKind: "manual-entry" },
      createRun: true,
      runType: "manual-entry",
      runExtra: { entryId: entryRef.id },
    });

    return res.json({
      ok: true,
      id: entryRef.id,
      entry: { id: entryRef.id, ...entry },
      normalizedId: result.normalizedId,
      normalized: result.normalized,
      runId: result.runId,
    });
  } catch (err) {
    console.error("POST /api/business-intelligence/manual-entry failed:", err);
    return res.status(500).json({ ok: false, error: err.message || "Could not create manual BI entry." });
  }
});

router.post("/source-registry/run", async (req, res) => {
  try {
    const db = getFirestore();
    const mainDoc = await readBiMainDoc(db, req.tenantId);
    const onboarding = mainDoc?.onboarding || {};
    const sourceKey = normString(req.body?.sourceKey || "") || "manual";
    const sourceConfig = mainDoc?.sourceConfig?.[sourceKey] || {};
    const registryEntry = mainDoc?.sourceRegistry?.[sourceKey] || {};

    if (sourceConfig.enabled === false) {
      return res.status(400).json({ ok: false, error: `The ${sourceKey} source is currently paused in BI settings.` });
    }

    const result = await ingestBiSingleEvent({
      db,
      tenantId: req.tenantId,
      sourceKey,
      payload: req.body?.samplePayload || registryEntry,
      onboarding,
      registryEntry,
      persistNormalized: req.body?.persistNormalized !== false,
      normalizedExtra: { runKind: "source-registry" },
      createRun: true,
      runType: "source-registry",
      runExtra: {
        sourceConfig: cleanUndefined({ enabled: sourceConfig.enabled !== false, cadence: sourceConfig.cadence || "on_demand" }),
        registrySnapshot: cleanUndefined(registryEntry),
        payloadPreview: String(req.body?.samplePayload || "").slice(0, 4000),
      },
    });

    return res.json({ ok: true, runId: result.runId, normalizedId: result.normalizedId, normalized: result.normalized, registry: registryEntry });
  } catch (err) {
    console.error("POST /api/business-intelligence/source-registry/run failed:", err);
    return res.status(500).json({ ok: false, error: err.message || "Could not run BI source registry." });
  }
});

module.exports = router;