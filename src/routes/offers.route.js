// services/api/src/routes/offers.route.js
const express = require('express');
const router = express.Router();
const { handleRespond } = require('../services/autopilot.service');

router.get('/respond', async (req, res) => {
  try {
    const { token, action } = req.query || {};
    const out = await handleRespond(token, action);
    res.json({ ok: true, data: out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'BAD_REQUEST' });
  }
});

module.exports = router;
