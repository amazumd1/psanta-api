// services/api/src/routes/wh/learning.route.js
const express = require('express');
const router = express.Router();

const mongoose = require('mongoose');
const WarehouseJob = require('../../../models/WarehouseJob');
const ConsumptionModel = require('../../../models/ConsumptionModel');
const { ewmaUpdate } = require('../../../utils/consumption');
const { distributePackedWeight } = require('../../../utils/weight');

/**
 * POST /api/wh/jobs/:jobId/pack
 * body: { actual_carton_weight_g }
 * - captures gross carton weight
 * - distributes NET (gross - tare) across lines by expected share
 */
router.post('/jobs/:jobId/pack', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { actual_carton_weight_g = 0 } = req.body || {};

    const job = await WarehouseJob.findOne({ jobId });
    if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });

    const gross = Math.max(0, Number(actual_carton_weight_g || 0));
    job.actual_carton_weight_g = gross;

    const tare = Math.max(0, Number(job.carton_tare_g || 0));
    const net = Math.max(0, gross - tare);

    // proportional distribution to line.packed_weight_g
    const items = (job.lines || []).map(l => ({
      expected_ship_weight_g: Number(l.expected_ship_weight_g || 0),
      packed_weight_g: 0
    }));
    distributePackedWeight({ items }, net);
    items.forEach((it, idx) => { job.lines[idx].packed_weight_g = it.packed_weight_g; });

    await job.save();
    return res.json({
      ok: true,
      jobId: job.jobId,
      actual_carton_weight_g: job.actual_carton_weight_g,
      packed_net_g: net
    });
  } catch (e) { next(e); }
});

/**
 * POST /api/wh/jobs/:jobId/close
 * body: {
 *   occupied_days,            // default: job.expected_occupied_days
 *   used_by_sku: [{skuId,used_g}], // optional manual override
 *   stockout,                 // boolean
 *   topups_sent               // number
 * }
 * - updates ConsumptionModel (per property+sku EWMA)
 */
router.post('/jobs/:jobId/close', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { occupied_days, used_by_sku = [], stockout = false, topups_sent = 0 } = req.body || {};

    const job = await WarehouseJob.findOne({ jobId });
    if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });

    const days = Math.max(
      1,
      Math.min(
        Number(occupied_days || job.expected_occupied_days || 1),
        Number(job.cycle_days || 30)
      )
    );

    // build used map
    const usedMap = new Map();
    if (Array.isArray(used_by_sku) && used_by_sku.length) {
      used_by_sku.forEach(u => usedMap.set(u.skuId, Math.max(0, Number(u.used_g || 0))));
    } else {
      (job.lines || []).forEach(l => usedMap.set(l.skuId, Math.max(0, Number(l.packed_weight_g || 0))));
    }

    for (const l of (job.lines || [])) {
      const skuId = l.skuId;
      const usedG = usedMap.get(skuId) || 0;
      const sampleGpd = usedG / days;

      let model = await ConsumptionModel.findOne({ propertyId: job.propertyId, skuId });
      if (!model) {
        model = new ConsumptionModel({
          propertyId: job.propertyId,
          skuId,
          mu_g_per_day: sampleGpd,
          sigma_g_per_day: 0,
          N: 1,
          stockout_penalty: 1
        });
      } else {
        const upd = ewmaUpdate({
          mu: model.mu_g_per_day,
          sigma: model.sigma_g_per_day,
          N: model.N
        }, sampleGpd, 0.3);
        model.mu_g_per_day = upd.mu;
        model.sigma_g_per_day = upd.sigma;
        model.N = upd.N;
      }

      // stockout penalty smoothing
      const decay = 0.9;  // gently decay toward 1
      const bump  = 1.08; // 8% bump on stockout
      model.stockout_penalty = (model.stockout_penalty || 1) * (stockout ? bump : 1);
      model.stockout_penalty = 1 + (model.stockout_penalty - 1) * decay;

      model.lastSample = {
        days,
        used_g: usedG,
        stockout: !!stockout,
        topups: Number(topups_sent || 0),
        capturedAt: new Date()
      };
      model.updatedAt = new Date();
      await model.save();
    }

    job.closed = true;
    job.stockout = !!stockout;
    job.topups_sent = Number(topups_sent || 0);
    job.closedAt = new Date();
    await job.save();

    return res.json({ ok: true, jobId: job.jobId, closed: true });
  } catch (e) { next(e); }
});

/**
 * GET /api/wh/learning/:propertyId/summary
 * - lightweight summary per SKU from WarehouseJob history (no LearningEvent needed)
 */
router.get('/learning/:propertyId/summary', async (req, res, next) => {
  try {
    const { propertyId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(propertyId)) {
      return res.status(400).json({ ok: false, error: 'Invalid propertyId' });
    }

    // Fold jobs for this property, explode lines and aggregate
    const bySku = await WarehouseJob.aggregate([
      { $match: { propertyId: new mongoose.Types.ObjectId(propertyId) } },
      { $unwind: '$lines' },
      {
        $group: {
          _id: '$lines.skuId',
          samples: { $sum: 1 },
          lastPackedG: { $last: '$lines.packed_weight_g' },
          lastExpectedG: { $last: '$lines.expected_ship_weight_g' },
          avgPackedG: { $avg: '$lines.packed_weight_g' },
          avgExpectedG: { $avg: '$lines.expected_ship_weight_g' },
          lastSeenAt: { $last: '$updatedAt' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    return res.json({ ok: true, bySku });
  } catch (e) { next(e); }
});

module.exports = router;
