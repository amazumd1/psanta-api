const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const UserEvent = require("../models/UserEvent");
const ProductInterest = require("../models/ProductInterest");
const CuratedInterestRequest = require("../models/CuratedInterestRequest");
const VendorLead = require("../models/VendorLead");
const AiIntent = require("../models/AiIntent");
const SearchbaseRecommendation = require("../models/SearchbaseRecommendation");
const CuratedLook = require("../models/CuratedLook");

const router = express.Router();

const curatedAssetDir = path.join(__dirname, "..", "uploads", "curated-composer");
fs.mkdirSync(curatedAssetDir, { recursive: true });

const ROOMGPT_THEME_COPY = {
    "modern-coastal":
        "modern coastal short-term-rental bedroom, bright beach house, light wood, linen, woven accents, clean and inviting",
    "luxury-neutral":
        "luxury neutral boutique hotel room, cream and taupe palette, premium bedding, refined lamps, elegant storage",
    "warm-boho":
        "warm boho rental room, earthy palette, woven textures, rattan accents, cozy guest-ready styling",
    "japandi-clean":
        "Japandi clean minimal room, low clutter, natural wood, calm neutral palette, soft daylight",
    "family-str":
        "durable family short-term-rental room, bright practical furniture, easy turnover, guest friendly",
    "black-white-luxe":
        "black and white luxe boutique hotel room, crisp contrast, brass accents, premium modern furniture",
    "beach-airbnb":
        "beach Airbnb vacation room, airy coastal palette, light furniture, blue accents, cheerful rental design",
};

function buildRoomGptPrompt({ roomType, themeId, themeTitle, market }) {
    const themeCopy = ROOMGPT_THEME_COPY[themeId] || ROOMGPT_THEME_COPY["modern-coastal"];
    const room = text(roomType || "bedroom", 60).replace(/_/g, " ");
    const location = text(market || "South Florida", 120);

    return [
        `Redesign this ${room} into a ${themeTitle || themeId} curated home concept for ${location}.`,
        `Preserve the original camera angle, room architecture, walls, windows, doors, ceiling fixtures, and flooring.`,
        `Replace the visible furniture and decor with a coherent ${themeCopy} design.`,
        `Make it look like a professional RoomGPT-style before/after for a rental-ready model home.`,
        `Keep proportions realistic, keep the room believable, avoid distorted furniture, avoid changing structural layout.`,
        `Output should be photorealistic, bright, clean, aspirational, and ready for investor/demo review.`,
    ].join(" ");
}

function roomGptProviderMode() {
    const provider = text(process.env.ROOMGPT_PROVIDER || "mock", 40).toLowerCase();
    if (["openai", "replicate", "google", "mock"].includes(provider)) return provider;
    return "mock";
}

const SHOP_ROOM_FALLBACK_IMAGES = {
    bedroom: "https://images.unsplash.com/photo-1616594039964-3a2e148d1f84?auto=format&fit=crop&w=1400&q=88",
    living_room: "https://images.unsplash.com/photo-1493809842364-78817add7ffb?auto=format&fit=crop&w=1400&q=88",
    kitchen: "https://images.unsplash.com/photo-1556910103-1c02745aae4d?auto=format&fit=crop&w=1400&q=88",
};

const SHOP_ROOM_FALLBACK_PRODUCTS = {
    bedroom: [
        ["bed", "Source-matched upholstered bed", "furniture", 1295, "Hero bed"],
        ["bedding", "Layered linen bedding set", "decor", 220, "Bedding"],
        ["nightstand", "Warm wood nightstand pair", "furniture", 540, "Nightstands"],
        ["lamp", "Ceramic table lamps", "decor", 260, "Lamps"],
        ["rug", "Neutral bedroom rug", "decor", 480, "Rug"],
        ["art", "Soft wall art set", "decor", 240, "Wall art"],
    ],
    living_room: [
        ["sofa", "Source-matched performance sofa", "furniture", 1399, "Sofa"],
        ["chair", "Natural accent chair", "furniture", 360, "Accent chair"],
        ["table", "Textured coffee table", "furniture", 440, "Coffee table"],
        ["rug", "Neutral area rug", "decor", 620, "Rug"],
        ["art", "Statement wall art", "decor", 295, "Wall art"],
        ["tray", "Styled tray accessories", "decor", 125, "Tray"],
    ],
    kitchen: [
        ["counter", "Counter styling tray", "host", 88, "Counter tray"],
        ["soap", "Organic sink refill pair", "cleaning", 58, "Soap"],
        ["tray", "Coffee and tea station", "host", 72, "Coffee station"],
        ["art", "Small-maker kitchen decor", "decor", 125, "Decor"],
    ],
};

function safeUrl(value) {
    const raw = text(value, 900);
    try {
        const parsed = new URL(raw);
        if (!["http:", "https:"].includes(parsed.protocol)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function sourceHost(value) {
    try {
        return new URL(value).hostname.replace(/^www\./i, "");
    } catch {
        return "Furniture source";
    }
}

function decodeHtml(value = "") {
    return String(value || "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

function attrFromHtml(tag = "", name = "") {
    const re = new RegExp(`${name}=["']([^"']+)["']`, "i");
    return decodeHtml(tag.match(re)?.[1] || "");
}

function metaContent(html = "", key = "") {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i");
    const tag = html.match(re)?.[0] || "";
    return attrFromHtml(tag, "content");
}

function pageTitle(html = "") {
    return decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
        .replace(/\s+/g, " ")
        .trim();
}

function absoluteAssetUrl(asset = "", pageUrl = "") {
    if (!asset) return "";
    try {
        return new URL(asset, pageUrl).toString();
    } catch {
        return asset;
    }
}

function parseJsonLdProducts(html = "", pageUrl = "") {
    const scripts = Array.from(html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
    const products = [];

    function visit(node) {
        if (!node || products.length >= 10) return;
        if (Array.isArray(node)) return node.forEach(visit);
        if (typeof node !== "object") return;

        const type = Array.isArray(node["@type"]) ? node["@type"].join(" ") : String(node["@type"] || "");
        if (/Product/i.test(type)) {
            const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers || {};
            const image = Array.isArray(node.image) ? node.image[0] : node.image;
            products.push({
                title: text(node.name || "Furniture item", 220),
                price: num(offer.price || offer.lowPrice || offer.highPrice, null),
                image: absoluteAssetUrl(text(image, 800), pageUrl),
                sourceUrl: absoluteAssetUrl(text(node.url || offer.url || pageUrl, 800), pageUrl),
            });
        }

        if (node["@graph"]) visit(node["@graph"]);
        if (node.itemListElement) visit(node.itemListElement.map((item) => item.item || item));
    }

    scripts.forEach((match) => {
        try {
            visit(JSON.parse(decodeHtml(match[1]).trim()));
        } catch {
            // Ignore malformed JSON-LD. Many retail sites inject partial objects.
        }
    });

    return products.filter((item) => item.title).slice(0, 8);
}

function buildShopRoomProducts({ roomType, themeId, sourceUrl, sourceName, sourceImage, htmlProducts }) {
    const fallbackRows = SHOP_ROOM_FALLBACK_PRODUCTS[roomType] || SHOP_ROOM_FALLBACK_PRODUCTS.living_room;
    const multiplier = String(themeId || "").includes("luxury") ? 1.08 : String(themeId || "").includes("family") ? 0.92 : 1;
    const source = sourceName || sourceHost(sourceUrl);
    const parsed = Array.isArray(htmlProducts) ? htmlProducts : [];

    return fallbackRows.map(([slotKey, fallbackTitle, category, basePrice, slotLabel], index) => {
        const parsedProduct = parsed[index] || {};
        const price = parsedProduct.price ? Math.round(Number(parsedProduct.price)) : Math.round(basePrice * multiplier);
        return {
            productId: `shop-room-${source.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${slotKey}-${index + 1}`,
            title: parsedProduct.title || fallbackTitle,
            category,
            productStatus: "source_review",
            price,
            role: index === 0 ? "hero" : index <= 3 ? "supporting" : "accent",
            slotKey,
            slotLabel,
            image: parsedProduct.image || sourceImage || SHOP_ROOM_FALLBACK_IMAGES[roomType] || SHOP_ROOM_FALLBACK_IMAGES.living_room,
            sourceProductId: "shop-room-source-fetch",
            sourceName: source,
            sourceUrl: parsedProduct.sourceUrl || sourceUrl,
        };
    });
}

const curatedAssetUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, curatedAssetDir),
        filename: (_req, file, cb) => {
            const ext = path.extname(file.originalname || "").toLowerCase() || ".png";
            const safeExt = [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : ".png";
            cb(null, `curated-${Date.now()}-${Math.random().toString(16).slice(2)}${safeExt}`);
        },
    }),
    limits: { fileSize: 12 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
        if (/^image\/(png|jpeg|jpg|webp)$/i.test(file.mimetype || "")) return cb(null, true);
        return cb(new Error("Only PNG, JPG, JPEG, or WEBP images are allowed."));
    },
});

function text(value, max = 255) {
    return String(value ?? "").trim().slice(0, max);
}

function num(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function zip(value) {
    const match = text(value, 40).match(/\b\d{5}(?:-\d{4})?\b/);
    return match ? match[0].slice(0, 10) : "";
}

function arr(value, max = 24) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => text(item, 140)).filter(Boolean).slice(0, max);
}

function metaObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};

    const out = {};
    Object.entries(value)
        .slice(0, 60)
        .forEach(([key, raw]) => {
            const cleanKey = text(key, 80).replace(/[^a-zA-Z0-9_.:-]/g, "_");
            if (!cleanKey) return;

            if (raw === null || typeof raw === "boolean" || typeof raw === "number") {
                out[cleanKey] = raw;
                return;
            }

            if (Array.isArray(raw)) {
                out[cleanKey] = raw.slice(0, 24).map((item) => text(item, 220));
                return;
            }

            if (typeof raw === "object") {
                out[cleanKey] = text(JSON.stringify(raw), 1000);
                return;
            }

            out[cleanKey] = text(raw, 1000);
        });

    return out;
}

