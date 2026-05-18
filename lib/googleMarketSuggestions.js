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

const REVIEW_CONFIDENCE_THRESHOLD = 0.60;

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

const OUT_OF_MARKET_LOCATION_TERMS = [
  'jamaica', 'javea', 'jávea', 'alicante', 'spain', 'costa blanca',
  'kingston', 'montego bay', 'negril', 'resort apartment', 'holiday apartment',
];

const BAD_NON_CLEANING_PRICE_DOMAINS = [
  'estatesales.net', 'estatesales.org', 'estatesales.com', 'estatesaletoday.com',
  'estatesalestoday.com', 'estatesale.com', 'estate-sale.com', 'auctionninja.com',
];

const DIRECT_LOCAL_RATE_DOMAINS = [
  'catalinacleaning.com',
  'gallasroyalcleaning.com',
  'thefloridamaid.com',
  'sweetmaidcleaning.com',
  'clarityfresh.com',

  // Miami / Miami Beach / South Beach local vendor pricing sources.
  'southbeachcleaning.com',
  'dndcleaningservicesusa.com',
  'cleanandspotlessservices.com',
  'miamiexpcleaning.com',
];

const US_STATE_NAMES = {
  AL: 'alabama',
  AK: 'alaska',
  AZ: 'arizona',
  AR: 'arkansas',
  CA: 'california',
  CO: 'colorado',
  CT: 'connecticut',
  DE: 'delaware',
  FL: 'florida',
  GA: 'georgia',
  HI: 'hawaii',
  ID: 'idaho',
  IL: 'illinois',
  IN: 'indiana',
  IA: 'iowa',
  KS: 'kansas',
  KY: 'kentucky',
  LA: 'louisiana',
  ME: 'maine',
  MD: 'maryland',
  MA: 'massachusetts',
  MI: 'michigan',
  MN: 'minnesota',
  MS: 'mississippi',
  MO: 'missouri',
  MT: 'montana',
  NE: 'nebraska',
  NV: 'nevada',
  NH: 'new hampshire',
  NJ: 'new jersey',
  NM: 'new mexico',
  NY: 'new york',
  NC: 'north carolina',
  ND: 'north dakota',
  OH: 'ohio',
  OK: 'oklahoma',
  OR: 'oregon',
  PA: 'pennsylvania',
  RI: 'rhode island',
  SC: 'south carolina',
  SD: 'south dakota',
  TN: 'tennessee',
  TX: 'texas',
  UT: 'utah',
  VT: 'vermont',
  VA: 'virginia',
  WA: 'washington',
  WV: 'west virginia',
  WI: 'wisconsin',
  WY: 'wyoming',
};

function mentionedOtherStates(text = '', targetState = '') {
  const raw = String(text || '');
  const t = raw.toLowerCase();
  const target = String(targetState || '').toUpperCase();

  return Object.entries(US_STATE_NAMES)
    .filter(([code, name]) => {
      if (!code || code === target) return false;

      // Important: case-sensitive state abbreviation match.
      // This prevents common word "in" from being treated as Indiana / IN.
      const codeHit = new RegExp(`(?:^|[\\s,;()])${code}(?:[\\s,;()]|$)`).test(raw);
      const nameHit = t.includes(name);

      return codeHit || nameHit;
    })
    .map(([code]) => code);
}

const SOCIAL_DOMAINS = [
  'facebook.com', 'reddit.com', 'x.com', 'twitter.com', 'instagram.com', 'tiktok.com',
  'threads.net', 'pinterest.com', 'quora.com', 'nextdoor.com', 'youtube.com',
  'community.withairbnb.com', 'community.airbnb.com',
];

const MARKETPLACE_DOMAINS = [
  'thumbtack.com', 'angi.com', 'angieslist.com', 'homeadvisor.com', 'taskrabbit.com',
  'care.com', 'yelp.com', 'houzz.com', 'bark.com', 'porch.com', 'homeyou.com',

  // STR / city-market support sources.
  // These are not local vendors, but they can support consensus.
  'turno.com',
];

const LOW_TRUST_DOMAINS = [
  'facebook.com', 'reddit.com', 'quora.com', 'nextdoor.com', 'pinterest.com',
  'community.withairbnb.com', 'community.airbnb.com',
];

const BROAD_GUIDE_DOMAINS = [
  'homeguide.com',
  'airroi.com',
  'leadduo.io',
  'homeaglow.com',
  'airdna.co',
  'rental-scale-up.com',
  'rentalscaleup.com',
  'beyondpricing.com',
  'freshbooks.com',
  'fixr.com',

  // Generic/national guide pages. These can appear in rejected evidence,
  // but they must never drive verified local ZIP rates.
  'getproperly.com',
  'properly.com',
  'tidycleaningchamps.com',
  'maidbright.com',
  'maids.com',
  'homecleaning.com',
  'housecallpro.com',
  'tidy.com',
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
  '33140': { turnover_clean: 0, standard_clean: 0, deep_clean: 0, move_out_clean: 0 },
  '33334': { turnover_clean: 0, standard_clean: 0, deep_clean: 0, move_out_clean: 0 },
  '33076': { turnover_clean: 0, standard_clean: 0, deep_clean: 0, move_out_clean: 0 },
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
  'southbeachcleaning.com',
  'dndcleaningservicesusa.com',
  'cleanandspotlessservices.com',
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
      return [
        'Airbnb cleaning service',
        'vacation rental cleaning service',
        'short term rental turnover cleaning service',
        'Airbnb turnover cleaning company',
        'vacation rental housekeeping'
      ];
    case 'deep_clean':
      return ['deep house cleaning service', 'deep cleaning service', 'house deep clean pricing'];
    case 'move_out_clean':
      return ['move out cleaning service', 'move in move out cleaning', 'rental move out cleaning'];
    default:
      return ['house cleaning service', 'maid service', 'standard house cleaning'];
  }
}

