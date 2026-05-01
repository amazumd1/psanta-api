const fetch = require("node-fetch");
const dns = require("dns").promises;
const net = require("net");

const PUBLIC_EXTRACT_VERSION = "airbnb-ff-redfin-direct-2026-04-30-v10";

// Safer-by-default allowlist (add more if needed)
const ALLOW_HOST_SUFFIXES = [
    // STR / property listing sources
    "airbnb.com",
    "vrbo.com",
    "expedia.com",
    "booking.com",
    "hotels.com",
    "hotel.com",
    "hilton.com",

    // Furnished / monthly / residential sources
    "furnishedfinder.com",
    "zillow.com",
    "realtor.com",
    "apartments.com",
    "redfin.com",
    "trulia.com",
    "homes.com",

    // Commercial listing sources
    "loopnet.com",
    "crexi.com",
    "costar.com",

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


const LISTING_SOURCE_RULES = [
    { source: "airbnb", label: "Airbnb", type: "short_term", typeLabel: "Short-term rental", family: "STR", match: ["airbnb.com"] },
    { source: "vrbo", label: "VRBO", type: "short_term", typeLabel: "Short-term rental", family: "STR", match: ["vrbo.com"] },
    { source: "booking", label: "Booking.com", type: "short_term", typeLabel: "Short-term rental", family: "STR", match: ["booking.com"] },
    { source: "expedia", label: "Expedia", type: "short_term", typeLabel: "Short-term rental", family: "STR", match: ["expedia.com"] },
    { source: "hotels", label: "Hotels.com", type: "short_term", typeLabel: "Short-term rental", family: "STR", match: ["hotels.com", "hotel.com", "hilton.com"] },

    { source: "furnishedfinder", label: "Furnished Finder", type: "furnished_30_plus", typeLabel: "Furnished 30-day+ rental", family: "Monthly furnished", match: ["furnishedfinder.com"] },

    { source: "zillow", label: "Zillow", type: "long_term", typeLabel: "Long-term residential rental", family: "Residential", match: ["zillow.com"] },
    { source: "realtor", label: "Realtor.com", type: "long_term", typeLabel: "Long-term residential rental", family: "Residential", match: ["realtor.com"] },
    { source: "apartments", label: "Apartments.com", type: "long_term", typeLabel: "Long-term residential rental", family: "Residential", match: ["apartments.com"] },
    { source: "redfin", label: "Redfin", type: "long_term", typeLabel: "Long-term residential rental", family: "Residential", match: ["redfin.com"] },
    { source: "trulia", label: "Trulia", type: "long_term", typeLabel: "Long-term residential rental", family: "Residential", match: ["trulia.com"] },
    { source: "homes", label: "Homes.com", type: "long_term", typeLabel: "Long-term residential rental", family: "Residential", match: ["homes.com"] },

    { source: "loopnet", label: "LoopNet", type: "commercial", typeLabel: "Commercial listing", family: "Commercial", match: ["loopnet.com"] },
    { source: "crexi", label: "CREXI", type: "commercial", typeLabel: "Commercial listing", family: "Commercial", match: ["crexi.com"] },
    { source: "costar", label: "CoStar", type: "commercial", typeLabel: "Commercial listing", family: "Commercial", match: ["costar.com"] },
];

function hostnameFromUrl(url) {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
        return "";
    }
}

function getListingSourceInfo(url) {
    const host = hostnameFromUrl(url);

    const rule = LISTING_SOURCE_RULES.find((r) =>
        r.match.some((d) => host === d || host.endsWith(`.${d}`))
    );

    if (!rule) {
        return {
            source: host || "unknown",
            sourceLabel: host || "Public listing",
            sourceDomain: host,
            listingType: "unknown",
            listingTypeLabel: "Listing type not detected",
            sourceFamily: "Unknown",
        };
    }

    return {
        source: rule.source,
        sourceLabel: rule.label,
        sourceDomain: host,
        listingType: rule.type,
        listingTypeLabel: rule.typeLabel,
        sourceFamily: rule.family,
    };
}

function detectSource(url) {
    return getListingSourceInfo(url).source;
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
        return { ok: res.ok, status: res.status, contentType: ct, html, finalUrl: res.url || url };
    } finally {
        clearTimeout(t);
    }
}

async function fetchReaderText(url) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 14000);

    try {
        const readerUrl = `https://r.jina.ai/${url}`;

        const res = await fetch(readerUrl, {
            method: "GET",
            redirect: "follow",
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
                Accept: "text/plain,text/markdown,*/*",
                "Accept-Language": "en-US,en;q=0.9",
            },
            signal: controller.signal,
        });

        const ct = String(res.headers.get("content-type") || "");
        const text = await res.text();
        const html = text.length > 1500000 ? text.slice(0, 1500000) : text;

        return {
            ok: res.ok,
            status: res.status,
            contentType: ct || "text/plain",
            html,
            viaReader: true,
        };
    } catch (e) {
        return {
            ok: false,
            status: "reader_error",
            contentType: "",
            html: "",
            error: e?.message || "Reader fetch failed",
            viaReader: true,
        };
    } finally {
        clearTimeout(t);
    }
}

function listingTextLooksBlocked(html) {
    const t = stripHtml(html || "").replace(/\s+/g, " ").trim();
    if (!t) return false;

    return /\bpx[-_]?captcha\b/i.test(t) ||
        /access\s+to\s+this\s+page\s+has\s+been\s+denied/i.test(t) ||
        /verify\s+you\s+are\s+a\s+human/i.test(t) ||
        /unusual\s+traffic/i.test(t) ||
        /captcha/i.test(t);
}

function bookingTextLooksBlocked(html) {
    const t = stripHtml(html || "").replace(/\s+/g, " ").trim();
    if (!t) return false;

    return /javascript\s+is\s+disabled/i.test(t) ||
        /enable\s+javascript/i.test(t) ||
        /verify\s+that\s+you(?:'|’)re\s+not\s+a\s+robot/i.test(t) ||
        /not\s+a\s+robot/i.test(t) ||
        /automated\s+traffic/i.test(t) ||
        (/booking\.com\s+is\s+part\s+of\s+booking\s+holdings/i.test(t) && /javascript/i.test(t));
}

function parseBookingHotelNameFromUrl(url) {
    let u;
    try {
        u = new URL(url);
    } catch {
        return "";
    }

    const path = decodeURIComponent(u.pathname || "");
    const file = path.split("/").filter(Boolean).pop() || "";
    const slug = file
        .replace(/\.(?:html?|aspx?)$/i, "")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    if (!slug || /^share/i.test(slug)) return "";

    let name = titleCaseSlugPart(slug);

    if (name && !/\b(hotel|inn|suites|resort|hostel|motel|apartments?)\b/i.test(name)) {
        name = `${name} Hotel`;
    }

    return name;
}

function getDelimitedValue(text, key) {
    const safe = String(key || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = String(text || "").match(new RegExp(`${safe}::([\\s\\S]*?)::`, "i"));
    return m ? String(m[1] || "").replace(/\s+/g, " ").trim() : "";
}

function cleanBookingTitle(rawTitle) {
    let title = String(rawTitle || "").replace(/\s+/g, " ").trim();
    if (!title) return "";

    title = title.replace(/\s*\([^)]*prices?[^)]*\)\s*/gi, " ").trim();
    title = title.replace(/\s*\([^)]*updated[^)]*\)\s*/gi, " ").trim();
    title = title.replace(/\s*,\s*(?:updated\s+prices?.*)$/i, "").trim();

    const commaParts = title.split(",").map((x) => x.trim()).filter(Boolean);
    if (commaParts.length > 1) return commaParts[0];

    return title;
}

