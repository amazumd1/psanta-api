// services/api/utils/consumption.js

/**
 * EWMA update for mean (mu) and a simple EWMA for variance proxy (sigma)
 * We track grams per occupied day: gpd = used_g / occupied_days
 */
function ewmaUpdate({ mu, sigma, N }, sampleGpd, alpha = 0.3) {
  if (N <= 0 || !isFinite(mu)) {
    // first sample bootstrap
    return { mu: sampleGpd, sigma: 0, N: 1 };
  }
  const delta = sampleGpd - mu;
  const nextMu = mu + alpha * delta;

  // simple EWMA of abs deviation -> convert to sigma-ish
  const dev = Math.abs(delta);
  const nextSigma = (1 - alpha) * sigma + alpha * dev; // not true stddev, but works as noise proxy

  return { mu: nextMu, sigma: nextSigma, N: Math.min(N + 1, 1000) };
}

/**
 * Safety stock logic:
 * demand ~ mu * D  ;  noise ~ sigma * sqrt(D)
 * rec_g = mu*D + z * sigma * sqrt(D) ; then penalty if past stockouts
 */
function recommendGrams({ mu, sigma, days, z = 1.0, penalty = 1.0 }) {
  const D = Math.max(1, Number(days || 1));
  const base = mu * D;
  const noise = sigma * Math.sqrt(D);
  const rec = base + z * noise;
  return Math.max(0, Math.round(rec * penalty));
}

/**
 * Round recommended grams to pack size (bottle, roll etc.)
 * packs: [{skuId, net_g, minUnits=1}]
 */
function roundToPacks(recG, { net_g = 0, minUnits = 1 }) {
  if (!net_g || net_g <= 0) return { units: 0, rounded_g: 0 };
  const units = Math.max(minUnits, Math.ceil(recG / net_g));
  return { units, rounded_g: units * net_g };
}

module.exports = {
  ewmaUpdate,
  recommendGrams,
  roundToPacks
};
