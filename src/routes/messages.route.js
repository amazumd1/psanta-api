const express = require('express');
const router = express.Router();
const { processCustomerMessage } = require('../services/recoAdapter.service');
const { estimateDailyUse, computeRemainingDays } = require('../services/consumption.service');
const { computeTopUp, computeNextCyclePack } = require('../services/recommendation.service');
const { updateOveruseFactor, getOveruseFactor } = require('../services/learning.service');
const { upsertNextPackAlert } = require('../services/alerts.service');
const { NEXT_PACK_SAFETY_PCT, DEFAULT_PACK_STEP, CONSUMPTION_TARGET_DAYS, ALERT_MIN_CONFIDENCE } = require('../config/weights');

// TODO: replace with your real lookups:
async function getCustomerPlan(customerId, skuId, jobId) {
  // Pull from your Subscription/Plan tables
  return {
    serviceStart: new Date(),                 // fill real
    serviceEnd: new Date(Date.now() + 29*864e5),
    daysPerCycle: CONSUMPTION_TARGET_DAYS,
    planPackGrams: 4000,
    skuPackStep: DEFAULT_PACK_STEP,
    lastShippedGrams: 4000,
    lastShippedAt: new Date(Date.now() - 10*864e5)
  };
}

router.post('/ingest', async (req, res, next) => {
  try {
    const { messageId, customerId, skuId, jobId, text } = req.body;

    // 1) Run your learning model (phrase-agnostic)
    const model = await processCustomerMessage({ messageId, customerId, skuId, jobId, text });
    if (model.intent !== 'early_depletion' || (model.confidence ?? 0) < ALERT_MIN_CONFIDENCE) {
      return res.json({ ok: true, skipped: true, reason: 'no-early-depletion' });
    }

    // 2) Pull plan & shipment info
    const plan = await getCustomerPlan(customerId, skuId, jobId);

    // 3) Numbers
    const remainingDays = computeRemainingDays({ serviceEnd: plan.serviceEnd });
    const est = estimateDailyUse({
      lastShippedGrams: plan.lastShippedGrams,
      lastShippedAt: plan.lastShippedAt,
      planPackGrams: plan.planPackGrams,
      daysPerCycle: plan.daysPerCycle
    });

    // 4) Compute top-up and next-cycle suggestion
    const topUpGrams = computeTopUp({
      dailyUse: est.dailyUse,
      remainingDays,
      safetyPct: NEXT_PACK_SAFETY_PCT,
      packStep: plan.skuPackStep
    });

    const prevFactor = await getOveruseFactor({ jobId, skuId });
    const nextCyclePack = computeNextCyclePack({
      planPackGrams: plan.planPackGrams,
      overuseFactor: prevFactor,
      packStep: plan.skuPackStep
    });

    // 5) Update learning immediately with current shortfall snapshot (optional)
    const expectedThisCycle = plan.planPackGrams;
    const actualSoFar = est.dailyUse * Math.max(1, est.daysSinceShip);
    await updateOveruseFactor({ jobId, skuId, expected: expectedThisCycle, actual: actualSoFar });

    // 6) Raise/Upsert Alert
    const alert = await upsertNextPackAlert({
      type: 'next_pack_recommendation',
      status: 'open',
      customerId, jobId, skuId,
      remainingDays,
      signal: {
        earlyDepletionConfidence: model.confidence,
        projectionDays: null,
        historyFastCycles: 0
      },
      recommendation: {
        currentPackGrams: plan.planPackGrams,
        suggestedTopUpGrams: topUpGrams,
        suggestedNextCyclePackGrams: nextCyclePack,
        safetyPct: NEXT_PACK_SAFETY_PCT,
        packStep: plan.skuPackStep
      },
      links: { messageId },
      meta: { source: 'customer_message', reason: model.rationale }
    });

    res.json({ ok: true, alert });
  } catch (e) { next(e); }
});

module.exports = router;
