const fetch = require("node-fetch");
const dns = require("dns").promises;
const net = require("net");

// Safer-by-default allowlist (add more if needed)
const ALLOW_HOST_SUFFIXES = [
  // STR / property listing sources
  "airbnb.com",
  "vrbo.com",
  "expedia.com",
  "booking.com",
  "zillow.com",
  "realtor.com",
  "loopnet.com",
  "crexi.com",

  // Pro profile sources (public reputation pages)
  "g.page",
  "google.com",
  "yelp.com",
  "nextdoor.com",
  "angi.com",
  "homeadvisor.com",
  "thumbtack.com",
  "taskrabbit.com",
  "porch.com",
  "houzz.com",
];

function hostAllowed(hostname) {
    const h = String(hostname || "").toLowerCase();
    return ALLOW_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

function isPrivateIPv4(ip) {
    if (!ip) return true;
    if (ip === "127.0.0.1" || ip === "0.0.0.0") return true;
    if (ip.startsWith("10.")) return true;
    if (ip.startsWith("192.168.")) return true;
    const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16–172.31
    if (a === 169 && b === 254) return true; // link local
    return false;
}
function isPrivateIPv6(ip) {
    if (!ip) return true;
    const v = String(ip).toLowerCase();
    if (v === "::1") return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique local
    if (v.startsWith("fe80")) return true; // link local
    return false;
}
function isPrivateIp(ip) {
    const fam = net.isIP(ip);
    if (fam === 4) return isPrivateIPv4(ip);
    if (fam === 6) return isPrivateIPv6(ip);
    return true;
}

async function validateAndNormalizeUrl(raw) {
    const s = String(raw || "").trim();
    if (!s) throw new Error("Missing url");

    let u;
    try { u = new URL(s); } catch { throw new Error("Invalid url"); }

    if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error("Only http/https links are allowed");
    }

    const hostname = String(u.hostname || "").toLowerCase();
    if (!hostAllowed(hostname)) {
        throw new Error(`Unsupported host. Allowed: ${ALLOW_HOST_SUFFIXES.join(", ")}`);
    }

    if (["localhost", "0.0.0.0"].includes(hostname)) throw new Error("Blocked host");

    if (net.isIP(hostname)) {
        if (isPrivateIp(hostname)) throw new Error("Blocked private IP");
        return u.toString();
    }

    // best-effort DNS private-IP block
    try {
        const res = await dns.lookup(hostname, { all: true, verbatim: true });
        for (const r of res || []) {
            if (isPrivateIp(r.address)) throw new Error("Blocked private IP");
        }
    } catch {
        // ignore DNS errors; fetch may still fail later
    }

    return u.toString();
}

function absolutizeMaybeUrl(raw, baseUrl) {
    const s = String(raw || "").trim();
    if (!s) return "";
    if (/^data:/i.test(s)) return s;
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith("//")) return `https:${s}`;
    if (s.startsWith("www.")) return `https://${s}`;
    try {
        return new URL(s, baseUrl).toString();
    } catch {
        return s;
    }
}

