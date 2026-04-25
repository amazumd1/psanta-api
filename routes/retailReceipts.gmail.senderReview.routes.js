const express = require("express");
const {
  listRetailSenderSuggestionRows,
  buildRetailSenderReviewSummary,
  approveRetailSenderSuggestion,
  dismissRetailSenderSuggestion,
} = require("../services/retailSenderReviewService");

function createRetailSenderReviewRouter({
  retailTenantMemberMiddleware = [],
  retailTenantManagerMiddleware = [],
  getRetailTenantIdFromReq,
} = {}) {
  const router = express.Router();

  router.get("/", ...retailTenantMemberMiddleware, async (req, res) => {
    try {
      const retailOwnerId = getRetailTenantIdFromReq(req);
      const rows = await listRetailSenderSuggestionRows(retailOwnerId, {
        status: req.query?.status || "pending",
        limit: req.query?.limit || 20,
      });

      return res.json({ ok: true, retailOwnerId, rows, count: rows.length });
    } catch (err) {
      console.error("receipts/google/sender-suggestions list error", err);
      return res.status(err?.status || 500).json({
        ok: false,
        error: err?.message || "Failed to load sender suggestions",
      });
    }
  });

  router.get("/summary", ...retailTenantMemberMiddleware, async (req, res) => {
    try {
      const retailOwnerId = getRetailTenantIdFromReq(req);
      const summary = await buildRetailSenderReviewSummary(retailOwnerId, {
        status: req.query?.status || "pending",
        preview: req.query?.preview || 5,
        summaryLimit: req.query?.summaryLimit || 100,
      });

      return res.json({ ok: true, retailOwnerId, summary });
    } catch (err) {
      console.error("receipts/google/sender-suggestions summary error", err);
      return res.status(err?.status || 500).json({
        ok: false,
        error: err?.message || "Failed to load sender review summary",
      });
    }
  });

  router.post("/:suggestionId/approve", ...retailTenantManagerMiddleware, express.json({ limit: "256kb" }), async (req, res) => {
    try {
      const retailOwnerId = getRetailTenantIdFromReq(req);
      const result = await approveRetailSenderSuggestion(retailOwnerId, req.params?.suggestionId, {
        mode: req.body?.mode || "email",
        actorUid: req.user?.uid || req.auth?.uid || "",
        actorEmail: req.user?.email || req.auth?.email || "",
      });

      return res.json({
        ok: true,
        retailOwnerId,
        suggestionId: result.suggestionId,
        mode: result.mode,
        pattern: result.pattern,
        allowlist: result.allowlist,
      });
    } catch (err) {
      console.error("receipts/google/sender-suggestions approve error", err);
      return res.status(err?.status || 500).json({
        ok: false,
        error: err?.message || "Failed to approve sender suggestion",
      });
    }
  });

  router.post("/:suggestionId/dismiss", ...retailTenantManagerMiddleware, express.json({ limit: "256kb" }), async (req, res) => {
    try {
      const retailOwnerId = getRetailTenantIdFromReq(req);
      const result = await dismissRetailSenderSuggestion(retailOwnerId, req.params?.suggestionId, {
        reason: req.body?.reason || "",
      });

      return res.json({
        ok: true,
        retailOwnerId,
        suggestionId: result.suggestionId,
        status: result.status,
      });
    } catch (err) {
      console.error("receipts/google/sender-suggestions dismiss error", err);
      return res.status(err?.status || 500).json({
        ok: false,
        error: err?.message || "Failed to dismiss sender suggestion",
      });
    }
  });

  return router;
}

module.exports = {
  createRetailSenderReviewRouter,
};