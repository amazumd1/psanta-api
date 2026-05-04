// services/api/lib/marketGuardrailPricing.js
const crypto = require('crypto');
const MarketRateProfile = require('../models/MarketRateProfile');
const PricingQuote = require('../models/PricingQuote');

const DEFAULT_MARKET_PROFILES = {
  '33140:standard_clean': { marketLow: 150, marketMedian: 195, marketHigh: 275, cleanerPayoutFloor: 125, platformMarginPct: 22, confidence: 0.55, sourceCount: 2, sources: ['manual_seed', 'public_benchmark'] },
  '33140:deep_clean': { marketLow: 230, marketMedian: 310, marketHigh: 430, cleanerPayoutFloor: 185, platformMarginPct: 24, confidence: 0.5, sourceCount: 2, sources: ['manual_seed', 'public_benchmark'] },
  '33140:move_out_clean': { marketLow: 260, marketMedian: 345, marketHigh: 475, cleanerPayoutFloor: 210, platformMarginPct: 24, confidence: 0.5, sourceCount: 2, sources: ['manual_seed', 'public_benchmark'] },

  '33334:standard_clean': { marketLow: 135, marketMedian: 175, marketHigh: 250, cleanerPayoutFloor: 110, platformMarginPct: 22, confidence: 0.45, sourceCount: 2, sources: ['manual_seed', 'public_benchmark'] },
  '33334:deep_clean': { marketLow: 210, marketMedian: 285, marketHigh: 405, cleanerPayoutFloor: 170, platformMarginPct: 24, confidence: 0.45, sourceCount: 2, sources: ['manual_seed', 'public_benchmark'] },
  '33334:move_out_clean': { marketLow: 235, marketMedian: 320, marketHigh: 445, cleanerPayoutFloor: 190, platformMarginPct: 24, confidence: 0.45, sourceCount: 2, sources: ['manual_seed', 'public_benchmark'] },

  '33076:standard_clean': { marketLow: 145, marketMedian: 185, marketHigh: 265, cleanerPayoutFloor: 118, platformMarginPct: 22, confidence: 0.45, sourceCount: 2, sources: ['manual_seed', 'public_benchmark'] },
  '33076:deep_clean': { marketLow: 220, marketMedian: 300, marketHigh: 420, cleanerPayoutFloor: 178, platformMarginPct: 24, confidence: 0.45, sourceCount: 2, sources: ['manual_seed', 'public_benchmark'] },
  '33076:move_out_clean': { marketLow: 245, marketMedian: 330, marketHigh: 460, cleanerPayoutFloor: 198, platformMarginPct: 24, confidence: 0.45, sourceCount: 2, sources: ['manual_seed', 'public_benchmark'] },
};

function normalizeZip(zip) {
  const m = String(zip || '').match(/\b\d{5}\b/);
  return m ? m[0] : '';
}

function normalizeService(serviceType) {
  const raw = String(serviceType || '').toLowerCase().trim();
  if (raw.includes('deep')) return 'deep_clean';
  if (raw.includes('move')) return 'move_out_clean';
  if (raw.includes('turnover')) return 'turnover_clean';
  return 'standard_clean';
}

function fallbackProfile(zip, service) {
  const key = `${zip}:${service}`;
  const seeded = DEFAULT_MARKET_PROFILES[key];
  if (seeded) return { zip, service, ...seeded, isFallback: true };

  const stateLikePremium = /^(33|10|11|90|91|92|94|98)/.test(zip || '') ? 1.12 : 1;
  const base = service === 'deep_clean' ? 255 : service === 'move_out_clean' ? 285 : service === 'turnover_clean' ? 195 : 165;
  const median = Math.round(base * stateLikePremium);

  return {
    zip,
    service,
    marketLow: Math.round(median * 0.72),
    marketMedian: median,
    marketHigh: Math.round(median * 1.45),
    cleanerPayoutFloor: Math.round(median * 0.64),
    platformMarginPct: service === 'standard_clean' ? 22 : 24,
    paymentFeeBuffer: 8,
    suppliesTravelBuffer: 0,
    confidence: zip ? 0.25 : 0.15,
    sourceCount: 1,
    sources: ['fallback_seed'],
    isFallback: true,
  };
}