function unescapeHtml(s) {
    return String(s || "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim();
}
function stripHtml(s) {
    return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function pickMeta(html, nameOrProp) {
    const p = String(nameOrProp);
    const re = new RegExp(
        `<meta[^>]+(?:property|name)=["']${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]+content=["']([^"']+)["'][^>]*>`,
        "i"
    );
    const m = html.match(re);
    return m ? unescapeHtml(m[1]) : "";
}

function extractScripts(html, { type, id } = {}) {
    const parts = [];
    const typeRe = type ? `[^>]*type=["']${type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']` : "[^>]*";
    const idRe = id ? `[^>]*id=["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']` : "[^>]*";
    const re = new RegExp(`<script${idRe}${typeRe}[^>]*>([\\s\\S]*?)<\\/script>`, "gi");
    let m;
    while ((m = re.exec(html))) {
        const body = String(m[1] || "").trim();
        if (body) parts.push(body);
    }
    return parts;
}
function tryJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function deepCollect(obj, out = []) {
    if (!obj || typeof obj !== "object") return out;
    if (Array.isArray(obj)) { obj.forEach((v) => deepCollect(v, out)); return out; }
    for (const [k, v] of Object.entries(obj)) {
        out.push({ key: k, value: v });
        deepCollect(v, out);
    }
    return out;
}
function firstNumber(v) {
    if (v == null) return null;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const s = String(v);
    const m = s.match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
}

function parseAirbnbOgSummary(desc) {
    const s = unescapeHtml(desc || "");
    const parts = s.split("·").map((x) => x.trim()).filter(Boolean);

    // location usually first chunk: "Bhubaneswar, Odisha, India"
    let area = "";
    if (parts[0] && parts[0].length <= 90 && /,/.test(parts[0])) area = parts[0];

    const guestsMax = firstNumber(s.match(/(\d+)\s+guests?/i)?.[1]);
    const bedrooms = firstNumber(s.match(/(\d+)\s+bedrooms?/i)?.[1]);
    const beds = firstNumber(s.match(/(\d+)\s+beds?/i)?.[1]);
    const bathrooms = firstNumber(s.match(/(\d+(?:\.\d+)?)\s+baths?/i)?.[1]);

    return { area, guestsMax, bedrooms, beds, bathrooms };
}

function parseCityStateFromArea(area) {
    const s = String(area || "").trim();
    if (!s) return { city: "", state: "" };

    const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) return { city: "", state: "" };

    const city = parts[0] || "";
    const st = parts[1] || "";
    const m = st.match(/\b([A-Z]{2})\b/); // "FL"
    const state = m ? m[1] : st;

    return { city, state };
}


function parseAirbnbHints(html, metaDesc) {
    const text = stripHtml(html || "");
    const d = String(metaDesc || "");

    // Beds/Baths/Bedrooms often appear in header text
    let bedrooms =
        firstNumber((text.match(/(\d+(?:\.\d+)?)\s*bedrooms?\b/i) || d.match(/(\d+(?:\.\d+)?)\s*bedrooms?\b/i) || [])[1]) ??
        null;

    let beds =
        firstNumber((text.match(/(\d+(?:\.\d+)?)\s*beds?\b/i) || d.match(/(\d+(?:\.\d+)?)\s*beds?\b/i) || [])[1]) ??
        null;

    let bathrooms =
        firstNumber((text.match(/(\d+(?:\.\d+)?)\s*bath(?:room)?s?\b/i) || d.match(/(\d+(?:\.\d+)?)\s*bath(?:room)?s?\b/i) || [])[1]) ??
        null;

let guestsMax =
  firstNumber((text.match(/(\d{1,2})\s*guests?\b/i) || d.match(/(\d{1,2})\s*guests?\b/i) || [])[1]) ?? null;
    // "Entire home in City, State" (exact street address is not exposed pre-booking)
    // ✅ Airbnb location: parse safely from JSON-ish HTML (avoid grabbing huge tail)
    let city = "";
    let state = "";

    function inferCityStateFromTitle(title) {
        const t = String(title || "").replace(/\s+/g, " ").trim();
        if (!t) return { city: "", state: "" };

        // common Brazil pattern: "... Santa Isabel - SP"
        const m = t.match(/(.+?)\s*[-—]\s*([A-Z]{2,3})\s*$/);
        if (!m) return { city: "", state: "" };

        const stateCode = m[2].trim();
        const left = m[1].trim();

        // take last 2-3 words as city (works well for "Santa Isabel")
        const words = left.split(" ").filter(Boolean);
        const city = words.slice(-3).join(" ").trim();

        if (!city || city.length < 2) return { city: "", state: "" };
        return { city, state: stateCode }; // keep "SP" etc (UI can show "Santa Isabel, SP")
    }

    function inferGuestsMaxFromHtml(html) {
        const s = String(html || "");

        // Try JSON-ish numeric capacities
        const m =
            s.match(/"personCapacity"\s*:\s*(\d{1,2})/i) ||
            s.match(/"maxGuestCapacity"\s*:\s*(\d{1,2})/i) ||
            s.match(/"guestCapacity"\s*:\s*(\d{1,2})/i);
        if (m?.[1]) return Number(m[1]) || null;

        // Try "16+ guests" style
        const plus = s.match(/(\d{1,2})\s*\+\s*guests/i);
        if (plus?.[1]) return Number(plus[1]) || null;

        return null;
    }

    function cleanPlaceToken(v) {
        let s = String(v || "").trim();
        if (!s) return "";
        // cut at obvious separators if any
        s = s.split('"')[0];
        s = s.split("•")[0];
        s = s.split("·")[0];
        s = s.split("|")[0];
        s = s.replace(/\s+/g, " ").trim();
        if (/[{}[\]<>]/.test(s)) return "";
        if (s.length > 60) s = s.slice(0, 60).trim();
        return s;
    }

    function looksLikePlace(s, kind = "city") {
        const v = String(s || "").trim();
        if (!v) return false;

        // too long / too many words => likely description fragments
        const words = v.split(/\s+/).filter(Boolean);
        if (kind === "state" && words.length > 4) return false;
        if (kind === "city" && words.length > 6) return false;

        // must contain letters, no obvious junk
        if (!/[A-Za-zÀ-ÿ]/.test(v)) return false;
        if (/\d/.test(v)) return false;

        const bad = /(parking|swimming|pool|kitchen|wifi|barbecue|bbq|bedroom|bathroom|guests|reviews|check-?in|check-?out|community)/i;
        if (bad.test(v)) return false;

        // phrases like "a gated community..." are not cities
        if (/^(a|an|the)\s+/i.test(v)) return false;

        return true;
    }

    // ✅ Prefer localizedCityName/localizedStateName FIRST (more reliable)
    const pair =
        (html || "").match(/"localizedCityName"\s*:\s*"([^"]{1,80})"[\s\S]{0,160}"localizedStateName"\s*:\s*"([^"]{1,80})"/i) ||
        (html || "").match(/"localizedCityName"\s*:\s*"([^"]{1,80})"[\s\S]{0,160}"localizedCountryName"\s*:\s*"([^"]{1,80})"/i) ||
        (html || "").match(/"city"\s*:\s*"([^"]{1,80})"[\s\S]{0,160}"state"\s*:\s*"([^"]{1,80})"/i);

    if (pair) {
        const c = cleanPlaceToken(pair[1]);
        const s = cleanPlaceToken(pair[2]);

        // ✅ accept only if looks like a place, else ignore (prevents your exact bug)
        if (looksLikePlace(c, "city")) city = c;
        if (looksLikePlace(s, "state")) state = s;

        // if one is junk, drop both to avoid misleading UI
        if ((city && !looksLikePlace(city, "city")) || (state && !looksLikePlace(state, "state"))) {
            city = "";
            state = "";
        }
    }

    // fallback loc branch – older pattern that sometimes appears on Airbnb pages
    if (!city && !state) {
        const loc = (html || "").match(/Entire home in ([^,]+),\s*([^<]+)/i);
        if (loc) {
            const c = cleanPlaceToken(loc[1]);
            const s = cleanPlaceToken(loc[2]);
            if (looksLikePlace(c, "city")) city = c;
            if (looksLikePlace(s, "state")) state = s;
        }
    }

    // --- fallback: if city/state missing, infer from og:title or title tag ---
    if (!city && !state) {
        const ogTitle =
            (String(html || "").match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1]) ||
            (String(html || "").match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]) ||
            "";

        const inferred = inferCityStateFromTitle(ogTitle);
        if (inferred.city && inferred.state) {
            city = inferred.city;
            state = inferred.state;
        }
    }

    // --- fallback: guestsMax ---
    if (!guestsMax) {
        const g = inferGuestsMaxFromHtml(html);
        if (g) guestsMax = g;
    }


    return { bedrooms, beds, bathrooms, guestsMax, city, state };
}


