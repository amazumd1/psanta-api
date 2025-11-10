// services/api/src/routes/prop/stock.route.js
const express = require('express');
const router = express.Router();

const PropertyStock = require('../../../models/PropertyStock');
const WarehouseJob = require('../../../models/WarehouseJob');
const Order = require('../../../models/Order');

// POST /api/prop/stock/receive
// body: { propertyId, jobId, sscc, lines:[{skuId,name,qty_ea, expected_line_gross_g, packed_line_gross_g, lot, expiry}] }
router.post('/stock/receive', async (req, res, next) => {
  try {
    const { propertyId, jobId, sscc, lines = [] } = req.body || {};
    if (!propertyId || !jobId) return res.status(400).json({ ok:false, error:'propertyId and jobId required' });

    const job = await WarehouseJob.findOne({ jobId });
    if (!job) return res.status(404).json({ ok:false, error:'job not found' });

    const docs = await PropertyStock.insertMany(lines.map(l => ({
      propertyId,
      orderId: job.orderId,
      jobId,
      sscc: sscc || job.sscc,
      skuId: l.skuId,
      name: l.name,
      qty_ea: Number(l.qty_ea || l.qty || 0),
      expected_line_gross_g: l.expected_line_gross_g,
      packed_line_gross_g: l.packed_line_gross_g,
      lot: l.lot,
      expiry: l.expiry
    })));

    res.json({ ok:true, created: docs.length });
  } catch (e) { next(e); }
});

// POST /api/prop/stock/consume
// body: { sscc OR stockId, skuId, qty_ea, note }
router.post('/stock/consume', async (req, res, next) => {
  try {
    const { sscc, stockId, skuId, qty_ea = 1, note } = req.body || {};
    let stock;

    if (stockId) {
      stock = await PropertyStock.findById(stockId);
    } else if (sscc && skuId) {
      stock = await PropertyStock.findOne({ sscc, skuId, status: 'active' }).sort({ createdAt: -1 });
    }

    if (!stock) return res.status(404).json({ ok:false, error:'stock not found' });
    stock.qty_ea = Math.max(0, (stock.qty_ea || 0) - Number(qty_ea));
    stock.events.push({ type: 'consume', qty_ea, note, by: req.user?.email || 'unknown' });

    if (stock.qty_ea === 0) stock.status = 'consumed';
    await stock.save();

    res.json({ ok:true, jobId: stock.jobId, orderId: stock.orderId, sscc: stock.sscc, remaining: stock.qty_ea });
  } catch (e) { next(e); }
});

module.exports = router;
