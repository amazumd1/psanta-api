// services/api/routes/psStr.js
// Part 4 — STR Publish v1 (listing object + preview + photos)

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { auth, authOptional } = require("../middleware/auth");
const { extractPublicListing } = require("../lib/publicExtract");
const sharp = require("sharp");
const { cloudinary } = require("../src/services/cloudinary");

let StrListing = null;
try {
    StrListing = require("../models/StrListing");
} catch (e) {
    StrListing = null;
}

const ServiceRequest = require("../models/ServiceRequest");
const router = express.Router();

// Mount calendar import under same STR namespace
try {
    // /calendar/import
    router.use("/calendar", require("./psStrCalendar"));
} catch {
    // ok
}

/* -------------------- helpers -------------------- */
function sanitizeZip(zip) {
    return String(zip || "")
        .trim()
        .replace(/[^\d]/g, "")
        .slice(0, 5);
}

function zip3FromAny(zip) {
    const s = String(zip || "").replace(/[^\d]/g, "").slice(0, 3);
    return s.length === 3 ? s : "";
}

router.post("/extract_public", authOptional, async (req, res) => {
    try {
        const url = req.body?.url || req.body?.link;
        const r = await extractPublicListing(url);
        if (!r?.ok) return res.status(400).json(r || { ok: false, error: "Extract failed" });
        return res.json(r);
    } catch (e) {
        return res.status(400).json({ ok: false, error: e?.message || "Extract failed" });
    }
});


function safeId(id) {
    const s = String(id || "").trim();
    if (!s) return "";
    if (s.length > 64) return s.slice(0, 64);
    return s;
}

function safeText(v, max = 3000) {
    const s = String(v || "").trim();
    return s ? s.slice(0, max) : "";
}

function buildPreviewFromDraft(d) {
    if (!d || typeof d !== "object") return "";
    const parts = [];

    const title = safeText(d.title || d.headline || d.name || "", 120);
    if (title) parts.push(title);

    const beds = d.beds || d.bedrooms;
    const baths = d.baths || d.bathrooms;
    if (beds || baths) parts.push(`${beds || "?"} bd • ${baths || "?"} ba`);

    const area = safeText(d.area || d.neighborhood || d.city || "", 80);
    if (area) parts.push(area);

    const note = safeText(d.description || d.notes || d.requestNotes || "", 220);
    if (note) parts.push(note);

    return safeText(parts.join(" — "), 420);
}


function uniqUrls(urls, max = 30) {
    const out = [];
    const seen = new Set();

    for (const u of Array.isArray(urls) ? urls : []) {
        const s = String(u || "").trim();
        if (!s) continue;

        let norm = s;
        if (norm.startsWith("//")) norm = `https:${norm}`;
        if (norm.startsWith("/api/uploads/")) norm = norm.replace(/^\/api/, "");

        if (seen.has(norm)) continue;

        if (
            !/^https?:\/\//i.test(norm) &&
            !/^\/uploads\//i.test(norm) &&
            !/^data:image\//i.test(norm)
        ) continue;

        out.push(norm);
        seen.add(norm);
        if (out.length >= max) break;
    }
    return out;
}

function guessExtFromMime(mime) {
    const m = String(mime || "").toLowerCase();
    if (m.includes("jpeg")) return "jpg";
    if (m.includes("png")) return "png";
    if (m.includes("webp")) return "webp";
    return "jpg";
}

function parseDataUrl(dataUrl) {
    const s = String(dataUrl || "");
    const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(s);
    if (!m) return null;
    return { mime: m[1], b64: m[2] };
}

/* -------------------- Cloudinary (STR) -------------------- */
const STR_CLOUDINARY_FOLDER = process.env.CLOUDINARY_STR_FOLDER || "ps_str";
const STR_MIRROR_MAX = Math.max(0, Math.min(30, Number(process.env.CLOUDINARY_STR_MIRROR_MAX || 8)));

function isCloudinaryUrl(u) {
    const s = String(u || "");
    return /res\.cloudinary\.com/i.test(s) || /\/image\/upload\//i.test(s);
}

function normalizePhotoUrl(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    if (/^data:/i.test(s)) return s;
    if (s.startsWith("//")) return `https:${s}`;
    if (s.startsWith("/api/uploads/")) return s.replace(/^\/api/, "");
    return s;
}

function strListingFolder(listingId) {
    const id = String(listingId || "").trim().slice(0, 64) || "unknown";
    return `${STR_CLOUDINARY_FOLDER}/${id}`;
}

