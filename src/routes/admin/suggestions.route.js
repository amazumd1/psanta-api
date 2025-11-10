const express = require('express');
const Suggestion = require('../../models/Suggestion.js');
const axios = require('axios');

module.exports = function mountAdminSuggestions(app) {
  const r = express.Router();

  // LIST: GET /api/admin/suggestions?status=pending|applied|rejected (optional)
  r.get('/admin/suggestions', async (req, res) => {
    try {
      const { status, q } = req.query || {};
      const filter = {};
      if (status) filter.status = status;
      if (q) {
        filter.$or = [
          { orderId: { $regex: q, $options: 'i' } },
          { jobId:   { $regex: q, $options: 'i' } },
          { reason:  { $regex: q, $options: 'i' } },
        ];
      }
      const rows = await Suggestion.find(filter).sort({ createdAt: -1 }).lean();
      res.json({ ok: true, data: rows });
    } catch (e) {
      console.error('GET /admin/suggestions error', e);
      res.status(500).json({ ok:false, error:'server_error', data: [] });
    }
  });

  // APPLY: POST/PATCH /api/admin/suggestions/:id/apply

  async function applyHandler(req, res) {
  try {
    const { id } = req.params;
    // 1) mark applied
    const row = await Suggestion.findByIdAndUpdate(
      id,
      { $set: { status: 'applied', appliedAt: new Date() } },
      { new: true }
    ).lean();

    if (!row) return res.status(404).json({ ok:false, error:'not_found' });

    // 2) Prepare WH payload
    const base    = `${req.protocol}://${req.get('host')}`; // e.g. http://localhost:5000
    const orderId = row.orderId || row.jobId;
    let   items   = Array.isArray(row.items) ? row.items : [];

    // 🪙 Fallback: agar items khali ho to ek generic bump bhej do (so Learning/WH auto-calc kar sake)
    if (!items.length) {
      // Optional: yahan tum apni learning store se sku nikaal sakte ho (jobId/planName ke basis par)
      // फिलहाल generic +1 भेजते हैं ताकि WH/recalc अंदर से decide कर ले:
      items = [{ sku: 'AUTO', extraQty: 1 }];
    }

    const adjustments = items.map(it => ({
      sku: String(it.sku || 'AUTO'),
      deltaQty: Number(it.extraQty || 1)
    }));

    console.log('[APPLY] calling WH:', {
      url: `${base}/api/wh/orders/${orderId}/recalc-expected`,
      orderId, adjustments, suggestionId: row._id
    });

    try {
      const resp = await axios.post(
        `${base}/api/wh/orders/${encodeURIComponent(orderId)}/recalc-expected`,
        {
          source: 'admin_apply',
          reason: 'shortage_remedy',
          suggestionId: row._id,
          planName: row.planName,
          // Learning/WH ko hint:
          auto: !row.items?.length,   // true => WH may compute from history
          adjustments
        },
        { timeout: 10000 }
      );
      console.log('[APPLY] WH OK:', resp?.data);
    } catch (whErr) {
      // Detailed error log
      const data = whErr?.response?.data;
      console.error('[APPLY] WH FAIL:', data || whErr.message);
      // NOTE: हम 200 ही लौटाते हैं ताकि UI stuck न रहे—पर नीचे meta भेज देते हैं
      return res.json({ ok:true, data: row, whError: data || whErr.message });
    }

    return res.json({ ok:true, data: row });
  } catch (e) {
    console.error('APPLY /admin/suggestions/:id/apply', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
}

  r.patch('/admin/suggestions/:id/apply', applyHandler);
  r.post('/admin/suggestions/:id/apply',  applyHandler);

  app.use('/api', r);
};
