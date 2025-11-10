// services/api/controllers/pricing.controller.js
const PricingConfig = require('../models/PricingConfig');
const { computeQuote } = require('../lib/quote');

// ↓↓↓ ADD this helper just below the existing requires
function normalizeStatesWithCodes(inputStates = {}) {
  // clone
  const states = { ...inputStates };

  // If someone sent UPPERCASE DEFAULT, normalize to 'default'
  if (states.DEFAULT && !states.default) {
    states.default = states.DEFAULT;
    delete states.DEFAULT;
  }

  // Ensure every state object has a .code (use its key as fallback)
  for (const k of Object.keys(states)) {
    const s = states[k] = { ...(states[k] || {}) };
    if (!s.code) s.code = k; // e.g., 'NC', 'FL', 'WA', 'default'
  }

  return states;
}


async function getOrCreate() {
  let doc = await PricingConfig.findOne({});
  if (!doc) {
    // seed with one default state e.g. NC
    doc = await PricingConfig.create({
      states: {
        NC: {
          code: 'NC',
          time: { base_minutes: 60, per_bed_minutes: 18, per_bath_minutes: 22, per_1000sqft_minutes: 12, min_minutes_floor: 60, max_minutes_cap: 600 },
          billing: { labor_hourly_cost: 22, margin_percent: 45, direct_billing_hourly_rate: 45, visit_fee: 0, min_job_value: 0, weekend_factor: 1.15, holiday_factor: 1.3, zip_factor_default: 1, rounding_step: 5, charm_style: '.99' },
        }
      }
    });
  }
  return doc;
}

exports.getConfig = async (req, res) => {
  const doc = await getOrCreate();
  res.json(doc);
};

// // --- REPLACE the whole function ---
// exports.replaceConfig = async (req, res) => {
//   try {
//     const input = req.body || {};
//     const body = input && input.config ? input.config : input;

//     const doc = await getOrCreate(); // your existing helper

//     // Only allowlisted fields update karo (defensive)
//     if (body.states && typeof body.states === 'object') {
//       doc.states = body.states;
//     }
//     if (body.multiVisit && typeof body.multiVisit === 'object') {
//       doc.multiVisit = body.multiVisit;
//     }
//     if (body.billing && typeof body.billing === 'object') {
//       doc.billing = body.billing;
//     }
//     if (body.addons && typeof body.addons === 'object') {
//       doc.addons = body.addons;
//     }

//     // OPTIONAL: strip UI-only placeholders if they slipped in
//     if (doc.states && doc.states.DEFAULT && !doc.states.DEFAULT.code) {
//       delete doc.states.DEFAULT;
//     }

//     await doc.save();
//     return res.json({ ok: true, updatedAt: doc.updatedAt });
//   } catch (err) {
//     console.error('replaceConfig error:', err);
//     return res.status(400).json({ ok: false, error: String(err.message || err) });
//   }
// };

// --- REPLACE the whole function ---
exports.replaceConfig = async (req, res) => {
  try {
    const input = req.body || {};
    const body = input && input.config ? input.config : input;

    const doc = await getOrCreate(); // keep existing helper

    // 1) STATES: sanitize + keep Map semantics so .get/.set keep working
    if (body.states && typeof body.states === 'object') {
      const s = normalizeStatesWithCodes(body.states);
      doc.states = new Map(Object.entries(s));
    }

    // 2) Other top-level pieces (optional / pass-through)
    if (body.multiVisit && typeof body.multiVisit === 'object') {
      doc.multiVisit = body.multiVisit;
    }
    if (body.billing && typeof body.billing === 'object') {
      doc.billing = body.billing;
    }
    if (body.addons && typeof body.addons === 'object') {
      doc.addons = body.addons;
    }

    await doc.save(); // will validate, now code is present
    return res.json({ ok: true, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error('replaceConfig error:', err);
    return res.status(400).json({ ok: false, error: String(err.message || err) });
  }
};



exports.addState = async (req, res) => {
  const { code, cloneFrom } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  const doc = await getOrCreate();
  if (doc.states.get(code)) return res.status(409).json({ error: 'state exists' });

  let base = doc.states.get(cloneFrom) || doc.states.get('NC');
  base = base ? base.toObject ? base.toObject() : base : {};
  doc.states.set(code, { ...base, code });
  await doc.save();
  res.json({ ok: true, state: doc.states.get(code) });
};

exports.deleteState = async (req, res) => {
  const { code } = req.params;
  const doc = await getOrCreate();
  if (!doc.states.get(code)) return res.status(404).json({ error: 'not found' });
  doc.states.delete(code);
  await doc.save();
  res.json({ ok: true });
};

exports.updateStatePatch = async (req, res) => {
  const { code } = req.params;
  const patch = req.body || {};
  const doc = await getOrCreate();
  const cur = doc.states.get(code);
  if (!cur) return res.status(404).json({ error: 'not found' });
  doc.states.set(code, { ...cur.toObject?.() ?? cur, ...patch });
  await doc.save();
  res.json({ ok: true, state: doc.states.get(code) });
};

exports.quote = async (req, res) => {
  const doc = await getOrCreate();
  try {
    const data = computeQuote(doc, req.body || {});
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};