function isProductInterest(name = "", payload = {}) {
    const n = text(name, 160).toLowerCase();
    return (
        n === "shops_request_availability" ||
        n === "shops_product_summary_request" ||
        n.includes("request_availability") ||
        n.includes("notify_restock") ||
        Boolean(payload.productId && n.includes("request"))
    );
}

function isCuratedRequest(name = "", payload = {}) {
    const n = text(name, 160).toLowerCase();
    return (
        n === "collections_estimate_clicked" ||
        n === "collections_shop_this_look_clicked" ||
        n === "collections_upload_photos_clicked" ||
        n === "collections_ai_design_clicked" ||
        n.includes("curation_estimate") ||
        Boolean((payload.projectId || payload.lookId) && (n.includes("estimate") || n.includes("shop_this_look") || n.includes("ai_design")))
    );
}

function isVendorLead(name = "") {
    const n = text(name, 160).toLowerCase();
    return n === "careers_interest_submitted" || n.includes("vendor_lead") || n.includes("careers_interest");
}

function isAiIntent(name = "", payload = {}) {
    const n = text(name, 160).toLowerCase();
    return n.includes("ai") || n.includes("chatbot") || Boolean(payload.intent && payload.flow === "ai");
}

function normalizedEvent(body = {}, req) {
    const payload = metaObject(body.payload || body.meta || body);
    const eventName = text(body.eventName || body.name || payload.eventName || payload.name || "ps_event", 120);
    const eventType = text(body.eventType || payload.eventType || "custom_event", 60);

    return {
        eventName,
        eventType,
        flow: text(body.flow || payload.flow, 80),
        step: text(body.step || payload.step || payload.stage, 120),
        intent: text(body.intent || payload.intent || payload.detectedIntent, 120),
        serviceType: text(body.serviceType || payload.serviceType || payload.service, 120),
        page: text(body.page || payload.page, 120),
        path: text(body.path || payload.path || req.headers.referer || "", 300),
        source: text(body.source || payload.source || "frontPage", 80),
        productId: text(body.productId || payload.productId, 140),
        productTitle: text(body.productTitle || payload.productTitle, 220),
        productCategory: text(body.productCategory || payload.productCategory || payload.category, 120),
        productStatus: text(body.productStatus || payload.productStatus, 80),
        lookId: text(body.lookId || payload.lookId || payload.sourceLookId || payload.activeLookId || payload.projectId, 140),
        lookTitle: text(body.lookTitle || payload.lookTitle || payload.sourceLookTitle || payload.activeLookTitle || payload.projectTitle, 220),
        projectId: text(body.projectId || payload.projectId || payload.lookId, 140),
        projectTitle: text(body.projectTitle || payload.projectTitle || payload.lookTitle, 220),
        zip: zip(body.zip || payload.zip || payload.serviceZip || payload.postalCode),
        role: text(body.role || payload.role || payload.roleLabel, 120),
        category: text(body.category || payload.category || payload.productCategory, 120),
        visitorId: text(body.visitorId || payload.visitorId, 120),
        sessionId: text(body.sessionId || payload.sessionId, 120),
        userAgent: text(body.userAgent || body.ua || payload.ua || req.headers["user-agent"], 260),
        referrer: text(body.referrer || payload.referrer || req.headers.referer, 400),
        meta: payload,
    };
}

function productDocFromEvent(event, body = {}) {
    const meta = event.meta || {};
    return {
        action: text(body.action || meta.action || event.eventName, 80) || "request_availability",
        productId: event.productId,
        productTitle: event.productTitle,
        category: event.productCategory || event.category,
        productStatus: event.productStatus,
        price: num(body.price ?? meta.quoteAmount ?? meta.price, null),
        minimumPurchase: num(body.minimumPurchase ?? meta.minimumPurchase, 50),
        sourceLookId: text(body.sourceLookId || meta.sourceLookId || event.lookId, 140),
        sourceLookTitle: text(body.sourceLookTitle || meta.sourceLookTitle || event.lookTitle, 220),
        activeLookId: text(body.activeLookId || meta.activeLookId, 140),
        activeLookTitle: text(body.activeLookTitle || meta.activeLookTitle, 220),
        path: event.path,
        visitorId: event.visitorId,
        sessionId: event.sessionId,
        zip: event.zip,
        source: event.source,
        meta,
    };
}

function curatedDocFromEvent(event, body = {}) {
    const meta = event.meta || {};
    return {
        action: text(body.action || meta.action || event.eventName, 80) || "curated_request",
        lookId: event.lookId,
        lookTitle: event.lookTitle,
        projectId: event.projectId,
        projectTitle: event.projectTitle,
        intent: event.intent || text(meta.intent, 120),
        productIds: arr(body.productIds || meta.productIds || meta.usedInLookIds),
        productCount: num(body.productCount ?? meta.productCount, 0),
        zip: event.zip,
        path: event.path,
        visitorId: event.visitorId,
        sessionId: event.sessionId,
        source: event.source,
        meta,
    };
}

function aiDocFromEvent(event, body = {}) {
    const meta = event.meta || {};
    return {
        contextType: text(body.contextType || meta.contextType || event.flow || event.page || "frontpage", 80),
        intent: event.intent || text(body.intent || meta.intent || event.eventName, 140),
        userMessage: text(body.userMessage || meta.userMessage || meta.message || meta.prompt, 2000),
        page: event.page,
        path: event.path,
        productId: event.productId,
        productTitle: event.productTitle,
        lookId: event.lookId,
        lookTitle: event.lookTitle,
        projectId: event.projectId,
        projectTitle: event.projectTitle,
        zip: event.zip,
        category: event.category || event.productCategory,
        visitorId: event.visitorId,
        sessionId: event.sessionId,
        source: event.source,
        meta,
    };
}