function detectSource(url) {
    const h = new URL(url).hostname.toLowerCase();
    if (h.includes("airbnb.")) return "airbnb";
    if (h.includes("vrbo.")) return "vrbo";
    if (h.includes("booking.")) return "booking";
    if (h.includes("expedia.")) return "expedia";
    if (h.includes("zillow.")) return "zillow";
    if (h.includes("realtor.")) return "realtor";
    if (h.includes("loopnet.")) return "loopnet";
    return h;
}

function redactAddress(full) {
    const s = String(full || "").trim();
    if (!s) return { redacted: "", full: "" };
    const redacted = s.replace(/^\s*\d+[\w\-]*\s+/, "••• ");
    return { redacted, full: s };
}

function pickFromJsonLd(jsonLd) {
    const arr = Array.isArray(jsonLd) ? jsonLd : [jsonLd];
    let best = null;

    for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const types = [];
        const t = item["@type"];
        if (typeof t === "string") types.push(t);
        if (Array.isArray(t)) types.push(...t.filter((x) => typeof x === "string"));

        const score =
            (types.some((x) => /LodgingBusiness|Hotel|Residence|House|Apartment|SingleFamilyResidence/i.test(x)) ? 3 : 0) +
            (types.some((x) => /Product|Offer/i.test(x)) ? 1 : 0);

        if (!best || score > best.score) best = { item, score };
    }
    if (!best) return {};

    const x = best.item;
    const ratingValue = firstNumber(x?.aggregateRating?.ratingValue) ?? firstNumber(x?.ratingValue);
    const reviewCount =
        firstNumber(x?.aggregateRating?.reviewCount) ??
        firstNumber(x?.aggregateRating?.ratingCount) ??
        firstNumber(x?.reviewCount);

    const addressObj = x?.address;
    const addressFull =
        typeof addressObj === "string"
            ? addressObj
            : [addressObj?.streetAddress, addressObj?.addressLocality, addressObj?.addressRegion, addressObj?.postalCode]
                .filter(Boolean)
                .join(", ");

    const img = x?.image;
    let image_url = "";
    if (typeof img === "string") image_url = img.trim();
    else if (Array.isArray(img)) image_url = String(img.find((v) => typeof v === "string") || "").trim();
    else if (img && typeof img === "object") image_url = String(img.url || img["@id"] || "").trim();

    return {
        title: String(x?.name || "").trim(),
        description: String(x?.description || "").trim(),
        rating: ratingValue,
        review_count: reviewCount,
        bedrooms: firstNumber(x?.numberOfRooms) ?? firstNumber(x?.numberOfBedrooms) ?? null,
        bathrooms: firstNumber(x?.numberOfBathroomsTotal) ?? firstNumber(x?.numberOfBathrooms) ?? null,
        address_full: String(addressFull || "").trim(),
        image_url,
    };
}

