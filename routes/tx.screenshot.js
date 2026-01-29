// services/api/routes/tx.screenshot.js
const express = require("express");
const router = express.Router();

const { parsePaymentScreenshot } = require("../services/paymentScreenshotParse");

/**
 * POST /api/tx/parse-payment-screenshot
 * Body: { imageDataUrl: "data:image/png;base64,...", taxYearHint?: number }
 * Auth: Bearer token (handled by server mount)
 */
router.post("/parse-payment-screenshot", async (req, res) => {
  try {
    const { imageDataUrl, taxYearHint } = req.body || {};
    const parsed = await parsePaymentScreenshot({ imageDataUrl, taxYearHint });
    res.json({ ok: true, data: parsed });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({
      ok: false,
      error: e.message || String(e),
    });
  }
});

module.exports = router;
