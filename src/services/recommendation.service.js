const { NEXT_PACK_SAFETY_PCT, DEFAULT_PACK_STEP } = require('../config/weights');

function ceilToStep(value, step) {
  return Math.ceil(value / step) * step;
}

function blendDailyUse(dailyUseObs, dailyUsePlan, alpha = 0.7) {
  if (!dailyUseObs && !dailyUsePlan) return 0;
  if (!dailyUseObs) return dailyUsePlan;
  if (!dailyUsePlan) return dailyUseObs;
  return alpha * dailyUseObs + (1 - alpha) * dailyUsePlan;
}

function computeTopUp({ dailyUse, remainingDays, safetyPct = NEXT_PACK_SAFETY_PCT, packStep = DEFAULT_PACK_STEP }) {
  const raw = Math.max(0, dailyUse) * Math.max(0, remainingDays) * (1 + safetyPct);
  return ceilToStep(raw, packStep);
}

function computeNextCyclePack({ planPackGrams, overuseFactor = 1.0, safetyPct = NEXT_PACK_SAFETY_PCT, packStep = DEFAULT_PACK_STEP }) {
  const raw = planPackGrams * overuseFactor * (1 + safetyPct);
  return ceilToStep(raw, packStep);
}

module.exports = {
  ceilToStep,
  blendDailyUse,
  computeTopUp,
  computeNextCyclePack,
};