function parseRange(value) {
    const raw = text(value || "30d", 20).toLowerCase();
    const match = raw.match(/^(\d{1,3})(d|day|days)?$/);
    const days = Math.max(1, Math.min(90, match ? Number(match[1]) : 30));
    return { label: `${days}d`, days, start: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
}

async function countSince(Model, start, match = {}) {
    return Model.countDocuments({ createdAt: { $gte: start }, ...match });
}

async function topBy(Model, start, field, limit = 8, match = {}) {
    const path = String(field || "").replace(/^\$/, "");
    if (!path) return [];

    return Model.aggregate([
        { $match: { createdAt: { $gte: start }, ...match, [path]: { $exists: true, $nin: ["", null] } } },
        {
            $group: {
                _id: `$${path}`,
                count: { $sum: 1 },
                latestAt: { $max: "$createdAt" },
                sampleTitle: { $last: "$productTitle" },
                sampleLookTitle: { $last: "$lookTitle" },
                sampleProjectTitle: { $last: "$projectTitle" },
                sampleRoleLabel: { $last: "$roleLabel" },
                sampleCategory: { $last: "$category" },
                sampleStatus: { $last: "$productStatus" },
            },
        },
        { $sort: { count: -1, latestAt: -1 } },
        { $limit: limit },
    ]).then((rows) =>
        rows.map((row) => ({
            id: text(row._id, 160),
            count: Number(row.count || 0),
            latestAt: row.latestAt,
            title: text(row.sampleTitle || row.sampleLookTitle || row.sampleProjectTitle || row.sampleRoleLabel || row._id, 220),
            category: text(row.sampleCategory, 120),
            status: text(row.sampleStatus, 80),
        }))
    );
}

async function buildSearchbaseSnapshot(rangeLabel = "30d") {
    const range = parseRange(rangeLabel);
    const start = range.start;

    const [
        eventCount,
        productInterestCount,
        curatedRequestCount,
        vendorLeadCount,
        aiIntentCount,
        topProducts,
        topLooks,
        topZips,
        topVendorZips,
        topRoles,
        topCategories,
        topEvents,
        recentProductInterests,
        recentCuratedRequests,
        recentVendorLeads,
    ] = await Promise.all([
        countSince(UserEvent, start),
        countSince(ProductInterest, start),
        countSince(CuratedInterestRequest, start),
        countSince(VendorLead, start),
        countSince(AiIntent, start),
        topBy(ProductInterest, start, "productId", 8),
        topBy(CuratedInterestRequest, start, "lookId", 8),
        topBy(UserEvent, start, "zip", 8),
        topBy(VendorLead, start, "zip", 8),
        topBy(VendorLead, start, "role", 8),
        topBy(ProductInterest, start, "category", 8),
        topBy(UserEvent, start, "eventName", 10),
        ProductInterest.find({ createdAt: { $gte: start } }).sort({ createdAt: -1 }).limit(8).lean(),
        CuratedInterestRequest.find({ createdAt: { $gte: start } }).sort({ createdAt: -1 }).limit(8).lean(),
        VendorLead.find({ createdAt: { $gte: start } }).sort({ createdAt: -1 }).limit(8).lean(),
    ]);

    const topZipSet = new Map();
    [...topZips, ...topVendorZips].forEach((item) => {
        if (!item.id) return;
        const current = topZipSet.get(item.id) || { ...item, count: 0 };
        current.count += Number(item.count || 0);
        current.latestAt =
            current.latestAt && item.latestAt && new Date(current.latestAt) > new Date(item.latestAt)
                ? current.latestAt
                : item.latestAt;
        topZipSet.set(item.id, current);
    });

    return {
        range: range.label,
        generatedAt: new Date().toISOString(),
        counts: {
            events: eventCount,
            productInterests: productInterestCount,
            curatedRequests: curatedRequestCount,
            vendorLeads: vendorLeadCount,
            aiIntents: aiIntentCount,
        },
        topProducts,
        topLooks,
        topZips: Array.from(topZipSet.values()).sort((a, b) => b.count - a.count).slice(0, 8),
        topRoles,
        topCategories,
        topEvents,
        recent: {
            productInterests: recentProductInterests.map((item) => ({
                id: String(item._id),
                productId: item.productId,
                productTitle: item.productTitle,
                category: item.category,
                productStatus: item.productStatus,
                sourceLookId: item.sourceLookId || item.activeLookId || "",
                sourceLookTitle: item.sourceLookTitle || item.activeLookTitle || "",
                createdAt: item.createdAt,
            })),
            curatedRequests: recentCuratedRequests.map((item) => ({
                id: String(item._id),
                lookId: item.lookId || item.projectId,
                lookTitle: item.lookTitle || item.projectTitle,
                action: item.action,
                productCount: item.productCount,
                zip: item.zip,
                createdAt: item.createdAt,
            })),
            vendorLeads: recentVendorLeads.map((item) => ({
                id: String(item._id),
                zip: item.zip,
                role: item.role,
                roleLabel: item.roleLabel,
                availability: item.availability,
                createdAt: item.createdAt,
            })),
        },
    };
}

function rec(priority, type, title, reason, action, meta = {}) {
    return {
        id: `${type}_${String(title || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_|_$/g, "")
            .slice(0, 40) || Date.now()}`,
        priority,
        type,
        title,
        reason,
        action,
        meta,
    };
}

function buildHeuristicRecommendations(snapshot) {
    const out = [];
    const topProduct = snapshot.topProducts?.[0];
    const topLook = snapshot.topLooks?.[0];
    const topZip = snapshot.topZips?.[0];
    const topRole = snapshot.topRoles?.[0];
    const topCategory = snapshot.topCategories?.[0];

    if (topProduct) {
        out.push(
            rec(
                topProduct.count >= 3 ? "high" : "medium",
                "product_demand",
                `Prioritize ${topProduct.title || topProduct.id}`,
                `${topProduct.count} product interest signal${topProduct.count === 1 ? "" : "s"} came in for this item during ${snapshot.range}.`,
                "Check stock/admin approval, then connect it to 1–2 curated looks and keep Request Availability active until checkout is ready.",
                { productId: topProduct.id, count: topProduct.count, category: topProduct.category, status: topProduct.status }
            )
        );
    }

    if (topLook) {
        out.push(
            rec(
                topLook.count >= 3 ? "high" : "medium",
                "curated_look",
                `Make ${topLook.title || topLook.id} more actionable`,
                `${topLook.count} curated look signal${topLook.count === 1 ? "" : "s"} came from this portfolio card.`,
                "Add a clearer estimate CTA, confirm linked products, and prepare a simple labor/product checklist for this look.",
                { lookId: topLook.id, count: topLook.count }
            )
        );
    }

    if (topZip) {
        out.push(
            rec(
                topZip.count >= 4 ? "high" : "medium",
                "zip_demand",
                `Review ZIP ${topZip.id}`,
                `${topZip.count} signal${topZip.count === 1 ? "" : "s"} are tied to this ZIP across events/leads.`,
                "Check whether pricing, vendor coverage, and service availability are ready for this ZIP before opening checkout.",
                { zip: topZip.id, count: topZip.count }
            )
        );
    }

    if (topRole) {
        out.push(
            rec(
                topRole.count >= 2 ? "medium" : "low",
                "vendor_supply",
                `Build ${topRole.title || topRole.id} coverage`,
                `${topRole.count} vendor lead${topRole.count === 1 ? "" : "s"} selected this skill.`,
                "Keep collecting ZIP-specific vendor leads and match this skill to curated/service requests when demand appears.",
                { role: topRole.id, count: topRole.count }
            )
        );
    }

    if (topCategory) {
        out.push(
            rec(
                "medium",
                "shop_category",
                `Create a bundle around ${topCategory.id}`,
                `${topCategory.count} product interest signal${topCategory.count === 1 ? "" : "s"} are in this shop category.`,
                "Turn the category into a small shop bundle and feature it in the most relevant curated look.",
                { category: topCategory.id, count: topCategory.count }
            )
        );
    }

    if (!out.length) {
        out.push(
            rec(
                "low",
                "data_quality",
                "Collect more searchbase signals",
                "There is not enough Mongo searchbase data yet to rank demand confidently.",
                "Drive traffic to Shop this look, Request availability, Request estimate, and Careers by ZIP so the next recommendation run has useful data."
            )
        );
    }

    out.push(
        rec(
            "low",
            "llm_next_step",
            "Keep this phase LLM-ready",
            "The saved events now contain product, curated look, ZIP, role, and intent context.",
            "Next phase can add the customer-facing AI modal that reads this same context and explains recommended products/looks to users.",
            { aiIntents: snapshot.counts?.aiIntents || 0 }
        )
    );

    return out.slice(0, 7);
}

function safeJsonFromText(rawText) {
    const raw = text(rawText, 12000);
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

function buildRecommendationPrompt(snapshot) {
    return `You are PropertySanta's searchbase growth operator. Analyze this Mongo searchbase snapshot and return JSON only.
Goal: recommend what the team should do next for Shop, Curated Homes, vendor ZIP coverage, and LLM-ready product/design intelligence.
Rules: Do not invent data. Use only this snapshot. Keep recommendations practical and short. Mention if data is limited.
Return exactly this shape:
{
  "headline": "short headline",
  "summary": "2-3 sentence summary",
  "confidence": 0-100,
  "recommendations": [
    {"priority":"high|medium|low", "type":"product_demand|curated_look|zip_demand|vendor_supply|shop_category|data_quality|llm_next_step", "title":"...", "reason":"...", "action":"..."}
  ]
}
Snapshot JSON:
${JSON.stringify(snapshot).slice(0, 14000)}`;
}

async function generateGeminiRecommendations(snapshot) {
    const apiKey = text(
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        process.env.GOOGLE_AI_API_KEY ||
        "",
        300
    );

    if (!apiKey) return null;

    let GoogleGenerativeAI;
    try {
        GoogleGenerativeAI = require("@google/generative-ai").GoogleGenerativeAI;
    } catch {
        return null;
    }

    const prompt = buildRecommendationPrompt(snapshot);
    const genAI = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.SEARCHBASE_GEMINI_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    const raw = result?.response?.text?.() || "";
    const parsed = safeJsonFromText(raw);
    if (!parsed || typeof parsed !== "object") return { prompt, raw, parsed: null };

    return {
        prompt,
        raw,
        parsed: {
            headline: text(parsed.headline, 240),
            summary: text(parsed.summary, 1400),
            confidence: Math.max(0, Math.min(100, Number(parsed.confidence || 0))),
            recommendations: Array.isArray(parsed.recommendations)
                ? parsed.recommendations.slice(0, 8).map((item, index) => ({
                    id: text(item.id || `llm_rec_${index + 1}`, 120),
                    priority: ["high", "medium", "low"].includes(text(item.priority, 20)) ? text(item.priority, 20) : "medium",
                    type: text(item.type || "llm_next_step", 80),
                    title: text(item.title, 220),
                    reason: text(item.reason, 700),
                    action: text(item.action, 800),
                    meta: metaObject(item.meta || {}),
                })).filter((item) => item.title || item.action)
                : [],
        },
    };
}

async function buildRecommendationResult({ range = "30d", useLlm = false } = {}) {
    const snapshot = await buildSearchbaseSnapshot(range);
    const heuristic = buildHeuristicRecommendations(snapshot);
    let generatedBy = "heuristic";
    let status = "fallback";
    let llmPrompt = buildRecommendationPrompt(snapshot);
    let llmRaw = "";
    let headline = "Mongo searchbase recommendation seed is ready";
    let summary =
        "This report ranks product demand, curated look interest, ZIP demand, and vendor signals from MongoDB. It is safe to use before external sourcing/automation is added.";
    let confidence = Math.min(
        88,
        Math.max(
            35,
            (snapshot.counts.events || 0) * 4 +
            (snapshot.counts.productInterests || 0) * 7 +
            (snapshot.counts.curatedRequests || 0) * 7
        )
    );
    let recommendations = heuristic;

    if (useLlm) {
        try {
            const llm = await generateGeminiRecommendations(snapshot);
            if (llm?.prompt) llmPrompt = llm.prompt;
            if (llm?.raw) llmRaw = llm.raw;
            if (llm?.parsed?.recommendations?.length) {
                generatedBy = "gemini";
                status = "ok";
                headline = llm.parsed.headline || headline;
                summary = llm.parsed.summary || summary;
                confidence = llm.parsed.confidence || confidence;
                recommendations = llm.parsed.recommendations;
            }
        } catch (error) {
            llmRaw = text(error?.message || "llm_failed", 2000);
        }
    }

    return { status, generatedBy, headline, summary, confidence, recommendations, snapshot, llmPrompt, llmRaw };
}

router.post("/events/track", async (req, res) => {
    try {
        const event = normalizedEvent(req.body || {}, req);
        const created = await UserEvent.create(event);

        const fanout = [];
        if (event.productId && isProductInterest(event.eventName, event.meta)) {
            fanout.push(ProductInterest.create(productDocFromEvent(event, req.body || {})));
        }
        if ((event.lookId || event.projectId) && isCuratedRequest(event.eventName, event.meta)) {
            fanout.push(CuratedInterestRequest.create(curatedDocFromEvent(event, req.body || {})));
        }
        if (isVendorLead(event.eventName)) {
            fanout.push(
                VendorLead.create({
                    zip: event.zip,
                    role: event.role,
                    roleLabel: text(event.meta.roleLabel || event.meta.role || event.role, 160),
                    path: event.path,
                    visitorId: event.visitorId,
                    sessionId: event.sessionId,
                    source: "analytics_event",
                    meta: event.meta,
                })
            );
        }
        if (isAiIntent(event.eventName, event.meta)) {
            fanout.push(AiIntent.create(aiDocFromEvent(event, req.body || {})));
        }

        await Promise.allSettled(fanout);

        res.json({ ok: true, id: created._id, fanout: fanout.length });
    } catch (error) {
        console.error("searchbase events/track failed", error);
        res.status(200).json({ ok: false, message: error.message || "Event capture failed" });
    }
});

router.post("/shop/interest", async (req, res) => {
    try {
        const event = normalizedEvent({ ...(req.body || {}), eventName: "shop_interest_direct" }, req);
        if (!event.productId) return res.status(400).json({ ok: false, message: "productId required" });

        const doc = await ProductInterest.create(productDocFromEvent(event, req.body || {}));
        await UserEvent.create({ ...event, eventName: "shop_interest_direct" });
        res.json({ ok: true, id: doc._id });
    } catch (error) {
        console.error("shop interest failed", error);
        res.status(500).json({ ok: false, message: error.message || "Shop interest failed" });
    }
});

router.post("/curated/request", async (req, res) => {
    try {
        const event = normalizedEvent({ ...(req.body || {}), eventName: "curated_request_direct" }, req);
        if (!event.lookId && !event.projectId) {
            return res.status(400).json({ ok: false, message: "lookId or projectId required" });
        }

        const doc = await CuratedInterestRequest.create(curatedDocFromEvent(event, req.body || {}));
        await UserEvent.create({ ...event, eventName: "curated_request_direct" });
        res.json({ ok: true, id: doc._id });
    } catch (error) {
        console.error("curated request failed", error);
        res.status(500).json({ ok: false, message: error.message || "Curated request failed" });
    }
});

router.post("/careers/lead", async (req, res) => {
    try {
        const body = req.body || {};
        const cleanZip = zip(body.zip || body.postalCode);
        const role = text(body.role || body.roleLabel, 120);
        const contact = text(body.contact || body.email || body.phone, 220);

        if (!cleanZip || !role || !contact) {
            return res.status(400).json({ ok: false, message: "zip, role, and contact are required" });
        }

        const doc = await VendorLead.create({
            name: text(body.name, 160),
            contact,
            zip: cleanZip,
            role,
            roleLabel: text(body.roleLabel || body.role, 160),
            availability: text(body.availability, 120),
            hasTools: text(body.hasTools, 40),
            note: text(body.note, 1200),
            path: text(body.path || req.headers.referer, 300),
            visitorId: text(body.visitorId, 120),
            sessionId: text(body.sessionId, 120),
            source: text(body.source || "careers", 80),
            meta: metaObject(body.meta || body),
        });

        await UserEvent.create({
            eventName: "careers_lead_direct",
            eventType: "custom_event",
            flow: "careers",
            step: "zip_apply_panel",
            serviceType: "local_workforce",
            path: text(body.path || req.headers.referer, 300),
            source: "careers",
            zip: cleanZip,
            role,
            visitorId: text(body.visitorId, 120),
            sessionId: text(body.sessionId, 120),
            userAgent: text(req.headers["user-agent"], 260),
            referrer: text(req.headers.referer, 400),
            meta: { vendorLeadId: String(doc._id), roleLabel: doc.roleLabel },
        });

        res.json({ ok: true, id: doc._id });
    } catch (error) {
        console.error("careers lead failed", error);
        res.status(500).json({ ok: false, message: error.message || "Careers lead failed" });
    }
});

router.post("/ai/session", async (req, res) => {
    try {
        const event = normalizedEvent({ ...(req.body || {}), eventName: "ai_session_direct" }, req);
        const doc = await AiIntent.create(aiDocFromEvent(event, req.body || {}));
        await UserEvent.create({ ...event, eventName: "ai_session_direct" });
        res.json({ ok: true, id: doc._id });
    } catch (error) {
        console.error("ai session failed", error);
        res.status(500).json({ ok: false, message: error.message || "AI session failed" });
    }
});

router.get("/searchbase/recommendations", async (req, res) => {
    try {
        const range = text(req.query.range || "30d", 20);
        const llm = String(req.query.llm || "").trim() === "1";
        const result = await buildRecommendationResult({ range, useLlm: llm });
        res.json({ ok: true, ...result });
    } catch (error) {
        console.error("searchbase recommendations failed", error);
        res.status(500).json({ ok: false, message: error.message || "Searchbase recommendations failed" });
    }
});

router.post("/searchbase/recommendations/run", async (req, res) => {
    try {
        const range = text(req.body?.range || "30d", 20);
        const useLlm = Boolean(req.body?.useLlm);
        const result = await buildRecommendationResult({ range, useLlm });

        const doc = await SearchbaseRecommendation.create({
            range: result.snapshot.range,
            source: "searchbase_phase2",
            generatedBy: result.generatedBy,
            status: result.status,
            headline: result.headline,
            summary: result.summary,
            confidence: result.confidence,
            recommendations: result.recommendations,
            snapshot: result.snapshot,
            llmPrompt: result.llmPrompt,
            llmRaw: result.llmRaw,
            meta: { requestedUseLlm: useLlm },
        });

        await AiIntent.create({
            contextType: "searchbase_recommendations",
            intent: "generate_saved_data_recommendations",
            userMessage: "Generate recommendations from Mongo searchbase events and demand signals.",
            page: "admin_searchbase",
            source: "searchbase_phase2",
            meta: { recommendationId: String(doc._id), range: result.snapshot.range, generatedBy: result.generatedBy },
        });

        res.json({ ok: true, id: doc._id, ...result });
    } catch (error) {
        console.error("searchbase recommendations run failed", error);
        res.status(500).json({ ok: false, message: error.message || "Recommendation run failed" });
    }
});

router.get("/searchbase/recommendations/history", async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(30, Number(req.query.limit || 10)));
        const rows = await SearchbaseRecommendation.find({})
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        res.json({
            ok: true,
            items: rows.map((row) => ({
                id: String(row._id),
                range: row.range,
                generatedBy: row.generatedBy,
                status: row.status,
                headline: row.headline,
                summary: row.summary,
                confidence: row.confidence,
                recommendations: Array.isArray(row.recommendations) ? row.recommendations.slice(0, 5) : [],
                createdAt: row.createdAt,
            })),
        });
    } catch (error) {
        console.error("searchbase recommendation history failed", error);
        res.status(500).json({ ok: false, message: error.message || "Recommendation history failed" });
    }
});

