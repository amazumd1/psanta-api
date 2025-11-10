const express = require('express');
const router = express.Router();
const Alert = require('../models/Alert');
const { dismiss } = require('../services/alerts.service');

// 🔎 GET /api/alerts?status=open&customerId=&skuId=
router.get('/', async (req, res, next) => {
  try {
    const { status = 'open', customerId, skuId } = req.query || {};
    const q = { status };
    if (customerId) q.customerId = customerId;
    if (skuId) q.skuId = skuId;
    const rows = await Alert.find(q).sort({ createdAt: -1 }).lean();
    res.json({ ok: true, data: rows });
  } catch (e) { next(e); }
});

// 🔍 GET /api/alerts/:id
router.get('/:id', async (req, res, next) => {
  try {
    const row = await Alert.findById(req.params.id).lean();
    if (!row) return res.status(404).json({ ok:false, error:'not_found' });
    res.json({ ok:true, data: row });
  } catch (e) { next(e); }
});

// ✋ POST /api/alerts/:id/dismiss
router.post('/:id/dismiss', async (req,res,next)=>{
  try { const doc = await dismiss(req.params.id); res.json({ ok:true, alert: doc }); }
  catch(e){ next(e); }
});

module.exports = router;
