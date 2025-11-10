// services/api/src/services/suggestions.service.js
const dayjs = require('dayjs');
const WarehouseOrder = require('../models/WarehouseOrder'); // canonical model path
const { processCustomerMessage } = require('./recoAdapter.service');
const { estimateDailyUse, computeRemainingDays } = require('./consumption.service');
const { computeTopUp, computeNextCyclePack } = require('./recommendation.service');
const { updateOveruseFactor, getOveruseFactor } = require('./learning.service');
const { upsertNextPackAlert } = require('./alerts.service');
const {
  NEXT_PACK_SAFETY_PCT,
  DEFAULT_PACK_STEP,
  CONSUMPTION_TARGET_DAYS,
  ALERT_MIN_CONFIDENCE,
} = require('../config/weights');

/** Resolve plan/shipment facts from order/job/subscription */
async function resolvePlanFacts({ orderId, jobId, skuIdHint }) {
  const out = {
    jobId: jobId || undefined,
    skuId: skuIdHint || undefined,
    customerId: undefined,
    planPackGrams: undefined,
    skuPackStep: DEFAULT_PACK_STEP,
    daysPerCycle: CONSUMPTION_TARGET_DAYS,
    serviceStart: undefined,
    serviceEnd: undefined,
    lastShippedGrams: 0,
    lastShippedAt: undefined,
  };

  // 1) Resolve customer via Property (jobId == propertyId)
  if (!out.customerId && jobId) {
    try {
      const Property = require('../models/Property');
      const p = await Property.findOne({ propertyId: jobId }).select('_id customer').lean();
      out.customerId = p?.customer?.toString?.() || p?._id?.toString?.() || out.customerId;
    } catch {}
  }

  // 2) Latest WO for this job (meta.jobId) or explicit orderId
  let wo = null;
  try {
    if (jobId) {
      wo = await WarehouseOrder
        .findOne({ 'meta.jobId': jobId }, { items: { $slice: 1 } })
        .sort({ createdAt: -1 })
        .lean();
    }
    if (!wo && orderId) {
      wo = await WarehouseOrder
        .findOne({ _id: orderId }, { items: { $slice: 1 } })
        .lean();
    }
  } catch {}

  // 3) Fallback: most recent WO overall
  if (!wo) {
    try {
      wo = await WarehouseOrder
        .findOne({}, { items: { $slice: 1 } })
        .sort({ createdAt: -1 })
        .lean();
    } catch {}
  }

  // 4) Derive fields
  const firstItem = wo?.items?.[0] || {};
  if (!out.skuId) out.skuId = firstItem.skuId;
  if (!out.customerId && wo?.customerId) {
    out.customerId = wo.customerId.toString?.() || wo.customerId;
  }

  out.lastShippedGrams = firstItem.expected_ship_weight_g || 0;
  out.lastShippedAt = wo?.createdAt || new Date(Date.now() - 7 * 864e5);

  out.planPackGrams = firstItem.expected_ship_weight_g || 4000;
  out.skuPackStep = DEFAULT_PACK_STEP;
  out.daysPerCycle = CONSUMPTION_TARGET_DAYS;

  const serviceStart = wo?.createdAt || new Date();
  out.serviceStart = serviceStart;
  out.serviceEnd = dayjs(serviceStart).add(out.daysPerCycle, 'day').toDate();

  // 5) Sensible fallbacks
  if (!out.skuId) out.skuId = 'SH-REFILL';
  if (!out.customerId) out.customerId = undefined;

  return out;
}

/** Main pipeline – accepts loose payload; resolves missing facts internally */
async function createSuggestionFromMessage(input = {}) {
  const {
    messageId,
    customerId: customerIdIn,   // optional
    skuId: skuIdIn,             // optional
    jobId,                      // service/job id (e.g. EO-1208-RDU)
    orderId,                    // optional: WO _id
    text,                       // optional
    planName,                   // optional
    reason,                     // optional
    tags = [],                  // optional: array of strings
    meta,                       // optional passthrough
  } = input;

  // Resolve facts if missing
  const facts = await resolvePlanFacts({ orderId, jobId, skuIdHint: skuIdIn });
  const customerId = customerIdIn || facts.customerId;
  const skuId = skuIdIn || facts.skuId;

  // 1) Model signal
  let model = await processCustomerMessage({
    messageId,
    customerId,
    skuId,
    jobId,
    text: text || reason || 'customer message',
  }).catch(() => ({
    intent: 'early_depletion',
    confidence: 0.8,
    entities: { skuId, jobId },
    rationale: 'default-fallback',
  }));

  // 🔥 Hard trigger: shortage/tag weight_exhausted => force open alert
  const hardTrigger =
    reason === 'shortage' ||
    (Array.isArray(tags) && tags.includes('weight_exhausted'));

  if (hardTrigger) {
    model = {
      intent: 'early_depletion',
      confidence: 0.95,
      entities: { skuId, jobId },
      rationale: 'hard-trigger',
    };
  }

  // Skip if model says no
  if (model.intent !== 'early_depletion' || (model.confidence ?? 0) < (ALERT_MIN_CONFIDENCE || 0.6)) {
    return { skipped: true, reason: 'no-early-depletion', model };
  }

  // 2) Numbers
  const remainingDays = computeRemainingDays({ serviceEnd: facts.serviceEnd });
  const est = estimateDailyUse({
    lastShippedGrams: facts.lastShippedGrams,
    lastShippedAt: facts.lastShippedAt,
    planPackGrams: facts.planPackGrams,
    daysPerCycle: facts.daysPerCycle,
  });

  // 3) Top-up now + next cycle suggestion
  const topUpGrams = computeTopUp({
    dailyUse: est.dailyUse,
    remainingDays,
    safetyPct: NEXT_PACK_SAFETY_PCT,
    packStep: facts.skuPackStep,
  });

  const prevFactor = await getOveruseFactor({ jobId, skuId });
  const nextCyclePack = computeNextCyclePack({
    planPackGrams: facts.planPackGrams,
    overuseFactor: prevFactor,
    packStep: facts.skuPackStep,
  });

  // 4) Learn
  const expectedThisCycle = facts.planPackGrams;
  const actualSoFar = est.dailyUse * Math.max(1, est.daysSinceShip);
  await updateOveruseFactor({ jobId, skuId, expected: expectedThisCycle, actual: actualSoFar });

  // 5) Alert upsert (+ socket push inside alerts.service)
  const alert = await upsertNextPackAlert({
    type: 'next_pack_recommendation',
    status: 'open',
    customerId,
    jobId,
    skuId,
    remainingDays,
    signal: {
      earlyDepletionConfidence: model.confidence,
      projectionDays: null,
      historyFastCycles: 0,
    },
    recommendation: {
      currentPackGrams: facts.planPackGrams,
      suggestedTopUpGrams: topUpGrams,
      suggestedNextCyclePackGrams: nextCyclePack,
      safetyPct: NEXT_PACK_SAFETY_PCT,
      packStep: facts.skuPackStep,
    },
    links: { messageId, orderId },
    meta: { source: 'customer_message', reason: model.rationale, planName, ...meta },
  });

  return { skipped: false, alert, model, est, remainingDays, facts };
}

module.exports = { createSuggestionFromMessage };
