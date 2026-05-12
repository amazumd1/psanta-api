// services/api/lib/googleMarketSuggestions.js
// Market-rate search suggestions powered by Serper.dev first, with Google CSE fallback.
// The exported name is kept for compatibility with pricing.controller.js.

let fetchFn = global.fetch;
if (!fetchFn) {
  try { fetchFn = require('node-fetch'); } catch { fetchFn = null; }
}

const GOOGLE_CSE_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';
const SERPER_ENDPOINT = 'https://google.serper.dev/search';
const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const FIRECRAWL_SCRAPE_ENDPOINT = 'https://api.firecrawl.dev/v1/scrape';
const DEFAULT_BATCH_SERVICES = ['turnover_clean', 'standard_clean', 'deep_clean', 'move_out_clean'];

const REVIEW_CONFIDENCE_THRESHOLD = 0.75;

const ZIP_LOCATION_HINTS = {
  '33140': {
    city: 'Miami Beach',
    state: 'FL',
    aliases: ['miami beach', 'south beach', 'north beach', 'mid beach', 'miami-dade', 'miami'],
  },
  '33334': {
    city: 'Fort Lauderdale',
    state: 'FL',
    aliases: ['fort lauderdale', 'oakland park', 'wilton manors', 'pompano beach', 'broward'],
  },
  '33076': {
    city: 'Parkland',
    state: 'FL',
    aliases: ['parkland', 'coral springs', 'coconut creek', 'boca raton', 'broward'],
  },
};

const KNOWN_CITY_TERMS = [
  'miami beach', 'south beach', 'miami', 'fort lauderdale', 'oakland park', 'wilton manors',
  'pompano beach', 'parkland', 'coral springs', 'boca raton', 'hollywood', 'west palm beach',
  'orlando', 'tampa', 'jacksonville', 'naples', 'sarasota', 'clearwater', 'st petersburg',
  'atlanta', 'charlotte', 'raleigh', 'new york', 'los angeles', 'dallas', 'houston', 'chicago',
  'oakland', 'san francisco', 'berkeley',
  'davenport', 'kissimmee', 'orlando', 'tampa', 'clearwater', 'st petersburg',
];

const SOCIAL_DOMAINS = [
  'facebook.com', 'reddit.com', 'x.com', 'twitter.com', 'instagram.com', 'tiktok.com',
  'threads.net', 'pinterest.com', 'quora.com', 'nextdoor.com', 'youtube.com',
  'community.withairbnb.com', 'community.airbnb.com',
];

const MARKETPLACE_DOMAINS = [
  'thumbtack.com', 'angi.com', 'angieslist.com', 'homeadvisor.com', 'taskrabbit.com',
  'care.com', 'yelp.com', 'houzz.com', 'bark.com', 'porch.com',
];

const LOW_TRUST_DOMAINS = [
  'facebook.com', 'reddit.com', 'quora.com', 'nextdoor.com', 'pinterest.com',
  'community.withairbnb.com', 'community.airbnb.com',
];

const BROAD_GUIDE_DOMAINS = [
  'homeguide.com', 'airroi.com', 'leadduo.io', 'homeaglow.com', 'airdna.co',
  'rental-scale-up.com', 'rentalscaleup.com', 'turno.com', 'beyondpricing.com',
];

const SERVICE_PRICE_RULES = {
  turnover_clean: {
    minCustomerPrice: 105,
    softLow: 140,
    softHigh: 220,
    hardHigh: 340,
    strongWords: /\b(airbnb|vacation\s*rental|short\s*term\s*rental|str|turnover|checkout|check-out|guest\s*ready)\b/i,
    mismatchWords: /\b(deep\s*clean|deep-clean|move\s*out|move-out|move\s*in|move-in|post[-\s]?construction|construction\s*clean)\b/i,
  },
  standard_clean: {
    minCustomerPrice: 80,
    softLow: 115,
    softHigh: 260,
    hardHigh: 360,
    strongWords: /\b(standard\s*clean|regular\s*clean|recurring\s*clean|house\s*cleaning|maid\s*service|home\s*cleaning)\b/i,
    mismatchWords: /\b(airbnb|vacation\s*rental|turnover|deep\s*clean|move\s*out|move-out|post[-\s]?construction)\b/i,
  },
  deep_clean: {
    minCustomerPrice: 130,
    softLow: 180,
    softHigh: 430,
    hardHigh: 650,
    strongWords: /\b(deep\s*clean|deep-clean|detail\s*clean|spring\s*clean|heavy\s*clean|baseboards?|inside\s*cabinets?)\b/i,
    mismatchWords: /\b(airbnb\s*turnover|turnover\s*clean|checkout|move\s*out|move-out)\b/i,
  },
  move_out_clean: {
    minCustomerPrice: 150,
    softLow: 220,
    softHigh: 560,
    hardHigh: 800,
    strongWords: /\b(move\s*out|move-out|move\s*in|move-in|vacancy|tenant\s*turnover|rental\s*turnover)\b/i,
    mismatchWords: /\b(airbnb|vacation\s*rental|short\s*term|standard\s*clean|recurring\s*clean)\b/i,
  },
};

const PREMIUM_ZIP_SERVICE_FLOORS = {
  '33140': { turnover_clean: 150, standard_clean: 145, deep_clean: 215, move_out_clean: 235 },

  // 33334 should not force standard/STR lows too high.
  // Let exact Oakland Park/Fort Lauderdale pages decide the real low.
  '33334': { turnover_clean: 100, standard_clean: 95, deep_clean: 190, move_out_clean: 215 },

  '33076': { turnover_clean: 135, standard_clean: 130, deep_clean: 185, move_out_clean: 210 },
};

const COST_FLOOR_PATTERNS = [
  /\bcost\s*floor\b/i,
  /\bnever\s+set\s+(?:your\s+)?(?:cleaning\s+fee\s+)?below\b/i,
  /\bminimum\s+(?:payout|pay|wage|rate|floor)\b/i,
  /\bcleaner\s+(?:payout|pay|cost|wage|rate)\b/i,
  /\byour\s+cost\b/i,
  /\blabor\s+cost\b/i,
  /\bactual\s+cost\b/i,
];

const LARGE_PROPERTY_PATTERNS = [
  /\b(4\+?|5|6|7|8)\s*(?:bed|bedroom|br|bd)\b/i,
  /\b(?:large|luxury|resort|villa|estate|mansion|pool\s*home)\b/i,
  /\b(?:add[-\s]?ons?|extra\s*services?|premium\s*package|full\s*service)\b/i,
];

// These are not hard-coded prices. They only influence trust/scoring
// so exact local vendor/service pages beat broad or mixed pages.
const HIGH_TRUST_VENDOR_DOMAINS = [
  'thefloridamaid.com',
  'miamiexpcleaning.com',
  'karmamaids.com',
];

const HIGH_TRUST_GUIDE_DOMAINS = [
  'homeguide.com',
];

const SERVICE_URL_KEYWORDS = {
  turnover_clean: /(?:airbnb|vacation[-\s]?rental|short[-\s]?term|turnover|checkout|str)/i,
  standard_clean: /(?:maid[-\s]?service|house[-\s]?cleaning|home[-\s]?cleaning|standard|regular|recurring)/i,
  deep_clean: /(?:deep[-\s]?clean|deep[-\s]?cleaning|spring[-\s]?clean|detail[-\s]?clean)/i,
  move_out_clean: /(?:move[-\s]?(?:in|out)|move[-\s]?in[-\s]?move[-\s]?out|vacancy|tenant[-\s]?turnover)/i,
};

const CLEANER_FLOOR_POLICY = {
  turnover_clean: { min: 90, pctOfMedian: 0.62 },
  standard_clean: { min: 85, pctOfMedian: 0.58 },
  deep_clean: { min: 130, pctOfMedian: 0.48 },
  move_out_clean: { min: 150, pctOfMedian: 0.45 },
};

