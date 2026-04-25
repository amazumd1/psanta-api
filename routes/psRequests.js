const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");

const ServiceRequest = require("../models/ServiceRequest");
const HousingContactRequest = require("../models/HousingContactRequest");
const User = require("../models/User");
const { auth, authOptional } = require("../middleware/auth");


const PCPersona = require("../models/PCPersona");
const PSDemandEvent = require("../models/PSDemandEvent");
const StrListing = require("../models/StrListing");



const router = express.Router();

function classifyServiceType(q = "") {
  const s = String(q).toLowerCase();
  if (/(clean|turnover|maid|housekeep)/.test(s)) return "cleaning";
  if (/(septic|pump out)/.test(s)) return "septic";
  if (/(paint|painter)/.test(s)) return "painter";
  if (/(handyman|repair|fix)/.test(s)) return "handyman";
  if (/(lock|smart lock|keypad)/.test(s)) return "smart_lock";
  if (/(deliver|errand|pickup|drop)/.test(s)) return "delivery";
  if (/(design|staging|interior)/.test(s)) return "design";
  return "other";
}

function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT || "dev_salt_change_me";
  return crypto.createHash("sha256").update(String(ip || "") + "|" + salt).digest("hex");
}

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function sinceDays(days) {
  const d = clampInt(days, 14, 1, 180);
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000);
}

function zip3FromAny(zip) {
  const s = String(zip || "").replace(/[^\d]/g, "").slice(0, 3);
  return s.length === 3 ? s : "";
}

function normalizeSeekAtom(v) {
  return String(v || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildHousingSeekKey({ zip = "", fields = null, query = "" } = {}) {
  const f = fields && typeof fields === "object" ? fields : {};
  const z = String(zip || "").replace(/[^\d]/g, "").slice(0, 5);

  return [
    z,
    normalizeSeekAtom(String(f?.want || "").replace(/_/g, " ")),
    normalizeSeekAtom(f?.beds),
    normalizeSeekAtom(f?.budget),
    normalizeSeekAtom(f?.moveIn),
    normalizeSeekAtom(f?.duration),
    normalizeSeekAtom(f?.people),
    normalizeSeekAtom(f?.notes || query),
  ].join("|");
}

function personaTrustScore(p) {
  if (!p || typeof p !== "object") return 0;

  const reviews = Number(p.externalReviewCount || 0) || 0;
  const jobs = Number(p.jobsCount || 0) || 0;
  const matches = Number(p.matchCount || 0) || 0;
  const tags = Array.isArray(p.focusTags) ? p.focusTags.length : 0;

  return (
    (p.kind === "renter" ? 24 : p.kind === "landlord" ? 20 : p.kind === "pro" ? 16 : 8) +
    (p.isActive ? 10 : 0) +
    (p.verified ? 8 : 0) +
    Math.min(12, Math.floor(reviews / 5)) +
    Math.min(6, Math.floor(jobs / 3)) +
    Math.min(4, Math.floor(matches / 5)) +
    Math.min(3, tags)
  );
}

function pickBestPersona(rows = []) {
  let best = null;
  let bestScore = -1;

  for (const r of Array.isArray(rows) ? rows : []) {
    const score = personaTrustScore(r);
    if (!best || score > bestScore) {
      best = r;
      bestScore = score;
    }
  }

  return best;
}

// map pro skills → serviceType (best effort)
function skillToServiceType(skill = "") {
  const s = String(skill).toLowerCase();
  if (/(clean|turnover|maid|housekeep)/.test(s)) return "cleaning";
  if (/(septic|pump)/.test(s)) return "septic";
  if (/(paint|painter)/.test(s)) return "painter";
  if (/(handyman|repair|fix)/.test(s)) return "handyman";
  if (/(lock|smart lock|keypad)/.test(s)) return "smart_lock";
  if (/(deliver|errand|pickup|drop)/.test(s)) return "delivery";
  if (/(design|staging|interior)/.test(s)) return "design";
  return null;
}


function getClientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.ip || req.connection?.remoteAddress || "";
}

// function hasAnyAuthToken(req) {
//   const h = String(req.headers?.authorization || req.headers?.Authorization || "");
//   if (/^Bearer\s+/i.test(h)) return true;

//   const raw = String(req.headers?.cookie || "");
//   return /(?:^|;\s*)(cp_jwt|authToken|token)=/i.test(raw);
// }

// Optional auth: token ho to attach user; token na ho to anonymous allow
// function optionalAuth(req, res, next) {
//   if (!hasAnyAuthToken(req)) return next();
//   return auth(req, res, next);
// }


function maskEmail(email = "") {
  const e = String(email || "").trim();
  const [u, d] = e.split("@");
  if (!u || !d) return "";
  if (u.length <= 2) return `${u[0] || "*"}*@${d}`;
  return `${u.slice(0, 2)}***@${d}`;
}

function maskPhone(phone = "") {
  const p = String(phone || "").replace(/[^\d]/g, "");
  if (p.length < 7) return "";
  return `***-***-${p.slice(-4)}`;
}

function isObjId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || "").trim());
}

function clampMinutes(v, def = 30, min = 5, max = 120) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function safeText(v, max = 600) {
  const s = String(v || "").trim();
  return s ? s.slice(0, max) : "";
}

// -------------------- Part 6: Anti-fraud / penalties (MVP) --------------------
const PS_LIMITS = {
  REQ_PER_HOUR: 5,              // requester contact requests per hour
  UNIQUE_POSTS_10M: 4,          // requester hitting many different posts quickly
  PENDING_PER_DAY: 10,          // too many pending requests
  UNLOCKS_PER_HOUR: 10,         // owner unlocks per hour
  UNLOCKS_PER_DAY: 30,          // owner unlocks per day
  DENIES_PER_DAY: 3,            // requester denied too often => cooldown
};

const PS_PENALTIES = {
  REQUEST_SPAM_MIN: 120,        // 2 hours
  CONTACT_LEAK_MIN: 120,        // 2 hours (trying to bypass handshake)
  OWNER_UNLOCK_SPAM_MIN: 30,    // 30 min cooldown (optional; we mostly rate-limit)
};

function looksLikeContactLeak(text = "") {
  const s = String(text || "").trim();
  if (!s) return false;

  // links
  if (/(https?:\/\/|www\.)/i.test(s)) return true;

  // email
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(s)) return true;

  // phone-ish: 9+ digits total
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length >= 9) return true;

  return false;
}

// Part 5: even if we hide contact fields at top-level,
// the wizard also stores some of them under `fields`.
function redactHousingFields(fields) {
  if (!fields || typeof fields !== "object") return fields || null;
  const f = { ...(fields || {}) };
  delete f.email;
  delete f.phone;
  delete f.addressText;
  delete f.contactEmail;
  delete f.contactPhone;
  delete f.ownerContact;
  return f;
}

