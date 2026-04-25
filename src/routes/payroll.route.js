const crypto = require("crypto");
const express = require("express");
const router = express.Router();
const { runAutoPayrollForToday } = require("../services/payrollAuto.service");
const { makeRateLimiter } = require("../../middleware/rateLimit");

const cronLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: process.env.NODE_ENV === "production" ? 10 : 60,
  keyPrefix: "payroll_cron",
});

function safeCompare(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function assertCronSecret(req) {
  const configured = String(process.env.PAYROLL_CRON_SECRET || "").trim();

  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      const err = new Error("PAYROLL_CRON_SECRET is not configured");
      err.statusCode = 500;
      throw err;
    }
    return;
  }

  const provided = String(
    req.headers["x-cron-secret"] || req.query.secret || ""
  ).trim();

  if (!provided || !safeCompare(provided, configured)) {
    const err = new Error("unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

router.get("/auto-run", cronLimiter, async (req, res) => {
  try {
    assertCronSecret(req);

    const dryValue = String(req.query.dry || "0").toLowerCase();
    const dryRun = dryValue === "1" || dryValue === "true";

    const result = await runAutoPayrollForToday({ dryRun });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Payroll auto-run failed", err);
    return res
      .status(err.statusCode || 500)
      .json({ ok: false, error: err.message || "Payroll auto-run failed" });
  }
});

module.exports = router;