async function uploadBufferAsJpegToCloudinary(buf, folder) {
    const jpegBuf = await sharp(buf)
        .resize({ width: 1800, withoutEnlargement: true })
        .jpeg({ quality: 88 })
        .toBuffer();

    const up = await cloudinary.uploader.upload(
        `data:image/jpeg;base64,${jpegBuf.toString("base64")}`,
        { folder, resource_type: "image", format: "jpg" }
    );

    return { url: up.secure_url, publicId: up.public_id };
}

async function uploadDataUrlToCloudinary(dataUrl, folder) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) { const e = new Error("invalid_data_url"); e.status = 400; throw e; }
    if (!/^image\//i.test(parsed.mime)) { const e = new Error("invalid_mime"); e.status = 400; throw e; }
    if (parsed.b64.length > 10_000_000) { const e = new Error("payload_too_large"); e.status = 413; throw e; }

    const buf = Buffer.from(parsed.b64, "base64");
    if (!buf.length) { const e = new Error("empty_image"); e.status = 400; throw e; }

    return uploadBufferAsJpegToCloudinary(buf, folder);
}

async function uploadRemoteUrlToCloudinary(url, folder) {
    const up = await cloudinary.uploader.upload(url, { folder, resource_type: "image" });
    return { url: up.secure_url, publicId: up.public_id };
}

