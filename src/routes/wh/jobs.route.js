// services/api/src/routes/wh/jobs.route.js
const express = require('express');
const router = express.Router();

const Order = require('../../../models/Order');
const WarehouseJob = require('../../../models/WarehouseJob');
const { fillExpectedOnOrder } = require('../../../utils/weight');
const { buildSSCC } = require('../../lib/zpl'); 

function makeJobId(orderId) {
  return 'JOB-' + String(orderId).slice(-6) + '-' + Date.now().toString().slice(-4);
}

// POST /api/wh/jobs/from-order/:orderId
router.post('/jobs/from-order/:orderId', async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const { carton_tare_g = 0, tol_abs_g = 50, tol_pct = 0.015 } = req.body || {};

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ ok:false, error:'order not found' });

    // ensure line expected weights
    fillExpectedOnOrder(order);

    const expectedCarton = order.items.reduce((sum, it) => sum + (it.expected_ship_weight_g || 0), 0);

    const sscc = buildSSCC(); // GS1 serial for carton
    const job = await WarehouseJob.create({
      jobId: makeJobId(orderId),
      orderId,
      lines: order.items.map(it => ({
        skuId: it.skuId,
        name: it.name,
        qty:  it.qty,
        expected_ship_weight_g: it.expected_ship_weight_g || 0,
        tolerance_g: it.tolerance_g ?? 10,
        tolerance_pct: it.tolerance_pct ?? 0.02,
        lot: it.lot,
        expiry: it.expiry
      })),
      expected_carton_weight_g: expectedCarton,
      carton_tare_g,
      tol_abs_g: tol_abs_g,
      tol_pct: tol_pct,
      sscc
    });

    res.json({
      ok: true,
      jobId: job.jobId,
      id: job._id,
      expected_carton_weight_g: expectedCarton,
      sscc
    });
  } catch (e) { next(e); }
});

module.exports = router;