async function logPSEvent(req, action, meta = {}) {
  try {
    await PSDemandEvent.create({
      action,
      tab: "housing",
      zip: meta.zip || "",
      zip3: meta.zip3 || "",
      query: meta.query || "",
      source: "api",
      userId: meta.userId ? String(meta.userId) : (req.userId ? String(req.userId) : ""),
      ipHash: hashIp(getClientIp(req)),
      ua: String(req.headers["user-agent"] || "").slice(0, 220),
      meta,
    });
  } catch {
    // do not break main flow if logging fails
  }
}

async function applyCooldown(userId, minutes, req, reason, meta = {}) {
  const until = new Date(Date.now() + Number(minutes) * 60 * 1000);

  try {
    await User.updateOne(
      { _id: userId },
      { $set: { unlockLockedUntil: until } }
    );
  } catch { }

  await logPSEvent(req, "ps_penalty", {
    ...meta,
    reason,
    minutes,
    cooldown_until: until.toISOString(),
    userId: String(userId),
  });

  return until;
}




router.post("/requests", authOptional, async (req, res) => {
  try {
    const {
      zip,
      state = "",
      tab = "services",
      query,
      addressText = "",
      email = "",
      phone = "",
      fields = null,
      beds = 0,
      baths = 0,
      sqft = 0,
      date = "",
      reason = "",
      source = "frontPage",
      serviceType,
      intent = "",
      budgetMax = 0,
    } = req.body || {};


    const z = String(zip || "").replace(/[^\d]/g, "").slice(0, 5);
    const q = String(query || "").trim().slice(0, 300);

    if (!z || z.length < 3) return res.status(400).json({ ok: false, message: "zip required" });
    if (!q) return res.status(400).json({ ok: false, message: "query required" });

    const st = serviceType || classifyServiceType(q);
    const meId = req.userId || req.user?.userId || req.user?._id;

    const normalizedFields = fields && typeof fields === "object" ? { ...fields } : null;

    // strong renter dedupe: same user + same renter need should not create duplicates
    if (st === "housing_seek" && meId) {
      const seekKey = buildHousingSeekKey({
        zip: z,
        fields: normalizedFields,
        query: q,
      });

      if (normalizedFields) normalizedFields._seekKey = seekKey;

      const existingSeek = await ServiceRequest.findOne({
        userId: meId,
        serviceType: "housing_seek",
        zip: z,
        "fields._seekKey": seekKey,
        createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      })
        .sort({ createdAt: -1 })
        .lean();

      if (existingSeek) {
        return res.json({ ok: true, deduped: true, id: String(existingSeek._id) });
      }
    }

    // generic dedupe last 10 min per (zip + tab + normalized query)
    const dedupeKey = `${z}|${String(tab || "services")}|${q.toLowerCase()}`;
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);

    const existing = await ServiceRequest.findOne({
      dedupeKey,
      createdAt: { $gte: tenMinAgo },
    }).lean();

    if (existing) {
      return res.json({ ok: true, deduped: true, id: String(existing._id) });
    }

    const doc = await ServiceRequest.create({
      zip3: zip3FromAny(z),
      zip: z,
      state: String(state || "").slice(0, 10),
      tab: String(tab || "services").slice(0, 30),
      query: q,
      serviceType: st,
      intent: String(intent || "").slice(0, 16),
      budgetMax: Number(budgetMax) || 0,
      addressText: String(addressText || "").slice(0, 200),
      contactEmail: String(email || "").slice(0, 120),
      contactPhone: String(phone || "").slice(0, 40),
      fields: normalizedFields,


      beds: Number(beds) || 0,
      baths: Number(baths) || 0,
      sqft: Number(sqft) || 0,
      date: String(date || "").slice(0, 20),

      // if your auth middleware sets req.user:

      userId: req.userId || req.user?.userId || req.user?._id,
      userEmail: req.userDoc?.email || req.user?.email || "",
      ipHash: hashIp(getClientIp(req)),


      source: String(source || "frontPage").slice(0, 30),
      reason: String(reason || "").slice(0, 60),
      dedupeKey,
    });

    return res.json({ ok: true, id: String(doc._id) });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

router.get("/requests/:id([0-9a-fA-F]{24})", authOptional, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, message: "id required" });

    const doc = await ServiceRequest.findById(id).lean();
    if (!doc) return res.status(404).json({ ok: false, message: "Not found" });

    const meId = req.userId || req.user?.userId || req.user?._id || null;
    const isOwner = meId && doc.userId && String(doc.userId) === String(meId);

    // simple “stage” derivation (MVP)
    const zip3 = String(doc.zip || "").slice(0, 3);
    const proCount = zip3
      ? await PCPersona.countDocuments({
        kind: "pro",
        isActive: true,
        zip: new RegExp("^" + zip3),
        $or: [{ activeUntil: null }, { activeUntil: { $gt: new Date() } }],
      })
      : 0;

    const contacted = (doc.responses && doc.responses.length) || (doc.contactedBy && doc.contactedBy.length);
    const status = contacted ? "contacted" : proCount > 0 ? "matching" : "received";

    // public-safe response by default
    const publicView = String(req.query.public || "") === "1" || !isOwner;

    const isHousingPost = /^housing_/.test(String(doc.serviceType || ""));

    // public view me bhi housing/STR listing ke safe fields milne chahiye
    const safeFields = isHousingPost
      ? redactHousingFields(doc.fields)
      : (publicView ? null : (doc.fields || null));

    const safePhotoUrls = Array.isArray(safeFields?.photo_urls)
      ? safeFields.photo_urls
      : Array.isArray(safeFields?.photoUrls)
        ? safeFields.photoUrls
        : Array.isArray(safeFields?.photos)
          ? safeFields.photos
          : Array.isArray(safeFields?.images)
            ? safeFields.images
            : [];

    const safeCover = String(
      safeFields?.cover_url ||
      safeFields?.coverUrl ||
      safeFields?.coverImageUrl ||
      safeFields?.cover_image_url ||
      safeFields?.coverImage ||
      safePhotoUrls?.[0] ||
      ""
    ).trim();

    const safeReferenceId = String(
      safeFields?.referenceId ||
      safeFields?.reference_id ||
      safeFields?.listing_id ||
      safeFields?.strListingId ||
      safeFields?.str_listing_id ||
      ""
    ).trim();

    const safeTitle = String(
      safeFields?.public_title ||
      safeFields?.publicTitle ||
      safeFields?.headline ||
      safeFields?.title ||
      doc.query ||
      ""
    ).trim();

    const safePreview = String(
      safeFields?.public_preview ||
      safeFields?.publicPreview ||
      safeFields?.description ||
      ""
    ).trim();

    const safeType = String(
      safeFields?.propertyType ||
      safeFields?.type ||
      ""
    ).trim();

    const safeRent = String(
      safeFields?.rent ||
      safeFields?.price ||
      ""
    ).trim();

    const out = {
      _id: doc._id,
      id: String(doc._id),

      zip: doc.zip,
      state: doc.state || "",
      city: safeFields?.city || "",
      tab: doc.tab || "",

      query: doc.query,
      title: safeTitle || doc.query || "",
      public_title: safeTitle || "",
      publicTitle: safeTitle || "",

      serviceType: doc.serviceType || "other",
      active: doc.active !== false,
      intent: doc.intent || "",
      budgetMax: Number(doc.budgetMax) || 0,

      beds: doc.beds || 0,
      baths: doc.baths || 0,
      sqft: doc.sqft || 0,
      date: doc.date || "",

      // keep old behavior, but public card info should come from city/state/title mostly
      addressText: publicView && isHousingPost ? "" : (doc.addressText || ""),

      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      status,
      matchCount: proCount,
      lastContactedAt: doc.lastContactedAt || null,

      // public-safe housing/STR metadata
      fields: safeFields,
      dedupeKey: doc.dedupeKey || "",

      referenceId: safeReferenceId,
      listing_id: safeReferenceId,
      strListingId: safeReferenceId,

      type: safeType,
      rent: safeRent,

      public_preview: safePreview,
      publicPreview: safePreview,
      description: safePreview,

      cover_url: safeCover,
      coverUrl: safeCover,
      coverImageUrl: safeCover,

      photo_urls: safePhotoUrls,
      photoUrls: safePhotoUrls,
      photo_urls_text: Array.isArray(safePhotoUrls) ? safePhotoUrls.join("\n") : "",

      // only show responses to owner
      responses: publicView ? [] : (doc.responses || []),
    };

    return res.json({ ok: true, request: out });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

/* ------------------------------------------------------------------
 * Owner dashboard helpers
 * - lists the authenticated user's own posts
 * - updates/pause/unpause a post
 * ------------------------------------------------------------------ */

function normalizeMineRow(d) {
  const zip3 = d.zip3 || zip3FromAny(d.zip);
  return {
    _id: d._id,
    id: String(d._id),
    post_id: String(d._id),

    zip: d.zip,
    zip3,
    state: d.state || "",
    tab: d.tab || "",

    query: d.query,
    serviceType: d.serviceType || "other",
    intent: d.intent || "",
    budgetMax: Number(d.budgetMax) || 0,

    beds: d.beds || 0,
    baths: d.baths || 0,
    sqft: d.sqft || 0,
    date: d.date || "",

    addressText: d.addressText || "",
    contactEmail: d.contactEmail || "",
    contactPhone: d.contactPhone || "",
    fields: d.fields || null,

    active: d.active !== false,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

async function listMine(req, res, { housingOnly = false } = {}) {
  const meId = req.userId || req.user?.userId || req.user?._id;
  if (!meId) return res.status(401).json({ ok: false, message: "Not authenticated" });

  const limit = clampInt(req.query?.limit, 100, 1, 300);

  const q = { userId: meId };

  const st = String(req.query?.serviceType || "").trim();

  if (housingOnly) {
    const allowedHousingTypes = new Set(["housing_listing", "housing_seek"]);

    if (st && allowedHousingTypes.has(st)) {
      q.serviceType = st;
    } else {
      q.serviceType = { $in: Array.from(allowedHousingTypes) };
    }
  } else if (st) {
    q.serviceType = st;
  }

  const docs = await ServiceRequest.find(q).sort({ createdAt: -1 }).limit(limit).lean();
  return res.json({ ok: true, items: (docs || []).map(normalizeMineRow) });
}

// ✅ My posts (dashboard)
router.get("/requests/mine", auth, async (req, res) => {
  try {
    return await listMine(req, res);
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

// legacy alias
router.get("/requests/my", auth, async (req, res) => {
  try {
    return await listMine(req, res);
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

// extra fallbacks used by some frontends
router.get("/housing/posts/mine", auth, async (req, res) => {
  try {
    return await listMine(req, res, { housingOnly: true });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

router.get("/housing/my_posts", auth, async (req, res) => {
  try {
    return await listMine(req, res, { housingOnly: true });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

async function handleUpdatePost(req, res) {
  const meId = req.userId || req.user?.userId || req.user?._id;
  if (!meId) return res.status(401).json({ ok: false, message: "Not authenticated" });

  const postId = String(
    req.body?.post_id || req.body?.postId || req.body?.request_id || req.body?.id || ""
  ).trim();

  if (!isObjId(postId)) return res.status(400).json({ ok: false, message: "post_id invalid" });

  const doc = await ServiceRequest.findById(postId);
  if (!doc) return res.status(404).json({ ok: false, message: "Not found" });
  if (!doc.userId || String(doc.userId) !== String(meId)) {
    return res.status(403).json({ ok: false, message: "Forbidden" });
  }

  // Patch fields (only when provided)
  if (req.body?.query !== undefined) {
    doc.query = String(req.body.query || "").trim().slice(0, 800);
  }

  const bedsRaw = req.body?.beds;
  const bathsRaw = req.body?.baths;
  const rentRaw = req.body?.rent;

  if (bedsRaw !== undefined) {
    const n = Number(String(bedsRaw).replace(/[^0-9.]/g, ""));
    doc.beds = Number.isFinite(n) ? n : 0;
  }
  if (bathsRaw !== undefined) {
    const n = Number(String(bathsRaw).replace(/[^0-9.]/g, ""));
    doc.baths = Number.isFinite(n) ? n : 0;
  }

  if (req.body?.addressText !== undefined) {
    doc.addressText = String(req.body.addressText || "").trim().slice(0, 200);
  }

  if (req.body?.active !== undefined) {
    doc.active = !!req.body.active;
  }

  // Keep wizard payload in-sync (most UI reads from fields)
  if (!doc.fields || typeof doc.fields !== "object") doc.fields = {};

  // ✅ allow safe merge from req.body.fields (MVP allowlist)
  const incomingFields = (req.body?.fields && typeof req.body.fields === "object") ? req.body.fields : null;

  // --- Archive toggle (soft hide) ---
  const archRaw =
    req.body?.archived ??
    incomingFields?.archived ??
    incomingFields?.isArchived;

  if (archRaw !== undefined) {
    const arch = !!archRaw;
    doc.fields.archived = arch;
    doc.fields.isArchived = arch;

    // Archived ads should not be active
    if (arch) doc.active = false;
  }

  // --- Photos / cover (so Edit works too) ---
  const coverRaw =
    req.body?.cover_url ??
    req.body?.coverUrl ??
    incomingFields?.cover_url ??
    incomingFields?.coverUrl ??
    incomingFields?.coverImageUrl ??
    incomingFields?.cover_image_url ??
    incomingFields?.coverImage ??
    incomingFields?.cover;

  if (coverRaw !== undefined) {
    const s = String(coverRaw || "").trim().slice(0, 600);
    if (s) {
      doc.fields.cover_url = s;
      doc.fields.coverUrl = s;
      doc.fields.coverImageUrl = s;
    }
  }

  const photosRaw =
    req.body?.photo_urls ??
    req.body?.photoUrls ??
    incomingFields?.photo_urls ??
    incomingFields?.photoUrls ??
    incomingFields?.photos ??
    incomingFields?.images;

  if (photosRaw !== undefined) {
    let urls = [];
    if (Array.isArray(photosRaw)) {
      urls = photosRaw
        .map((x) => (typeof x === "string" ? x : (x?.url || x?.src || x?.href || "")))
        .map((x) => String(x || "").trim())
        .filter(Boolean);
    } else if (typeof photosRaw === "string") {
      urls = String(photosRaw).split(/\s+/).map((x) => x.trim()).filter(Boolean);
    }

    urls = urls.slice(0, 24);

    doc.fields.photo_urls = urls;
    doc.fields.photoUrls = urls;
    doc.fields.photos = urls;
    doc.fields.images = urls;
  }

  if (bedsRaw !== undefined) doc.fields.beds = doc.beds;
  if (bathsRaw !== undefined) doc.fields.baths = doc.baths;
  if (req.body?.addressText !== undefined) doc.fields.addressText = doc.addressText;

  if (rentRaw !== undefined) {
    const n = Number(String(rentRaw).replace(/[^0-9.]/g, ""));
    const val = Number.isFinite(n) ? n : 0;

    // listing uses rent; seeker uses budget
    if (String(doc.serviceType || "") === "housing_seek") {
      doc.fields.budget = val;
    } else {
      doc.fields.rent = val;
    }
  }

  doc.markModified("fields");
  await doc.save();

  await logPSEvent(req, "ps_post_updated", {
    postId: String(doc._id),
    serviceType: doc.serviceType,
    userId: String(meId),
  });

  return res.json({ ok: true, updated: true, post: normalizeMineRow(doc.toObject()) });
}

async function handleDeletePost(req, res) {
  try {
    const meId = req.userId || req.user?.userId || req.user?._id;
    const postId = String(req.params?.id || req.body?.post_id || req.body?.postId || "").trim();

    if (!meId) return res.status(401).json({ ok: false, message: "Not authenticated" });
    if (!mongoose.Types.ObjectId.isValid(String(postId))) {
      return res.status(400).json({ ok: false, message: "post_id invalid" });
    }

    const doc = await ServiceRequest.findById(postId);
    if (!doc) return res.status(404).json({ ok: false, message: "Not found" });

    const ownerId = doc.userId ? String(doc.userId) : "";
    if (!ownerId || ownerId !== String(meId)) {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }

    const fields = (doc.fields && typeof doc.fields === "object") ? doc.fields : {};
    const kind = String(fields.kind || "").toLowerCase();
    const refType = String(fields.referenceType || "").toLowerCase();
    const isStr = kind === "str_listing" || refType === "str_listing";

    const listingId = String(
      fields.referenceId || fields.referenceID || fields.listing_id || fields.listingId || ""
    ).trim();

    // delete contact requests tied to this post (best effort)
    HousingContactRequest.deleteMany({ postId: doc._id }).catch(() => { });

    await ServiceRequest.deleteOne({ _id: doc._id });

    // if this post is STR-backed, also delete STR listing row so it disappears from ZIP feed
    let strDeleted = false;
    if (isStr && listingId && StrListing) {
      try {
        const r = await StrListing.deleteOne({
          listing_id: listingId,
          $or: [{ userId: meId }, { userId: null }, { userId: { $exists: false } }],
        });
        strDeleted = (r?.deletedCount || 0) > 0;
      } catch { }
    }

    return res.json({
      ok: true,
      deleted: true,
      post_id: postId,
      str_deleted: strDeleted,
      listing_id: listingId || "",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
}

// DELETE /api/ps/housing/posts/:id
router.delete("/housing/posts/:id([0-9a-fA-F]{24})", auth, async (req, res) => {
  return handleDeletePost(req, res);
});

// Alias: DELETE /api/ps/requests/:id
router.delete("/requests/:id([0-9a-fA-F]{24})", auth, async (req, res) => {
  return handleDeletePost(req, res);
});

router.post("/requests/update", auth, async (req, res) => {
  try {
    return await handleUpdatePost(req, res);
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

// extra fallbacks used by some frontends
router.post("/housing/posts/update", auth, async (req, res) => {
  try {
    return await handleUpdatePost(req, res);
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

router.post("/housing/post/update", auth, async (req, res) => {
  try {
    return await handleUpdatePost(req, res);
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});


/**
 * Pro Leads (MVP)
 * GET /api/ps/leads?days=14&limit=20
 * - requires auth
 * - pro profile must be active
 * - pulls ServiceRequest rows from same ZIP3 (and filters by serviceType if skills present)
 */
router.get("/leads", auth, async (req, res) => {
  try {
    const meId = req.userId || req.user?.userId || req.user?._id;
    if (!meId) return res.status(401).json({ ok: false, message: "Not authenticated" });

    const persona = await PCPersona.findOne({
      userId: meId,
      kind: "pro",
      isActive: true,
      $or: [{ activeUntil: null }, { activeUntil: { $gt: new Date() } }],
    }).lean();

    if (!persona) {
      return res.status(403).json({ ok: false, message: "Pro profile not active." });
    }

    const days = clampInt(req.query?.days, 14, 1, 180);
    const limit = clampInt(req.query?.limit, 20, 1, 50);
    const since = sinceDays(days);

    const zip3 = zip3FromAny(persona.zip);
    if (!zip3) return res.json({ ok: true, zip3: "", range: { days, since }, rows: [] });

    // optional: filter leads by pro skills → serviceType
    const stSet = new Set(
      (persona.skills || [])
        .map(skillToServiceType)
        .filter(Boolean)
    );

    const match = {
      createdAt: { $gte: since },
      zip: new RegExp("^" + zip3),
    };

    // strict=1 => only matched service types
    // default => show matched + "other" (so pros also see general requests)
    const strict = String(req.query?.strict || "") === "1";
    if (stSet.size) {
      const types = strict
        ? Array.from(stSet)
        : Array.from(new Set([...Array.from(stSet), "other"]));
      match.serviceType = { $in: types };
    }

    const docs = await ServiceRequest.find(match)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const rows = (docs || []).map((d) => {
      const contacted = Array.isArray(d.contactedBy)
        ? d.contactedBy.some((id) => String(id) === String(meId))
        : false;

      const replied = Array.isArray(d.responses)
        ? d.responses.some((x) => String(x.proId) === String(meId))
        : false;

      const extra = (d.fields && typeof d.fields === "object") ? d.fields : {};
      return {
        _id: d._id,              // keep if frontend expects _id
        id: String(d._id),       // keep for pwsh script fallback
        zip: d.zip,
        serviceType: d.serviceType,
        query: d.query,
        createdAt: d.createdAt,
        contacted,
        replied,
        fields: {
          ...extra,
          beds: d.beds || 0,
          baths: d.baths || 0,
          sqft: d.sqft || 0,
          date: d.date || "",
          state: d.state || "",
          tab: d.tab || "",
        },
      };
    });

    return res.json({ ok: true, zip3, range: { days, since }, rows });


  } catch (e) {
    console.error("ps/leads error:", e?.stack || e);
    return res.status(500).json({ ok: false, message: e?.message || "Server error" });
  }

});

// Mark contacted
router.post("/leads/:id/contacted", auth, async (req, res) => {
  try {
    const meId = req.userId || req.user?.userId || req.user?._id;
    if (!meId) return res.status(401).json({ ok: false, message: "Not authenticated" });

    const id = req.params.id;
    const now = new Date();

    await ServiceRequest.updateOne(
      { _id: id },
      { $addToSet: { contactedBy: meId }, $set: { lastContactedAt: now } }
    );

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

// Reply endpoint
router.post("/leads/:id/reply", auth, async (req, res) => {
  try {
    const meId = req.userId || req.user?.userId || req.user?._id;
    if (!meId) return res.status(401).json({ ok: false, message: "Not authenticated" });

    const id = req.params.id;
    const message = String(req.body?.message || "").trim().slice(0, 1200);
    if (!message) return res.status(400).json({ ok: false, message: "message required" });

    const now = new Date();

    // update existing reply if exists
    const upd = await ServiceRequest.updateOne(
      { _id: id, "responses.proId": meId },
      {
        $set: {
          "responses.$.message": message,
          "responses.$.updatedAt": now,
          lastContactedAt: now,
        },
        $addToSet: { contactedBy: meId },
      }
    );

    if (!upd.matchedCount) {
      await ServiceRequest.updateOne(
        { _id: id },
        {
          $push: { responses: { proId: meId, message, createdAt: now, updatedAt: now } },
          $set: { lastContactedAt: now },
          $addToSet: { contactedBy: meId },
        }
      );
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});



// Optional: admin stats (later OMD)
router.get("/requests/stats", async (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, Number(req.query.days || 30)));
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await ServiceRequest.aggregate([
      { $match: { createdAt: { $gte: from } } },
      { $group: { _id: { zip: "$zip", serviceType: "$serviceType" }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 200 },
    ]);

    res.json({ ok: true, days, rows });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

router.get("/housing/listings", authOptional, async (req, res) => {
  try {
    const zip3 = zip3FromAny(req.query.zip3 || req.query.zip || "");
    if (!zip3) return res.status(400).json({ ok: false, message: "zip or zip3 required" });

    const days = clampInt(req.query.days, 30, 1, 180);
    const since = sinceDays(days);

    // harden renter feed: if any published STR listing missed ServiceRequest mirror,
    // backfill it here before returning listings
    try {
      const strRows = await StrListing.find({
        zip3,
        published: true,
        $or: [
          { publishedAt: { $gte: since } },
          { updatedAt: { $gte: since } },
        ],
      })
        .select("listing_id userId zip zip3 state draft public_title public_preview cover_url photos publishedAt createdAt")
        .limit(100)
        .lean();

      for (const d of strRows || []) {
        const listingId = String(d?.listing_id || "").trim();
        if (!listingId) continue;

        const key = `str_listing|${listingId}`;
        const draft = d?.draft && typeof d.draft === "object" ? d.draft : {};

        const srZip = String(d?.zip || "").replace(/[^\d]/g, "").slice(0, 5) || zip3;
        const srZip3 = zip3FromAny(d?.zip3 || srZip || zip3);
        if (!srZip3) continue;

        const bedsN = Number(draft?.beds || draft?.bedrooms || 0) || 0;
        const bathsN = Number(draft?.baths || draft?.bathrooms || 0) || 0;

        const city = String(draft?.locationHint?.city || "").trim();
        const stCode = String(draft?.locationHint?.state || d?.state || "").trim();
        const addressText = [city, stCode].filter(Boolean).join(", ");

        const photoUrls = Array.isArray(d?.photos)
          ? d.photos
            .map((p) => (typeof p === "string" ? p : (p?.url || p?.src || p?.href || "")))
            .map((u) => String(u || "").trim())
            .filter(Boolean)
            .slice(0, 24)
          : [];

        await ServiceRequest.updateOne(
          { dedupeKey: key },
          {
            $setOnInsert: {
              dedupeKey: key,
              serviceType: "housing_listing",
              tab: "housing",
              intent: "offer",
              source: "psStr",
              reason: "str_feed_autofix",
              createdAt: d?.publishedAt || d?.createdAt || new Date(),
            },
            $set: {
              ...(d?.userId ? { userId: d.userId } : {}),
              active: true,
              zip: srZip,
              zip3: srZip3,
              state: stCode,
              query: safeText(
                d?.public_title || draft?.title || draft?.headline || "Short-term rental listing",
                300
              ),
              addressText: safeText(addressText, 120),
              beds: bedsN,
              baths: bathsN,
              fields: {
                kind: "str_listing",
                referenceId: listingId,
                listing_id: listingId,
                referenceType: "str_listing",

                cover_url: d?.cover_url || "",
                coverUrl: d?.cover_url || "",
                coverImageUrl: d?.cover_url || "",

                photo_urls: photoUrls,
                photoUrls: photoUrls,

                public_title: d?.public_title || "",
                public_preview: d?.public_preview || "",
                propertyType: draft?.propertyType || "",
                nightlyMin: draft?.nightlyMin ?? null,
                nightlyMax: draft?.nightlyMax ?? null,
                minNights: draft?.minNights ?? null,
                amenities: Array.isArray(draft?.amenities) ? draft.amenities : [],
                source: "str_ai",
              },
              updatedAt: new Date(),
            },
          },
          { upsert: true, runValidators: true }
        );
      }
    } catch (feedErr) {
      console.warn("housing/listings autofeed failed:", feedErr?.message || feedErr);
    }

    const rows = await ServiceRequest.find({
      serviceType: "housing_listing",
      active: { $ne: false },
      createdAt: { $gte: since },
      $or: [{ zip3 }, { zip: new RegExp("^" + zip3) }],
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const meId = req.userId || req.user?.userId || req.user?._id || null;

    const items = rows.map((r) => {
      const isMine = Boolean(meId && r.userId && String(r.userId) === String(meId));

      return {
        id: String(r._id),
        post_id: String(r._id),

        zip: r.zip,
        zip3: r.zip3 || zip3FromAny(r.zip),
        query: r.query,

        addressText: isMine ? (r.addressText || "") : "",

        beds: r.beds || 0,
        baths: r.baths || 0,
        sqft: r.sqft || 0,
        date: r.date || "",

        // ✅ IMPORTANT: prevent leaking contact via fields
        fields: isMine ? (r.fields || null) : redactHousingFields(r.fields),

        contactEmail: isMine ? (r.contactEmail || "") : "",
        contactPhone: isMine ? (r.contactPhone || "") : "",

        ownerId: r.userId ? String(r.userId) : "",
        isMine,
        active: r.active !== false,

        createdAt: r.createdAt,
      };
    });



    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

router.get("/housing/seekers", authOptional, async (req, res) => {
  try {
    const zip3 = zip3FromAny(req.query.zip3 || req.query.zip || "");
    if (!zip3) return res.status(400).json({ ok: false, message: "zip or zip3 required" });

    const days = clampInt(req.query.days, 30, 1, 180);
    const since = sinceDays(days);

    const rows = await ServiceRequest.find({
      serviceType: "housing_seek",
      active: { $ne: false },
      createdAt: { $gte: since },
      $or: [{ zip3 }, { zip: new RegExp("^" + zip3) }],
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const meId = req.userId || req.user?.userId || req.user?._id || null;

    const items = rows.map((r) => {
      const isMine = Boolean(meId && r.userId && String(r.userId) === String(meId));

      return {
        id: String(r._id),
        post_id: String(r._id),

        zip: r.zip,
        zip3: r.zip3 || zip3FromAny(r.zip),
        query: r.query,

        // ✅ IMPORTANT: prevent leaking contact via fields
        fields: isMine ? (r.fields || null) : redactHousingFields(r.fields),

        contactEmail: isMine ? (r.contactEmail || "") : "",
        contactPhone: isMine ? (r.contactPhone || "") : "",

        ownerId: r.userId ? String(r.userId) : "",
        isMine,
        active: r.active !== false,

        createdAt: r.createdAt,
      };
    });



    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

/**
 * Part 5 — Housing privacy unlock handshake
 *
 * POST /api/ps/housing/contact/request
 * GET  /api/ps/housing/contact/request/:request_id
 * GET  /api/ps/housing/contact/inbox?zip3=276
 * POST /api/ps/housing/contact/unlock
 */

// requester -> owner (requires auth)
router.post("/housing/contact/request", auth, async (req, res) => {
  try {
    const meId = req.userId || req.user?.userId || req.user?._id;
    const postId = String(req.body?.post_id || req.body?.postId || "").trim();
    const zip3 = zip3FromAny(req.body?.zip3 || req.body?.zip || "");
    const message = safeText(req.body?.message || "", 1200);

    if (!meId) return res.status(401).json({ ok: false, message: "Not authenticated" });
    if (!isObjId(postId)) return res.status(400).json({ ok: false, message: "post_id invalid" });

    // optional anti-spam lockout (uses User.unlockLockedUntil)
    const me = await User.findById(meId).select("_id email name psCooldownUntil").lean();
    if (!me) return res.status(401).json({ ok: false, message: "User not found" });

    if (me.psCooldownUntil && new Date(me.psCooldownUntil).getTime() > Date.now()) {
      return res.status(429).json({
        ok: false,
        message: `Temporarily locked. Try again after ${new Date(me.psCooldownUntil).toISOString()}`,
      });
    }



    // --- Part 6: block attempts to share contact in message (bypass handshake)
    if (looksLikeContactLeak(message)) {
      const until = await applyCooldown(meId, PS_PENALTIES.CONTACT_LEAK_MIN, req, "contact_leak_attempt", {
        zip3,
        postId,
        msgPreview: String(message || "").slice(0, 120),
      });

      return res.status(400).json({
        ok: false,
        message: `Please don't share phone/email/links in the message. Use unlock flow. Locked until ${until.toISOString()}`,
        cooldown_until: until.toISOString(),
      });
    }

    // --- Part 6: requester rate-limits
    const nowMs = Date.now();
    const hourAgo = new Date(nowMs - 60 * 60 * 1000);
    const dayAgo = new Date(nowMs - 24 * 60 * 60 * 1000);
    const tenMinAgo = new Date(nowMs - 10 * 60 * 1000);

    const reqHour = await HousingContactRequest.countDocuments({
      requesterId: meId,
      createdAt: { $gte: hourAgo },
    });
    if (reqHour >= PS_LIMITS.REQ_PER_HOUR) {
      const until = await applyCooldown(meId, PS_PENALTIES.REQUEST_SPAM_MIN, req, "req_per_hour", {
        zip3,
        postId,
        reqHour,
      });
      await logPSEvent(req, "housing_contact_request_blocked", { zip3, postId, reqHour, reason: "REQ_PER_HOUR" });

      return res.status(429).json({
        ok: false,
        message: `Too many contact requests. Locked until ${until.toISOString()}`,
        cooldown_until: until.toISOString(),
      });
    }

    const pendingDay = await HousingContactRequest.countDocuments({
      requesterId: meId,
      status: "pending",
      createdAt: { $gte: dayAgo },
    });
    if (pendingDay >= PS_LIMITS.PENDING_PER_DAY) {
      const until = await applyCooldown(meId, PS_PENALTIES.REQUEST_SPAM_MIN, req, "too_many_pending", {
        zip3,
        postId,
        pendingDay,
      });
      await logPSEvent(req, "housing_contact_request_blocked", { zip3, postId, pendingDay, reason: "PENDING_PER_DAY" });

      return res.status(429).json({
        ok: false,
        message: `Too many pending requests. Locked until ${until.toISOString()}`,
        cooldown_until: until.toISOString(),
      });
    }

    const uniqPosts10m = await HousingContactRequest.distinct("postId", {
      requesterId: meId,
      createdAt: { $gte: tenMinAgo },
    });
    if (Array.isArray(uniqPosts10m) && uniqPosts10m.length >= PS_LIMITS.UNIQUE_POSTS_10M) {
      const until = await applyCooldown(meId, PS_PENALTIES.REQUEST_SPAM_MIN, req, "spray_many_posts_10m", {
        zip3,
        postId,
        uniqPosts10m: uniqPosts10m.length,
      });
      await logPSEvent(req, "housing_contact_request_blocked", {
        zip3,
        postId,
        uniqPosts10m: uniqPosts10m.length,
        reason: "UNIQUE_POSTS_10M",
      });

      return res.status(429).json({
        ok: false,
        message: `Too many different posts requested quickly. Locked until ${until.toISOString()}`,
        cooldown_until: until.toISOString(),
      });
    }


    const post = await ServiceRequest.findById(postId).lean();
    if (!post) return res.status(404).json({ ok: false, message: "Post not found" });

    if (!/(^housing_)/.test(String(post.serviceType || ""))) {
      return res.status(400).json({ ok: false, message: "Not a housing post" });
    }

    const ownerId = post.userId ? String(post.userId) : "";
    if (!ownerId) {
      return res.status(400).json({ ok: false, message: "Owner not available (post created without login)" });
    }
    if (String(ownerId) === String(meId)) {
      return res.status(400).json({ ok: false, message: "You own this post" });
    }

    // dedupe: if last pending/unlocked exists in 24h, return it
    // const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const existing = await HousingContactRequest.findOne({
      postId,
      requesterId: meId,
      createdAt: { $gte: dayAgo },
      status: { $in: ["pending", "unlocked"] },
    })
      .sort({ createdAt: -1 })
      .lean();

    if (existing) {
      return res.json({ ok: true, request_id: String(existing._id), status: existing.status });
    }

    const doc = await HousingContactRequest.create({
      postId,
      zip3: zip3 || (post.zip3 || zip3FromAny(post.zip)),
      ownerId,
      requesterId: meId,
      fromEmail: safeText(me.email || req.userDoc?.email || "", 120),
      fromName: safeText(me.name || "", 80),
      message,
      status: "pending",
    });

    await logPSEvent(req, "housing_contact_request_created", { zip3, postId, ownerId, requesterId: String(meId) });


    return res.json({ ok: true, request_id: String(doc._id), status: "pending" });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

// requester/owner check status (requires auth)
router.get("/housing/contact/request/:id([0-9a-fA-F]{24})", auth, async (req, res) => {
  try {
    const meId = req.userId || req.user?.userId || req.user?._id;
    const requestId = String(req.params.id || "").trim();
    if (!meId) return res.status(401).json({ ok: false, message: "Not authenticated" });

    const doc = await HousingContactRequest.findById(requestId).lean();
    if (!doc) return res.status(404).json({ ok: false, message: "Not found" });

    const isRequester = String(doc.requesterId) === String(meId);
    const isOwner = String(doc.ownerId) === String(meId);
    if (!isRequester && !isOwner) return res.status(403).json({ ok: false, message: "Forbidden" });

    const now = Date.now();
    const exp = doc.expiresAt ? new Date(doc.expiresAt).getTime() : 0;
    const active = doc.status === "unlocked" && exp > now;

    // auto-mark expired (best effort)
    if (doc.status === "unlocked" && exp && exp <= now) {
      HousingContactRequest.updateOne({ _id: doc._id }, { $set: { status: "expired" } }).catch(() => { });
    }

    // requester gets contact only when active
    if (active && isRequester) {
      return res.json({
        ok: true,
        request_id: String(doc._id),
        status: "unlocked",
        expires_at: doc.expiresAt,
        owner_contact: doc.ownerContact || { email: "", phone: "" },
        addressText: doc.addressText || "",
      });
    }

    return res.json({
      ok: true,
      request_id: String(doc._id),
      status: active ? "unlocked" : (doc.status || "pending"),
      expires_at: doc.expiresAt || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

// owner inbox (requires auth)
router.get("/housing/contact/inbox", auth, async (req, res) => {
  try {
    const meId = req.userId || req.user?.userId || req.user?._id;
    if (!meId) return res.status(401).json({ ok: false, message: "Not authenticated" });

    const zip3 = zip3FromAny(req.query?.zip3 || req.query?.zip || "");
    const postId = String(req.query?.post_id || req.query?.postId || "").trim();
    const limit = clampInt(req.query?.limit, 50, 1, 200);

    const q = { ownerId: meId };
    if (zip3) q.zip3 = zip3;
    if (isObjId(postId)) q.postId = postId;

    const rows = await HousingContactRequest.find(q)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const requesterIds = Array.from(
      new Set(
        rows
          .map((r) => String(r?.requesterId || "").trim())
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
      )
    );

    const requesterObjIds = requesterIds.map((id) => new mongoose.Types.ObjectId(id));
    const ownerObjId = mongoose.Types.ObjectId.isValid(String(meId))
      ? new mongoose.Types.ObjectId(String(meId))
      : null;

    const users = requesterObjIds.length
      ? await User.find({ _id: { $in: requesterObjIds } })
        .select("name email phone rating createdAt")
        .lean()
      : [];

    const personas = requesterObjIds.length
      ? await PCPersona.find({ userId: { $in: requesterObjIds } })
        .select(
          "userId kind verified isActive focusTags evidenceLinks showExternalRating externalRating externalReviewCount jobsCount matchCount updatedAt"
        )
        .lean()
      : [];

    const historyAgg = ownerObjId && requesterObjIds.length
      ? await HousingContactRequest.aggregate([
        {
          $match: {
            ownerId: ownerObjId,
            requesterId: { $in: requesterObjIds },
          },
        },
        {
          $group: {
            _id: "$requesterId",
            total: { $sum: 1 },
            approved: {
              $sum: {
                $cond: [{ $in: ["$status", ["unlocked", "expired"]] }, 1, 0],
              },
            },
            firstSeenAt: { $min: "$createdAt" },
            lastSeenAt: { $max: "$createdAt" },
          },
        },
      ])
      : [];

    const sameAdAgg = ownerObjId && requesterObjIds.length
      ? await HousingContactRequest.aggregate([
        {
          $match: {
            ownerId: ownerObjId,
            requesterId: { $in: requesterObjIds },
          },
        },
        {
          $group: {
            _id: { requesterId: "$requesterId", postId: "$postId" },
            total: { $sum: 1 },
          },
        },
      ])
      : [];

    const userMap = new Map(
      (users || []).map((u) => [String(u._id), u])
    );

    const personaRowsByUser = new Map();
    for (const p of personas || []) {
      const uid = String(p?.userId || "").trim();
      if (!uid) continue;
      const arr = personaRowsByUser.get(uid) || [];
      arr.push(p);
      personaRowsByUser.set(uid, arr);
    }

    const personaMap = new Map();
    for (const [uid, arr] of personaRowsByUser.entries()) {
      personaMap.set(uid, pickBestPersona(arr));
    }

    const historyMap = new Map(
      (historyAgg || []).map((x) => [
        String(x?._id),
        {
          total: Number(x?.total || 0) || 0,
          approved: Number(x?.approved || 0) || 0,
          firstSeenAt: x?.firstSeenAt || null,
          lastSeenAt: x?.lastSeenAt || null,
        },
      ])
    );

    const sameAdMap = new Map(
      (sameAdAgg || []).map((x) => [
        `${String(x?._id?.requesterId || "")}:${String(x?._id?.postId || "")}`,
        Number(x?.total || 0) || 0,
      ])
    );

    const items = rows.map((r) => {
      const requesterId = String(r?.requesterId || "").trim();
      const postIdStr = String(r?.postId || "").trim();

      const u = userMap.get(requesterId) || null;
      const persona = personaMap.get(requesterId) || null;
      const hist = historyMap.get(requesterId) || {
        total: 0,
        approved: 0,
        firstSeenAt: null,
        lastSeenAt: null,
      };

      const sameAdCount = sameAdMap.get(`${requesterId}:${postIdStr}`) || 0;

      const showExternalRating = !!persona?.showExternalRating;
      const extRating = showExternalRating ? (Number(persona?.externalRating || 0) || 0) : 0;
      const extReviews = showExternalRating ? (Number(persona?.externalReviewCount || 0) || 0) : 0;
      const fallbackUserRating = Number(u?.rating || 0) || 0;

      const rating = extRating || fallbackUserRating || 0;
      const reviewCount = extReviews || 0;

      return {
        request_id: String(r._id),
        requester_id: requesterId,
        post_id: postIdStr,

        from_email: r.fromEmail || u?.email || "",
        from_name: r.fromName || u?.name || "",
        from_phone: u?.phone || "",

        message: r.message || "",
        status: r.status || "pending",
        created_at: r.createdAt,
        expires_at: r.expiresAt || null,

        profile_kind: persona?.kind || "",
        verified: !!persona?.verified,

        rating,
        review_count: reviewCount,
        jobs_count: Number(persona?.jobsCount || 0) || 0,
        match_count: Number(persona?.matchCount || 0) || 0,
        member_since: u?.createdAt || null,

        trust: {
          profile_kind: persona?.kind || "",
          verified: !!persona?.verified,

          rating,
          review_count: reviewCount,

          jobs_count: Number(persona?.jobsCount || 0) || 0,
          match_count: Number(persona?.matchCount || 0) || 0,

          focus_tags: Array.isArray(persona?.focusTags) ? persona.focusTags : [],
          evidence_links_count: Array.isArray(persona?.evidenceLinks) ? persona.evidenceLinks.length : 0,

          prior_with_you_count: Number(hist?.total || 0) || 0,
          approved_before_count: Number(hist?.approved || 0) || 0,
          same_ad_count: Number(sameAdCount || 0) || 0,

          first_seen_at: hist?.firstSeenAt || null,
          last_seen_at: hist?.lastSeenAt || null,
          member_since: u?.createdAt || null,
        },
      };
    });

    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

router.post("/housing/contact/deny", auth, async (req, res) => {
  try {
    const meId = req.userId || req.user?.userId || req.user?._id;
    const requestId = String(req.body?.request_id || "").trim();
    const reason = safeText(req.body?.reason || "", 120);

    if (!meId) return res.status(401).json({ ok: false, message: "Not authenticated" });
    if (!isObjId(requestId)) return res.status(400).json({ ok: false, message: "request_id invalid" });

    const doc = await HousingContactRequest.findById(requestId);
    if (!doc) return res.status(404).json({ ok: false, message: "Not found" });
    if (String(doc.ownerId) !== String(meId)) return res.status(403).json({ ok: false, message: "Forbidden" });

    doc.status = "denied";
    await doc.save();

    await logPSEvent(req, "housing_contact_denied", { ownerId: String(meId), requesterId: String(doc.requesterId), reason });

    // If requester gets denied too often -> cooldown
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const denies = await HousingContactRequest.countDocuments({
      requesterId: doc.requesterId,
      status: "denied",
      createdAt: { $gte: dayAgo },
    });

    if (denies >= PS_LIMITS.DENIES_PER_DAY) {
      const until = await applyCooldown(doc.requesterId, PS_PENALTIES.REQUEST_SPAM_MIN, req, "too_many_denies", {
        denies,
      });
      return res.json({ ok: true, denied: true, cooldown_until: until.toISOString() });
    }

    return res.json({ ok: true, denied: true });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});


// owner approves + unlocks (requires auth)
router.post("/housing/contact/unlock", auth, async (req, res) => {
  try {
    const meId = req.userId || req.user?.userId || req.user?._id;
    const requestId = String(req.body?.request_id || req.body?.requestId || "").trim();
    const minutes = clampMinutes(req.body?.minutes, 30, 5, 120);

    if (!meId) return res.status(401).json({ ok: false, message: "Not authenticated" });
    if (!isObjId(requestId)) return res.status(400).json({ ok: false, message: "request_id invalid" });

    // ✅ owner cooldown (anti-fraud)
    const me = await User.findById(meId).select("_id psCooldownUntil").lean();
    if (me?.psCooldownUntil && new Date(me.psCooldownUntil).getTime() > Date.now()) {
      return res.status(429).json({
        ok: false,
        message: `Temporarily locked. Try again after ${new Date(me.psCooldownUntil).toISOString()}`,
        cooldown_until: new Date(me.psCooldownUntil).toISOString(),
      });
    }

    // ✅ unlock rate limits (owner)
    const nowMs = Date.now();
    const hourAgo = new Date(nowMs - 60 * 60 * 1000);
    const dayAgo = new Date(nowMs - 24 * 60 * 60 * 1000);

    const unlockHour = await HousingContactRequest.countDocuments({
      ownerId: meId,
      status: "unlocked",
      unlockedAt: { $gte: hourAgo },
    });
    if (unlockHour >= PS_LIMITS.UNLOCKS_PER_HOUR) {
      const until = await applyCooldown(meId, PS_PENALTIES.OWNER_UNLOCK_SPAM_MIN, req, "too_many_unlocks_hour", {
        ownerId: String(meId),
        unlockHour,
      });
      return res.status(429).json({
        ok: false,
        message: `Too many unlocks this hour. Locked until ${until.toISOString()}`,
        cooldown_until: until.toISOString(),
      });
    }

    const unlockDay = await HousingContactRequest.countDocuments({
      ownerId: meId,
      status: "unlocked",
      unlockedAt: { $gte: dayAgo },
    });
    if (unlockDay >= PS_LIMITS.UNLOCKS_PER_DAY) {
      const until = await applyCooldown(meId, PS_PENALTIES.OWNER_UNLOCK_SPAM_MIN, req, "too_many_unlocks_day", {
        ownerId: String(meId),
        unlockDay,
      });
      return res.status(429).json({
        ok: false,
        message: `Too many unlocks today. Locked until ${until.toISOString()}`,
        cooldown_until: until.toISOString(),
      });
    }

    // ✅ fetch doc (null-safe)
    const doc = await HousingContactRequest.findById(requestId);
    if (!doc) return res.status(404).json({ ok: false, message: "Not found" });
    if (String(doc.ownerId) !== String(meId)) return res.status(403).json({ ok: false, message: "Forbidden" });

    if (doc.status === "denied") {
      return res.status(400).json({ ok: false, message: "Request was denied." });
    }

    if (doc.status === "unlocked" && doc.expiresAt && new Date(doc.expiresAt).getTime() > Date.now()) {
      return res.status(400).json({ ok: false, message: "Already unlocked and active." });
    }

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    if (doc.createdAt && new Date(doc.createdAt).getTime() < sevenDaysAgo) {
      return res.status(400).json({ ok: false, message: "Request is too old to unlock." });
    }

    const post = await ServiceRequest.findById(doc.postId).lean();
    if (!post) return res.status(404).json({ ok: false, message: "Post not found" });
    if (!post.userId || String(post.userId) !== String(meId)) {
      return res.status(403).json({ ok: false, message: "You do not own this post" });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + minutes * 60 * 1000);

    doc.status = "unlocked";
    doc.unlockedAt = now;
    doc.expiresAt = expiresAt;

    // fallback: if post doesn't have contact info, use owner's User profile
    const ownerUser = await User.findById(meId).select("email phone name").lean();

    const bestEmail = post.contactEmail || ownerUser?.email || "";
    const bestPhone = post.contactPhone || ownerUser?.phone || "";

    // address fallback: if missing, at least show city/area (if available)
    const bestAddr =
      post.addressText ||
      post.locationText ||
      post.city ||
      post.neighborhood ||
      "";

    doc.ownerContact = {
      email: safeText(bestEmail, 120),
      phone: safeText(bestPhone, 40),
    };
    doc.addressText = safeText(bestAddr, 200);

    await doc.save();

    await logPSEvent(req, "housing_contact_unlocked", {
      ownerId: String(meId),
      requesterId: String(doc.requesterId),
      postId: String(doc.postId),
      minutes,
      expires_at: expiresAt.toISOString(),
    });

    return res.json({ ok: true, expires_at: expiresAt });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});



module.exports = router;