function deepPickCandidates(obj) {
    const pairs = deepCollect(obj);
    const getByKey = (re) => {
        for (const p of pairs) if (re.test(p.key)) return p.value;
        return null;
    };

    const rating = firstNumber(getByKey(/ratingValue|starRating|stars|avgRating/i)) ?? firstNumber(getByKey(/rating/i));
    const reviewCount =
        firstNumber(getByKey(/reviewCount|reviewsCount|ratingCount|numberOfReviews/i)) ?? firstNumber(getByKey(/reviews/i));

    const bedrooms = firstNumber(getByKey(/bedrooms|beds|bedCount/i));
    const bathrooms = firstNumber(getByKey(/bathrooms|baths|bathCount/i));

    const street = getByKey(/streetAddress|street/i);
    const city = getByKey(/addressLocality|city/i);
    const region = getByKey(/addressRegion|state|region/i);
    const zip = getByKey(/postalCode|zipcode|zip/i);

    const address_full = [street, city, region, zip].filter(Boolean).join(", ");

    return {
        rating: rating ?? null,
        review_count: reviewCount ?? null,
        bedrooms: bedrooms ?? null,
        bathrooms: bathrooms ?? null,
        address_full: String(address_full || "").trim(),
    };
}

async function fetchHtml(url) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 12000);

    try {
        const res = await fetch(url, {
            method: "GET",
            redirect: "follow",
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            signal: controller.signal,
        });

        const ct = String(res.headers.get("content-type") || "");
        const text = await res.text();
        const html = text.length > 1500000 ? text.slice(0, 1500000) : text;
        return { ok: res.ok, status: res.status, contentType: ct, html };
    } finally {
        clearTimeout(t);
    }
}