function normalizeZip(zip) {
  const m = String(zip || '').match(/\b\d{5}\b/);
  return m ? m[0] : '';
}

function normalizeService(serviceType) {
  const raw = String(serviceType || '').toLowerCase().trim();
  if (raw.includes('deep')) return 'deep_clean';
  if (raw.includes('move')) return 'move_out_clean';
  if (raw.includes('turnover') || raw.includes('str') || raw.includes('airbnb') || raw.includes('vacation')) return 'turnover_clean';
  return 'standard_clean';
}

function serviceLabel(service) {
  switch (normalizeService(service)) {
    case 'turnover_clean': return 'STR Turnover Clean';
    case 'deep_clean': return 'Deep Clean';
    case 'move_out_clean': return 'Move-out Clean';
    default: return 'Standard Clean';
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function median(values = []) {
  const arr = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function percentile(values = [], p = 0.5) {
  const arr = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!arr.length) return 0;
  if (arr.length === 1) return arr[0];
  const idx = (arr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const weight = idx - lo;
  return arr[lo] * (1 - weight) + arr[hi] * weight;
}

function weightedPercentile(items = [], p = 0.5) {
  const arr = items
    .map((item) => ({ value: Number(item.price), weight: Math.max(0, Number(item.weight || 0)) }))
    .filter((item) => Number.isFinite(item.value) && item.value > 0 && item.weight > 0)
    .sort((a, b) => a.value - b.value);

  if (!arr.length) return 0;
  const totalWeight = arr.reduce((sum, item) => sum + item.weight, 0);
  const target = totalWeight * clamp(p, 0, 1);
  let running = 0;

  for (const item of arr) {
    running += item.weight;
    if (running >= target) return item.value;
  }
  return arr[arr.length - 1].value;
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function locationContext({ zip, city, state }) {
  const cleanZip = normalizeZip(zip);
  const seeded = ZIP_LOCATION_HINTS[cleanZip];
  const cleanCity = String(city || seeded?.city || '').trim();
  const cleanState = String(state || seeded?.state || '').trim().toUpperCase();
  const aliases = [
    ...(seeded?.aliases || []),
    cleanCity,
  ]
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean);

  return {
    zip: cleanZip,
    city: cleanCity,
    state: cleanState,
    label: [cleanCity, cleanState].filter(Boolean).join(', '),
    aliases: [...new Set(aliases)],
  };
}

function inferCityState({ zip, city, state }) {
  const ctx = locationContext({ zip, city, state });
  return ctx.label || [city, state].filter(Boolean).join(', ');
}

function serviceTerms(service) {
  switch (normalizeService(service)) {
    case 'turnover_clean':
      return ['Airbnb turnover cleaning', 'vacation rental cleaning', 'short term rental cleaning'];
    case 'deep_clean':
      return ['deep house cleaning', 'deep cleaning service'];
    case 'move_out_clean':
      return ['move out cleaning', 'move in move out cleaning'];
    default:
      return ['house cleaning', 'maid service'];
  }
}

function marketQueryLimit() {
  return num(
    process.env.MARKET_SEARCH_QUERY_LIMIT ||
    process.env.TAVILY_MARKET_QUERY_LIMIT ||
    process.env.SERPER_MARKET_QUERY_LIMIT ||
    process.env.GOOGLE_CSE_MARKET_QUERY_LIMIT,
    5
  );
}

function resultsPerQuery() {
  return clamp(
    num(
      process.env.MARKET_SEARCH_RESULTS_PER_QUERY ||
      process.env.TAVILY_RESULTS_PER_QUERY ||
      process.env.SERPER_RESULTS_PER_QUERY ||
      process.env.GOOGLE_CSE_RESULTS_PER_QUERY,
      5
    ),
    1,
    10
  );
}

function buildQueries({ zip, service, city, state }) {
  const ctx = locationContext({ zip, city, state });
  const loc = ctx.label || inferCityState({ zip, city, state });
  const terms = serviceTerms(service);
  const serviceName = normalizeService(service);
  const aliases = [ctx.city, ...(ctx.aliases || [])]
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  const primaryLocalNames = [...new Set(aliases)].slice(0, serviceName === 'turnover_clean' ? 4 : 3);

  const q = [];

  if (loc) q.push(`${loc} ${terms[0]} pricing`);
  if (ctx.zip) q.push(`${ctx.zip} ${terms[0]} price`);

  for (const localName of primaryLocalNames) {
    q.push(`${localName} ${terms[0]} cost`);
  }

  if (terms[1]) q.push(`${ctx.zip} ${terms[1]} rates`);
  if (loc && terms[2]) q.push(`${loc} ${terms[2]} pricing`);

  // Exact phrase searches help discover service-specific vendor pages instead of
  // generic blog snippets that mix standard/deep/move-out prices together.
  if (ctx.city) q.push(`"${ctx.city}" "${terms[0]}" "pricing"`);

  if (serviceName === 'deep_clean') q.push(`${ctx.zip} deep cleaning service price range`);
  if (serviceName === 'move_out_clean') q.push(`${ctx.zip} move out cleaning service price range`);
  if (serviceName === 'turnover_clean') q.push(`${ctx.zip} Airbnb cleaning turnover fee`);

  return [...new Set(q.filter(Boolean))].slice(0, marketQueryLimit());
}

function isHourlyContext(text) {
  return /\b(hourly|per\s*hour|\/\s*hr|\bhr\b|hour)\b/i.test(text || '');
}

function contextAround(text = '', start = 0, end = start, radius = 130) {
  const clean = String(text || '');
  const a = Math.max(0, start - radius);
  const b = Math.min(clean.length, end + radius);
  return clean.slice(a, b).replace(/\s+/g, ' ').trim();
}

function priceFlagsForContext(context = '', service = 'standard_clean') {
  const t = String(context || '').toLowerCase();
  const rules = SERVICE_PRICE_RULES[normalizeService(service)] || SERVICE_PRICE_RULES.standard_clean;

  return {
    costFloor: COST_FLOOR_PATTERNS.some((re) => re.test(t)),
    serviceStrong: rules.strongWords ? rules.strongWords.test(t) : false,
    serviceMismatch: rules.mismatchWords ? rules.mismatchWords.test(t) : false,
    largeProperty: LARGE_PROPERTY_PATTERNS.some((re) => re.test(t)),
    hourly: isHourlyContext(t),
    rangeContext: /\b(range|between|from|to|starts?\s*at|starting\s*at|average|typical|usually|per\s*turnover|per\s*clean)\b/i.test(t),
  };
}

function extractPriceSignals({ title = '', snippet = '', link = '', query = '', service = '' }) {
  const text = `${title} ${snippet}`;
  const signals = [];

  const patterns = [
    /(?:\$|usd\s*)\s*([1-9]\d{1,3})(?:\.\d{2})?/gi,
    /\b([1-9]\d{1,3})\s*(?:dollars|usd)\b/gi,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const price = Number(m[1]);
      if (!Number.isFinite(price)) continue;
      if (price < 55 || price > 950) continue;

      const priceContext = contextAround(text, m.index, m.index + m[0].length);
      const flags = priceFlagsForContext(priceContext, service);
      const serviceName = normalizeService(service);

      const urlServiceMatch = serviceKeywordMatch(link, serviceName);
      const titleServiceMatch = serviceKeywordMatch(title, serviceName);
      const contextServiceMatch = serviceKeywordMatch(priceContext, serviceName);

      flags.serviceStrong = !!(
        flags.serviceStrong ||
        urlServiceMatch ||
        titleServiceMatch ||
        contextServiceMatch
      );

      // If the URL/title is an exact service page, do not let unrelated nav/footer words
      // in a long Firecrawl page mark the price as a mismatch.
      flags.serviceMismatch = !!(flags.serviceMismatch && !urlServiceMatch && !titleServiceMatch);

      // Hourly or cleaner-side cost-floor signals are not customer-facing package prices.
      // Keep them only if they are clearly large customer prices, otherwise reject early.
      if (price < 90 && (flags.hourly || flags.costFloor)) continue;

      signals.push({
        price,
        title,
        link,
        domain: domainFromUrl(link),
        snippet,
        query,
        priceContext,
        flags,
        serviceMatch: {
          urlServiceMatch,
          titleServiceMatch,
          contextServiceMatch,
        },
      });
    }
  }

  return signals;
}

function sourceTypeForDomain(domain = '') {
  const d = String(domain || '').toLowerCase();
  if (SOCIAL_DOMAINS.some((x) => d === x || d.endsWith(`.${x}`))) return 'social';
  if (MARKETPLACE_DOMAINS.some((x) => d === x || d.endsWith(`.${x}`))) return 'marketplace';
  return 'vendor_or_web';
}

function sourceBaseWeight(domain = '') {
  const type = sourceTypeForDomain(domain);
  if (type === 'social') return 0.38;
  if (type === 'marketplace') return 0.72;
  return 0.95;
}

function looksLikeVendorPricingPage({ title = '', snippet = '', domain = '' }) {
  const text = `${domain} ${title} ${snippet}`.toLowerCase();
  if (sourceTypeForDomain(domain) !== 'vendor_or_web') return false;
  return /\b(cleaning|maid|housekeeping|janitorial)\b/.test(text) &&
    /\b(pricing|rates?|cost|starts?\s*at|service|airbnb|vacation\s*rental|short\s*term)\b/.test(text);
}

function priceContextScore(text, service) {
  const t = String(text || '').toLowerCase();
  let score = 0;

  if (/\b(per\s*clean|per\s*cleaning|per\s*turnover|turnover|checkout|check-out)\b/i.test(t)) score += 0.22;
  if (/\b(starts?\s*at|starting\s*at|prices?\s*start|pricing|rates?|cost)\b/i.test(t)) score += 0.15;
  if (/\b(cleaning|cleaner|maid|housekeeping)\b/i.test(t)) score += 0.12;

  if (service === 'turnover_clean' && /\b(airbnb|vacation\s*rental|short\s*term\s*rental|str)\b/i.test(t)) score += 0.2;
  if (service === 'deep_clean' && /\bdeep\b/i.test(t)) score += 0.18;
  if (service === 'move_out_clean' && /\bmove\s*(out|in)|move-in|move-out\b/i.test(t)) score += 0.18;

  if (/\b(monthly|weekly|subscription|salary|annual|yearly)\b/i.test(t)) score -= 0.22;
  if (isHourlyContext(t)) score -= 0.25;

  return clamp(score, -0.35, 0.6);
}

function locationQuality({ title = '', snippet = '', link = '' }, ctx) {
  const text = `${title} ${snippet} ${link}`.toLowerCase();
  const aliases = ctx.aliases || [];
  const hasTarget = aliases.some((alias) => alias && text.includes(alias));
  const hasZip = ctx.zip && text.includes(ctx.zip);
  let mentionedOtherCities = KNOWN_CITY_TERMS.filter((city) => text.includes(city) && !aliases.includes(city));

  // ZIP 33334 can mean Oakland Park, FL — but plain "Oakland" search results are
  // usually Oakland, CA and should not be treated as local Broward/Fort Lauderdale data.
  if (ctx.zip === '33334' && !hasTarget && !hasZip && hasStandaloneOaklandNotPark(text)) {
    mentionedOtherCities = [...new Set([...mentionedOtherCities, 'oakland'])];
    return { status: 'wrong_city_low_weight', multiplier: 0.04, otherCities: mentionedOtherCities };
  }

  if (hasZip) {
    return { status: 'zip_match', multiplier: 1.18, otherCities: mentionedOtherCities };
  }

  if (hasTarget) {
    const conflictingOtherCities = mentionedOtherCities.filter((city) => !(ctx.zip === '33334' && city === 'oakland' && text.includes('oakland park')));
    if (conflictingOtherCities.length) return { status: 'mixed_location', multiplier: 0.72, otherCities: conflictingOtherCities };
    return { status: 'city_match', multiplier: 1.08, otherCities: [] };
  }

  if (mentionedOtherCities.length) {
    return { status: 'wrong_city_low_weight', multiplier: 0.18, otherCities: mentionedOtherCities };
  }

  return { status: 'unknown_location', multiplier: 0.58, otherCities: [] };
}

function normalizeUrlKey(url = '') {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return String(url || '').trim().toLowerCase();
  }
}

function servicePriceRules(service) {
  return SERVICE_PRICE_RULES[normalizeService(service)] || SERVICE_PRICE_RULES.standard_clean;
}

function domainMatchesAny(domain = '', list = []) {
  const d = String(domain || '').toLowerCase();
  return list.some((x) => d === x || d.endsWith(`.${x}`));
}

function serviceKeywordMatch(text = '', service = 'standard_clean') {
  const re = SERVICE_URL_KEYWORDS[normalizeService(service)] || SERVICE_URL_KEYWORDS.standard_clean;
  return re.test(String(text || '').toLowerCase());
}

function sourceTrustBoost(domain = '') {
  // Vendor trust can be global, but guide trust must stay conservative.
  // HomeGuide has both useful local city pages and broad national Airbnb guides;
  // the stronger HomeGuide boost is applied later only when the page is local.
  if (domainMatchesAny(domain, ['thefloridamaid.com'])) return 0.42;
  if (domainMatchesAny(domain, HIGH_TRUST_VENDOR_DOMAINS)) return 0.32;
  if (domainMatchesAny(domain, ['homeguide.com'])) return 0.10;
  if (domainMatchesAny(domain, HIGH_TRUST_GUIDE_DOMAINS)) return 0.08;
  return 0;
}

function hasStandaloneOaklandNotPark(text = '') {
  const t = String(text || '').toLowerCase();
  return /\boakland\b(?!\s+park\b)/i.test(t);
}

function hasTargetLocationText(text = '', ctx = {}) {
  const t = String(text || '').toLowerCase();
  const aliases = ctx.aliases || [];
  return !!((ctx.zip && t.includes(ctx.zip)) || aliases.some((alias) => alias && t.includes(alias)));
}

function exactServicePageBoost(domain = '', sample = {}, service = 'standard_clean', ctx = {}) {
  const serviceName = normalizeService(service);
  const urlTitle = `${sample.link || sample.url || ''} ${sample.title || ''}`.toLowerCase();
  const pageText = `${urlTitle} ${sample.snippet || ''}`.toLowerCase();
  const localPage = hasTargetLocationText(pageText, ctx);
  let boost = 0;

  if (domainMatchesAny(domain, ['thefloridamaid.com']) && serviceKeywordMatch(urlTitle, serviceName)) {
    boost += localPage ? 0.38 : 0.22;
  }

  // Only boost HomeGuide when the page is actually local to the ZIP/city.
  // Generic Airbnb national guides should remain weak reference material, not market median drivers.
  if (domainMatchesAny(domain, ['homeguide.com']) && localPage && serviceKeywordMatch(pageText, serviceName)) {
    boost += 0.22;
  }

  if (serviceName === 'move_out_clean' && /\bmove[-\s]?(?:in[-\s]?)?move[-\s]?out|move[-\s]?out|move[-\s]?in\b/i.test(urlTitle)) {
    boost += localPage || domainMatchesAny(domain, ['thefloridamaid.com']) ? 0.38 : 0.18;
  }

  if (serviceName === 'deep_clean' && /\bdeep[-\s]?clean(?:ing)?\b/i.test(urlTitle)) {
    boost += localPage ? 0.26 : 0.14;
  }

  if (serviceName === 'turnover_clean' && /\b(?:airbnb|vacation[-\s]?rental|short[-\s]?term|turnover)\b/i.test(urlTitle)) {
    boost += localPage ? 0.22 : 0.08;
  }

  return clamp(boost, 0, 0.62);
}

function priceSignalPrecheck(signal = {}, service = 'standard_clean') {
  const serviceName = normalizeService(service);
  const rules = servicePriceRules(serviceName);
  const price = Number(signal.price || 0);
  const flags = signal.flags || {};

  const text = `${signal.title || ''} ${signal.link || ''} ${signal.query || ''} ${signal.priceContext || ''}`;

  const urlServiceMatch = serviceKeywordMatch(signal.link || '', serviceName);
  const contextServiceMatch = serviceKeywordMatch(signal.priceContext || '', serviceName);
  const titleServiceMatch = serviceKeywordMatch(signal.title || '', serviceName);

  const strongServiceMatch = !!(
    flags.serviceStrong ||
    urlServiceMatch ||
    contextServiceMatch ||
    titleServiceMatch
  );

  const reasons = [];

  if (!Number.isFinite(price) || price <= 0) reasons.push('invalid_price');
  if (flags.costFloor) reasons.push('cleaner_or_labor_cost_not_customer_price');
  if (flags.hourly && price < rules.softLow) reasons.push('hourly_price_not_package_price');
  if (flags.serviceMismatch && !strongServiceMatch) reasons.push('wrong_service_context');

  if ((serviceName === 'deep_clean' || serviceName === 'move_out_clean') && !strongServiceMatch && price < rules.softLow) {
    reasons.push('weak_service_match_below_service_floor');
  }

  if (serviceName === 'standard_clean' && flags.serviceMismatch) {
    reasons.push('standard_mixed_with_premium_service');
  }

  if (price < rules.minCustomerPrice && !strongServiceMatch) {
    reasons.push('below_customer_market_minimum');
  }

  if (price > rules.hardHigh) {
    reasons.push('above_hard_outlier_cap');
  }

  return {
    keep: reasons.length === 0,
    reasons,
    strongServiceMatch,
    urlServiceMatch,
    contextServiceMatch,
    titleServiceMatch,
    textMatched: serviceKeywordMatch(text, serviceName),
  };
}

function sourceRangeLow(signal = {}) {
  const prices = Array.isArray(signal.prices) ? signal.prices : [signal.price];
  const clean = prices
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  return clean.length ? clean[0] : Number(signal.price || 0);
}

function sourceRangeHigh(signal = {}) {
  const prices = Array.isArray(signal.prices) ? signal.prices : [signal.price];
  const clean = prices
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  return clean.length ? clean[clean.length - 1] : Number(signal.price || 0);
}

function estimateCleanerPayoutFloor({ marketMedian, service, ctx }) {
  const serviceName = normalizeService(service);
  const policy = CLEANER_FLOOR_POLICY[serviceName] || CLEANER_FLOOR_POLICY.standard_clean;

  const zipMinimum = {
    '33140': { turnover_clean: 105, standard_clean: 105, deep_clean: 150, move_out_clean: 175 },
    '33334': { turnover_clean: 95, standard_clean: 95, deep_clean: 145, move_out_clean: 175 },
    '33076': { turnover_clean: 95, standard_clean: 95, deep_clean: 145, move_out_clean: 170 },
  }[ctx?.zip || '']?.[serviceName];

  const raw = Math.max(
    Number(policy.min || 0),
    Number(zipMinimum || 0),
    Number(marketMedian || 0) * Number(policy.pctOfMedian || 0.55)
  );

  // Keep cleaner floor below customer median so guardrails still have room for margin.
  const capped = Math.min(raw, Number(marketMedian || 0) * 0.72);

  return Math.max(0, Math.round(capped / 5) * 5);
}

function premiumFloorFor(ctx, service) {
  const zip = ctx?.zip || '';
  return PREMIUM_ZIP_SERVICE_FLOORS[zip]?.[normalizeService(service)] || 0;
}

function hasAnyFlag(group, key) {
  return (group.rawSignals || []).some((signal) => !!signal.flags?.[key]);
}

function groupContextText(group) {
  const sample = group.sample || {};
  const signalContexts = (group.rawSignals || []).map((s) => s.priceContext || '').join(' ');
  return `${sample.title || ''} ${sample.snippet || ''} ${signalContexts}`.toLowerCase();
}

function isBroadGuideDomain(domain = '') {
  const d = String(domain || '').toLowerCase();
  return BROAD_GUIDE_DOMAINS.some((x) => d === x || d.endsWith(`.${x}`));
}

function servicePolicyForGroupedSignal({ group, ctx, service, representativePrice, location, vendorPricingPage, sourceType }) {
  const rules = servicePriceRules(service);
  const serviceName = normalizeService(service);
  const sample = group.sample || {};
  const domain = sample.domain || domainFromUrl(sample.link || sample.url);
  const text = groupContextText(group);
  const exactLocation = ['zip_match', 'city_match'].includes(location.status);
  const mixedLocation = location.status === 'mixed_location';
  const wrongCity = location.status === 'wrong_city_low_weight';
  const unknownLocation = location.status === 'unknown_location';
  const broadGuide = isBroadGuideDomain(domain);

  const flags = {
    costFloor: hasAnyFlag(group, 'costFloor') || COST_FLOOR_PATTERNS.some((re) => re.test(text)),
    serviceStrong: hasAnyFlag(group, 'serviceStrong') || !!rules.strongWords?.test(text),
    serviceMismatch: hasAnyFlag(group, 'serviceMismatch') || !!rules.mismatchWords?.test(text),
    largeProperty: hasAnyFlag(group, 'largeProperty') || LARGE_PROPERTY_PATTERNS.some((re) => re.test(text)),
    broadGuide,
    belowCustomerMinimum: representativePrice < rules.minCustomerPrice,
    belowSoftLow: representativePrice < rules.softLow,
    aboveSoftHigh: representativePrice > rules.softHigh,
    aboveHardHigh: representativePrice > rules.hardHigh,
    exactLocation,
    mixedLocation,
    wrongCity,
    unknownLocation,
  };

  const reasons = [];
  let multiplier = 1;
  let exclude = false;

  if (flags.costFloor) {
    multiplier *= 0.12;
    reasons.push('cost_floor_or_cleaner_side_price');
  }

  if (flags.serviceMismatch) {
    multiplier *= 0.18;
    reasons.push('service_context_mismatch');
  }

  if (serviceName === 'turnover_clean' && !flags.serviceStrong) {
    multiplier *= 0.72;
    reasons.push('weak_turnover_context');
  }

  if (flags.wrongCity) {
    multiplier *= 0.06;
    reasons.push('wrong_city');
    if (!flags.serviceStrong || broadGuide) exclude = true;
  } else if (flags.mixedLocation) {
    multiplier *= 0.48;
    reasons.push('mixed_location');
  } else if (flags.unknownLocation && broadGuide) {
    multiplier *= 0.55;
    reasons.push('broad_unknown_location_guide');
  }

  if (serviceName === 'turnover_clean' && broadGuide && flags.unknownLocation && representativePrice >= 220) {
    multiplier *= 0.08;
    reasons.push('generic_airbnb_guide_high_price');
    exclude = true;
  }

  if (flags.belowCustomerMinimum) {
    multiplier *= 0.08;
    reasons.push('below_customer_market_minimum');
    if (flags.costFloor || broadGuide || !exactLocation) exclude = true;
  } else if (flags.belowSoftLow && serviceName === 'turnover_clean') {
    multiplier *= exactLocation ? 0.62 : 0.35;
    reasons.push('below_service_soft_low');
  }

  if (flags.aboveHardHigh) {
    multiplier *= 0.07;
    reasons.push('above_hard_outlier_cap');
    if (!exactLocation || flags.largeProperty || broadGuide) exclude = true;
  } else if (flags.aboveSoftHigh) {
    multiplier *= (exactLocation && vendorPricingPage && !flags.largeProperty) ? 0.42 : 0.18;
    reasons.push('above_service_soft_high');
  }

  if (flags.largeProperty && serviceName === 'turnover_clean') {
    multiplier *= 0.45;
    reasons.push('large_or_luxury_property_context');
  }

  if (sourceType === 'social') {
    multiplier *= 0.68;
    reasons.push('social_low_trust');
  }

  // Exact local vendor pages remain useful, but broad national pages should not auto-approve by themselves.
  if (exactLocation && vendorPricingPage && flags.serviceStrong && !flags.costFloor && !flags.serviceMismatch) {
    multiplier *= domainMatchesAny(domain, ['thefloridamaid.com']) ? 1.28 : 1.12;
    reasons.push('strong_local_service_match');
  }

  if (serviceName === 'move_out_clean' && exactLocation && domainMatchesAny(domain, ['thefloridamaid.com']) && flags.serviceStrong) {
    multiplier *= 1.18;
    reasons.push('trusted_move_out_local_page');
  }

  return {
    multiplier: clamp(multiplier, 0, 1.25),
    exclude,
    reasons: [...new Set(reasons)],
    flags,
  };
}

function qualityScoreForGroupedSignal(group, ctx, service) {
  const sample = group.sample || {};
  const domain = sample.domain || domainFromUrl(sample.link);
  const text = `${sample.title || ''} ${sample.snippet || ''}`;
  const sourceType = sourceTypeForDomain(domain);
  const location = locationQuality(sample, ctx);
  const vendorPricingPage = looksLikeVendorPricingPage({ ...sample, domain });
  const representativePrice = median(group.prices.filter((p) => Number.isFinite(p) && p > 0));


  let weight = sourceBaseWeight(domain);
  weight += priceContextScore(text, service);
  weight += sourceTrustBoost(domain);
  weight += exactServicePageBoost(domain, sample, service, ctx);
  if (vendorPricingPage) weight += 0.32;
  if (serviceKeywordMatch(sample.link || '', service)) weight += 0.24;
  if (serviceKeywordMatch(sample.title || '', service)) weight += 0.14;
  if (sample.fullPage || sample.sourceProvider === 'firecrawl') weight += 0.22;

  weight *= location.multiplier;

  const priceCount = group.prices.length;
  if (priceCount > 1) weight *= clamp(1 + Math.log(priceCount) * 0.08, 1, 1.18);

  if (LOW_TRUST_DOMAINS.some((x) => domain === x || domain.endsWith(`.${x}`))) {
    weight = Math.min(weight, 0.55);
  }

  const policy = servicePolicyForGroupedSignal({
    group,
    ctx,
    service,
    representativePrice,
    location,
    vendorPricingPage,
    sourceType,
  });

  weight *= policy.multiplier;

  return {
    weight: policy.exclude ? 0 : clamp(weight, 0.02, 1.45),
    sourceType,
    locationStatus: location.status,
    locationPenalty: Number(location.multiplier.toFixed(2)),
    otherCities: location.otherCities,
    vendorPricingPage,
    policy,
  };
}

function reduceDuplicateSignals(priceSignals = [], ctx, service) {
  const byUrl = new Map();

  for (const signal of priceSignals) {
    const urlKey = normalizeUrlKey(signal.link || signal.url || `${signal.domain}:${signal.title}`);
    if (!urlKey) continue;

    const group = byUrl.get(urlKey) || {
      urlKey,
      prices: [],
      sample: signal,
      rawSignals: [],
    };

    group.prices.push(Number(signal.price));
    group.rawSignals.push(signal);
    if (!group.sample?.snippet && signal.snippet) group.sample = signal;
    byUrl.set(urlKey, group);
  }

  const allGrouped = [...byUrl.values()].map((group) => {
    const cleanPrices = group.prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
    const representativePrice = median(cleanPrices);
    const q = qualityScoreForGroupedSignal(group, ctx, service);
    const sample = group.sample || {};
    const domain = sample.domain || domainFromUrl(sample.link);

    return {
      price: representativePrice,
      prices: cleanPrices,
      rawPriceCount: cleanPrices.length,
      title: sample.title || domain || 'Source',
      link: sample.link || sample.url || '',
      url: sample.link || sample.url || '',
      domain,
      snippet: sample.snippet || '',
      query: sample.query || '',
      weight: q.weight,
      sourceType: q.sourceType,
      locationStatus: q.locationStatus,
      locationPenalty: q.locationPenalty,
      otherCities: q.otherCities,
      vendorPricingPage: q.vendorPricingPage,
      sourceProvider: sample.sourceProvider || 'search',
      fullPage: !!sample.fullPage,
      policyReasons: q.policy?.reasons || [],
      policyFlags: q.policy?.flags || {},
      serviceMatch: sample.serviceMatch || {},
      rejected: !!q.policy?.exclude || q.weight <= 0.04,
      trust: q.policy?.exclude
        ? 'rejected_policy_filter'
        : q.vendorPricingPage ? 'high_vendor_pricing' : q.sourceType === 'social' ? 'low_social_signal' : q.sourceType === 'marketplace' ? 'medium_marketplace' : 'medium_web',
    };
  });

  const policyRejectedSignals = allGrouped
    .filter((item) => item.rejected)
    .map((item) => ({
      ...item,
      rejectReasons: item.policyReasons?.length ? item.policyReasons : ['low_source_weight'],
      priceContext: item.snippet,
    }));

  const grouped = allGrouped.filter((item) => !item.rejected && item.weight > 0.04);

  const byDomain = new Map();
  for (const item of grouped) {
    const d = item.domain || 'unknown';
    const list = byDomain.get(d) || [];
    list.push(item);
    byDomain.set(d, list);
  }

  const reduced = [];
  for (const [, list] of byDomain.entries()) {
    list.sort((a, b) => b.weight - a.weight);
    list.slice(0, 2).forEach((item, idx) => {
      reduced.push({ ...item, weight: idx === 0 ? item.weight : item.weight * 0.45, domainRank: idx + 1 });
    });
  }

  const sorted = reduced.sort((a, b) => b.weight - a.weight);
  sorted.policyRejectedSignals = policyRejectedSignals;
  return sorted;
}

function firecrawlTopPagesPerService() {
  return clamp(num(process.env.FIRECRAWL_TOP_PAGES_PER_SERVICE, 2), 0, 5);
}

function shouldTryFirecrawl() {
  const raw = String(process.env.FIRECRAWL_ENABLED ?? 'true').trim().toLowerCase();
  return !!(process.env.FIRECRAWL_API_KEY || process.env.FIRECRAWL_DEV_API_KEY) &&
    !['0', 'false', 'off', 'no'].includes(raw);
}

function itemQualityPreview(item = {}, ctx, service) {
  const domain = domainFromUrl(item.link || item.url || '');
  const location = locationQuality({
    title: item.title,
    snippet: item.snippet,
    link: item.link || item.url,
  }, ctx);

  const vendorPricingPage = looksLikeVendorPricingPage({
    title: item.title,
    snippet: item.snippet,
    domain,
  });

  let score = sourceBaseWeight(domain) + priceContextScore(`${item.title || ''} ${item.snippet || ''}`, service);
  score += sourceTrustBoost(domain);
  score += exactServicePageBoost(domain, item, service, ctx);
  if (vendorPricingPage) score += 0.35;
  score *= location.multiplier;
  if (sourceTypeForDomain(domain) === 'social') score *= 0.25;

  return { score, domain, locationStatus: location.status, vendorPricingPage };
}

function pickFirecrawlTargets(items = [], ctx, service) {
  const max = firecrawlTopPagesPerService();
  if (!max) return [];

  const seen = new Set();

  return items
    .map((item) => ({ item, q: itemQualityPreview(item, ctx, service) }))
    .filter(({ item, q }) => {
      const url = normalizeUrlKey(item.link || item.url || '');
      if (!url || seen.has(url)) return false;
      seen.add(url);
      if (sourceTypeForDomain(q.domain) === 'social') return false;
      if (q.locationStatus === 'wrong_city_low_weight') return false;
      return q.score >= 0.45;
    })
    .sort((a, b) => b.q.score - a.q.score)
    .slice(0, max)
    .map(({ item }) => item);
}

function trimForSnippet(text = '', limit = 5000) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeFirecrawlData(data, originalItem) {
  const payload = data?.data || data || {};
  const markdown = payload.markdown || payload.content || payload.text || payload.html || '';
  const meta = payload.metadata || payload.meta || {};
  const url = payload.url || payload.sourceURL || meta.sourceURL || meta.url || originalItem.link || originalItem.url || '';
  const title = meta.title || payload.title || originalItem.title || domainFromUrl(url) || 'Vendor page';

  return {
    title,
    link: url,
    snippet: trimForSnippet(markdown, 6000),
    query: `${originalItem.query || ''} · firecrawl_page`,
    sourceProvider: 'firecrawl',
    fullPage: true,
  };
}

async function firecrawlScrape(url, originalItem = {}) {
  const key = process.env.FIRECRAWL_API_KEY || process.env.FIRECRAWL_DEV_API_KEY;

  if (!key) {
    const err = new Error('Firecrawl env missing: set FIRECRAWL_API_KEY');
    err.status = 400;
    err.code = 'FIRECRAWL_NOT_CONFIGURED';
    throw err;
  }

  const { res, data } = await fetchJsonWithTimeout(FIRECRAWL_SCRAPE_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      timeout: 30000,
    }),
  }, num(process.env.FIRECRAWL_TIMEOUT_MS, 30000));

  if (!res.ok || data?.success === false || data?.error) {
    const message = data?.error || data?.message || `Firecrawl scrape failed with ${res.status}`;
    const err = new Error(message);
    err.status = res.status || 400;
    err.code = 'FIRECRAWL_FAILED';
    throw err;
  }

  return normalizeFirecrawlData(data, originalItem);
}

