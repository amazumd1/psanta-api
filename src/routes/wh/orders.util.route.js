const express = require('express');
const router = express.Router();
const Order = require('../../../models/Order');
const { fillExpectedOnOrder } = require('../../../utils/weight');

// POST /api/wh/orders/:orderId/recalc-expected
router.post('/orders/:orderId/recalc-expected', async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const doc = await Order.findById(orderId);
    if (!doc) return res.status(404).json({ ok: false, error: 'Order not found' });

    fillExpectedOnOrder(doc);
    doc.markModified('items');
    await doc.save();

    res.json({ ok: true, orderId, items: doc.items });
  } catch (e) { next(e); }
});

module.exports = router;
