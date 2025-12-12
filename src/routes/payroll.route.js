// services/api/src/routes/payroll.route.js
const express = require('express');
const router = express.Router();
const { runAutoPayrollForToday } = require('../services/payrollAuto.service');

// Simple auth for cron calls (optional but recommended)
// Set PAYROLL_CRON_SECRET in your environment, then call:
//   GET /api/payroll/auto-run?secret=YOUR_SECRET
function assertCronSecret(req) {
  const configured = process.env.PAYROLL_CRON_SECRET;
  if (!configured) return; // no secret configured, allow all (Dev)
  const provided = req.query.secret || req.headers['x-cron-secret'];
  if (!provided || provided !== configured) {
    const err = new Error('unauthorized');
    err.statusCode = 401;
    throw err;
  }
}

// GET so you can hit it from Fly.io cron / UptimeRobot etc.
router.get('/auto-run', async (req, res) => {
  try {
    assertCronSecret(req);
    const dryRun = req.query.dry === '1' || req.query.dry === 'true';
    const result = await runAutoPayrollForToday({ dryRun });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Payroll auto-run failed', err);
    res
      .status(err.statusCode || 500)
      .json({ ok: false, error: err.message || 'Payroll auto-run failed' });
  }
});

module.exports = router;