async function enrichItemsWithFirecrawl(items = [], ctx, service) {
  if (!shouldTryFirecrawl()) {
    return {
      items,
      enrichment: { provider: null, attempted: 0, succeeded: 0, failed: 0 },
    };
  }

  const targets = pickFirecrawlTargets(items, ctx, service);

  if (!targets.length) {
    return {
      items,
      enrichment: { provider: 'firecrawl', attempted: 0, succeeded: 0, failed: 0 },
    };
  }

  const enriched = [];
  let failed = 0;
  const failures = [];

  for (const target of targets) {
    const targetUrl = target.link || target.url;

    try {
      const scraped = await firecrawlScrape(targetUrl, target);
      if (scraped?.snippet) {
        enriched.push(scraped);
      } else {
        failed += 1;
        failures.push({
          url: targetUrl,
          domain: domainFromUrl(targetUrl),
          reason: "Firecrawl returned no readable page text",
        });
      }
    } catch (err) {
      failed += 1;
      failures.push({
        url: targetUrl,
        domain: domainFromUrl(targetUrl),
        reason: err.message || String(err),
        code: err.code || null,
        status: err.status || null,
      });
      console.warn('market suggestion firecrawl failed:', targetUrl, err.message);
    }
  }

  return {
    items: [...items, ...enriched],
    enrichment: {
      provider: 'firecrawl',
      attempted: targets.length,
      succeeded: enriched.length,
      failed,
      failures,
    },
  };
}