function marketQueryLimit() {
  return clamp(
    num(
      process.env.MARKET_SEARCH_QUERY_LIMIT ||
      process.env.TAVILY_MARKET_QUERY_LIMIT ||
      process.env.SERPER_MARKET_QUERY_LIMIT ||
      process.env.GOOGLE_CSE_MARKET_QUERY_LIMIT,
      16
    ),
    6,
    24
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

function marketAreasForContext(ctx) {
  const zip = ctx.zip || '';
  const state = ctx.state || 'FL';

  if (zip === '33076') {
    return [
      { label: '33076', kind: 'zip' },
      { label: 'Parkland FL', kind: 'primary_city' },
      { label: 'Coral Springs FL', kind: 'nearby_city' },
      { label: 'Coconut Creek FL', kind: 'nearby_city' },
      { label: 'Boca Raton FL', kind: 'nearby_city' },
      { label: 'Broward County FL', kind: 'county' },
      { label: 'South Florida', kind: 'regional_sanity' },
    ];
  }

  if (zip === '33334') {
    return [
      { label: '33334', kind: 'zip' },
      { label: 'Oakland Park FL', kind: 'primary_city' },
      { label: 'Fort Lauderdale FL', kind: 'nearby_city' },
      { label: 'Wilton Manors FL', kind: 'nearby_city' },
      { label: 'Pompano Beach FL', kind: 'nearby_city' },
      { label: 'Broward County FL', kind: 'county' },
      { label: 'South Florida', kind: 'regional_sanity' },
    ];
  }

  if (zip === '33140') {
    return [
      { label: '33140', kind: 'zip' },
      { label: 'Miami Beach FL', kind: 'primary_city' },
      { label: 'South Beach Miami FL', kind: 'nearby_city' },
      { label: 'Miami FL', kind: 'nearby_city' },
      { label: 'Miami-Dade County FL', kind: 'county' },
      { label: 'South Florida', kind: 'regional_sanity' },
    ];
  }

  const cityLabel = ctx.label || [ctx.city, state].filter(Boolean).join(' ');
  return [
    { label: zip, kind: 'zip' },
    { label: cityLabel, kind: 'primary_city' },
    { label: `${state} house cleaning`, kind: 'regional_sanity' },
  ].filter((x) => x.label);
}

function sourceTargetQueriesForService({ zip, service }) {
  const serviceName = normalizeService(service);

  // Exact-source discovery for ZIPs where public local pricing pages are known.
  // This is NOT fallback pricing. These are only search/crawl hints to find real online sources.
  if (zip === '33140') {
    if (serviceName === 'turnover_clean') {
      return [
        'site:thefloridamaid.com/south-beach-maid-service/airbnb-cleaning "$75" "$195"',
        'site:miamiexpcleaning.com average cost Airbnb cleaning Miami "$120" "$200"',
        'site:dndcleaningservicesusa.com/precios.html Airbnb Vacation Rental Miami cleaning prices',
        'site:cleanandspotlessservices.com/services/vacation-rental-str-airbnb-cleaning "Starting at $90"',
        'South Beach Airbnb cleaning service public pricing',
        'Miami Beach vacation rental turnover cleaning pricing',
      ];
    }

    if (serviceName === 'standard_clean') {
      return [
        'site:thefloridamaid.com/south-beach-maid-service/regular-cleaning "$98" "$260"',
        'site:southbeachcleaning.com/pricing-guide "$100" "basic cleaning"',
        'site:dndcleaningservicesusa.com/precios.html "Standard Cleaning" "$90"',
        'site:thumbtack.com/p/house-cleaning-prices-miami "$158" "$278"',
        'Miami Beach house cleaning standard cleaning pricing',
      ];
    }

    if (serviceName === 'deep_clean') {
      return [
        'site:thefloridamaid.com/south-beach-maid-service/deep-cleaning "$196" "$390"',
        'site:southbeachcleaning.com/pricing-guide "$150" "deep cleaning"',
        'site:dndcleaningservicesusa.com/precios.html "Deep Cleaning" "$160"',
        'site:miamiflhousecleaning.com/cost/deep-cleaning-cost-miami "$263" "$952"',
        'Miami Beach deep cleaning service pricing',
      ];
    }

    if (serviceName === 'move_out_clean') {
      return [
        'site:thefloridamaid.com/south-beach-maid-service/move-in-move-out-cleaning "$260" "$520"',
        'site:dndcleaningservicesusa.com/precios.html "Move-In / Move-Out" "$150"',
        'site:miamiflhousecleaning.com/cost/move-out-cleaning-cost-miami "$263" "$952"',
        'Miami Beach move out cleaning service pricing',
      ];
    }

    return [];
  }

  if (zip === '33334') {
    if (serviceName === 'turnover_clean') {
      return [
        'site:thefloridamaid.com/fort-lauderdale-maid-service/airbnb-cleaning "$75" "$195"',
        'site:turno.com/airbnb-cleaners/us/florida/fort-lauderdale "Average Cleaning Prices"',
        'Fort Lauderdale Airbnb short term rental cleaning "$75" "$195"',
        'Fort Lauderdale vacation rental cleaning average cleaning prices',
        'Oakland Park FL Airbnb cleaning service public pricing',
      ];
    }

    if (serviceName === 'standard_clean') {
      return [
        'site:thefloridamaid.com/oakland-park-maid-service/regular-cleaning "$98" "$260"',
        'site:thefloridamaid.com/fort-lauderdale-maid-service/regular-cleaning "Regular House Cleaning"',
        'site:homeyou.com/fl/house-cleaning-fort-lauderdale-costs "Typical Range"',
        'Oakland Park regular house cleaning "$98" "$260"',
        'Fort Lauderdale maid service public pricing',
      ];
    }

    if (serviceName === 'deep_clean') {
      return [
        'site:thefloridamaid.com/fort-lauderdale-maid-service/deep-cleaning "$196" "$390"',
        'site:thefloridamaid.com/oakland-park-maid-service/deep-cleaning "Deep Cleaning"',
        'Fort Lauderdale deep cleaning "$196" "$390"',
        'Oakland Park deep cleaning company pricing',
      ];
    }

    if (serviceName === 'move_out_clean') {
      return [
        'site:thefloridamaid.com/oakland-park-maid-service/move-in-move-out-cleaning "$260" "$520"',
        'site:thefloridamaid.com/fort-lauderdale-maid-service/move-in-move-out-cleaning "$260" "$520"',
        'Oakland Park move in move out cleaning "$260" "$520"',
        'Fort Lauderdale move out cleaning "$260" "$520"',
      ];
    }

    return [];
  }

  if (zip !== '33076') return [];

  if (serviceName === 'turnover_clean') {
    return [
      'Gallas Royal Cleaning Airbnb Cleaning Service Coral Springs FL price',
      'site:gallasroyalcleaning.com airbnb cleaning coral springs',
      'Catalina Cleaning Broward County Airbnb Vacation Rental Cleaning custom pricing',
      'Airtasker Airbnb cleaning service cost fixed fee',
    ];
  }

  if (serviceName === 'standard_clean') {
    return [
      'Catalina Cleaning Broward County Standard Cleaning Starting at $200',
      'site:catalinacleaning.com/service-areas/broward-county Standard Cleaning Starting at',
      'The Florida Maid Parkland Maid Service house cleaning price',
      'Coral Springs house cleaning service pricing',
    ];
  }

  if (serviceName === 'deep_clean') {
    return [
      'Catalina Cleaning Broward County Deep Cleaning Starting at $270',
      'site:catalinacleaning.com/service-areas/broward-county Deep Cleaning Starting at',
      'Parkland FL deep cleaning service pricing',
      'Coral Springs FL deep cleaning service price',
    ];
  }

  if (serviceName === 'move_out_clean') {
    return [
      'Catalina Cleaning Broward County Move In Move Out Cleaning Starting at $307',
      'site:catalinacleaning.com/service-areas/broward-county Move In Move Out Cleaning Starting at',
      'Homeyou Boca Raton move out cleaning costs typical range',
      'Molly Maid Boca Raton Coral Springs move-out cleaning',
    ];
  }

  return [];
}

function seededPublicRatePagesForService({ ctx = {}, service = 'standard_clean' }) {
  const zip = ctx?.zip || '';
  const serviceName = normalizeService(service);
  const seeds = [];

  function add({ title, link, snippet }) {
    seeds.push({
      title,
      link,
      url: link,
      snippet: snippet || 'Seeded public pricing source page. Firecrawl will scrape this page for current public rates.',
      query: `seeded_public_rate_page:${serviceName}:${zip}`,
      sourceProvider: 'seeded_public_rate_page',
      seededPublicRatePage: true,
    });
  }

  // ZIP 33140 = Miami Beach / South Beach / Miami-Dade.
  // These are SOURCE URLs only. No fallback prices here.
  if (zip === '33140') {
    if (serviceName === 'turnover_clean') {
      add({
        title: 'Airbnb & Short-Term Rental Cleaning in South Beach | The Florida Maid',
        link: 'https://www.thefloridamaid.com/south-beach-maid-service/airbnb-cleaning',
        snippet: 'Public local vendor page for Airbnb and short-term rental cleaning in South Beach.',
      });

      add({
        title: 'What Is the Average Cost of an Airbnb Cleaning in Miami? | Miami Exp Cleaning',
        link: 'https://miamiexpcleaning.com/what-is-the-average-cost-of-an-airbnb-cleaning-in-miami/',
        snippet: 'Public Miami Airbnb turnover cleaning cost guide from a local cleaning company.',
      });

      add({
        title: 'Airbnb Cleaning Miami FL | Clean and Spotless Services',
        link: 'https://cleanandspotlessservices.com/services/vacation-rental-str-airbnb-cleaning/',
        snippet: 'Public Miami vacation rental STR cleaning page with starting prices.',
      });
    }

    if (serviceName === 'standard_clean') {
      add({
        title: 'Regular House Cleaning in South Beach | The Florida Maid',
        link: 'https://www.thefloridamaid.com/south-beach-maid-service/regular-cleaning',
        snippet: 'Public local vendor page for regular house cleaning in South Beach.',
      });

      add({
        title: 'South Beach Cleaning Pricing Guide',
        link: 'https://www.southbeachcleaning.com/pricing-guide',
        snippet: 'Public Miami Beach/South Beach cleaning pricing guide.',
      });

      add({
        title: 'Cleaning Service Prices Miami FL | D&D Cleaning',
        link: 'https://dndcleaningservicesusa.com/precios.html',
        snippet: 'Public Miami cleaning service pricing table.',
      });
    }

    if (serviceName === 'deep_clean') {
      add({
        title: 'Deep Cleaning in South Beach | The Florida Maid',
        link: 'https://www.thefloridamaid.com/south-beach-maid-service/deep-cleaning',
        snippet: 'Public local vendor page for deep cleaning in South Beach.',
      });

      add({
        title: 'South Beach Cleaning Pricing Guide',
        link: 'https://www.southbeachcleaning.com/pricing-guide',
        snippet: 'Public Miami Beach/South Beach cleaning pricing guide.',
      });

      add({
        title: 'Cleaning Service Prices Miami FL | D&D Cleaning',
        link: 'https://dndcleaningservicesusa.com/precios.html',
        snippet: 'Public Miami cleaning service pricing table.',
      });
    }

    if (serviceName === 'move_out_clean') {
      add({
        title: 'Move-In/Move-Out Cleaning in South Beach | The Florida Maid',
        link: 'https://www.thefloridamaid.com/south-beach-maid-service/move-in-move-out-cleaning',
        snippet: 'Public local vendor page for move-in/move-out cleaning in South Beach.',
      });

      add({
        title: 'Cleaning Service Prices Miami FL | D&D Cleaning',
        link: 'https://dndcleaningservicesusa.com/precios.html',
        snippet: 'Public Miami move-in/move-out cleaning pricing table.',
      });

      add({
        title: 'Move-Out Cleaning Cost in Miami | Miami FL House Cleaning',
        link: 'https://miamiflhousecleaning.com/cost/move-out-cleaning-cost-miami/',
        snippet: 'Public Miami move-out cleaning cost page.',
      });
    }
  }

  // ZIP 33334 = Oakland Park / Fort Lauderdale / Wilton Manors / Broward area.
  // IMPORTANT: These are source URLs only, not fallback prices.
  if (zip === '33334') {
    if (serviceName === 'turnover_clean') {
      add({
        title: 'Airbnb & Short-Term Rental Cleaning in Fort Lauderdale | The Florida Maid',
        link: 'https://www.thefloridamaid.com/fort-lauderdale-maid-service/airbnb-cleaning',
        snippet: 'Public local vendor page for Airbnb and short-term rental cleaning in Fort Lauderdale.',
      });

      add({
        title: 'Fort Lauderdale Vacation Rental Cleaners | Turno',
        link: 'https://turno.com/airbnb-cleaners/us/florida/fort-lauderdale/',
        snippet: 'Public local marketplace page for Fort Lauderdale STR cleaning averages.',
      });
    }

    if (serviceName === 'standard_clean') {
      add({
        title: 'Regular House Cleaning in Oakland Park | The Florida Maid',
        link: 'https://www.thefloridamaid.com/oakland-park-maid-service/regular-cleaning',
        snippet: 'Public local vendor page for regular house cleaning in Oakland Park.',
      });

      add({
        title: 'House Cleaning Fort Lauderdale Costs | Homeyou',
        link: 'https://www.homeyou.com/fl/house-cleaning-fort-lauderdale-costs',
        snippet: 'Public local marketplace cost page for house cleaning in Fort Lauderdale.',
      });
    }

    if (serviceName === 'deep_clean') {
      add({
        title: 'Deep Cleaning in Fort Lauderdale | The Florida Maid',
        link: 'https://www.thefloridamaid.com/fort-lauderdale-maid-service/deep-cleaning',
        snippet: 'Public local vendor page for deep cleaning in Fort Lauderdale.',
      });

      add({
        title: 'Deep Cleaning in Oakland Park | The Florida Maid',
        link: 'https://www.thefloridamaid.com/oakland-park-maid-service/deep-cleaning',
        snippet: 'Public local vendor page for deep cleaning in Oakland Park.',
      });
    }

    if (serviceName === 'move_out_clean') {
      add({
        title: 'Move-In/Move-Out Cleaning in Oakland Park | The Florida Maid',
        link: 'https://www.thefloridamaid.com/oakland-park-maid-service/move-in-move-out-cleaning',
        snippet: 'Public local vendor page for move-in/move-out cleaning in Oakland Park.',
      });

      add({
        title: 'Move-In/Move-Out Cleaning in Fort Lauderdale | The Florida Maid',
        link: 'https://www.thefloridamaid.com/fort-lauderdale-maid-service/move-in-move-out-cleaning',
        snippet: 'Public local vendor page for move-in/move-out cleaning in Fort Lauderdale.',
      });
    }
  }

  return seeds;
}

function localVendorDiscoveryQueriesForService({ ctx, service }) {
  const serviceName = normalizeService(service);
  const areas = marketAreasForContext(ctx)
    .filter((area) => area.kind !== 'regional_sanity')
    .slice(0, 5);

  const q = [];

  function push(areaLabel, phrase) {
    if (!areaLabel || !phrase) return;
    q.push(`${areaLabel} ${phrase}`);
  }

  for (const area of areas) {
    if (serviceName === 'turnover_clean') {
      push(area.label, 'local Airbnb cleaning company pricing');
      push(area.label, 'vacation rental cleaning service rates');
      push(area.label, 'short term rental cleaning company pricing');
      push(area.label, '"Airbnb cleaning" "starting at"');
      push(area.label, '"vacation rental cleaning" "per clean"');

      // Marketplace/support discovery.
      push(area.label, 'Turno Airbnb cleaners average cleaning prices');
      push(area.label, 'Thumbtack Airbnb cleaning prices');
      push(area.label, 'HomeGuide Airbnb cleaning cost local');
    }

    if (serviceName === 'standard_clean') {
      push(area.label, 'local house cleaning company pricing');
      push(area.label, 'maid service pricing');
      push(area.label, '"house cleaning" "starting at"');
      push(area.label, '"home cleaning" "flat rate"');
      push(area.label, '"standard cleaning" "starting at"');

      // Marketplace/support discovery.
      push(area.label, 'Homeyou house cleaning costs typical range');
      push(area.label, 'Thumbtack house cleaning prices');
      push(area.label, 'Angi house cleaning cost local');
    }

    if (serviceName === 'deep_clean') {
      push(area.label, 'local deep cleaning company pricing');
      push(area.label, '"deep cleaning" "starting at"');
      push(area.label, '"deep clean" "flat rate"');
      push(area.label, '"house deep cleaning" "pricing"');

      // Marketplace/support discovery.
      push(area.label, 'Homeyou deep cleaning costs typical range');
      push(area.label, 'Thumbtack deep cleaning prices');
      push(area.label, 'Angi deep cleaning cost local');
    }

    if (serviceName === 'move_out_clean') {
      push(area.label, 'local move out cleaning company pricing');
      push(area.label, '"move out cleaning" "starting at"');
      push(area.label, '"move in move out cleaning" "pricing"');
      push(area.label, '"tenant turnover cleaning" "flat rate"');

      // Marketplace/support discovery.
      push(area.label, 'Homeyou move out cleaning costs typical range');
      push(area.label, 'Thumbtack move out cleaning prices');
      push(area.label, 'Angi move out cleaning cost local');
    }
  }

  return [...new Set(q)];
}

function buildQueries({ zip, service, city, state }) {
  const ctx = locationContext({ zip, city, state });
  const serviceName = normalizeService(service);
  const areas = marketAreasForContext(ctx);
  const q = [
    ...localVendorDiscoveryQueriesForService({ ctx, service: serviceName }),
  ];

  function push(areaLabel, phrase) {
    if (!areaLabel || !phrase) return;
    q.push(`${areaLabel} ${phrase}`);
  }

  if (serviceName === 'turnover_clean') {
    for (const area of areas) {
      if (area.kind === 'regional_sanity') continue;

      push(area.label, 'Airbnb cleaning service pricing');
      push(area.label, 'Airbnb cleaning fee cleaning company');
      push(area.label, 'vacation rental cleaning service rates');
      push(area.label, 'vacation rental turnover cleaning rates');
      push(area.label, 'short term rental cleaning service pricing');
      push(area.label, 'Airbnb turnover cleaning company');
      push(area.label, 'vacation rental housekeeping rates');
      push(area.label, 'STR turnover cleaning service');
    }
  }

  if (serviceName === 'standard_clean') {
    for (const area of areas) {
      push(area.label, 'house cleaning service pricing');
      push(area.label, 'maid service rates');
      push(area.label, 'standard house cleaning cost');
      push(area.label, 'home cleaning service price');
      push(area.label, 'recurring house cleaning rates');
    }
  }

  if (serviceName === 'deep_clean') {
    for (const area of areas) {
      push(area.label, 'deep cleaning service pricing');
      push(area.label, 'house deep cleaning cost');
      push(area.label, 'deep clean maid service rates');
      push(area.label, 'starting price deep clean');
      push(area.label, 'one time deep cleaning price');
    }
  }

  if (serviceName === 'move_out_clean') {
    for (const area of areas) {
      push(area.label, 'move out cleaning service pricing');
      push(area.label, 'move in move out cleaning rates');
      push(area.label, 'rental move out cleaning cost');
      push(area.label, 'apartment move out cleaning price');
      push(area.label, 'tenant move out cleaning service cost');
    }
  }

  for (const targeted of sourceTargetQueriesForService({ zip: ctx.zip, service: serviceName })) {
    q.unshift(targeted);
  }

  return [...new Set(q.map((query) => {
    const alreadySiteQuery = query.includes('site:');
    const negative = alreadySiteQuery
      ? '-jobs -salary -wage -hiring -auto -detailing -carwash -vehicle -ceramic -coating -pdf -facebook -tiktok -instagram'
      : '-jobs -salary -wage -hiring -checklist -insurance -carpet -upholstery -hvac -auto -detailing -carwash -vehicle -ceramic -coating -pdf -facebook -tiktok -instagram -restaurant -menu -tennis -realtor -mls -zillow -redfin';
    return `${query} ${negative}`.trim();
  }))].slice(0, marketQueryLimit());
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

function serviceSectionRegex(service = 'standard_clean') {
  const serviceName = normalizeService(service);

  if (serviceName === 'turnover_clean') {
    return /\b(airbnb|vacation\s*rental|short\s*term|str|turnover|checkout|guest[-\s]?ready)\b/i;
  }

  if (serviceName === 'standard_clean') {
    return /\b(standard\s*cleaning|standard\s*clean|regular\s*cleaning|home\s*cleaning|house\s*cleaning|maid\s*service)\b/i;
  }

  if (serviceName === 'deep_clean') {
    return /\b(deep\s*cleaning|deep\s*clean|spring\s*clean|detail\s*clean)\b/i;
  }

  if (serviceName === 'move_out_clean') {
    return /\b(move\s*in\s*\/\s*move\s*out|move\s*in\s*move\s*out|move[-\s]?out|move[-\s]?in|moving\s*cleaning|tenant\s*turnover)\b/i;
  }

  return /\b(cleaning|maid)\b/i;
}

function otherServiceSectionRegex(service = 'standard_clean') {
  const serviceName = normalizeService(service);
  const parts = [];

  if (serviceName !== 'turnover_clean') {
    parts.push('airbnb', 'vacation\\s*rental', 'short\\s*term', 'turnover');
  }
  if (serviceName !== 'standard_clean') {
    parts.push('standard\\s*cleaning', 'regular\\s*cleaning', 'recurring\\s*cleaning');
  }
  if (serviceName !== 'deep_clean') {
    parts.push('deep\\s*cleaning', 'deep\\s*clean');
  }
  if (serviceName !== 'move_out_clean') {
    parts.push('move\\s*in\\s*\\/\\s*move\\s*out', 'move\\s*in\\s*move\\s*out', 'move[-\\s]?out', 'moving\\s*cleaning');
  }

  return new RegExp(`\\b(${parts.join('|')})\\b`, 'i');
}

function sectionAwarePriceSignals({ title = '', snippet = '', link = '', query = '', service = '' }) {
  const serviceName = normalizeService(service);
  const text = String(snippet || '');
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);

  const targetSectionRe = serviceSectionRegex(serviceName);
  const otherSectionRe = otherServiceSectionRegex(serviceName);
  const signals = [];

  let activeTarget = false;
  let activeHeader = '';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const cleanLine = line.replace(/^#+\s*/, '').trim();

    const looksLikeHeader =
      /^#{1,4}\s+/.test(line) ||
      /^(standard|deep|recurring|move|airbnb|vacation|maid|house cleaning)/i.test(cleanLine);

    if (looksLikeHeader && targetSectionRe.test(cleanLine)) {
      activeTarget = true;
      activeHeader = cleanLine;
    } else if (looksLikeHeader && otherSectionRe.test(cleanLine)) {
      activeTarget = false;
      activeHeader = cleanLine;
    }

    if (!activeTarget) continue;

    const windowText = [activeHeader, line, lines[i + 1] || '', lines[i + 2] || ''].join(' ');
    const priceMatches = [...windowText.matchAll(/(?:\$|usd\s*)\s*([1-9]\d{1,3})(?:\.\d{2})?/gi)];

    for (const m of priceMatches) {
      const price = Number(m[1]);
      if (!Number.isFinite(price) || price < 55 || price > 950) continue;

      const priceContext = windowText.replace(/\s+/g, ' ').trim();
      const flags = priceFlagsForContext(priceContext, serviceName);

      flags.serviceStrong = true;
      flags.serviceMismatch = false;

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
          urlServiceMatch: serviceKeywordMatch(link, serviceName),
          titleServiceMatch: serviceKeywordMatch(title, serviceName),
          contextServiceMatch: true,
          sectionServiceMatch: true,
        },
      });
    }

    // Handle custom pricing explicitly for STR.
    if (
      serviceName === 'turnover_clean' &&
      /\bcustom\s*pricing|request\s*(?:a\s*)?quote|get\s*(?:a\s*)?free\s*estimate\b/i.test(windowText)
    ) {
      signals.push({
        price: 0,
        title,
        link,
        domain: domainFromUrl(link),
        snippet,
        query,
        priceContext: windowText,
        flags: {
          serviceStrong: true,
          serviceMismatch: false,
          customPricing: true,
          hourly: false,
          costFloor: false,
          largeProperty: false,
          rangeContext: false,
        },
        serviceMatch: {
          urlServiceMatch: serviceKeywordMatch(link, serviceName),
          titleServiceMatch: serviceKeywordMatch(title, serviceName),
          contextServiceMatch: true,
          sectionServiceMatch: true,
        },
        customPricing: true,
      });
    }
  }

  return signals;
}