function parseAirbnbExtras(html) {
    const t = stripHtml(html);

    const bedrooms = firstNumber(t.match(/\b(\d{1,2})\s+bedrooms?\b/i)?.[1]);
    const beds = firstNumber(t.match(/\b(\d{1,2})\s+beds?\b/i)?.[1]);

    // ✅ bathrooms often appears as "6 bathrooms" (or 6.5 baths)

    const bathrooms = firstNumber(t.match(/\b(\d+(?:\.\d+)?)\s*(?:bath|bathroom)s?\b/i)?.[1]);


    const guestsMax = firstNumber(t.match(/\b(\d{1,2})\s+guests?\s+maximum\b/i)?.[1]);

    const checkInTime = (t.match(/\bCheck-?in\s+after\s+([0-9: ]+(?:AM|PM))\b/i)?.[1] || "").trim();
    const checkOutTime = (t.match(/\bCheck-?out\s+before\s+([0-9: ]+(?:AM|PM))\b/i)?.[1] || "").trim();

    let checkInMethod = "";
    if (/\blockbox\b/i.test(t)) checkInMethod = "Self check-in (lockbox)";
    else if (/\bsmart lock\b/i.test(t)) checkInMethod = "Self check-in (smart lock)";

    const amenities = [];
    if (/\bWifi\b/i.test(t)) amenities.push("WiFi");
    if (/\bKitchen\b/i.test(t)) amenities.push("Kitchen");
    if (/\bFree parking\b/i.test(t) || /\bparking on premises\b/i.test(t)) amenities.push("Parking");

    return { bedrooms, beds, bathrooms, guestsMax, checkInTime, checkOutTime, checkInMethod, amenities };
}