function summarizeEvidence(results = []) {
  const byDomain = new Map();
  for (const r of results) {
    const key = r.domain || domainFromUrl(r.link) || r.title;
    if (!key || byDomain.has(key)) continue;
    byDomain.set(key, {
      domain: key,
      title: r.title || key,
      url: r.link || '',
      snippet: String(r.snippet || '').slice(0, 240),
      extractedPrice: r.price || null,
      query: r.query || '',
    });
  }
  return [...byDomain.values()].slice(0, 8);
}

function providerLabel(provider) {
  if (provider === 'serper') return 'Serper Google Search';
  if (provider === 'google_cse') return 'Google Custom Search';
  return 'Search';
}

function providerSource(provider) {
  if (provider === 'serper') return 'serper_google_search';
  if (provider === 'google_cse') return 'google_custom_search';
  return 'search_provider';
}

function buildQualitySummary(weightedSignals = [], rejectedSignals = []) {
  const sourceCount = weightedSignals.length;
  const vendorCount = weightedSignals.filter((s) => s.vendorPricingPage).length;
  const socialCount = weightedSignals.filter((s) => s.sourceType === 'social').length;
  const acceptedWrongCityCount = weightedSignals.filter((s) => s.locationStatus === 'wrong_city_low_weight').length;
  const rejectedWrongCityCount = rejectedSignals.filter((s) =>
    s.locationStatus === 'wrong_city_low_weight' ||
    (s.rejectReasons || s.policyReasons || s.reasons || []).includes('wrong_city')
  ).length;
  const wrongCityCount = acceptedWrongCityCount + rejectedWrongCityCount;
  const mixedLocationCount = weightedSignals.filter((s) => s.locationStatus === 'mixed_location').length;
  const exactLocationCount = weightedSignals.filter((s) => ['zip_match', 'city_match'].includes(s.locationStatus)).length;
  const costFloorCount = weightedSignals.filter((s) => !!s.policyFlags?.costFloor).length;
  const serviceMismatchCount = weightedSignals.filter((s) => !!s.policyFlags?.serviceMismatch).length;
  const outlierCount = weightedSignals.filter((s) => !!s.policyFlags?.aboveHardHigh || !!s.policyFlags?.aboveSoftHigh).length;
  const totalWeight = weightedSignals.reduce((sum, s) => sum + Number(s.weight || 0), 0);

  return {
    sourceCount,
    vendorCount,
    socialCount,
    wrongCityCount,
    acceptedWrongCityCount,
    rejectedWrongCityCount,
    mixedLocationCount,
    exactLocationCount,
    costFloorCount,
    serviceMismatchCount,
    outlierCount,
    rejectedSignalCount: rejectedSignals.length,
    totalWeight: Number(totalWeight.toFixed(2)),
  };
}

