const crypto = require("crypto");
const express = require("express");
const PSAnalyticsEvent = require("../models/PSAnalyticsEvent");

const router = express.Router();

const COUNTRY_NAMES = {
  US: "United States of America",
  IE: "Ireland",
  IN: "India",
  CN: "People's Republic of China",
  PK: "Pakistan",
  CA: "Canada",
  GB: "United Kingdom",
  AE: "United Arab Emirates",
  AU: "Australia",
};

const COUNTRY_ALIASES = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  us: "US",
  india: "IN",
  ireland: "IE",
  germany: "DE",
  china: "CN",
  "people's republic of china": "CN",
  pakistan: "PK",
  canada: "CA",
  "united kingdom": "GB",
  uk: "GB",
  australia: "AU",
  "united arab emirates": "AE",
};

let REGION_NAMES = null;
try {
  REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
} catch {
  REGION_NAMES = null;
}

function cleanCountryCode(value) {
  const code = str(value, 8).toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  if (["XX", "ZZ", "T1", "A1", "A2"].includes(code)) return "";
  return code;
}

function countryNameFromCode(code) {
  const clean = cleanCountryCode(code);
  if (!clean) return "";
  return COUNTRY_NAMES[clean] || REGION_NAMES?.of?.(clean) || clean;
}

function inferCountryCodeFromName(value = "") {
  const raw = str(value, 120).toLowerCase();
  if (!raw || raw === "unknown" || raw === "direct / unknown") return "";

  const directCode = cleanCountryCode(raw);
  if (directCode) return directCode;

  if (COUNTRY_ALIASES[raw]) return COUNTRY_ALIASES[raw];

  for (const [code, name] of Object.entries(COUNTRY_NAMES)) {
    if (String(name).toLowerCase() === raw) return code;
  }

  return "";
}

function inferCountryCodeFromTimezone(value = "") {
  const tz = str(value, 120);

  const directMap = {
    "America/New_York": "US",
    "America/Detroit": "US",
    "America/Kentucky/Louisville": "US",
    "America/Kentucky/Monticello": "US",
    "America/Indiana/Indianapolis": "US",
    "America/Indiana/Vincennes": "US",
    "America/Indiana/Winamac": "US",
    "America/Indiana/Marengo": "US",
    "America/Indiana/Petersburg": "US",
    "America/Indiana/Vevay": "US",
    "America/Chicago": "US",
    "America/Indiana/Tell_City": "US",
    "America/Indiana/Knox": "US",
    "America/Menominee": "US",
    "America/North_Dakota/Center": "US",
    "America/North_Dakota/New_Salem": "US",
    "America/North_Dakota/Beulah": "US",
    "America/Denver": "US",
    "America/Boise": "US",
    "America/Phoenix": "US",
    "America/Los_Angeles": "US",
    "America/Anchorage": "US",
    "America/Juneau": "US",
    "America/Sitka": "US",
    "America/Metlakatla": "US",
    "America/Yakutat": "US",
    "America/Nome": "US",
    "America/Adak": "US",
    "Pacific/Honolulu": "US",
    "America/Puerto_Rico": "US",

    "Asia/Kolkata": "IN",
    "Asia/Calcutta": "IN",
    "Europe/Dublin": "IE",
    "Europe/Berlin": "DE",
    "Asia/Shanghai": "CN",
    "Asia/Karachi": "PK",
    "Europe/London": "GB",
    "Asia/Dubai": "AE",
    "Australia/Sydney": "AU",
    "Australia/Melbourne": "AU",
    "Australia/Brisbane": "AU",
    "Australia/Perth": "AU",
    "America/Toronto": "CA",
    "America/Vancouver": "CA",
    "America/Montreal": "CA",
    "America/Winnipeg": "CA",
    "America/Halifax": "CA",
  };

  return directMap[tz] || "";
}

function countryFlagEmoji(code) {
  const clean = cleanCountryCode(code);
  if (!clean) return "🌐";
  return clean
    .split("")
    .map((char) => String.fromCodePoint(127397 + char.charCodeAt(0)))
    .join("");
}

function countryCodeFromRow(row = {}) {
  return (
    cleanCountryCode(row.countryCode) ||
    inferCountryCodeFromName(row.country) ||
    inferCountryCodeFromTimezone(row.timezone)
  );
}