function priceFlagsForContext(context = '', service = 'standard_clean') {
  const t = String(context || '').toLowerCase();
  const rules = SERVICE_PRICE_RULES[normalizeService(service)] || SERVICE_PRICE_RULES.standard_clean;

  return {
    costFloor: COST_FLOOR_PATTERNS.some((re) => re.test(t)),
    serviceStrong: rules.strongWords ? rules.strongWords.test(t) : false,
    serviceMismatch: rules.mismatchWords ? rules.mismatchWords.test(t) : false,
    nonPropertyCleaning: isNonPropertyCleaningContext(t),
    publicPackageRate: hasPublicPackageRateContext(t),
    strongPropertyCleaningContext: hasStrongPropertyCleaningContext(t, service),
    largeProperty: LARGE_PROPERTY_PATTERNS.some((re) => re.test(t)),
    hourly: isHourlyContext(t),
    rangeContext: /\b(range|between|from|to|starts?\s*at|starting\s*at|average|typical|usually|per\s*turnover|per\s*clean)\b/i.test(t),
  };
}

function extractPriceSignals({ title = '', snippet = '', link = '', query = '', service = '', sourceProvider, fullPage }) {
  const text = `${title} ${snippet}`;
  const domain = domainFromUrl(link);

  const labeledSignals = extractServiceLabeledPackageSignals({
    title,
    snippet,
    link,
    query,
    service,
    sourceProvider,
    fullPage,
  });

  const sectionSignals = sectionAwarePriceSignals({ title, snippet, link, query, service });

  // For known multi-price/range pages, use only the service-labeled extraction.
  // Otherwise Catalina can mix recurring/standard/deep/move-out prices from one FAQ line.
  if (labeledSignals.length && domainMatchesAny(domain, [
    'catalinacleaning.com',
    'homeyou.com',
    'gallasroyalcleaning.com',
    'thefloridamaid.com',
    'turno.com',
    'southbeachcleaning.com',
    'dndcleaningservicesusa.com',
    'cleanandspotlessservices.com',
    'miamiexpcleaning.com',
  ])) {
    return labeledSignals;
  }

  const signals = [
    ...labeledSignals,
    ...sectionSignals,
  ];

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

      flags.serviceMismatch = !!(flags.serviceMismatch && !urlServiceMatch && !titleServiceMatch);

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
        sourceProvider: sourceProvider || 'search',
        fullPage: !!fullPage,
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

function isBadMarketRatePage({ title = '', snippet = '', url = '', service = '' }) {
  const text = `${title} ${snippet} ${url}`.toLowerCase();
  const domain = domainFromUrl(url);
  const serviceName = normalizeService(service);

  if (domain.includes('ziprecruiter.com')) return true;
  if (domain.includes('indeed.com')) return true;
  if (domain.includes('glassdoor.com')) return true;
  if (domain.includes('beliani.')) return true;
  if (isBlockedPriceDomain(domain)) return true;

  if (isBadDiscoveryResult({ title, snippet, url })) return true;

  // National/generic guides must not become customer-ready ZIP-rate evidence.
  if (isBroadGuideDomain(domain)) return true;

  // Example: "Stay Clean Auto Detailing in Oakland Park, FL"
  // It has "clean" text, but it is vehicle detailing, not property cleaning.
  if (isNonPropertyCleaningContext(text)) return true;

  if (shouldRejectGenericBookingSource({ domain, text, service: serviceName })) return true;

  if (/\b(sofa|furniture|chair|table|mattress|estate\s*sales?\s*today|estate sale|auction|for sale|sale today|product page|shopping cart)\b/i.test(text)) {
    return true;
  }

  // If it does not look like a cleaning-service page at all, do not use it as market evidence.
  const cleaningIntent = hasStrongPropertyCleaningContext(text, serviceName);

  if (!cleaningIntent) return true;

  // Carpet/window/pressure-wash/HVAC/vehicle-detailing are not property package cleaning rates.
  if (/\b(carpet cleaning|rug cleaning|upholstery|tile cleaning|window cleaning|pressure washing|hvac|air duct|auto detailing|car detailing|vehicle detailing|mobile detailing|ceramic coating|paint correction|car wash)\b/i.test(text)) {
    return true;
  }

  // Care jobs/profile/hourly pages are cleaner-side supply, not customer package rates.
  if (domain.includes('care.com') && /\b(job|jobs|profile|profiles|caregiver|housekeeper|from\$?\d+\/hr|\/hr|per hour)\b/i.test(text)) {
    return true;
  }

  // STR checklist/insurance/guide pages are not local package pricing.
  if (
    serviceName === 'turnover_clean' &&
    /\b(checklist|template|insurance|protection plan|hvac protection|host guide|tips|blog)\b/i.test(text)
  ) {
    return true;
  }

  if (/\b(cleaning jobs|salary|wage|hiring|career|apply now)\b/i.test(text)) return true;

  return false;
}

function priorityRateSourceBoost(domain = '', text = '') {
  const d = String(domain || '').toLowerCase();
  const t = String(text || '').toLowerCase();

  let boost = 0;

  if (d.includes('catalinacleaning.com')) boost += 1.2;
  if (d.includes('gallasroyalcleaning.com')) boost += 1.1;
  if (d.includes('sweetmaidcleaning.com')) boost += 0.8;
  if (d.includes('turno.com')) boost += 0.55;
  if (d.includes('mollymaid.com')) boost += 0.45;
  if (d.includes('airtasker.com')) boost += 0.35;
  if (d.includes('thefloridamaid.com')) boost += 0.55;
  if (d.includes('clarityfresh.com')) boost += 0.45;

  if (/\b(starting at|typical range|average|custom pricing|move in\/move out|airbnb|vacation rental)\b/i.test(t)) {
    boost += 0.35;
  }

  return boost;
}

function sourceBaseWeight(domain = '') {
  const type = sourceTypeForDomain(domain);

  if (isBroadGuideDomain(domain)) return 0.32;
  if (type === 'social') return 0.38;
  if (type === 'marketplace') return 0.72;

  return 0.95;
}

function looksLikeVendorPricingPage({ title = '', snippet = '', domain = '', service = 'standard_clean' }) {
  const text = `${domain} ${title} ${snippet}`.toLowerCase();

  if (isBroadGuideDomain(domain)) return false;
  if (sourceTypeForDomain(domain) !== 'vendor_or_web') return false;
  if (isNonPropertyCleaningContext(text)) return false;

  // Square/booking pages are noisy. Accept only if they clearly show
  // property-cleaning + service context + public package price.
  if (shouldRejectGenericBookingSource({ domain, text, service })) return false;

  // Direct local vendor pages like The Florida Maid may have page title "From $49/hr",
  // but the extracted service card/snippet has a real package range:
  // "local typical range: $196 - $390".
  if (
    domainMatchesAny(domain, DIRECT_LOCAL_RATE_DOMAINS) &&
    hasStrongPropertyCleaningContext(text, service) &&
    serviceKeywordMatch(text, service) &&
    (hasPublicPackageRateContext(text) || hasPublicPackageRangeText(text))
  ) {
    return true;
  }

  return hasStrongPropertyCleaningContext(text, service) &&
    /\b(pricing|rates?|cost|typical\s*cost|typical\s*range|local\s*typical\s*range|average\s*cleaning\s*prices?|starts?\s*at|starting\s*price|service|airbnb|vacation\s*rental|short\s*term|package|per\s*clean)\b/i.test(text);
}

function sourceTierForSignal(signal = {}) {
  const sourceType = signal.sourceType || sourceTypeForDomain(signal.domain);
  const locationStatus = signal.locationStatus || '';
  const vendorPricingPage = !!signal.vendorPricingPage;
  const broadGuide = isBroadGuideDomain(signal.domain);

  const exactLocal = locationStatus === 'zip_match' || locationStatus === 'city_match';
  const nearby = locationStatus === 'mixed_location';

  if (vendorPricingPage && exactLocal) return 'A_local_vendor';
  if (sourceType === 'marketplace' && exactLocal) return 'B_local_marketplace';
  if ((vendorPricingPage || sourceType === 'marketplace') && nearby) return 'C_nearby_market';

  if (broadGuide) return 'D_national_guide';
  if (sourceType === 'social') return 'E_social';

  if (exactLocal) return 'C_nearby_market';
  return 'D_national_guide';
}

function isPrimaryConsensusSignal(signal = {}) {
  return ['A_local_vendor', 'B_local_marketplace', 'C_nearby_market'].includes(signal.sourceTier);
}

function trustedConsensusSourceCount(signals = []) {
  return signals.filter(isPrimaryConsensusSignal).length;
}

function isStrongDirectLocalPriceSignal(signal = {}) {
  const domain = signal.domain || domainFromUrl(signal.link || signal.url || '');
  const text = `${signal.title || ''} ${signal.snippet || ''} ${signal.priceContext || ''} ${signal.link || signal.url || ''}`;

  if (!domain) return false;
  if (isBroadGuideDomain(domain)) return false;
  if (sourceTypeForDomain(domain) !== 'vendor_or_web') return false;
  if (isNonPropertyCleaningContext(text)) return false;

  const locationOk = ['zip_match', 'city_match', 'mixed_location'].includes(signal.locationStatus || '');
  const priceOk = Number.isFinite(Number(signal.price)) && Number(signal.price) > 0;

  const serviceOk = !!(
    signal.serviceMatch?.syntheticServicePrice ||
    signal.serviceMatch?.sectionServiceMatch ||
    signal.serviceMatch?.contextServiceMatch ||
    signal.policyFlags?.serviceStrong
  );

  const vendorOk = !!(
    signal.vendorPricingPage &&
    ['A_local_vendor', 'C_nearby_market'].includes(signal.sourceTier || '')
  );

  const publicPackageOk = !!(
    signal.policyFlags?.publicPackageRate ||
    hasPublicPackageRateContext(text) ||
    signal.serviceMatch?.syntheticServicePrice ||
    signal.serviceMatch?.sectionServiceMatch
  );

  const propertyContextOk = !!(
    signal.policyFlags?.strongPropertyCleaningContext ||
    hasStrongPropertyCleaningContext(text, signal.service || 'standard_clean') ||
    serviceOk
  );

  const genericBookingOk = !shouldRejectGenericBookingSource({
    domain,
    text,
    service: signal.service || 'standard_clean',
  });

  const policyReasons = signal.policyReasons || [];
  const blocked = policyReasons.some((reason) =>
    /wrong_city|bad_market|hourly|cost_floor|cleaner|service_context_mismatch|wrong_service|outlier|broad_guide|non_property|generic_booking/i.test(reason)
  );

  return priceOk &&
    locationOk &&
    serviceOk &&
    vendorOk &&
    publicPackageOk &&
    propertyContextOk &&
    genericBookingOk &&
    !blocked;
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
  const otherStates = mentionedOtherStates(text, ctx.state);
  const outOfMarketLocations = OUT_OF_MARKET_LOCATION_TERMS.filter((term) => text.includes(term));

  if (!hasZip && !hasTarget && outOfMarketLocations.length) {
    return {
      status: 'wrong_city_low_weight',
      multiplier: 0.04,
      otherCities: [...new Set(outOfMarketLocations.map((x) => `out_of_market:${x}`))],
    };
  }

  // Strong out-of-state signal should override weak text matches.
  // Example: "Move Out Cleaning in Levittown, PA" must not pass for Parkland, FL.
  if (!hasZip && otherStates.length) {
    return {
      status: 'wrong_city_low_weight',
      multiplier: 0.04,
      otherCities: [...new Set([...mentionedOtherCities, ...otherStates.map((s) => `state:${s}`)])],
    };
  }

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
    const conflictingOtherCities = mentionedOtherCities.filter((city) =>
      !(ctx.zip === '33334' && city === 'oakland' && text.includes('oakland park'))
    );

    if (conflictingOtherCities.length) {
      return { status: 'mixed_location', multiplier: 0.72, otherCities: conflictingOtherCities };
    }

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

function isBlockedPriceDomain(domain = '') {
  const d = String(domain || '').toLowerCase();

  return BAD_NON_CLEANING_PRICE_DOMAINS.some((x) => d === x || d.endsWith(`.${x}`)) ||
    /estate[-\s]?sales?|auction|classified/i.test(d);
}

function isNonPropertyCleaningContext(text = '') {
  const t = String(text || '').toLowerCase();

  return /\b(auto\s*detailing|car\s*detailing|vehicle\s*detailing|mobile\s*detailing|ceramic\s*coating|paint\s*correction|car\s*wash|truck\s*wash|boat\s*detailing|rv\s*detailing|interior\s*detail|exterior\s*detail|full\s*detail|waxing|tire\s*shine)\b/i.test(t);
}

function isBadDiscoveryResult({ title = '', snippet = '', url = '' }) {
  const text = `${title} ${snippet} ${url}`.toLowerCase();
  const domain = domainFromUrl(url);

  if (!domain) return true;

  if (domainMatchesAny(domain, [
    'ziprecruiter.com',
    'indeed.com',
    'glassdoor.com',
    'monster.com',
    'simplyhired.com',
    'salary.com',
  ])) {
    return true;
  }

  if (sourceTypeForDomain(domain) === 'social') return true;
  if (isBroadGuideDomain(domain)) return true;
  if (isBlockedPriceDomain(domain)) return true;

  if (domainMatchesAny(domain, [
    's3.amazonaws.com',
    'amazonaws.com',
    'facebook.com',
    'tiktok.com',
    'instagram.com',
    'youtube.com',
    'x.com',
    'twitter.com',
    'zillow.com',
    'redfin.com',
    'apartments.com',
    'realtor.com',
    'fultongrace.com',
  ])) {
    return true;
  }

  if (/\b(\.pdf|pdf\b|tennis|restaurant|cuisine|menu|greek cuisine|real estate|realtor|mls|property listing|unit \d+|for rent|for sale|apartment listing|condo listing|jobs?|salary|wage|hiring|career|now hiring)\b/i.test(text)) {
    return true;
  }

  if (isNonPropertyCleaningContext(text)) return true;

    // Vacation-rental listing pages are not vacation-rental cleaning price pages.
  if (
    /\b(vacation\s*rentals?|places\s*to\s*stay|luxury\s*places|villa|villas|hotel|resort|flight|cruise|barbados|saint\s*michael)\b/i.test(text) &&
    !/\b(cleaning\s*service|maid\s*service|house\s*cleaning|airbnb\s*cleaning|turnover\s*cleaning|vacation\s*rental\s*cleaning)\b/i.test(text)
  ) {
    return true;
  }

  // Laundry/dry-cleaning/window-only pages are not full property cleaning package rates.
  if (/\b(dry\s*cleaning|laundry\s*and\s*dry\s*cleaning|commercial\s*laundry|window\s*cleaning|carpet\s*cleaning|upholstery\s*cleaning)\b/i.test(text)) {
    return true;
  }

  return false;
}

function isUnsafeMarketEvidenceItem(item = {}, service = 'standard_clean') {
  const url = item.url || item.link || '';
  const domain = item.domain || domainFromUrl(url);
  const text = `${domain} ${item.title || ''} ${item.snippet || ''} ${item.context || ''} ${item.priceContext || ''} ${url}`.toLowerCase();

  if (!domain) return true;
  if (isBadDiscoveryResult({ title: item.title, snippet: `${item.snippet || ''} ${item.context || ''}`, url })) return true;
  if (isNonPropertyCleaningContext(text)) return true;
  if (shouldRejectGenericBookingSource({ domain, text, service })) return true;

  return false;
}

function cleanEvidenceForDisplay(evidence = [], service = 'standard_clean') {
  return (evidence || [])
    .filter((item) => !isUnsafeMarketEvidenceItem(item, service))
    .slice(0, 8);
}

function canUseAdjacentAnchor(anchor = {}) {
  const reviewStatus = String(anchor.reviewStatus || anchor.suggested?.reviewStatus || '');
  const status = String(anchor.status || anchor.suggested?.status || '');
  const quality = anchor.quality || {};

  // Never derive adjacent service prices from weak draft/junk evidence.
  if (reviewStatus === 'draft_from_weak_search_evidence') return false;
  if (reviewStatus === 'draft_from_adjacent_service_search') return false;
  if (reviewStatus === 'no_price_evidence') return false;

  // Strong anchors only.
  if (status === 'verified') return true;
  if (reviewStatus === 'verified_local_vendor') return true;
  if (reviewStatus === 'verified_consensus') return true;

  // Local vendor page with no public price is okay to show as review context,
  // but should not be used to calculate another service price.
  if (reviewStatus === 'draft_from_local_vendor_no_public_price') return false;

  return Number(quality.vendorCount || 0) > 0 && Number(anchor.confidence || anchor.suggested?.confidence || 0) >= 0.6;
}

function isGenericBookingDomain(domain = '') {
  return domainMatchesAny(domain, [
    'square.site',
    'squareup.com',
    'booksy.com',
    'setmore.com',
    'calendly.com',
    'acuityscheduling.com',
    'wixsite.com',
    'godaddysites.com',
  ]);
}

function hasStrongPropertyCleaningContext(text = '', service = 'standard_clean') {
  const t = String(text || '').toLowerCase();
  const serviceName = normalizeService(service);

  if (isNonPropertyCleaningContext(t)) return false;

  const propertyCleaning =
    /\b(house\s*cleaning|home\s*cleaning|residential\s*cleaning|maid\s*service|housekeeping|apartment\s*cleaning|condo\s*cleaning|rental\s*cleaning|property\s*cleaning|cleaning\s*service)\b/i.test(t);

  const strCleaning =
    /\b(airbnb|vacation\s*rental|short\s*term\s*rental|str|turnover|guest[-\s]?ready|checkout|check-out)\b/i.test(t);

  const deepCleaning =
    /\b(deep\s*clean|deep\s*cleaning|spring\s*clean|detail\s*cleaning|baseboards?|inside\s*cabinets?)\b/i.test(t);

  const moveCleaning =
    /\b(move\s*out|move-out|move\s*in|move-in|move\s*in\s*\/\s*move\s*out|tenant\s*turnover|vacancy\s*clean)\b/i.test(t);

  if (serviceName === 'turnover_clean') return strCleaning || propertyCleaning;
  if (serviceName === 'deep_clean') return deepCleaning || propertyCleaning;
  if (serviceName === 'move_out_clean') return moveCleaning || propertyCleaning;

  return propertyCleaning || /\b(standard\s*clean|regular\s*clean|recurring\s*clean)\b/i.test(t);
}

function hasPublicPackageRateContext(text = '') {
  const t = String(text || '').toLowerCase();

  return /\$\s*[1-9]\d{1,3}/.test(t) &&
    /\b(pricing|price|prices|rates?|cost|typical\s*cost|starts?\s*at|starting\s*at|starting\s*price|typical\s*range|average\s*cleaning\s*prices?|per\s*clean|per\s*cleaning|flat\s*rate|package)\b/i.test(t) &&
    !/\b(per\s*hour|hourly|\/\s*hr|\bhr\b|salary|wage|job|jobs|hiring)\b/i.test(t);
}

function hasPublicPackageRangeText(text = '') {
  const t = String(text || '').toLowerCase();

  return /\$\s*[1-9]\d{1,3}\s*(?:-|–|—|to)\s*\$?\s*[1-9]\d{1,3}/i.test(t) &&
    /\b(typical\s*range|typical\s*cost|local\s*typical\s*range|average\s*cleaning\s*prices?|package|per\s*clean|standard\s*clean|regular\s*clean|deep\s*clean|move[-\s]*out|move[-\s]*in|airbnb|vacation\s*rental|turnover)\b/i.test(t);
}

function shouldRejectGenericBookingSource({ domain = '', text = '', service = 'standard_clean' }) {
  if (!isGenericBookingDomain(domain)) return false;

  // Booking/Square pages are allowed only when they clearly show
  // property-cleaning + service context + public package price.
  return !(
    hasStrongPropertyCleaningContext(text, service) &&
    hasPublicPackageRateContext(text) &&
    serviceKeywordMatch(text, service)
  );
}

function makeSyntheticPriceSignal({ price, title, link, query, service, priceContext, sourceProvider, fullPage }) {
  const serviceName = normalizeService(service);
  const context = String(priceContext || '').replace(/\s+/g, ' ').trim();

  return {
    price: Number(price),
    title,
    link,
    domain: domainFromUrl(link),
    snippet: context,
    query,
    priceContext: context,
    flags: {
      ...priceFlagsForContext(context, serviceName),
      serviceStrong: true,
      serviceMismatch: false,
      hourly: false,
      costFloor: false,
      publicPackageRate: true,
      strongPropertyCleaningContext: true,
      rangeContext: /range|between|from|to|starts?\s*at|starting\s*at|typical|average/i.test(context),
    },
    serviceMatch: {
      urlServiceMatch: serviceKeywordMatch(link, serviceName),
      titleServiceMatch: serviceKeywordMatch(title, serviceName),
      contextServiceMatch: true,
      sectionServiceMatch: true,
      syntheticServicePrice: true,
    },
    sourceProvider: sourceProvider || 'search',
    fullPage: !!fullPage,
  };
}

function extractServiceLabeledPackageSignals({ title = '', snippet = '', link = '', query = '', service = '', sourceProvider, fullPage }) {
  const serviceName = normalizeService(service);
  const domain = domainFromUrl(link);
  const text = normalizeRateText(`${title} ${snippet}`).replace(/\s+/g, ' ');
  const signals = [];

  function add(price, label, rawContext) {
    if (!Number.isFinite(Number(price)) || Number(price) <= 0) return;

    signals.push(makeSyntheticPriceSignal({
      price: Number(price),
      title,
      link,
      query,
      service: serviceName,
      priceContext: rawContext || `${label} package price ${price}`,
      sourceProvider,
      fullPage,
    }));
  }

  // Catalina page has multiple service prices in one sentence.
  // Extract only the price for the current service.
  if (domainMatchesAny(domain, ['catalinacleaning.com'])) {
    const catalinaMap = [
      [
        'standard_clean',
        /\$\s*([1-9]\d{1,3})(?:\.\d{2})?\s*(?:for\s*)?standard\s*cleans?/i,
        'Catalina standard clean starting price',
      ],
      [
        'deep_clean',
        /\$\s*([1-9]\d{1,3})(?:\.\d{2})?\s*(?:for\s*)?deep\s*cleans?/i,
        'Catalina deep clean starting price',
      ],
      [
        'move_out_clean',
        /\$\s*([1-9]\d{1,3})(?:\.\d{2})?\s*(?:for\s*)?move\s*in\s*\/?\s*move\s*out\s*cleans?/i,
        'Catalina move in/move out starting price',
      ],
      [
        'turnover_clean',
        /\$\s*([1-9]\d{1,3})(?:\.\d{2})?\s*(?:for\s*)?(?:airbnb|vacation\s*rental|turnover)\s*cleans?/i,
        'Catalina STR/turnover starting price',
      ],
    ];

    for (const [svc, re, label] of catalinaMap) {
      if (svc !== serviceName) continue;

      const m = text.match(re);
      if (m) {
        add(
          Number(m[1]),
          label,
          `${label}: $${m[1]} · Broward County / South Florida`
        );
      }
    }

    // Catalina service pages sometimes say only "Starting price $307".
    if (!signals.length) {
      const start = text.match(/starting\s*price\s*\$\s*([1-9]\d{1,3})(?:\.\d{2})?/i);

      if (start && serviceKeywordMatch(`${title} ${link}`, serviceName)) {
        add(
          Number(start[1]),
          'Catalina service page starting price',
          `Catalina ${serviceLabel(serviceName)} starting price: $${start[1]}`
        );
      }
    }
  }

    // D&D Cleaning Miami public pricing table.
  // Rows include Standard, Deep, Move-In/Move-Out, and Airbnb/Vacation Rental.
  if (domainMatchesAny(domain, ['dndcleaningservicesusa.com'])) {
    const rowPatterns = [];

    if (serviceName === 'standard_clean') {
      rowPatterns.push(/standard\s*cleaning[^$]{0,120}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})[^$]{0,80}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})[^$]{0,80}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})/i);
    }

    if (serviceName === 'deep_clean') {
      rowPatterns.push(/deep\s*cleaning[^$]{0,120}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})[^$]{0,80}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})[^$]{0,80}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})/i);
    }

    if (serviceName === 'move_out_clean') {
      rowPatterns.push(/move[-\s]*in\s*\/\s*move[-\s]*out[^$]{0,120}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})[^$]{0,80}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})[^$]{0,80}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})/i);
    }

    if (serviceName === 'turnover_clean') {
      rowPatterns.push(/airbnb\s*\/\s*vacation\s*rental[^$]{0,100}?(?:from\s*)?\$\s*([1-9]\d{1,3})[^$]{0,80}?(?:from\s*)?\$\s*([1-9]\d{1,3})[^$]{0,80}?(?:from\s*)?\$\s*([1-9]\d{1,3})/i);
    }

    for (const re of rowPatterns) {
      const m = text.match(re);
      if (!m) continue;

      const nums = m.slice(1)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n >= 70 && n <= 900)
        .sort((a, b) => a - b);

      if (nums.length >= 2) {
        const low = nums[0];
        const high = nums[nums.length - 1];

        add(
          low,
          'D&D Cleaning Miami low',
          `D&D Cleaning ${serviceLabel(serviceName)} Miami pricing table: $${low} - $${high}`
        );

        add(
          high,
          'D&D Cleaning Miami high',
          `D&D Cleaning ${serviceLabel(serviceName)} Miami pricing table: $${low} - $${high}`
        );

        break;
      }
    }
  }

    // South Beach Cleaning public pricing guide.
  // Basic cleaning maps to Standard Clean; Deep cleaning maps to Deep Clean.
  if (domainMatchesAny(domain, ['southbeachcleaning.com'])) {
    if (serviceName === 'standard_clean' || serviceName === 'deep_clean') {
      const prices = [];

      const blockMatches = [
        ...text.matchAll(/\b(?:studio|1\s*bedroom|2\s*bedroom|3\s*bedroom|4\s*bedroom|2000\s*\+\s*sq\s*ft)[^$]{0,140}?\$\s*([1-9]\d{1,3})\s*deep\s*cleaning[^$]{0,80}?\$\s*([1-9]\d{1,3})\s*basic\s*cleaning/gi),
      ];

      for (const m of blockMatches) {
        const deep = Number(m[1]);
        const basic = Number(m[2]);

        if (serviceName === 'deep_clean' && Number.isFinite(deep)) prices.push(deep);
        if (serviceName === 'standard_clean' && Number.isFinite(basic)) prices.push(basic);
      }

      const clean = [...new Set(prices)]
        .filter((n) => Number.isFinite(n) && n >= 70 && n <= 500)
        .sort((a, b) => a - b);

      if (clean.length >= 2) {
        add(
          clean[0],
          'South Beach Cleaning low',
          `South Beach Cleaning ${serviceLabel(serviceName)} pricing guide: $${clean[0]} - $${clean[clean.length - 1]}`
        );

        add(
          clean[clean.length - 1],
          'South Beach Cleaning high',
          `South Beach Cleaning ${serviceLabel(serviceName)} pricing guide: $${clean[0]} - $${clean[clean.length - 1]}`
        );
      }
    }
  }

  // The Florida Maid local service pages expose clear local typical-cost ranges.
  // Example pages include Airbnb, regular, deep, and move-in/move-out cleaning.
  if (domainMatchesAny(domain, ['thefloridamaid.com'])) {
    const serviceRangePatterns = [];

    if (serviceName === 'turnover_clean') {
      serviceRangePatterns.push(
        /airbnb\s*&?\s*short[-\s]*term\s*rental\s*cleaning[^$]{0,220}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})/i,
        /airbnb[^$]{0,180}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})/i,
        /short[-\s]*term\s*rental[^$]{0,180}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})/i
      );
    }

    if (serviceName === 'standard_clean') {
      serviceRangePatterns.push(
        /regular\s*house\s*cleaning[^$]{0,220}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})/i,
        /regular\s*cleaning[^$]{0,180}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})/i,
        /standard\s*cleaning[^$]{0,180}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})/i
      );
    }

    if (serviceName === 'deep_clean') {
      serviceRangePatterns.push(
        /deep\s*cleaning[^$]{0,220}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})/i,
        /deep\s*clean[^$]{0,180}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})/i
      );
    }

    if (serviceName === 'move_out_clean') {
      serviceRangePatterns.push(
        /move[-\s]*in\s*\/?\s*move[-\s]*out\s*cleaning[^$]{0,220}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})/i,
        /move[-\s]*out\s*cleaning[^$]{0,180}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})/i,
        /move[-\s]*in\s*move[-\s]*out[^$]{0,180}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})/i
      );
    }

    for (const re of serviceRangePatterns) {
      const m = text.match(re);
      if (!m) continue;

      const low = Number(m[1]);
      const high = Number(m[2]);

      if (Number.isFinite(low) && Number.isFinite(high) && high >= low) {
        add(
          low,
          'The Florida Maid local low',
          `The Florida Maid ${serviceLabel(serviceName)} local typical range: $${low} - $${high}`
        );

        add(
          high,
          'The Florida Maid local high',
          `The Florida Maid ${serviceLabel(serviceName)} local typical range: $${low} - $${high}`
        );

        break;
      }
    }

    // Fallback for The Florida Maid pages when markdown separates heading and range.
    // Still service-safe because URL/title must match requested service.
    if (!signals.length && serviceKeywordMatch(`${title} ${link}`, serviceName)) {
      const normalized = normalizeRateText(text);

      const rangeCandidates = [
        ...normalized.matchAll(/\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})/gi),
      ]
        .map((m) => ({
          low: Number(m[1]),
          high: Number(m[2]),
          idx: m.index || 0,
          context: contextAround(normalized, m.index || 0, (m.index || 0) + m[0].length, 180),
        }))
        .filter((r) =>
          Number.isFinite(r.low) &&
          Number.isFinite(r.high) &&
          r.high >= r.low &&
          r.low >= 50 &&
          r.high <= 900
        );

      // Prefer ranges near "Typical cost" or the requested service phrase.
      const preferred = rangeCandidates.find((r) =>
        /\btypical\s*cost\b/i.test(r.context) ||
        serviceKeywordMatch(r.context, serviceName)
      ) || rangeCandidates[0];

      if (preferred) {
        add(
          preferred.low,
          'The Florida Maid local page low',
          `The Florida Maid ${serviceLabel(serviceName)} local page range: $${preferred.low} - $${preferred.high}`
        );

        add(
          preferred.high,
          'The Florida Maid local page high',
          `The Florida Maid ${serviceLabel(serviceName)} local page range: $${preferred.low} - $${preferred.high}`
        );
      }
    }
  }

  // Turno local STR pages expose average cleaning prices by bedroom count.
  // Use as local marketplace support evidence, not single local-vendor verification.
  if (domainMatchesAny(domain, ['turno.com']) && serviceName === 'turnover_clean') {
    const turnoPrices = [];

    const bedroomRangeMatches = [
      ...text.matchAll(/\b(?:1|2|3|4)\s*(?:bed|bedroom|br)?[^$]{0,70}?\$\s*([1-9]\d{1,3})\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})/gi),
    ];

    for (const m of bedroomRangeMatches) {
      const low = Number(m[1]);
      const high = Number(m[2]);
      if (Number.isFinite(low) && Number.isFinite(high) && high >= low) {
        turnoPrices.push(low, high);
      }
    }

    const clean = [...new Set(turnoPrices)]
      .filter((n) => Number.isFinite(n) && n >= 70 && n <= 300)
      .sort((a, b) => a - b);

    if (clean.length) {
      add(
        clean[0],
        'Turno local STR low',
        `Turno local STR average cleaning prices: $${clean[0]} - $${clean[clean.length - 1]}`
      );

      add(
        clean[clean.length - 1],
        'Turno local STR high',
        `Turno local STR average cleaning prices: $${clean[0]} - $${clean[clean.length - 1]}`
      );
    }
  }

  // Homeyou pages show "Typical Range: $153 - $191".
  if (domainMatchesAny(domain, ['homeyou.com'])) {
    const rangePatterns = [
      /typical\s*range\s*:?\s*\$\s*([1-9]\d{1,3})(?:\.\d{2})?\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})(?:\.\d{2})?/i,
      /average[^.]{0,80}?cost[^.]{0,80}?\$\s*([1-9]\d{1,3})(?:\.\d{2})?\s*(?:-|–|—|to)\s*\$?\s*([1-9]\d{1,3})(?:\.\d{2})?/i,
    ];

    for (const re of rangePatterns) {
      const m = text.match(re);
      if (!m) continue;

      const low = Number(m[1]);
      const high = Number(m[2]);

      if (Number.isFinite(low) && Number.isFinite(high) && high >= low) {
        add(
          low,
          'Homeyou local typical low',
          `Homeyou local ${serviceLabel(serviceName)} typical range: $${low} - $${high}`
        );

        add(
          high,
          'Homeyou local typical high',
          `Homeyou local ${serviceLabel(serviceName)} typical range: $${low} - $${high}`
        );

        break;
      }
    }
  }

  // Gallas STR page has "$80 to $150 per clean".
  if (domainMatchesAny(domain, ['gallasroyalcleaning.com']) && serviceName === 'turnover_clean') {
    const m = text.match(
      /(?:prices?\s*)?(?:typically\s*)?range\s*(?:from|between)?\s*\$\s*([1-9]\d{1,3})(?:\.\d{2})?\s*(?:-|–|—|to|and)\s*\$?\s*([1-9]\d{1,3})(?:\.\d{2})?\s*per\s*clean/i
    );

    if (m) {
      const low = Number(m[1]);
      const high = Number(m[2]);

      add(low, 'Gallas Airbnb clean low', `Gallas Airbnb cleaning per-clean range: $${low} - $${high}`);
      add(high, 'Gallas Airbnb clean high', `Gallas Airbnb cleaning per-clean range: $${low} - $${high}`);
    }
  }

  return signals;
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

  // Marketplace support sources. These help consensus, but do not become
  // verified_local_vendor by themselves.
  if (domainMatchesAny(domain, ['turno.com', 'homeyou.com', 'thumbtack.com'])) return 0.18;

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

  const fullText = `${signal.title || ''} ${signal.link || ''} ${signal.query || ''} ${signal.priceContext || ''}`.toLowerCase();

  const domain = signal.domain || domainFromUrl(signal.link || signal.url || '');

  if (sourceTypeForDomain(domain) === 'social') {
    reasons.push('social_source_not_customer_package_price');
  }

  if (isBlockedPriceDomain(domain) || isBadMarketRatePage({
    title: signal.title,
    snippet: `${signal.snippet || ''} ${signal.priceContext || ''}`,
    url: signal.link || signal.url || '',
    service: serviceName,
  })) {
    reasons.push('bad_market_rate_page');
  }

  const isSyntheticServicePrice = !!(
    signal.serviceMatch?.syntheticServicePrice ||
    signal.serviceMatch?.sectionServiceMatch
  );

  const priceContextText = String(signal.priceContext || '').toLowerCase();

  // For service-labeled extracted ranges, only judge hourly from the extracted
  // price context. Some vendor page titles say "From $49/hr", while the actual
  // service card has a package/range like "$196 - $390".
  const hourlyCheckText = isSyntheticServicePrice ? priceContextText : fullText;

  if (/\bfrom\s*\$?\d+(?:\.\d{2})?\s*\/?\s*(hr|hour)|per\s*hour|hourly\b/i.test(hourlyCheckText)) {
    reasons.push('hourly_price_not_package_price');
  }

  if (signal.customPricing || signal.flags?.customPricing) {
    return {
      keep: false,
      reasons: ['custom_pricing_no_public_package_price'],
      strongServiceMatch: true,
      urlServiceMatch: serviceKeywordMatch(signal.link || '', serviceName),
      contextServiceMatch: true,
      titleServiceMatch: serviceKeywordMatch(signal.title || '', serviceName),
      textMatched: true,
      customPricing: true,
    };
  }

  if (!Number.isFinite(price) || price <= 0) reasons.push('invalid_price');

  if (flags.nonPropertyCleaning || isNonPropertyCleaningContext(fullText)) {
    reasons.push('non_property_cleaning_service');
  }

  if (shouldRejectGenericBookingSource({ domain, text: fullText, service: serviceName })) {
    reasons.push('generic_booking_page_without_strong_property_rate');
  }

  if (isBroadGuideDomain(domain)) {
    reasons.push('broad_guide_not_local_vendor');
  }

  if (flags.costFloor) reasons.push('cleaner_or_labor_cost_not_customer_price');
  if (!isSyntheticServicePrice && flags.hourly && price < rules.softLow) {
    reasons.push('hourly_price_not_package_price');
  }
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

  const sectionServiceMatch = !!signal.serviceMatch?.sectionServiceMatch;

  if (price > rules.hardHigh) {
    reasons.push('above_hard_outlier_cap');
  } else if (sectionServiceMatch && price <= rules.softHigh) {
    // Section-matched prices like "Deep Cleaning Starting at $270"
    // should not be rejected just because the same page has other higher service prices.
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

  if (isNonPropertyCleaningContext(text)) {
    multiplier *= 0.02;
    reasons.push('non_property_cleaning_service');
    exclude = true;
  }

  if (shouldRejectGenericBookingSource({ domain, text, service: serviceName })) {
    multiplier *= 0.04;
    reasons.push('generic_booking_page_without_strong_property_rate');
    exclude = true;
  }

  if (broadGuide) {
    multiplier *= 0.08;
    reasons.push('broad_guide_not_local_vendor');
    exclude = true;
  }

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
    multiplier *= 0.35;
    reasons.push('broad_unknown_location_guide');
  }

  if (broadGuide && !exactLocation) {
    multiplier *= 0.18;
    reasons.push('broad_guide_not_local_vendor');
    exclude = true;
  }

  // For STR turnover, national/blog guide pages should not become accepted
  // market-rate evidence. They can show in rejected reasons, but not set median.
  if (serviceName === 'turnover_clean' && broadGuide) {
    multiplier *= 0.12;
    reasons.push('broad_guide_not_local_str_vendor');

    // AirROI/HomeGuide/etc. are not local STR cleaning vendors.
    // Reject unless this is somehow exact ZIP/city + real vendor pricing,
    // which broad guides usually are not.
    if (!exactLocation || !vendorPricingPage) {
      exclude = true;
    }
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
  const vendorPricingPage = looksLikeVendorPricingPage({ ...sample, domain, service });
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
      service: normalizeService(service),
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
  return clamp(num(process.env.FIRECRAWL_TOP_PAGES_PER_SERVICE, 8), 0, 10);
}