function roundMarketLow(value, ctx, service) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 75;
  const floor = premiumFloorFor(ctx, service);
  const rounded = Math.floor(n / 10) * 10;
  return Math.max(75, floor || 0, rounded);
}

function roundMarketMidHigh(value, minValue) {
  const n = Number(value || 0);
  const rounded = Math.round(n / 5) * 5;
  return Math.max(Number(minValue || 0), rounded);
}

function applyServiceCaps(value, service, kind = 'high') {
  const rules = servicePriceRules(service);
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return n;
  if (kind === 'high') return Math.min(n, rules.softHigh);
  return n;
}

function applyServiceShapeGuardrails({ marketLow, marketMedian, marketHigh, service }) {
  const serviceName = normalizeService(service);
  let low = Number(marketLow || 0);
  let mid = Number(marketMedian || 0);
  let high = Number(marketHigh || 0);

  if (serviceName === 'turnover_clean') {
    // STR turnover searches often find a valid local page plus generic Airbnb guide maxima.
    // Keep the median near the low/local package signal; let the high carry premium/larger-home evidence.
    mid = Math.min(mid, low + 55);
    high = Math.min(high, Math.max(mid + 45, 200));
  }

  if (serviceName === 'standard_clean') {
    high = Math.min(high, Math.max(mid + 70, 220));
  }

  return {
    marketLow: Math.round(low / 5) * 5,
    marketMedian: Math.max(Math.round(mid / 5) * 5, Math.round(low / 5) * 5),
    marketHigh: Math.max(Math.round(high / 5) * 5, Math.max(Math.round(mid / 5) * 5, Math.round(low / 5) * 5)),
  };
}