async function extractPublicListing(url) {
    const normalized = await validateAndNormalizeUrl(url);
    const absUrl = (u) => absolutizeMaybeUrl(u, normalized);
    const source = detectSource(normalized);

    const { ok, status, contentType, html } = await fetchHtml(normalized);
    if (!ok || !html || html.length < 200) {
        return { ok: false, source, url: normalized, error: `Fetch failed (${status || "unknown"}).` };
    }

    const title =
        pickMeta(html, "og:title") ||
        pickMeta(html, "twitter:title") ||
        stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");

    const description = pickMeta(html, "og:description") || pickMeta(html, "description");

    const ogDesc = pickMeta(html, "og:description") || description || "";

    const metaImages = [
        pickMeta(html, "og:image"),
        pickMeta(html, "og:image:url"),
        pickMeta(html, "og:image:secure_url"),
        pickMeta(html, "twitter:image"),
        pickMeta(html, "twitter:image:src"),
    ].filter(Boolean);

    const seenImg = new Set();
    const images = [];
    for (const u of metaImages) {
        const s = absUrl(u);
        if (!s || seenImg.has(s)) continue;
        seenImg.add(s);
        images.push(s);
    }
    const meta_image_url = images[0] || "";

    // ✅ Airbnb-specific light parsing (no JS needed)
    const airbnbHints = source === "airbnb" ? parseAirbnbHints(html, description) : {};

    // JSON-LD
    const ldScripts = extractScripts(html, { type: "application/ld+json" });
    const ldJson = ldScripts
        .map((s) => tryJsonParse(s))
        .filter(Boolean)
        .flatMap((j) => (Array.isArray(j) ? j : [j]));
    const fromLd = ldJson.length ? pickFromJsonLd(ldJson) : {};

    // __NEXT_DATA__ (Zillow etc)
    const nextDataScripts = extractScripts(html, { id: "__NEXT_DATA__" });
    const nextData = nextDataScripts.length ? tryJsonParse(nextDataScripts[0]) : null;
    const fromNext = nextData ? deepPickCandidates(nextData) : {};

    const fallbackRating = firstNumber(html.match(/rating(?:Value)?\D{0,20}(\d(?:\.\d+)?)/i)?.[1]);
    const fallbackReviews = firstNumber(html.match(/(\d+[\d,]*)\s*(?:reviews|review)/i)?.[1]?.replace(/,/g, ""));

    const airbnbExtra = source === "airbnb" ? parseAirbnbExtras(html) : {};

    let merged = {
        title: fromLd.title || title || "",
        description: fromLd.description || description || "",
        image_url: absUrl(fromLd.image_url || meta_image_url || "") || "",
        images: images,

        rating: fromLd.rating ?? fromNext.rating ?? fallbackRating ?? null,
        review_count: fromLd.review_count ?? fromNext.review_count ?? fallbackReviews ?? null,

        // ✅ Keep both beds + bedrooms (frontend can choose)
        beds: fromNext.beds ?? airbnbExtra.beds ?? airbnbHints.beds ?? null,
        bedrooms: fromLd.bedrooms ?? fromNext.bedrooms ?? airbnbExtra.bedrooms ?? airbnbHints.bedrooms ?? null,

        // ✅ bathrooms: try JSON-LD/Next, then airbnbExtra, then airbnbHints
        bathrooms: fromLd.bathrooms ?? fromNext.bathrooms ?? airbnbExtra.bathrooms ?? airbnbHints.bathrooms ?? null,

        address_full: fromLd.address_full || fromNext.address_full || "",

        // ✅ NEW: carry Airbnb city/state hints through to frontend
        city: airbnbHints.city || fromNext.city || "",
        state: airbnbHints.state || fromNext.state || "",

        guestsMax: airbnbExtra.guestsMax ?? airbnbHints.guestsMax ?? null,
        checkInTime: airbnbExtra.checkInTime || "",
        checkOutTime: airbnbExtra.checkOutTime || "",
        checkInMethod: airbnbExtra.checkInMethod || "",
        amenities: airbnbExtra.amenities || [],
    };

    // ✅ Airbnb fallback: infer city/state from title when hints are missing
    if (source === "airbnb" && (!merged.city || !merged.state)) {
        const inferred = (function inferCityStateFromTitle(t) {
            const s = String(t || "").replace(/\s+/g, " ").trim();
            const m = s.match(/(.+?)\s*[-—]\s*([A-Z]{2,3})\s*$/);
            if (!m) return { city: "", state: "" };

            const stateCode = m[2].trim();
            const left = m[1].trim();

            // Remove very common property-type prefixes (Portuguese + English)
            const cleanedLeft = left
                .replace(/\b(ch[aá]cara|recanto|s[ií]tio|fazenda|casa|apartamento|apartment|house|condo|studio)\b/gi, " ")
                .replace(/\s+/g, " ")
                .trim();

            const words = cleanedLeft.split(" ").filter(Boolean);

            // Prefer last 2 words as "city" (works for "Santa Isabel")
            let city = words.slice(-2).join(" ").trim();

            // If last 2 still contain connector-only junk, broaden a bit
            const badTokens = /^(do|da|de|dos|das|the|of)$/i;
            const cityWords = city.split(" ").filter(Boolean);
            if (cityWords.length && badTokens.test(cityWords[0])) {
                city = words.slice(-3).join(" ").trim();
            }

            if (!city) return { city: "", state: "" };
            return { city, state: stateCode };
        })(merged.title);
        if (!merged.city && inferred.city) merged.city = inferred.city;
        if (!merged.state && inferred.state) merged.state = inferred.state;
    }


    let airbnbArea = "";
    if (source === "airbnb" && ogDesc) {
        const a = parseAirbnbOgSummary(ogDesc);
        airbnbArea = a.area || "";

        if (merged.bedrooms == null && a.bedrooms != null) merged.bedrooms = a.bedrooms;
        if (merged.bathrooms == null && a.bathrooms != null) merged.bathrooms = a.bathrooms;
        if (merged.guestsMax == null && a.guestsMax != null) merged.guestsMax = a.guestsMax;
        if (merged.beds == null && a.beds != null) merged.beds = a.beds;

    }

    // ✅ fallback: if city/state missing, try parse from og area like "Pompano Beach, FL"
    if (source === "airbnb" && airbnbArea && (!merged.city || !merged.state)) {
        const cs = parseCityStateFromArea(airbnbArea);
        if (!merged.city && cs.city) merged.city = cs.city;
        if (!merged.state && cs.state) merged.state = cs.state;
    }


    // Airbnb: listing rating may be hidden until 3 reviews; avoid wrong "Rated X ⭐"
    if (source === "airbnb") {
        if (/Average rating will appear after 3 reviews/i.test(stripHtml(html))) {
            merged.rating = null;
        }

        // pick smallest "X review(s)" as listing review count (host may have big numbers)
        const nums = [...stripHtml(html).matchAll(/\b(\d[\d,]*)\s*review\b/gi)]
            .map(m => Number(String(m[1]).replace(/,/g, "")))
            .filter(n => Number.isFinite(n));
        if (nums.length) merged.review_count = Math.min(...nums);
    }



    const addr = redactAddress(merged.address_full);
    const address_full = addr.full || ""; // only real address if present
    const address_redacted = addr.redacted || airbnbArea || ""; // area-level fallback for Airbnb

    return {
        ok: true,
        source,
        url: normalized,
        content_type: contentType,

        extracted: {
            title: merged.title,
            description: merged.description,
            image_url: merged.image_url || "",
            images: Array.isArray(merged.images) ? merged.images : [],
            rating: merged.rating,
            review_count: merged.review_count,
            bedrooms: merged.bedrooms,
            bathrooms: merged.bathrooms,
            beds: merged.beds,
            guestsMax: merged.guestsMax,
            checkInTime: merged.checkInTime,
            checkOutTime: merged.checkOutTime,
            checkInMethod: merged.checkInMethod,
            amenities: merged.amenities,
            city: merged.city,
            state: merged.state,
            location: [merged.city, merged.state].filter(Boolean).join(", ") || address_redacted || "",
            address_redacted,
            address_full,
        },
        warnings: [
            "Some sites (Airbnb/Booking) may block server fetch. If fields are empty, ask the user to paste rating/reviews manually.",
        ],
    };


}


