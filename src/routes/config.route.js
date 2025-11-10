const express = require('express');
const router = express.Router();
const Config = require('../models/Config'); // adjust relative path if needed

// GET current defaults
router.get('/ai-defaults', async (req, res, next) => {
  try {
    const cfg = await Config.findOne({ key: 'ai-defaults' }).lean();
    res.json({ ok: true, data: cfg?.value || {} });
  } catch (e) { next(e); }
});

// PUT update defaults
router.put('/ai-defaults', async (req, res, next) => {
  try {
    const val = req.body || {};
    const cfg = await Config.findOneAndUpdate(
      { key: 'ai-defaults' },
      { $set: { value: val } },
      { new: true, upsert: true }
    );
    res.json({ ok: true, data: cfg.value });
  } catch (e) { next(e); }
});

module.exports = router;
