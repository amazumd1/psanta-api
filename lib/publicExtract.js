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
        return { ok: res.ok, status: res.status, contentType: ct, html };
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
    return String(v || "")
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase());
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
        "st", "street", "ave", "avenue", "rd", "road", "dr", "drive", "ln", "lane",
        "ct", "court", "cir", "circle", "blvd", "boulevard", "way", "pl", "place",
        "pkwy", "parkway", "ter", "terrace", "trl", "trail", "loop", "hwy", "highway",
        "path", "walk", "run", "row", "sq", "square", "n", "s", "e", "w", "ne", "nw", "se", "sw",
    ]);

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
        cityParts = beforeState.slice(-2);
        streetParts = beforeState.slice(0, -2);
    } else {
        cityParts = beforeState.slice(-2);
    }

    const street = titleCaseSlugPart(streetParts.join("-"));
    const city = titleCaseSlugPart(cityParts.join("-"));
    const address_full = [street, city, state, zip].filter(Boolean).join(", ");

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
    const s = String(address || "").replace(/\s+/g, " ").trim();

    const m = s.match(/^(.*?),\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})(?:-\d{4})?/i);
    if (!m) return {};

    return {
        address_full: `${m[1].trim()}, ${m[2].trim()}, ${m[3].toUpperCase()} ${m[4]}`,
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
        s.split(/\b(?:Nearby apartments for rent|Similar homes for rent|Price history|Nearby schools)\b/i)[0] || s
    ).trim();

    const pickNumber = (v) => {
        const m = String(v ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
        if (!m) return null;
        const n = Number(m[0]);
        return Number.isFinite(n) ? n : null;
    };

    const pickMoney = (v) => {
        const n = pickNumber(v);
        return n != null ? n : null;
    };

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
        /\bBedrooms?\s*[:\-]?\s*(\d+(?:\.\d+)?)[^\d]{0,120}\bBathrooms?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i
    );

    if (exactFacts) {
        setLayout(exactFacts[1], exactFacts[2]);
    }

    const heroLayout = primary.match(
        /\b(\d+(?:\.\d+)?)\s*(?:bd|bed|beds|bedrooms)\b\s*(?:[,|/·-]|\s){0,12}\s*(\d+(?:\.\d+)?)\s*(?:ba|bath|baths|bathrooms)\b/i
    );

    if (heroLayout) {
        setLayout(heroLayout[1], heroLayout[2]);
    }

    const descLayout = primary.match(
        /\b(?:has|with|rental\s*-\s*)\s*(\d+(?:\.\d+)?)\s*(?:br|bd|bedrooms?|beds?)\s*(?:,|\s|and|&|-){0,20}\s*(\d+(?:\.\d+)?)\s*(?:bathroom|bathrooms|bath|baths|ba)\b/i
    );

    if (descLayout) {
        setLayout(descLayout[1], descLayout[2]);
    }

    if (out.bedrooms == null) {
        const br =
            primary.match(/\bBedrooms?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i)?.[1] ||
            primary.match(/\b(\d+(?:\.\d+)?)\s*(?:bd|bed|beds|bedrooms)\b/i)?.[1];

        const n = pickNumber(br);
        if (n != null && n >= 0 && n <= 20) {
            out.bedrooms = n;
            out.beds = n;
        }
    }

    if (out.bathrooms == null) {
        const ba =
            primary.match(/\bBathrooms?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i)?.[1] ||
            primary.match(/\bFull bathrooms?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i)?.[1] ||
            primary.match(/\b(\d+(?:\.\d+)?)\s*(?:ba|bath|baths|bathrooms)\b/i)?.[1];

        const n = pickNumber(ba);
        if (n != null && n >= 0 && n <= 30) {
            out.bathrooms = n;
        }
    }

    const price =
        primary.match(/\$\s*([\d,]+)\s*(?:\/\s*)?(?:mo|month|monthly)\b/i)?.[1] ||
        primary.match(/\bListed for rent\s*\$\s*([\d,]+)\b/i)?.[1] ||
        primary.match(/\bfor rent\s*\$\s*([\d,]+)\b/i)?.[1];

    if (price) {
        out.monthlyPrice = pickMoney(price);
    }

    const sqft = primary.match(/\b([\d,]{3,8})\s*(?:sq\.?\s*ft\.?|sqft|sf|square\s+feet)\b/i)?.[1];
    if (sqft && !/^--/.test(sqft)) {
        out.squareFeet = pickNumber(sqft);
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



function parseGenericListingHints(html, sourceInfo = {}) {
    const text = stripHtml(html || "");
    const compact = text.replace(/\s+/g, " ").trim();
    const out = {};

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

    const layoutPair = compact.match(
        /\b(\d+(?:\.\d+)?)\s*(?:bd|bed|beds|bedrooms)\b.{0,70}?\b(\d+(?:\.\d+)?)\s*(?:ba|full\s+ba|total\s+ba|bath|baths|bathrooms|full\s+baths|total\s+baths|full\s+bathrooms|total\s+bathrooms)\b/i
    );

    const mainChunk = String(
        compact.split(/\b(?:Nearby apartments for rent|Similar homes for rent|Price history|Nearby schools)\b/i)[0] || compact
    ).trim();

    const layoutPair = mainChunk.match(
        /\b(\d+(?:\.\d+)?)\s*(?:bd|br|bed|beds|bedrooms)\b.{0,80}?\b(\d+(?:\.\d+)?)\s*(?:ba|bath|baths|bathroom|bathrooms|full\s+baths|total\s+baths)\b/i
    );

    const bedrooms =
        firstNumber(layoutPair?.[1]) ??
        firstNumber(mainChunk.match(/\bBedrooms?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i)?.[1]) ??
        firstNumber(mainChunk.match(/\b(\d+(?:\.\d+)?)\s*(?:bd|br|beds?|bedrooms?)\b/i)?.[1]);

    const bathrooms =
        firstNumber(layoutPair?.[2]) ??
        firstNumber(mainChunk.match(/\bBathrooms?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i)?.[1]) ??
        firstNumber(mainChunk.match(/\bFull bathrooms?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i)?.[1]) ??
        firstNumber(mainChunk.match(/\b(\d+(?:\.\d+)?)\s*(?:ba|baths?|bathrooms?)\b/i)?.[1]);

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

    if (/\bfor\s+lease\b/i.test(compact)) out.leaseOrSale = "For lease";
    else if (/\bfor\s+sale\b/i.test(compact)) out.leaseOrSale = "For sale";

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

    const readerFallbackSources = new Set([
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
    ]);

    if (
        readerFallbackSources.has(sourceInfo.source) &&
        (
            !ok ||
            !html ||
            html.length < 200 ||
            (sourceInfo.source === "zillow" && zillowTextLooksThin(html))
        )
    ) {
        const readerFetched = await fetchReaderText(normalized);

        if (readerFetched?.ok && readerFetched?.html && readerFetched.html.length > 300) {
            fetched = {
                ...readerFetched,
                html: `${html || ""}\n\n${readerFetched.html}`,
                contentType: readerFetched.contentType || contentType || "text/plain",
                status: readerFetched.status || status,
                ok: true,
                viaReader: true,
            };

            ok = fetched.ok;
            status = fetched.status;
            contentType = fetched.contentType;
            html = fetched.html;
        }
    }

    // IMPORTANT:
    // Supported public platforms should not hard-fail with 400 just because
    // Zillow/Realtor/Apartments/LoopNet blocked server-side HTML.
    // Return ok:true + partial:true so frontend can keep detected platform/type
    // and URL-derived address hints.
    if (!ok || !html || html.length < 200) {
        return buildExtractPayload({
            normalized,
            sourceInfo,
            contentType: contentType || "",
            merged: {},
            partial: true,
            fetchStatus: status || "unknown",
            fetchError: fetched?.error || `Fetch failed (${status || "unknown"}).`,
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
    let platformHints = parseGenericListingHints(html, sourceInfo);

    // Zillow can return a large page shell that still misses the real listing facts.
    // If core rental facts are missing, try reader text and re-parse before merging.
    if (
        source === "zillow" &&
        !fetched?.viaReader &&
        (platformHints.bedrooms == null || platformHints.bathrooms == null)
    ) {
        const readerFetched = await fetchReaderText(normalized);

        if (readerFetched?.ok && readerFetched?.html && readerFetched.html.length > 300) {
            html = `${html || ""}\n\n${readerFetched.html}`;
            contentType = readerFetched.contentType || contentType || "text/plain";
            platformHints = parseGenericListingHints(html, sourceInfo);
        }
    }

    let merged = {
        title: fromLd.title || title || "",
        description: fromLd.description || description || "",

        propertyType: platformHints.propertyType || "",

        image_url: absUrl(fromLd.image_url || meta_image_url || "") || "",
        images,

        rating: fromLd.rating ?? fromNext.rating ?? fallbackRating ?? null,
        review_count: fromLd.review_count ?? fromNext.review_count ?? fallbackReviews ?? null,

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

address_full: fromLd.address_full || fromNext.address_full || platformHints.address_full || "",

city: airbnbHints.city || fromNext.city || platformHints.city || "",
state: airbnbHints.state || fromNext.state || platformHints.state || "",
zip: fromNext.zip || platformHints.zip || "",

        guestsMax: airbnbExtra.guestsMax ?? airbnbHints.guestsMax ?? null,
        checkInTime: airbnbExtra.checkInTime || "",
        checkOutTime: airbnbExtra.checkOutTime || "",
        checkInMethod: airbnbExtra.checkInMethod || "",
        amenities: airbnbExtra.amenities || [],

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
    };

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
        partial: !hasUsefulExtractedData(merged),
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
