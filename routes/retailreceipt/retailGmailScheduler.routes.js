const express = require("express");

function createRetailGmailSchedulerRouter({
  firebaseAuth,
  requireOpsAdmin,
  getRetailReceiptSchedulerStatus,
  runRetailReceiptSchedulerPass,
  handleRetailSchedulerHttp,
  normalizeIntInRange,
  DEFAULT_AUTO_SCHEDULER_LIMIT,
}) {
  const router = express.Router();

  router.get("/admin/scheduler/status", firebaseAuth, requireOpsAdmin, async (req, res) => {
    try {
      return res.json({ ok: true, scheduler: getRetailReceiptSchedulerStatus() });
    } catch (err) {
      console.error("receipts/google/admin/scheduler/status error", err);
      return res.status(500).json({ ok: false, error: err.message || "Failed to load scheduler status" });
    }
  });

  router.post("/admin/scheduler/run", firebaseAuth, requireOpsAdmin, async (req, res) => {
    try {
      const result = await runRetailReceiptSchedulerPass({
        mode: String(req.body?.mode || "all").trim() || "all",
        limit: normalizeIntInRange(req.body?.limit, DEFAULT_AUTO_SCHEDULER_LIMIT, 1, 100),
        retailOwnerId: String(req.body?.retailOwnerId || "").trim(),
        dry: !!req.body?.dry,
        force: !!req.body?.force,
        source: "admin_http",
      });

      return res.json({ ok: true, ...result, scheduler: getRetailReceiptSchedulerStatus() });
    } catch (err) {
      console.error("receipts/google/admin/scheduler/run error", err);
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message || "Scheduler run failed" });
    }
  });

  router.get("/cron/scheduler", async (req, res) => {
    return handleRetailSchedulerHttp(req, res, { mode: "all", source: "cron_http_get" });
  });

  router.post("/cron/scheduler", async (req, res) => {
    return handleRetailSchedulerHttp(req, res, { mode: "all", source: "cron_http_post" });
  });

  router.get("/cron/scheduler/recent", async (req, res) => {
    return handleRetailSchedulerHttp(req, res, { mode: "recent", source: "cron_http_recent" });
  });

  router.get("/cron/scheduler/backfill", async (req, res) => {
    return handleRetailSchedulerHttp(req, res, { mode: "backfill", source: "cron_http_backfill" });
  });

  return router;
}

module.exports = { createRetailGmailSchedulerRouter };