function shouldTryFirecrawl() {
  const raw = String(process.env.FIRECRAWL_ENABLED ?? 'true').trim().toLowerCase();
  return !!(process.env.FIRECRAWL_API_KEY || process.env.FIRECRAWL_DEV_API_KEY) &&
    !['0', 'false', 'off', 'no'].includes(raw);
}

function itemQualityPreview(item = {}, ctx, service) {
  const url = item.link || item.url || '';
  const domain = domainFromUrl(url);
  const text = `${item.title || ''} ${item.snippet || ''} ${url}`;

  const location = locationQuality({
    title: item.title,
    snippet: item.snippet,
    link: url,
  }, ctx);

  const vendorPricingPage = looksLikeVendorPricingPage({
    title: item.title,
    snippet: item.snippet,
    domain,
    service,
  });

  if (isBadMarketRatePage({
    title: item.title,
    snippet: item.snippet,
    url,
    service,
  })) {
    return {
      score: -10,
      domain,
      locationStatus: location.status,
      vendorPricingPage: false,
      badMarketRatePage: true,
    };
  }

  let score = sourceBaseWeight(domain) + priceContextScore(text, service);
  score += sourceTrustBoost(domain);
  score += exactServicePageBoost(domain, item, service, ctx);
  score += priorityRateSourceBoost(domain, text);

  if (vendorPricingPage) score += 0.35;
  score *= location.multiplier;

  if (sourceTypeForDomain(domain) === 'social') score *= 0.25;

  return { score, domain, locationStatus: location.status, vendorPricingPage, badMarketRatePage: false };
}