function countCountryRows(rows = []) {
  const map = new Map();

  rows.forEach((row) => {
    const code = countryCodeFromRow(row);
    const fallbackName = str(row.country, 80);
    const name = countryNameFromCode(code) || fallbackName || "Unknown";
    const key = code || name;
    const visitorKey = row.visitorIdHash || row.ipHash || row.sessionId || "unknown";

    const current = map.get(key) || {
      name,
      countryCode: code,
      code,
      flag: countryFlagEmoji(code),
      visitors: new Set(),
      total: 0,
    };

    current.total += 1;
    current.visitors.add(visitorKey);
    map.set(key, current);
  });

  const output = Array.from(map.values()).map((row) => ({
    name: row.name,
    countryCode: row.countryCode,
    code: row.code,
    flag: row.flag,
    visitors: row.visitors.size,
    total: row.visitors.size,
  }));

  const denominator = Math.max(
    1,
    output.reduce((sum, row) => sum + Number(row.visitors || 0), 0)
  );

  return output
    .map((row) => ({
      ...row,
      percentage: Math.round((Number(row.visitors || 0) / denominator) * 100),
    }))
    .sort((a, b) => b.visitors - a.visitors)
    .slice(0, 12);
}

function str(value, max = 255) {
  return String(value || "").trim().slice(0, max);
}

function cleanZip(value) {
  const raw = str(value, 20);
  const match = raw.match(/\b\d{5}(?:-\d{4})?\b/);
  return match ? match[0].slice(0, 10) : "";
}

function numberOrUndefined(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function pickFirst(...values) {
  for (const value of values) {
    const clean = str(value, 255);
    if (clean) return clean;
  }
  return "";
}

function zipFromRow(row = {}) {
  return cleanZip(
    row.zip ||
    row.meta?.zip ||
    row.meta?.serviceZip ||
    row.meta?.detectedZip ||
    row.meta?.postalCode
  );
}

function eventName(row = {}) {
  return String(row.eventName || "").toLowerCase();
}

function flowName(row = {}) {
  return String(row.flow || row.meta?.flow || row.source || "").toLowerCase();
}

function isChatbotEvent(row = {}) {
  const name = eventName(row);
  const flow = flowName(row);
  return (
    flow === "chatbot" ||
    name.startsWith("chatbot_") ||
    name.startsWith("start_here_ai_chat")
  );
}

function isQuoteRequestEvent(row = {}) {
  const name = eventName(row);
  return (
    name.includes("quote_requested") ||
    name.includes("quote_started") ||
    name.includes("host_quote_started") ||
    name.includes("zip_quote_requested")
  );
}

function isQuoteRevealEvent(row = {}) {
  const name = eventName(row);
  return (
    name.includes("quote_revealed") ||
    name.includes("rate_revealed") ||
    name.includes("host_rate_revealed") ||
    name.includes("zip_quote_revealed")
  );
}

function isLeadEvent(row = {}) {
  const name = eventName(row);
  return (
    name.includes("lead_created") ||
    name.includes("checkout_started") ||
    name.includes("vendor_contact_clicked")
  );
}

function bumpMap(map, key, amount = 1) {
  const clean = str(key, 160) || "Unknown";
  map.set(clean, (map.get(clean) || 0) + amount);
}

function topMapLabel(map, fallback = "Unknown") {
  let best = fallback;
  let bestValue = 0;

  for (const [key, value] of map.entries()) {
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }

  return best;
}

function safeMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const out = {};
  Object.entries(meta)
    .slice(0, 20)
    .forEach(([key, value]) => {
      const cleanKey = str(key, 50).replace(/[^a-zA-Z0-9_.:-]/g, "_");
      if (!cleanKey) return;
      if (value === null || typeof value === "boolean" || typeof value === "number") {
        out[cleanKey] = value;
        return;
      }
      out[cleanKey] = str(typeof value === "string" ? value : JSON.stringify(value), 220);
    });
  return out;
}

function hashValue(value) {
  const salt = process.env.ANALYTICS_HASH_SALT || process.env.JWT_SECRET || "propertysanta-analytics-v1";
  return crypto.createHash("sha256").update(`${salt}:${String(value || "")}`).digest("hex");
}

function clientIp(req) {
  const raw =
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "";
  return String(raw).split(",")[0].trim();
}

function refHost(referrer = "") {
  try {
    const u = new URL(referrer);
    return u.hostname.replace(/^www\./i, "").slice(0, 140);
  } catch {
    return "";
  }
}