function slugifyLookId(title) {
    const base = text(title || "curated-look", 120)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 70) || "curated-look";
    return `${base}-${Date.now().toString(36)}`;
}

function cleanCuratedProducts(value) {
    if (!Array.isArray(value)) return [];
    return value
        .slice(0, 18)
        .map((item) => ({
            productId: text(item.productId || item.id, 140),
            title: text(item.title, 220),
            category: text(item.category, 120),
            productStatus: text(item.productStatus || item.status, 80),
            price: num(item.price, null),
            image: text(item.image || item.imageUrl, 800),
sourceName: text(item.sourceName || item.source || item.maker, 140),
sourceUrl: text(item.sourceUrl || item.url || item.productUrl, 800),
sourceProductId: text(item.sourceProductId || item.sku, 180),
slotKey: text(item.slotKey, 80),
slotLabel: text(item.slotLabel, 160),
role: ["hero", "supporting", "accent", "utility"].includes(text(item.role, 40))
    ? text(item.role, 40)
    : "supporting",
robotHandlingNote: text(item.robotHandlingNote || item.handlingNote, 500),
replacementReason: text(item.replacementReason || item.reason, 300),
dealScore: num(item.dealScore, null),
reviewScore: num(item.reviewScore, null),
        }))
        .filter((item) => item.productId);
}

function cleanLaborNeeds(value) {
    if (!Array.isArray(value)) return [];
    return value
        .slice(0, 12)
        .map((item) => ({
            role: text(item.role || item.key || item.label, 120),
            label: text(item.label || item.role || item.key, 160),
            hours: Math.max(0, Math.min(80, num(item.hours, 0) || 0)),
            note: text(item.note, 500),
        }))
        .filter((item) => item.role || item.label);
}