function pickFirecrawlTargets(items = [], ctx, service) {
  const max = firecrawlTopPagesPerService();
  if (!max) return [];

  const seen = new Set();
  const serviceName = normalizeService(service);

  return items
    .map((item) => ({ item, q: itemQualityPreview(item, ctx, serviceName) }))
    .filter(({ item, q }) => {
      const url = normalizeUrlKey(item.link || item.url || '');
      if (!url || seen.has(url)) return false;
      seen.add(url);

      const seeded = !!item.seededPublicRatePage;

      // Seeded public pricing URLs bypass weak search-snippet checks.
      // They still must be scraped and parsed from live page text.
      if (seeded) return true;

      if (q.badMarketRatePage) return false;

      const domain = q.domain || domainFromUrl(url);
      const type = sourceTypeForDomain(domain);
      const text = `${item.title || ''} ${item.snippet || ''} ${url}`.toLowerCase();

      if (isBadMarketRatePage({
        title: item.title,
        snippet: item.snippet,
        url,
        service: serviceName,
      })) {
        return false;
      }

      if (type === 'social') return false;
      if (q.locationStatus === 'wrong_city_low_weight') return false;

      if (isBadDiscoveryResult({
        title: item.title,
        snippet: item.snippet,
        url,
      })) {
        return false;
      }

      const cleaningPage = hasStrongPropertyCleaningContext(text, serviceName);

      const serviceish =
        serviceKeywordMatch(text, serviceName) ||
        serviceKeywordMatch(url, serviceName) ||
        cleaningPage;

      return serviceish && q.score >= 0.12;
    })
    .sort((a, b) => {
      const seededA = a.item.seededPublicRatePage ? 1 : 0;
      const seededB = b.item.seededPublicRatePage ? 1 : 0;

      if (seededA !== seededB) return seededB - seededA;
      return b.q.score - a.q.score;
    })
    .slice(0, max)
    .map(({ item }) => item);
}

