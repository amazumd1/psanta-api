// services/api/src/routes/wh/reco.route.js
const express = require('express');
const router = express.Router();

const ConsumptionModel = require('../../../models/ConsumptionModel');
const { recommendGrams, roundToPacks } = require('../../../utils/consumption');
const { getSkuWeightG } = require('../../../utils/weight');

/**
 * GET /api/wh/recommendation?propertyId=...&days=15&z=1.0
 * returns per-SKU recommended UNITS and grams
 */
router.get('/recommendation', async (req, res, next) => {
  try {
    const { propertyId, days = 15, z = 1.0 } = req.query;
    if (!propertyId) return res.status(400).json({ ok: false, error: 'propertyId required' });

    const models = await ConsumptionModel.find({ propertyId });
    const out = [];
    for (const m of models) {
      const recG = recommendGrams({
        mu: m.mu_g_per_day || 0,
        sigma: m.sigma_g_per_day || 0,
        days: Number(days),
        z: Number(z),
        penalty: m.stockout_penalty || 1
      });
      const net_g = getSkuWeightG(m.skuId) || 0;
      const rounded = roundToPacks(recG, { net_g, minUnits: 1 });
      out.push({
        skuId: m.skuId,
        mu_g_per_day: Math.round((m.mu_g_per_day || 0) * 100) / 100,
        sigma_g_per_day: Math.round((m.sigma_g_per_day || 0) * 100) / 100,
        stockout_penalty: Math.round((m.stockout_penalty || 1) * 100) / 100,
        recommended_g: recG,
        pack_net_g: net_g,
        recommended_units: rounded.units,
        rounded_g: rounded.rounded_g
      });
    }
    res.json({ ok: true, days: Number(days), z: Number(z), items: out });
  } catch (e) { next(e); }
});


// GET /api/wh/reco/:propertyId
router.get('/reco/:propertyId', async (req, res, next) => {
  try {
    const { propertyId } = req.params;
    const recos = await Recommendation.find({ propertyId })
      .sort({ createdAt: -1 }).limit(1).lean();
    return res.json({ ok: true, latest: recos[0] || null });
  } catch (e) { next(e); }
});


module.exports = router;