function cleanRoomDimensions(value = {}, fallbackMeta = {}) {
    const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const meta = fallbackMeta && typeof fallbackMeta === "object" && !Array.isArray(fallbackMeta) ? fallbackMeta : {};
    const lengthFt = num(raw.lengthFt ?? meta.lengthFt, 0) || 0;
    const widthFt = num(raw.widthFt ?? meta.widthFt, 0) || 0;
    const ceilingHeightFt = num(raw.ceilingHeightFt ?? raw.heightFt ?? meta.ceilingHeightFt, 0) || 0;
    const approxSqFt = num(raw.approxSqFt ?? meta.approxSqFt, 0) || Math.round(lengthFt * widthFt * 10) / 10;

    return {
        lengthFt,
        widthFt,
        heightFt: num(raw.heightFt ?? ceilingHeightFt, 0) || ceilingHeightFt,
        ceilingHeightFt,
        approxSqFt,
        walls: Math.max(0, Math.min(20, num(raw.walls ?? meta.walls, 4) || 4)),
        windows: Math.max(0, Math.min(40, num(raw.windows ?? meta.windows, 0) || 0)),
        doors: Math.max(0, Math.min(20, num(raw.doors ?? meta.doors, 0) || 0)),
        notes: text(raw.notes || meta.notes || meta.wallsWindows, 1200),
    };
}

function cleanReplacementRules(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 24).map((item) => ({
        slotKey: text(item.slotKey || item.key, 80),
        slotLabel: text(item.slotLabel || item.label, 160),
        currentProductId: text(item.currentProductId || item.productId, 140),
        preferredCategory: text(item.preferredCategory || item.category, 120),
        minPrice: num(item.minPrice, null),
        maxPrice: num(item.maxPrice, null),
        requiredDimensions: text(item.requiredDimensions || item.dimensions, 240),
        styleNotes: text(item.styleNotes || item.notes, 500),
        replaceWhen: text(item.replaceWhen || item.rule, 500),
        supplierPriority: arr(item.supplierPriority || item.suppliers, 8),
    })).filter((item) => item.slotKey || item.slotLabel || item.preferredCategory);
}

function cleanRobotTasks(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 40).map((item, index) => ({
        taskId: text(item.taskId || item.id || `task_${index + 1}`, 120),
        label: text(item.label || item.title || item.task || `Task ${index + 1}`, 180),
        zone: text(item.zone || item.area, 120),
        estimatedMinutes: Math.max(0, Math.min(480, num(item.estimatedMinutes ?? item.minutes, 0) || 0)),
        robotCapability: text(item.robotCapability || item.capability, 160),
        humanInLoop: item.humanInLoop === false ? false : true,
        notes: text(item.notes || item.note, 700),
    })).filter((item) => item.taskId || item.label);
}

function defaultRobotTasks(roomCode, estimatedCleaningMinutes) {
    const code = text(roomCode || "L1", 40).toUpperCase();
    const total = Math.max(0, num(estimatedCleaningMinutes, 0) || 0);
    const first = total ? Math.max(10, Math.round(total * 0.45)) : 0;
    const second = total ? Math.max(8, Math.round(total * 0.25)) : 0;
    const third = total ? Math.max(8, total - first - second) : 0;

    return [
        {
            taskId: `${code}_clean_floor_path`,
            label: "Clean visible floor path",
            zone: "main_room_path",
            estimatedMinutes: first,
            robotCapability: "vacuum_or_mop_reachable_path",
            humanInLoop: true,
            notes: "Robot follows pre-approved room path. Human verifies exceptions and obstacles.",
        },
        {
            taskId: `${code}_reset_soft_goods`,
            label: "Reset pillows, throws, and visible soft goods",
            zone: "sofa_or_bed_zone",
            estimatedMinutes: second,
            robotCapability: "light_pick_place_and_visual_alignment",
            humanInLoop: true,
            notes: "Used for subscribed design consistency, not heavy furniture moving.",
        },
        {
            taskId: `${code}_inspect_maintenance`,
            label: "Inspect scratches, stains, restock issues, and damage",
            zone: "walls_tables_floor_edges",
            estimatedMinutes: third,
            robotCapability: "vision_inspection_report",
            humanInLoop: true,
            notes: "Routes maintenance findings back to Property Center approval flow.",
        },
    ].filter((item) => item.estimatedMinutes > 0 || !total);
}

function cleanRobotServicePlan(value = {}, fallback = {}) {
    const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const roomCode = text(fallback.roomCode || raw.roomCode || "L1", 40).toUpperCase();
    const estimatedCleaningMinutes = Math.max(
        0,
        Math.min(1440, num(raw.estimatedCleaningMinutes ?? fallback.estimatedCleaningMinutes, 0) || 0)
    );
    const monthlyServicePrice = Math.max(0, num(raw.monthlyServicePrice ?? fallback.maintenanceServicePrice, 0) || 0);

    return {
        planId: text(raw.planId || fallback.planId || `${roomCode}_service_plan_v1`, 160),
        expectedRobot: text(raw.expectedRobot || fallback.expectedRobot || "NEO indoor / Unitree fallback", 160),
        serviceMode: ["human", "human_in_loop", "neo", "unitree", "hybrid"].includes(text(raw.serviceMode, 40))
            ? text(raw.serviceMode, 40)
            : "human_in_loop",
        subscriptionSku: text(raw.subscriptionSku || `${roomCode}_maintenance_subscription`, 160),
        estimatedCleaningMinutes,
        estimatedMaintenanceMinutes: Math.max(0, Math.min(1440, num(raw.estimatedMaintenanceMinutes, 0) || 0)),
        monthlyServicePrice,
        tasks: cleanRobotTasks(raw.tasks).length ? cleanRobotTasks(raw.tasks) : defaultRobotTasks(roomCode, estimatedCleaningMinutes),
        outputFormat: text(raw.outputFormat || fallback.output || "json_ros2_bridge_ready", 120),
        notes: text(raw.notes || fallback.notes || fallback.robotNotes, 1600),
    };
}

function cleanMaintenanceInspectionTemplate(value = {}, fallback = {}) {
    const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const roomCode = text(fallback.roomCode || raw.roomCode || "L1", 40).toUpperCase();
    const items = Array.isArray(raw.items) ? raw.items : [];

    return {
        templateId: text(raw.templateId || `${roomCode}_maintenance_inspection_v1`, 160),
        title: text(raw.title || `${roomCode} maintenance inspection`, 220),
        frequency: text(raw.frequency || "after_each_service", 120),
        items: items.length
            ? items.slice(0, 40).map((item, index) => ({
                checkId: text(item.checkId || item.id || `check_${index + 1}`, 120),
                label: text(item.label || item.title || item.check, 180),
                zone: text(item.zone || item.area, 120),
                severityDefault: ["info", "low", "medium", "high"].includes(text(item.severityDefault || item.severity, 20))
                    ? text(item.severityDefault || item.severity, 20)
                    : "low",
                reportAction: text(item.reportAction || item.action, 300),
            }))
            : [
                { checkId: `${roomCode}_wall_scratches`, label: "Wall scratches / paint touch-up", zone: "walls", severityDefault: "medium", reportAction: "estimate_hours_and_route_approval" },
                { checkId: `${roomCode}_floor_edges`, label: "Floor edges, rug movement, and visible debris", zone: "floor", severityDefault: "low", reportAction: "include_in_service_report" },
                { checkId: `${roomCode}_furniture_damage`, label: "Furniture scratches, stains, and loose parts", zone: "furniture", severityDefault: "medium", reportAction: "create_maintenance_line_item" },
                { checkId: `${roomCode}_restock`, label: "Restock / reset items", zone: "room_supplies", severityDefault: "low", reportAction: "notify_property_center" },
            ],
        approvalFlow: text(raw.approvalFlow || "route_to_property_center", 240),
        notes: text(raw.notes || fallback.robotNotes || "Robot or human-in-loop inspector generates a report after each subscribed service.", 1200),
    };
}

function cleanExternalRef(value = {}, fallback = {}) {
    const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
        refId: text(raw.refId || raw.id || fallback.refId, 180),
        url: text(raw.url || fallback.url, 800),
        status: text(raw.status || fallback.status || "planned", 80),
        notes: text(raw.notes || fallback.notes, 700),
    };
}

