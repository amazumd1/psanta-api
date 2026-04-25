const router = require("express").Router();
const User = require("../models/User");
const PCPersona = require("../models/PCPersona");
const User1099Transaction = require("../models/User1099Transaction");
const { auth, authOptional } = require("../middleware/auth");
const crypto = require("crypto");
const PSDemandEvent = require("../models/PSDemandEvent");
const ServiceRequest = require("../models/ServiceRequest");
const { extractPublicListing, extractPublicProProfile } = require("../lib/publicExtract");
let StrListing = null;
try {
  StrListing = require("../models/StrListing");
} catch (e) {
  StrListing = null;
}

const { makeRateLimiter } = require("../middleware/rateLimit");
const { redactPII, redactMetaPII } = require("../utils/pii");

const fs = require("fs");
const path = require("path");





function safeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function maskEmail(email) {
  const e = String(email || "").trim();
  if (!e || !e.includes("@")) return "";
  const [u, d] = e.split("@");
  const u2 = u.length <= 2 ? `${u[0] || "*"}*` : `${u.slice(0, 2)}***`;
  const parts = String(d || "").split(".");
  const d0 = parts[0] || "";
  const d0m = d0.length <= 1 ? "*" : `${d0[0]}***`;
  const rest = parts.slice(1).join(".");
  return `${u2}@${d0m}${rest ? `.${rest}` : ""}`;
}

function maskPhone(phone) {
  const p = String(phone || "").replace(/[^\d]/g, "");
  if (p.length < 7) return "";
  return `***-***-${p.slice(-4)}`;
}

async function loadUser1099SpendMap(userIds = []) {
  const ObjectId = PCPersona.db.base.Types.ObjectId;

  const ids = Array.from(
    new Set(
      (userIds || [])
        .map((v) => String(v || "").trim())
        .filter((v) => v && ObjectId.isValid(v))
    )
  );

  if (!ids.length) return new Map();

  const rows = await User1099Transaction.aggregate([
    {
      $match: {
        userId: {
          $in: ids.map((id) => new ObjectId(id)),
        },
      },
    },
    {
      $group: {
        _id: "$userId",
        totalSpent: { $sum: { $ifNull: ["$amount", 0] } },
      },
    },
  ]);

  return new Map(
    rows.map((r) => [String(r?._id || ""), Number(r?.totalSpent || 0) || 0])
  );
}

function normLeadText(v) {
  return String(v || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function sanitizeProDashboardState(input) {
  const raw = input && typeof input === "object" ? input : {};
  const allowedStages = new Set(["new", "opened", "contacted", "won", "lost"]);

  const seenAt = Math.max(0, Number(raw?.seenAt || 0) || 0);

  const archivedLeadIds = Array.isArray(raw?.archivedLeadIds)
    ? Array.from(new Set(raw.archivedLeadIds.map((x) => String(x || "").trim()).filter(Boolean))).slice(0, 500)
    : [];

  const leadStageMapRaw = raw?.leadStageMap && typeof raw.leadStageMap === "object"
    ? raw.leadStageMap
    : {};

  const leadStageMap = {};
  for (const [k, v] of Object.entries(leadStageMapRaw)) {
    const id = String(k || "").trim();
    const stage = String(v || "").trim().toLowerCase();
    if (!id || !allowedStages.has(stage)) continue;
    leadStageMap[id] = stage;
  }

  return { seenAt, archivedLeadIds, leadStageMap };
}

function guessLeadSourceKind(serviceType, tab) {
  const st = String(serviceType || "").trim();
  const tb = String(tab || "").trim();

  if (st === "housing_seek") return "renter";
  if (st === "housing_listing") return "owner";
  if (tb === "landlords") return "owner";
  if (tb === "pros") return "pro";
  return "customer";
}

function toLeadBudgetHint(v) {
  const n = Number(String(v || "").replace(/[^\d.\-]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return "";
  return `$${Math.round(n).toLocaleString()}`;
}

function collectLeadTags(reqDoc) {
  const f = reqDoc?.fields && typeof reqDoc.fields === "object" ? reqDoc.fields : {};
  const out = [];

  const push = (v) => {
    const s = String(v || "").trim();
    if (s) out.push(s);
  };

  push(reqDoc?.serviceType);
  push(f?.want ? String(f.want).replace(/_/g, " ") : "");
  push(f?.propertyType);
  push(f?.moveIn);

  if (Array.isArray(f?.amenities)) {
    for (const a of f.amenities.slice(0, 3)) push(a);
  }

  return Array.from(new Set(out)).slice(0, 5);
}

function computeLeadFitScore(query, serviceType, focusTags = []) {
  const q = normLeadText(query);
  const st = normLeadText(serviceType);
  const tags = Array.isArray(focusTags)
    ? focusTags.map((x) => normLeadText(x)).filter(Boolean)
    : [];

  let score = 38;

  if (st) score += 8;
  if (q.includes("urgent") || q.includes("asap") || q.includes("today")) score += 8;
  if (q.includes("weekly") || q.includes("monthly") || q.includes("ongoing")) score += 6;

  for (const tag of tags) {
    if (!tag) continue;
    if (q.includes(tag)) score += 10;
  }

  return Math.max(18, Math.min(96, score));
}

function randomPassword() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
function addDays(d, days) {
  const dt = new Date(d);
  dt.setDate(dt.getDate() + Number(days || 0));
  return dt;
}

const DEMAND_SALT = process.env.DEMAND_LOG_SALT || process.env.JWT_SECRET || "dev_salt";

// Admin allowlist (optional). In prod you can set ADMIN_EMAILS="a@x.com,b@y.com"
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || "")
  .split(",")
  .map(safeEmail)
  .filter(Boolean);

function isAdminEmail(email) {
  const e = safeEmail(email);
  if (!e) return false;
  return ADMIN_EMAILS.includes(e);
}



function isAdminReq(req) {
  const role = req.userDoc?.role || req.user?.role;
  if (role === "admin") return true;
  const email = req.userDoc?.email || req.user?.email;
  return isAdminEmail(email);
}

function demandAdminAuth(req, res, next) {
  return auth(req, res, () => {
    // In dev/staging, auth is enough; in production, require admin
    if (process.env.NODE_ENV !== "production") return next();
    if (isAdminReq(req)) return next();
    return res.status(403).json({ ok: false, error: "Admin only." });
  });
}


function getClientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.ip || req.connection?.remoteAddress || "";
}

function sha256(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex");
}

function safeRefHost(req) {
  const raw = String(req.headers["referer"] || req.headers["referrer"] || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).host.slice(0, 160);
  } catch {
    // if it's not a full URL, ignore
    return null;
  }
}



function sanitizeZip(z) {
  const s = String(z || "").trim().replace(/[^\d]/g, "").slice(0, 10);
  return s || null;
}


function sanitizeTab(t) {
  const s = String(t || "").trim();
  return s ? s.slice(0, 32) : null;
}

function sanitizeQuery(q) {
  const s = String(q || "").trim();
  if (!s) return null;
  return redactPII(s).slice(0, 300);
}

function safeMeta(meta) {
  if (!meta || typeof meta !== "object") return undefined;
  try {
    const m = redactMetaPII(meta);
    if (JSON.stringify(m).length > 2000) return { _truncated: true };
    return m;
  } catch {
    return { _unserializable: true };
  }
}



// best-effort: never break main flow
async function logDemand(req, action, { tab, zip, query, meta, source, userId } = {}) {
  try {
    const z = sanitizeZip(zip);
    const z3 = z ? z.slice(0, 3) : null;

    await PSDemandEvent.create({
      action: String(action || "").trim().slice(0, 64),
      tab: sanitizeTab(tab),
      zip: z,
      zip3: z3,
      query: sanitizeQuery(query),
      source: String(source || "frontPage").trim().slice(0, 64),
      userId: userId ? String(userId).slice(0, 64) : undefined,
      ipHash: sha256(`${DEMAND_SALT}:${getClientIp(req)}`),
      ua: String(req.headers["user-agent"] || "").slice(0, 220),
      ref: String(req.headers["referer"] || req.headers["referrer"] || "").slice(0, 400),
      refHost: safeRefHost(req),
      meta: safeMeta(meta),
    });
  } catch (e) {
    console.warn("demand log failed:", e?.message || e);
  }
}

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function sinceDays(days) {
  const raw = String(days ?? "").trim().toLowerCase();
  if (raw === "all") return null;
  const d = clampInt(raw, 7, 1, 365);
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000);
}


function sanitizeZip3(z3) {
  const s = String(z3 || "").trim().replace(/[^\d]/g, "").slice(0, 3);
  return s.length === 3 ? s : null;
}

function pickHeroUrl(d) {
  const cover = String(d?.cover_url || "").trim();
  if (cover) return cover;

  const photos = Array.isArray(d?.photos) ? d.photos : [];
  const coverPhoto = photos.find((p) => p && p.is_cover && p.url);
  if (coverPhoto?.url) return String(coverPhoto.url);

  const first = photos.find((p) => p && p.url);
  return first?.url ? String(first.url) : "";
}

function sanitizeZip5(z) {
  return String(z || "").trim().replace(/[^\d]/g, "").slice(0, 5);
}

