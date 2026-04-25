const express = require("express");
const router = express.Router();
const { requireTenantAccess } = require("../middleware/tenantAccess");

// Apps Script config from .env
const GAS_URL = process.env.GAS_RECEIPTS_WEBAPP_URL;
const GAS_SECRET = process.env.GAS_RECEIPTS_SECRET;

const INTERNAL_RECEIPT_JOB_ROLES = new Set(["admin", "ops"]);

function requireInternalReceiptJobAccess(req, res, next) {
  const enabled = String(process.env.ENABLE_INTERNAL_RECEIPT_JOBS || "0") === "1";
  if (!enabled) {
    return res.status(403).json({
      ok: false,
      error: "Manual receipt jobs are disabled for retail users",
    });
  }

  const appRole = String(req.user?.role || "").trim().toLowerCase();
  if (!INTERNAL_RECEIPT_JOB_ROLES.has(appRole)) {
    return res.status(403).json({
      ok: false,
      error: "Manual receipt jobs are internal only",
    });
  }

  return next();
}

router.use(requireTenantAccess);
router.use(requireInternalReceiptJobAccess);

// Helper: build Apps Script URL with query params
function buildGasUrl(action, extra = {}) {
  if (!GAS_URL) return null;

  const url = new URL(GAS_URL);
  url.searchParams.set("action", action);

  if (GAS_SECRET) {
    url.searchParams.set("secret", GAS_SECRET);
  }

  Object.entries(extra).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

async function nodeFetch(url, options) {
  if (typeof fetch === "function") {
    return fetch(url, options);
  }

  const mod = await import("node-fetch");
  const fn = mod.default || mod;
  return fn(url, options);
}

router.get("/jobs", async (req, res) => {
  try {
    if (!GAS_URL) {
      console.warn("⚠️ GAS_RECEIPTS_WEBAPP_URL is not set. /api/receipts/jobs will fail.");
      return res.status(500).json({ ok: false, error: "GAS url not configured on server" });
    }

    const url = buildGasUrl("listJobs", {
      kind: "ops-app",
      tenantId: req.tenantId,
    });

    const gasRes = await nodeFetch(url);

    if (!gasRes.ok) {
      const bodyText = await gasRes.text().catch(() => "<no body>");
      console.error("❌ Apps Script listJobs returned non-200", gasRes.status, bodyText);
      return res.status(502).json({ ok: false, error: "Apps Script listJobs failed" });
    }

    const raw = await gasRes.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(500).json({
        ok: false,
        error:
          "Apps Script listJobs did not return JSON. Check deployment access and URL.",
      });
    }

    if (!data || data.ok === false) {
      return res.status(500).json({
        ok: false,
        error: (data && data.error) || "Invalid response from Apps Script (listJobs)",
      });
    }

    const jobs = data.jobs || (data.data && data.data.jobs) || [];
    return res.json({ ok: true, jobs });
  } catch (err) {
    console.error("❌ Error in GET /api/receipts/jobs", err);
    return res.status(500).json({
      ok: false,
      error: "Internal error while fetching receipt jobs",
    });
  }
});

router.post("/run", async (req, res) => {
  try {
    if (!GAS_URL) {
      console.warn("⚠️ GAS_RECEIPTS_WEBAPP_URL is not set. /api/receipts/run will fail.");
      return res.status(500).json({ ok: false, error: "GAS url not configured on server" });
    }

    const { jobId } = req.body || {};
    if (!jobId) {
      return res.status(400).json({ ok: false, error: "jobId is required" });
    }

    const url = buildGasUrl("runJob", {
      jobId,
      kind: "ops-app",
      tenantId: req.tenantId,
    });

    const gasRes = await nodeFetch(url);

    if (!gasRes.ok) {
      const bodyText = await gasRes.text().catch(() => "<no body>");
      console.error("❌ Apps Script runJob returned non-200", gasRes.status, bodyText);
      return res.status(502).json({ ok: false, error: "Apps Script runJob failed" });
    }

    const data = await gasRes.json().catch(() => null);

    if (!data || data.ok === false) {
      return res.status(500).json({
        ok: false,
        error: (data && data.error) || "Invalid response from Apps Script (runJob)",
      });
    }

    return res.json(data);
  } catch (err) {
    console.error("❌ Error in POST /api/receipts/run", err);
    return res.status(500).json({
      ok: false,
      error: "Internal error while running receipt job",
    });
  }
});

module.exports = router;