function trimForSnippet(text = '', limit = 12000) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, limit);
}

function normalizeRateText(value = '') {
  return String(value || '')
    .replace(/\\\$/g, '$')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&ndash;|&#8211;|&#x2013;/gi, '–')
    .replace(/&mdash;|&#8212;|&#x2014;/gi, '—')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToReadableText(html = '') {
  return normalizeRateText(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<\/(h1|h2|h3|h4|p|div|section|article|li|br|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
  );
}

async function fetchTextWithTimeout(url, options = {}, timeoutMs = 20000) {
  ensureFetch();

  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), Math.max(1000, Number(timeoutMs || 20000))) : null;

  try {
    const res = await fetchFn(url, { ...options, signal: ac?.signal });
    const text = await res.text().catch(() => '');
    return { res, text };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function directPublicPageFetch(url, originalItem = {}) {
  const { res, text } = await fetchTextWithTimeout(url, {
    method: 'GET',
    headers: {
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 PropertySantaBot/1.0 market-rate-verifier',
    },
  }, num(process.env.MARKET_DIRECT_FETCH_TIMEOUT_MS, 20000));

  if (!res.ok || !text) {
    const err = new Error(`Direct public page fetch failed with ${res.status}`);
    err.status = res.status || 400;
    err.code = 'DIRECT_PUBLIC_PAGE_FETCH_FAILED';
    throw err;
  }

  const readable = htmlToReadableText(text);

  if (!readable || readable.length < 120) {
    const err = new Error('Direct public page fetch returned too little readable text');
    err.status = res.status || 400;
    err.code = 'DIRECT_PUBLIC_PAGE_EMPTY_TEXT';
    throw err;
  }

  return {
    title: originalItem.title || domainFromUrl(url) || 'Public pricing page',
    link: url,
    snippet: trimForSnippet(readable, 16000),
    query: `${originalItem.query || ''} · direct_public_page`,
    sourceProvider: 'direct_public_page',
    fullPage: true,
    seededPublicRatePage: !!originalItem.seededPublicRatePage,
  };
}

function normalizeFirecrawlData(data, originalItem) {
  const payload = data?.data || data || {};
  const markdown = normalizeRateText(payload.markdown || payload.content || payload.text || payload.html || '');
  const meta = payload.metadata || payload.meta || {};
  const url = payload.url || payload.sourceURL || meta.sourceURL || meta.url || originalItem.link || originalItem.url || '';
  const title = meta.title || payload.title || originalItem.title || domainFromUrl(url) || 'Vendor page';

  return {
    title,
    link: url,
    snippet: trimForSnippet(markdown, 12000),
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
  const seededItems = seededPublicRatePagesForService({ ctx, service });
  const crawlCandidates = [...seededItems, ...items];

  if (!shouldTryFirecrawl()) {
    return {
      items,
      enrichment: {
        provider: null,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        seeded: seededItems.length,
        skippedReason: 'Firecrawl disabled or FIRECRAWL_API_KEY missing',
      },
    };
  }

  const targets = pickFirecrawlTargets(crawlCandidates, ctx, service);

  if (!targets.length) {
    return {
      items,
      enrichment: {
        provider: 'firecrawl',
        attempted: 0,
        succeeded: 0,
        failed: 0,
        seeded: seededItems.length,
      },
    };
  }

  const enriched = [];
  let failed = 0;
  const failures = [];

  for (const target of targets) {
    const targetUrl = target.link || target.url;

    try {
      const scraped = await firecrawlScrape(targetUrl, target);

      if (scraped?.snippet && scraped.snippet.length > 120) {
        enriched.push({
          ...scraped,
          seededPublicRatePage: !!target.seededPublicRatePage,
        });
        continue;
      }

      // Firecrawl succeeded but returned weak/no readable text.
      // For seeded public pricing pages, fetch live HTML directly.
      if (target.seededPublicRatePage) {
        const direct = await directPublicPageFetch(targetUrl, target);
        enriched.push(direct);
        continue;
      }

      failed += 1;
      failures.push({
        url: targetUrl,
        domain: domainFromUrl(targetUrl),
        reason: 'Firecrawl returned no readable page text',
      });
    } catch (err) {
      // Firecrawl can fail on some public vendor pages.
      // For seeded public pricing pages, still try direct live HTML fetch.
      if (target.seededPublicRatePage) {
        try {
          const direct = await directPublicPageFetch(targetUrl, target);
          enriched.push(direct);
          failures.push({
            url: targetUrl,
            domain: domainFromUrl(targetUrl),
            reason: `Firecrawl failed, direct fetch succeeded: ${err.message || String(err)}`,
            recoveredByDirectFetch: true,
          });
          continue;
        } catch (directErr) {
          failed += 1;
          failures.push({
            url: targetUrl,
            domain: domainFromUrl(targetUrl),
            reason: `Firecrawl failed and direct fetch failed: ${err.message || String(err)} | ${directErr.message || String(directErr)}`,
            code: directErr.code || err.code || null,
            status: directErr.status || err.status || null,
          });
          continue;
        }
      }

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
    // Seeds themselves are NOT evidence. Only live scraped/fetched page text is added.
    items: [...items, ...enriched],
    enrichment: {
      provider: 'firecrawl',
      attempted: targets.length,
      succeeded: enriched.length,
      failed,
      seeded: seededItems.length,
      recoveredByDirectFetch: failures.filter((f) => f.recoveredByDirectFetch).length,
      failures,
    },
  };
}

function summarizeEvidence(results = []) {
  const byDomain = new Map();

  for (const r of results) {
    const key = r.domain || domainFromUrl(r.link || r.url) || r.title;
    if (!key || byDomain.has(key)) continue;

    const url = r.link || r.url || '';
    const domain = r.domain || domainFromUrl(url);
    const sourceType = r.sourceType || sourceTypeForDomain(domain);

    byDomain.set(key, {
      domain: key,
      title: r.title || key,
      url,
      snippet: String(r.snippet || '').slice(0, 300),
      extractedPrice: r.price || null,
      query: r.query || '',
      sourceType,
      sourceTier: r.sourceTier || sourceTierForSignal(r),
      locationStatus: r.locationStatus || '',
      vendorPricingPage: !!r.vendorPricingPage,
      weight: r.weight ? Number(Number(r.weight).toFixed(2)) : null,
    });
  }

  return [...byDomain.values()].slice(0, 10);
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
  const marketplaceCount = weightedSignals.filter((s) => s.sourceType === 'marketplace').length;
  const socialCount = weightedSignals.filter((s) => s.sourceType === 'social').length;

  const wrongCityCount = weightedSignals.filter((s) => s.locationStatus === 'wrong_city_low_weight').length;
  const mixedLocationCount = weightedSignals.filter((s) => s.locationStatus === 'mixed_location').length;
  const exactLocationCount = weightedSignals.filter((s) => ['zip_match', 'city_match'].includes(s.locationStatus)).length;

  const tierACount = weightedSignals.filter((s) => s.sourceTier === 'A_local_vendor').length;
  const tierBCount = weightedSignals.filter((s) => s.sourceTier === 'B_local_marketplace').length;
  const tierCCount = weightedSignals.filter((s) => s.sourceTier === 'C_nearby_market').length;
  const tierDCount = weightedSignals.filter((s) => s.sourceTier === 'D_national_guide').length;
  const tierECount = weightedSignals.filter((s) => s.sourceTier === 'E_social').length;

  const primaryConsensusCount = weightedSignals.filter(isPrimaryConsensusSignal).length;

  const costFloorCount = weightedSignals.filter((s) =>
    (s.policyReasons || []).includes('cost_floor_or_cleaner_side_price')
  ).length;

  const serviceMismatchCount = weightedSignals.filter((s) =>
    (s.policyReasons || []).includes('service_context_mismatch')
  ).length;

  const outlierCount = weightedSignals.filter((s) =>
    (s.policyReasons || []).includes('above_hard_outlier_cap') ||
    (s.policyReasons || []).includes('above_service_soft_high') ||
    (s.policyReasons || []).includes('below_service_soft_low') ||
    (s.policyReasons || []).includes('below_customer_market_minimum')
  ).length;

  const broadGuideCount = weightedSignals.filter((s) =>
    (s.policyReasons || []).includes('broad_guide_not_local_str_vendor') ||
    (s.policyReasons || []).includes('broad_guide_not_local_vendor') ||
    (s.policyReasons || []).includes('broad_unknown_location_guide') ||
    s.sourceTier === 'D_national_guide'
  ).length;

  const rejectedSignalCount = Array.isArray(rejectedSignals) ? rejectedSignals.length : 0;
  const totalWeight = weightedSignals.reduce((sum, s) => sum + Number(s.weight || 0), 0);

  return {
    sourceCount,
    vendorCount,
    marketplaceCount,
    socialCount,
    wrongCityCount,
    mixedLocationCount,
    exactLocationCount,
    tierACount,
    tierBCount,
    tierCCount,
    tierDCount,
    tierECount,
    primaryConsensusCount,
    costFloorCount,
    serviceMismatchCount,
    outlierCount,
    broadGuideCount,
    rejectedSignalCount,
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

function displayRejectedSignals(signals = []) {
  return signals.slice(0, 12).map((s) => ({
    price: s.price,
    title: s.title,
    url: s.link || s.url,
    domain: s.domain,
    reasons: s.rejectReasons || s.policyReasons || [],
    context: String(s.priceContext || s.context || '').slice(0, 180),
  }));
}

function weakDraftSignals(rejectedSignals = [], service) {
  const serviceName = normalizeService(service);

  return (rejectedSignals || [])
    .filter((s) => {
      const price = Number(s.price || 0);

      if (s.customPricing || s.signalDecision?.customPricing || (s.rejectReasons || []).includes('custom_pricing_no_public_package_price')) {
        return false;
      }

      if (!Number.isFinite(price) || price <= 0) return false;

      const reasons = s.rejectReasons || s.policyReasons || [];
      const reasonText = reasons.join(' ').toLowerCase();
      const domain = s.domain || domainFromUrl(s.link || s.url || '');
      const text = `${domain} ${s.title || ''} ${s.snippet || ''} ${s.context || ''} ${s.priceContext || ''} ${s.link || s.url || ''}`.toLowerCase();

      if (!domain) return false;
      if (sourceTypeForDomain(domain) === 'social') return false;
      if (isBroadGuideDomain(domain)) return false;
      if (isBlockedPriceDomain(domain)) return false;

      if (isBadDiscoveryResult({
        title: s.title,
        snippet: `${s.snippet || ''} ${s.context || ''} ${s.priceContext || ''}`,
        url: s.link || s.url || '',
      })) {
        return false;
      }

      if (isNonPropertyCleaningContext(text)) return false;
      if (shouldRejectGenericBookingSource({ domain, text, service: serviceName })) return false;

      // These are too unsafe even for draft pricing.
      if (/wrong_city|bad_market|bad market|social_source|social source|non_property|non property|generic_booking|generic booking|service_context_mismatch|wrong_service|cost_floor|cleaner_or_labor|cleaner side|hourly|not_package|not package|job|salary|wage|hiring|above_hard_outlier|outlier high/.test(reasonText)) {
        return false;
      }

      // Draft evidence still must be property-cleaning related.
      if (!hasStrongPropertyCleaningContext(text, serviceName)) {
        return false;
      }

      // Service sanity floors for draft rows.
      if (serviceName === 'turnover_clean' && price < 95) return false;
      if (serviceName === 'move_out_clean' && price < 150) return false;
      if (serviceName === 'deep_clean' && price < 130) return false;
      if (serviceName === 'standard_clean' && price < 90) return false;

      return true;
    })
    .slice(0, 8);
}

function evidenceHasLocalVendorPages(evidence = [], ctx = {}, service = 'standard_clean') {
  return (evidence || []).filter((e) => {
    const url = e.url || e.link || '';
    const domain = e.domain || domainFromUrl(url);
    const sourceType = e.sourceType || sourceTypeForDomain(domain);
    const text = `${domain} ${e.title || ''} ${e.snippet || ''} ${url}`.toLowerCase();

    if (!domain) return false;
    if (sourceType === 'social') return false;
    if (isBroadGuideDomain(domain)) return false;
    if (isBadDiscoveryResult({ title: e.title, snippet: e.snippet, url })) return false;
    if (isNonPropertyCleaningContext(text)) return false;
    if (shouldRejectGenericBookingSource({ domain, text, service })) return false;

    const localHit = hasTargetLocationText(text, ctx);
    const propertyHit = hasStrongPropertyCleaningContext(text, service);

    return localHit && propertyHit;
  });
}

function buildDraftFromLocalVendorEvidence({
  zip,
  service,
  provider,
  enrichment,
  queries,
  evidence,
  city,
  state,
  reason,
}) {
  const serviceName = normalizeService(service);
  const ctx = locationContext({ zip, city, state });
  const vendorEvidence = evidenceHasLocalVendorPages(evidence, ctx, serviceName);

  if (!vendorEvidence.length) return null;

  // This is NOT verified pricing. It is a draft row because local STR vendor pages exist,
  // but no public package price was exposed.
  let marketLow = 0;
  let marketMedian = 0;
  let marketHigh = 0;

  if (serviceName === 'turnover_clean') {
    marketLow = 135;
    marketMedian = 175;
    marketHigh = 225;
  } else if (serviceName === 'standard_clean') {
    marketLow = 130;
    marketMedian = 180;
    marketHigh = 245;
  } else if (serviceName === 'deep_clean') {
    marketLow = 200;
    marketMedian = 285;
    marketHigh = 430;
  } else if (serviceName === 'move_out_clean') {
    marketLow = 230;
    marketMedian = 360;
    marketHigh = 520;
  }

  ({ marketLow, marketMedian, marketHigh } = applyServiceShapeGuardrails({
    marketLow,
    marketMedian,
    marketHigh,
    service: serviceName,
  }));

  const cleanerPayoutFloor = estimateCleanerPayoutFloor({
    marketMedian,
    service: serviceName,
    ctx,
  });

  const quality = {
    sourceCount: vendorEvidence.length,
    vendorCount: vendorEvidence.length,
    marketplaceCount: 0,
    socialCount: 0,
    wrongCityCount: 0,
    mixedLocationCount: 0,
    exactLocationCount: vendorEvidence.length,
    tierACount: vendorEvidence.length,
    tierBCount: 0,
    tierCCount: 0,
    tierDCount: 0,
    tierECount: 0,
    primaryConsensusCount: vendorEvidence.length,
    costFloorCount: 0,
    serviceMismatchCount: 0,
    outlierCount: 0,
    broadGuideCount: 0,
    rejectedSignalCount: 0,
    totalWeight: Number((vendorEvidence.length * 0.45).toFixed(2)),
    localVendorNoPublicPrice: true,
  };

  return {
    ok: true,
    zip,
    service: serviceName,
    provider,
    enrichment: enrichment || null,
    suggested: {
      marketLow,
      marketMedian,
      marketHigh,
      cleanerPayoutFloor,
      platformMarginPct: serviceName === 'standard_clean' ? 22 : 24,
      paymentFeeBuffer: 8,
      suppliesTravelBuffer: 0,
      confidence: 0.42,
      sourceCount: vendorEvidence.length,
      sources: [
        providerSource(provider),
        'local_vendor_pages_no_public_price',
        ...vendorEvidence.map((e) => e.domain).filter(Boolean).slice(0, 6),
      ],
      status: 'review_required',
      pricingSource: 'ai_search_incomplete',
      reviewStatus: 'draft_from_local_vendor_no_public_price',
      safeToAutoSave: false,
      canAutoApprove: false,
      notes: `Draft from ${vendorEvidence.length} local vendor page(s), but no public package price was exposed. Admin must verify before customer quotes use it. ${reason || ''}`.trim(),
    },
    priceSignals: [],
    rejectedPriceSignals: [],
    confidence: 0.42,
    sourceCount: vendorEvidence.length,
    reviewStatus: 'draft_from_local_vendor_no_public_price',
    canAutoApprove: false,
    safeToAutoSave: false,
    status: 'review_required',
    pricingSource: 'ai_search_incomplete',
    quality,
    queries,
    evidence: vendorEvidence.slice(0, 8).map((e) => ({
      ...e,
      sourceType: e.sourceType || 'vendor_or_web',
      sourceTier: e.sourceTier || 'A_local_vendor',
      locationStatus: e.locationStatus || 'city_match',
      vendorPricingPage: true,
      weight: e.weight || 0.45,
    })),
    notes: `Local vendor pages found, but no public package price was visible.`,
  };
}

function buildReviewDraftSuggestion({
  zip,
  service,
  provider,
  enrichment,
  queries,
  evidence,
  rejectedSignals,
  city,
  state,
  reason,
}) {
  const serviceName = normalizeService(service);
  const ctx = locationContext({ zip, city, state });
  const cleanEvidence = cleanEvidenceForDisplay(evidence, serviceName);
  const weak = weakDraftSignals(rejectedSignals, serviceName);

  if (!weak.length) {
    // No fallback pricing. If public package-price extraction fails,
    // keep the row as no_price_evidence / review_required.
    const localVendorDraft = null;

    if (localVendorDraft) return localVendorDraft;

    return {
      ok: true,
      zip,
      service: serviceName,
      provider,
      enrichment: enrichment || null,
      suggested: null,
      confidence: 0,
      sourceCount: cleanEvidence.length,
      reviewStatus: 'no_price_evidence',
      canAutoApprove: false,
      safeToAutoSave: false,
      status: 'review_required',
      pricingSource: 'ai_search_incomplete',
      quality: buildQualitySummary([], rejectedSignals),
      queries,
      evidence: cleanEvidence,
      rejectedPriceSignals: displayRejectedSignals(rejectedSignals),
      notes: reason || 'Search completed, but no usable customer package-price signal was found.',
    };
  }

  const prices = weak.map((s) => Number(s.price)).filter((n) => Number.isFinite(n) && n > 0);

  let marketLow = roundMarketLow(percentile(prices, 0.25), ctx, serviceName);
  let marketMedian = roundMarketMidHigh(median(prices), marketLow);
  let marketHigh = roundMarketMidHigh(percentile(prices, 0.85), marketMedian);

  ({ marketLow, marketMedian, marketHigh } = applyServiceShapeGuardrails({
    marketLow,
    marketMedian,
    marketHigh,
    service: serviceName,
  }));

  const cleanerPayoutFloor = estimateCleanerPayoutFloor({ marketMedian, service: serviceName, ctx });
  const quality = {
    ...buildQualitySummary([], rejectedSignals),
    draftFromWeakEvidence: true,
  };

  return {
    ok: true,
    zip,
    service: serviceName,
    provider,
    enrichment: enrichment || null,
    suggested: {
      marketLow,
      marketMedian,
      marketHigh,
      cleanerPayoutFloor,
      platformMarginPct: serviceName === 'standard_clean' ? 22 : 24,
      paymentFeeBuffer: 8,
      suppliesTravelBuffer: 0,
      confidence: 0.32,
      sourceCount: cleanEvidence.length || weak.length,
      sources: [providerSource(provider), ...weak.map((e) => e.domain).filter(Boolean).slice(0, 8)],
      status: 'review_required',
      pricingSource: 'ai_search_incomplete',
      reviewStatus: 'draft_from_weak_search_evidence',
      safeToAutoSave: false,
      canAutoApprove: false,
      notes: `Draft only from weak search evidence. Admin must review before customer quotes use it. ${reason || ''}`.trim(),
    },
    priceSignals: [],
    rejectedPriceSignals: displayRejectedSignals(rejectedSignals),
    confidence: 0.32,
    sourceCount: cleanEvidence.length || weak.length,
    reviewStatus: 'draft_from_weak_search_evidence',
    canAutoApprove: false,
    safeToAutoSave: false,
    status: 'review_required',
    pricingSource: 'ai_search_incomplete',
    quality,
    queries,
    evidence: cleanEvidence.length ? cleanEvidence : cleanEvidenceForDisplay(weak, serviceName),
  };
}

function buildSuggestion({ zip, service, priceSignals, evidenceFallback, queries, provider, city, state, enrichment }) {
  const serviceName = normalizeService(service);
  const ctx = locationContext({ zip, city, state });
  const acceptedSignals = [];
  const rejectedSignals = [];

  for (const signal of priceSignals || []) {
    const decision = priceSignalPrecheck(signal, serviceName);

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

  const weightedSignalsRaw = reduceDuplicateSignals(acceptedSignals, ctx, serviceName);
  const policyRejectedSignals = Array.isArray(weightedSignalsRaw.policyRejectedSignals)
    ? weightedSignalsRaw.policyRejectedSignals
    : [];

  const allRejectedSignals = [...rejectedSignals, ...policyRejectedSignals];

  const weightedSignals = weightedSignalsRaw.map((signal) => ({
    ...signal,
    sourceTier: sourceTierForSignal(signal),
  }));

  const evidence = weightedSignals.length
    ? cleanEvidenceForDisplay(summarizeEvidence(weightedSignals), serviceName)
    : cleanEvidenceForDisplay(evidenceFallback, serviceName);
  const label = providerLabel(provider);
  const quality = buildQualitySummary(weightedSignals, allRejectedSignals);

  const allPrices = weightedSignals
    .map((s) => Number(s.price))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!allPrices.length) {
    return buildReviewDraftSuggestion({
      zip,
      service: serviceName,
      provider,
      enrichment,
      queries,
      evidence,
      rejectedSignals: allRejectedSignals,
      city,
      state,
      reason: `${label} completed, but accepted consensus prices were not strong enough.`,
    });
  }

  const primarySignals = weightedSignals.filter(isPrimaryConsensusSignal);

  // If enough A/B/C evidence exists, price from primary consensus.
  // If not, still show a draft price from weak evidence, but do not verify/autosave it.
  const consensusSignals = primarySignals.length >= 2 ? primarySignals : weightedSignals;

  const lowItems = consensusSignals.map((s) => ({ ...s, price: sourceRangeLow(s) }));
  const medianItems = consensusSignals.map((s) => ({ ...s, price: Number(s.price || 0) }));
  const highItems = consensusSignals.map((s) => ({ ...s, price: sourceRangeHigh(s) }));
  const consensusPrices = consensusSignals.map((s) => Number(s.price)).filter((n) => Number.isFinite(n) && n > 0);

  const lowRaw = weightedPercentile(lowItems, 0.25) || percentile(consensusPrices, 0.25);
  const medianRaw = weightedPercentile(medianItems, 0.5) || median(consensusPrices);
  const highRawUncapped =
    weightedPercentile(highItems, consensusPrices.length >= 4 ? 0.75 : 0.85) ||
    percentile(consensusPrices, consensusPrices.length >= 4 ? 0.75 : 0.85);

  const highRaw = applyServiceCaps(highRawUncapped, serviceName, 'high');

  let marketLow = roundMarketLow(lowRaw, ctx, serviceName);
  let marketMedian = roundMarketMidHigh(medianRaw, marketLow);
  let marketHigh = roundMarketMidHigh(highRaw, marketMedian);

  ({ marketLow, marketMedian, marketHigh } = applyServiceShapeGuardrails({
    marketLow,
    marketMedian,
    marketHigh,
    service: serviceName,
  }));

  const uniqueDomains = new Set(consensusSignals.map((e) => e.domain).filter(Boolean)).size;
  const spread = marketMedian ? (marketHigh - marketLow) / marketMedian : 1;
  const socialRatio = quality.sourceCount ? quality.socialCount / quality.sourceCount : 0;
  const avgWeight = quality.sourceCount ? quality.totalWeight / quality.sourceCount : 0;

  let confidence = 0.22;
  confidence += Math.min(0.22, quality.totalWeight * 0.055);
  confidence += Math.min(0.16, uniqueDomains * 0.04);
  confidence += Math.min(0.18, quality.primaryConsensusCount * 0.075);
  confidence += Math.min(0.12, quality.exactLocationCount * 0.035);
  confidence += Math.min(0.08, quality.tierACount * 0.05);
  confidence += Math.min(0.06, quality.tierBCount * 0.035);

  confidence -= Math.min(0.20, spread * 0.12);
  confidence -= Math.min(0.14, socialRatio * 0.16);
  confidence -= Math.min(0.16, quality.wrongCityCount * 0.08);
  confidence -= Math.min(0.12, quality.mixedLocationCount * 0.04);
  confidence -= Math.min(0.14, quality.costFloorCount * 0.05);
  confidence -= Math.min(0.14, quality.serviceMismatchCount * 0.05);
  confidence -= Math.min(0.12, quality.outlierCount * 0.035);
  confidence -= Math.min(0.10, quality.broadGuideCount * 0.03);

  if (avgWeight < 0.45) confidence -= 0.08;

  const trustedCount = trustedConsensusSourceCount(weightedSignals);
  const strongDirectLocalCount = weightedSignals.filter(isStrongDirectLocalPriceSignal).length;
  const hasStrongDirectLocalVendor = strongDirectLocalCount >= 1;

  const onlyWeakEvidence = !hasStrongDirectLocalVendor && (trustedCount < 2 || primarySignals.length < 2);
  const onlySocial = quality.socialCount > 0 && quality.vendorCount === 0 && quality.marketplaceCount === 0;
  const onlyBroadGuide = quality.broadGuideCount > 0 && trustedCount === 0;

  if (hasStrongDirectLocalVendor) {
    confidence += Math.min(0.12, strongDirectLocalCount * 0.08);
  }

  if (onlyWeakEvidence) confidence = Math.min(confidence, 0.55);
  if (onlySocial) confidence = Math.min(confidence, 0.35);
  if (onlyBroadGuide) confidence = Math.min(confidence, 0.42);

  // A direct local vendor page with a service-specific public price is good enough
  // for customer-ready admin suggestions, even if only one source was found.
  if (
    hasStrongDirectLocalVendor &&
    quality.wrongCityCount === 0 &&
    quality.costFloorCount === 0 &&
    quality.serviceMismatchCount === 0
  ) {
    confidence = Math.max(confidence, REVIEW_CONFIDENCE_THRESHOLD + 0.02);
  }

  confidence = clamp(confidence, 0.18, 0.9);

  const hasEnoughTrustedEvidence = trustedCount >= 2 || hasStrongDirectLocalVendor;

  const safeToAutoSave =
    confidence >= REVIEW_CONFIDENCE_THRESHOLD &&
    hasEnoughTrustedEvidence &&
    quality.wrongCityCount === 0 &&
    quality.costFloorCount === 0 &&
    quality.serviceMismatchCount === 0 &&
    !onlySocial &&
    !onlyBroadGuide &&
    (
      serviceName !== 'turnover_clean' ||
      hasStrongDirectLocalVendor ||
      (quality.primaryConsensusCount >= 2 && quality.tierACount + quality.tierBCount + quality.tierCCount >= 2)
    );

  const verificationMode =
    safeToAutoSave && hasStrongDirectLocalVendor && trustedCount < 2
      ? 'verified_local_vendor'
      : safeToAutoSave
        ? 'verified_consensus'
        : 'needs_review';

  const reviewStatus = verificationMode;

  // Keep status simple because frontend/HostOnboarding uses this as the main gate.
  const status = safeToAutoSave ? 'verified' : 'review_required';

  const pricingSource = safeToAutoSave
    ? verificationMode === 'verified_local_vendor'
      ? 'ai_search_local_vendor'
      : (quality.tierACount || quality.tierBCount ? 'ai_search_consensus' : 'ai_search_nearby_consensus')
    : 'ai_search_incomplete';

  const cleanerPayoutFloor = estimateCleanerPayoutFloor({ marketMedian, service: serviceName, ctx });
  const confidenceRounded = Number(confidence.toFixed(2));

  const reviewReason = safeToAutoSave
    ? verificationMode === 'verified_local_vendor'
      ? `Verified local vendor: direct service-specific public price, ${trustedCount} trusted local/nearby source(s), confidence ${Math.round(confidenceRounded * 100)}%.`
      : `Verified consensus: ${trustedCount} trusted local/nearby source(s), confidence ${Math.round(confidenceRounded * 100)}%.`
    : `Review required: ${trustedCount} trusted source(s), ${quality.socialCount} social source(s), ${quality.broadGuideCount} broad guide source(s), confidence ${Math.round(confidenceRounded * 100)}%.`;

  return {
    ok: true,
    zip,
    service: serviceName,
    provider,
    enrichment: enrichment || null,
    suggested: {
      marketLow,
      marketMedian,
      marketHigh,
      cleanerPayoutFloor,
      platformMarginPct: serviceName === 'standard_clean' ? 22 : 24,
      paymentFeeBuffer: 8,
      suppliesTravelBuffer: 0,
      confidence: confidenceRounded,
      sourceCount: evidence.length,
      sources: [providerSource(provider), ...evidence.map((e) => e.domain).filter(Boolean).slice(0, 8)],

      status,
      pricingSource,
      reviewStatus,
      safeToAutoSave,
      canAutoApprove: safeToAutoSave,

      notes: `${label} ${verificationMode === 'verified_local_vendor' ? 'local vendor suggestion' : 'consensus suggestion'} from ${consensusSignals.length} source(s). ${reviewReason}`,
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
      sourceTier: s.sourceTier,
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
      reasons: s.rejectReasons || s.policyReasons || [],
      context: String(s.priceContext || s.context || '').slice(0, 180),
    })),
    confidence: confidenceRounded,
    sourceCount: evidence.length,
    reviewStatus,
    canAutoApprove: safeToAutoSave,
    safeToAutoSave,
    status,
    pricingSource,
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

  const includeRaw =
    String(process.env.TAVILY_INCLUDE_RAW_CONTENT || 'false').toLowerCase() === 'true';

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
      include_raw_content: includeRaw,
    }),
  }, num(process.env.TAVILY_TIMEOUT_MS, 25000));

  if (!res.ok || data?.error) {
    const message = data?.error || data?.message || data?.error?.message || `Tavily search failed with ${res.status}`;
    const err = new Error(message);
    err.status = res.status || 400;
    err.code = 'TAVILY_FAILED';
    throw err;
  }

  const results = Array.isArray(data?.results) ? data.results : [];

  return results.map((item) => {
    const raw = String(item.raw_content || '').trim();
    const content = String(item.content || item.snippet || item.description || '').trim();

    return normalizeSearchItem({
      title: item.title || '',
      link: item.url || item.link || '',
      snippet: [content, raw].filter(Boolean).join('\n\n').slice(0, 12000),
    }, query);
  });
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
    priceSignals.push(...extractPriceSignals({
      ...item,
      service,
      sourceProvider: item.sourceProvider || 'search',
      fullPage: !!item.fullPage,
    }).map((signal) => ({
      ...signal,
      sourceProvider: signal.sourceProvider || item.sourceProvider || 'search',
      fullPage: !!(signal.fullPage || item.fullPage),
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

function clampPrice(value, fallback = 0) {
  const n = Number(value || fallback || 0);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function deriveMissingServiceDraft({ zip, service, results }) {
  const serviceName = normalizeService(service);
  const byService = new Map(
    (results || [])
      .filter((r) => r?.ok && r?.suggested)
      .map((r) => [normalizeService(r.service), r])
  );

  const standard = byService.get('standard_clean');
  const deep = byService.get('deep_clean');
  const moveOut = byService.get('move_out_clean');
  const turnover = byService.get('turnover_clean');

  let anchor = null;
  let low = 0;
  let mid = 0;
  let high = 0;

  if (serviceName === 'turnover_clean') {
    anchor = standard || deep;
    if (!anchor) return null;

    const a = anchor.suggested;
    if (anchor.service === 'deep_clean') {
      low = clampPrice(a.marketLow) * 0.62;
      mid = clampPrice(a.marketMedian) * 0.62;
      high = clampPrice(a.marketHigh) * 0.62;
    } else {
      low = clampPrice(a.marketLow) * 1.00;
      mid = clampPrice(a.marketMedian) * 1.08;
      high = clampPrice(a.marketHigh) * 1.05;
    }
  }

  if (serviceName === 'move_out_clean') {
    anchor = deep || standard;
    if (!anchor) return null;

    const a = anchor.suggested;
    if (anchor.service === 'deep_clean') {
      low = clampPrice(a.marketLow) * 1.12;
      mid = clampPrice(a.marketMedian) * 1.25;
      high = clampPrice(a.marketHigh) * 1.18;
    } else {
      low = clampPrice(a.marketLow) * 1.65;
      mid = clampPrice(a.marketMedian) * 1.95;
      high = clampPrice(a.marketHigh) * 2.05;
    }
  }

  if (serviceName === 'deep_clean') {
    anchor = standard || moveOut;
    if (!anchor) return null;

    const a = anchor.suggested;
    if (anchor.service === 'move_out_clean') {
      low = clampPrice(a.marketLow) * 0.82;
      mid = clampPrice(a.marketMedian) * 0.78;
      high = clampPrice(a.marketHigh) * 0.78;
    } else {
      low = clampPrice(a.marketLow) * 1.45;
      mid = clampPrice(a.marketMedian) * 1.65;
      high = clampPrice(a.marketHigh) * 1.75;
    }
  }

  if (serviceName === 'standard_clean') {
    anchor = turnover || deep;
    if (!anchor) return null;

    const a = anchor.suggested;
    if (anchor.service === 'turnover_clean') {
      low = clampPrice(a.marketLow) * 0.95;
      mid = clampPrice(a.marketMedian) * 0.92;
      high = clampPrice(a.marketHigh) * 0.95;
    } else {
      low = clampPrice(a.marketLow) * 0.58;
      mid = clampPrice(a.marketMedian) * 0.60;
      high = clampPrice(a.marketHigh) * 0.62;
    }
  }

  if (!canUseAdjacentAnchor(anchor)) return null;

  if (!mid) return null;

  low = Math.max(75, Math.round(low / 5) * 5);
  mid = Math.max(low, Math.round(mid / 5) * 5);
  high = Math.max(mid, Math.round(high / 5) * 5);

  const ctx = locationContext({ zip });
  ({ marketLow: low, marketMedian: mid, marketHigh: high } = applyServiceShapeGuardrails({
    marketLow: low,
    marketMedian: mid,
    marketHigh: high,
    service: serviceName,
  }));

  const cleanerPayoutFloor = estimateCleanerPayoutFloor({
    marketMedian: mid,
    service: serviceName,
    ctx,
  });

  const anchorEvidence = cleanEvidenceForDisplay(anchor.evidence || [], serviceName);

  if (!anchorEvidence.length) return null;

  const anchorDomains = anchorEvidence
    .map((e) => e.domain || domainFromUrl(e.url || e.link || ''))
    .filter(Boolean);

  return {
    ok: true,
    zip,
    service: serviceName,
    provider: anchor.provider || requestedProvider(),
    enrichment: null,
    suggested: {
      marketLow: low,
      marketMedian: mid,
      marketHigh: high,
      cleanerPayoutFloor,
      platformMarginPct: serviceName === 'standard_clean' ? 22 : 24,
      paymentFeeBuffer: 8,
      suppliesTravelBuffer: 0,
      confidence: 0.34,
      sourceCount: anchorEvidence.length,
      sources: ['derived_from_same_zip_search', normalizeService(anchor.service), ...anchorDomains.slice(0, 6)],
      status: 'review_required',
      pricingSource: 'ai_search_incomplete',
      reviewStatus: 'draft_from_adjacent_service_search',
      safeToAutoSave: false,
      canAutoApprove: false,
      notes: `Draft derived from ${serviceLabel(anchor.service)} searched evidence for the same ZIP. Admin must review before customer quotes use it.`,
    },
    priceSignals: [],
    rejectedPriceSignals: [],
    confidence: 0.34,
    sourceCount: anchorEvidence.length,
    reviewStatus: 'draft_from_adjacent_service_search',
    canAutoApprove: false,
    safeToAutoSave: false,
    status: 'review_required',
    pricingSource: 'ai_search_incomplete',
    quality: {
      derivedFromAdjacentService: true,
      anchorService: normalizeService(anchor.service),
      sourceCount: anchorEvidence.length,
      vendorCount: anchor.quality?.vendorCount || 0,
      marketplaceCount: anchor.quality?.marketplaceCount || 0,
      socialCount: anchor.quality?.socialCount || 0,
      wrongCityCount: 0,
      rejectedSignalCount: anchor.quality?.rejectedSignalCount || 0,
    },
    queries: [],
    evidence: anchorEvidence,
    notes: `Draft derived from ${serviceLabel(anchor.service)} searched evidence for ${zip}.`,
  };
}

function fillMissingServiceDrafts({ zip, services, results }) {
  return (services || []).map((service) => {
    const serviceName = normalizeService(service);
    const existing = (results || []).find((r) => normalizeService(r.service) === serviceName);

    if (existing?.ok && existing?.suggested) return existing;

    const derived = deriveMissingServiceDraft({ zip, service: serviceName, results });
    if (derived) return derived;

    return existing || {
      ok: true,
      zip,
      service: serviceName,
      provider: requestedProvider(),
      suggested: null,
      confidence: 0,
      sourceCount: 0,
      reviewStatus: 'no_price_evidence',
      canAutoApprove: false,
      safeToAutoSave: false,
      status: 'review_required',
      pricingSource: 'ai_search_incomplete',
      quality: { sourceCount: 0 },
      queries: [],
      evidence: [],
      rejectedPriceSignals: [],
      notes: 'No price evidence found and no same-ZIP adjacent service anchor was available.',
    };
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

  const finalResults = fillMissingServiceDrafts({ zip, services, results });

  return {
    ok: true,
    zip,
    provider: finalResults.find((r) => r.provider)?.provider || requestedProvider(),
    services,
    results: finalResults,
    summary: {
      total: finalResults.length,
      suggested: finalResults.filter((r) => r.ok && r.suggested).length,
      needsReview: finalResults.filter((r) => r.ok && r.reviewStatus !== 'verified_consensus').length,
      autoReviewEligible: finalResults.filter((r) => r.ok && r.canAutoApprove).length,
      failed: finalResults.filter((r) => !r.ok).length,
    },
  };
}

module.exports = {
  suggestMarketRateFromGoogle,
  suggestMarketRatesBatch,
  normalizeService,
};    