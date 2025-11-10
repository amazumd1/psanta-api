const dayjs = require('dayjs');
const { blendDailyUse } = require('./recommendation.service');

function diffDays(a, b) { return Math.max(0, Math.ceil(dayjs(a).diff(dayjs(b), 'day', true))); }

function estimateDailyUse({ lastShippedGrams, lastShippedAt, planPackGrams, daysPerCycle }) {
  const daysSinceShip = Math.max(1, diffDays(new Date(), lastShippedAt || new Date()));
  const dailyUseObs = lastShippedGrams ? (lastShippedGrams / daysSinceShip) : null;
  const dailyUsePlan = (planPackGrams && daysPerCycle) ? (planPackGrams / daysPerCycle) : null;
  return { dailyUse: blendDailyUse(dailyUseObs, dailyUsePlan), dailyUseObs, dailyUsePlan, daysSinceShip };
}

function computeRemainingDays({ serviceEnd }) {
  return diffDays(serviceEnd, new Date());
}

module.exports = { estimateDailyUse, computeRemainingDays };
