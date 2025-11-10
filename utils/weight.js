// services/api/utils/weight.js  ✅ single export object
const gToLbOz = (g) => {
  const totalOz = g / 28.349523125;
  const lb = Math.floor(totalOz / 16);
  const oz = Math.round((totalOz - lb * 16) * 10) / 10;
  return { lb, oz };
};

const lbOzToG = ({ lb = 0, oz = 0 }) => {
  const totalOz = (Number(lb)||0) * 16 + (Number(oz)||0);
  return Math.round(totalOz * 28.349523125);
};

const tolerancePass = (actualG, expectedG, { absG = 50, pct = 0.015 } = {}) => {
  const tol = Math.max(absG, expectedG * pct);
  const variance = Math.round(actualG - expectedG);
  return { pass: Math.abs(variance) <= tol, variance, tol };
};

// per-SKU net grams
const SKU_WEIGHT_G = {
 'SH-REFILL': 500, 'CD-REFILL': 500, 'BW-BOTTLE': 500, 'HS-BOTTLE': 400, 'DS-BOTTLE': 500,
  'TP-ROLL': 95, 'PT-ROLL': 160, 'TL-PACK': 0, 'LD-BOTTLE': 800, 'CP-BOX12': 0, 'TB-BOX25': 0,
};

const DEFAULT_TOLERANCE_G = 10;
const DEFAULT_TOLERANCE_PCT = 0.02;

function getSkuWeightG(skuId) {
  return Number(SKU_WEIGHT_G[skuId] || 0);
}
function expectedForItem(item) {
  const base = getSkuWeightG(item.skuId) * Number(item.qty || 0);
  return Math.max(0, Math.round(base));
}
function ensureTolerance(item) {
  const tolG = Number(item.tolerance_g ?? DEFAULT_TOLERANCE_G);
  const tolPct = Number(item.tolerance_pct ?? DEFAULT_TOLERANCE_PCT);
  return { tolG, tolPct };
}
function fillExpectedOnOrder(order) {
  let total = 0;
  for (const it of order.items || []) {
    if (!it.expected_ship_weight_g || it.expected_ship_weight_g <= 0) {
      it.expected_ship_weight_g = expectedForItem(it);
    }
    const { tolG, tolPct } = ensureTolerance(it);
    it.tolerance_g = tolG;
    it.tolerance_pct = tolPct;
    total += Number(it.expected_ship_weight_g || 0);
  }
  return { totalExpectedG: total };
}
function distributePackedWeight(order, packedNetG) {
  const items = order.items || [];
  const sumExpected = items.reduce((s, it) => s + Number(it.expected_ship_weight_g || 0), 0);
  if (sumExpected <= 0) { for (const it of items) it.packed_weight_g = 0; return; }
  for (const it of items) {
    const share = (Number(it.expected_ship_weight_g || 0) / sumExpected) * packedNetG;
    it.packed_weight_g = Math.max(0, Math.round(share));
  }
}

module.exports = {
  gToLbOz,
  lbOzToG,
  tolerancePass,
  getSkuWeightG,
  expectedForItem,
  fillExpectedOnOrder,
  distributePackedWeight,
  DEFAULT_TOLERANCE_G,
  DEFAULT_TOLERANCE_PCT,
};