function curatedLookPayload(body = {}) {
    const meta = body.meta && typeof body.meta === "object" && !Array.isArray(body.meta) ? body.meta : {};
    const products = cleanCuratedProducts(body.products);
    const supplierProducts = cleanCuratedProducts(body.supplierProducts || meta.supplierProducts || meta.furnitureBom || body.products);
    const laborNeeds = cleanLaborNeeds(body.laborNeeds);
    const title = text(body.title || "Untitled curated look", 220);
    const status = ["draft", "published", "sold", "subscribed", "archived"].includes(text(body.status, 40)) ? text(body.status, 40) : "draft";
    const lookId = text(body.lookId, 160) || slugifyLookId(title);
    const roomCode = text(body.roomCode || meta.roomCode || "", 40).toUpperCase();
    const roomType = text(body.roomType || meta.roomType || body.primaryCategory || body.category, 120);
    const roomTemplateId = text(body.roomTemplateId || meta.roomTemplateId || (roomCode && roomType ? `${roomCode}_${roomType}` : ""), 120);
    const designTier = ["tier_1", "tier_2", "tier_3", "custom"].includes(text(body.designTier || meta.designTier || meta.tier, 40))
        ? text(body.designTier || meta.designTier || meta.tier, 40)
        : "tier_1";
    const roomDimensions = cleanRoomDimensions(body.roomDimensions || meta.roomDimensions, {
        ...meta,
        notes: meta.wallsWindows,
    });
    const estimatedCleaningMinutes = Math.max(
        0,
        Math.min(1440, num(body.estimatedCleaningMinutes ?? meta.estimatedCleaningMinutes ?? meta.robotCleaningMinutes, 0) || 0)
    );
    const maintenanceServicePrice = Math.max(
        0,
        num(body.maintenanceServicePrice ?? meta.maintenanceServicePrice ?? meta.estimatedMonthlyMaintenance, 0) || 0
    );
    const robotServicePlan = cleanRobotServicePlan(body.robotServicePlan || meta.robotServicePlan || meta.rosBridgeIntent, {
        roomCode,
        estimatedCleaningMinutes,
        maintenanceServicePrice,
        expectedRobot: meta.rosBridgeIntent?.expectedRobot,
        output: meta.rosBridgeIntent?.output,
        planId: meta.rosBridgeIntent?.planId,
        robotNotes: meta.robotNotes,
    });
    const maintenanceInspectionTemplate = cleanMaintenanceInspectionTemplate(
        body.maintenanceInspectionTemplate || meta.maintenanceInspectionTemplate,
        { roomCode, robotNotes: meta.robotNotes }
    );
    const rosTaskPlanRef = cleanExternalRef(body.rosTaskPlanRef || meta.rosTaskPlanRef, {
        refId: meta.rosBridgeIntent?.planId || `${roomCode || "room"}_service_plan_v1`,
        status: "planned",
        notes: meta.rosBridgeIntent?.output || "JSON task path now, ROS2/Foxglove/Isaac bridge later",
    });
    const base44Ref = cleanExternalRef(body.base44Ref || meta.base44Ref, {
        refId: meta.base44RefId || `${roomCode || "room"}_base44_business_unit`,
        status: "planned",
        notes: "Base44 owns executive hardware/BOM/cost visibility; PropertySanta stores room/design service memory.",
    });

    const estimatedProductTotal = products.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
    const estimatedLaborHours = laborNeeds.reduce((sum, item) => sum + (Number(item.hours) || 0), 0);
    const aiPredictedDesignUrl = text(body.aiPredictedDesignUrl || meta.aiPredictedDesignUrl || body.afterImage, 800);
    const implementedDesignUrl = text(body.implementedDesignUrl || meta.implementedDesignUrl || body.heroImage || body.afterImage, 800);

    return {
        lookId,
        title,
        status,
        roomCode,
        roomTemplateId,
        roomDimensions,
        designTier,
        market: text(body.market, 140),
        serviceArea: text(body.serviceArea, 180),
        zip: zip(body.zip),
        primaryCategory: text(body.primaryCategory || body.category || roomType, 120),
        summary: text(body.summary, 1200),
        designIntent: text(body.designIntent, 1600),
        beforeImage: text(body.beforeImage || meta.beforePhotoUrl, 800),
        afterImage: text(body.afterImage || aiPredictedDesignUrl, 800),
        aiPredictedDesignUrl,
        implementedDesignUrl,
        heroImage: text(body.heroImage || implementedDesignUrl || aiPredictedDesignUrl || body.afterImage || body.beforeImage, 800),
        tags: arr(body.tags, 18),
        products,
        supplierProducts,
        replacementRules: cleanReplacementRules(body.replacementRules || meta.replacementRules),
        laborNeeds,
        robotServicePlan,
        estimatedCleaningMinutes: estimatedCleaningMinutes || robotServicePlan.estimatedCleaningMinutes || 0,
        maintenanceServicePrice: maintenanceServicePrice || robotServicePlan.monthlyServicePrice || 0,
        maintenanceInspectionTemplate,
        rosTaskPlanRef,
        base44Ref,
        productCount: products.length,
        estimatedProductTotal,
        estimatedLaborHours,
        shopPath: text(body.shopPath || `/shops?look=${encodeURIComponent(lookId)}`, 300),
        source: text(body.source || "admin_builder", 80),
        createdBy: text(body.createdBy || "admin", 160),
        publishedAt: status === "published" ? new Date() : null,
        soldAt: status === "sold" ? new Date() : null,
        subscribedAt: status === "subscribed" ? new Date() : null,
        reviewStatus: status === "published" || status === "sold" || status === "subscribed" ? "approved" : "new",
        meta: metaObject(body.meta || body),
    };
}

function normalizeCuratedLook(row) {
    const raw = row || {};
    return {
        id: String(raw._id || ""),
        lookId: raw.lookId || "",
        title: raw.title || "Curated look",
        status: raw.status || "draft",
        roomCode: raw.roomCode || "",
        roomTemplateId: raw.roomTemplateId || "",
        roomDimensions: raw.roomDimensions || {},
        designTier: raw.designTier || "tier_1",
        market: raw.market || "",
        serviceArea: raw.serviceArea || "",
        zip: raw.zip || "",
        primaryCategory: raw.primaryCategory || "",
        summary: raw.summary || "",
        designIntent: raw.designIntent || "",
        beforeImage: raw.beforeImage || "",
        afterImage: raw.afterImage || "",
        aiPredictedDesignUrl: raw.aiPredictedDesignUrl || "",
        implementedDesignUrl: raw.implementedDesignUrl || "",
        heroImage: raw.heroImage || "",
        tags: raw.tags || [],
        products: raw.products || [],
        supplierProducts: raw.supplierProducts || raw.products || [],
        replacementRules: raw.replacementRules || [],
        laborNeeds: raw.laborNeeds || [],
        robotServicePlan: raw.robotServicePlan || {},
        estimatedCleaningMinutes: raw.estimatedCleaningMinutes || 0,
        maintenanceServicePrice: raw.maintenanceServicePrice || 0,
        maintenanceInspectionTemplate: raw.maintenanceInspectionTemplate || {},
        rosTaskPlanRef: raw.rosTaskPlanRef || {},
        base44Ref: raw.base44Ref || {},
        productCount: raw.productCount || 0,
        estimatedProductTotal: raw.estimatedProductTotal || 0,
        estimatedLaborHours: raw.estimatedLaborHours || 0,
        shopPath: raw.shopPath || `/shops?look=${encodeURIComponent(raw.lookId || "")}`,
        reviewStatus: raw.reviewStatus || "new",
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        publishedAt: raw.publishedAt,
        soldAt: raw.soldAt,
        subscribedAt: raw.subscribedAt,
        meta: raw.meta || {},
    };
}

const ADMIN_TYPES = {
    productInterests: {
        Model: ProductInterest,
        label: "Product interests",
        primary: "productTitle",
        secondary: "productId",
        dateField: "createdAt",
    },
    curatedRequests: {
        Model: CuratedInterestRequest,
        label: "Curated requests",
        primary: "lookTitle",
        secondary: "lookId",
        dateField: "createdAt",
    },
    vendorLeads: {
        Model: VendorLead,
        label: "Vendor leads",
        primary: "roleLabel",
        secondary: "zip",
        dateField: "createdAt",
    },
    aiIntents: {
        Model: AiIntent,
        label: "AI intents",
        primary: "intent",
        secondary: "contextType",
        dateField: "createdAt",
    },
    recommendationRuns: {
        Model: SearchbaseRecommendation,
        label: "Recommendation runs",
        primary: "headline",
        secondary: "generatedBy",
        dateField: "createdAt",
    },
    curatedLooks: {
        Model: CuratedLook,
        label: "Curated looks",
        primary: "title",
        secondary: "lookId",
        dateField: "createdAt",
    },
};

const ADMIN_ACTIONS = {
    mark_reviewed: { status: "reviewed", label: "Marked reviewed" },
    approve_product: { status: "approved", label: "Product approved" },
    create_curated_task: { status: "task_created", label: "Curated task created" },
    contact_vendor: { status: "contacted", label: "Vendor contact needed" },
    need_zip_pricing: { status: "pricing_needed", label: "Needs ZIP pricing" },
    ignore: { status: "ignored", label: "Ignored" },
};

function adminTypeConfig(type) {
    return ADMIN_TYPES[text(type, 60)] || ADMIN_TYPES.productInterests;
}