/* -------------------- Pro profile extraction (ratings/reviews) -------------------- */

function detectProSource(url) {
  const h = String(url || "").toLowerCase();
  if (h.includes("yelp.com")) return "yelp";
  if (h.includes("google.com") || h.includes("g.page")) return "google";
  if (h.includes("nextdoor.com")) return "nextdoor";
  if (h.includes("thumbtack.com")) return "thumbtack";
  if (h.includes("angi.com") || h.includes("homeadvisor.com")) return "angi";
  if (h.includes("taskrabbit.com")) return "taskrabbit";
  if (h.includes("houzz.com")) return "houzz";
  if (h.includes("porch.com")) return "porch";
  return "pro";
}

function toNum(v) {
  const n = firstNumber(v);
  return (n != null && Number.isFinite(n)) ? n : null;
}

function pickImage(v, baseUrl) {
  if (!v) return "";
  if (typeof v === "string") return absolutizeMaybeUrl(v, baseUrl);
  if (Array.isArray(v) && v.length) return absolutizeMaybeUrl(v[0], baseUrl);
  if (typeof v === "object") return absolutizeMaybeUrl(v.url || v.contentUrl || v["@id"] || "", baseUrl);
  return "";
}

function extractAggFromObj(obj) {
  if (!obj || typeof obj !== "object") return null;

  const ar = obj.aggregateRating || obj.aggregate_rating || null;
  if (ar && typeof ar === "object") {
    const rating = toNum(ar.ratingValue || ar.rating_value || ar.value);
    const review_count = toNum(ar.reviewCount || ar.review_count || ar.ratingCount || ar.rating_count);
    if (rating != null || review_count != null) return { rating, review_count };
  }

  const rr = obj.reviewRating || obj.review_rating || null;
  if (rr && typeof rr === "object") {
    const rating = toNum(rr.ratingValue || rr.rating_value);
    if (rating != null) return { rating, review_count: null };
  }

  return null;
}