function routeFromPath(path = "") {
  const clean = str(path, 260).split("?")[0] || "/";
  return clean
    .replace(/\/r\/[a-zA-Z0-9_-]+/g, "/r/:requestId")
    .replace(/\/pay-invoice\/[a-zA-Z0-9_-]+/g, "/pay-invoice/:invoiceId")
    .replace(/\/product-page\/[a-zA-Z0-9_-]+/g, "/product-page/:slug");
}

function pctChange(current, previous) {
  const c = Number(current || 0);
  const p = Number(previous || 0);
  if (!p && !c) return 0;
  if (!p) return 100;
  return Math.round(((c - p) / p) * 100);
}

function parseRange(value) {
  const raw = String(value || "7d").toLowerCase();
  const map = { "24h": 1, "1d": 1, "7d": 7, "14d": 14, "30d": 30, "90d": 90 };
  return map[raw] || 7;
}

function dayKey(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function addHours(date, hours) {
  const d = new Date(date);
  d.setUTCHours(d.getUTCHours() + hours);
  return d;
}

function hourKey(d) {
  const x = new Date(d);
  x.setUTCMinutes(0, 0, 0);
  return x.toISOString();
}

function labelsBetweenHours(start, hours) {
  return Array.from({ length: hours }, (_, i) => hourKey(addHours(start, i)));
}

function labelsBetween(start, days) {
  return Array.from({ length: days }, (_, i) => dayKey(addDays(start, i)));
}

function normalizeDevice(value) {
  const v = str(value, 40).toLowerCase();
  if (v.includes("mobile")) return "Mobile";
  if (v.includes("tablet")) return "Tablet";
  if (v.includes("bot")) return "Bot";
  return "Desktop";
}

function inferBrowser(ua = "") {
  const v = String(ua || "");
  if (/Edg\//.test(v)) return "Edge";
  if (/Chrome\//.test(v) && !/Chromium/.test(v)) return "Chrome";
  if (/Safari\//.test(v) && !/Chrome\//.test(v)) return "Safari";
  if (/Firefox\//.test(v)) return "Firefox";
  return "Other";
}

function inferOs(ua = "") {
  const v = String(ua || "");
  if (/Windows/i.test(v)) return "Windows";
  if (/Android/i.test(v)) return "Android";
  if (/iPhone|iPad|iOS/i.test(v)) return "iOS";
  if (/Mac OS|Macintosh/i.test(v)) return "macOS";
  if (/Linux/i.test(v)) return "GNU/Linux";
  return "Other";
}

function countRows(rows, keyFn, totalViews = false) {
  const map = new Map();
  rows.forEach((row) => {
    const key = str(keyFn(row), 160) || "Direct / Unknown";
    const current = map.get(key) || { name: key, visitors: new Set(), total: 0 };
    current.total += 1;
    current.visitors.add(row.visitorIdHash || row.ipHash || row.sessionId || "unknown");
    map.set(key, current);
  });
  return Array.from(map.values())
    .map((row) => ({ name: row.name, visitors: row.visitors.size, total: totalViews ? row.total : row.visitors.size }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);
}

function summarize(rows, days, start, bucketMode = "day", bucketCount = days) {
  const pageViews = rows.filter((r) => r.eventType === "page_view");
  const customEvents = rows.filter((r) => r.eventType === "custom_event");
  const visitorSet = new Set(rows.map((r) => r.visitorIdHash || r.ipHash || r.sessionId).filter(Boolean));
  const sessionMap = new Map();

  pageViews.forEach((row) => {
    const key = row.sessionId || row.visitorIdHash || row.ipHash || `anon-${row._id}`;
    const current = sessionMap.get(key) || 0;
    sessionMap.set(key, current + 1);
  });

  const sessions = sessionMap.size;
  const bounces = Array.from(sessionMap.values()).filter((views) => views <= 1).length;
  const bounceRate = sessions ? Math.round((bounces / sessions) * 100) : 0;

  const isHourly = bucketMode === "hour";
  const labels = isHourly
    ? labelsBetweenHours(start, bucketCount)
    : labelsBetween(start, bucketCount);

  const byBucket = new Map(
    labels.map((label) => [
      label,
      { date: label, visitors: new Set(), pageViews: 0, events: 0 },
    ])
  );

  rows.forEach((row) => {
    const key = isHourly ? hourKey(row.createdAt) : dayKey(row.createdAt);
    if (!byBucket.has(key)) return;

    const bucket = byBucket.get(key);
    bucket.visitors.add(row.visitorIdHash || row.ipHash || row.sessionId || "unknown");

    if (row.eventType === "page_view") bucket.pageViews += 1;
    if (row.eventType === "custom_event") bucket.events += 1;
  });

  const timeseries = Array.from(byBucket.values()).map((row) => ({
    date: row.date,
    visitors: row.visitors.size,
    pageViews: row.pageViews,
    events: row.events,
  }));

  return {
    visitors: visitorSet.size,
    pageViews: pageViews.length,
    sessions,
    bounceRate,
    customEvents: customEvents.length,
    timeseries,
    pages: countRows(pageViews, (r) => r.path || "/", true),
    routes: countRows(pageViews, (r) => r.route || routeFromPath(r.path || "/"), true),
    hostnames: countRows(pageViews, (r) => r.host || "propertysanta.com", true),
    referrers: countRows(pageViews.filter((r) => r.refHost), (r) => r.refHost, false),
    utm: countRows(pageViews.filter((r) => r.utmSource || r.utmCampaign), (r) => r.utmCampaign || r.utmSource, false),
    countries: countCountryRows(rows),
    devices: countRows(rows, (r) => normalizeDevice(r.device), false),
    browsers: countRows(rows, (r) => r.browser || inferBrowser(r.ua), false),
    os: countRows(rows, (r) => r.os || inferOs(r.ua), false),
    events: countRows(customEvents, (r) => r.eventName || "custom_event", true),
    flags: countRows(customEvents.filter((r) => /^flag[_.:-]/i.test(r.eventName || "")), (r) => r.eventName, true),
  };
}

router.post("/track", async (req, res) => {
  try {
    const body = req.body || {};
    const eventType = body.eventType === "custom_event" ? "custom_event" : "page_view";
    const ip = clientIp(req);
    const ua = str(body.ua || req.headers["user-agent"], 260);
    const timezone = str(body.timezone || req.headers["x-timezone"], 80);

    const countryCode = cleanCountryCode(
      req.headers["x-vercel-ip-country"] ||
      req.headers["cf-ipcountry"] ||
      req.headers["cloudfront-viewer-country"] ||
      req.headers["x-appengine-country"] ||
      req.headers["x-geo-country"] ||
      req.headers["x-country-code"] ||
      body.countryCode
    ) || inferCountryCodeFromName(body.country) || inferCountryCodeFromTimezone(timezone);

    const country = str(
      countryNameFromCode(countryCode) ||
      body.country ||
      countryCode ||
      "Unknown",
      80
    );
    const referrer = str(body.referrer || req.headers.referer, 400);
    const path = str(body.path || "/", 260) || "/";
    const visitorRaw = str(body.visitorId || body.visitorIdHash || ip || ua, 120);

    const meta = safeMeta(body.meta);

    const businessZip = cleanZip(
      body.zip ||
      body.serviceZip ||
      body.postalCode ||
      meta.zip ||
      meta.serviceZip ||
      meta.detectedZip ||
      meta.postalCode
    );

    const businessFlow = pickFirst(body.flow, meta.flow, body.source);
    const businessStep = pickFirst(body.step, meta.step, body.stage, meta.stage);
    const businessStage = pickFirst(body.stage, meta.stage, businessStep);
    const businessIntent = pickFirst(body.intent, meta.intent, meta.detectedIntent);
    const businessServiceType = pickFirst(body.serviceType, meta.serviceType, meta.service);

    await PSAnalyticsEvent.create({
      eventType,
      eventName: str(body.eventName || (eventType === "page_view" ? "page_view" : "custom_event"), 90),
      path,
      route: str(body.route || routeFromPath(path), 220),
      title: str(body.title, 180),
      host: str(body.host || req.headers.host, 120),
      referrer,
      refHost: str(body.refHost || refHost(referrer), 140),
      utmSource: str(body.utmSource, 90),
      utmMedium: str(body.utmMedium, 90),
      utmCampaign: str(body.utmCampaign, 120),
      utmTerm: str(body.utmTerm, 120),
      utmContent: str(body.utmContent, 120),
      sessionId: str(body.sessionId, 90),
      visitorIdHash: hashValue(visitorRaw),
      ipHash: ip ? hashValue(ip) : "",
      country,
      countryCode,
      region: str(req.headers["x-vercel-ip-country-region"] || body.region, 80),
      city: str(req.headers["x-vercel-ip-city"] || body.city, 90),
      device: normalizeDevice(body.device || "desktop"),
      browser: str(body.browser || inferBrowser(ua), 60),
      os: str(body.os || inferOs(ua), 60),
      ua,
      screen: str(body.screen, 40),
      timezone,
      source: str(body.source || "frontPage", 60),
      zip: businessZip,
      serviceCity: str(body.serviceCity || meta.serviceCity || meta.city, 90),
      serviceState: str(body.serviceState || meta.serviceState || meta.state, 40),

      flow: str(businessFlow, 80),
      step: str(businessStep, 120),
      stage: str(businessStage, 120),
      intent: str(businessIntent, 80),
      serviceType: str(businessServiceType, 120),

      propertyType: str(body.propertyType || meta.propertyType, 80),
      bedrooms: numberOrUndefined(body.bedrooms ?? meta.bedrooms),
      bathrooms: numberOrUndefined(body.bathrooms ?? meta.bathrooms),
      quoteAmount: numberOrUndefined(body.quoteAmount ?? meta.quoteAmount),
      confidence: numberOrUndefined(body.confidence ?? meta.confidence),

      requestId: str(body.requestId || meta.requestId, 120),
      quoteId: str(body.quoteId || meta.quoteId, 120),

      meta,
    });

    res.json({ ok: true });
  } catch (error) {
    console.error("analytics track failed", error);
    res.status(200).json({ ok: false });
  }
});

router.get("/overview", async (req, res) => {
  try {
    const rangeKey = String(req.query.range || "7d").toLowerCase();
    const is24h = rangeKey === "24h" || rangeKey === "1d";
    const days = parseRange(rangeKey);
    const now = new Date();

    let start;
    let prevStart;
    let prevEnd;
    let bucketMode = "day";
    let bucketCount = days;

    if (is24h) {
      const thisHour = new Date(now);
      thisHour.setUTCMinutes(0, 0, 0);

      start = addHours(thisHour, -23);
      prevStart = addHours(start, -24);
      prevEnd = start;
      bucketMode = "hour";
      bucketCount = 24;
    } else {
      const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      start = addDays(todayUtc, -(days - 1));
      prevStart = addDays(start, -days);
      prevEnd = start;
    }

    const [currentRows, previousRows] = await Promise.all([
      PSAnalyticsEvent.find({ createdAt: { $gte: start, $lte: now } }).sort({ createdAt: 1 }).limit(20000).lean(),
      PSAnalyticsEvent.find({ createdAt: { $gte: prevStart, $lt: prevEnd } }).sort({ createdAt: 1 }).limit(20000).lean(),
    ]);

    const current = summarize(currentRows, days, start, bucketMode, bucketCount);
    const previous = summarize(previousRows, days, prevStart, bucketMode, bucketCount);
    const responseRange = is24h ? "24h" : `${days}d`;

    res.json({
      ok: true,
      range: responseRange,
      generatedAt: new Date().toISOString(),
      granularity: bucketMode,
      window: {
        start: start.toISOString(),
        end: now.toISOString(),
        previousStart: prevStart.toISOString(),
        previousEnd: prevEnd.toISOString(),
        bucketMode,
        bucketCount,
        currentRows: currentRows.length,
        previousRows: previousRows.length,
      },
      summary: {
        visitors: current.visitors,
        pageViews: current.pageViews,
        sessions: current.sessions,
        bounceRate: current.bounceRate,
        customEvents: current.customEvents,
      },
      deltas: {
        visitors: pctChange(current.visitors, previous.visitors),
        pageViews: pctChange(current.pageViews, previous.pageViews),
        sessions: pctChange(current.sessions, previous.sessions),
        bounceRate: pctChange(current.bounceRate, previous.bounceRate),
        customEvents: pctChange(current.customEvents, previous.customEvents),
      },

      timeseries: current.timeseries,
      tables: {
        pages: current.pages,
        routes: current.routes,
        hostnames: current.hostnames,
        referrers: current.referrers,
        utm: current.utm,
        countries: current.countries,
        devices: current.devices,
        browsers: current.browsers,
        os: current.os,
        events: current.events,
        flags: current.flags,
      },
    });
  } catch (error) {
    console.error("analytics overview failed", error);
    res.status(500).json({ ok: false, message: error.message || "Analytics overview failed" });
  }
});

function summarizeZipRows(rows = []) {
  const byZip = new Map();

  rows.forEach((row) => {
    const zip = zipFromRow(row);
    if (!zip) return;

    const current =
      byZip.get(zip) ||
      {
        zip,
        visitors: new Set(),
        sessions: new Set(),
        pageViews: 0,
        customEvents: 0,
        chatbotEvents: 0,
        uiEvents: 0,
        quoteRequests: 0,
        quoteReveals: 0,
        leads: 0,
        services: new Map(),
        sources: new Map(),
        flows: new Map(),
        steps: new Map(),
      };

    const visitorKey = row.visitorIdHash || row.ipHash || row.sessionId || "unknown";
    const sessionKey = row.sessionId || visitorKey;

    current.visitors.add(visitorKey);
    current.sessions.add(sessionKey);

    if (row.eventType === "page_view") current.pageViews += 1;
    if (row.eventType === "custom_event") current.customEvents += 1;

    if (isChatbotEvent(row)) current.chatbotEvents += 1;
    else current.uiEvents += 1;

    if (isQuoteRequestEvent(row)) current.quoteRequests += 1;
    if (isQuoteRevealEvent(row)) current.quoteReveals += 1;
    if (isLeadEvent(row)) current.leads += 1;

    bumpMap(current.services, row.serviceType || row.meta?.serviceType || row.meta?.service || "Unknown");
    bumpMap(current.sources, row.utmCampaign || row.utmSource || row.refHost || row.source || "Direct / Unknown");
    bumpMap(current.flows, row.flow || row.meta?.flow || row.source || "Unknown");
    bumpMap(current.steps, row.step || row.stage || row.meta?.step || row.meta?.stage || "Unknown");

    byZip.set(zip, current);
  });

  const rowsOut = Array.from(byZip.values())
    .map((item) => {
      const visitors = item.visitors.size;
      const quoteConversion = item.quoteRequests
        ? Math.round((item.quoteReveals / item.quoteRequests) * 100)
        : 0;
      const leadConversion = visitors ? Math.round((item.leads / visitors) * 100) : 0;

      return {
        zip: item.zip,
        visitors,
        sessions: item.sessions.size,
        pageViews: item.pageViews,
        customEvents: item.customEvents,
        chatbotEvents: item.chatbotEvents,
        uiEvents: item.uiEvents,
        quoteRequests: item.quoteRequests,
        quoteReveals: item.quoteReveals,
        leads: item.leads,
        quoteConversion,
        leadConversion,
        topService: topMapLabel(item.services),
        topSource: topMapLabel(item.sources, "Direct / Unknown"),
        topFlow: topMapLabel(item.flows),
        topStep: topMapLabel(item.steps),
      };
    })
    .sort((a, b) => {
      const scoreA = a.visitors * 4 + a.quoteRequests * 3 + a.quoteReveals * 4 + a.leads * 8 + a.chatbotEvents;
      const scoreB = b.visitors * 4 + b.quoteRequests * 3 + b.quoteReveals * 4 + b.leads * 8 + b.chatbotEvents;
      return scoreB - scoreA;
    });

  const totals = rowsOut.reduce(
    (acc, row) => {
      acc.zips += 1;
      acc.visitors += row.visitors;
      acc.pageViews += row.pageViews;
      acc.chatbotEvents += row.chatbotEvents;
      acc.uiEvents += row.uiEvents;
      acc.quoteRequests += row.quoteRequests;
      acc.quoteReveals += row.quoteReveals;
      acc.leads += row.leads;
      return acc;
    },
    {
      zips: 0,
      visitors: 0,
      pageViews: 0,
      chatbotEvents: 0,
      uiEvents: 0,
      quoteRequests: 0,
      quoteReveals: 0,
      leads: 0,
    }
  );

  return { totals, rows: rowsOut.slice(0, 100) };
}

router.get("/zip-overview", async (req, res) => {
  try {
    const rangeKey = String(req.query.range || "7d").toLowerCase();
    const is24h = rangeKey === "24h" || rangeKey === "1d";
    const days = parseRange(rangeKey);
    const now = new Date();

    let start;
    let prevStart;
    let prevEnd;
    let bucketMode = "day";
    let bucketCount = days;

    if (is24h) {
      const thisHour = new Date(now);
      thisHour.setUTCMinutes(0, 0, 0);
      start = addHours(thisHour, -23);
      prevStart = addHours(start, -24);
      prevEnd = start;
      bucketMode = "hour";
      bucketCount = 24;
    } else {
      const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      start = addDays(todayUtc, -(days - 1));
      prevStart = addDays(start, -days);
      prevEnd = start;
    }

    const [currentRows, previousRows] = await Promise.all([
      PSAnalyticsEvent.find({ createdAt: { $gte: start, $lte: now } })
        .sort({ createdAt: 1 })
        .limit(30000)
        .lean(),
      PSAnalyticsEvent.find({ createdAt: { $gte: prevStart, $lt: prevEnd } })
        .sort({ createdAt: 1 })
        .limit(30000)
        .lean(),
    ]);

    const current = summarizeZipRows(currentRows);
    const previous = summarizeZipRows(previousRows);
    const responseRange = is24h ? "24h" : `${days}d`;

    res.json({
      ok: true,
      range: responseRange,
      generatedAt: new Date().toISOString(),
      granularity: bucketMode,
      window: {
        start: start.toISOString(),
        end: now.toISOString(),
        previousStart: prevStart.toISOString(),
        previousEnd: prevEnd.toISOString(),
        bucketMode,
        bucketCount,
        currentRows: currentRows.length,
        previousRows: previousRows.length,
      },
      summary: {
        ...current.totals,
        zipsDelta: pctChange(current.totals.zips, previous.totals.zips),
        visitorsDelta: pctChange(current.totals.visitors, previous.totals.visitors),
        quoteRequestsDelta: pctChange(current.totals.quoteRequests, previous.totals.quoteRequests),
        quoteRevealsDelta: pctChange(current.totals.quoteReveals, previous.totals.quoteReveals),
        leadsDelta: pctChange(current.totals.leads, previous.totals.leads),
      },
      rows: current.rows,
    });
  } catch (error) {
    console.error("analytics zip-overview failed", error);
    res.status(500).json({
      ok: false,
      message: error.message || "ZIP analytics overview failed",
    });
  }
});

function clampScore(value) {
  const n = Number(value || 0);
  return Math.max(0, Math.min(100, Math.round(n)));
}

function topName(rows = [], fallback = "None yet") {
  const first = Array.isArray(rows) && rows.length ? rows[0] : null;
  return first?.name || fallback;
}

function buildFallbackAiReport({ summary = {}, tables = {}, range = "7d" }) {
  const visitors = Number(summary.visitors || 0);
  const pageViews = Number(summary.pageViews || 0);
  const bounceRate = Number(summary.bounceRate || 0);
  const customEvents = Number(summary.customEvents || 0);
  const viewsPerVisitor = visitors ? Number((pageViews / visitors).toFixed(1)) : 0;

  const healthScore = clampScore(
    35 +
    Math.min(25, pageViews * 2) +
    Math.min(20, customEvents * 4) -
    Math.max(0, bounceRate - 55) * 0.7
  );

  const topRoute = topName(tables.routes, topName(tables.pages, "No page leader yet"));
  const topCountry = topName(tables.countries, "Unknown");
  const topDevice = topName(tables.devices, "Unknown");
  const topEvent = topName(tables.events, "No custom events yet");

  const risks = [];
  if (!visitors) risks.push("Traffic is not being captured yet. Confirm /api/analytics/track returns ok:true.");
  if (bounceRate >= 65) risks.push("Bounce rate is high; landing page or first CTA may need clearer next-step copy.");
  if (!customEvents) risks.push("Custom events are missing; instrument quote, checkout, and CTA clicks.");
  if (!tables.referrers?.length) risks.push("Referrer source is mostly unknown; use UTM links for ads/social posts.");

  return {
    headline: visitors
      ? `${range} report: ${visitors} visitors, ${pageViews} page views, ${viewsPerVisitor} views per visitor.`
      : `${range} report: tracking is live-ready but no visitor data is captured yet.`,
    healthScore,
    executiveSummary: visitors
      ? `Top route is ${topRoute}. Strongest geography is ${topCountry}, mostly on ${topDevice}. Custom event leader: ${topEvent}.`
      : "Analytics UI is ready, but tracker/API needs traffic or route config verification.",
    keyWins: [`Top route: ${topRoute}`, `Best country signal: ${topCountry}`, `Device leader: ${topDevice}`],
    risks: risks.length ? risks.slice(0, 4) : ["No major risk found in this range."],
    recommendedActions: [
      "Track CTA clicks: start_here_message, host_quote_started, quote_revealed, checkout_started, lead_unlocked.",
      "Add UTM parameters to every ad/social/referral link.",
      "Review top page copy if bounce rate stays above 60%.",
      "Compare 7d vs 30d before changing landing page copy."
    ],
    dataQuality: visitors ? "usable" : "needs_traffic_or_tracker_check"
  };
}

function safeJsonFromText(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch { }

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function generateGeminiAiReport({ summary, tables, range }) {
  const apiKey = String(
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ""
  ).trim();

  if (!apiKey) return null;

  let GoogleGenerativeAI;
  try {
    GoogleGenerativeAI = require("@google/generative-ai").GoogleGenerativeAI;
  } catch {
    return null;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName =
    process.env.ANALYTICS_GEMINI_MODEL ||
    process.env.GEMINI_MODEL ||
    "gemini-2.0-flash-lite";

  const model = genAI.getGenerativeModel({ model: modelName });

  const prompt = `You are PropertySanta's growth analyst. Generate a concise analytics report from this JSON only.
Return valid JSON only with keys: headline, healthScore, executiveSummary, keyWins, risks, recommendedActions, dataQuality.
Rules: healthScore is 0-100. keyWins, risks, recommendedActions are arrays of short strings. Do not invent numbers.

Range: ${range}
Summary: ${JSON.stringify(summary)}
Tables: ${JSON.stringify({
    pages: (tables.pages || []).slice(0, 8),
    routes: (tables.routes || []).slice(0, 8),
    referrers: (tables.referrers || []).slice(0, 8),
    utm: (tables.utm || []).slice(0, 8),
    countries: (tables.countries || []).slice(0, 8),
    devices: (tables.devices || []).slice(0, 8),
    browsers: (tables.browsers || []).slice(0, 8),
    events: (tables.events || []).slice(0, 8)
  })}`;

  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || "";
  const parsed = safeJsonFromText(text);

  if (!parsed || typeof parsed !== "object") return null;

  return {
    headline: str(parsed.headline, 220),
    healthScore: clampScore(parsed.healthScore),
    executiveSummary: str(parsed.executiveSummary, 900),
    keyWins: Array.isArray(parsed.keyWins) ? parsed.keyWins.map((x) => str(x, 180)).filter(Boolean).slice(0, 5) : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks.map((x) => str(x, 180)).filter(Boolean).slice(0, 5) : [],
    recommendedActions: Array.isArray(parsed.recommendedActions) ? parsed.recommendedActions.map((x) => str(x, 200)).filter(Boolean).slice(0, 6) : [],
    dataQuality: str(parsed.dataQuality, 80) || "usable"
  };
}

router.get("/ai-report", async (req, res) => {
  try {
    const days = parseRange(req.query.range);
    const range = `${days}d`;
    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = addDays(todayUtc, -(days - 1));

    const rows = await PSAnalyticsEvent.find({ createdAt: { $gte: start, $lte: now } })
      .sort({ createdAt: 1 })
      .limit(20000)
      .lean();

    const current = summarize(rows, days, start);

    const summary = {
      visitors: current.visitors,
      pageViews: current.pageViews,
      sessions: current.sessions,
      bounceRate: current.bounceRate,
      customEvents: current.customEvents
    };

    const tables = {
      pages: current.pages,
      routes: current.routes,
      hostnames: current.hostnames,
      referrers: current.referrers,
      utm: current.utm,
      countries: current.countries,
      devices: current.devices,
      browsers: current.browsers,
      os: current.os,
      events: current.events,
      flags: current.flags
    };

    let source = "fallback";
    let report = null;

    try {
      report = await generateGeminiAiReport({ summary, tables, range });
      if (report) source = "gemini";
    } catch (error) {
      console.warn("analytics ai-report gemini fallback", error.message);
    }

    if (!report) report = buildFallbackAiReport({ summary, tables, range });

    res.json({
      ok: true,
      source,
      range,
      generatedAt: new Date().toISOString(),
      summary,
      report
    });
  } catch (error) {
    console.error("analytics ai-report failed", error);
    res.status(500).json({ ok: false, message: error.message || "Analytics AI report failed" });
  }
});

module.exports = router;
