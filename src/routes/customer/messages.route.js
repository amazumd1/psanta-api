// services/api/src/routes/customer/messages.route.js
const express = require('express');
const { randomUUID } = require('crypto');
const uuidv4 = () => randomUUID();
const { auth: requireAuth } = require('../../../middleware/auth');
const Message = require('../../models/Message');

// (optional) learning/suggestion hook — safe-guarded
let createSuggestionFromMessage = null;
try {
  ({ createSuggestionFromMessage } = require('../../services/suggestions.service'));
} catch (_) {}

const router = express.Router();

// 🔒 protect all customer message routes
router.use(requireAuth);

/**
 * POST /api/customer/messages
 * Body: { orderId, text, reason='other', planName?, tags?[] }
 */
router.post('/', async (req, res) => {
  try {
    const { orderId, text, reason = 'other', planName, tags = [] } = req.body || {};
    if (!orderId || !text) {
      return res.status(400).json({ ok: false, error: 'orderId_and_text_required' });
    }

    const doc = await Message.create({
      messageId: uuidv4(),
      jobId: String(orderId),
      details: String(text),
      reason,
      tags: Array.isArray(tags) ? tags : [],
      from: 'customer',
      planName: planName || undefined,
    });

    // fire-and-forget learning hook (optional)
    try {
      if (typeof createSuggestionFromMessage === 'function') {
        createSuggestionFromMessage({ orderId, text, reason, tags, planName }).catch(() => {});
      }
    } catch (_) {}

    return res.json({ ok: true, data: doc });
  } catch (e) {
    console.error('POST /api/customer/messages error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * GET /api/customer/messages
 * Returns latest customer-originated messages
 */
router.get('/', async (_req, res) => {
  try {
    const rows = await Message.find({ from: 'customer' }).sort({ createdAt: -1 }).lean();
    return res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('GET /api/customer/messages error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
