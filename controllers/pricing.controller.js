// services/api/controllers/pricing.controller.js
const PricingConfig = require('../models/PricingConfig');
const { computeQuote } = require('../lib/quote');
const MarketRateProfile = require('../models/MarketRateProfile');
const { createLockedQuote } = require('../lib/marketGuardrailPricing');

function normalizeStatesWithCodes(inputStates = {}) {
  const states = { ...inputStates };

  if (states.DEFAULT && !states.default) {
    states.default = states.DEFAULT;
    delete states.DEFAULT;
  }

  for (const k of Object.keys(states)) {
    const s = (states[k] = { ...(states[k] || {}) });
    if (!s.code) s.code = k;
  }

  return states;
}

async function getOrCreate() {
  let doc = await PricingConfig.findOne({});
  if (!doc) {
    doc = await PricingConfig.create({
      states: {
        NC: {
          code: 'NC',
          time: {
            base_minutes: 60,
            per_bed_minutes: 18,
            per_bath_minutes: 22,
            per_1000sqft_minutes: 12,
            min_minutes_floor: 60,
            max_minutes_cap: 600,
          },
          billing: {
            labor_hourly_cost: 22,
            margin_percent: 45,
            direct_billing_hourly_rate: 45,
            visit_fee: 0,
            min_job_value: 0,
            weekend_factor: 1.15,
            holiday_factor: 1.3,
            zip_factor_default: 1,
            rounding_step: 5,
            charm_style: '.99',
          },
        },
      },
    });
  }

  return doc;
}

exports.getConfig = async (req, res) => {
  try {
    const doc = await getOrCreate();
    return res.json(doc);
  } catch (err) {
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
};

exports.replaceConfig = async (req, res) => {
  try {
    const input = req.body || {};
    const body = input && input.config ? input.config : input;

    const doc = await getOrCreate();

    if (body.states && typeof body.states === 'object') {
      const states = normalizeStatesWithCodes(body.states);
      doc.states = new Map(Object.entries(states));
    }

    if (body.multiVisit && typeof body.multiVisit === 'object') {
      doc.multiVisit = body.multiVisit;
    }

    if (body.billing && typeof body.billing === 'object') {
      doc.billing = body.billing;
    }

    if (body.addons && typeof body.addons === 'object') {
      doc.addons = body.addons;
    }

    await doc.save();
    return res.json({ ok: true, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error('replaceConfig error:', err);
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
};

exports.addState = async (req, res) => {
  try {
    const { code, cloneFrom } = req.body || {};
    if (!code) return res.status(400).json({ ok: false, error: 'code required' });

    const doc = await getOrCreate();
    if (doc.states.get(code)) {
      return res.status(409).json({ ok: false, error: 'state exists' });
    }

    let base = doc.states.get(cloneFrom) || doc.states.get('NC');
    base = base ? (base.toObject ? base.toObject() : base) : {};

    doc.states.set(code, { ...base, code });
    await doc.save();

    return res.json({ ok: true, state: doc.states.get(code) });
  } catch (err) {
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
};

exports.deleteState = async (req, res) => {
  try {
    const { code } = req.params;
    const doc = await getOrCreate();

    if (!doc.states.get(code)) {
      return res.status(404).json({ ok: false, error: 'not found' });
    }

    doc.states.delete(code);
    await doc.save();

    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
};

exports.updateStatePatch = async (req, res) => {
  try {
    const { code } = req.params;
    const patch = req.body || {};

    const doc = await getOrCreate();
    const cur = doc.states.get(code);

    if (!cur) {
      return res.status(404).json({ ok: false, error: 'not found' });
    }

    const currentState = cur.toObject ? cur.toObject() : cur;
    doc.states.set(code, { ...currentState, ...patch, code: patch.code || currentState.code || code });

    await doc.save();

    return res.json({ ok: true, state: doc.states.get(code) });
  } catch (err) {
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
};

exports.quote = async (req, res) => {
  try {
    const doc = await getOrCreate();
    const input = req.body || {};

    let configQuote = null;
    try {
      configQuote = computeQuote(doc, input);
    } catch (_) {
      configQuote = null;
    }

    const locked = await createLockedQuote({
      input,
      cfgQuote: configQuote,
      tenantId: String(input.tenantId || req.headers['x-tenant-id'] || '').trim(),
      propertyId: String(input.propertyId || '').trim(),
    });

    return res.json({
      ok: true,
      quoteId: locked.quoteId,
      priceLockToken: locked.priceLockToken,
      expiresAt: locked.expiresAt,
      total: locked.total,
      currency: 'USD',
      breakdown: locked.breakdown,
      marketProfile: {
        zip: locked.marketProfile?.zip || '',
        service: locked.marketProfile?.service || locked.breakdown?.service || '',
        marketLow: locked.marketProfile?.marketLow,
        marketMedian: locked.marketProfile?.marketMedian,
        marketHigh: locked.marketProfile?.marketHigh,
        cleanerPayoutFloor: locked.marketProfile?.cleanerPayoutFloor,
        confidence: locked.marketProfile?.confidence,
        sourceCount: locked.marketProfile?.sourceCount,
        updatedAt: locked.marketProfile?.updatedAt,
        isFallback: !!locked.marketProfile?.isFallback,
      },
      configQuote: configQuote
        ? {
            total: configQuote.total,
            breakdown: configQuote.breakdown,
          }
        : null,
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
};

exports.listMarketRates = async (req, res) => {
  try {
    const zip = String(req.query.zip || '').trim();
    const service = String(req.query.service || '').trim();

    const q = {};
    if (zip) q.zip = zip;
    if (service) q.service = service;

    const rows = await MarketRateProfile.find(q).sort({ zip: 1, service: 1 }).limit(250).lean();

    return res.json({ ok: true, rows });
  } catch (err) {
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
};

exports.upsertMarketRate = async (req, res) => {
  try {
    const body = req.body || {};
    const zip = String(body.zip || '').trim();
    const service = String(body.service || '').trim();

    if (!/^\d{5}$/.test(zip)) {
      return res.status(400).json({ ok: false, error: 'valid 5-digit zip required' });
    }

    if (!service) {
      return res.status(400).json({ ok: false, error: 'service required' });
    }

    const patch = {
      marketLow: Number(body.marketLow),
      marketMedian: Number(body.marketMedian),
      marketHigh: Number(body.marketHigh),
      cleanerPayoutFloor: Number(body.cleanerPayoutFloor),
      platformMarginPct: Number(body.platformMarginPct ?? 22),
      paymentFeeBuffer: Number(body.paymentFeeBuffer ?? 8),
      suppliesTravelBuffer: Number(body.suppliesTravelBuffer ?? 0),
      confidence: Number(body.confidence ?? 0.35),
      sourceCount: Number(body.sourceCount ?? 1),
      sources: Array.isArray(body.sources)
        ? body.sources.map(String).slice(0, 10)
        : ['manual_admin'],
      notes: String(body.notes || ''),
    };

    for (const key of ['marketLow', 'marketMedian', 'marketHigh', 'cleanerPayoutFloor']) {
      if (!Number.isFinite(patch[key]) || patch[key] <= 0) {
        return res.status(400).json({ ok: false, error: `${key} must be positive` });
      }
    }

    const row = await MarketRateProfile.findOneAndUpdate(
      { zip, service },
      { $set: { zip, service, ...patch } },
      { new: true, upsert: true, runValidators: true }
    );

    return res.json({ ok: true, row });
  } catch (err) {
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
};