function extractFromLdJson(html, baseUrl) {
  const scripts = extractScripts(html, { type: "application/ld+json" });
  let best = { name: "", rating: null, review_count: null, image_url: "" };

  const consider = (o) => {
    if (!o || typeof o !== "object") return;

    const t = o["@type"];
    const typeStr = Array.isArray(t) ? t.join(",") : String(t || "");
    const isBiz = /(LocalBusiness|Organization|ProfessionalService|HomeAndConstructionBusiness|Plumber|Electrician|HVACBusiness|MovingCompany|Contractor|Locksmith|CleaningService|HousePainter|RealEstateAgent)/i.test(typeStr);

    const name = unescapeHtml(o.name || "");
    const img = pickImage(o.image || o.logo, baseUrl);
    const agg = extractAggFromObj(o);

    const score =
      (isBiz ? 10 : 0) +
      (agg && agg.rating != null ? 6 : 0) +
      (agg && agg.review_count != null ? 3 : 0) +
      (name ? 1 : 0) +
      (img ? 1 : 0);

    const curScore = (best._score || 0);

    if (score > curScore) {
      best = {
        name: name || best.name,
        rating: agg ? agg.rating : best.rating,
        review_count: agg ? agg.review_count : best.review_count,
        image_url: img || best.image_url,
        _score: score,
      };
    }
  };

  for (const body of scripts) {
    const parsed = tryJsonParse(body);
    if (!parsed) continue;

    const arr = Array.isArray(parsed) ? parsed : [parsed];
    for (const it of arr) {
      if (!it) continue;
      if (Array.isArray(it["@graph"])) {
        for (const g of it["@graph"]) consider(g);
      }
      consider(it);
    }
  }

  return best;
}

function extractAggFromHtmlText(html) {
  const s = String(html || "");
  const r1 =
    s.match(/"ratingValue"\s*:\s*"?(?<r>\d+(?:\.\d+)?)"?/i) ||
    s.match(/\b(?<r>\d\.\d)\s*\/\s*5\b/i);

  const r2 =
    s.match(/"reviewCount"\s*:\s*"?(?<c>[\d,]+)"?/i) ||
    s.match(/"ratingCount"\s*:\s*"?(?<c>[\d,]+)"?/i);

  const rating = r1?.groups?.r ? Number(r1.groups.r) : null;
  const review_count = r2?.groups?.c ? Number(String(r2.groups.c).replace(/,/g, "")) : null;

  return {
    rating: Number.isFinite(rating) ? rating : null,
    review_count: Number.isFinite(review_count) ? review_count : null,
  };
}

async function extractPublicProProfile(url) {
  const normalized = await validateAndNormalizeUrl(url);
  const source = detectProSource(normalized);

  const { ok, status, contentType, html } = await fetchHtml(normalized);
  if (!ok || !html || html.length < 200) {
    return { ok: false, source, url: normalized, error: `Fetch failed (${status || "unknown"}).` };
  }

  const ogTitle = pickMeta(html, "og:title") || pickMeta(html, "twitter:title");
  const pageTitle = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const metaDesc = pickMeta(html, "og:description") || pickMeta(html, "description");

  const ld = extractFromLdJson(html, normalized);
  const aggFallback = extractAggFromHtmlText(html);

  const name = String(ld.name || ogTitle || pageTitle || "").trim().slice(0, 120);
  const rating = (ld.rating != null ? ld.rating : aggFallback.rating);
  const review_count = (ld.review_count != null ? ld.review_count : aggFallback.review_count);

  const image_url =
    String(ld.image_url || pickMeta(html, "og:image") || pickMeta(html, "twitter:image") || "").trim();

  return {
    ok: true,
    source,
    url: normalized,
    content_type: contentType,
    extracted: {
      name,
      rating: (rating != null && Number.isFinite(rating)) ? rating : null,
      review_count: (review_count != null && Number.isFinite(review_count)) ? review_count : null,
      image_url: absolutizeMaybeUrl(image_url, normalized) || "",
      description: String(metaDesc || "").trim().slice(0, 300),
    },
    warnings: [
      "Some sites may block server reads. If fields are empty, ask the pro to paste rating/reviews manually.",
      "Jobs/spend are usually not public; collect manually or derive from your platform activity.",
    ],
  };
}

module.exports = { extractPublicListing, extractPublicProProfile };
