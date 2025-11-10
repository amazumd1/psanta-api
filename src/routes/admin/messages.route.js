// services/api/src/routes/admin/messages.route.js
const express = require('express');
const router = express.Router();

const { auth: requireAuth } = require('../../../middleware/auth');
const { requireRole } = require('../../../middleware/roles');
const Message = require('../../models/Message');

// 🔒 admin-only guard
router.use(requireAuth, requireRole(['admin']));

/**
 * GET /api/admin/messages
 * Query: state, reason, q, page=1, pageSize=20
 */
router.get('/', async (req, res) => {
  try {
    const { state, reason, q } = req.query || {};
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 20)));

    const filter = {};
    if (state) filter.triage_state = String(state);
    if (reason) filter.reason = String(reason);
    if (q && String(q).trim()) {
      const rx = new RegExp(String(q).trim(), 'i');
      filter.$or = [
        { messageId: rx },
        { jobId: rx },
        { details: rx },
        { planName: rx },
        { tags: rx },
      ];
    }

    const [rows, total] = await Promise.all([
      Message.find(filter).sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      Message.countDocuments(filter),
    ]);

    return res.json({ ok: true, data: rows, page, pageSize, total });
  } catch (e) {
    console.error('GET /api/admin/messages error', e);
    return res.status(500).json({ ok: false, error: 'server_error', data: [] });
  }
});

/**
 * GET /api/admin/messages/:messageId
 */
router.get('/:messageId', async (req, res) => {
  try {
    const row = await Message.findOne({ messageId: req.params.messageId }).lean();
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.json({ ok: true, data: row });
  } catch (e) {
    console.error('GET /api/admin/messages/:messageId error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * PATCH /api/admin/messages/:messageId
 * Body: { triage_state?, tags?[] }
 */
router.patch('/:messageId', async (req, res) => {
  try {
    const { triage_state, tags } = req.body || {};
    const update = {};
    if (triage_state) update.triage_state = String(triage_state);
    if (Array.isArray(tags)) update.tags = tags;

    const row = await Message.findOneAndUpdate(
      { messageId: req.params.messageId },
      { $set: update },
      { new: true }
    ).lean();

    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.json({ ok: true, data: row });
  } catch (e) {
    console.error('PATCH /api/admin/messages/:messageId error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
