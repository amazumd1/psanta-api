const { resolveCanonicalBiCategory } = require('./biCategories');
const { resolveCategoryMemoryMatch } = require('./biCategoryMemoryService');

function dedupe(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [values]).map((item) => String(item || '').trim()).filter(Boolean)));
}

function countMatches(text = '', regex) {
  const matches = String(text || '').match(regex);
  return Array.isArray(matches) ? matches.length : 0;
}

function deriveHeuristicSignals(haystack = '') {
  const signals = [];
  const add = (value) => {
    if (!signals.includes(value)) signals.push(value);
  };

  if (/(1099|w-9|w9|irs|nec form|tax document|contractor payment)/i.test(haystack)) add('contractor_1099');
  if (/(airbnb|vrbo|booking\.com|host payout|reservation payout|rent payment|rental payout|income statement)/i.test(haystack)) add('rental_income');
  if (/(invoice paid|payment received|revenue|sales income|deposit)/i.test(haystack)) add('business_income');
  if (/(utility|water bill|electric bill|power bill|gas bill|internet bill|phone bill|trash|sewer)/i.test(haystack)) add('utilities');
  if (/(maintenance|repair|plumbing|hvac|electrical repair|service call|landscaping|pest control|roof repair)/i.test(haystack)) add('maintenance');
  if (/(legal invoice|accounting fee|consulting invoice|professional fee|attorney|bookkeeping|cpa)/i.test(haystack)) add('professional_fees');
  if (/(insurance|policy premium|coverage invoice)/i.test(haystack)) add('insurance');
  if (/(software|subscription|saas|google workspace|microsoft|openai|chatgpt|quickbooks|xero|slack|zoom|notion|adobe)/i.test(haystack)) add('software');
  if (/(travel|hotel|flight|airline|uber|lyft|marriott|hilton|lodging)/i.test(haystack)) add('travel');
  if (/(amazon|staples|office depot|supply order|equipment|tools|hardware|lowe's|home depot|costco|walmart)/i.test(haystack)) add('supplies_equipment');
  if (/(payroll|salary|wages|employee pay|timesheet)/i.test(haystack)) add('payroll');
  if (/(incident|issue|ticket|leak|alert|failure|urgent|critical)/i.test(haystack)) add('incident_issue');
  if (/(temperature|thermostat|sensor|degrees|climate)/i.test(haystack)) add('temperature_monitoring');
  if (/((^|[^a-z])ph([^a-z]|$)|soil|crop|water test)/i.test(haystack)) add('field_crop_reading');
  if (/(photo|image|screenshot|pdf|attachment|evidence)/i.test(haystack)) add('photo_evidence');
  if (/(invoice|statement|bill|receipt|amount due|vendor|expense)/i.test(haystack)) add('other_business_expense');
  return signals;
}

function deriveConfidence(score = 0) {
  if (score >= 8) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

function categorizeBusinessSignal({
  currentCategory = '',
  text = '',
  senderEmail = '',
  senderDomain = '',
  amount = null,
  memory = {},
  explicitCategory = '',
} = {}) {
  const haystack = [currentCategory, explicitCategory, senderEmail, senderDomain, text]
    .filter(Boolean)
    .join(' \n ')
    .toLowerCase();

  const reasons = [];
  let score = 0;

  const memoryMatch = resolveCategoryMemoryMatch(memory, { senderEmail, senderDomain, text: haystack });
  if (memoryMatch?.category) {
    return {
      category: memoryMatch.category,
      confidence: memoryMatch.confidence === 'learned_high' ? 'high' : 'medium',
      score: memoryMatch.confidence === 'learned_high' ? 9 : 7,
      reasons: memoryMatch.reasons,
      source: `memory:${memoryMatch.matchedBy}`,
      signals: [],
    };
  }

  const direct = resolveCanonicalBiCategory({
    value: explicitCategory || currentCategory,
    text: haystack,
    fallbackLabel: 'General Ops',
  });

  const signals = deriveHeuristicSignals(haystack);
  if (signals.length) {
    score += Math.min(4, signals.length);
    reasons.push(`Signal hits: ${signals.slice(0, 4).join(', ')}`);
  }

  const amountHits = countMatches(haystack, /\$\s?\d[\d,]*(?:\.\d{2})?/g);
  if (amountHits > 0 || (typeof amount === 'number' && Number.isFinite(amount) && amount > 0)) {
    score += 1;
    reasons.push('Amount-like data present');
  }

  const attachmentHits = countMatches(haystack, /(pdf|csv|xlsx?|attachment|statement|invoice copy|receipt image)/gi);
  if (attachmentHits > 0) {
    score += 1;
    reasons.push('Attachment-style evidence present');
  }

  const negativeHits = countMatches(haystack, /(coupon|promo|newsletter|deal alert|marketing|unsubscribe|survey|discount)/gi);
  if (negativeHits > 0) {
    score -= Math.min(2, negativeHits);
    reasons.push('Marketing-like language reduced confidence');
  }

  let category = direct?.label || '';
  if (!category) {
    const signalText = signals.join(' ');
    category = resolveCanonicalBiCategory({
      text: [haystack, signalText].join(' \n '),
      fallbackLabel: 'General Ops',
    })?.label || 'General Ops';
  }

  return {
    category,
    confidence: deriveConfidence(score),
    score,
    reasons: dedupe(reasons),
    source: direct?.label ? 'canonical' : 'heuristic',
    signals,
  };
}

module.exports = {
  dedupe,
  countMatches,
  deriveHeuristicSignals,
  categorizeBusinessSignal,
};