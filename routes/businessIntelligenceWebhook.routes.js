const express = require("express");

const { getFirestore } = require("../lib/firebaseAdminApp");
const { normString } = require("../middleware/tenantAccess");
const { readBiMainDoc, ingestBiSingleEvent } = require("../services/businessIntelligence/biIngestionService");

const router = express.Router();

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

router.post("/:tenantId/:sourceKey", async (req, res) => {
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

module.exports = router;