function zip3FromAny(zip) {
  const s = String(zip || "").replace(/[^\d]/g, "");
  return s.length >= 3 ? s.slice(0, 3) : "";
}

function safeText(s, max = 280) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function buildPreviewFromDraft(draft) {
  const d = draft && typeof draft === "object" ? draft : {};
  const bits = [];

  const pt = safeText(d.propertyType || d.type || "", 48);
  if (pt) bits.push(pt);

  const beds = Number(d.beds || d.bedrooms || 0) || 0;
  const baths = Number(d.baths || d.bathrooms || 0) || 0;
  if (beds || baths) bits.push(`${beds || "?"} bd • ${baths || "?"} ba`);

  const min = d.nightlyMin != null ? Number(d.nightlyMin) : null;
  const max = d.nightlyMax != null ? Number(d.nightlyMax) : null;
  if (Number.isFinite(min) || Number.isFinite(max)) bits.push(`$${min ?? "—"}–$${max ?? "—"}/night`);

  const mn = d.minNights != null ? Number(d.minNights) : null;
  if (Number.isFinite(mn) && mn > 0) bits.push(`${mn} min nights`);

  const area = safeText(d.areaHint || "", 60);
  if (area) bits.push(area);

  return safeText(bits.join(" · "), 420);
}

function pickHeroUrl(d) {
  const cover = String(d?.cover_url || "").trim();
  if (cover) return cover;

  const photos = Array.isArray(d?.photos) ? d.photos : [];
  const coverPhoto = photos.find((p) => p && p.is_cover && p.url);
  if (coverPhoto?.url) return String(coverPhoto.url);

  const first = photos.find((p) => p && p.url);
  return first?.url ? String(first.url) : "";
}


function pickHeroFromDoc(doc) {
  const cover = String(doc?.cover_url || "").trim();
  if (cover) return cover;

  const photos = Array.isArray(doc?.photos) ? doc.photos : [];
  const coverPhoto = photos.find((p) => p && p.is_cover && p.url);
  if (coverPhoto?.url) return String(coverPhoto.url);

  const first = photos.find((p) => p && p.url);
  return first?.url ? String(first.url) : "";
}

async function computeCoverFromDraftOrExtract(doc) {
  const d = doc?.draft && typeof doc.draft === "object" ? doc.draft : {};

  const draftCover = String(d.cover_url || d.coverUrl || d.image_url || d.imageUrl || "").trim();
  if (draftCover) return draftCover;

  const listingUrl = String(d.listingUrl || d.url || "").trim();
  if (!listingUrl) return "";

  const r = await extractPublicListing(listingUrl);
  const img = String(r?.extracted?.image_url || "").trim();
  return img || "";
}

function buildLocationLineFromDraft(draft) {
  const d = draft && typeof draft === "object" ? draft : {};
  let locationStr = "";

  if (d.locationHint && typeof d.locationHint === "object") {
    const lh = d.locationHint;
    const lhCity = String(lh.city || "").trim();
    const lhState = String(lh.state || "").trim();
    const lhZip = String(lh.zip || "").trim();
    locationStr = [lhCity, lhState].filter(Boolean).join(", ") || lhZip || "";
  }
  if (!locationStr && d.areaHint) locationStr = String(d.areaHint).trim();

  return safeText(locationStr, 120);
}

function toNum(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function toInt(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/[^\d\-]/g, ""));
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

function pickText(...vals) {
  for (const v of vals) {
    const s = String(v || "").trim();
    if (s) return s;
  }
  return "";
}

function boolTrueLoose(...vals) {
  for (const v of vals) {
    if (v === true || v === 1) return true;
    const s = String(v || "").trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  }
  return false;
}