function buildSuggestion({ zip, service, priceSignals, evidenceFallback, queries, provider, city, state, enrichment }) {
  const ctx = locationContext({ zip, city, state });
  const acceptedSignals = [];
  const rejectedSignals = [];

  for (const signal of priceSignals || []) {
    const decision = priceSignalPrecheck(signal, service);

    if (decision.keep) {
      acceptedSignals.push({ ...signal, signalDecision: decision });
    } else {
      rejectedSignals.push({
        ...signal,
        rejectReasons: decision.reasons,
        signalDecision: decision,
      });
    }
  }

  const weightedSignals = reduceDuplicateSignals(acceptedSignals, ctx, service);
  const policyRejectedSignals = Array.isArray(weightedSignals.policyRejectedSignals)
    ? weightedSignals.policyRejectedSignals
    : [];
  const allRejectedSignals = [...rejectedSignals, ...policyRejectedSignals];
  const prices = weightedSignals.map((s) => Number(s.price)).filter((n) => Number.isFinite(n) && n > 0);
  const evidence = weightedSignals.length ? summarizeEvidence(weightedSignals) : evidenceFallback;
  const uniqueDomains = new Set(weightedSignals.map((e) => e.domain).filter(Boolean)).size;
  const label = providerLabel(provider);
  const quality = buildQualitySummary(weightedSignals, allRejectedSignals);

  if (!prices.length) {
    return {
      ok: true,
      zip,
      service,
      provider,
      enrichment: enrichment || null,
      suggested: null,
      confidence: 0.12,
      sourceCount: evidence.length,
      reviewStatus: 'needs_review',
      canAutoApprove: false,
      quality,
      queries,
      evidence,
      notes: `${label} completed, but no clear dollar price signals were found in titles/snippets. Review source pages manually or adjust search terms.`,
    };
  }

  const lowItems = weightedSignals.map((s) => ({ ...s, price: sourceRangeLow(s) }));
  const medianItems = weightedSignals.map((s) => ({ ...s, price: Number(s.price || 0) }));
  const highItems = weightedSignals.map((s) => ({ ...s, price: sourceRangeHigh(s) }));

  const lowRaw = weightedPercentile(lowItems, 0.25) || percentile(prices, 0.25);
  const medianRaw = weightedPercentile(medianItems, 0.5) || median(prices);
  const highRawUncapped = weightedPercentile(highItems, prices.length >= 4 ? 0.75 : 0.85) || percentile(prices, prices.length >= 4 ? 0.75 : 0.85);
  const highRaw = applyServiceCaps(highRawUncapped, service, 'high');

  let marketLow = roundMarketLow(lowRaw, ctx, service);
  let marketMedian = roundMarketMidHigh(medianRaw, marketLow);
  let marketHigh = roundMarketMidHigh(highRaw, marketMedian);

  ({ marketLow, marketMedian, marketHigh } = applyServiceShapeGuardrails({
    marketLow,
    marketMedian,
    marketHigh,
    service,
  }));

  const spread = marketMedian ? (marketHigh - marketLow) / marketMedian : 1;
  const socialRatio = quality.sourceCount ? quality.socialCount / quality.sourceCount : 0;
  const wrongCityRatio = quality.sourceCount ? quality.wrongCityCount / quality.sourceCount : 0;
  const avgWeight = quality.sourceCount ? quality.totalWeight / quality.sourceCount : 0;

  let confidence = 0.24;
  confidence += Math.min(0.24, quality.totalWeight * 0.055);
  confidence += Math.min(0.16, uniqueDomains * 0.035);
  confidence += Math.min(0.14, quality.vendorCount * 0.07);
  confidence += Math.min(0.08, quality.exactLocationCount * 0.025);
  confidence -= Math.min(0.24, spread * 0.12);
  confidence -= Math.min(0.18, socialRatio * 0.14);
  confidence -= Math.min(0.2, wrongCityRatio * 0.22);
  confidence -= Math.min(0.12, (quality.mixedLocationCount || 0) * 0.035);
  confidence -= Math.min(0.16, (quality.costFloorCount || 0) * 0.05);
  confidence -= Math.min(0.16, (quality.serviceMismatchCount || 0) * 0.05);
  confidence -= Math.min(0.14, (quality.outlierCount || 0) * 0.035);
  if (avgWeight < 0.45) confidence -= 0.08;
  confidence = clamp(confidence, 0.18, 0.9);

  const canAutoApprove = confidence >= REVIEW_CONFIDENCE_THRESHOLD &&
    quality.sourceCount >= 3 &&
    quality.vendorCount >= 2 &&
    quality.wrongCityCount === 0 &&
    quality.costFloorCount === 0 &&
    quality.serviceMismatchCount === 0;

  const reviewStatus = canAutoApprove ? 'auto_review_eligible' : 'needs_review';
  const cleanerPayoutFloor = estimateCleanerPayoutFloor({ marketMedian, service, ctx });
  const confidenceRounded = Number(confidence.toFixed(2));

  const reviewReason = canAutoApprove
    ? `Confidence is ${Math.round(confidenceRounded * 100)}%, with ${quality.vendorCount} vendor pricing source(s). Auto-approval is allowed by policy.`
    : `Confidence is ${Math.round(confidenceRounded * 100)}%, below the ${Math.round(REVIEW_CONFIDENCE_THRESHOLD * 100)}% auto-approval threshold or missing enough trusted vendor/local sources. Admin review required before saving.`;

  return {
    ok: true,
    zip,
    service,
    provider,
    enrichment: enrichment || null,
    suggested: {
      marketLow,
      marketMedian,
      marketHigh,
      cleanerPayoutFloor,
      platformMarginPct: service === 'standard_clean' ? 22 : 24,
      paymentFeeBuffer: 8,
      suppliesTravelBuffer: 0,
      confidence: confidenceRounded,
      sourceCount: evidence.length,
      sources: [providerSource(provider), ...evidence.map((e) => e.domain).filter(Boolean).slice(0, 6)],
      reviewStatus,
      canAutoApprove,
      notes: `${label} quality-weighted suggestion from ${weightedSignals.length} deduped source(s) across ${uniqueDomains || evidence.length} domain(s). ${reviewReason}`,
    },
    priceSignals: weightedSignals.slice(0, 12).map((s) => ({
      price: s.price,
      rangeLow: sourceRangeLow(s),
      rangeHigh: sourceRangeHigh(s),
      prices: s.prices,
      rawPriceCount: s.rawPriceCount,
      title: s.title,
      url: s.link || s.url,
      domain: s.domain,
      snippet: String(s.snippet || '').slice(0, 240),
      query: s.query,
      weight: Number(s.weight.toFixed(2)),
      trust: s.trust,
      sourceType: s.sourceType,
      locationStatus: s.locationStatus,
      vendorPricingPage: s.vendorPricingPage,
      policyReasons: s.policyReasons || [],
      policyFlags: s.policyFlags || {},
      serviceMatch: s.serviceMatch || {},
    })),
    rejectedPriceSignals: allRejectedSignals.slice(0, 12).map((s) => ({
      price: s.price,
      title: s.title,
      url: s.link || s.url,
      domain: s.domain,
      reasons: s.rejectReasons || [],
      context: String(s.priceContext || '').slice(0, 180),
    })),
    confidence: confidenceRounded,
    sourceCount: evidence.length,
    reviewStatus,
    canAutoApprove,
    quality,
    queries,
    evidence,
  };
}