function parseBookingSerpApiHints(rawText) {
    const s = String(rawText || "").replace(/\s+/g, " ").trim();
    const out = {};
    if (!s) return out;

    const rawTitle = getDelimitedValue(s, "SERP_PRIMARY_TITLE");
    const link = getDelimitedValue(s, "SERP_PRIMARY_LINK");
    const snippet = getDelimitedValue(s, "SERP_PRIMARY_SNIPPET");
    const thumbnail = getDelimitedValue(s, "SERP_PRIMARY_THUMBNAIL");

    // If we did not find a precise Booking hotel result, do not use generic
    // Booking homepage/search result data.
    if (!rawTitle || !link || /\/hotel\/index\.html/i.test(link) || /book\s+last-minute\s+hotels/i.test(rawTitle)) {
        return {};
    }

    const cleanedTitle = cleanBookingTitle(rawTitle);

    if (cleanedTitle) out.title = cleanedTitle;
    if (snippet) out.description = snippet.trim();

    if (thumbnail) {
        out.image_url = thumbnail;
        out.images = [thumbnail];
    }

    out.propertyType = "hotel";

    const cityFromTitle =
        String(rawTitle || "").match(/,\s*([^,(]+)\s*(?:\(|$)/)?.[1]?.trim() ||
        "";

    if (cityFromTitle && /^[A-Za-z .'-]{2,60}$/.test(cityFromTitle)) {
        out.city = titleCaseSlugPart(cityFromTitle);
    }

    const reviewMatch =
        s.match(/\b([\d,]+)\s+Verified\s+Hotel\s+Reviews\b/i) ||
        s.match(/\b([\d,]+)\s+reviews?\b/i);

    if (reviewMatch?.[1]) {
        const n = Number(String(reviewMatch[1]).replace(/,/g, ""));
        if (Number.isFinite(n) && n > 0) out.review_count = n;
    }

    const ratingMatch =
        s.match(/\bScored\s+(\d(?:\.\d)?)\b/i) ||
        s.match(/\b(\d(?:\.\d)?)\s*\/\s*10\b/i);

    if (ratingMatch?.[1]) {
        const n = Number(ratingMatch[1]);
        if (Number.isFinite(n)) out.rating = n;
    }

    const amenities = [];
    if (/\bfree\s+wifi\b|\bwifi\b|\bwi-fi\b/i.test(snippet)) amenities.push("WiFi");
    if (/\bkitchen\b/i.test(snippet)) amenities.push("Kitchen");
    if (/\bparking\b/i.test(snippet)) amenities.push("Parking");
    if (amenities.length) out.amenities = amenities;

    if (link) out.platformListingId = link;

    // Important: never treat Booking hotel SERP price as monthly/rent.
    delete out.monthlyPrice;
    delete out.rentOrPrice;
    delete out.propertyUse;
    delete out.leaseOrSale;

    return out;
}

function parseVrboIdsFromUrl(url) {
    let u;
    try {
        u = new URL(url);
    } catch {
        return {};
    }

    const path = decodeURIComponent(u.pathname || "");
    const propertyId = path.match(/\/(\d{4,})(?:\/|$)/)?.[1] || "";
    const expediaPropertyId = u.searchParams.get("expediaPropertyId") || "";

    return { propertyId, expediaPropertyId };
}

function cleanVrboTitle(rawTitle) {
    let title = String(rawTitle || "").replace(/\s+/g, " ").trim();
    if (!title) return "";

    title = title.replace(/\s*\|\s*Vrbo\s*$/i, "").trim();
    title = title.replace(/\s*-\s*Vrbo\s*$/i, "").trim();
    title = title.replace(/\s*,\s*US\s*$/i, "").trim();

    return title;
}

function parseVrboSerpApiHints(rawText) {
    const s = String(rawText || "").replace(/\s+/g, " ").trim();
    const out = {};
    if (!s) return out;

    const rawTitle = getDelimitedValue(s, "SERP_PRIMARY_TITLE");
    const link = getDelimitedValue(s, "SERP_PRIMARY_LINK");
    const snippet = getDelimitedValue(s, "SERP_PRIMARY_SNIPPET");
    const thumbnail = getDelimitedValue(s, "SERP_PRIMARY_THUMBNAIL");

    // Important: only trust the exact primary VRBO listing result.
    // Do not parse the whole SERP text, because unrelated results contaminate
    // bedrooms/city/amenities.
    if (!rawTitle || !link || !/vrbo\.com\/\d+/i.test(link)) {
        return {};
    }

    const title = cleanVrboTitle(rawTitle);

    if (title) out.title = title;
    if (snippet) out.description = snippet.trim();

    if (thumbnail) {
        out.image_url = thumbnail;
        out.images = [thumbnail];
    }

    const ids = parseVrboIdsFromUrl(link);
    if (ids.propertyId) out.platformListingId = ids.propertyId;
    else if (ids.expediaPropertyId) out.platformListingId = ids.expediaPropertyId;

    // Only parse facts from title + primary snippet, not the whole search page.
    const primaryText = `${rawTitle} ${snippet}`.replace(/\s+/g, " ").trim();

    const guests =
        firstNumber(primaryText.match(/\b(?:sleeps|sleeping|guests?)\D{0,12}(\d{1,2})\b/i)?.[1]) ??
        firstNumber(primaryText.match(/\b(\d{1,2})\s+guests?\b/i)?.[1]);

    const bedrooms =
        firstNumber(primaryText.match(/\b(\d+(?:\.\d+)?)\s*(?:bedrooms?|br|bd)\b/i)?.[1]);

    const beds =
        firstNumber(primaryText.match(/\b(\d+(?:\.\d+)?)\s*beds?\b/i)?.[1]);

    const bathrooms =
        firstNumber(primaryText.match(/\b(\d+(?:\.\d+)?)\s*(?:bathrooms?|baths?|ba)\b/i)?.[1]);

    if (guests != null && guests > 0 && guests <= 30) out.guestsMax = guests;
    if (bedrooms != null && bedrooms >= 0 && bedrooms <= 20) out.bedrooms = bedrooms;
    if (beds != null && beds >= 0 && beds <= 40) out.beds = beds;
    if (bathrooms != null && bathrooms >= 0 && bathrooms <= 20) out.bathrooms = bathrooms;

    const rating =
        firstNumber(primaryText.match(/\b(\d+(?:\.\d+)?)\s+out\s+of\s+10\b/i)?.[1]) ??
        firstNumber(primaryText.match(/\b(\d+(?:\.\d+)?)\s*(?:out of|\/)\s*5\b/i)?.[1]);

    if (rating != null) out.rating = rating;

    const reviewCount =
        firstNumber(primaryText.match(/\b([\d,]+)\s+(?:verified\s+)?reviews?\b/i)?.[1]);

    if (reviewCount != null) out.review_count = reviewCount;

    if (/\bentire home\b/i.test(primaryText)) out.propertyType = "house";
    else if (/\bcottage\b/i.test(primaryText)) out.propertyType = "house";
    else if (/\bhouse\b|\bhome\b/i.test(primaryText)) out.propertyType = "house";
    else if (/\bcondo\b/i.test(primaryText)) out.propertyType = "condo";
    else if (/\bapartment\b/i.test(primaryText)) out.propertyType = "apartment";
    else if (/\bcabin\b/i.test(primaryText)) out.propertyType = "cabin";
    else if (/\bvilla\b/i.test(primaryText)) out.propertyType = "villa";

    // Safe city extraction from exact title only:
    // "NEW! Scandinavian Cottage in Duke~King Bed - Durham"
    const titleCity = String(rawTitle || "").match(/\s-\s*([A-Za-z .'-]{2,50})\s*$/)?.[1]?.trim() || "";
    if (titleCity && !/vrbo|vacation|rental|home|house|cottage|condo|apartment/i.test(titleCity)) {
        out.city = titleCaseSlugPart(titleCity);
    }

    const exactCityState =
        primaryText.match(/\b([A-Z][A-Za-z .'-]{2,40}),\s*(NC|FL|CA|TX|NY|GA|SC|VA|TN|AZ|CO|WA|OR|IL|MA|PA|OH|MI|MD|NJ)\b/i);

    if (exactCityState) {
        out.city = titleCaseSlugPart(exactCityState[1]);
        out.state = exactCityState[2].toUpperCase();
    }

    const amenities = [];
    if (/\bwifi\b|\bwi-fi\b/i.test(primaryText)) amenities.push("WiFi");
    if (/\bkitchen\b/i.test(primaryText)) amenities.push("Kitchen");
    if (/\bwasher\b/i.test(primaryText)) amenities.push("Washer");
    if (/\bdryer\b/i.test(primaryText)) amenities.push("Dryer");
    if (/\bparking\b/i.test(primaryText)) amenities.push("Parking");
    if (/\bpool\b/i.test(primaryText)) amenities.push("Pool");
    if (/\bpet friendly\b|\bdog-friendly\b|\bpets?\b/i.test(primaryText)) amenities.push("Pet friendly");
    if (/\bair conditioning\b|\bac\b/i.test(primaryText)) amenities.push("Air conditioning");
    if (/\boutdoor space\b|\bbalcony\b|\bpatio\b/i.test(primaryText)) amenities.push("Outdoor Space");

    if (amenities.length) out.amenities = [...new Set(amenities)];

    return out;
}

function buildListingSearchFallbackQuery(url, sourceInfo = {}) {
    const hints = parseListingHintsFromUrl(url, sourceInfo);
    const address = String(hints.address_full || "").replace(/\s+/g, " ").trim();
    const listingId = String(hints.platformListingId || "").trim();

    if (sourceInfo.source === "zillow" && address) {
        return [
            `"${address}"`,
            "Zillow",
            sourceInfo.listingType === "long_term" ? "rent beds baths price" : "listing beds baths price",
            listingId,
        ]
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
    }

    if (sourceInfo.source === "booking") {
        const hotelName = parseBookingHotelNameFromUrl(url);

        return [
            hotelName || String(url || ""),
            "Booking.com hotel",
        ]
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
    }

    if (sourceInfo.source === "vrbo") {
        const ids = parseVrboIdsFromUrl(url);

        return [
            "VRBO",
            ids.propertyId || ids.expediaPropertyId || String(url || ""),
            "vacation rental",
        ]
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
    }

    const parts = [];
    if (address) parts.push(address);
    else parts.push(String(url || ""));

    if (sourceInfo.sourceLabel) parts.push(sourceInfo.sourceLabel);
    if (sourceInfo.listingType === "long_term") parts.push("rent beds baths price");
    else parts.push("listing beds baths price");
    if (listingId) parts.push(listingId);

    return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function stringifySerpApiValue(value) {
    if (value == null) return "";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch {
        return "";
    }
}

function serpApiJsonToListingText(json) {
    const lines = [];

    const pushObjFields = (label, obj, fields = []) => {
        if (!obj || typeof obj !== "object") return;
        lines.push(label);
        for (const key of fields) {
            const val = stringifySerpApiValue(obj[key]);
            if (val) lines.push(`${key}: ${val}`);
        }
    };

    pushObjFields("ANSWER_BOX", json?.answer_box, [
        "title",
        "answer",
        "snippet",
        "snippet_highlighted_words",
        "displayed_link",
        "link",
    ]);

    pushObjFields("KNOWLEDGE_GRAPH", json?.knowledge_graph, [
        "title",
        "description",
        "type",
        "address",
        "price",
        "rating",
    ]);

    const organic = Array.isArray(json?.organic_results) ? json.organic_results : [];

    const primary =
        organic.find((r) => {
            const source = String(r?.source || "");
            const link = String(r?.link || "");
            const title = String(r?.title || "");

            return /Booking\.com/i.test(source) &&
                /booking\.com\/hotel\//i.test(link) &&
                !/\/hotel\/index\.html/i.test(link) &&
                !/book\s+last-minute\s+hotels/i.test(title);
        }) ||
        organic.find((r) => {
            const source = String(r?.source || "");
            const link = String(r?.link || "");
            const title = String(r?.title || "");

            return (/Vrbo|VRBO/i.test(source) || /vrbo\.com/i.test(link)) &&
                /vrbo\.com\/\d+/i.test(link) &&
                !/search|vacation-rentals|travel/i.test(link) &&
                !/search/i.test(title);
        });

    if (primary) {
        lines.push("SERP_PRIMARY_RESULT");

        for (const key of ["title", "source", "link", "snippet", "thumbnail"]) {
            const val = stringifySerpApiValue(primary[key]);
            if (val) lines.push(`SERP_PRIMARY_${key.toUpperCase()}::${val}::`);
        }
    }

    for (let i = 0; i < organic.length; i += 1) {
        const r = organic[i];
        if (!r || typeof r !== "object") continue;

        lines.push(`ORGANIC_RESULT_${i + 1}`);
        for (const key of ["title", "source", "displayed_link", "link", "snippet", "thumbnail"]) {
            const val = stringifySerpApiValue(r[key]);
            if (val) lines.push(`${key}: ${val}`);
        }

        const richSnippet = stringifySerpApiValue(r.rich_snippet);
        if (richSnippet) lines.push(`rich_snippet: ${richSnippet}`);

        const sitelinks = stringifySerpApiValue(r.sitelinks);
        if (sitelinks) lines.push(`sitelinks: ${sitelinks}`);
    }

    return lines.join("\n").replace(/\s+/g, " ").trim();
}

function buildSerpApiQueries(baseQuery) {
    const q = String(baseQuery || "").replace(/\s+/g, " ").trim();
    if (!q) return [];

    const queries = [q];

    const quotedAddress = q.match(/"([^"]+)"/)?.[1] || "";
    if (quotedAddress) {
        queries.push(`"${quotedAddress}" "for rent"`);
        queries.push(`"${quotedAddress}"`);
    }

    return [...new Set(queries)].slice(0, 3);
}

async function fetchSearchFallbackText(query) {
    const apiKey = String(process.env.SERPAPI_KEY || "").trim();
    const queries = buildSerpApiQueries(query);

    if (!queries.length) {
        return { ok: false, status: "empty_query", contentType: "", html: "", viaSearchFallback: true };
    }

    if (!apiKey) {
        return {
            ok: false,
            status: "missing_serpapi_key",
            contentType: "",
            html: "",
            error: "Missing SERPAPI_KEY environment variable.",
            viaSearchFallback: true,
            viaSerpApiFallback: true,
        };
    }

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 30000);

    try {
        const chunks = [];
        let lastStatus = null;

        for (const q of queries) {
            const params = new URLSearchParams({
                engine: "google",
                google_domain: "google.com",
                gl: "us",
                hl: "en",
                num: "10",
                q,
                api_key: apiKey,
            });

            const res = await fetch(`https://serpapi.com/search.json?${params.toString()}`, {
                method: "GET",
                redirect: "follow",
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
                    Accept: "application/json,text/plain,*/*",
                    "Accept-Language": "en-US,en;q=0.9",
                },
                signal: controller.signal,
            });

            lastStatus = res.status;
            const raw = await res.text();

            if (!res.ok) {
                chunks.push(`SERPAPI_ERROR status:${res.status} query:${q} body:${raw.slice(0, 500)}`);
                continue;
            }

            let json = null;
            try {
                json = JSON.parse(raw);
            } catch {
                chunks.push(raw);
                continue;
            }

            const text = serpApiJsonToListingText(json);
            if (text) chunks.push(`QUERY: ${q}\n${text}`);
        }

        const html = chunks.join("\n\n").replace(/\s+/g, " ").trim();

        return {
            ok: !!html,
            status: lastStatus || 200,
            contentType: "text/plain; charset=utf-8",
            html: html.length > 800000 ? html.slice(0, 800000) : html,
            viaSearchFallback: true,
            viaSerpApiFallback: true,
        };
    } catch (e) {
        return {
            ok: false,
            status: "serpapi_fallback_error",
            contentType: "",
            html: "",
            error: e?.message || "SerpApi fallback failed",
            viaSearchFallback: true,
            viaSerpApiFallback: true,
        };
    } finally {
        clearTimeout(t);
    }
}

function selectAddressFocusedText(rawText, url, sourceInfo = {}) {
    const text = String(rawText || "").replace(/\s+/g, " ").trim();
    if (!text) return "";

    const hints = parseListingHintsFromUrl(url, sourceInfo);
    const address = String(hints.address_full || "").replace(/\s+/g, " ").trim();
    const zpid = String(hints.platformListingId || "").trim();

    const needles = [address, zpid].filter((x) => x && x.length >= 4);
    const lower = text.toLowerCase();

    let idx = -1;

    for (const needle of needles) {
        const n = String(needle).toLowerCase();
        idx = lower.indexOf(n);
        if (idx >= 0) break;
    }

    // If exact address spacing does not match, use first part of street.
    if (idx < 0 && address) {
        const streetStart = address.split(",")[0]?.trim().toLowerCase();
        if (streetStart) idx = lower.indexOf(streetStart);
    }

    if (idx < 0) return text.slice(0, 12000);

    const start = Math.max(0, idx - 1800);
    const end = Math.min(text.length, idx + 7000);
    return text.slice(start, end);
}

function zillowTextLooksThin(html) {
    const t = stripHtml(html || "").replace(/\s+/g, " ").trim();

    if (!t || t.length < 800) return true;

    // Zillow apartment pages should usually contain bd/ba, available units, or rent rows.
    if (/\b\d+(?:\.\d+)?\s*(?:bd|bed|beds|bedroom|bedrooms)\b/i.test(t)) return false;
    if (/\bavailable units\b/i.test(t)) return false;
    if (/\b1\s*bed\s*\$\s*[\d,]+\+/i.test(t)) return false;

    return true;
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

function parseAirbnbPlatformListingId(url) {
    try {
        const u = new URL(url);
        return (
            u.pathname.match(/\/rooms\/(\d+)/i)?.[1] ||
            u.pathname.match(/\/(\d{5,})/i)?.[1] ||
            ""
        );
    } catch {
        return "";
    }
}

function decodeAirbnbHtmlText(html) {
    return String(html || "")
        .replace(/\\u002F/gi, "/")
        .replace(/\\\//g, "/")
        .replace(/\\u0026/gi, "&")
        .replace(/\\u003C/gi, "<")
        .replace(/\\u003E/gi, ">")
        .replace(/\\"/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

function collectAirbnbImagesFromHtml(html, baseUrl) {
    const decoded = decodeAirbnbHtmlText(html);
    const out = [];
    const seen = new Set();

    const add = (raw) => {
        const u = absolutizeMaybeUrl(raw, baseUrl);
        if (!u || seen.has(u)) return;

        // Avoid host/profile/logo assets. Keep actual listing photos.
        if (/AirbnbPlatformAssets-UserProfile/i.test(u)) return;
        if (/(logo|favicon|sprite|icon)/i.test(u)) return;
        if (!/a0\.muscache\.com|muscache|\/pictures\//i.test(u)) return;

        seen.add(u);
        out.push(u);
    };

    for (const meta of [
        pickMeta(html, "og:image"),
        pickMeta(html, "og:image:url"),
        pickMeta(html, "og:image:secure_url"),
        pickMeta(html, "twitter:image"),
        pickMeta(html, "twitter:image:src"),
    ]) {
        add(meta);
    }

    const re = /https?:\/\/[^"'\\\s<>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s<>]*)?/gi;
    let m;

    while ((m = re.exec(decoded))) {
        add(m[0]);
        if (out.length >= 20) break;
    }

    return out.slice(0, 12);
}

function inferAirbnbPropertyType(html, title = "", description = "") {
    const text = `${pickMeta(html, "og:title")} ${title} ${description} ${stripHtml(html)}`
        .replace(/\s+/g, " ")
        .trim();

    // Order matters. "Rental unit" should not become house because description says "home".
    if (/\brental unit\b|\bapartment\b/i.test(text)) return "apartment";
    if (/\bcondo\b/i.test(text)) return "condo";
    if (/\bstudio\b/i.test(text)) return "studio";
    if (/\bcabin\b/i.test(text)) return "cabin";
    if (/\bvilla\b/i.test(text)) return "villa";
    if (/\bentire home\b|\bhouse\b|\bhome\b/i.test(text)) return "house";

    return "";
}

function parseAirbnbDirectHints(html, url, title = "", description = "") {
    const decoded = decodeAirbnbHtmlText(html);
    const text = `${stripHtml(html)} ${decoded}`.replace(/\s+/g, " ").trim();
    const out = {};

    const platformListingId = parseAirbnbPlatformListingId(url);
    if (platformListingId) out.platformListingId = platformListingId;

    const images = collectAirbnbImagesFromHtml(html, url);
    if (images.length) {
        out.image_url = images[0];
        out.images = images;
    }

    const propertyType = inferAirbnbPropertyType(html, title, description);
    if (propertyType) out.propertyType = propertyType;

    const amenities = [];
    if (/\bwifi\b|\bwi-fi\b/i.test(text)) amenities.push("WiFi");
    if (/\bkitchen\b/i.test(text)) amenities.push("Kitchen");
    if (/\bfree parking\b|\bparking\b/i.test(text)) amenities.push("Parking");
    if (/\bwasher\b/i.test(text)) amenities.push("Washer");
    if (/\bdryer\b/i.test(text)) amenities.push("Dryer");
    if (/\bair conditioning\b|\bac\b/i.test(text)) amenities.push("Air conditioning");
    if (/\bheating\b/i.test(text)) amenities.push("Heating");
    if (/\btv\b/i.test(text)) amenities.push("TV");
    if (/\bworkspace\b|\bdedicated workspace\b/i.test(text)) amenities.push("Workspace");
    if (/\bpool\b/i.test(text)) amenities.push("Pool");
    if (/\bhot tub\b/i.test(text)) amenities.push("Hot tub");
    if (/\bbbq\b|\bgrill\b/i.test(text)) amenities.push("BBQ grill");

    if (amenities.length) out.amenities = [...new Set(amenities)];

    if (/\blockbox\b/i.test(text)) out.checkInMethod = "Self check-in (lockbox)";
    else if (/\bsmart lock\b/i.test(text)) out.checkInMethod = "Self check-in (smart lock)";
    else if (/\bself check-in\b/i.test(text)) out.checkInMethod = "Self check-in";

    const checkInTime = text.match(/\bCheck-?in\s+after\s+([0-9: ]+(?:AM|PM))\b/i)?.[1]?.trim() || "";
    const checkOutTime = text.match(/\bCheck-?out\s+before\s+([0-9: ]+(?:AM|PM))\b/i)?.[1]?.trim() || "";

    if (checkInTime) out.checkInTime = checkInTime;
    if (checkOutTime) out.checkOutTime = checkOutTime;

    return out;
}

function parseMoneyValue(raw) {
    const s = String(raw || "").replace(/,/g, "");
    const m = s.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
    if (!m?.[1]) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
}

function moneyNear(text, patterns) {
    const s = String(text || "").replace(/\s+/g, " ");
    for (const re of patterns) {
        const m = s.match(re);
        const val = parseMoneyValue(m?.[1] || m?.groups?.price || "");
        if (val != null) return val;
    }
    return null;
}

function titleCaseSlugPart(v) {
    const compass = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW"]);

    return String(v || "")
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .split(" ")
        .map((part) => {
            const upper = part.toUpperCase();
            return compass.has(upper) ? upper : part;
        })
        .join(" ");
}

function looksLikeStateCode(v) {
    return /^[A-Z]{2}$/i.test(String(v || "").trim());
}

function parseAddressSlug(slug) {
    const raw = String(slug || "")
        .replace(/\.(?:html?|aspx?)$/i, "")
        .replace(/[_]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

    if (!raw) return {};

    const parts = raw.split("-").map((x) => x.trim()).filter(Boolean);
    if (parts.length < 3) return {};

    let zip = "";
    let state = "";
    let stateIdx = -1;

    const last = parts[parts.length - 1] || "";
    if (/^\d{5}(?:\d{4})?$/.test(last)) {
        zip = last.slice(0, 5);
        const maybeState = parts[parts.length - 2] || "";
        if (looksLikeStateCode(maybeState)) {
            state = maybeState.toUpperCase();
            stateIdx = parts.length - 2;
        }
    }

    if (stateIdx < 0) {
        for (let i = parts.length - 1; i >= 0; i -= 1) {
            if (looksLikeStateCode(parts[i])) {
                state = parts[i].toUpperCase();
                stateIdx = i;
                const maybeZip = parts[i + 1] || "";
                if (/^\d{5}/.test(maybeZip)) zip = maybeZip.slice(0, 5);
                break;
            }
        }
    }

    if (stateIdx < 0) return { zip };

    const beforeState = parts.slice(0, stateIdx);

    const streetSuffixes = new Set([
        "st", "street",
        "ave", "avenue",
        "rd", "road",
        "dr", "drive",
        "ln", "lane",
        "ct", "court",
        "cir", "circle",
        "blvd", "boulevard",
        "way",
        "pl", "place",
        "pkwy", "parkway",
        "ter", "terrace",
        "trl", "trail",
        "loop",
        "hwy", "highway",
        "path",
        "walk",
        "run",
        "row",
        "sq", "square",
    ]);

    // Important: compass words like NW/NE are street direction, not street suffix.
    // For 11560-NW-71st-Pl-Parkland-FL-33076:
    // street = 11560 NW 71st Pl
    // city = Parkland
    let suffixIdx = -1;
    for (let i = 0; i < beforeState.length; i += 1) {
        if (streetSuffixes.has(String(beforeState[i]).toLowerCase())) {
            suffixIdx = i;
        }
    }

    let streetParts = [];
    let cityParts = [];

    if (/^\d/.test(beforeState[0] || "") && suffixIdx >= 1 && suffixIdx < beforeState.length - 1) {
        streetParts = beforeState.slice(0, suffixIdx + 1);
        cityParts = beforeState.slice(suffixIdx + 1);
    } else if (/^\d/.test(beforeState[0] || "") && beforeState.length >= 4) {
        cityParts = beforeState.slice(-1);
        streetParts = beforeState.slice(0, -1);
    } else {
        cityParts = beforeState.slice(-2);
    }

    const street = titleCaseSlugPart(streetParts.join("-"));
    const city = titleCaseSlugPart(cityParts.join("-"));

    let address_full = [street, city, state, zip].filter(Boolean).join(", ");
    address_full = address_full.replace(/,\s*([A-Z]{2}),\s*(\d{5})(?:-\d{4})?$/i, ", $1 $2");

    return { address_full, city, state, zip };
}

function parseCityStateSlug(slug) {
    const s = String(slug || "")
        .trim()
        .toLowerCase()
        .replace(/_+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

    if (!s) return {};

    const m = s.match(/^(.+)-([a-z]{2})$/i);
    if (!m) return {};

    const citySlug = String(m[1] || "").trim();
    const state = String(m[2] || "").trim().toUpperCase();

    if (!citySlug || !looksLikeStateCode(state)) return {};

    return {
        city: titleCaseSlugPart(citySlug),
        state,
    };
}

function parseAreaFromUrlParts(parts = [], sourceInfo = {}) {
    const arr = Array.isArray(parts) ? parts : [];

    // Zillow community URLs:
    // /apartments/parkland-fl/the-villas-at-ibis-landing/5g3t9v/
    if (sourceInfo.source === "zillow") {
        const apartmentsIdx = arr.findIndex((p) => String(p || "").toLowerCase() === "apartments");
        if (apartmentsIdx >= 0) {
            const area = parseCityStateSlug(arr[apartmentsIdx + 1] || "");
            if (area.city || area.state) return area;
        }
    }

    // Generic fallback for any segment like parkland-fl, boca-raton-fl, new-york-ny
    for (const part of arr) {
        const s = String(part || "").trim();

        // skip obvious IDs / listing slugs
        if (!s || /\d{5}/.test(s) || /^\d+_zpid$/i.test(s) || /^[a-z0-9]{5,10}$/i.test(s)) {
            continue;
        }

        const area = parseCityStateSlug(s);
        if (area.city || area.state) return area;
    }

    return {};
}

function parseListingHintsFromUrl(url, sourceInfo = {}) {
    let u;
    try {
        u = new URL(url);
    } catch {
        return {};
    }

    const path = decodeURIComponent(u.pathname || "");
    const parts = path.split("/").map((x) => x.trim()).filter(Boolean);

    let slug = "";

    if (sourceInfo.source === "zillow") {
        const i = parts.findIndex((x) => x.toLowerCase() === "homedetails");
        slug = i >= 0 ? parts[i + 1] || "" : "";
    }

    if (!slug) {
        slug = [...parts].reverse().find((x) => /\d{5}/.test(x) && /[A-Za-z]/.test(x)) || "";
    }

    const loc = parseAddressSlug(slug);
    const area = parseAreaFromUrlParts(parts, sourceInfo);

    const zpid = (
        path.match(/\/(\d+)_zpid\b/i)?.[1] ||
        u.searchParams.get("zpid") ||
        ""
    ).trim();

    // Zillow apartment/community id, example: /apartments/parkland-fl/name/5g3t9v/
    const communityId =
        sourceInfo.source === "zillow" && !zpid
            ? String(parts[parts.length - 1] || "").trim()
            : "";

    const out = {
        ...area,
        ...loc,

        // loc should win if full address exists, but area fills city/state for apartment URLs.
        city: loc.city || area.city || "",
        state: loc.state || area.state || "",
        zip: loc.zip || "",
    };

    if (zpid) out.platformListingId = zpid;
    else if (/^[a-z0-9]{4,16}$/i.test(communityId)) out.platformListingId = communityId;

    return out;
}

function hasUsefulExtractedData(x) {
    if (!x || typeof x !== "object") return false;

    return !!(
        x.title ||
        x.description ||
        x.image_url ||
        x.address_full ||
        x.address_redacted ||
        x.city ||
        x.state ||
        x.zip ||
        x.bedrooms != null ||
        x.bathrooms != null ||
        x.beds != null ||
        x.monthlyPrice != null ||
        x.nightlyPrice != null ||
        x.rentOrPrice != null ||
        x.squareFeet != null ||
        x.minimumStay ||
        x.leaseTerm ||
        x.deposit != null
    );
}

function buildExtractPayload({
    normalized,
    sourceInfo,
    contentType = "",
    merged = {},
    partial = false,
    fetchStatus = null,
    fetchError = "",
}) {
    const source = sourceInfo.source;
    const urlHints = parseListingHintsFromUrl(normalized, sourceInfo);

    const address_full = merged.address_full || urlHints.address_full || "";
    const addr = redactAddress(address_full);
    const address_redacted = addr.redacted || merged.address_redacted || "";

    const city = merged.city || urlHints.city || "";
    const state = merged.state || urlHints.state || "";
    const zip = merged.zip || urlHints.zip || "";

    const extracted = {
        source,
        sourceLabel: sourceInfo.sourceLabel,
        sourceDomain: sourceInfo.sourceDomain,
        listingType: sourceInfo.listingType,
        listingTypeLabel: sourceInfo.listingTypeLabel,

        title: merged.title || "",
        description: merged.description || "",
        image_url: merged.image_url || "",
        images: Array.isArray(merged.images) ? merged.images : [],

        rating: merged.rating ?? null,
        review_count: merged.review_count ?? null,

        bedrooms: merged.bedrooms ?? null,
        bathrooms: merged.bathrooms ?? null,
        beds: merged.beds ?? null,
        propertyType: merged.propertyType || "",
        guestsMax: merged.guestsMax ?? null,

        checkInTime: merged.checkInTime || "",
        checkOutTime: merged.checkOutTime || "",
        checkInMethod: merged.checkInMethod || "",
        amenities: Array.isArray(merged.amenities) ? merged.amenities : [],

        nightlyPrice: merged.nightlyPrice ?? null,
        cleaningFee: merged.cleaningFee ?? null,

        monthlyPrice: merged.monthlyPrice ?? null,
        minimumStay: merged.minimumStay || "",
        leaseTerm: merged.leaseTerm || "",
        deposit: merged.deposit ?? null,
        availableDate: merged.availableDate || "",

        furnished: merged.furnished ?? null,
        utilitiesIncluded: merged.utilitiesIncluded ?? null,
        parking: merged.parking ?? null,
        pets: merged.pets || "",
        wifiSpeedMbps: merged.wifiSpeedMbps ?? null,

        squareFeet: merged.squareFeet ?? null,

        propertyUse: merged.propertyUse || "",
        leaseOrSale: merged.leaseOrSale || "",
        rentOrPrice: merged.rentOrPrice ?? null,

        city,
        state,
        zip,
        location: [city, state].filter(Boolean).join(", ") || address_redacted || "",
        address_redacted,
        address_full: addr.full || address_full,
        platformListingId: merged.platformListingId || urlHints.platformListingId || "",
    };

    return {
        ok: true,
        partial: !!partial,
        debugVersion: PUBLIC_EXTRACT_VERSION,
        fetchStatus,
        fetchError,
        source,
        sourceLabel: sourceInfo.sourceLabel,
        sourceDomain: sourceInfo.sourceDomain,
        listingType: sourceInfo.listingType,
        listingTypeLabel: sourceInfo.listingTypeLabel,
        sourceFamily: sourceInfo.sourceFamily,
        url: normalized,
        content_type: contentType,
        extracted,
        warnings: [
            partial
                ? "The site blocked or limited server-side reading, so I kept the detected platform/type and any URL-derived details."
                : "Some sites load details with JavaScript or bot protection, so server extraction can be partial.",
            "If fields are empty, keep the detected listing type and ask the user to continue manually.",
        ],
    };
}

function psMoneyToNumber(v) {
    const m = String(v ?? "").replace(/,/g, "").match(/\d+(?:\.\d{1,2})?/);
    if (!m) return null;

    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
}

function psFirstNumber(v) {
    const m = String(v ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
    if (!m) return null;

    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
}

function parseAddressPartsFromFullAddress(address) {
    const src = String(address || "").replace(/\s+/g, " ").trim();

    const street =
        src.match(
            /\b(\d{2,6}\s+[A-Za-z0-9 .'-]+?\s(?:Rd|Road|St|Street|Ave|Avenue|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Cir|Circle|Way|Pkwy|Parkway|Pl|Place|Ter|Terrace|Trl|Trail)\b\s*,\s*[^,]+,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)\b/i
        )?.[1] || src;

    const m = street.match(/^(.*?),\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})(?:-\d{4})?/i);
    if (!m) return {};

    return {
        address_full: `${titleCaseSlugPart(m[1].trim())}, ${titleCaseSlugPart(m[2].trim())}, ${m[3].toUpperCase()} ${m[4]}`,
        city: titleCaseSlugPart(m[2].trim()),
        state: m[3].toUpperCase(),
        zip: m[4],
    };
}


function parseZillowCommunityRentalHints(rawText) {
    const s = String(rawText || "")
        .replace(/&nbsp;/gi, " ")
        .replace(/\\u002F/gi, "/")
        .replace(/\\u003C/gi, "<")
        .replace(/\\u003E/gi, ">")
        .replace(/\\u0026/gi, "&")
        .replace(/\s+/g, " ")
        .trim();

    const out = {};
    if (!s) return out;

    const primary = String(
        s.split(/\b(?:Nearby apartments for rent|Similar homes for rent|Price history|Nearby schools|Neighborhood:|Local legal protections)\b/i)[0] || s
    ).trim();

    const pickNumber = (v) => psFirstNumber(v);

    const setLayout = (bedrooms, bathrooms) => {
        const br = pickNumber(bedrooms);
        const ba = pickNumber(bathrooms);

        if (br != null && br >= 0 && br <= 20) {
            out.bedrooms = br;
            out.beds = br;
        }

        if (ba != null && ba >= 0 && ba <= 30) {
            out.bathrooms = ba;
        }
    };

    const addrMatch = primary.match(
        /\b(\d{2,6}\s+[A-Za-z0-9 .'-]+?\s(?:Rd|Road|St|Street|Ave|Avenue|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Cir|Circle|Way|Pkwy|Parkway|Pl|Place|Ter|Terrace|Trl|Trail)\b\s*,\s*[A-Za-z .'-]+,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)\b/i
    );

    if (addrMatch?.[1]) {
        Object.assign(out, parseAddressPartsFromFullAddress(addrMatch[1]));
    }

    const exactFacts = primary.match(
        /\bBedrooms?\s*[:\-]?\s*(\d+(?:\.\d+)?)[^\d]{0,140}\b(?:Bathrooms?|Full bathrooms?)\s*[:\-]?\s*(\d+(?:\.\d+)?)/i
    );

    if (exactFacts) {
        setLayout(exactFacts[1], exactFacts[2]);
    }

    const heroLayout = primary.match(
        /\b(\d+(?:\.\d+)?)\s*(?:bd|br|bed|beds|bedrooms)\b\s*(?:[,|/·-]|\s){0,16}\s*(\d+(?:\.\d+)?)\s*(?:ba|bath|baths|bathrooms)\b/i
    );

    if (heroLayout) {
        setLayout(heroLayout[1], heroLayout[2]);
    }

    const descLayout = primary.match(
        /\b(?:has|with|includes|features|rental\s*-\s*)\s*(\d+(?:\.\d+)?)\s*(?:br|bd|bedrooms?|beds?)\s*(?:,|\s|and|&|-){0,24}\s*(\d+(?:\.\d+)?)\s*(?:bathroom|bathrooms|bath|baths|ba)\b/i
    );

    if (descLayout) {
        setLayout(descLayout[1], descLayout[2]);
    }

    if (out.bedrooms == null) {
        const br =
            primary.match(/\bBedrooms?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i)?.[1] ||
            primary.match(/\b(\d+(?:\.\d+)?)\s*(?:bd|br|bed|beds|bedrooms)\b/i)?.[1];

        const n = pickNumber(br);
        if (n != null && n >= 0 && n <= 20) {
            out.bedrooms = n;
            out.beds = n;
        }
    }

    if (out.bathrooms == null) {
        const ba =
            primary.match(/\b(?:Bathrooms?|Full bathrooms?)\s*[:\-]?\s*(\d+(?:\.\d+)?)/i)?.[1] ||
            primary.match(/\b(\d+(?:\.\d+)?)\s*(?:ba|bath|baths|bathrooms)\b/i)?.[1] ||
            primary.match(/\b(\d+(?:\.\d+)?)\s*(?:full\s+|total\s+)?(?:bath|baths|bathrooms)\b/i)?.[1];

        const n = pickNumber(ba);
        if (n != null && n >= 0 && n <= 30) {
            out.bathrooms = n;
        }
    }

    const price =
        primary.match(/\$\s*([\d,]+)\s*(?:\/\s*)?(?:mo|month|monthly)\b/i)?.[1] ||
        primary.match(/\b(?:listed\s+for\s+rent|for\s+rent|rent)\D{0,30}\$\s*([\d,]+)\b/i)?.[1] ||
        primary.match(/\b1\s*bed\s*\$\s*([\d,]+)\+/i)?.[1];

    if (price) {
        out.monthlyPrice = psMoneyToNumber(price);
    }

    const sqft = primary.match(/\b([\d,]{3,8})\s*(?:sq\.?\s*ft\.?|sqft|sf|square\s+feet)\b/i)?.[1];
    if (sqft && !/^--/.test(sqft)) {
        out.squareFeet = psFirstNumber(sqft);
    }

    if (/\b(single\s*family\s*residence|single\s*family|singlefamily)\b/i.test(primary)) {
        out.propertyType = "house";
    } else if (/\btownhouse|townhome\b/i.test(primary)) {
        out.propertyType = "townhouse";
    } else if (/\bcondo\b/i.test(primary)) {
        out.propertyType = "condo";
    } else if (/\bapartment\b/i.test(primary)) {
        out.propertyType = "apartment";
    }

    if (/\bAvailable now\b/i.test(primary)) {
        out.availableDate = "Available now";
    }

    const leaseTerm = primary.match(/\bLease term\s*[:\-]?\s*([A-Za-z0-9 ]{2,40})/i)?.[1];
    if (leaseTerm) {
        out.leaseTerm = leaseTerm.trim();
    }

    if (/\b(parking|garage|off[-\s]?street parking|covered parking)\b/i.test(primary)) {
        out.parking = true;
    }

    if (/\b(dogs allowed|cats allowed|pet-friendly|pet friendly|pets allowed)\b/i.test(primary)) {
        out.pets = "yes";
    } else if (/\bno\s+pets?\b/i.test(primary)) {
        out.pets = "no";
    }

    return out;
}


function parseFurnishedFinderHints(html) {
    const text = stripHtml(html || "");
    const compact = text.replace(/\s+/g, " ").trim();
    const out = {};

    if (!compact) return out;

    // Only parse the primary listing area. Do not scan Similar Rentals,
    // otherwise bedrooms/baths get polluted by other listings.
    const primary = String(
        compact.split(/\b(?:Similar Rentals|About the Landlord|Closest facilities|Property Availability)\b/i)[0] || compact
    ).trim();

    const title =
        primary.match(/#\s*([^#]{8,160}?)\s+Share\s+Save/i)?.[1] ||
        primary.match(/Overview\s+Amenities\s+Availability\s+Reviews\s*\(\d+\)\s+Landlord\s+#\s*([^#]{8,160}?)\s+Property ID:/i)?.[1] ||
        primary.match(/\b([A-Z][^#]{8,160}?)\s+Property ID:\s*\d+_\d+/i)?.[1] ||
        "";

    if (title) out.title = title.replace(/\s+/g, " ").trim();

    const propertyId = primary.match(/\bProperty ID:\s*([A-Za-z0-9_-]+)/i)?.[1] || "";
    if (propertyId) out.platformListingId = propertyId;

    const loc = primary.match(/\b(Cottage|House|Apartment|Condo|Studio|Room|Townhouse|Guesthouse)\s+in\s+([A-Za-z .'-]+),\s*([A-Za-z .'-]+)\b/i);
    if (loc) {
        out.propertyType = String(loc[1] || "").toLowerCase();
        out.city = titleCaseSlugPart(loc[2]);

        let state = titleCaseSlugPart(loc[3]);
        state = state
            .replace(/\s+Landlord\s+Tenure.*$/i, "")
            .replace(/\s+Property\s+ID.*$/i, "")
            .replace(/\s+Monthly\s+Rent.*$/i, "")
            .replace(/\s+Rooms\s+&\s+Beds.*$/i, "")
            .trim();

        out.state = state;
    }

    const bedrooms =
        firstNumber(primary.match(/\b(\d+(?:\.\d+)?)\s+Bedrooms?\b/i)?.[1]) ??
        firstNumber(primary.match(/\bRooms\s*&\s*beds\s+(\d+(?:\.\d+)?)\s+Bedrooms?\b/i)?.[1]);

    if (bedrooms != null && bedrooms >= 0 && bedrooms <= 20) {
        out.bedrooms = bedrooms;
        out.beds = bedrooms;
    }

    const bathrooms =
        firstNumber(primary.match(/\b(\d+(?:\.\d+)?)\s+(?:Private\s+)?Bathrooms?\b/i)?.[1]) ??
        firstNumber(primary.match(/\bBathroom\s+\d+\s+Private Bath\b/i) ? "1" : "");

    if (bathrooms != null && bathrooms >= 0 && bathrooms <= 20) {
        out.bathrooms = bathrooms;
    }

    const bedType = primary.match(/\bBedroom\s+\d+\s+([^$]{1,80}?Bed)\b/i)?.[1] || "";
    if (bedType && out.beds == null) out.beds = 1;

    const monthly =
        primary.match(/\$\s*([\d,]+)\s*\/\s*month\b/i)?.[1] ||
        primary.match(/\$\s*([\d,]+)\s+\/month\b/i)?.[1] ||
        primary.match(/\$\s*([\d,]+)\s+Utilities:/i)?.[1];

    if (monthly) {
        out.monthlyPrice = psMoneyToNumber(monthly);
        out.rentOrPrice = out.monthlyPrice;
    }

    const minStay =
        primary.match(/\bMinimum stay:\s*(\d+\s*(?:month|months|day|days))\b/i)?.[1] ||
        primary.match(/\bminimum of\s*(\d+\s*days)\b/i)?.[1];

    if (minStay) out.minimumStay = minStay.trim();

    const deposit = primary.match(/\bDeposit\s*\(Refundable\)\s*\$\s*([\d,]+)/i)?.[1];
    if (deposit) out.deposit = psMoneyToNumber(deposit);

    if (/\bUtilities:\s*Included\b/i.test(primary) || /\bUtilities Included\b/i.test(primary)) {
        out.utilitiesIncluded = true;
    }

    out.furnished = true;

    const maxOccupancy = firstNumber(primary.match(/\bMax occupancy\s+(\d{1,2})\b/i)?.[1]);
    if (maxOccupancy != null && maxOccupancy > 0 && maxOccupancy <= 30) {
        out.guestsMax = maxOccupancy;
    }

    if (/\bPets Not Allowed\b/i.test(primary)) out.pets = "no";
    else if (/\bPets Allowed\b/i.test(primary) || /\bPets on Property\b/i.test(primary)) out.pets = "yes";

    if (/\bParking\b/i.test(primary) || /\bMax vehicles\s+\d+/i.test(primary)) out.parking = true;

    const amenities = [];
    if (/\bWasher and dryer\b/i.test(primary)) {
        amenities.push("Washer");
        amenities.push("Dryer");
    }
    if (/\bKitchenware\b|\bfull kitchen\b|\bKitchen\b/i.test(primary)) amenities.push("Kitchen");
    if (/\bAir Conditioning\b/i.test(primary)) amenities.push("Air conditioning");
    if (/\bHeating\b/i.test(primary)) amenities.push("Heating");
    if (/\bQuiet Environment\b/i.test(primary)) amenities.push("Quiet Environment");
    if (/\bStorage\b/i.test(primary)) amenities.push("Storage");
    if (/\bWifi\b|\bWiFi\b|\b6e Wifi\b/i.test(primary)) amenities.push("WiFi");
    if (/\bParking\b/i.test(primary)) amenities.push("Parking");

    if (amenities.length) out.amenities = [...new Set(amenities)];

    const desc =
        primary.match(/\b(Welcome|Bienvenidos|Enjoy|Relax|Brand new|This charming)[\s\S]{40,900}?(?:\s+Read more|\s+Neighborhood overview|\s+Rooms & beds)/i)?.[0] ||
        "";

    if (desc) {
        out.description = desc
            .replace(/\s+Read more$/i, "")
            .replace(/\s+Neighborhood overview$/i, "")
            .replace(/\s+Rooms & beds$/i, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 900);
    }

    const reviewCount = firstNumber(primary.match(/\b(\d+)\s+review\s*s?\b/i)?.[1]);
    if (reviewCount != null) out.review_count = reviewCount;

    // Try to pull image URLs from HTML if present. If the site only exposes
    // optimized JS image objects, this may remain blank.
    const images = [];
    const imageRegexes = [
        /https?:\/\/[^"'\\\s<>]+property[^"'\\\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s<>]*)?/gi,
        /https?:\/\/[^"'\\\s<>]+439100_1[^"'\\\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s<>]*)?/gi,
        /https?:\/\/[^"'\\\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s<>]*)?/gi,
    ];

    for (const re of imageRegexes) {
        let m;
        while ((m = re.exec(String(html || "")))) {
            const img = absolutizeMaybeUrl(m[0], "https://www.furnishedfinder.com/");
            if (!img || images.includes(img)) continue;
            images.push(img);
            if (images.length >= 12) break;
        }
        if (images.length) break;
    }

    if (images.length) {
        out.image_url = images[0];
        out.images = images;
    }

    return out;
}

function cleanRedfinTitle(rawTitle, urlHints = {}) {
    let title = String(rawTitle || "").replace(/\s+/g, " ").trim();

    title = title
        .replace(/^undefined\s*-\s*/i, "")
        .replace(/\s*\|\s*Redfin\s*$/i, "")
        .replace(/\s*-\s*Redfin\s*$/i, "")
        .trim();

    if (!title && urlHints.address_full) title = urlHints.address_full;
    if (/^undefined$/i.test(title) && urlHints.address_full) title = urlHints.address_full;

    return title;
}

function parseRedfinUrlHints(url) {
    let u;
    try {
        u = new URL(url);
    } catch {
        return {};
    }

    const path = decodeURIComponent(u.pathname || "");
    const parts = path.split("/").map((x) => x.trim()).filter(Boolean);

    const state = parts[0] && /^[A-Z]{2}$/i.test(parts[0]) ? parts[0].toUpperCase() : "";
    const city = parts[1] ? titleCaseSlugPart(parts[1]) : "";

    const homeIdx = parts.findIndex((x) => /^home$/i.test(x));
    const platformListingId = homeIdx >= 0 ? String(parts[homeIdx + 1] || "").trim() : "";

    let slug = "";
    if (homeIdx >= 1) {
        slug = parts[homeIdx - 1] || "";
    }

    let zip = "";
    let street = "";

    const m = slug.match(/^(.+)-(\d{5})(?:-\d{4})?$/i);
    if (m) {
        street = titleCaseSlugPart(m[1]);
        zip = m[2];
    } else {
        street = titleCaseSlugPart(slug);
    }

    const address_full =
        street && city && state && zip
            ? `${street}, ${city}, ${state} ${zip}`
            : "";

    return {
        platformListingId,
        address_full,
        city,
        state,
        zip,
    };
}

function parseRedfinHints(html, url) {
    const text = stripHtml(html || "").replace(/\s+/g, " ").trim();
    const compact = text;
    const out = {};
    const urlHints = parseRedfinUrlHints(url);

    if (urlHints.platformListingId) out.platformListingId = urlHints.platformListingId;
    if (urlHints.address_full) out.address_full = urlHints.address_full;
    if (urlHints.city) out.city = urlHints.city;
    if (urlHints.state) out.state = urlHints.state;
    if (urlHints.zip) out.zip = urlHints.zip;

    const ogTitle = pickMeta(html, "og:title") || pickMeta(html, "twitter:title") || "";
    const pageTitle = stripHtml(String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
    const rawTitle = ogTitle || pageTitle || urlHints.address_full || "";

    const title = cleanRedfinTitle(rawTitle, urlHints);
    if (title) out.title = title;

    const metaDesc =
        pickMeta(html, "og:description") ||
        pickMeta(html, "description") ||
        "";

    const safeDesc = String(metaDesc || "")
        .replace(/^For Rent:\s*·\s*/i, "For Rent: ")
        .replace(/\s+/g, " ")
        .trim();

    if (safeDesc) out.description = safeDesc;

    // Focus only around the known address/title so we don't parse unrelated nearby/commercial text.
    const addressNeedle = urlHints.address_full || title || "";
    let primary = compact;

    if (addressNeedle) {
        const idx = compact.toLowerCase().indexOf(addressNeedle.toLowerCase());
        if (idx >= 0) {
            primary = compact.slice(Math.max(0, idx - 1200), Math.min(compact.length, idx + 5000));
        }
    }

    // Cut noisy sections.
    primary = String(
        primary.split(/\b(?:Nearby homes|Nearby rentals|Schools|Commute|Property details|Sale and tax history|Public facts|About this home|Around this home)\b/i)[0] ||
        primary
    ).trim();

    const rentCandidates = [
        primary.match(/\$\s*([\d,]+)\s*(?:\/\s*)?(?:mo|month)\b/i)?.[1],
        compact.match(/\$\s*([\d,]+)\s*(?:\/\s*)?(?:mo|month)\b/i)?.[1],
        primary.match(/\bFor\s+Rent\b.{0,180}?\$\s*([\d,]+)\b/i)?.[1],
        compact.match(/\bFor\s+Rent\b.{0,220}?\$\s*([\d,]+)\b/i)?.[1],
        String(pickMeta(html, "og:description") || "").match(/\$\s*([\d,]+)\b/i)?.[1],
        String(pickMeta(html, "description") || "").match(/\$\s*([\d,]+)\b/i)?.[1],
    ].filter(Boolean);

    const cleanRentCandidates = rentCandidates
        .map((x) => psMoneyToNumber(x))
        .filter((n) => Number.isFinite(n) && n >= 500 && n <= 50000);

    // Prefer the smallest valid rent candidate. Redfin pages can contain unrelated
    // nearby/estimate prices, and those should not overwrite the actual listing rent.
    const n = cleanRentCandidates.length ? Math.min(...cleanRentCandidates) : null;

    if (n != null) {
        out.monthlyPrice = n;
        out.rentOrPrice = n;
        out.leaseOrSale = "For rent";
    }

    const layout =
        primary.match(/\b(\d+(?:\.\d+)?)\s*(?:beds?|bedrooms?)\b.{0,40}?\b(\d+(?:\.\d+)?)\s*(?:baths?|bathrooms?)\b/i) ||
        compact.match(/\b(\d+(?:\.\d+)?)\s*(?:beds?|bedrooms?)\b.{0,40}?\b(\d+(?:\.\d+)?)\s*(?:baths?|bathrooms?)\b/i);

    if (layout) {
        const br = firstNumber(layout[1]);
        const ba = firstNumber(layout[2]);

        if (br != null && br >= 0 && br <= 20) {
            out.bedrooms = br;
            out.beds = br;
        }

        if (ba != null && ba >= 0 && ba <= 20) {
            out.bathrooms = ba;
        }
    }

    // Redfin pages often include lot size / nearby sqft noise. Only accept sqft if it appears
    // close to bed/bath/rent language and within a reasonable interior range.
    const sqftRaw =
        primary.match(/\b(\d[\d,]{2,5})\s*(?:sq\.?\s*ft\.?|sqft)\b/i)?.[1] || "";

    if (sqftRaw) {
        const sqft = Number(String(sqftRaw).replace(/,/g, ""));
        if (Number.isFinite(sqft) && sqft >= 200 && sqft <= 6000) {
            out.squareFeet = sqft;
        }
    }

    if (/\bsingle[-\s]?family\b|\bhouse\b|\bhome\b/i.test(primary)) {
        out.propertyType = "house";
    } else if (/\btownhouse|townhome\b/i.test(primary)) {
        out.propertyType = "townhouse";
    } else if (/\bcondo\b/i.test(primary)) {
        out.propertyType = "condo";
    } else if (/\bapartment\b/i.test(primary)) {
        out.propertyType = "apartment";
    }

    if (/\bpets?\s+(?:allowed|welcome|friendly)\b|\bdogs?\s+allowed\b|\bcats?\s+allowed\b/i.test(primary)) {
        out.pets = "yes";
    } else if (/\bno\s+pets?\b/i.test(primary)) {
        out.pets = "no";
    }

    if (/\bparking\b|\bgarage\b/i.test(primary)) {
        out.parking = true;
    }

    const amenities = [];
    if (/\bparking\b|\bgarage\b/i.test(primary)) amenities.push("Parking");
    if (/\blaundry\b|\bin-unit laundry\b/i.test(primary)) amenities.push("Laundry");
    if (/\bwasher\b/i.test(primary)) amenities.push("Washer");
    if (/\bdryer\b/i.test(primary)) amenities.push("Dryer");
    if (/\bair conditioning\b|\bcentral air\b|\bac\b/i.test(primary)) amenities.push("Air conditioning");
    if (/\bdishwasher\b/i.test(primary)) amenities.push("Dishwasher");
    if (/\bpool\b/i.test(primary)) amenities.push("Pool");
    if (/\bpatio\b/i.test(primary)) amenities.push("Patio");
    if (/\bbalcony\b/i.test(primary)) amenities.push("Balcony");
    if (/\byard\b/i.test(primary)) amenities.push("Yard");

    if (amenities.length) out.amenities = [...new Set(amenities)];

    // Important: Redfin residential rentals should not inherit generic commercial/STR fields.
    out.propertyUse = "";
    out.rating = null;
    out.review_count = null;
    out.furnished = null;
    out.nightlyPrice = null;
    out.cleaningFee = null;

    return out;
}

function parseGenericListingHints(html, sourceInfo = {}, pageUrl = "") {
    const text = stripHtml(html || "");
    const compact = text.replace(/\s+/g, " ").trim();
    const out = {};

    // Booking.com fallback comes from SERP snippets.
    // Do NOT run generic rent/commercial parsing on it, because snippets contain
    // unrelated prices/warehouse words and create bad fields like monthlyPrice/propertyUse.
    if (sourceInfo.source === "booking") {
        const bookingHints = parseBookingSerpApiHints(compact);

        for (const [key, value] of Object.entries(bookingHints)) {
            if (value == null || value === "") continue;
            if (Array.isArray(value) && !value.length) continue;
            out[key] = value;
        }

        return out;
    }

    if (sourceInfo.source === "furnishedfinder") {
        const ffHints = parseFurnishedFinderHints(html);

        for (const [key, value] of Object.entries(ffHints)) {
            if (value == null || value === "") continue;
            if (Array.isArray(value) && !value.length) continue;
            out[key] = value;
        }

        return out;
    }

    if (sourceInfo.source === "redfin") {
        const redfinHints = parseRedfinHints(html, pageUrl);

        for (const [key, value] of Object.entries(redfinHints)) {
            if (value == null || value === "") continue;
            if (Array.isArray(value) && !value.length) continue;
            out[key] = value;
        }

        return out;
    }

    if (sourceInfo.source === "vrbo" && /SERP_PRIMARY_|ORGANIC_RESULT_/i.test(compact)) {
        const vrboHints = parseVrboSerpApiHints(compact);

        for (const [key, value] of Object.entries(vrboHints)) {
            if (value == null || value === "") continue;
            if (Array.isArray(value) && !value.length) continue;
            out[key] = value;
        }

        return out;
    }

    const monthlyPrice = moneyNear(compact, [
        /(?<price>\$\s*[\d,]+(?:\.\d{1,2})?)\s*(?:\/|per\s*)?(?:mo|month|monthly)\b/i,
        /(?:rent|monthly rent|price)\D{0,25}(?<price>\$\s*[\d,]+(?:\.\d{1,2})?)/i,
    ]);

    const nightlyPrice = moneyNear(compact, [
        /(?<price>\$\s*[\d,]+(?:\.\d{1,2})?)\s*(?:\/|per\s*)?(?:night|nightly)\b/i,
        /(?:nightly|per night)\D{0,25}(?<price>\$\s*[\d,]+(?:\.\d{1,2})?)/i,
    ]);

    const cleaningFee = moneyNear(compact, [
        /cleaning\s*fee\D{0,25}(?<price>\$\s*[\d,]+(?:\.\d{1,2})?)/i,
        /(?<price>\$\s*[\d,]+(?:\.\d{1,2})?)\s*cleaning\s*fee/i,
    ]);

    const deposit = moneyNear(compact, [
        /(?:security\s*)?deposit\D{0,25}(?<price>\$\s*[\d,]+(?:\.\d{1,2})?)/i,
    ]);

    const rentOrPrice = moneyNear(compact, [
        /(?:asking price|sale price|lease rate|rent|price)\D{0,25}(?<price>\$\s*[\d,]+(?:\.\d{1,2})?)/i,
        /(?<price>\$\s*[\d,]+(?:\.\d{1,2})?)/i,
    ]);

    if (monthlyPrice != null) out.monthlyPrice = monthlyPrice;
    if (nightlyPrice != null) out.nightlyPrice = nightlyPrice;
    if (cleaningFee != null) out.cleaningFee = cleaningFee;
    if (deposit != null) out.deposit = deposit;
    if (rentOrPrice != null) out.rentOrPrice = rentOrPrice;

    const mainChunk = String(
        compact.split(/\b(?:Nearby apartments for rent|Similar homes for rent|Price history|Nearby schools|Neighborhood:|Local legal protections)\b/i)[0] || compact
    ).trim();

    const layoutPair = mainChunk.match(
        /\b(\d+(?:\.\d+)?)\s*(?:bd|br|bed|beds|bedrooms)\b.{0,90}?\b(\d+(?:\.\d+)?)\s*(?:ba|bath|baths|bathroom|bathrooms|full\s+baths|total\s+baths)\b/i
    );

    const bedrooms =
        firstNumber(layoutPair?.[1]) ??
        firstNumber(mainChunk.match(/\bBedrooms?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i)?.[1]) ??
        firstNumber(mainChunk.match(/\b(\d+(?:\.\d+)?)\s*(?:bd|br|beds?|bedrooms?)\b/i)?.[1]);

    const bathrooms =
        firstNumber(layoutPair?.[2]) ??
        firstNumber(mainChunk.match(/\b(?:Bathrooms?|Full bathrooms?)\s*[:\-]?\s*(\d+(?:\.\d+)?)/i)?.[1]) ??
        firstNumber(mainChunk.match(/\b(\d+(?:\.\d+)?)\s*(?:ba|baths?|bathrooms?)\b/i)?.[1]) ??
        firstNumber(mainChunk.match(/\b(\d+(?:\.\d+)?)\s*(?:full\s+|total\s+)?(?:bath|baths|bathrooms)\b/i)?.[1]);

    if (bedrooms != null) {
        out.bedrooms = bedrooms;
        out.beds = bedrooms;
    }

    if (bathrooms != null) out.bathrooms = bathrooms;

    const minStay = compact.match(/(?:minimum|min\.?|minimum stay)\D{0,20}(\d{1,3})\s*(night|nights|day|days|month|months)/i);
    if (minStay?.[1]) out.minimumStay = `${minStay[1]} ${minStay[2]}`;

    const leaseTerm = compact.match(/(?:lease term|lease)\D{0,25}(\d{1,2}\s*(?:month|months|year|years)|annual|month-to-month)/i);
    if (leaseTerm?.[1]) out.leaseTerm = leaseTerm[1];

    const availableDate = compact.match(
        /(?:available|move-?in|availability)\D{0,30}((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i
    );
    if (availableDate?.[1]) out.availableDate = availableDate[1];

    const sqft = compact.match(/\b([\d,]{3,8})\s*(?:sq\.?\s*ft\.?|sf|square\s*feet)\b/i);
    if (sqft?.[1]) out.squareFeet = Number(String(sqft[1]).replace(/,/g, "")) || null;

    if (sourceInfo.listingType === "long_term" && out.monthlyPrice != null) {
        out.leaseOrSale = "For rent";
    } else if (/\bfor\s+lease\b/i.test(compact)) {
        out.leaseOrSale = "For lease";
    } else if (/\bfor\s+sale\b/i.test(compact)) {
        out.leaseOrSale = "For sale";
    }

    if (/\b(retail|storefront)\b/i.test(compact)) out.propertyUse = "Retail";
    else if (/\b(office|medical office)\b/i.test(compact)) out.propertyUse = "Office";
    else if (/\b(warehouse|industrial|flex)\b/i.test(compact)) out.propertyUse = "Industrial / warehouse";
    else if (/\b(restaurant|food service)\b/i.test(compact)) out.propertyUse = "Restaurant";

    if (/\bfurnished\b/i.test(compact)) out.furnished = true;
    if (/\butilities included\b/i.test(compact)) out.utilitiesIncluded = true;
    if (/\b(parking|garage|covered parking|off-street parking)\b/i.test(compact)) out.parking = true;

    if (/\bpets?\s+(?:allowed|welcome|friendly)\b/i.test(compact)) out.pets = "yes";
    else if (/\bno\s+pets?\b/i.test(compact)) out.pets = "no";

    const wifi = compact.match(/\b(?:wifi|wi-fi|internet)\D{0,16}(\d{2,4})\s*(?:mbps|mb\/s)\b/i);
    if (wifi?.[1]) out.wifiSpeedMbps = Number(wifi[1]) || null;

    if (sourceInfo.listingType === "commercial") {
        out.leaseOrSale = out.leaseOrSale || (/sale/i.test(compact) ? "For sale" : "For lease");
    }

    if (sourceInfo.listingType === "furnished_30_plus") {
        out.furnished = true;
        out.minimumStay = out.minimumStay || "30 days";
    }

    if (sourceInfo.source === "zillow") {
        const zillowHints = parseZillowCommunityRentalHints(compact);

        for (const [key, value] of Object.entries(zillowHints)) {
            if (value == null || value === "") continue;
            if (Array.isArray(value) && !value.length) continue;
            out[key] = value;
        }
    }

    if (sourceInfo.source === "booking") {
        const bookingHints = parseBookingSerpApiHints(compact);

        for (const [key, value] of Object.entries(bookingHints)) {
            if (value == null || value === "") continue;
            if (Array.isArray(value) && !value.length) continue;
            out[key] = value;
        }
    }

    return out;
}


async function extractPublicListing(url) {
    const normalized = await validateAndNormalizeUrl(url);
    const absUrl = (u) => absolutizeMaybeUrl(u, normalized);
    const sourceInfo = getListingSourceInfo(normalized);
    const source = sourceInfo.source;

    let fetched;

    try {
        fetched = await fetchHtml(normalized);
    } catch (e) {
        fetched = {
            ok: false,
            status: "network_error",
            contentType: "",
            html: "",
            error: e?.message || "Fetch failed",
        };
    }


    let { ok, status, contentType, html } = fetched || {};
    let usedSearchFallback = false;
    let resolvedListingUrl = fetched?.finalUrl || normalized;

    const fallbackSources = new Set([
        "zillow",
        "realtor",
        "apartments",
        "redfin",
        "trulia",
        "homes",
        "furnishedfinder",
        "loopnet",
        "crexi",
        "costar",
        "booking",
        "vrbo",
    ]);

    const tryReader =
        sourceInfo.source !== "booking" &&
        fallbackSources.has(sourceInfo.source) &&
        (
            !ok ||
            !html ||
            html.length < 200 ||
            listingTextLooksBlocked(html) ||
            (sourceInfo.source === "zillow" && zillowTextLooksThin(html)) ||
            (sourceInfo.source === "booking" && bookingTextLooksBlocked(html))
        );

    if (tryReader) {
        const readerFetched = await fetchReaderText(normalized);

        if (
            readerFetched?.ok &&
            readerFetched?.html &&
            readerFetched.html.length > 300 &&
            !listingTextLooksBlocked(readerFetched.html)
        ) {
            fetched = {
                ...readerFetched,
                ok: true,
                status: readerFetched.status || status,
                contentType: readerFetched.contentType || contentType || "text/plain",
                html: readerFetched.html,
                viaReader: true,
            };

            ok = true;
            status = fetched.status;
            contentType = fetched.contentType;
            html = fetched.html;
        }
    }

    const trySearchFallback =
        (
            sourceInfo.source === "zillow" &&
            (
                !ok ||
                !html ||
                html.length < 200 ||
                listingTextLooksBlocked(html) ||
                zillowTextLooksThin(html)
            )
        ) ||
        (
            sourceInfo.source === "booking" &&
            (
                !ok ||
                !html ||
                html.length < 200 ||
                bookingTextLooksBlocked(html) ||
                !pickMeta(html, "og:title")
            )
        ) ||
        (
            sourceInfo.source === "vrbo" &&
            (
                !ok ||
                !html ||
                html.length < 200 ||
                status === 429 ||
                listingTextLooksBlocked(html) ||
                !pickMeta(html, "og:title")
            )
        );

    if (trySearchFallback) {
        const q = buildListingSearchFallbackQuery(resolvedListingUrl, sourceInfo);
        const searchFetched = await fetchSearchFallbackText(q);
        const focusedSearchText = selectAddressFocusedText(searchFetched?.html || "", resolvedListingUrl, sourceInfo);

        if (
            searchFetched?.ok &&
            focusedSearchText &&
            focusedSearchText.length > 120 &&
            !listingTextLooksBlocked(focusedSearchText)
        ) {
            usedSearchFallback = true;

            fetched = {
                ...searchFetched,
                ok: true,
                status: searchFetched.status || status,
                contentType: searchFetched.contentType || contentType || "text/plain",
                html: focusedSearchText,
                viaSearchFallback: true,
            };

            ok = true;
            status = fetched.status;
            contentType = fetched.contentType;
            html = fetched.html;
        }
    }

    if (!ok || !html || html.length < 200 || (sourceInfo.source === "zillow" && listingTextLooksBlocked(html)) || (sourceInfo.source === "booking" && bookingTextLooksBlocked(html))) {
        const urlHints = parseListingHintsFromUrl(normalized, sourceInfo);

        return buildExtractPayload({
            normalized,
            sourceInfo,
            contentType: contentType || "",
            merged: {
                title: urlHints.address_full || "",
                address_full: urlHints.address_full || "",
                city: urlHints.city || "",
                state: urlHints.state || "",
                zip: urlHints.zip || "",
            },
            partial: true,
            fetchStatus: status || "blocked",
            fetchError:
                fetched?.error ||
                (
                    sourceInfo.source === "zillow"
                        ? "Zillow returned a captcha/access-denied page before listing facts could be read."
                        : `Fetch failed (${status || "unknown"}).`
                ),
        });
    }

    const title =
        pickMeta(html, "og:title") ||
        pickMeta(html, "twitter:title") ||
        stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");

    const description =
        pickMeta(html, "og:description") ||
        pickMeta(html, "description") ||
        "";

    const ogDesc = pickMeta(html, "og:description") || description || "";

    // Hard stop: Zillow can return HTTP 200/text with only px-captcha.
    // Do not let "Access to this page has been denied" become listing data.
    if (
        source === "zillow" &&
        listingTextLooksBlocked(`${title} ${description} ${html}`)
    ) {
        const urlHints = parseListingHintsFromUrl(normalized, sourceInfo);

        return buildExtractPayload({
            normalized,
            sourceInfo,
            contentType: contentType || "",
            merged: {
                title: urlHints.address_full || "",
                address_full: urlHints.address_full || "",
                city: urlHints.city || "",
                state: urlHints.state || "",
                zip: urlHints.zip || "",
                platformListingId: urlHints.platformListingId || "",
            },
            partial: true,
            fetchStatus: status || "blocked",
            fetchError: "Zillow returned a captcha/access-denied page. Backend cannot read beds/baths/rent from this URL server-side.",
        });
    }

    // Extra Zillow guard: sometimes the raw HTML is not detected as blocked,
    // but the title/description clearly expose px-captcha/access-denied text.
    // In that case, switch to search fallback before extracting meta/images/LD data.
    if (
        source === "zillow" &&
        !fetched?.viaSearchFallback &&
        listingTextLooksBlocked(`${title} ${description}`)
    ) {
        const q = buildListingSearchFallbackQuery(normalized, sourceInfo);
        const searchFetched = await fetchSearchFallbackText(q);
        const focusedSearchText = selectAddressFocusedText(searchFetched?.html || "", normalized, sourceInfo);

        if (
            searchFetched?.ok &&
            focusedSearchText &&
            focusedSearchText.length > 120 &&
            !listingTextLooksBlocked(focusedSearchText)
        ) {
            usedSearchFallback = true;
            html = focusedSearchText;
            contentType = searchFetched.contentType || contentType || "text/plain";
            fetched = {
                ...searchFetched,
                ok: true,
                contentType,
                html,
                viaSearchFallback: true,
            };
        } else {
            const urlHints = parseListingHintsFromUrl(normalized, sourceInfo);

            return buildExtractPayload({
                normalized,
                sourceInfo,
                contentType: contentType || "",
                merged: {
                    title: urlHints.address_full || "",
                    address_full: urlHints.address_full || "",
                    city: urlHints.city || "",
                    state: urlHints.state || "",
                    zip: urlHints.zip || "",
                    platformListingId: urlHints.platformListingId || "",
                },
                partial: true,
                fetchStatus: status || "blocked",
                fetchError: "Zillow returned a captcha/access-denied title before listing facts could be read.",
            });
        }
    }

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

    const airbnbHints = source === "airbnb" ? parseAirbnbHints(html, description) : {};

    const ldScripts = extractScripts(html, { type: "application/ld+json" });
    const ldJson = ldScripts
        .map((s) => tryJsonParse(s))
        .filter(Boolean)
        .flatMap((j) => (Array.isArray(j) ? j : [j]));

    const fromLd = ldJson.length ? pickFromJsonLd(ldJson) : {};

    const nextDataScripts = extractScripts(html, { id: "__NEXT_DATA__" });
    const nextData = nextDataScripts.length ? tryJsonParse(nextDataScripts[0]) : null;
    const fromNext = nextData ? deepPickCandidates(nextData) : {};

    const fallbackRating = firstNumber(html.match(/rating(?:Value)?\D{0,20}(\d(?:\.\d+)?)/i)?.[1]);
    const fallbackReviews = firstNumber(
        html.match(/(\d+[\d,]*)\s*(?:reviews|review)/i)?.[1]?.replace(/,/g, "")
    );

    const airbnbExtra = source === "airbnb" ? parseAirbnbExtras(html) : {};
    const airbnbDirect = source === "airbnb" ? parseAirbnbDirectHints(html, normalized, title, description) : {};
    let platformHints = parseGenericListingHints(html, sourceInfo, fetched?.finalUrl || normalized);

    // SERP snippets are good for rent/beds/baths, but sqft can be noisy
    // because search results include unrelated numbers.
    if (fetched?.viaSerpApiFallback) {
        delete platformHints.squareFeet;
    }

    if (
        (
            source === "zillow" &&
            !fetched?.viaSearchFallback &&
            (platformHints.bedrooms == null || platformHints.bathrooms == null)
        ) ||
        (
            source === "booking" &&
            !fetched?.viaSearchFallback &&
            (!platformHints.title || !platformHints.image_url)
        ) ||
        (
            source === "vrbo" &&
            !fetched?.viaSearchFallback &&
            (!platformHints.title || !platformHints.image_url)
        )
    ) {
        const q = buildListingSearchFallbackQuery(fetched?.finalUrl || normalized, sourceInfo);
        const searchFetched = await fetchSearchFallbackText(q);
        const focusedSearchText = selectAddressFocusedText(searchFetched?.html || "", fetched?.finalUrl || normalized, sourceInfo);

        if (
            searchFetched?.ok &&
            focusedSearchText &&
            focusedSearchText.length > 120 &&
            !listingTextLooksBlocked(focusedSearchText)
        ) {
            usedSearchFallback = true;
            html = focusedSearchText;
            contentType = searchFetched.contentType || contentType || "text/plain";
            fetched = {
                ...searchFetched,
                ok: true,
                contentType,
                html,
                viaSearchFallback: true,
            };
            platformHints = parseGenericListingHints(html, sourceInfo, fetched?.finalUrl || normalized);
            if (fetched?.viaSerpApiFallback) {
                delete platformHints.squareFeet;
            }
        }
    }

    const urlHintsForMerge = parseListingHintsFromUrl(normalized, sourceInfo);
    const safeTitle = listingTextLooksBlocked(title) ? "" : title;
    const safeDescription = listingTextLooksBlocked(description) ? "" : description;
    const safeLdTitle = listingTextLooksBlocked(fromLd.title) ? "" : fromLd.title;
    const safeLdDescription = listingTextLooksBlocked(fromLd.description) ? "" : fromLd.description;

    const directAirbnbImages =
        source === "airbnb" && Array.isArray(airbnbDirect.images)
            ? airbnbDirect.images
            : [];

    const mergedImages = [
        ...images,
        ...(Array.isArray(platformHints.images) ? platformHints.images : []),
        ...directAirbnbImages,
    ].filter(Boolean);

    const uniqueMergedImages = [...new Set(mergedImages)].slice(0, 12);

    const airbnbAmenities = [
        ...(Array.isArray(airbnbExtra.amenities) ? airbnbExtra.amenities : []),
        ...(Array.isArray(airbnbDirect.amenities) ? airbnbDirect.amenities : []),
    ].filter(Boolean);

    let merged = {
        title:
            platformHints.title ||
            safeLdTitle ||
            safeTitle ||
            platformHints.address_full ||
            urlHintsForMerge.address_full ||
            "",

        description:
            platformHints.description ||
            safeLdDescription ||
            safeDescription ||
            "",

        propertyType: platformHints.propertyType || airbnbDirect.propertyType || "",

        image_url: absUrl(
            fromLd.image_url ||
            meta_image_url ||
            platformHints.image_url ||
            airbnbDirect.image_url ||
            uniqueMergedImages[0] ||
            ""
        ) || "",
        images: uniqueMergedImages,

        rating: platformHints.rating ?? fromLd.rating ?? fromNext.rating ?? fallbackRating ?? null,
        review_count: platformHints.review_count ?? fromLd.review_count ?? fromNext.review_count ?? fallbackReviews ?? null,

        beds:
            platformHints.beds ??
            fromNext.beds ??
            airbnbExtra.beds ??
            airbnbHints.beds ??
            null,

        bedrooms:
            platformHints.bedrooms ??
            fromLd.bedrooms ??
            fromNext.bedrooms ??
            airbnbExtra.bedrooms ??
            airbnbHints.bedrooms ??
            null,

        bathrooms:
            platformHints.bathrooms ??
            fromLd.bathrooms ??
            fromNext.bathrooms ??
            airbnbExtra.bathrooms ??
            airbnbHints.bathrooms ??
            null,

        guestsMax:
            platformHints.guestsMax ??
            airbnbExtra.guestsMax ??
            airbnbHints.guestsMax ??
            null,

        checkInTime: airbnbExtra.checkInTime || airbnbDirect.checkInTime || "",
        checkOutTime: airbnbExtra.checkOutTime || airbnbDirect.checkOutTime || "",
        checkInMethod: airbnbExtra.checkInMethod || airbnbDirect.checkInMethod || "",
        amenities:
            Array.isArray(platformHints.amenities) && platformHints.amenities.length
                ? platformHints.amenities
                : [...new Set(airbnbAmenities)],

        nightlyPrice: platformHints.nightlyPrice ?? null,
        cleaningFee: platformHints.cleaningFee ?? null,

        monthlyPrice: platformHints.monthlyPrice ?? null,
        minimumStay: platformHints.minimumStay || "",
        leaseTerm: platformHints.leaseTerm || "",
        deposit: platformHints.deposit ?? null,
        availableDate: platformHints.availableDate || "",

        furnished: platformHints.furnished ?? null,
        utilitiesIncluded: platformHints.utilitiesIncluded ?? null,
        parking: platformHints.parking ?? null,
        pets: platformHints.pets || "",
        wifiSpeedMbps: platformHints.wifiSpeedMbps ?? null,

        squareFeet: platformHints.squareFeet ?? null,

        propertyUse: platformHints.propertyUse || "",
        leaseOrSale: platformHints.leaseOrSale || "",
        rentOrPrice: platformHints.rentOrPrice ?? null,

        address_full:
            platformHints.address_full ||
            fromLd.address_full ||
            fromNext.address_full ||
            urlHintsForMerge.address_full ||
            "",

        city:
            airbnbHints.city ||
            fromNext.city ||
            platformHints.city ||
            urlHintsForMerge.city ||
            "",

        state:
            airbnbHints.state ||
            fromNext.state ||
            platformHints.state ||
            urlHintsForMerge.state ||
            "",

        zip:
            fromNext.zip ||
            platformHints.zip ||
            urlHintsForMerge.zip ||
            "",

        platformListingId:
            platformHints.platformListingId ||
            airbnbDirect.platformListingId ||
            urlHintsForMerge.platformListingId ||
            "",
    };

    if (source === "booking" || source === "vrbo" || source === "airbnb") {
        merged.monthlyPrice = null;
        merged.rentOrPrice = null;
        merged.propertyUse = "";
        merged.leaseOrSale = "";
        merged.squareFeet = null;
        merged.leaseTerm = "";
        merged.deposit = null;
        merged.availableDate = "";
        merged.furnished = null;
        merged.utilitiesIncluded = null;
        merged.pets = "";
    }

    if (source === "redfin") {
        // Redfin residential rentals should not inherit generic ratings or STR fields.
        merged.rating = null;
        merged.review_count = null;

        merged.guestsMax = null;
        merged.checkInTime = "";
        merged.checkOutTime = "";
        merged.checkInMethod = "";
        merged.nightlyPrice = null;
        merged.cleaningFee = null;

        merged.furnished = null;
        merged.utilitiesIncluded = null;
        merged.propertyUse = "";

        // Keep Redfin monthly rent only.
        if (merged.monthlyPrice != null) {
            merged.rentOrPrice = merged.monthlyPrice;
            merged.leaseOrSale = "For rent";
        }

        if (!Array.isArray(merged.amenities)) {
            merged.amenities = [];
        }
    }

    // Airbnb fallback: infer city/state from title when hidden.
    if (source === "airbnb" && (!merged.city || !merged.state)) {
        const inferred = (function inferCityStateFromTitle(t) {
            const s = String(t || "").replace(/\s+/g, " ").trim();
            const m = s.match(/(.+?)\s*[-—]\s*([A-Z]{2,3})\s*$/);
            if (!m) return { city: "", state: "" };

            const stateCode = m[2].trim();
            const left = m[1].trim();

            const cleanedLeft = left
                .replace(/\b(ch[aá]cara|recanto|s[ií]tio|fazenda|casa|apartamento|apartment|house|condo|studio)\b/gi, " ")
                .replace(/\s+/g, " ")
                .trim();

            const words = cleanedLeft.split(" ").filter(Boolean);

            let city = words.slice(-2).join(" ").trim();

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

    if (source === "airbnb" && airbnbArea && (!merged.city || !merged.state)) {
        const cs = parseCityStateFromArea(airbnbArea);
        if (!merged.city && cs.city) merged.city = cs.city;
        if (!merged.state && cs.state) merged.state = cs.state;
    }

    if (source === "airbnb") {
        if (/Average rating will appear after 3 reviews/i.test(stripHtml(html))) {
            merged.rating = null;
        }

        const nums = [...stripHtml(html).matchAll(/\b(\d[\d,]*)\s*review\b/gi)]
            .map((m) => Number(String(m[1]).replace(/,/g, "")))
            .filter((n) => Number.isFinite(n));

        if (nums.length) merged.review_count = Math.min(...nums);
    }

    const addr = redactAddress(merged.address_full);
    const address_full = addr.full || "";
    const address_redacted = addr.redacted || airbnbArea || "";

    merged.address_full = address_full;
    merged.address_redacted = address_redacted;

    return buildExtractPayload({
        normalized,
        sourceInfo,
        contentType,
        merged,
        partial: usedSearchFallback || !hasUsefulExtractedData(merged),
    });
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

    let fetched;

    try {
        fetched = await fetchHtml(normalized);
    } catch (e) {
        fetched = {
            ok: false,
            status: "network_error",
            contentType: "",
            html: "",
            error: e?.message || "Fetch failed",
        };
    }

    const { ok, status, contentType, html } = fetched || {};

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