async function uploadLocalUploadsPathToCloudinary(urlPath, folder) {
    const rel = String(urlPath || "").replace(/^\//, "");
    const full = path.join(__dirname, "..", rel);
    if (!fs.existsSync(full)) { const e = new Error("local_upload_missing"); e.status = 404; throw e; }
    const buf = fs.readFileSync(full);
    return uploadBufferAsJpegToCloudinary(buf, folder);
}

async function ensureCloudinaryUrlForAny(inputUrl, folder) {
    const u0 = normalizePhotoUrl(inputUrl);
    if (!u0) return { url: "", publicId: "" };
    if (isCloudinaryUrl(u0)) return { url: u0, publicId: "" };

    if (/^data:image\//i.test(u0)) return uploadDataUrlToCloudinary(u0, folder);
    if (/^\/uploads\//i.test(u0)) return uploadLocalUploadsPathToCloudinary(u0, folder);
    if (/^https?:\/\//i.test(u0)) return uploadRemoteUrlToCloudinary(u0, folder);

    return { url: u0, publicId: "" };
}

function ensureUploadsDir(listingId) {
    const base = path.join(__dirname, "..", "uploads", "ps_str", listingId);
    fs.mkdirSync(base, { recursive: true });
    return base;
}

function canMutate(doc, req) {
    // Once a listing has an owner, only that owner can modify.
    const owner = doc?.userId ? String(doc.userId) : "";
    const who = req.userId ? String(req.userId) : "";

    if (!owner) return true; // unclaimed listing: anyone can mutate (MVP)
    if (!who) return false; // owner set but request is anonymous
    return owner === who;
}

async function getOrCreateListing({ listing_id, zip, req }) {
    if (!StrListing) throw new Error("StrListing model missing");

    const id = safeId(listing_id);
    if (!id) {
        const err = new Error("missing_listing_id");
        err.status = 400;
        throw err;
    }

    const z = sanitizeZip(zip);
    const z3 = zip3FromAny(z);

    let doc = await StrListing.findOne({ listing_id: id });

    if (!doc) {
        doc = await StrListing.create({
            listing_id: id,
            zip: z,
            zip3: z3,
            userId: req.userId || undefined,
            draft: {},
            photos: [],
            cover_url: "",
            published: false,
            publishedAt: null,
        });
        return doc;
    }

    // enforce ownership if already claimed
    if (!canMutate(doc, req)) {
        const err = new Error("forbidden");
        err.status = 403;
        throw err;
    }

    // allow claiming listing if it was created anonymously and now user is authed
    if (!doc.userId && req.userId) {
        doc.userId = req.userId;
    }

    // refresh zip if provided
    if (z) {
        doc.zip = z;
        doc.zip3 = z3;
    }

    return doc;
}

/* -------------------- POST /photos/upload_base64 -------------------- */
router.post("/photos/upload_base64", authOptional, async (req, res) => {
    try {
        const { listing_id, zip, filename, data_url } = req.body || {};

        const doc = await getOrCreateListing({ listing_id, zip, req });

        const parsed = parseDataUrl(data_url);
        if (!parsed) {
            return res.status(400).json({ ok: false, error: "invalid_data_url" });
        }

        const mime = parsed.mime;
        if (!/^image\//i.test(mime)) {
            return res.status(400).json({ ok: false, error: "invalid_mime" });
        }

        // basic size guard (~6MB decoded)
        if (parsed.b64.length > 10_000_000) {
            return res.status(413).json({ ok: false, error: "payload_too_large" });
        }

        const buf = Buffer.from(parsed.b64, "base64");
        if (!buf.length) {
            return res.status(400).json({ ok: false, error: "empty_image" });
        }

        const ext = guessExtFromMime(mime);
        const safeName = String(filename || "photo")
            .trim()
            .replace(/[^a-z0-9._-]+/gi, "_")
            .slice(0, 60);

        const rand = crypto.randomBytes(4).toString("hex");
        const baseDir = ensureUploadsDir(doc.listing_id);
        const file = `${Date.now()}_${rand}_${safeName || "photo"}.${ext}`;
        const full = path.join(baseDir, file);

        fs.writeFileSync(full, buf);

        const url = `/uploads/ps_str/${encodeURIComponent(doc.listing_id)}/${encodeURIComponent(file)}`;

        // persist in listing (best effort)
        const exists = (doc.photos || []).some((p) => p?.url === url);
        if (!exists) {
            doc.photos = Array.isArray(doc.photos) ? doc.photos : [];
            doc.photos.push({ url, source: "upload", is_cover: false });
        }

        // set cover if missing
        if (!doc.cover_url) {
            doc.cover_url = url;
            doc.photos = (doc.photos || []).map((p) => ({ ...p, is_cover: p?.url === url }));
        }

        await doc.save();

        return res.json({ ok: true, url, item: { url } });
    } catch (e) {
        const status = e?.status || 500;
        if (status >= 500) console.error("POST /ps/str/photos/upload_base64 error:", e);
        return res.status(status).json({ ok: false, error: e?.message || "server_error" });
    }

});

/* -------------------- POST /photos/save -------------------- */
router.post("/photos/save", authOptional, async (req, res) => {
    try {
        const { listing_id, zip, urls, cover_url } = req.body || {};

        const doc = await getOrCreateListing({ listing_id, zip, req });

        const clean = uniqUrls(urls, 30);
        const coverNorm = normalizePhotoUrl(cover_url);

        const coverProvided = !!coverNorm;
        const coverIdxRaw = coverProvided ? clean.indexOf(coverNorm) : -1;
        const coverProvidedButMissing = coverProvided && coverIdxRaw < 0;

        let coverIdx = coverIdxRaw;
        if (coverIdx < 0) coverIdx = clean.length ? 0 : -1;

        const folder = strListingFolder(doc.listing_id);
        const items = [];

        for (let i = 0; i < clean.length; i++) {
            const u = clean[i];
            const isData = /^data:image\//i.test(u);
            const isLocal = /^\/uploads\//i.test(u);

            const mustMirror = isData || isLocal || i < STR_MIRROR_MAX || i === coverIdx;

            if (mustMirror) {
                try {
                    const up = await ensureCloudinaryUrlForAny(u, folder);
                    items.push({
                        url: up.url || u,
                        publicId: up.publicId || "",
                        source: isData || isLocal ? "upload" : "link",
                        is_cover: false,
                    });
                    continue;
                } catch { }
            }

            items.push({ url: u, publicId: "", source: isData ? "data" : "link", is_cover: false });
        }

        // cover_url urls[] me nahi tha → still honor it
        if (coverProvidedButMissing) {
            try {
                const up = await ensureCloudinaryUrlForAny(coverNorm, folder);
                items.unshift({ url: up.url || coverNorm, publicId: up.publicId || "", source: "link", is_cover: true });
                coverIdx = 0;
            } catch {
                items.unshift({ url: coverNorm, publicId: "", source: "link", is_cover: true });
                coverIdx = 0;
            }
        }

        const coverFinal =
            coverIdx >= 0 && items[coverIdx] ? items[coverIdx].url : items[0]?.url || doc.cover_url || "";

        doc.photos = items.map((p, idx) => ({ ...p, is_cover: idx === coverIdx }));
        doc.cover_url = coverFinal;

        await doc.save();

        return res.json({ ok: true, photos_count: doc.photos.length, cover_url: doc.cover_url });
    } catch (e) {
        const status = e?.status || 500;
        if (status >= 500) console.error("POST /ps/str/photos/save error:", e);
        return res.status(status).json({ ok: false, error: e?.message || "server_error" });
    }
});

/* -------------------- POST /listings/save (and /listings/publish alias) -------------------- */
async function saveListingHandler(req, res) {
    try {
        const {
            listing_id,
            zip,
            draft,
            photo_urls,
            cover_url,
            public_preview,
            public_title,
            publish,
        } = req.body || {};

        const doc = await getOrCreateListing({ listing_id, zip, req });

        /* -------------------- Draft: merge (do not wipe) -------------------- */
        const incomingDraft =
            draft && typeof draft === "object" && !Array.isArray(draft) ? draft : null;

        if (incomingDraft) {
            const base =
                doc.draft && typeof doc.draft === "object" && !Array.isArray(doc.draft)
                    ? doc.draft
                    : {};

            const merged = { ...base, ...incomingDraft };

            if (typeof merged.requestNotes === "string") merged.requestNotes = safeText(merged.requestNotes, 1200);
            if (typeof merged.evidenceLinksText === "string") merged.evidenceLinksText = safeText(merged.evidenceLinksText, 1400);
            // normalize listing URL (frontend might send url/link instead of listingUrl)
            // normalize listing URL (frontend might send url/link instead of listingUrl)
            const urlCandidate =
                typeof merged.listingUrl === "string" ? merged.listingUrl :
                    typeof merged.url === "string" ? merged.url :
                        typeof merged.link === "string" ? merged.link :
                            typeof incomingDraft?.url === "string" ? incomingDraft.url :
                                typeof incomingDraft?.link === "string" ? incomingDraft.link :
                                    "";

            if (urlCandidate) merged.listingUrl = safeText(urlCandidate, 420);
            if (typeof merged.listingUrl === "string") merged.listingUrl = safeText(merged.listingUrl, 420);

            // if extract step gave an image_url and we still have no cover, set it
            const imgCandidate = String(merged.image_url || merged.cover_url || merged.coverUrl || "").trim();

            if (imgCandidate && !doc.cover_url) {
                doc.cover_url = imgCandidate;
                doc.photos = Array.isArray(doc.photos) ? doc.photos : [];
                if (!doc.photos.length) {
                    doc.photos = [{ url: imgCandidate, source: "extract", is_cover: true }];
                }
            }

            doc.draft = merged;
        }

        const curDraft =
            doc.draft && typeof doc.draft === "object" && !Array.isArray(doc.draft)
                ? doc.draft
                : {};

        const isPublish =
            /\/publish$/i.test(req.path || "") ||
            /\/publish$/i.test(req.originalUrl || "") ||
            publish === true;

        if (isPublish && !req.userId) {
            return res.status(401).json({ ok: false, error: "auth_required" });
        }

        /* -------------------- Public preview/title: only overwrite if provided -------------------- */
        const ppIn = typeof public_preview === "string" ? safeText(public_preview, 900) : "";
        const ptIn = typeof public_title === "string" ? safeText(public_title, 160) : "";

        if (ppIn) {
            doc.public_preview = ppIn;
        } else if (!doc.public_preview || (isPublish && !doc.public_preview)) {
            doc.public_preview = buildPreviewFromDraft(curDraft);
        }

        if (ptIn) {
            doc.public_title = ptIn;
        } else if (!doc.public_title || (isPublish && !doc.public_title)) {
            doc.public_title = safeText(curDraft?.title || curDraft?.headline || "", 160);
        }

        /* -------------------- Photos: only update when provided -------------------- */
        const hasPhotoUrls = Array.isArray(photo_urls);
        const hasCover = typeof cover_url === "string" && cover_url.trim();

        if (hasPhotoUrls || hasCover) {
            const clean = hasPhotoUrls ? uniqUrls(photo_urls, 30) : (
                Array.isArray(doc.photos) ? doc.photos.map((p) => p?.url).filter(Boolean) : []
            );

            const cover = hasCover ? String(cover_url).trim() : (doc.cover_url || "");
            const coverFinal =
                cover && clean.includes(cover) ? cover : cover || clean[0] || doc.cover_url || "";

            if (clean.length) {
                doc.photos = clean.map((u) => ({
                    url: u,
                    source: /^data:image\//i.test(u) ? "data" : "link",
                    is_cover: u === coverFinal,
                }));
                doc.cover_url = coverFinal;
            } else if (coverFinal && !doc.cover_url) {
                doc.cover_url = coverFinal;
            }
        }

        // ✅ Auto-cover on publish (if no photos provided)
        if (isPublish) {
            await ensureAutoCoverOnPublish(doc, curDraft);
            await mirrorPhotosForPublish(doc);
        }

        /* -------------------- Publish semantics -------------------- */
        if (isPublish && !doc.published) {
            doc.published = true;
            doc.publishedAt = new Date();
        }

        await doc.save();

        // ✅ Hard guarantee: never publish with empty title/preview
        if (isPublish) {
            if (!doc.public_title) {
                doc.public_title = safeText(curDraft?.title || curDraft?.headline || `STR Listing ${doc.listing_id}`, 160);
            }
            if (!doc.public_preview) {
                doc.public_preview = buildPreviewFromDraft(curDraft) || safeText(curDraft?.description || `ZIP ${doc.zip || ""}`, 420);
            }
        }

        /* -------------------- Upsert housing listing into ServiceRequest -------------------- */
        const housingDedupeKey = `str_listing|${doc.listing_id}`;
        const housingDraft = curDraft; // use latest merged draft

        // Build location line respecting privacy
        let locationStr = "";
        if (housingDraft.locationHint && typeof housingDraft.locationHint === "object") {
            const lh = housingDraft.locationHint;
            const lhCity = String(lh.city || "").trim();
            const lhState = String(lh.state || "").trim();
            const lhZip = String(lh.zip || "").trim();
            locationStr = [lhCity, lhState].filter(Boolean).join(", ") || lhZip || "";
        }
        if (!locationStr && housingDraft.areaHint) {
            locationStr = String(housingDraft.areaHint).trim();
        }

        const z = sanitizeZip(doc.zip || zip || "");
        const z3 = zip3FromAny(doc.zip3 || z);

        const hasAnyLocation = !!z3; // require ZIP3 for housing feed
        let housingPostDoc = null;

        if (!hasAnyLocation) {
            console.warn("Skipping housing_listing upsert: missing location + zip3");
        } else {
            const srZip = z;
            const srZip3 = z3;

            const bedsN = Number(housingDraft.beds || 0) || 0;
            const bathsN = Number(housingDraft.baths || 0) || 0;

            const srQuery =
                doc.public_title ||
                housingDraft.title ||
                housingDraft.headline ||
                "Short-term rental listing";

            const srPreview =
                doc.public_preview ||
                housingDraft.description ||
                "";

            const srFields = {
                kind: "str_listing",
                referenceId: doc.listing_id,
                referenceType: "str_listing",
                listingUrl: housingDraft.listingUrl || housingDraft.publicLocationUrl || "",
                coverImageUrl: doc.cover_url || "",
                public_title: doc.public_title || "",
                public_preview: doc.public_preview || "",
                propertyType: housingDraft.propertyType || null,
                nightlyMin: housingDraft.nightlyMin || null,
                nightlyMax: housingDraft.nightlyMax || null,
                cleaningFee: housingDraft.cleaningFee || null,
                minNights: housingDraft.minNights || null,
                checkInTime: housingDraft.checkInTime || null,
                checkOutTime: housingDraft.checkOutTime || null,
                amenities: Array.isArray(housingDraft.amenities) ? housingDraft.amenities : [],
                tags: ["str", "short-term-rental"],
                source: "str_ai",
                preview: srPreview,
            };

            try {
                housingPostDoc = await ServiceRequest.findOneAndUpdate(
                    { dedupeKey: housingDedupeKey },
                    {
                        $setOnInsert: {
                            dedupeKey: housingDedupeKey,
                            serviceType: "housing_listing",
                            tab: "housing",
                            intent: "offer",
                            source: "psStr",
                            reason: "str_publish",
                            createdAt: new Date(),
                        },
                        $set: {
                            ...(req.userId ? { userId: req.userId } : {}),
                            ...(req.userDoc?.email ? { userEmail: req.userDoc.email } : {}),

                            active: true,
                            zip: srZip,
                            zip3: srZip3,
                            query: srQuery,
                            addressText: locationStr,
                            beds: bedsN,
                            baths: bathsN,
                            fields: srFields,
                            updatedAt: new Date(),
                        },
                    },
                    {
                        upsert: true,
                        new: true,
                        setDefaultsOnInsert: true,
                        runValidators: true,
                    }
                );
            } catch (srErr) {
                console.warn("ServiceRequest upsert failed:", srErr?.message);
            }
        }

        return res.json({
            ok: true,
            listing_id: doc.listing_id,
            published: !!doc.published,
            photos_count: Array.isArray(doc.photos) ? doc.photos.length : 0,
            cover_url: doc.cover_url || "",
            public_title: doc.public_title || "",
            public_preview: doc.public_preview || "",
            updatedAt: doc.updatedAt,
            ...(hasAnyLocation && {
                housing_post: {
                    post_id: housingPostDoc ? String(housingPostDoc._id) : "",
                    serviceType: "housing_listing",
                    dedupeKey: housingDedupeKey,
                },
            }),
        });
    } catch (e) {
        const status = e?.status || 500;
        if (status >= 500) console.error("POST /ps/str/listings/save error:", e);
        return res.status(status).json({ ok: false, error: e?.message || "server_error" });
    }
}

async function ensureAutoCoverOnPublish(doc, curDraft) {
    try {
        const hasPhotos = Array.isArray(doc.photos) && doc.photos.length > 0;
        const hasCover = String(doc.cover_url || "").trim();
        if (hasPhotos || hasCover) return;

        const d = curDraft && typeof curDraft === "object" ? curDraft : {};

        // 1) if frontend already placed cover in draft
        const draftCover = String(d.cover_url || d.coverUrl || d.image_url || d.imageUrl || "").trim();
        if (draftCover) {
            doc.photos = [{ url: draftCover, source: "draft", is_cover: true }];
            doc.cover_url = draftCover;
            doc.draft = { ...(doc.draft || {}), cover_url: draftCover };
            return;
        }

        // 2) else extract OG image from listingUrl at publish time
        const listingUrl = String(d.listingUrl || d.url || "").trim();
        if (!listingUrl) return;

        const r = await extractPublicListing(listingUrl);
        const img = String(r?.extracted?.image_url || "").trim();
        if (!img) return;

        doc.photos = [{ url: img, source: "extract", is_cover: true }];
        doc.cover_url = img;
        doc.draft = { ...(doc.draft || {}), cover_url: img };
    } catch {
        // ignore (publish should still succeed even if image fetch fails)
    }
}

async function mirrorPhotosForPublish(doc) {
    try {
        if (!doc) return;
        doc.photos = Array.isArray(doc.photos) ? doc.photos : [];
        const folder = strListingFolder(doc.listing_id);

        // cover always mirrored
        const coverOld = normalizePhotoUrl(doc.cover_url);
        if (coverOld && !isCloudinaryUrl(coverOld)) {
            try {
                const up = await ensureCloudinaryUrlForAny(coverOld, folder);
                if (up?.url) {
                    const coverNew = up.url;
                    doc.cover_url = coverNew;

                    let found = false;
                    doc.photos = doc.photos.map((p) => {
                        const pu = normalizePhotoUrl(p?.url);
                        if (pu && pu === coverOld) {
                            found = true;
                            return { ...p, url: coverNew, publicId: up.publicId || p?.publicId || "", is_cover: true };
                        }
                        return { ...p, is_cover: false };
                    });

                    if (!found) {
                        doc.photos.unshift({ url: coverNew, publicId: up.publicId || "", source: "cover_mirror", is_cover: true });
                    }
                }
            } catch { }
        }

        // mirror first N photos
        for (let i = 0; i < doc.photos.length && i < STR_MIRROR_MAX; i++) {
            const p = doc.photos[i] || {};
            const u = normalizePhotoUrl(p.url);
            if (!u || isCloudinaryUrl(u)) continue;

            try {
                const up = await ensureCloudinaryUrlForAny(u, folder);
                if (up?.url && isCloudinaryUrl(up.url)) {
                    doc.photos[i] = { ...p, url: up.url, publicId: up.publicId || p?.publicId || "" };
                    if (p.is_cover) doc.cover_url = up.url;
                }
            } catch { }
        }

        // guarantee 1 cover
        const coverFinal =
            normalizePhotoUrl(doc.cover_url) ||
            normalizePhotoUrl(doc.photos.find((p) => p?.is_cover)?.url) ||
            normalizePhotoUrl(doc.photos[0]?.url) ||
            "";

        if (coverFinal) {
            doc.cover_url = coverFinal;
            doc.photos = doc.photos.map((p) => ({ ...p, is_cover: normalizePhotoUrl(p?.url) === coverFinal }));
        }
    } catch { }
}

router.post("/listings/save", authOptional, saveListingHandler);
router.post("/listing/save", authOptional, saveListingHandler);
router.post("/listings/publish", auth, saveListingHandler);

/* -------------------- GET /listings/mine --------------------
 * Owner workspace source-of-truth for published STR inventory.
 * /api/ps/str/listings/mine?status=published|draft|all&limit=100
 */
router.get("/listings/mine", auth, async (req, res) => {
    try {
        if (!StrListing) return res.status(501).json({ ok: false, error: "model_missing" });

        const meId = req.userId;
        const status = String(req.query?.status || "published").trim().toLowerCase();
        const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 100)));

        const match = { userId: meId };
        if (status === "published") match.published = true;
        else if (status === "draft") match.published = false;

        const rows = await StrListing.find(match)
            .sort({ updatedAt: -1, publishedAt: -1, createdAt: -1 })
            .limit(limit)
            .lean();

        const items = rows.map((d) => ({
            listing_id: d.listing_id,
            zip3: d.zip3 || zip3FromAny(d.zip || ""),
            zip: d.zip,
            cover_url: d.cover_url || (Array.isArray(d.photos) && d.photos[0] ? d.photos[0].url : "") || "",
            photo_count: Array.isArray(d.photos) ? d.photos.length : 0,
            public_title: d.public_title || safeText(d?.draft?.title || d?.draft?.headline || "", 120),
            public_preview: d.public_preview || buildPreviewFromDraft(d?.draft || {}),
            published: !!d.published,
            publishedAt: d.publishedAt || null,
            updatedAt: d.updatedAt || null,
        }));

        return res.json({ ok: true, status, count: items.length, items });
    } catch (e) {
        console.error("GET /ps/str/listings/mine error:", e);
        return res.status(500).json({ ok: false, error: "server_error", message: String(e?.message || e) });
    }
});

/* -------------------- GET /listings/byZip3 --------------------
 * Public feed for a ZIP3.
 * /api/ps/str/listings/byZip3?zip3=276&limit=24
 */
router.get("/listings/byZip3", authOptional, async (req, res) => {
    try {
        if (!StrListing) return res.status(501).json({ ok: false, error: "model_missing" });

        const zip3 = zip3FromAny(req.query?.zip3 || "");
        const limit = Math.max(1, Math.min(60, Number(req.query?.limit || 24)));

        if (!zip3) return res.status(400).json({ ok: false, error: "missing_zip3" });

        const rows = await StrListing.find({ zip3, published: true })
            .sort({ publishedAt: -1, updatedAt: -1 })
            .limit(limit)
            .lean();

        const items = rows.map((d) => ({
            listing_id: d.listing_id,
            zip3: d.zip3,
            zip: d.zip,
            cover_url: d.cover_url || (Array.isArray(d.photos) && d.photos[0] ? d.photos[0].url : "") || "",
            photo_count: Array.isArray(d.photos) ? d.photos.length : 0,
            public_title: d.public_title || "",
            public_preview: d.public_preview || "",
            publishedAt: d.publishedAt || null,
            updatedAt: d.updatedAt || null,
        }));

        return res.json({ ok: true, zip3, items });
    } catch (e) {
        console.error("GET /ps/str/listings/byZip3 error:", e);
        return res.status(500).json({ ok: false, error: "server_error", message: String(e?.message || e) });
    }
});

/* -------------------- GET /listings/:listing_id (debug/read) -------------------- */
router.get("/listings/:listing_id", authOptional, async (req, res) => {
    try {
        if (!StrListing) return res.status(501).json({ ok: false, error: "model_missing" });
        const id = safeId(req.params.listing_id);
        if (!id) return res.status(400).json({ ok: false, error: "missing_listing_id" });

        const doc = await StrListing.findOne({ listing_id: id }).lean();
        if (!doc) return res.status(404).json({ ok: false, error: "not_found" });
        // If not published, only owner can read it
        const owner = doc.userId ? String(doc.userId) : "";
        const who = req.userId ? String(req.userId) : "";

        if (!doc.published && owner && owner !== who) {
            return res.status(404).json({ ok: false, error: "not_found" });
        }

        let out = doc;
        if (owner && owner !== who) {
            out = {
                listing_id: doc.listing_id,
                zip3: doc.zip3,
                zip: doc.zip,
                cover_url: doc.cover_url,
                photos: (doc.photos || []).slice(0, 6),
                published: !!doc.published,
                publishedAt: doc.publishedAt,
                createdAt: doc.createdAt,
                updatedAt: doc.updatedAt,
            };
        }

        return res.json({ ok: true, item: out });
    } catch (e) {
        console.error("GET /ps/str/listings/:listing_id error:", e);
        return res.status(500).json({ ok: false, error: "server_error" });
    }
});

// ✅ Ensure published listings are also in ServiceRequest feed (so OwnerDashboard can see them)
router.post("/listings/ensure_feed", auth, async (req, res) => {
    try {
        if (!StrListing) return res.status(501).json({ ok: false, error: "model_missing" });

        const meId = req.userId;
        const onlyId = safeId(req.body?.listing_id || "");
        const match = { userId: meId, published: true };
        if (onlyId) match.listing_id = onlyId;

        const rows = await StrListing.find(match).lean();
        if (!rows.length) return res.json({ ok: true, ensured: 0, total: 0 });

        const items = [];
        let ensured = 0;

        for (const d of rows) {
            const key = `str_listing|${d.listing_id}`;

            const draft = d?.draft && typeof d.draft === "object" ? d.draft : {};
            const srZip = sanitizeZip(d.zip || "");
            const srZip3 = zip3FromAny(d.zip3 || srZip);
            if (!srZip3) continue;

            const bedsN = Number(draft?.beds || draft?.bedrooms || 0) || 0;
            const bathsN = Number(draft?.baths || draft?.bathrooms || 0) || 0;

            const srQuery =
                String(d.public_title || "").trim() ||
                String(draft?.title || draft?.headline || "").trim() ||
                "Short-term rental listing";

            const srPreview = String(d.public_preview || "").trim();

            const srFields = {
                kind: "str_listing",
                referenceId: d.listing_id,
                referenceType: "str_listing",
                listingUrl: draft.listingUrl || draft.publicLocationUrl || "",
                coverImageUrl: d.cover_url || "",
                public_title: d.public_title || "",
                public_preview: d.public_preview || "",
                propertyType: draft.propertyType || null,
                nightlyMin: draft.nightlyMin ?? null,
                nightlyMax: draft.nightlyMax ?? null,
                cleaningFee: draft.cleaningFee ?? null,
                minNights: draft.minNights ?? null,
                checkInTime: draft.checkInTime ?? null,
                checkOutTime: draft.checkOutTime ?? null,
                amenities: Array.isArray(draft.amenities) ? draft.amenities : [],
                tags: ["str", "short-term-rental"],
                source: "str_ai",
                preview: srPreview,
            };

            const existingPost = await ServiceRequest.findOne({ dedupeKey: key }).lean();

            const existingFields =
                existingPost?.fields && typeof existingPost.fields === "object"
                    ? existingPost.fields
                    : {};

            const preservedArchived = !!(
                existingFields.archived ||
                existingFields.isArchived
            );

            const preservedActive =
                existingPost ? existingPost.active !== false : true;

            const nextActive = preservedArchived ? false : preservedActive;

            const mergedFields = {
                ...existingFields,
                ...srFields,
                archived: preservedArchived,
                isArchived: preservedArchived,
            };

            const postDoc = await ServiceRequest.findOneAndUpdate(
                { dedupeKey: key },
                {
                    $setOnInsert: {
                        dedupeKey: key,
                        serviceType: "housing_listing",
                        tab: "housing",
                        intent: "offer",
                        source: "psStr",
                        reason: "str_publish_backfill",
                        createdAt: new Date(),
                    },
                    $set: {
                        userId: meId,
                        userEmail: (req.userDoc?.email || req.user?.email || ""),

                        active: nextActive,
                        zip: srZip,
                        zip3: srZip3,
                        query: srQuery,
                        beds: bedsN,
                        baths: bathsN,
                        fields: mergedFields,
                        updatedAt: new Date(),
                    },
                },
                {
                    upsert: true,
                    new: true,
                    setDefaultsOnInsert: true,
                }
            );

            items.push({
                listing_id: d.listing_id,
                post_id: postDoc ? String(postDoc._id) : "",
                dedupeKey: key,
            });

            ensured += 1;
        }

        return res.json({ ok: true, ensured, total: rows.length, items });
    } catch (e) {
        console.error("POST /ps/str/listings/ensure_feed error:", e);
        return res.status(500).json({ ok: false, error: "server_error", message: String(e?.message || e) });
    }
});

module.exports = router;