function ensureFetch() {
  if (fetchFn) return;
  const err = new Error('No fetch implementation available. Use Node 20+ or install node-fetch.');
  err.status = 500;
  err.code = 'FETCH_NOT_AVAILABLE';
  throw err;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 15000) {
  ensureFetch();

  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), Math.max(1000, Number(timeoutMs || 15000))) : null;

  try {
    const res = await fetchFn(url, { ...options, signal: ac?.signal });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { res, data };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeSearchItem(item = {}, query = '') {
  return {
    title: item.title || '',
    link: item.link || item.url || '',
    snippet: item.snippet || item.description || item.htmlSnippet || '',
    query,
  };
}

async function googleCseSearch(query) {
  const key = process.env.GOOGLE_CSE_API_KEY || process.env.GOOGLE_CUSTOM_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_CSE_CX || process.env.GOOGLE_CUSTOM_SEARCH_CX || process.env.GOOGLE_CSE_ID;

  if (!key || !cx) {
    const err = new Error('Google Custom Search env missing: set GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX');
    err.status = 400;
    err.code = 'GOOGLE_CSE_NOT_CONFIGURED';
    throw err;
  }

  const params = new URLSearchParams({
    key,
    cx,
    q: query,
    num: String(resultsPerQuery()),
    safe: 'active',
  });

  const { res, data } = await fetchJsonWithTimeout(`${GOOGLE_CSE_ENDPOINT}?${params.toString()}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });

  if (!res.ok || data?.error) {
    const err = new Error(data?.error?.message || `Google CSE failed with ${res.status}`);
    err.status = res.status || 400;
    err.code = 'GOOGLE_CSE_FAILED';
    throw err;
  }

  return (Array.isArray(data?.items) ? data.items : []).map((item) => normalizeSearchItem(item, query));
}

async function serperSearch(query) {
  const key = process.env.SERPER_API_KEY || process.env.SERPER_DEV_API_KEY;

  if (!key) {
    const err = new Error('Serper env missing: set SERPER_API_KEY');
    err.status = 400;
    err.code = 'SERPER_NOT_CONFIGURED';
    throw err;
  }

  const { res, data } = await fetchJsonWithTimeout(SERPER_ENDPOINT, {
    method: 'POST',
    headers: {
      'X-API-KEY': key,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ q: query, num: resultsPerQuery() }),
  });

  if (!res.ok || data?.error) {
    const message = typeof data?.error === 'string'
      ? data.error
      : data?.message || data?.error?.message || `Serper search failed with ${res.status}`;
    const err = new Error(message);
    err.status = res.status || 400;
    err.code = 'SERPER_FAILED';
    throw err;
  }

  const organic = Array.isArray(data?.organic) ? data.organic : [];
  return organic.map((item) => normalizeSearchItem(item, query));
}

async function tavilySearch(query) {
  const key = process.env.TAVILY_API_KEY || process.env.TAVILY_DEV_API_KEY;

  if (!key) {
    const err = new Error('Tavily env missing: set TAVILY_API_KEY');
    err.status = 400;
    err.code = 'TAVILY_NOT_CONFIGURED';
    throw err;
  }

  const { res, data } = await fetchJsonWithTimeout(TAVILY_SEARCH_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      query,
      search_depth: process.env.TAVILY_SEARCH_DEPTH || 'basic',
      max_results: resultsPerQuery(),
      include_answer: false,
      include_raw_content: false,
    }),
  });

  if (!res.ok || data?.error) {
    const message = data?.error || data?.message || data?.error?.message || `Tavily search failed with ${res.status}`;
    const err = new Error(message);
    err.status = res.status || 400;
    err.code = 'TAVILY_FAILED';
    throw err;
  }

  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map((item) => normalizeSearchItem({
    title: item.title || '',
    link: item.url || item.link || '',
    snippet: item.content || item.snippet || item.description || '',
  }, query));
}

function requestedProvider() {
  const raw = String(process.env.MARKET_SEARCH_PROVIDER || '').trim().toLowerCase();
  if (['tavily', 'serper', 'google_cse', 'google', 'auto'].includes(raw)) {
    return raw === 'google' ? 'google_cse' : raw;
  }

  if (process.env.TAVILY_API_KEY || process.env.TAVILY_DEV_API_KEY) return 'tavily';
  if (process.env.SERPER_API_KEY || process.env.SERPER_DEV_API_KEY) return 'serper';
  return 'google_cse';
}

function providerPriority() {
  const explicit = requestedProvider();
  if (explicit !== 'auto') return [explicit];

  const providers = [];
  if (process.env.TAVILY_API_KEY || process.env.TAVILY_DEV_API_KEY) providers.push('tavily');
  if (process.env.SERPER_API_KEY || process.env.SERPER_DEV_API_KEY) providers.push('serper');
  if (
    process.env.GOOGLE_CSE_API_KEY &&
    (process.env.GOOGLE_CSE_CX || process.env.GOOGLE_CUSTOM_SEARCH_CX || process.env.GOOGLE_CSE_ID)
  ) {
    providers.push('google_cse');
  }

  return providers.length ? providers : ['google_cse'];
}

async function searchOneQuery(query, provider) {
  if (provider === 'tavily') return tavilySearch(query);
  if (provider === 'serper') return serperSearch(query);
  return googleCseSearch(query);
}

async function collectItemsWithProvider(queries = [], provider) {
  const allItems = [];

  for (const query of queries || []) {
    const items = await searchOneQuery(query, provider);

    for (const item of items || []) {
      allItems.push({
        ...item,
        query: item.query || query,
      });
    }
  }

  return allItems;
}

async function collectItems(queries) {
  const providers = providerPriority();
  let lastErr;

  for (const provider of providers) {
    try {
      return { provider, items: await collectItemsWithProvider(queries, provider) };
    } catch (err) {
      lastErr = err;
      console.warn(`market suggestion provider ${provider} failed:`, err.message);
    }
  }

  throw lastErr;
}

async function suggestMarketRateFromGoogle(input = {}) {
  const zip = normalizeZip(input.zip);
  const service = normalizeService(input.service || input.serviceType || 'turnover_clean');

  if (!zip) {
    const err = new Error('valid 5-digit zip required');
    err.status = 400;
    err.code = 'ZIP_REQUIRED';
    throw err;
  }

  const ctx = locationContext({ zip, city: input.city, state: input.state });
  const queries = buildQueries({ zip, service, city: ctx.city, state: ctx.state });

  const { provider, items: rawItems } = await collectItems(queries);
  const { items, enrichment } = await enrichItemsWithFirecrawl(rawItems, ctx, service);

  const priceSignals = [];

  for (const item of items) {
    priceSignals.push(...extractPriceSignals({ ...item, service }).map((signal) => ({
      ...signal,
      sourceProvider: item.sourceProvider || 'search',
      fullPage: !!item.fullPage,
    })));
  }

  const evidenceFallback = summarizeEvidence(items.map((item) => ({
    ...item,
    domain: domainFromUrl(item.link),
    price: null,
    weight: null,
    trust: item.fullPage ? 'full_page_no_price_signal' : 'no_price_signal',
  })));

  return buildSuggestion({
    zip,
    service,
    priceSignals,
    evidenceFallback,
    queries,
    provider,
    city: ctx.city,
    state: ctx.state,
    enrichment,
  });
}


async function suggestMarketRatesBatch(input = {}) {
  const zip = normalizeZip(input.zip);
  if (!zip) {
    const err = new Error('valid 5-digit zip required');
    err.status = 400;
    err.code = 'ZIP_REQUIRED';
    throw err;
  }

  const requestedServices = Array.isArray(input.services) && input.services.length
    ? input.services
    : DEFAULT_BATCH_SERVICES;

  const services = [...new Set(requestedServices.map(normalizeService))];
  const results = [];

  for (const service of services) {
    try {
      const suggestion = await suggestMarketRateFromGoogle({ ...input, zip, service, serviceType: service });
      results.push({ service, ok: true, ...suggestion });
    } catch (err) {
      results.push({
        ok: false,
        zip,
        service,
        serviceLabel: serviceLabel(service),
        error: err.code || 'MARKET_RATE_SUGGESTION_FAILED',
        message: String(err.message || err),
      });
    }
  }

  return {
    ok: true,
    zip,
    provider: results.find((r) => r.provider)?.provider || requestedProvider(),
    services,
    results,
    summary: {
      total: results.length,
      suggested: results.filter((r) => r.ok && r.suggested).length,
      needsReview: results.filter((r) => r.ok && r.reviewStatus === 'needs_review').length,
      autoReviewEligible: results.filter((r) => r.ok && r.canAutoApprove).length,
      failed: results.filter((r) => !r.ok).length,
    },
  };
}

module.exports = {
  suggestMarketRateFromGoogle,
  suggestMarketRatesBatch,
  normalizeService,
};    