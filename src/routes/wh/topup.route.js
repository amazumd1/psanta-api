// services/api/src/routes/wh/topup.route.js
const express = require('express');
const router = express.Router();
const { Types } = require('mongoose');
const { markApplied } = require('../../services/alerts.service');
const WarehouseOrder = require('../../models/WarehouseOrder');

router.post('/', async (req, res, next) => {
  try {
    const { alertId, customerId, skuId, grams, requestId, jobId } = req.body || {};

    // ✅ minimal validation
    if (!customerId || !Types.ObjectId.isValid(customerId)) {
      return res.status(400).json({ ok: false, error: 'invalid_customerId' });
    }
    if (!skuId) {
      return res.status(400).json({ ok: false, error: 'sku_required' });
    }
    const g = Number(grams) || 0;
    if (g <= 0) {
      return res.status(400).json({ ok: false, error: 'grams_must_be_positive' });
    }

    // ✅ create WO (String orderId)
    const wo = await WarehouseOrder.create({
      orderId: requestId || `TOPUP-${Date.now()}`,
      source: 'admin_topup',
      status: 'pending_pick',
      customerId: new Types.ObjectId(customerId),
      items: [{
        skuId,
        name: skuId,
        qty: 1,
        unitPrice: 0,
        expected_ship_weight_g: g,
        packed_weight_g: 0,
        tolerance_g: 10,
        tolerance_pct: 0.02
      }],
      meta: { requestId, jobId }
    });

    if (alertId) await markApplied(alertId, wo._id);
    return res.json({ ok: true, order: wo });
  } catch (e) { next(e); }
});

module.exports = router;