function normalizeReviewItem(type, item) {
    const raw = item || {};
    const id = String(raw._id || raw.id || "");
    const status = raw.reviewStatus || raw.status || "new";

    if (type === "productInterests") {
        return {
            id,
            type,
            title: raw.productTitle || raw.productId || "Product interest",
            subtitle: [raw.productId, raw.category, raw.productStatus].filter(Boolean).join(" · "),
            status,
            action: raw.action || "request_availability",
            zip: raw.zip || "",
            primaryId: raw.productId || "",
            secondaryId: raw.sourceLookId || raw.activeLookId || "",
            note: raw.adminNote || "",
            createdAt: raw.createdAt,
            reviewedAt: raw.reviewedAt,
            meta: {
                price: raw.price,
                sourceLookTitle: raw.sourceLookTitle || raw.activeLookTitle || "",
                minimumPurchase: raw.minimumPurchase,
            },
        };
    }

    if (type === "curatedRequests") {
        return {
            id,
            type,
            title: raw.lookTitle || raw.projectTitle || raw.lookId || raw.projectId || "Curated request",
            subtitle: [raw.action, raw.intent, `${raw.productCount || 0} products`].filter(Boolean).join(" · "),
            status,
            action: raw.action || "curated_request",
            zip: raw.zip || "",
            primaryId: raw.lookId || raw.projectId || "",
            secondaryId: raw.projectId || "",
            note: raw.adminNote || "",
            createdAt: raw.createdAt,
            reviewedAt: raw.reviewedAt,
            meta: { productIds: raw.productIds || [], productCount: raw.productCount || 0 },
        };
    }

    if (type === "vendorLeads") {
        return {
            id,
            type,
            title: raw.roleLabel || raw.role || "Vendor lead",
            subtitle: [raw.name, raw.contact, raw.availability].filter(Boolean).join(" · "),
            status,
            action: raw.adminAction || "vendor_lead",
            zip: raw.zip || "",
            primaryId: raw.role || "",
            secondaryId: raw.contact || "",
            note: raw.note || raw.adminNote || "",
            createdAt: raw.createdAt,
            reviewedAt: raw.reviewedAt,
            meta: { hasTools: raw.hasTools || "", source: raw.source || "careers" },
        };
    }

    if (type === "aiIntents") {
        return {
            id,
            type,
            title: raw.intent || raw.contextType || "AI intent",
            subtitle: [raw.contextType, raw.productTitle, raw.lookTitle, raw.zip].filter(Boolean).join(" · "),
            status,
            action: raw.adminAction || "ai_intent",
            zip: raw.zip || "",
            primaryId: raw.productId || raw.lookId || raw.projectId || "",
            secondaryId: raw.page || raw.path || "",
            note: raw.userMessage || raw.adminNote || "",
            createdAt: raw.createdAt,
            reviewedAt: raw.reviewedAt,
            meta: { category: raw.category || "", source: raw.source || "frontPage" },
        };
    }

    return {
        id,
        type,
        title: raw.headline || "Recommendation run",
        subtitle: [raw.generatedBy, raw.range, `${raw.confidence || 0}% confidence`].filter(Boolean).join(" · "),
        status,
        action: raw.adminAction || "recommendation_run",
        zip: "",
        primaryId: raw.generatedBy || "",
        secondaryId: raw.range || "",
        note: raw.summary || raw.adminNote || "",
        createdAt: raw.createdAt,
        reviewedAt: raw.reviewedAt,
        meta: { recommendations: Array.isArray(raw.recommendations) ? raw.recommendations.length : 0 },
    };
}

async function adminCounts() {
    const [productInterests, curatedRequests, vendorLeads, aiIntents, recommendationRuns, zipDemand, openReviews] =
        await Promise.all([
            ProductInterest.countDocuments({}),
            CuratedInterestRequest.countDocuments({}),
            VendorLead.countDocuments({}),
            AiIntent.countDocuments({}),
            SearchbaseRecommendation.countDocuments({}),
            UserEvent.aggregate([
                { $match: { zip: { $exists: true, $nin: ["", null] } } },
                { $group: { _id: "$zip", count: { $sum: 1 }, latestAt: { $max: "$createdAt" } } },
                { $sort: { count: -1, latestAt: -1 } },
                { $limit: 8 },
            ]),
            Promise.all([
                ProductInterest.countDocuments({ reviewStatus: { $in: [null, "", "new"] } }),
                CuratedInterestRequest.countDocuments({ reviewStatus: { $in: [null, "", "new"] } }),
                VendorLead.countDocuments({ reviewStatus: { $in: [null, "", "new"] } }),
                AiIntent.countDocuments({ reviewStatus: { $in: [null, "", "new"] } }),
                SearchbaseRecommendation.countDocuments({ reviewStatus: { $in: [null, "", "new"] } }),
            ]),
        ]);

    return {
        productInterests,
        curatedRequests,
        vendorLeads,
        aiIntents,
        recommendationRuns,
        openReviews: openReviews.reduce((sum, value) => sum + Number(value || 0), 0),
        zipDemand: zipDemand.map((row) => ({ zip: row._id, count: row.count, latestAt: row.latestAt })),
    };
}

router.get("/searchbase/admin/overview", async (req, res) => {
    try {
        const counts = await adminCounts();
        res.json({ ok: true, counts });
    } catch (error) {
        console.error("searchbase admin overview failed", error);
        res.status(500).json({ ok: false, message: error.message || "Admin overview failed" });
    }
});

router.get("/searchbase/admin/review", async (req, res) => {
    try {
        const type = text(req.query.type || "productInterests", 60);
        const status = text(req.query.status || "all", 40);
        const limit = Math.max(1, Math.min(80, Number(req.query.limit || 24)));
        const config = adminTypeConfig(type);
        const query = {};

        if (status !== "all") {
            query.reviewStatus = status === "new" ? { $in: [null, "", "new"] } : status;
        }

        const rows = await config.Model.find(query).sort({ createdAt: -1 }).limit(limit).lean();
        res.json({
            ok: true,
            type,
            label: config.label,
            items: rows.map((row) => normalizeReviewItem(type, row)),
        });
    } catch (error) {
        console.error("searchbase admin review list failed", error);
        res.status(500).json({ ok: false, message: error.message || "Admin review list failed" });
    }
});

router.post("/searchbase/admin/action", async (req, res) => {
    try {
        const type = text(req.body?.type || "", 60);
        const id = text(req.body?.id || "", 80);
        const action = text(req.body?.action || "mark_reviewed", 80);
        const note = text(req.body?.note || "", 1200);
        const reviewedBy = text(req.body?.reviewedBy || "admin", 160);
        const config = adminTypeConfig(type);
        const actionConfig = ADMIN_ACTIONS[action] || ADMIN_ACTIONS.mark_reviewed;

        if (!id) return res.status(400).json({ ok: false, message: "id required" });

        const update = {
            reviewStatus: actionConfig.status,
            adminAction: action,
            reviewedAt: new Date(),
            reviewedBy,
        };

        if (note) update.adminNote = note;
        if (type === "vendorLeads" && action === "contact_vendor") update.status = "contacted";
        if (type === "vendorLeads" && action === "mark_reviewed") update.status = "reviewed";

        const doc = await config.Model.findByIdAndUpdate(id, { $set: update }, { new: true }).lean();
        if (!doc) return res.status(404).json({ ok: false, message: "review item not found" });

        await UserEvent.create({
            eventName: "searchbase_admin_action",
            eventType: "admin_action",
            flow: "searchbase_admin",
            step: action,
            source: "admin_review_dashboard",
            meta: { type, id, action, label: actionConfig.label, note },
        });

        res.json({ ok: true, item: normalizeReviewItem(type, doc), label: actionConfig.label });
    } catch (error) {
        console.error("searchbase admin action failed", error);
        res.status(500).json({ ok: false, message: error.message || "Admin action failed" });
    }
});

router.post("/searchbase/shop-room/fetch", async (req, res) => {
    try {
        const parsedUrl = safeUrl(req.body?.url || "");
        if (!parsedUrl) return res.status(400).json({ ok: false, message: "valid furniture or shop-by-room URL required" });

        const sourceUrl = parsedUrl.toString();
        const roomType = text(req.body?.roomType || "living_room", 80);
        const themeId = text(req.body?.themeId || "luxury-neutral-coastal", 80);
        const market = text(req.body?.market || "South Florida", 140);
        const serviceZip = zip(req.body?.zip || "");

        let html = "";
        let fetchError = "";

        if (typeof fetch === "function") {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 9000);
            try {
                const upstream = await fetch(sourceUrl, {
                    signal: controller.signal,
                    headers: {
                        "user-agent": "Mozilla/5.0 PropertySanta Curated Homes Source Review",
                        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    },
                });
                if (!upstream.ok) throw new Error(`source returned ${upstream.status}`);
                html = await upstream.text();
            } catch (error) {
                fetchError = error?.message || "source fetch failed";
            } finally {
                clearTimeout(timeout);
            }
        } else {
            fetchError = "server fetch is not available in this Node runtime";
        }

        const sourceName = sourceHost(sourceUrl);
        const sourceTitle = text(
            metaContent(html, "og:title") || metaContent(html, "twitter:title") || pageTitle(html) || sourceName,
            220
        );
        const sourceImage = absoluteAssetUrl(
            metaContent(html, "og:image") || metaContent(html, "twitter:image") || "",
            sourceUrl
        );
        const htmlProducts = parseJsonLdProducts(html, sourceUrl);
        const heroImage = sourceImage || SHOP_ROOM_FALLBACK_IMAGES[roomType] || SHOP_ROOM_FALLBACK_IMAGES.living_room;
        const products = buildShopRoomProducts({
            roomType,
            themeId,
            sourceUrl,
            sourceName,
            sourceImage: heroImage,
            htmlProducts,
        });

        await UserEvent.create({
            eventName: "curated_shop_room_source_fetched",
            eventType: "admin_action",
            flow: "curated_homes_studio",
            step: html ? "source_metadata_fetched" : "source_fallback_used",
            source: "admin_curated_builder",
            zip: serviceZip,
            meta: {
                sourceUrl,
                sourceName,
                sourceTitle,
                sourceImage: heroImage,
                fetchError,
                roomType,
                themeId,
                market,
                htmlProductCount: htmlProducts.length,
                productCount: products.length,
            },
        }).catch(() => null);

        res.json({
            ok: true,
            mode: html ? "source_metadata_fetched" : "curated_fallback_used",
            source: {
                url: sourceUrl,
                name: sourceName,
                title: sourceTitle,
                image: heroImage,
                fetchError,
            },
            heroImage,
            products,
            message: html
                ? "Fetched source page metadata and mapped it into the Curated Homes product slots."
                : "Could not read the page directly, so a review-ready shop-by-room fallback basket was generated from the source URL.",
        });
    } catch (error) {
        console.error("shop-room source fetch failed", error);
        res.status(500).json({ ok: false, message: error.message || "Shop-room source fetch failed" });
    }
});

