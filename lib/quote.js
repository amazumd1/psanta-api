// services/api/lib/quote.js
function minutesFrom(cfgState, { beds, baths, sqft }) {
  const t = cfgState.time;
  let m = t.base_minutes
    + (beds || 0) * t.per_bed_minutes
    + (baths || 0) * t.per_bath_minutes
    + Math.max(0, Math.ceil((Math.max(0, sqft || 0)) / 1000)) * t.per_1000sqft_minutes;
  m = Math.max(t.min_minutes_floor, Math.min(t.max_minutes_cap, m));
  return m;
}

function rateFrom(cfgState, { isWeekend, isHoliday, zip, zipFactorDefault = 1 }) {
  const b = cfgState.billing || {};
  const hourly =
    b.use_direct_rate
      ? Number(b.direct_billing_hourly_rate || 0)
      : Number(b.labor_hourly_cost || 0) * (1 + Number(b.margin_percent || 0) / 100);

  let mult = 1;
  if (isWeekend) mult *= Number(b.weekend_factor || 1);
  if (isHoliday) mult *= Number(b.holiday_factor || 1);

  // ---- ZIP factor (exact, prefix "*", 3-digit) ----
  let zipFactor = Number(zipFactorDefault || 1);

  if (cfgState && cfgState.zips) {
    const zobj =
      typeof cfgState.zips.get === 'function'
        ? Object.fromEntries(cfgState.zips)
        : (cfgState.zips || {});
    const zipStr = String(zip || '').trim();

    if (zobj[zipStr] != null) {
      zipFactor = Number(zobj[zipStr] || 1);
    } else {
      const keys = Object.keys(zobj);
      const found = keys.find(k => k && k.endsWith('*') && zipStr.startsWith(k.slice(0, -1)));
      if (found) {
        zipFactor = Number(zobj[found] || 1);
      } else {
        const zip3 = zipStr.slice(0, 3);
        if (zobj[zip3] != null) zipFactor = Number(zobj[zip3] || 1);
      }
    }
  }

  return hourly * mult * (zipFactor || 1);
}



function roundCharm(val, step, charm) {
  const s = step || 1;
  const base = Math.ceil(val / s) * s;   // ← ceil to step
  if (charm === '.99') return Math.floor(base) + 0.99;
  return base;
}


function getZipFactor(cfgState, zip, zipFactorDefault = 1) {
  let f = Number(zipFactorDefault || 1);
  if (cfgState && cfgState.zips) {
    const zobj =
      typeof cfgState.zips.get === 'function'
        ? Object.fromEntries(cfgState.zips)
        : (cfgState.zips || {});
    const zipStr = String(zip || '').trim();

    if (zobj[zipStr] != null) {
      f = Number(zobj[zipStr] || 1);
    } else {
      const keys = Object.keys(zobj);
      const found = keys.find(k => k && k.endsWith('*') && zipStr.startsWith(k.slice(0, -1)));
      if (found) {
        f = Number(zobj[found] || 1);
      } else {
        const zip3 = zipStr.slice(0, 3);
        if (zobj[zip3] != null) f = Number(zobj[zip3] || 1);
      }
    }
  }
  return f || 1;
}


function computeQuote(cfg, input) {
  const state = String(input.state || '').toUpperCase() || 'NC';
  const s = cfg.states.get ? cfg.states.get(state) : cfg.states[state];
  if (!s) throw new Error(`State ${state} not found`);

  const minutes = minutesFrom(s, input);
  const hours = minutes / 60;
  const hourly = rateFrom(s, input);
  const visitFee = s.billing.visit_fee || 0;

  let raw = hours * hourly + visitFee;
  if (raw < (s.billing.min_job_value || 0)) raw = s.billing.min_job_value;

  const total = roundCharm(raw, s.billing.rounding_step || 1, s.billing.charm_style || '.99');
const zipFactor = getZipFactor(s, input.zip, 1);
  return {
    total,
    breakdown: {
      minutes,
      hours: +hours.toFixed(2),
      effective_rate: +hourly.toFixed(2),
      visitFee,
      zipFactor,
      leadTimeFactor: 1,
      demandFactor: 1,
      addonsTotal: 0
    }
  };
}

module.exports = { computeQuote };