function toDateOrNull(v) {
  const raw = String(v || "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

function normalizeBoostTier(v, enabled = false) {
  if (!enabled) return "";
  const s = String(v || "").trim().toLowerCase();
  if (s === "priority") return "priority";
  return "priority";
}

function normalizeBoostColor(v, { enabled = false, freeOpen = false } = {}) {
  if (!enabled) return "";
  const s = String(v || "").trim().toLowerCase();
  if (s === "emerald" || s === "green") return "emerald";
  if (s === "amber" || s === "gold" || s === "yellow") return "amber";
  return freeOpen ? "emerald" : "amber";
}

function readProBoostInput(body) {
  const root = body && typeof body === "object" ? body : {};
  const profile = root?.profile && typeof root.profile === "object" ? root.profile : {};

  const enabled =
    boolTrueLoose(
      root?.matchBoostEnabled,
      profile?.matchBoostEnabled,

      root?.boosted,
      root?.priorityBoost,
      root?.profileBoosted,
      root?.sponsored,

      profile?.boosted,
      profile?.priorityBoost,
      profile?.profileBoosted,
      profile?.sponsored
    ) ||
    boolTrueLoose(
      root?.matchBoostFreeOpen,
      profile?.matchBoostFreeOpen,

      root?.freeOpen,
      root?.viewForFree,
      root?.openForFree,

      profile?.freeOpen,
      profile?.viewForFree,
      profile?.openForFree
    );

  const freeOpen = enabled && boolTrueLoose(
    root?.matchBoostFreeOpen,
    profile?.matchBoostFreeOpen,

    root?.freeOpen,
    root?.viewForFree,
    root?.openForFree,

    profile?.freeOpen,
    profile?.viewForFree,
    profile?.openForFree
  );

  const matchBoostTier = normalizeBoostTier(
    pickText(root?.matchBoostTier, profile?.matchBoostTier, root?.boostTier, profile?.boostTier),
    enabled
  );

  const matchBoostLabel = enabled
    ? safeText(
      pickText(
        root?.matchBoostLabel,
        profile?.matchBoostLabel,
        root?.boostLabel,
        profile?.boostLabel,
        freeOpen ? "Boosted • free open" : "Boosted profile"
      ),
      80
    )
    : "";

  const matchBoostColor = normalizeBoostColor(
    pickText(root?.matchBoostColor, profile?.matchBoostColor, root?.boostColor, profile?.boostColor),
    { enabled, freeOpen }
  );

  const matchBoostUpdatedAt = enabled
    ? (toDateOrNull(
      pickText(
        root?.matchBoostUpdatedAt,
        profile?.matchBoostUpdatedAt,
        root?.boostUpdatedAt,
        profile?.boostUpdatedAt
      )
    ) || new Date())
    : null;

  return {
    matchBoostEnabled: !!enabled,
    matchBoostFreeOpen: !!freeOpen,
    matchBoostTier,
    matchBoostLabel,
    matchBoostColor,
    matchBoostUpdatedAt,
  };
}

function decorateProBoostFields(doc) {
  const src = doc && typeof doc === "object" ? doc : {};

  const matchBoostEnabled = !!src.matchBoostEnabled;
  const matchBoostFreeOpen = !!(matchBoostEnabled && src.matchBoostFreeOpen);
  const matchBoostTier = normalizeBoostTier(src.matchBoostTier, matchBoostEnabled);
  const matchBoostLabel = matchBoostEnabled
    ? safeText(
      pickText(src.matchBoostLabel, matchBoostFreeOpen ? "Boosted • free open" : "Boosted profile"),
      80
    )
    : "";
  const matchBoostColor = normalizeBoostColor(src.matchBoostColor, {
    enabled: matchBoostEnabled,
    freeOpen: matchBoostFreeOpen,
  });

  return {
    matchBoostEnabled,
    matchBoostFreeOpen,
    matchBoostTier,
    matchBoostLabel,
    matchBoostColor,
    matchBoostUpdatedAt: src.matchBoostUpdatedAt || null,

    // compatibility fields for existing frontend
    boosted: matchBoostEnabled,
    priorityBoost: matchBoostEnabled,
    profileBoosted: matchBoostEnabled,
    boostTier: matchBoostTier,
    boostLabel: matchBoostLabel,
    boostColor: matchBoostColor,
    freeOpen: matchBoostFreeOpen,
    viewForFree: matchBoostFreeOpen,
    openForFree: matchBoostFreeOpen,
    boostUpdatedAt: src.matchBoostUpdatedAt || null,
  };
}

const SERVICE_SKILL_RX = {
  cleaning: /(clean|turnover|maid|housekeep|laundry)/i,
  septic: /(septic|pump)/i,
  painter: /(paint|painter|drywall|patch)/i,
  handyman: /(handyman|repair|fix|maintenance)/i,
  smart_lock: /(lock|keypad|smart)/i,
  delivery: /(deliver|pickup|dropoff|key)/i,
  design: /(design|staging|interior)/i,
  other: null,
};


/**
 * Public: Request OTP for PropertyCenter (creates a customer user if missing)
 * POST /api/pc/request-otp { email }
 * MVP/dev: OTP fixed = 123456 (prod me random)
 */
router.post("/request-otp", async (req, res) => {
  try {
    const email = safeEmail(req.body?.email);
    if (!email || !email.includes("@")) {
      return res.status(400).json({ success: false, message: "Valid email required" });
    }

    let user = await User.findOne({ email });

    const wasNew = !user;

    if (!user) {
      user = await User.create({
        name: email.split("@")[0].replace(/[._-]+/g, " ").trim() || "User",
        email,
        password: randomPassword(),
        role: "customer",
      });
    }

    const otp = process.env.NODE_ENV === "production"
      ? String(Math.floor(100000 + Math.random() * 900000))
      : "123456";

    user.otp = otp;
    user.otpExpiresAt = addDays(new Date(), 1);
    await user.save();

    const emailDomain = (email.split("@")[1] || "").slice(0, 80);
    logDemand(req, "otp_request", { tab: "auth", meta: { emailDomain, wasNew }, source: "api" });


    return res.json({
      success: true,
      message: process.env.NODE_ENV === "production" ? "OTP sent." : "OTP sent. (Dev OTP: 123456)",
    });
  } catch (e) {
    console.error("pc/request-otp error:", e);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/**
 * Public: Demand event logger (PII-safe)
 * POST /api/ps/events  (mount /api/pc bhi ho sakta hai)
 * body: { action, tab?, zip?, query?, meta?, source? }
 */
const EVENTS_RPM = clampInt(process.env.PS_EVENTS_RPM, 120, 20, 600);
const eventsLimiter = makeRateLimiter({ keyPrefix: "ps_events", windowMs: 60000, max: EVENTS_RPM });

router.post("/events", authOptional, eventsLimiter, async (req, res) => {
  const action = String(req.body?.action || "").trim();
  if (!action) return res.status(400).json({ ok: false, message: "action required" });

  const tab = req.body?.tab;
  const zip = req.body?.zip;
  const query = req.body?.query;
  const meta = req.body?.meta;
  const source = req.body?.source || "frontPage";

  await logDemand(req, action, { tab, zip, query, meta, source, userId: req.userId });
  return res.json({ ok: true });
});

// DEV-only: quick verify logs from PowerShell
router.get("/events/recent", async (req, res) => {
  if (process.env.NODE_ENV === "production") return res.status(404).json({ ok: false });

  const limit = Math.min(Number(req.query?.limit || 20), 100);
  const zip = sanitizeZip(req.query?.zip);

  const q = {};
  if (zip) q.zip3 = zip.slice(0, 3);

  const rows = await PSDemandEvent.find(q).sort({ createdAt: -1 }).limit(limit).lean();
  res.json({ ok: true, rows });
});

const PRO_EXTRACT_RPM = clampInt(process.env.PS_PRO_EXTRACT_RPM, 30, 10, 120);
const proExtractLimiter = makeRateLimiter({ keyPrefix: "ps_pro_extract", windowMs: 60000, max: PRO_EXTRACT_RPM });

router.post("/pro/extract_public", authOptional, proExtractLimiter, async (req, res) => {
  try {
    const url = req.body?.url || req.body?.link;
    const r = await extractPublicProProfile(url);
    if (!r?.ok) return res.status(400).json(r || { ok: false, error: "Extract failed" });
    return res.json(r);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || "Extract failed" });
  }
});

/**
 * Public: List pros in an area (zip3 prefix)
 * GET /api/pc/pros?zip=27606
 */
router.get("/pros", async (req, res) => {
  try {
    const zip = sanitizeZip(req.query?.zip);
    if (!zip || zip.length < 3) return res.json({ ok: true, rows: [] });

    const now = new Date();
    const zip3 = zip.slice(0, 3);

    const q = {
      kind: "pro",
      isActive: true,
      $or: [{ activeUntil: null }, { activeUntil: { $gt: now } }],
      zip: new RegExp("^" + zip3),
    };

    const rows = await PCPersona.find(q)
      .sort({ matchBoostEnabled: -1, matchBoostUpdatedAt: -1, matchCount: -1, updatedAt: -1 })
      .limit(50)
      .select("zip skills matchCount verified userId minRate rateUnit conditions focusTags evidenceLinks showExternalRating externalRating externalReviewCount jobsCount usdSpent matchBoostEnabled matchBoostFreeOpen matchBoostTier matchBoostLabel matchBoostColor matchBoostUpdatedAt")
      .populate("userId", "name email phone")
      .lean();

    const spendMap = await loadUser1099SpendMap(
      rows.map((r) => r?.userId?._id).filter(Boolean)
    );

    const out = rows.map((r) => {
      const boost = decorateProBoostFields(r);
      const liveSpent = Number(spendMap.get(String(r?.userId?._id || "")) || 0) || 0;

      return {
        _id: r._id,
        name: r.userId?.name,
        email: r.userId?.email || "",
        phone: r.userId?.phone || "",
        skills: r.skills || [],
        zip: r.zip,
        matchCount: r.matchCount || 0,
        verified: !!r.verified,
        // contact intentionally hidden until unlock

        minRate: r.minRate || 0,
        rateUnit: r.rateUnit || "hr",
        conditions: r.conditions || "",
        focusTags: Array.isArray(r.focusTags) ? r.focusTags : [],

        evidenceLinks: Array.isArray(r.evidenceLinks) ? r.evidenceLinks : [],
        showExternalRating: !!r.showExternalRating,
        externalRating: Number(r.externalRating || 0) || 0,
        externalReviewCount: Number(r.externalReviewCount || 0) || 0,
        jobsCount: Number(r.jobsCount || 0) || 0,
        usdSpent: liveSpent > 0 ? liveSpent : (Number(r.usdSpent || 0) || 0),

        ...boost,
      };
    });

    logDemand(req, "pros_list", { tab: "pros", zip, meta: { count: out.length }, source: "api" });

    res.json({ ok: true, rows: out });
  } catch (e) {
    console.error("pc/pros error:", e);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

router.get("/pro/me", auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?.userId;
    if (!userId) return res.status(401).json({ ok: false, message: "Not authenticated" });

    const doc = await PCPersona.findOne({ userId, kind: "pro" }).lean();
    if (!doc) return res.json({ ok: true, persona: null });

    return res.json({
      ok: true,
      persona: {
        ...doc,
        ...decorateProBoostFields(doc),
      },
    });
  } catch (e) {
    console.error("pc/pro/me error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

router.get("/pro/dashboard_state", auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?.userId;
    if (!userId) return res.status(401).json({ ok: false, message: "Not authenticated" });

    const doc = await PCPersona.findOne({ userId, kind: "pro" }).select("dashboardState").lean();
    const state = sanitizeProDashboardState(doc?.dashboardState || null);

    return res.json({ ok: true, state });
  } catch (e) {
    console.error("pc/pro/dashboard_state get error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

router.post("/pro/dashboard_state", auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?.userId;
    if (!userId) return res.status(401).json({ ok: false, message: "Not authenticated" });

    const doc = await PCPersona.findOne({ userId, kind: "pro" });
    if (!doc) return res.status(404).json({ ok: false, message: "No pro profile found" });

    const merged = sanitizeProDashboardState({
      ...(doc.dashboardState && typeof doc.dashboardState === "object" ? doc.dashboardState : {}),
      ...(req.body && typeof req.body === "object" ? req.body : {}),
    });

    doc.dashboardState = merged;
    await doc.save();

    return res.json({ ok: true, state: merged });
  } catch (e) {
    console.error("pc/pro/dashboard_state post error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

/**
 * Protected: Pro lead inbox (who unlocked you)
 * GET /api/pc/pro/leads?days=30&limit=80
 */
router.get("/pro/leads", auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?.userId;
    if (!userId) return res.status(401).json({ ok: false, message: "Not authenticated" });

    const pro = await PCPersona.findOne({ userId, kind: "pro" })
      .select("_id zip focusTags dashboardState")
      .lean();

    if (!pro?._id) return res.json({ ok: true, rows: [] });

    const proPersonaId = String(pro._id);
    const proId8 = proPersonaId.slice(-8);

    const limit = Math.min(200, Math.max(1, Number(req.query?.limit || 80)));
    const since = sinceDays(req.query?.days || "30");

    const q = {
      action: "pro_unlock",
      $or: [{ "meta.proPersonaId": proPersonaId }, { "meta.proId": proId8 }],
    };
    if (since) q.createdAt = { $gte: since };

    const events = await PSDemandEvent.find(q).sort({ createdAt: -1 }).limit(limit).lean();

    const userIds = Array.from(new Set(events.map((e) => String(e.userId || "").trim()).filter(Boolean)));
    const requestIds = Array.from(
      new Set(
        events
          .map((e) => String(e?.meta?.requestId || "").trim())
          .filter(Boolean)
      )
    );

    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select("name email phone").lean()
      : [];

    const reqDocs = requestIds.length
      ? await ServiceRequest.find({ _id: { $in: requestIds } })
        .select("serviceType tab budgetMax zip state addressText query fields createdAt")
        .lean()
      : [];

    const userMap = new Map(users.map((u) => [String(u._id), u]));
    const reqMap = new Map(reqDocs.map((r) => [String(r._id), r]));

    const now = Date.now();

    const rows = events.map((e) => {
      const meta = e?.meta && typeof e.meta === "object" ? e.meta : {};
      const reqId = String(meta?.requestId || "").trim();
      const reqDoc = reqMap.get(reqId) || null;

      const expMs = meta?.expiresAt ? Date.parse(String(meta.expiresAt)) : NaN;
      const expiresAtMs = Number.isFinite(expMs)
        ? expMs
        : (new Date(e.createdAt).getTime() + 30 * 60 * 1000);

      const active = expiresAtMs > now;
      const u = userMap.get(String(e.userId || "")) || null;

      const queryText = String(reqDoc?.query || e.query || "").trim();
      const serviceType = String(reqDoc?.serviceType || meta?.serviceType || "").trim();
      const tab = String(reqDoc?.tab || meta?.tab || "").trim();

      const sourceKind = guessLeadSourceKind(serviceType, tab);
      const fitScore = computeLeadFitScore(queryText, serviceType, pro.focusTags || []);
      const tags = collectLeadTags(reqDoc);

      const budgetHint = toLeadBudgetHint(reqDoc?.budgetMax || reqDoc?.fields?.budget);
      const locationText =
        String(reqDoc?.addressText || "").trim() ||
        [String(reqDoc?.zip || e.zip3 || "").trim(), String(reqDoc?.state || "").trim()].filter(Boolean).join(", ");

      const createdMs = new Date(e.createdAt).getTime();
      const urgency = !active
        ? "expired"
        : (now - createdMs < 2 * 60 * 60 * 1000)
          ? "hot"
          : (now - createdMs < 24 * 60 * 60 * 1000)
            ? "warm"
            : "normal";

      return {
        _id: e._id,
        createdAt: e.createdAt,
        expiresAt: new Date(expiresAtMs),
        active,
        zip3: e.zip3 || null,
        requestId: reqId || null,

        query: queryText || null,
        serviceType: serviceType || null,
        tab: tab || null,

        sourceKind,
        fitScore,
        urgency,
        budgetHint,
        locationText,
        serviceTags: tags,

        from: {
          id: e.userId || null,
          name: u?.name || "Customer",
          emailMasked: maskEmail(u?.email),
          phoneMasked: maskPhone(u?.phone),
        },
      };
    });

    logDemand(req, "pro_leads_list", {
      tab: "pros",
      zip: pro.zip,
      userId,
      meta: { count: rows.length },
      source: "api",
    });

    return res.json({ ok: true, rows });
  } catch (e) {
    console.error("pc/pro/leads error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

/**
 * Protected: Pro lead contact (only while the 30-min window is active)
 * POST /api/pc/pro/leads/:id/open
 */
router.post("/pro/leads/:id/open", auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?.userId;
    if (!userId) return res.status(401).json({ ok: false, message: "Not authenticated" });

    const pro = await PCPersona.findOne({ userId, kind: "pro" }).select("_id zip").lean();
    if (!pro?._id) return res.status(404).json({ ok: false, message: "No pro profile found" });

    const proPersonaId = String(pro._id);
    const proId8 = proPersonaId.slice(-8);

    const leadId = String(req.params.id || "").trim();
    if (!leadId) return res.status(400).json({ ok: false, message: "Missing lead id" });

    const ev = await PSDemandEvent.findById(leadId).lean();
    if (!ev || ev.action !== "pro_unlock") return res.status(404).json({ ok: false, message: "Lead not found" });

    const meta = ev?.meta && typeof ev.meta === "object" ? ev.meta : {};
    const belongs =
      (String(meta?.proPersonaId || "") === proPersonaId) ||
      (String(meta?.proId || "") === proId8);

    if (!belongs) return res.status(403).json({ ok: false, message: "Not allowed" });

    const expMs = meta?.expiresAt ? Date.parse(String(meta.expiresAt)) : NaN;
    const expiresAtMs = Number.isFinite(expMs)
      ? expMs
      : (new Date(ev.createdAt).getTime() + 30 * 60 * 1000);

    if (expiresAtMs <= Date.now()) {
      return res.status(403).json({ ok: false, error: "EXPIRED", message: "Unlock window expired" });
    }

    const u = await User.findById(ev.userId).select("name email phone").lean();
    if (!u) return res.status(404).json({ ok: false, message: "User not found" });

    logDemand(req, "pro_lead_open", {
      tab: "pros",
      zip: pro.zip,
      userId,
      meta: { leadId: String(ev._id).slice(-8), proPersonaId },
      source: "api",
    });

    return res.json({
      ok: true,
      expiresAt: new Date(expiresAtMs),
      requestId: meta?.requestId || null,
      contact: {
        id: String(u._id),
        name: u.name,
        email: u.email,
        phone: u.phone || null,
      },
    });
  } catch (e) {
    console.error("pc/pro/leads/open error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});


/**
 * Protected: Create/Update Pro persona (active for 90 days)
 * POST /api/pc/pro/apply
 * {
 *   zip,
 *   skills[],
 *   minRate?,
 *   rateUnit?,
 *   conditions?,
 *   focusTags?,
 *   boosted?/priorityBoost?/profileBoosted?,
 *   freeOpen?/viewForFree?/openForFree?,
 *   boostLabel?/boostColor?/boostUpdatedAt?
 * }
 */
router.post("/pro/apply", auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, message: "Not authenticated" });

    const zipClean = sanitizeZip(req.body?.zip);
    const skillsClean = Array.isArray(req.body?.skills)
      ? req.body.skills.map((s) => String(s).trim()).filter(Boolean).slice(0, 20)
      : [];

    if (!zipClean || zipClean.length < 3) {
      return res.status(400).json({ success: false, message: "Zip required" });
    }

    // Part 7 fields (UI now, backend-ready)
    const minRateNum = Math.max(0, Number(req.body?.minRate) || 0);
    const rateUnitClean = req.body?.rateUnit === "job" ? "job" : "hr";
    const conditionsClean = String(req.body?.conditions || "").trim().slice(0, 240);

    const focusArr = Array.isArray(req.body?.focusTags)
      ? req.body.focusTags
      : String(req.body?.focusTags || "").split(/[,\n]/g);

    const focusClean = focusArr
      .map((s) => String(s || "").trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 12);

    const evidenceIn = Array.isArray(req.body?.evidenceLinks)
      ? req.body.evidenceLinks
      : (Array.isArray(req.body?.profile?.evidenceLinks) ? req.body.profile.evidenceLinks : []);

    const evidenceLinks = (evidenceIn || [])
      .map((u) => String(u || "").trim())
      .filter((u) => /^https?:\/\//i.test(u))
      .map((u) => u.slice(0, 400))
      .slice(0, 8);

    const showExternalRating = !!(req.body?.showExternalRating ?? req.body?.profile?.showExternalRating);
    const externalRating = Math.max(0, Math.min(5, toNum(req.body?.externalRating ?? req.body?.profile?.externalRating)));
    const externalReviewCount = Math.max(0, toInt(req.body?.externalReviewCount ?? req.body?.profile?.externalReviewCount));

    const jobsCount = Math.max(0, toInt(req.body?.jobsCount ?? req.body?.profile?.jobsCount));
    const usdSpent = Math.max(0, toNum(req.body?.usdSpent ?? req.body?.profile?.usdSpent));

    const {
      matchBoostEnabled,
      matchBoostFreeOpen,
      matchBoostTier,
      matchBoostLabel,
      matchBoostColor,
      matchBoostUpdatedAt,
    } = readProBoostInput(req.body);

    const now = new Date();
    const activeUntil = addDays(now, 90);

    const doc = await PCPersona.findOneAndUpdate(
      { userId, kind: "pro" },
      {
        $set: {
          zip: zipClean,
          skills: skillsClean,
          isActive: true,
          activeUntil,
          consentUntil: activeUntil,

          // new fields
          minRate: minRateNum,
          rateUnit: rateUnitClean,
          conditions: conditionsClean,
          focusTags: focusClean,

          evidenceLinks,
          showExternalRating,
          externalRating,
          externalReviewCount,

          jobsCount,
          usdSpent,

          matchBoostEnabled,
          matchBoostFreeOpen,
          matchBoostTier,
          matchBoostLabel,
          matchBoostColor,
          matchBoostUpdatedAt,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    await logDemand(req, "pro_apply", {
      tab: "pros",
      zip: zipClean,
      userId,
      meta: {
        skillsCount: skillsClean.length,
        minRate: minRateNum,
        rateUnit: rateUnitClean,
        matchBoostEnabled,
        matchBoostFreeOpen,
      },
      source: "api",
    });

    return res.json({
      success: true,
      persona: {
        ...doc,
        ...decorateProBoostFields(doc),
      },
    });
  } catch (e) {
    console.error("pc/pro/apply error:", e);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});


/**
 * Protected: Unlock contact (increment matchCount)
 * POST /api/pc/pros/:id/unlock
 */
router.post("/pros/:id/unlock", auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?.userId;
    if (!userId) return res.status(401).json({ ok: false, message: "Not authenticated" });

    const id = req.params.id;
    // ✅ v2: enforce 30-min session lock per user
    const user = await User.findById(userId).select("unlockLockedUntil");

    const now = Date.now();
    const lockedUntil = user?.unlockLockedUntil ? user.unlockLockedUntil.getTime() : 0;

    if (lockedUntil && lockedUntil > now) {
      // optional: log blocked attempt
      // await PSDemandEvent.create({ kind: "unlock_blocked", userId: req.userId, meta: { lockedUntil: user.unlockLockedUntil } });

      return res.status(429).json({
        ok: false,
        error: "UNLOCK_WINDOW_ACTIVE",
        expiresAt: user.unlockLockedUntil.toISOString(),
        message: "Unlocks available again after the 30-min window.",
      });
    }

    const row = await PCPersona.findById(id).populate("userId", "name email phone").exec();
    if (!row || row.kind !== "pro") return res.status(404).json({ ok: false, message: "Not found" });

    row.matchCount = Number(row.matchCount || 0) + 1;
    await row.save();

    const expiresAt = new Date(now + 30 * 60 * 1000);
    const requestId = String(req.body?.request_id || req.body?.requestId || req.body?.reqId || "").trim();

    logDemand(req, "pro_unlock", {
      tab: "pros",
      zip: row.zip,
      userId,
      meta: {
        proId: String(id).slice(-8), // last 8 only (safe)
        proPersonaId: String(id),
        expiresAt: expiresAt.toISOString(),
        ...(requestId ? { requestId } : {}),
      },
      source: "api",
    });


    if (user) {
      user.unlockLockedUntil = expiresAt;
      await user.save();
    }


    res.json({
      ok: true,
      expiresAt,

      contact: {
        name: row.userId?.name,
        email: row.userId?.email,
        phone: row.userId?.phone || null,
      },
    });
  } catch (e) {
    console.error("pc/unlock error:", e);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

// -------------------- Pro Leads Inbox (MVP) --------------------



/**
 * Admin: Demand summary (auth required)
 * GET /api/ps/admin/demand/summary?days=7&zip3=276
 */
router.get("/admin/demand/summary", demandAdminAuth, async (req, res) => {

  try {
    // keep this guard (from first version)
    if (process.env.NODE_ENV === "production" && req.user?.role !== "admin") {
      return res.status(403).json({ ok: false, message: "Admin only" });
    }

    const daysRaw = String(req.query?.days || "7");
    const since = sinceDays(daysRaw); // supports days=all
    const zip3 = sanitizeZip3(req.query?.zip3);

    const match = {};
    if (since) match.createdAt = { $gte: since };
    if (zip3) match.zip3 = zip3;


    const [total, byAction, byZip3, byDay] = await Promise.all([
      PSDemandEvent.countDocuments(match),
      PSDemandEvent.aggregate([
        { $match: match },
        { $group: { _id: "$action", count: { $sum: 1 } } },
        { $project: { _id: 0, action: "$_id", count: 1 } },
        { $sort: { count: -1 } },
        { $limit: 50 },
      ]),
      PSDemandEvent.aggregate([
        { $match: match },
        { $group: { _id: "$zip3", count: { $sum: 1 } } },
        { $project: { _id: 0, zip3: "$_id", count: 1 } },
        { $sort: { count: -1 } },
        { $limit: 50 },
      ]),
      PSDemandEvent.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
              action: "$action",
            },
            count: { $sum: 1 },
          },
        },
        { $project: { _id: 0, day: "$_id.day", action: "$_id.action", count: 1 } },
        { $sort: { day: 1, count: -1 } },
        { $limit: 400 },
      ]),
    ]);

    res.json({ ok: true, range: { days: daysRaw, since }, total, byAction, byZip3, byDay });
  } catch (e) {
    console.error("admin demand summary error:", e);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

/**
 * Admin: Market insights + heatmap (Part 8)
 * GET /api/pc/admin/demand/insights?days=7|30|all&zip3=276&limit=60
 * Returns:
 *  - funnel: { searches, requests, unlocks, convReqFromSearch, convUnlockFromReq, convUnlockFromSearch }
 *  - heatZip3: [{ zip3, searches, requests, unlocks, convReqFromSearch, convUnlockFromReq }]
 *  - clusters: { topServiceTypes:[{serviceType,count}], byServiceType:[{serviceType,total,topZip3:[{zip3,count}]}] }
 *  - zip3ServiceType: [{ zip3, serviceType, count }]
 */
router.get("/admin/demand/insights", demandAdminAuth, async (req, res) => {
  try {
    const daysRaw = String(req.query?.days || "7");
    const since = sinceDays(daysRaw); // supports days=all
    const zip3 = sanitizeZip3(req.query?.zip3);
    const limit = clampInt(req.query?.limit, 60, 5, 200);

    // Funnel steps (events-based)
    const ACTIONS_SEARCH = ["search_typing", "search_focus", "search_blur", "chip_click"];
    const ACTIONS_REQUEST = ["request_submit", "housing_contact_request"];

    const ACTIONS_UNLOCK = ["pro_unlock_success", "pro_unlock", "housing_contact_unlocked"];

    const matchBase = {};
    if (since && since.getTime() > 0) matchBase.createdAt = { $gte: since };
    if (zip3) matchBase.zip3 = zip3;

    // Funnel totals
    const [searches, requests, unlocks] = await Promise.all([
      PSDemandEvent.countDocuments({ ...matchBase, action: { $in: ACTIONS_SEARCH } }),
      PSDemandEvent.countDocuments({ ...matchBase, action: { $in: ACTIONS_REQUEST } }),
      PSDemandEvent.countDocuments({ ...matchBase, action: { $in: ACTIONS_UNLOCK } }),
    ]);

    const convReqFromSearch = searches ? Number(((requests / searches) * 100).toFixed(1)) : 0;
    const convUnlockFromReq = requests ? Number(((unlocks / requests) * 100).toFixed(1)) : 0;
    const convUnlockFromSearch = searches ? Number(((unlocks / searches) * 100).toFixed(1)) : 0;

    // Heat by zip3 (merge searches + requests + unlocks)
    const [byZip3Search, byZip3Req, byZip3Unlock] = await Promise.all([
      PSDemandEvent.aggregate([
        { $match: { ...matchBase, action: { $in: ACTIONS_SEARCH }, zip3: { $exists: true, $ne: "" } } },
        { $group: { _id: "$zip3", count: { $sum: 1 } } },
        { $project: { _id: 0, zip3: "$_id", count: 1 } },
        { $sort: { count: -1 } },
        { $limit: Math.max(limit * 2, 80) },
      ]),
      PSDemandEvent.aggregate([
        { $match: { ...matchBase, action: { $in: ACTIONS_REQUEST }, zip3: { $exists: true, $ne: "" } } },
        { $group: { _id: "$zip3", count: { $sum: 1 } } },
        { $project: { _id: 0, zip3: "$_id", count: 1 } },
        { $sort: { count: -1 } },
        { $limit: Math.max(limit * 2, 80) },
      ]),
      PSDemandEvent.aggregate([
        { $match: { ...matchBase, action: { $in: ACTIONS_UNLOCK }, zip3: { $exists: true, $ne: "" } } },
        { $group: { _id: "$zip3", count: { $sum: 1 } } },
        { $project: { _id: 0, zip3: "$_id", count: 1 } },
        { $sort: { count: -1 } },
        { $limit: Math.max(limit * 2, 80) },
      ]),
    ]);

    const heatMap = new Map();
    for (const r of byZip3Search) {
      const z = String(r?.zip3 || "").trim();
      if (!z) continue;
      heatMap.set(z, { zip3: z, searches: Number(r?.count || 0), requests: 0, unlocks: 0 });
    }
    for (const r of byZip3Req) {
      const z = String(r?.zip3 || "").trim();
      if (!z) continue;
      const cur = heatMap.get(z) || { zip3: z, searches: 0, requests: 0, unlocks: 0 };
      cur.requests = Number(r?.count || 0);
      heatMap.set(z, cur);
    }
    for (const r of byZip3Unlock) {
      const z = String(r?.zip3 || "").trim();
      if (!z) continue;
      const cur = heatMap.get(z) || { zip3: z, searches: 0, requests: 0, unlocks: 0 };
      cur.unlocks = Number(r?.count || 0);
      heatMap.set(z, cur);
    }

    let heatZip3 = Array.from(heatMap.values()).map((r) => {
      const s = Number(r.searches || 0);
      const q = Number(r.requests || 0);
      const u = Number(r.unlocks || 0);
      return {
        ...r,
        convReqFromSearch: s ? Number(((q / s) * 100).toFixed(1)) : 0,
        convUnlockFromReq: q ? Number(((u / q) * 100).toFixed(1)) : 0,
      };
    });

    heatZip3 = heatZip3
      .sort((a, b) => (b.requests - a.requests) || (b.searches - a.searches))
      .slice(0, limit);

    // ServiceType clusters (based on request_submit events)
    const zip3ServiceType = await PSDemandEvent.aggregate([
      {
        $match: {
          ...matchBase,
          action: { $in: ACTIONS_REQUEST },
          zip3: { $exists: true, $ne: "" },
          "meta.serviceType": { $exists: true, $ne: "" },
        },
      },
      { $group: { _id: { zip3: "$zip3", serviceType: "$meta.serviceType" }, count: { $sum: 1 } } },
      { $project: { _id: 0, zip3: "$_id.zip3", serviceType: "$_id.serviceType", count: 1 } },
      { $sort: { count: -1 } },
      { $limit: 2000 },
    ]);

    const bySt = new Map();
    for (const r of zip3ServiceType) {
      const st = String(r?.serviceType || "").trim();
      const z = String(r?.zip3 || "").trim();
      const c = Number(r?.count || 0);
      if (!st || !z) continue;
      const cur = bySt.get(st) || { serviceType: st, total: 0, topZip3: [] };
      cur.total += c;
      cur.topZip3.push({ zip3: z, count: c });
      bySt.set(st, cur);
    }

    const byServiceType = Array.from(bySt.values())
      .map((x) => ({
        ...x,
        topZip3: x.topZip3.sort((a, b) => b.count - a.count).slice(0, 8),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 20);

    const topServiceTypes = byServiceType.map((x) => ({ serviceType: x.serviceType, count: x.total }));

    return res.json({
      ok: true,
      range: { days: daysRaw, since },
      funnel: {
        searches,
        requests,
        unlocks,
        convReqFromSearch,
        convUnlockFromReq,
        convUnlockFromSearch,
      },
      heatZip3,
      clusters: { topServiceTypes, byServiceType },
      zip3ServiceType,
    });
  } catch (e) {
    console.error("[admin/demand/insights] error", e);
    return res.status(500).json({ ok: false, error: e?.message || "Failed to load insights." });
  }
});



// ---------------------------------------------------------------------------
// AdminDemand.jsx compatibility endpoints
//   GET /admin/demand/top
//   GET /admin/demand/events
// ---------------------------------------------------------------------------

// /**
//  * GET /api/*/admin/demand/top
//  * query: days=7|30|all&limit=20
//  * returns: { ok, topQueries, topZips, topServiceTypes }
//  **/
router.get("/admin/demand/top", demandAdminAuth, async (req, res) => {
  try {
    const daysRaw = String(req.query.days || "7");
    const since = sinceDays(daysRaw); // supports days=all
    const limit = clampInt(req.query.limit, 20, 1, 200);

    const matchBase = {};
    if (since && since.getTime() > 0) matchBase.createdAt = { $gte: since };

    const [topQueries, topZips, topServiceTypes] = await Promise.all([
      PSDemandEvent.aggregate([
        { $match: { ...matchBase, query: { $exists: true, $ne: "" } } },
        { $group: { _id: "$query", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limit },
        { $project: { _id: 0, query: "$_id", count: 1 } },
      ]),
      PSDemandEvent.aggregate([
        { $match: { ...matchBase, zip3: { $exists: true, $ne: "" } } },
        { $group: { _id: "$zip3", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limit },
        { $project: { _id: 0, zip: "$_id", count: 1 } },
      ]),
      PSDemandEvent.aggregate([
        { $match: { ...matchBase, "meta.serviceType": { $exists: true, $ne: "" } } },
        { $group: { _id: "$meta.serviceType", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limit },
        { $project: { _id: 0, serviceType: "$_id", count: 1 } },
      ]),
    ]);

    return res.json({ ok: true, topQueries, topZips, topServiceTypes });
  } catch (e) {
    console.error("[admin/demand/top] error", e);
    return res.status(500).json({ ok: false, error: e?.message || "Failed to load top." });
  }
});

/**
 * Admin: Demand gaps (demand > supply)
 * GET /api/ps/admin/demand/gaps?days=30|all&zip3=276&limit=25
 * returns rows: [{ zip3, serviceType, demandCount, supplyCount, gapScore, avgBudget }]
 */
router.get("/admin/demand/gaps", demandAdminAuth, async (req, res) => {
  try {
    const daysRaw = String(req.query?.days || "30");
    const since = sinceDays(daysRaw);
    const zip3 = sanitizeZip3(req.query?.zip3);
    const limit = clampInt(req.query?.limit, 25, 1, 200);

    const match = {};
    if (since) match.createdAt = { $gte: since };
    if (zip3) match.zip3 = zip3;

    // Aggregate demand by zip3 + serviceType
    const demand = await ServiceRequest.aggregate([
      { $match: match },
      {
        $group: {
          _id: { zip3: "$zip3", serviceType: "$serviceType" },
          demandCount: { $sum: 1 },
          avgBudget: { $avg: "$budgetMax" },
        },
      },
      { $sort: { demandCount: -1 } },
      { $limit: Math.max(limit * 3, 50) },
    ]);

    // For each bucket, estimate supply by matching pro skills in that ZIP3
    const tasks = demand.map(async (d) => {
      const z3 = d?._id?.zip3 || "";
      const st = d?._id?.serviceType || "other";
      const rx = SERVICE_SKILL_RX[st] || null;

      const proQuery = { kind: "pro", isActive: true };
      if (z3) proQuery.zip = new RegExp(`^${z3}`);
      if (rx) proQuery.skills = rx;

      const supplyCount = await PCPersona.countDocuments(proQuery);
      const demandCount = Number(d?.demandCount || 0);
      const gapScore = demandCount / (supplyCount + 1);

      return {
        zip3: z3,
        serviceType: st,
        demandCount,
        supplyCount,
        gapScore: Number(gapScore.toFixed(2)),
        avgBudget: Number((d?.avgBudget || 0).toFixed(0)),
      };
    });

    let rows = await Promise.all(tasks);

    // Keep only meaningful gaps
    rows = rows
      .filter((r) => r.demandCount >= 2)
      .filter((r) => r.supplyCount === 0 || r.gapScore >= 1.5)
      .sort((a, b) => (b.gapScore - a.gapScore) || (b.demandCount - a.demandCount))
      .slice(0, limit);

    return res.json({ ok: true, range: { days: daysRaw, since }, zip3: zip3 || "", rows });
  } catch (e) {
    console.error("[admin/demand/gaps] error", e);
    return res.status(500).json({ ok: false, error: e?.message || "Failed to load gaps." });
  }
});


// /**
//  * GET /api/*/admin/demand/events
//  * query: days=7|30|all&limit=400&action=&q=&zip=
//  * returns: { ok, rows:[...] }
//  **/
router.get("/admin/demand/events", demandAdminAuth, async (req, res) => {
  try {
    const daysRaw = String(req.query.days || "7");
    const since = sinceDays(daysRaw); // supports days=all
    const limit = clampInt(req.query.limit, 400, 1, 5000);

    const action = String(req.query.action || "").trim();
    const qRaw = String(req.query.q || "").trim();

    // IMPORTANT FIX: sanitizeZip empty => null, so make it ""
    const zipIn = sanitizeZip(req.query.zip || "") || "";

    const match = {};
    if (since && since.getTime() > 0) match.createdAt = { $gte: since };
    if (action) match.action = action;

    if (zipIn.length >= 3) match.zip3 = zipIn.slice(0, 3);
    if (zipIn.length >= 5) match.zip = zipIn.slice(0, 5);

    if (qRaw) {
      const esc = qRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(esc, "i");
      match.$or = [{ action: rx }, { tab: rx }, { query: rx }, { "meta.serviceType": rx }];
    }

    const rows = await PSDemandEvent.find(match)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("action tab zip zip3 query meta createdAt refHost source")
      .lean();

    const out = rows.map((r) => ({
      ts: r.createdAt,
      action: r.action,
      tab: r.tab,
      zip: r.zip,
      query: r.query,
      meta: r.meta,
    }));

    return res.json({ ok: true, rows: out });
  } catch (e) {
    console.error("[admin/demand/events] error", e);
    return res.status(500).json({ ok: false, error: e?.message || "Failed to load events." });
  }
});

/**
 * Admin: All customer STR listings (cards + edit)
 * GET /api/ps/admin/str/listings?days=all|30&status=all|published|draft&zip3=276&q=&limit=24&skip=0
 */
router.get("/admin/str/listings", demandAdminAuth, async (req, res) => {
  try {
    if (!StrListing) return res.status(501).json({ ok: false, error: "model_missing" });

    const daysRaw = String(req.query?.days || "all");
    const since = sinceDays(daysRaw); // supports "all"
    const status = String(req.query?.status || "all").toLowerCase();

    const limit = clampInt(req.query?.limit, 24, 1, 200);
    const skip = clampInt(req.query?.skip, 0, 0, 100000);

    const zip3 = sanitizeZip3(req.query?.zip3);
    const qRaw = String(req.query?.q || "").trim();

    const match = {};
    if (since) match.updatedAt = { $gte: since };
    if (zip3) match.zip3 = zip3;

    if (status === "published") match.published = true;
    if (status === "draft") match.published = false;

    if (qRaw) {
      const esc = qRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(esc, "i");
      match.$or = [
        { listing_id: rx },
        { public_title: rx },
        { public_preview: rx },
        { zip: rx },
        { zip3: rx },
      ];
    }

    const [total, rows] = await Promise.all([
      StrListing.countDocuments(match),
      StrListing.find(match)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("userId", "name email phone")
        .lean(),
    ]);

    const keys = rows.map((d) => `str_listing|${d.listing_id}`);
    const srRows = await ServiceRequest.find({ dedupeKey: { $in: keys } })
      .select("dedupeKey updatedAt createdAt")
      .lean();
    const srMap = new Map(srRows.map((r) => [r.dedupeKey, r]));

    const items = rows.map((d) => {
      const draft = d?.draft && typeof d.draft === "object" ? d.draft : {};
      const beds = Number(draft?.beds || draft?.bedrooms || 0) || 0;
      const baths = Number(draft?.baths || draft?.bathrooms || 0) || 0;

      const photo_urls = Array.isArray(d.photos)
        ? d.photos.slice(0, 6).map((p) => p?.url).filter(Boolean)
        : [];

      const hero_url = pickHeroUrl(d);

      const key = `str_listing|${d.listing_id}`;
      const sr = srMap.get(key);

      return {
        listing_id: d.listing_id,
        zip: d.zip || "",
        zip3: d.zip3 || "",
        hero_url,
        state: d.state || "",

        public_title: d.public_title || "",
        public_preview: d.public_preview || "",
        cover_url: pickHeroUrl(d) || "",
        photo_count: Array.isArray(d.photos) ? d.photos.length : 0,

        hero_url,

        published: !!d.published,
        publishedAt: d.publishedAt || null,
        updatedAt: d.updatedAt || null,

        // editable mini draft
        draft: {
          beds: draft.beds ?? draft.bedrooms ?? 0,
          baths: draft.baths ?? draft.bathrooms ?? 0,
          propertyType: draft.propertyType || "",
          nightlyMin: draft.nightlyMin ?? null,
          nightlyMax: draft.nightlyMax ?? null,
          minNights: draft.minNights ?? null,
          areaHint: draft.areaHint || "",
          locationHint: draft.locationHint || null,
          listingUrl: draft.listingUrl || "",
        },

        owner: d.userId
          ? {
            id: String(d.userId?._id || ""),
            name: d.userId?.name || "",
            email: d.userId?.email || "",
            phone: d.userId?.phone || "",
          }
          : null,

        in_feed: !!sr,
        feed_updatedAt: sr ? (sr.updatedAt || sr.createdAt || null) : null,
      };
    });

    return res.json({ ok: true, range: { days: daysRaw, since }, total, limit, skip, items });
  } catch (e) {
    console.error("[admin/str/listings] error", e);
    return res.status(500).json({ ok: false, error: e?.message || "Failed to load listings." });
  }
});

/**
 * Admin: Edit listing (title/preview/zip/draft fields/publish)
 * PATCH /api/ps/admin/str/listings/:listing_id
 */
router.patch("/admin/str/listings/:listing_id", demandAdminAuth, async (req, res) => {
  try {
    if (!StrListing) return res.status(501).json({ ok: false, error: "model_missing" });

    const listingId = String(req.params?.listing_id || "").trim();
    if (!listingId) return res.status(400).json({ ok: false, error: "missing_listing_id" });

    const doc = await StrListing.findOne({ listing_id: listingId });
    if (!doc) return res.status(404).json({ ok: false, error: "not_found" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const draftPatch = body.draftPatch && typeof body.draftPatch === "object" ? body.draftPatch : null;

    // zip
    if (Object.prototype.hasOwnProperty.call(body, "zip")) {
      const z5 = sanitizeZip5(body.zip);
      doc.zip = z5 || "";
      doc.zip3 = z5 ? z5.slice(0, 3) : (doc.zip3 || "");
    }

    // public fields
    if (Object.prototype.hasOwnProperty.call(body, "public_title")) {
      doc.public_title = safeText(body.public_title, 160);
    }
    if (Object.prototype.hasOwnProperty.call(body, "public_preview")) {
      doc.public_preview = safeText(body.public_preview, 420);
    }

    // cover url (also mark photo is_cover)
    if (Object.prototype.hasOwnProperty.call(body, "cover_url")) {
      const c = String(body.cover_url || "").trim().slice(0, 1200);
      doc.cover_url = c;

      if (Array.isArray(doc.photos) && doc.photos.length) {
        doc.photos = doc.photos.map((p) => ({
          ...p,
          is_cover: String(p.url || "") === c,
        }));
      }
    }

    // draft merge
    if (draftPatch) {
      const cur = doc.draft && typeof doc.draft === "object" ? doc.draft : {};
      const next = { ...cur, ...draftPatch };

      // if nested locationHint passed, merge it
      if (draftPatch.locationHint && typeof draftPatch.locationHint === "object") {
        const curLH = cur.locationHint && typeof cur.locationHint === "object" ? cur.locationHint : {};
        next.locationHint = { ...curLH, ...draftPatch.locationHint };
      }

      doc.draft = next;
    }

    // publish toggle
    const wantsPublished = Object.prototype.hasOwnProperty.call(body, "published")
      ? !!body.published
      : doc.published;

    const wasPublished = !!doc.published;

    if (wantsPublished && !wasPublished) {
      doc.published = true;
      doc.publishedAt = new Date();
    }
    if (!wantsPublished && wasPublished) {
      doc.published = false;
      doc.publishedAt = null;
    }

    // guarantee title/preview if published
    if (doc.published) {
      const d = doc.draft && typeof doc.draft === "object" ? doc.draft : {};
      if (!doc.public_title) doc.public_title = safeText(d.title || d.headline || `STR Listing ${doc.listing_id}`, 160);
      if (!doc.public_preview) doc.public_preview = buildPreviewFromDraft(d) || safeText(d.description || `ZIP ${doc.zip || ""}`, 420);
    }

    await doc.save();

    // keep housing feed in sync
    const housingKey = `str_listing|${doc.listing_id}`;
    if (!doc.published) {
      // unpublish => remove from feed
      await ServiceRequest.deleteOne({ dedupeKey: housingKey });
    } else {
      // publish => upsert feed if zip3 exists
      const z5 = sanitizeZip5(doc.zip || "");
      const z3 = (doc.zip3 && String(doc.zip3).slice(0, 3)) || zip3FromAny(z5);
      if (z3) {
        const d = doc.draft && typeof doc.draft === "object" ? doc.draft : {};
        const bedsN = Number(d.beds || 0) || 0;
        const bathsN = Number(d.baths || 0) || 0;

        const locationStr = buildLocationLineFromDraft(d);
        const srQuery = doc.public_title || d.title || d.headline || "Short-term rental listing";
        const srPreview = doc.public_preview || safeText(d.description || "", 420);

        const srFields = {
          kind: "str_listing",
          referenceId: doc.listing_id,
          referenceType: "str_listing",
          listingUrl: d.listingUrl || d.publicLocationUrl || "",
          coverImageUrl: doc.cover_url || "",
          public_title: doc.public_title || "",
          public_preview: doc.public_preview || "",
          propertyType: d.propertyType || null,
          nightlyMin: d.nightlyMin || null,
          nightlyMax: d.nightlyMax || null,
          cleaningFee: d.cleaningFee || null,
          minNights: d.minNights || null,
          amenities: Array.isArray(d.amenities) ? d.amenities : [],
          tags: ["str", "short-term-rental"],
          source: "admin_edit",
          preview: srPreview,
        };

        await ServiceRequest.updateOne(
          { dedupeKey: housingKey },
          {
            $setOnInsert: {
              dedupeKey: housingKey,
              serviceType: "housing_listing",
              tab: "housing",
              intent: "offer",
              userId: doc.userId || undefined,
              source: "psStrAdmin",
              reason: "admin_edit_publish",
              createdAt: new Date(),
            },
            $set: {
              zip: z5,
              zip3: z3,
              query: srQuery,
              addressText: locationStr,
              beds: bedsN,
              baths: bathsN,
              fields: srFields,
              updatedAt: new Date(),
            },
          },
          { upsert: true, runValidators: true }
        );
      }
    }

    // return updated mini
    const draft = doc.draft && typeof doc.draft === "object" ? doc.draft : {};
    return res.json({
      ok: true,
      item: {
        listing_id: doc.listing_id,
        zip: doc.zip || "",
        zip3: doc.zip3 || "",
        public_title: doc.public_title || "",
        public_preview: doc.public_preview || "",
        cover_url: doc.cover_url || "",
        photo_count: Array.isArray(doc.photos) ? doc.photos.length : 0,
        photo_urls: Array.isArray(doc.photos) ? doc.photos.slice(0, 6).map((p) => p?.url).filter(Boolean) : [],
        published: !!doc.published,
        publishedAt: doc.publishedAt || null,
        updatedAt: doc.updatedAt || null,
        draft: {
          beds: draft.beds ?? 0,
          baths: draft.baths ?? 0,
          propertyType: draft.propertyType || "",
          nightlyMin: draft.nightlyMin ?? null,
          nightlyMax: draft.nightlyMax ?? null,
          minNights: draft.minNights ?? null,
          areaHint: draft.areaHint || "",
          locationHint: draft.locationHint || null,
          listingUrl: draft.listingUrl || "",
        },
      },
    });
  } catch (e) {
    console.error("[admin/str/listings:patch] error", e);
    return res.status(500).json({ ok: false, error: e?.message || "Failed to update listing." });
  }
});

/**
 * Admin: Delete STR listing permanently
 * DELETE /api/ps/admin/str/listings/:listing_id
 * Also removes: housing feed ServiceRequest + local uploads folder (if any)
 */
router.delete("/admin/str/listings/:listing_id", demandAdminAuth, async (req, res) => {
  try {
    if (!StrListing) return res.status(501).json({ ok: false, error: "model_missing" });

    const listingId = String(req.params?.listing_id || "").trim();
    if (!listingId) return res.status(400).json({ ok: false, error: "missing_listing_id" });

    const doc = await StrListing.findOne({ listing_id: listingId }).select("listing_id").lean();
    if (!doc) return res.status(404).json({ ok: false, error: "not_found" });

    // 1) delete listing doc
    await StrListing.deleteOne({ listing_id: listingId });

    // 2) delete from housing feed
    const key = `str_listing|${listingId}`;
    await ServiceRequest.deleteOne({ dedupeKey: key });

    // 3) delete uploaded photos folder (best-effort)
    try {
      const dir = path.join(__dirname, "..", "uploads", "ps_str", listingId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }

    return res.json({ ok: true, deleted: true, listing_id: listingId });
  } catch (e) {
    console.error("[admin delete listing] error", e);
    return res.status(500).json({ ok: false, error: e?.message || "Failed to delete listing." });
  }
});

/**
 * Admin: Live published STR listings (ads)
 * GET /api/ps/admin/demand/live_listings?days=7|30|all&zip3=276&limit=40&skip=0&q=
 * returns: { ok, total, limit, skip, items:[...] }
 */
router.get("/admin/demand/live_listings", demandAdminAuth, async (req, res) => {
  try {
    if (!StrListing) return res.status(501).json({ ok: false, error: "model_missing" });

    const daysRaw = String(req.query?.days || "30");
    const since = sinceDays(daysRaw); // supports "all"
    const limit = clampInt(req.query?.limit, 40, 1, 200);
    const skip = clampInt(req.query?.skip, 0, 0, 5000);
    const zip3 = sanitizeZip3(req.query?.zip3);

    const qRaw = String(req.query?.q || "").trim();

    const match = { published: true };

    // filter by time (publishedAt). if older docs have null publishedAt they will be excluded (OK).
    if (since) match.publishedAt = { $gte: since };
    if (zip3) match.zip3 = zip3;

    if (qRaw) {
      const esc = qRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(esc, "i");
      match.$or = [
        { listing_id: rx },
        { public_title: rx },
        { public_preview: rx },
        { zip: rx },
        { zip3: rx },
      ];
    }

    const [total, rows] = await Promise.all([
      StrListing.countDocuments(match),
      StrListing.find(match)
        .sort({ publishedAt: -1, updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("userId", "name email phone")
        .lean(),
    ]);

    // Check if each published listing actually exists in housing feed
    const keys = rows.map((d) => `str_listing|${d.listing_id}`);
    const srRows = await ServiceRequest.find({ dedupeKey: { $in: keys } })
      .select("dedupeKey zip zip3 createdAt updatedAt")
      .lean();

    const srMap = new Map(srRows.map((r) => [r.dedupeKey, r]));

    const items = rows.map((d) => {
      const key = `str_listing|${d.listing_id}`;
      const sr = srMap.get(key);

      const draft = d?.draft && typeof d.draft === "object" ? d.draft : {};
      const beds = Number(draft?.beds || draft?.bedrooms || 0) || 0;
      const baths = Number(draft?.baths || draft?.bathrooms || 0) || 0;

      return {
        listing_id: d.listing_id,
        zip: d.zip || "",
        zip3: d.zip3 || "",
        public_title: d.public_title || "",
        public_preview: d.public_preview || "",
        cover_url: d.cover_url || "",
        photo_count: Array.isArray(d.photos) ? d.photos.length : 0,
        publishedAt: d.publishedAt || null,
        updatedAt: d.updatedAt || null,

        beds,
        baths,
        propertyType: draft?.propertyType || "",
        nightlyMin: draft?.nightlyMin ?? null,
        nightlyMax: draft?.nightlyMax ?? null,
        minNights: draft?.minNights ?? null,

        owner: d.userId
          ? {
            id: String(d.userId?._id || ""),
            name: d.userId?.name || "",
            email: d.userId?.email || "",
            phone: d.userId?.phone || "",
          }
          : null,

        in_feed: !!sr,
        feed: sr
          ? {
            zip: sr.zip || "",
            zip3: sr.zip3 || "",
            updatedAt: sr.updatedAt || sr.createdAt || null,
          }
          : null,
      };
    });

    return res.json({
      ok: true,
      range: { days: daysRaw, since },
      total,
      limit,
      skip,
      items,
    });
  } catch (e) {
    console.error("[admin/demand/live_listings] error", e);
    return res.status(500).json({ ok: false, error: e?.message || "Failed to load live listings." });
  }
});

/**
 * Admin: Top queries
 * GET /api/ps/admin/demand/top-queries?days=7&zip3=276&limit=20
 */
router.get("/admin/demand/top-queries", demandAdminAuth, async (req, res) => {
  try {
    const days = clampInt(req.query?.days, 7, 1, 180);
    const limit = clampInt(req.query?.limit, 20, 1, 200);
    const zip3 = sanitizeZip3(req.query?.zip3);
    const since = sinceDays(days);

    const match = {
      createdAt: { $gte: since },
      query: { $ne: null, $ne: "" },
    };
    if (zip3) match.zip3 = zip3;

    const rows = await PSDemandEvent.aggregate([
      { $match: match },
      { $group: { _id: "$query", count: { $sum: 1 } } },
      { $project: { _id: 0, query: "$_id", count: 1 } },
      { $sort: { count: -1 } },
      { $limit: limit },
    ]);

    res.json({ ok: true, range: { days, since }, rows });
  } catch (e) {
    console.error("admin top-queries error:", e);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

/**
 * Admin: Top referrers (uses refHost if present)
 * GET /api/ps/admin/demand/top-referrers?days=7&limit=20
 */
router.get("/admin/demand/top-referrers", demandAdminAuth, async (req, res) => {
  try {
    const days = clampInt(req.query?.days, 7, 1, 180);
    const limit = clampInt(req.query?.limit, 20, 1, 200);
    const since = sinceDays(days);

    const match = { createdAt: { $gte: since } };

    const rows = await PSDemandEvent.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ["$refHost", "direct"] },
          count: { $sum: 1 },
        },
      },
      { $project: { _id: 0, refHost: "$_id", count: 1 } },
      { $sort: { count: -1 } },
      { $limit: limit },
    ]);

    res.json({ ok: true, range: { days, since }, rows });
  } catch (e) {
    console.error("admin top-referrers error:", e);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

/**
 * Admin: Signups / conversion actions
 * GET /api/ps/admin/demand/signups?days=7
 */
router.get("/admin/demand/signups", demandAdminAuth, async (req, res) => {
  try {
    const days = clampInt(req.query?.days, 7, 1, 180);
    const since = sinceDays(days);


    const actions = [
      "otp_request",        // backend logs
      "otp_login_success",  // frontend logs
      "pro_apply_success",  // frontend logs
      "pro_unlock_success", // frontend logs
    ];

    const match = {
      createdAt: { $gte: since },
      action: { $in: actions },
    };

    const [byAction, byDay] = await Promise.all([
      PSDemandEvent.aggregate([
        { $match: match },
        { $group: { _id: "$action", count: { $sum: 1 } } },
        { $project: { _id: 0, action: "$_id", count: 1 } },
        { $sort: { count: -1 } },
      ]),
      PSDemandEvent.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
              action: "$action",
            },
            count: { $sum: 1 },
          },
        },
        { $project: { _id: 0, day: "$_id.day", action: "$_id.action", count: 1 } },
        { $sort: { day: 1, count: -1 } },
      ]),
    ]);

    res.json({ ok: true, range: { days, since }, byAction, byDay });
  } catch (e) {
    console.error("admin signups error:", e);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

router.post("/admin/str/listings/backfill_covers", demandAdminAuth, async (req, res) => {
  try {
    if (!StrListing) return res.status(501).json({ ok: false, error: "model_missing" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const limit = Math.min(Math.max(Number(body.limit || 50), 1), 200);
    const dryRun = !!body.dryRun;
    const publishedOnly = body.publishedOnly !== false; // default true

    const q = {
      $or: [
        { cover_url: { $in: ["", null] } },
        { photos: { $exists: false } },
        { photos: { $size: 0 } },
      ],
    };
    if (publishedOnly) q.published = true;

    const docs = await StrListing.find(q).sort({ updatedAt: -1 }).limit(limit);

    const out = {
      ok: true,
      dryRun,
      limit,
      scanned: docs.length,
      updated: 0,
      skipped: 0,
      failed: 0,
      updated_ids: [],
      skipped_ids: [],
      failed_ids: [],
      errors: [],
    };

    for (const doc of docs) {
      const id = String(doc?.listing_id || "");
      try {
        const existing = pickHeroFromDoc(doc);
        if (existing) {
          out.skipped++;
          out.skipped_ids.push(id);
          continue;
        }

        const cover = await computeCoverFromDraftOrExtract(doc);
        if (!cover) {
          out.failed++;
          out.failed_ids.push(id);
          continue;
        }

        if (!dryRun) {
          doc.cover_url = cover;

          if (!Array.isArray(doc.photos) || doc.photos.length === 0) {
            doc.photos = [{ url: cover, source: "backfill", is_cover: true }];
          } else {
            doc.photos = doc.photos.map((p) => ({ ...p, is_cover: String(p.url || "") === cover }));
          }

          await doc.save();

          // optional: keep housing feed cover synced if exists
          const key = `str_listing|${doc.listing_id}`;
          await ServiceRequest.updateOne(
            { dedupeKey: key },
            { $set: { "fields.coverImageUrl": cover, updatedAt: new Date() } }
          );
        }

        out.updated++;
        out.updated_ids.push(id);
      } catch (e) {
        out.failed++;
        out.failed_ids.push(id);
        out.errors.push({ listing_id: id, error: e?.message || String(e) });
      }
    }

    return res.json(out);
  } catch (e) {
    console.error("[backfill_covers] error", e);
    return res.status(500).json({ ok: false, error: e?.message || "Failed to backfill covers." });
  }
});


module.exports = router;