router.post("/searchbase/roomgpt/generate", curatedAssetUpload.single("file"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ ok: false, message: "room image file required" });

        const provider = roomGptProviderMode();
        const themeId = text(req.body?.themeId || "modern-coastal", 80);
        const themeTitle = text(req.body?.themeTitle || themeId, 120);
        const roomType = text(req.body?.roomType || "bedroom", 80);
        const market = text(req.body?.market || "South Florida", 120);
        const serviceZip = zip(req.body?.zip || "");
        const beforeUrl = `/uploads/curated-composer/${req.file.filename}`;
        const beforeImageUrl = `${req.protocol}://${req.get("host")}${beforeUrl}`;
        const prompt = buildRoomGptPrompt({ roomType, themeId, themeTitle, market });
        const negativePrompt =
            "low quality, distorted furniture, changed room architecture, warped windows, extra doors, messy clutter, unrealistic scale, bad perspective";

        await UserEvent.create({
            eventName: "roomgpt_generate_requested",
            eventType: "admin_action",
            flow: "roomgpt_curated_homes",
            step: provider,
            source: "admin_curated_builder",
            zip: serviceZip,
            meta: {
                provider,
                themeId,
                themeTitle,
                roomType,
                market,
                beforeImageUrl,
                filename: req.file.filename,
                prompt,
                negativePrompt,
            },
        }).catch(() => null);

        if (provider !== "mock") {
            return res.json({
                ok: true,
                provider,
                mode: "provider_configured_not_connected_yet",
                imageUrl: "",
                beforeImageUrl,
                prompt,
                negativePrompt,
                message:
                    "Provider adapter is ready, but this ZIP does not include paid GPU/API credentials or provider SDK wiring. Frontend will use browser fallback preview now.",
            });
        }

        return res.json({
            ok: true,
            provider: "mock_no_gpu",
            mode: "prompt_ready_browser_fallback",
            imageUrl: "",
            beforeImageUrl,
            prompt,
            negativePrompt,
            message:
                "No-GPU backend accepted the upload and built the RoomGPT prompt. Frontend generated the after image with the browser fallback. Set ROOMGPT_PROVIDER=openai/replicate/google later to replace this fallback.",
        });
    } catch (error) {
        console.error("roomgpt generate failed", error);
        res.status(500).json({ ok: false, message: error.message || "RoomGPT generation failed" });
    }
});

router.post("/searchbase/curated-assets", curatedAssetUpload.single("file"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ ok: false, message: "file required" });

        const kind = text(req.body?.kind || "curated", 40) || "curated";
        const url = `/uploads/curated-composer/${req.file.filename}`;
        const absoluteUrl = `${req.protocol}://${req.get("host")}${url}`;

        await UserEvent.create({
            eventName: "curated_room_asset_uploaded",
            eventType: "admin_action",
            flow: "curated_room_composer",
            step: kind,
            source: "admin_curated_builder",
            meta: {
                filename: req.file.filename,
                originalName: text(req.file.originalname, 180),
                mimetype: text(req.file.mimetype, 80),
                size: req.file.size,
                url,
                absoluteUrl,
            },
        }).catch(() => null);

        res.json({ ok: true, url, absoluteUrl, filename: req.file.filename, kind });
    } catch (error) {
        console.error("curated asset upload failed", error);
        res.status(500).json({ ok: false, message: error.message || "Curated asset upload failed" });
    }
});

router.get("/searchbase/curated-looks", async (req, res) => {
    try {
        const status = text(req.query.status || "all", 40);
        const limit = Math.max(1, Math.min(80, Number(req.query.limit || 30)));
        const query = {};
        if (status !== "all") query.status = status;
        if (req.query.roomCode) query.roomCode = text(req.query.roomCode, 40).toUpperCase();
        if (req.query.roomTemplateId) query.roomTemplateId = text(req.query.roomTemplateId, 120);
        if (req.query.designTier) query.designTier = text(req.query.designTier, 40);
        if (req.query.primaryCategory) query.primaryCategory = text(req.query.primaryCategory, 120);
        if (req.query.zip) query.zip = zip(req.query.zip);

        const rows = await CuratedLook.find(query).sort({ updatedAt: -1, createdAt: -1 }).limit(limit).lean();
        res.json({ ok: true, items: rows.map(normalizeCuratedLook) });
    } catch (error) {
        console.error("curated look list failed", error);
        res.status(500).json({ ok: false, message: error.message || "Curated look list failed" });
    }
});

router.post("/searchbase/curated-looks", async (req, res) => {
    try {
        const payload = curatedLookPayload(req.body || {});
        if (!payload.title || payload.title === "Untitled curated look") {
            return res.status(400).json({ ok: false, message: "title required" });
        }

        const doc = await CuratedLook.findOneAndUpdate(
            { lookId: payload.lookId },
            { $set: payload, $setOnInsert: { createdAt: new Date() } },
            { new: true, upsert: true, runValidators: true }
        ).lean();

        await UserEvent.create({
            eventName: "curated_look_builder_saved",
            eventType: "admin_action",
            flow: "curated_look_builder",
            step: payload.status === "published" ? "published" : payload.status,
            source: "admin_curated_builder",
            lookId: payload.lookId,
            lookTitle: payload.title,
            zip: payload.zip,
            category: payload.primaryCategory,
            meta: {
                curatedLookId: String(doc._id),
                roomCode: payload.roomCode,
                roomTemplateId: payload.roomTemplateId,
                designTier: payload.designTier,
                productCount: payload.productCount,
                estimatedProductTotal: payload.estimatedProductTotal,
                estimatedLaborHours: payload.estimatedLaborHours,
                estimatedCleaningMinutes: payload.estimatedCleaningMinutes,
                maintenanceServicePrice: payload.maintenanceServicePrice,
                robotServicePlanId: payload.robotServicePlan?.planId,
                rosTaskPlanRef: payload.rosTaskPlanRef?.refId,
                base44Ref: payload.base44Ref?.refId,
                status: payload.status,
            },
        });

        res.json({ ok: true, item: normalizeCuratedLook(doc) });
    } catch (error) {
        console.error("curated look create failed", error);
        res.status(500).json({ ok: false, message: error.message || "Curated look create failed" });
    }
});

router.patch("/searchbase/curated-looks/:id", async (req, res) => {
    try {
        const id = text(req.params.id, 80);
        const update = curatedLookPayload(req.body || {});
        delete update.lookId;
        if (req.body?.status === "published") update.publishedAt = new Date();
        if (req.body?.status === "draft") {
            update.publishedAt = null;
            update.soldAt = null;
            update.subscribedAt = null;
        }
        if (req.body?.status === "sold") update.soldAt = new Date();
        if (req.body?.status === "subscribed") update.subscribedAt = new Date();

        const doc = await CuratedLook.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true }).lean();
        if (!doc) return res.status(404).json({ ok: false, message: "Curated look not found" });
        res.json({ ok: true, item: normalizeCuratedLook(doc) });
    } catch (error) {
        console.error("curated look update failed", error);
        res.status(500).json({ ok: false, message: error.message || "Curated look update failed" });
    }
});

router.post("/searchbase/curated-looks/:id/status", async (req, res) => {
    try {
        const id = text(req.params.id, 80);
        const status = ["draft", "published", "sold", "subscribed", "archived"].includes(text(req.body?.status, 40))
            ? text(req.body.status, 40)
            : "draft";
        const update = {
            status,
            reviewStatus: ["published", "sold", "subscribed"].includes(status) ? "approved" : "reviewed",
            adminAction: `set_${status}`,
            reviewedAt: new Date(),
            reviewedBy: text(req.body?.reviewedBy || "admin", 160),
            publishedAt: status === "published" ? new Date() : status === "draft" ? null : undefined,
            soldAt: status === "sold" ? new Date() : status === "draft" ? null : undefined,
            subscribedAt: status === "subscribed" ? new Date() : status === "draft" ? null : undefined,
        };
        Object.keys(update).forEach((key) => update[key] === undefined && delete update[key]);

        const doc = await CuratedLook.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true }).lean();
        if (!doc) return res.status(404).json({ ok: false, message: "Curated look not found" });

        await UserEvent.create({
            eventName: "curated_look_status_changed",
            eventType: "admin_action",
            flow: "curated_look_builder",
            step: status,
            source: "admin_curated_builder",
            lookId: doc.lookId,
            lookTitle: doc.title,
            zip: doc.zip,
            category: doc.primaryCategory,
            meta: {
                curatedLookId: String(doc._id),
                status,
                roomCode: doc.roomCode,
                roomTemplateId: doc.roomTemplateId,
                designTier: doc.designTier,
                estimatedCleaningMinutes: doc.estimatedCleaningMinutes,
                maintenanceServicePrice: doc.maintenanceServicePrice,
            },
        });

        res.json({ ok: true, item: normalizeCuratedLook(doc) });
    } catch (error) {
        console.error("curated look status failed", error);
        res.status(500).json({ ok: false, message: error.message || "Curated look status failed" });
    }
});

module.exports = router;