async function getMarketProfile({ zip, service }) {
  const cleanZip = normalizeZip(zip);
  const normalizedService = normalizeService(service);
  if (!cleanZip) return fallbackProfile('', normalizedService);

  const doc = await MarketRateProfile.findOne({ zip: cleanZip, service: normalizedService }).lean();
  return doc || fallbackProfile(cleanZip, normalizedService);
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function sizeFactor({ beds, baths, sqft }) {
  const b = Math.max(0, num(beds, 0));
  const ba = Math.max(0, num(baths, 0));
  const sf = Math.max(0, num(sqft, 0));
  const bedAdj = (b - 2) * 0.08;
  const bathAdj = (ba - 2) * 0.07;
  const sqftAdj = sf ? ((sf - 1000) / 1000) * 0.12 : 0;
  return clamp(1 + bedAdj + bathAdj + sqftAdj, 0.78, 1.65);
}

function serviceFactor(service) {
  if (service === 'deep_clean') return 1.25;
  if (service === 'move_out_clean') return 1.35;
  if (service === 'turnover_clean') return 1.12;
  return 1;
}

function conditionFactor(condition) {
  const c = String(condition || 'normal').toLowerCase();
  if (c.includes('heavy') || c.includes('dirty')) return 1.22;
  if (c.includes('light')) return 0.92;
  return 1;
}

function urgencyFactor({ leadTimeDays, isWeekend, isHoliday }) {
  let f = 1;
  const lead = Number(leadTimeDays);
  if (Number.isFinite(lead)) {
    if (lead <= 1) f *= 1.22;
    else if (lead <= 3) f *= 1.12;
  }
  if (isWeekend) f *= 1.1;
  if (isHoliday) f *= 1.25;
  return f;
}

function addonTotal(addons) {
  const flat = { windows: 25, oven: 20, fridge: 20, balcony: 15, laundry: 25, pet: 25 };
  if (Array.isArray(addons)) return addons.reduce((sum, code) => sum + num(flat[code], 0), 0);
  if (addons && typeof addons === 'object') {
    return Object.entries(addons).reduce((sum, [code, enabled]) => sum + (enabled ? num(flat[code], 0) : 0), 0);
  }
  return 0;
}

function roundCharm(value, step = 5, charm = '.99') {
  const s = Number(step || 1);
  const rounded = Math.ceil(Number(value || 0) / s) * s;
  if (charm === '.00') return Number(rounded.toFixed(2));
  return Number((Math.floor(rounded) + 0.99).toFixed(2));
}

function makeQuoteId() {
  return `qt_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

function makeLockToken() {
  return `lock_${crypto.randomBytes(18).toString('hex')}`;
}

function hashQuote(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot || {})).digest('hex');
}

async function computeMarketGuardrailQuote(input = {}, cfgQuote = null) {
  const service = normalizeService(input.serviceType || input.service || 'standard_clean');
  const zip = normalizeZip(input.zip);
  const market = await getMarketProfile({ zip, service });

  const baseMarket = num(market.marketMedian, 165);
  const factorSize = sizeFactor(input);
  const factorService = serviceFactor(service);
  const factorCondition = conditionFactor(input.condition);
  const factorUrgency = urgencyFactor(input);
  const addonsTotal = addonTotal(input.addons);

  const aiMarketEstimate = baseMarket * factorSize * factorService * factorCondition * factorUrgency + addonsTotal;
  const cfgTotal = Number(cfgQuote?.total || 0);
  const marketEstimate = cfgTotal > 0 ? Math.max(aiMarketEstimate, cfgTotal) : aiMarketEstimate;

  const cleanerFloor = num(market.cleanerPayoutFloor, Math.round(baseMarket * 0.62));
  const platformMarginPct = num(market.platformMarginPct, 22);
  const paymentFeeBuffer = num(market.paymentFeeBuffer, 8);
  const suppliesTravelBuffer = num(market.suppliesTravelBuffer, 0);
  const lossFloor = cleanerFloor * (1 + platformMarginPct / 100) + paymentFeeBuffer + suppliesTravelBuffer + addonsTotal;
  const raw = Math.max(marketEstimate, lossFloor);
  const total = roundCharm(raw, Number(input.roundingStep || 5), input.charmStyle || '.99');

  const minutes = cfgQuote?.breakdown?.minutes || Math.round(75 * factorSize * factorService * factorCondition);

  return {
    total,
    marketProfile: market,
    breakdown: {
      pricingMode: 'market_guardrail',
      service,
      zip,
      minutes,
      hours: Number((minutes / 60).toFixed(2)),
      marketLow: num(market.marketLow, 0),
      marketMedian: baseMarket,
      marketHigh: num(market.marketHigh, 0),
      cleanerPayoutFloor: cleanerFloor,
      platformMarginPct,
      paymentFeeBuffer,
      suppliesTravelBuffer,
      sizeFactor: Number(factorSize.toFixed(3)),
      serviceFactor: factorService,
      conditionFactor: factorCondition,
      urgencyFactor: Number(factorUrgency.toFixed(3)),
      addonsTotal,
      aiMarketEstimate: Number(aiMarketEstimate.toFixed(2)),
      configQuoteTotal: cfgTotal || null,
      lossFloor: Number(lossFloor.toFixed(2)),
      confidence: num(market.confidence, 0.25),
      sourceCount: num(market.sourceCount, 1),
      sources: market.sources || [],
    },
  };
}

async function createLockedQuote({ input = {}, cfgQuote = null, tenantId = '', propertyId = '' }) {
  const priced = await computeMarketGuardrailQuote(input, cfgQuote);
  const quoteId = makeQuoteId();
  const priceLockToken = makeLockToken();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const snapshot = {
    quoteId,
    tenantId,
    propertyId,
    input,
    total: priced.total,
    breakdown: priced.breakdown,
    expiresAt: expiresAt.toISOString(),
  };
  const quoteHash = hashQuote(snapshot);

  const doc = await PricingQuote.create({
    quoteId,
    priceLockToken,
    tenantId,
    propertyId,
    inputSnapshot: input,
    marketProfileSnapshot: priced.marketProfile,
    pricingConfigVersion: String(input.pricingConfigVersion || ''),
    total: priced.total,
    currency: 'USD',
    breakdown: priced.breakdown,
    status: 'quoted',
    expiresAt,
    quoteHash,
  });

  return { ...priced, quoteId, priceLockToken, expiresAt, quoteHash: doc.quoteHash };
}

async function getValidLockedQuote({ quoteId, priceLockToken, tenantId }) {
  const qid = String(quoteId || '').trim();
  const token = String(priceLockToken || '').trim();
  if (!qid || !token) return null;

  const query = { quoteId: qid, priceLockToken: token, status: 'quoted', expiresAt: { $gt: new Date() } };
  if (tenantId) query.$or = [{ tenantId: String(tenantId) }, { tenantId: '' }, { tenantId: { $exists: false } }];
  return PricingQuote.findOne(query);
}

module.exports = {
  normalizeZip,
  normalizeService,
  getMarketProfile,
  computeMarketGuardrailQuote,
  createLockedQuote,
  getValidLockedQuote,
};