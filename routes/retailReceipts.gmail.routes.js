// services/api/routes/retailReceipts.gmail.routes.js
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const multer = require("multer");
const { firebaseAuth, requireOpsAdmin } = require("../middleware/firebaseAuth");
const { auth } = require("../middleware/auth");
const {
    requireTenantAccess,
    requireTenantRole,
    getActorFirebaseUid,
} = require("../middleware/tenantAccess");
const { admin, getFirestore } = require("../lib/firebaseAdmin");
const { encryptText, decryptText } = require("../lib/secretBox");
const { cloudinary } = require("../src/services/cloudinary");
const { resolveCanonicalBiCategory } = require("../services/businessIntelligence/biCategories");
const {
    retailConnectionDoc,
    retailSettingsDoc,
    retailAllowlistCollection,
    retailAllowlistDoc,
    retailReceiptsCollection,
    retailReceiptDoc,
    retailFailureDoc,
    retailRunDoc,
    retailSenderSuggestionsCollection,
    retailSenderSuggestionDoc,
    buildRetailOwnedPayload,
} = require("../lib/retailPaths");

const { validateRetailDocForSave } = require("../lib/retailSchema");

const { tenantCollection } = require("../lib/tenantFirestore");
const { readBiCategoryMemory } = require("../services/businessIntelligence/biCategoryMemoryService");
const { buildBiNormalizedEvent } = require("../services/businessIntelligence/biEventModel");
const {
    classifySenderText,
    scoreSenderSuggestion: scoreSenderSuggestionV2,
} = require("../services/businessIntelligence/retailSenderIntelligence");
const { createRetailSenderReviewRouter } = require("./retailReceipts.gmail.senderReview.routes");
const { createRetailGmailSchedulerRouter } = require("./retailreceipt/retailGmailScheduler.routes");
const router = express.Router();

function envFirst(...names) {
    for (const name of names) {
        const value = process.env[name];
        if (value !== undefined && value !== null && String(value).trim()) {
            return String(value).trim();
        }
    }
    return "";
}

const {
    registerRetailSyncRunner,
    getRetailReceiptSchedulerStatus,
    runRetailReceiptSchedulerPass,
} = require("../lib/retailReceiptScheduler");

const RETAIL_GMAIL_CLIENT_ID = envFirst(
    "RETAIL_GMAIL_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_GMAIL_CLIENT_ID"
);
const RETAIL_GMAIL_CLIENT_SECRET = envFirst(
    "RETAIL_GMAIL_CLIENT_SECRET",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_GMAIL_CLIENT_SECRET"
);
const RETAIL_GMAIL_REDIRECT_URI = envFirst(
    "RETAIL_GMAIL_REDIRECT_URI",
    "RETAIL_GMAIL_OAUTH_REDIRECT_URI",
    "GOOGLE_GMAIL_REDIRECT_URI"
);
const RETAIL_GMAIL_WEBAPP_URL = envFirst(
    "RETAIL_GMAIL_WEBAPP_URL",
    "GAS_RECEIPTS_WEBAPP_URL"
);
const RETAIL_GMAIL_WEBAPP_SECRET = envFirst(
    "RETAIL_GMAIL_WEBAPP_SECRET",
    "GAS_RECEIPTS_SECRET"
);
const RETAIL_GMAIL_SUCCESS_URL =
    envFirst("RETAIL_GMAIL_SUCCESS_URL", "FRONTEND_RECEIPTS_SUCCESS_URL") ||
    "http://localhost:5173/receipts-live?gmail=connected";


const DEFAULT_RETAIL_IMPORTED_LABEL =
    process.env.RETAIL_GMAIL_IMPORTED_LABEL || "RECEIPT_IMPORTED";
const DEFAULT_RETAIL_RECEIPTS_LABEL =
    process.env.RETAIL_GMAIL_RECEIPTS_LABEL || "Auto/Receipts";

const DEFAULT_ALLOWLIST_QUERY_CHUNK_SIZE = 20;
const DEFAULT_SYNC_OVERLAP_MINUTES = (() => {
    const n = Number(process.env.RETAIL_GMAIL_SYNC_OVERLAP_MINUTES || 15);
    if (!Number.isFinite(n)) return 15;
    return Math.max(0, Math.min(1440, Math.trunc(n)));
})();
const MAX_RETAIL_SYNC_DAYS = 730;

const DEFAULT_AUTO_RECENT_EVERY_MINUTES = (() => {
    const n = Number(process.env.RETAIL_AUTO_RECENT_EVERY_MINUTES || 5);
    if (!Number.isFinite(n)) return 5;
    return Math.max(5, Math.min(1440, Math.trunc(n)));
})();
const DEFAULT_AUTO_RECENT_DAYS = 3;
const DEFAULT_AUTO_RECENT_MAX_MESSAGES = 35;
const DEFAULT_AUTO_BACKFILL_MAX_MESSAGES = 50;
const DEFAULT_AUTO_BACKFILL_EVERY_DAYS = 7;
const DEFAULT_AUTO_BACKFILL_START_DAYS_AGO = 30;
const DEFAULT_AUTO_BACKFILL_CHUNK_DAYS = 30;
const DEFAULT_AUTO_BACKFILL_MAX_DAYS = 360;
const DEFAULT_AUTO_SCHEDULER_LIMIT = 25;
const RETAIL_LEGACY_CUTOVER_VERSION = "retail-legacy-cutover-v1";
const DEFAULT_SENDER_DISCOVERY_MAX_MESSAGES = 30;
const DEFAULT_SENDER_DISCOVERY_RAW_FETCH_LIMIT = 80;
const RETAIL_SUGGESTION_SCORE_THRESHOLD = 4;

const RETAIL_RECEIPT_SIGNAL_QUERY =
    '("receipt" OR "invoice" OR "order confirmation" OR "payment received" OR "payment confirmation" OR "amount paid" OR "amount due" OR "bill" OR "billing" OR "statement" OR "due date" OR "past due" OR "premium" OR "policy" OR "order number" OR "order #")';

const RETAIL_NEGATIVE_SUBJECT_QUERY =
    '-subject:(shipped OR delivered OR arriving OR refund OR cancelled OR "rate" OR rating OR review OR survey)';

const RETAIL_NOISE_EXCLUSIONS = [
    "-in:spam",
    "-in:trash",
    "-from:marketplace-messages@amazon.com",
    "-from:shipment-tracking@amazon.com",
];

function ensureGoogleConfig() {
    const missing = [];
    if (!RETAIL_GMAIL_CLIENT_ID) missing.push("RETAIL_GMAIL_CLIENT_ID");
    if (!RETAIL_GMAIL_CLIENT_SECRET) missing.push("RETAIL_GMAIL_CLIENT_SECRET");
    if (!RETAIL_GMAIL_REDIRECT_URI) missing.push("RETAIL_GMAIL_REDIRECT_URI");
    if (!RETAIL_GMAIL_WEBAPP_URL) missing.push("RETAIL_GMAIL_WEBAPP_URL");
    if (!RETAIL_GMAIL_WEBAPP_SECRET) missing.push("RETAIL_GMAIL_WEBAPP_SECRET");
    if (missing.length) {
        throw new Error(`Missing env: ${missing.join(", ")}`);
    }
}

async function nodeFetch(url, options) {
    if (typeof fetch === "function") {
        return fetch(url, options);
    }
    const mod = await import("node-fetch");
    const fn = mod.default || mod;
    return fn(url, options);
}

function ensureRetailPdfUploadConfig() {
    const missing = [];
    if (!RETAIL_GMAIL_WEBAPP_URL) missing.push("RETAIL_GMAIL_WEBAPP_URL");
    if (!RETAIL_GMAIL_WEBAPP_SECRET) missing.push("RETAIL_GMAIL_WEBAPP_SECRET");

    const cfg = cloudinary.config() || {};
    if (!cfg.cloud_name) missing.push("CLOUDINARY_CLOUD_NAME");
    if (!cfg.api_key) missing.push("CLOUDINARY_API_KEY");
    if (!cfg.api_secret) missing.push("CLOUDINARY_API_SECRET");

    if (missing.length) {
        throw new Error(`Missing env: ${missing.join(", ")}`);
    }
}

function normalizeRetailYearScope(value, fallback = "") {
    const safe = String(value || "").trim();

    if (!safe) return fallback;
    if (safe === "last_30_days") return safe;
    if (/^\d{4}$/.test(safe)) return safe;
    if (/^\d{4}_\d{4}$/.test(safe)) return safe;

    return fallback;
}

function inferRetailYearScopeFromDays(daysDefault, fallback = "last_30_days") {
    const days = Number(daysDefault);
    if (!Number.isFinite(days)) return fallback;
    if (days <= 30) return "last_30_days";
    if (days <= 400) return fallback;
    if (days <= 800) return fallback;
    return fallback;
}

function buildRetailSetupState(settings = {}, settingsExists = false) {
    const allowlist = normalizeAllowlist(settings.allowlist || {});
    const allowlistInput = String(settings.allowlistInput || "").trim();
    const lane = String(settings.lane || "").trim();
    const yearScope = normalizeRetailYearScope(
        settings.yearScope,
        inferRetailYearScopeFromDays(settings.daysDefault)
    );
    const hasAllowlist = Boolean(
        allowlistInput ||
        allowlist.emails.length ||
        allowlist.domains.length
    );
    const hasLane = Boolean(lane);
    const hasSyncRange = Boolean(yearScope) || Number(settings.daysDefault || 0) > 0;
    const onboardingCompleted = Boolean(settings.onboardingCompleted);
    const readyForLive = Boolean(
        onboardingCompleted ||
        (settingsExists && hasAllowlist && hasLane && hasSyncRange)
    );

    return {
        hasAllowlist,
        hasLane,
        hasSyncRange,
        onboardingCompleted,
        readyForLive,
    };
}

function safeUploadFilename(value = "receipt.pdf") {
    const ext = path.extname(String(value || "")).toLowerCase() || ".pdf";
    const base = path
        .basename(String(value || "receipt"), ext)
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80);

    return `${base || "receipt"}${ext === ".pdf" ? ".pdf" : ext}`;
}

function buildPdfUploadMessageId(fileName = "receipt.pdf") {
    const base = path
        .basename(String(fileName || "receipt.pdf"), path.extname(String(fileName || "receipt.pdf")))
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80);

    return `pdf-upload-${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${base || "receipt"}`;
}

function uploadPdfBufferToCloudinary(buffer, { retailOwnerId, fileName }) {
    const safeFileName = safeUploadFilename(fileName);
    const baseName = path.basename(safeFileName, path.extname(safeFileName));
    const publicId = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${baseName}`;
    const folder = `retail_receipts/${retailOwnerId}/pdf_uploads`;

    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder,
                public_id: publicId,
                resource_type: "raw",
                format: "pdf",
                use_filename: false,
                unique_filename: false,
                overwrite: false,
                filename_override: safeFileName,
            },
            (err, result) => {
                if (err) return reject(err);
                return resolve(result);
            }
        );

        stream.end(buffer);
    });
}

const retailPdfUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        files: 10,
        fileSize: 12 * 1024 * 1024,
    },
    fileFilter: (_req, file, cb) => {
        const isPdf = String(file?.mimetype || "").toLowerCase() === "application/pdf";
        if (!isPdf) {
            return cb(new Error(`Only PDF files are allowed: ${file?.originalname || "file"}`));
        }
        cb(null, true);
    },
});

function retailPdfUploadMiddleware(req, res, next) {
    retailPdfUpload.array("files", 10)(req, res, (err) => {
        if (!err) return next();

        return res.status(400).json({
            ok: false,
            error: err?.message || "PDF upload failed",
        });
    });
}

const retailTenantMemberMiddleware = [auth, requireTenantAccess];
const retailTenantManagerMiddleware = [
    auth,
    requireTenantAccess,
    requireTenantRole(["owner", "admin", "ops"]),
];

function getRetailTenantIdFromReq(req) {
    const tenantId = String(
        req.tenantId ||
        req.body?.tenantId ||
        req.query?.tenantId ||
        req.headers["x-tenant-id"] ||
        ""
    ).trim();

    if (!tenantId) throw new Error("Missing tenantId");
    return tenantId;
}

function getRetailActorUidFromReq(req) {
    return String(getActorFirebaseUid(req) || req.firebaseUser?.uid || "").trim();
}

function normalizeEmailKey(value) {
    return String(value || "").trim().toLowerCase();
}

function uniqueNonEmpty(values = []) {
    return Array.from(
        new Set(
            (values || [])
                .map((x) => String(x || "").trim())
                .filter(Boolean)
        )
    );
}

function chunkArray(items = [], size = 200) {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
}

function retailValidatedPayload(kind, retailOwnerId, payload) {
    return validateRetailDocForSave(
        kind,
        buildRetailOwnedPayload(retailOwnerId, payload || {}),
        retailOwnerId
    );
}

function retailKindForCollectionName(collectionName) {
    switch (String(collectionName || "").trim()) {
        case "retailReceipts":
            return "receipt";
        case "retailReceipts_failed":
            return "failure";
        case "retailReceiptRuns":
            return "run";
        case "receiptAllowlist":
            return "allowlist";
        case "retailReceiptConnections":
            return "connection";
        case "gmailReceiptSettings":
            return "settings";
        default:
            return "retail";
    }
}

function legacyDocBelongsToOwner(data, retailOwnerId, emailCandidates = []) {
    const ownerIds = [
        data?.retailOwnerId,
        data?.uid,
        data?.workspaceId,
    ]
        .map((x) => String(x || "").trim())
        .filter(Boolean);

    if (ownerIds.includes(retailOwnerId)) return true;

    const emailSet = new Set(
        (emailCandidates || []).map((x) => normalizeEmailKey(x)).filter(Boolean)
    );

    if (!emailSet.size) return false;

    const docEmails = [
        data?.inboxEmail,
        data?.connectionEmail,
        data?.gmailEmail,
        data?.email,
    ]
        .map((x) => normalizeEmailKey(x))
        .filter(Boolean);

    return docEmails.some((email) => emailSet.has(email));
}

async function collectLegacyRootDocsForOwner({
    collectionName,
    retailOwnerId,
    emailCandidates = [],
    limitPerQuery = 250,
}) {
    const db = getFirestore();
    const coll = db.collection(collectionName);
    const seen = new Map();

    const directSnap = await coll.doc(retailOwnerId).get().catch(() => null);
    if (directSnap?.exists) {
        seen.set(directSnap.id, directSnap);
    }

    const querySpecs = [
        ["workspaceId", retailOwnerId],
        ["retailOwnerId", retailOwnerId],
        ["uid", retailOwnerId],
        ...emailCandidates.flatMap((email) => [
            ["inboxEmail", email],
            ["connectionEmail", email],
            ["gmailEmail", email],
            ["email", email],
        ]),
    ];

    const dedupedSpecs = uniqueNonEmpty(
        querySpecs.map(([field, value]) => `${field}::${value}`)
    ).map((entry) => {
        const [field, value] = entry.split("::");
        return [field, value];
    });

    for (const [field, value] of dedupedSpecs) {
        const snap = await coll.where(field, "==", value).limit(limitPerQuery).get().catch(() => null);
        if (!snap || snap.empty) continue;

        snap.forEach((docSnap) => {
            if (!seen.has(docSnap.id)) {
                seen.set(docSnap.id, docSnap);
            }
        });
    }

    return Array.from(seen.values()).filter((docSnap) =>
        legacyDocBelongsToOwner(docSnap.data() || {}, retailOwnerId, emailCandidates)
    );
}

async function migrateLegacyRootCollectionForOwner({
    collectionName,
    retailOwnerId,
    emailCandidates = [],
    nestedRefForDocId,
}) {
    const db = getFirestore();
    const docs = await collectLegacyRootDocsForOwner({
        collectionName,
        retailOwnerId,
        emailCandidates,
    });

    const summary = {
        matched: docs.length,
        copied: 0,
        archived: 0,
    };

    if (!docs.length) return summary;

    for (const chunk of chunkArray(docs, 200)) {
        const batch = db.batch();

        chunk.forEach((docSnap) => {
            const data = docSnap.data() || {};
            const nestedRef = nestedRefForDocId(docSnap.id);

            batch.set(
                nestedRef,
                retailValidatedPayload(retailKindForCollectionName(collectionName), retailOwnerId, {
                    ...data,
                    uid: retailOwnerId,
                    workspaceId: retailOwnerId,
                    retailOwnerId,
                    legacyRootCollection: collectionName,
                    legacyRootDocId: docSnap.id,
                    migratedFromLegacyRoot: true,
                    migratedAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                }),
                { merge: true }
            );

            batch.set(
                docSnap.ref,
                {
                    legacyArchived: true,
                    legacyArchivedAt: admin.firestore.FieldValue.serverTimestamp(),
                    legacyMigratedBy: retailOwnerId,
                    legacyMigratedToPath: nestedRef.path,
                    legacyMigrationVersion: "retailUsers_v1",
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
            );

            summary.copied += 1;
            summary.archived += 1;
        });

        await batch.commit();
    }

    return summary;
}

async function migrateLegacyConnectionForOwner({
    retailOwnerId,
    emailCandidates = [],
}) {
    const db = getFirestore();
    const docs = await collectLegacyRootDocsForOwner({
        collectionName: "retailReceiptConnections",
        retailOwnerId,
        emailCandidates,
    });

    const summary = {
        matched: docs.length,
        copied: 0,
        archived: 0,
    };

    if (!docs.length) return summary;

    const preferred =
        docs.find((docSnap) => docSnap.id === retailOwnerId) ||
        docs.find((docSnap) => {
            const data = docSnap.data() || {};
            const email = normalizeEmailKey(data.gmailEmail || data.email);
            return emailCandidates.includes(email);
        }) ||
        docs[0];

    const preferredData = preferred.data() || {};

    const batch = db.batch();

    batch.set(
        retailConnectionRef(retailOwnerId),
        retailValidatedPayload("connection", retailOwnerId, {
            ...preferredData,
            uid: retailOwnerId,
            workspaceId: retailOwnerId,
            retailOwnerId,
            gmailEmail:
                preferredData.gmailEmail ||
                preferredData.email ||
                emailCandidates[0] ||
                "",
            email:
                preferredData.email ||
                preferredData.gmailEmail ||
                emailCandidates[0] ||
                "",
            connectionEmail: normalizeEmailKey(
                preferredData.connectionEmail ||
                preferredData.gmailEmail ||
                preferredData.email ||
                emailCandidates[0] ||
                ""
            ),
            migratedFromLegacyRoot: true,
            legacyRootCollection: "retailReceiptConnections",
            legacyRootDocId: preferred.id,
            migratedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }),
        { merge: true }
    );

    summary.copied = 1;

    docs.forEach((docSnap) => {
        batch.set(
            docSnap.ref,
            {
                legacyArchived: true,
                legacyArchivedAt: admin.firestore.FieldValue.serverTimestamp(),
                legacyMigratedBy: retailOwnerId,
                legacyMigratedToPath: retailConnectionRef(retailOwnerId).path,
                legacyMigrationVersion: "retailUsers_v1",
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );

        summary.archived += 1;
    });

    await batch.commit();
    return summary;
}

async function migrateRetailLegacyDataForOwner({
    retailOwnerId,
    inboxEmail = "",
    connectionEmail = "",
}) {
    const db = getFirestore();

    const initialEmails = uniqueNonEmpty([
        normalizeEmailKey(inboxEmail),
        normalizeEmailKey(connectionEmail),
    ]);

    const connections = await migrateLegacyConnectionForOwner({
        retailOwnerId,
        emailCandidates: initialEmails,
    });

    const nestedConnSnap = await retailConnectionRef(retailOwnerId).get().catch(() => null);
    const nestedConn = nestedConnSnap?.exists ? nestedConnSnap.data() || {} : {};

    const resolvedEmails = uniqueNonEmpty([
        normalizeEmailKey(nestedConn.connectionEmail),
        normalizeEmailKey(nestedConn.gmailEmail),
        normalizeEmailKey(nestedConn.email),
        ...initialEmails,
    ]);

    const [receipts, failures, runs, allowlist] = await Promise.all([
        migrateLegacyRootCollectionForOwner({
            collectionName: "retailReceipts",
            retailOwnerId,
            emailCandidates: resolvedEmails,
            nestedRefForDocId: (docId) => retailReceiptDoc(db, retailOwnerId, docId),
        }),
        migrateLegacyRootCollectionForOwner({
            collectionName: "retailReceipts_failed",
            retailOwnerId,
            emailCandidates: resolvedEmails,
            nestedRefForDocId: (docId) => retailFailureDoc(db, retailOwnerId, docId),
        }),
        migrateLegacyRootCollectionForOwner({
            collectionName: "retailReceiptRuns",
            retailOwnerId,
            emailCandidates: resolvedEmails,
            nestedRefForDocId: (docId) => retailRunDoc(db, retailOwnerId, docId),
        }),
        migrateLegacyRootCollectionForOwner({
            collectionName: "receiptAllowlist",
            retailOwnerId,
            emailCandidates: resolvedEmails,
            nestedRefForDocId: (docId) => retailAllowlistDoc(db, retailOwnerId, docId),
        }),
    ]);

    const summary = {
        retailOwnerId,
        emailsResolved: resolvedEmails,
        connections,
        receipts,
        failures,
        runs,
        allowlist,
    };

    await retailSettingsRef(retailOwnerId).set(
        retailValidatedPayload("settings", retailOwnerId, {
            legacyMigration: {
                version: "retailUsers_v1",
                lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
                connections,
                receipts,
                failures,
                runs,
                allowlist,
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }),
        { merge: true }
    );

    return summary;
}

function oauthStateRef(state) {
    return getFirestore().collection("retailReceiptOauthStates").doc(state);
}

function retailConnectionRef(retailOwnerId) {
    return retailConnectionDoc(getFirestore(), retailOwnerId);
}

function retailSettingsRef(retailOwnerId) {
    return retailSettingsDoc(getFirestore(), retailOwnerId);
}

function retailAllowlistRef(retailOwnerId) {
    return retailAllowlistCollection(getFirestore(), retailOwnerId);
}

function retailRunRef(retailOwnerId, runId) {
    return retailRunDoc(getFirestore(), retailOwnerId, runId);
}

function retailReceiptsRef(retailOwnerId) {
    return retailReceiptDoc(getFirestore(), retailOwnerId, "sample").parent;
}

function retailFailuresRef(retailOwnerId) {
    return retailFailureDoc(getFirestore(), retailOwnerId, "sample").parent;
}

function retailRunsRef(retailOwnerId) {
    return retailRunDoc(getFirestore(), retailOwnerId, "sample").parent;
}

function retailSenderSuggestionsRef(retailOwnerId) {
    return retailSenderSuggestionsCollection(getFirestore(), retailOwnerId);
}

function retailSenderSuggestionRef(retailOwnerId, suggestionId) {
    return retailSenderSuggestionDoc(getFirestore(), retailOwnerId, suggestionId);
}

function legacyRetailUserPath(actorUid, ...segments) {
    return ["retailUsers", String(actorUid || "").trim(), ...segments]
        .filter(Boolean)
        .join("/");
}

function legacyRetailUserDoc(actorUid, ...segments) {
    return getFirestore().doc(legacyRetailUserPath(actorUid, ...segments));
}

function legacyRetailUserCollection(actorUid, ...segments) {
    return getFirestore().collection(legacyRetailUserPath(actorUid, ...segments));
}

async function migrateLegacyPersonalRetailToTenant({ actorUid, tenantId }) {
    const db = getFirestore();
    const summary = {
        actorUid: String(actorUid || "").trim(),
        tenantId: String(tenantId || "").trim(),
        connection: { matched: 0, copied: 0, archived: 0 },
        settings: { matched: 0, copied: 0, archived: 0 },
        allowlist: { matched: 0, copied: 0, archived: 0 },
        receipts: { matched: 0, copied: 0, archived: 0 },
        failures: { matched: 0, copied: 0, archived: 0 },
        runs: { matched: 0, copied: 0, archived: 0 },
    };

    if (!summary.actorUid || !summary.tenantId) return summary;

    const copyDoc = async (legacySegments, targetRef, bucketName) => {
        const snap = await legacyRetailUserDoc(actorUid, ...legacySegments).get().catch(() => null);
        if (!snap?.exists) return;

        summary[bucketName].matched += 1;
        const data = snap.data() || {};
        const batch = db.batch();

        batch.set(
            targetRef,
            retailValidatedPayload(
                bucketName === "settings" ? "settings" : "connection",
                tenantId,
                {
                    ...data,
                    tenantId,
                    workspaceId: tenantId,
                    retailOwnerId: tenantId,
                    connectedByUid: data.connectedByUid || actorUid,
                    migratedFromRetailUsers: true,
                    legacyRetailUserId: actorUid,
                    legacyRetailPath: legacyRetailUserPath(actorUid, ...legacySegments),
                    migratedAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                }),
            { merge: true }
        );

        batch.set(
            snap.ref,
            {
                legacyArchived: true,
                legacyArchivedAt: admin.firestore.FieldValue.serverTimestamp(),
                legacyMigratedBy: tenantId,
                legacyMigratedToPath: targetRef.path,
                legacyMigrationVersion: RETAIL_LEGACY_CUTOVER_VERSION,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );

        await batch.commit();
        summary[bucketName].copied += 1;
        summary[bucketName].archived += 1;
    };

    const copyCollection = async (legacySegments, targetRefForDocId, bucketName) => {
        const snap = await legacyRetailUserCollection(actorUid, ...legacySegments).get().catch(() => null);
        if (!snap || snap.empty) return;

        summary[bucketName].matched += snap.size;

        for (const chunk of chunkArray(snap.docs, 200)) {
            const batch = db.batch();

            for (const docSnap of chunk) {
                const data = docSnap.data() || {};
                const targetRef = targetRefForDocId(docSnap.id);

                batch.set(
                    targetRef,
                    retailValidatedPayload(
                        bucketName === "allowlist"
                            ? "allowlist"
                            : bucketName === "receipts"
                                ? "receipt"
                                : bucketName === "failures"
                                    ? "failure"
                                    : bucketName === "runs"
                                        ? "run"
                                        : "retail",
                        tenantId,
                        {
                            ...data,
                            tenantId,
                            workspaceId: tenantId,
                            retailOwnerId: tenantId,
                            connectedByUid: data.connectedByUid || actorUid,
                            migratedFromRetailUsers: true,
                            legacyRetailUserId: actorUid,
                            legacyRetailDocId: docSnap.id,
                            legacyRetailPath: legacyRetailUserPath(actorUid, ...legacySegments, docSnap.id),
                            migratedAt: admin.firestore.FieldValue.serverTimestamp(),
                            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        }),
                    { merge: true }
                );

                batch.set(
                    docSnap.ref,
                    {
                        legacyArchived: true,
                        legacyArchivedAt: admin.firestore.FieldValue.serverTimestamp(),
                        legacyMigratedBy: tenantId,
                        legacyMigratedToPath: targetRef.path,
                        legacyMigrationVersion: RETAIL_LEGACY_CUTOVER_VERSION,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    },
                    { merge: true }
                );

                summary[bucketName].copied += 1;
                summary[bucketName].archived += 1;
            }

            await batch.commit();
        }
    };

    await copyDoc(["connection", "main"], retailConnectionRef(tenantId), "connection");
    await copyDoc(["settings", "main"], retailSettingsRef(tenantId), "settings");
    await copyCollection(["allowlist"], (docId) => retailAllowlistDoc(db, tenantId, docId), "allowlist");
    await copyCollection(["receipts"], (docId) => retailReceiptDoc(db, tenantId, docId), "receipts");
    await copyCollection(["failures"], (docId) => retailFailureDoc(db, tenantId, docId), "failures");
    await copyCollection(["runs"], (docId) => retailRunDoc(db, tenantId, docId), "runs");

    return summary;
}

async function countDocsSafe(ref) {
    const snap = await ref.get().catch(() => null);
    return snap?.size || 0;
}

function countSummaryBucket(totalTarget, rootBucket = {}, retailUsersBucket = {}) {
    const sourceMatched = Number(rootBucket.matched || 0) + Number(retailUsersBucket.matched || 0);
    const sourceCopied = Number(rootBucket.copied || 0) + Number(retailUsersBucket.copied || 0);

    return {
        sourceMatched,
        sourceCopied,
        targetCount: Number(totalTarget || 0),
        ok: Number(totalTarget || 0) >= sourceCopied,
    };
}

async function buildRetailLegacyCutoverVerification({
    retailOwnerId,
    actorUid,
    rootSummary,
    retailUsersSummary,
}) {
    const [
        connectionSnap,
        settingsSnap,
        allowlistCount,
        receiptsCount,
        failuresCount,
        runsCount,
    ] = await Promise.all([
        retailConnectionRef(retailOwnerId).get().catch(() => null),
        retailSettingsRef(retailOwnerId).get().catch(() => null),
        countDocsSafe(retailAllowlistRef(retailOwnerId)),
        countDocsSafe(retailReceiptsRef(retailOwnerId)),
        countDocsSafe(retailFailuresRef(retailOwnerId)),
        countDocsSafe(retailRunsRef(retailOwnerId)),
    ]);

    const verifyCounts = {
        receipts: countSummaryBucket(
            receiptsCount,
            rootSummary.receipts,
            retailUsersSummary.receipts
        ),
        failures: countSummaryBucket(
            failuresCount,
            rootSummary.failures,
            retailUsersSummary.failures
        ),
        runs: countSummaryBucket(
            runsCount,
            rootSummary.runs,
            retailUsersSummary.runs
        ),
    };

    const verifyAllowlist = {
        ...countSummaryBucket(
            allowlistCount,
            rootSummary.allowlist,
            retailUsersSummary.allowlist
        ),
        ok:
            allowlistCount >=
            (Number(rootSummary.allowlist?.copied || 0) +
                Number(retailUsersSummary.allowlist?.copied || 0)),
    };

    const connectionSourceCopied =
        Number(rootSummary.connections?.copied || 0) +
        Number(retailUsersSummary.connection?.copied || 0);

    const settingsSourceCopied = Number(retailUsersSummary.settings?.copied || 0);

    const verifyGmail = {
        connection: {
            sourceCopied: connectionSourceCopied,
            exists: !!connectionSnap?.exists,
            ok: !!connectionSnap?.exists || connectionSourceCopied === 0,
        },
        settings: {
            sourceCopied: settingsSourceCopied,
            exists: !!settingsSnap?.exists,
            ok: !!settingsSnap?.exists,
        },
    };

    const archiveSummary = {
        rootDocsArchived:
            Number(rootSummary.connections?.archived || 0) +
            Number(rootSummary.receipts?.archived || 0) +
            Number(rootSummary.failures?.archived || 0) +
            Number(rootSummary.runs?.archived || 0) +
            Number(rootSummary.allowlist?.archived || 0),

        retailUsersArchived:
            Number(retailUsersSummary.connection?.archived || 0) +
            Number(retailUsersSummary.settings?.archived || 0) +
            Number(retailUsersSummary.allowlist?.archived || 0) +
            Number(retailUsersSummary.receipts?.archived || 0) +
            Number(retailUsersSummary.failures?.archived || 0) +
            Number(retailUsersSummary.runs?.archived || 0),

        rootCollectionsFrozen: true,
        retailUsersFrozen: true,
        actorUid: String(actorUid || "").trim(),
        ok: true,
    };

    return {
        verifyCounts,
        verifyAllowlist,
        verifyRuns: verifyCounts.runs,
        verifyGmail,
        archiveSummary,
    };
}

async function runRetailLegacyCutover({
    retailOwnerId,
    actorUid,
    force = false,
    inboxEmail = "",
    connectionEmail = "",
}) {
    const settingsRef = retailSettingsRef(retailOwnerId);
    const existingSettingsSnap = await settingsRef.get().catch(() => null);
    const existingSettings = existingSettingsSnap?.exists
        ? existingSettingsSnap.data() || {}
        : {};
    const existingCutover = existingSettings?.legacyCutover || {};

    if (!force && String(existingCutover.status || "").toLowerCase() === "completed") {
        return {
            alreadyCompleted: true,
            cutover: existingCutover,
        };
    }

    const [rootSummary, retailUsersSummary] = await Promise.all([
        migrateRetailLegacyDataForOwner({
            retailOwnerId,
            inboxEmail,
            connectionEmail,
        }),
        migrateLegacyPersonalRetailToTenant({
            actorUid,
            tenantId: retailOwnerId,
        }),
    ]);

    const verification = await buildRetailLegacyCutoverVerification({
        retailOwnerId,
        actorUid,
        rootSummary,
        retailUsersSummary,
    });

    const completedAtIso = new Date().toISOString();

    const cutoverSummary = {
        version: RETAIL_LEGACY_CUTOVER_VERSION,
        mode: "one_time",
        status: "completed",
        tenantId: retailOwnerId,
        actorUid: String(actorUid || "").trim(),
        force: !!force,
        completedAtIso,
        migrateRootDocs: rootSummary,
        migrateRetailUsers: retailUsersSummary,
        ...verification,
    };

    await settingsRef.set(
        retailValidatedPayload("settings", retailOwnerId, {
            legacyCutover: {
                ...cutoverSummary,
                completedAt: admin.firestore.FieldValue.serverTimestamp(),
                rootCollectionsArchiveFreeze: {
                    ok: verification.archiveSummary.ok,
                    rootDocsArchived: verification.archiveSummary.rootDocsArchived,
                    retailUsersArchived: verification.archiveSummary.retailUsersArchived,
                    rootCollectionsFrozen: true,
                    retailUsersFrozen: true,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }),
        { merge: true }
    );

    return {
        alreadyCompleted: false,
        cutover: cutoverSummary,
    };
}

function normalizeRetailSuccessUrl(value = "") {
    const safe = String(value || "").trim();
    if (!safe) return "";

    try {
        const parsed = new URL(safe);
        if (!["http:", "https:"].includes(parsed.protocol)) {
            return "";
        }
        return parsed.toString();
    } catch (_err) {
        return "";
    }
}

function buildGoogleAuthUrl(state) {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", RETAIL_GMAIL_CLIENT_ID);
    url.searchParams.set("redirect_uri", RETAIL_GMAIL_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set(
        "scope",
        [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/userinfo.email",
        ].join(" ")
    );
    url.searchParams.set("state", state);
    return url.toString();
}

function uniqueStrings(list = []) {
    return Array.from(
        new Set(
            (Array.isArray(list) ? list : [list])
                .map((x) => String(x || "").trim().toLowerCase())
                .filter(Boolean)
        )
    );
}

function normalizeEmailEntry(value) {
    const s = String(value || "").trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
}

function normalizeDomainEntry(value) {
    let s = String(value || "").trim().toLowerCase();
    s = s
        .replace(/^@\*/, "")
        .replace(/^@/, "")
        .replace(/^\*\./, "")
        .replace(/^www\./, "");
    s = s.replace(/^https?:\/\//, "").split("/")[0].trim();
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s) ? s : "";
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function normalizeIntInRange(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeIsoUtc(value) {
    const s = String(value || "").trim();
    if (!s) return "";

    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) return "";

    try {
        return new Date(ms).toISOString();
    } catch {
        return "";
    }
}

function buildGmailAfterClause(
    cursorIso,
    overlapMinutes = DEFAULT_SYNC_OVERLAP_MINUTES
) {
    const safeIso = normalizeIsoUtc(cursorIso);
    if (!safeIso) return "";

    const ms = Date.parse(safeIso);
    if (!Number.isFinite(ms)) return "";

    const safeOverlap = normalizeIntInRange(
        overlapMinutes,
        DEFAULT_SYNC_OVERLAP_MINUTES,
        0,
        1440
    );

    const adjustedMs = Math.max(0, ms - safeOverlap * 60 * 1000);
    const unixSeconds = Math.floor(adjustedMs / 1000);
    if (!unixSeconds) return "";

    return `after:${unixSeconds}`;
}

function buildExplicitWindowClauses({ days = 30, window = null } = {}) {
    const safeWindow = normalizeSyncWindow(window);

    if (safeWindow?.maxDaysAgo != null) {
        const clauses = [`newer_than:${safeWindow.maxDaysAgo}d`];
        if (safeWindow.minDaysAgo > 0) {
            clauses.push(`older_than:${safeWindow.minDaysAgo}d`);
        }
        return clauses;
    }

    return [`newer_than:${Math.max(1, Number(days || 30))}d`];
}

function resolveSyncTimePlan({
    days = 30,
    window = null,
    lastSyncCursorIso = "",
    overlapMinutes = DEFAULT_SYNC_OVERLAP_MINUTES,
    ignoreCursor = false,
} = {}) {
    const safeWindow = normalizeSyncWindow(window);
    const safeCursorIso = normalizeIsoUtc(lastSyncCursorIso);
    const safeOverlapMinutes = normalizeIntInRange(
        overlapMinutes,
        DEFAULT_SYNC_OVERLAP_MINUTES,
        0,
        1440
    );

    if (safeWindow?.maxDaysAgo != null) {
        return {
            mode: "window",
            clauses: buildExplicitWindowClauses({ days, window: safeWindow }),
            window: safeWindow,
            overlapMinutes: safeOverlapMinutes,
            savedCursorIso: safeCursorIso,
            appliedCursorIso: "",
        };
    }

    if (!ignoreCursor && safeCursorIso) {
        const afterClause = buildGmailAfterClause(safeCursorIso, safeOverlapMinutes);
        if (afterClause) {
            return {
                mode: "cursor",
                clauses: [afterClause],
                window: null,
                overlapMinutes: safeOverlapMinutes,
                savedCursorIso: safeCursorIso,
                appliedCursorIso: safeCursorIso,
            };
        }
    }

    return {
        mode: "days",
        clauses: buildExplicitWindowClauses({ days, window: null }),
        window: null,
        overlapMinutes: safeOverlapMinutes,
        savedCursorIso: safeCursorIso,
        appliedCursorIso: "",
    };
}

function normalizeScopeList(value) {
    if (Array.isArray(value)) {
        return Array.from(
            new Set(
                value
                    .map((x) => String(x || "").trim())
                    .filter(Boolean)
            )
        );
    }

    return Array.from(
        new Set(
            String(value || "")
                .split(/\s+/)
                .map((x) => String(x || "").trim())
                .filter(Boolean)
        )
    );
}

function buildManualWatchStatus(extra = {}) {
    return {
        mode: "manual_sync",
        state: "inactive",
        supported: false,
        lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...extra,
    };
}

function normalizeAllowlist(value = {}) {
    const emails = uniqueStrings(
        (Array.isArray(value?.emails) ? value.emails : [])
            .map(normalizeEmailEntry)
            .filter(Boolean)
    );

    const domains = uniqueStrings(
        (Array.isArray(value?.domains) ? value.domains : [])
            .map(normalizeDomainEntry)
            .filter(Boolean)
    );

    return { emails, domains };
}

function normalizeAutoSchedulerSettings(value = {}, saved = {}) {
    const source = value && typeof value === "object" ? value : {};
    const prev = saved && typeof saved === "object" ? saved : {};

    const legacyRecentHours = normalizeIntInRange(
        hasOwn(source, "recentEveryHours")
            ? source.recentEveryHours
            : prev.recentEveryHours,
        24,
        1,
        168
    );

    const recentEveryMinutes = normalizeIntInRange(
        hasOwn(source, "recentEveryMinutes")
            ? source.recentEveryMinutes
            : prev.recentEveryMinutes,
        DEFAULT_AUTO_RECENT_EVERY_MINUTES,
        5,
        1440
    );

    const recentDays = normalizeIntInRange(
        hasOwn(source, "recentDays") ? source.recentDays : prev.recentDays,
        DEFAULT_AUTO_RECENT_DAYS,
        1,
        30
    );

    const recentMaxMessages = normalizeIntInRange(
        hasOwn(source, "recentMaxMessages") ? source.recentMaxMessages : prev.recentMaxMessages,
        DEFAULT_AUTO_RECENT_MAX_MESSAGES,
        1,
        50
    );

    const backfillEveryDays = normalizeIntInRange(
        hasOwn(source, "backfillEveryDays") ? source.backfillEveryDays : prev.backfillEveryDays,
        DEFAULT_AUTO_BACKFILL_EVERY_DAYS,
        1,
        60
    );

    const backfillStartDaysAgo = normalizeIntInRange(
        hasOwn(source, "backfillStartDaysAgo") ? source.backfillStartDaysAgo : prev.backfillStartDaysAgo,
        DEFAULT_AUTO_BACKFILL_START_DAYS_AGO,
        1,
        3650
    );

    const backfillChunkDays = normalizeIntInRange(
        hasOwn(source, "backfillChunkDays") ? source.backfillChunkDays : prev.backfillChunkDays,
        DEFAULT_AUTO_BACKFILL_CHUNK_DAYS,
        7,
        365
    );

    const backfillMaxDays = normalizeIntInRange(
        hasOwn(source, "backfillMaxDays") ? source.backfillMaxDays : prev.backfillMaxDays,
        DEFAULT_AUTO_BACKFILL_MAX_DAYS,
        backfillStartDaysAgo + backfillChunkDays,
        3650
    );

    const nextBackfillStartDaysAgo = normalizeIntInRange(
        hasOwn(source, "nextBackfillStartDaysAgo") ? source.nextBackfillStartDaysAgo : prev.nextBackfillStartDaysAgo,
        backfillStartDaysAgo,
        1,
        3650
    );

    const backfillMaxMessages = normalizeIntInRange(
        hasOwn(source, "backfillMaxMessages") ? source.backfillMaxMessages : prev.backfillMaxMessages,
        DEFAULT_AUTO_BACKFILL_MAX_MESSAGES,
        1,
        50
    );

    return {
        enabled: hasOwn(source, "enabled") ? !!source.enabled : prev.enabled !== false,
        recentEveryMinutes,
        recentEveryHours: Math.max(1, Math.ceil((recentEveryMinutes || legacyRecentHours * 60) / 60)),
        recentDays,
        recentMaxMessages,
        backfillEveryDays,
        backfillStartDaysAgo,
        nextBackfillStartDaysAgo,
        backfillChunkDays,
        backfillMaxDays,
        backfillMaxMessages,
        lastAutoRecentAt: prev.lastAutoRecentAt || null,
        lastAutoBackfillAt: prev.lastAutoBackfillAt || null,
        lastRunAt: prev.lastRunAt || null,
        lastRunMode: String(prev.lastRunMode || "").trim(),
        lastRunSource: String(prev.lastRunSource || "").trim(),
        lastRunSummary: prev.lastRunSummary || null,
    };
}

function safeCompare(left, right) {
    const a = Buffer.from(String(left || ""));
    const b = Buffer.from(String(right || ""));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function assertRetailSchedulerCronSecret(req) {
    const configured = String(
        process.env.CRON_SECRET ||
        process.env.RETAIL_AUTO_SCHEDULER_SECRET ||
        process.env.PAYROLL_CRON_SECRET ||
        ""
    ).trim();

    if (!configured) {
        if (process.env.NODE_ENV === "production") {
            const err = new Error("CRON_SECRET or RETAIL_AUTO_SCHEDULER_SECRET is not configured");
            err.statusCode = 500;
            throw err;
        }
        return;
    }

    const authHeader = String(req.headers["authorization"] || "").trim();
    const bearerPrefix = "Bearer ";
    const bearerToken = authHeader.startsWith(bearerPrefix)
        ? authHeader.slice(bearerPrefix.length).trim()
        : "";

    const provided = String(
        bearerToken ||
        req.headers["x-retail-cron-secret"] ||
        req.headers["x-cron-secret"] ||
        req.query.secret ||
        req.body?.secret ||
        ""
    ).trim();

    if (!provided || !safeCompare(provided, configured)) {
        const err = new Error("unauthorized");
        err.statusCode = 401;
        throw err;
    }
}

function parseCronBoolean(value, fallback = false) {
    const s = String(value == null ? "" : value).trim().toLowerCase();
    if (!s) return fallback;
    return ["1", "true", "yes", "on"].includes(s);
}

async function handleRetailSchedulerHttp(req, res, {
    mode = "all",
    source = "cron_http",
} = {}) {
    try {
        assertRetailSchedulerCronSecret(req);

        const result = await runRetailReceiptSchedulerPass({
            mode: String(req.body?.mode || req.query.mode || mode).trim() || mode,
            limit: normalizeIntInRange(req.body?.limit || req.query.limit, DEFAULT_AUTO_SCHEDULER_LIMIT, 1, 100),
            retailOwnerId: String(req.body?.retailOwnerId || req.query.retailOwnerId || "").trim(),
            dry: parseCronBoolean(req.body?.dry || req.query.dry, false),
            force: parseCronBoolean(req.body?.force || req.query.force, false),
            source,
        });

        return res.json({ ok: true, ...result, scheduler: getRetailReceiptSchedulerStatus() });
    } catch (err) {
        console.error(`receipts/google/${source} error`, err);
        return res
            .status(err.statusCode || 500)
            .json({ ok: false, error: err.message || "Scheduler run failed" });
    }
}

async function loadRetailAllowlistFromDb(retailOwnerId) {
    const db = getFirestore();

    // Fast path: prefer the normalized allowlist mirrored into settings.main so
    // sync and sender-review flows do not scan the full allowlist collection on
    // every request.
    const settingsSnap = await retailSettingsDoc(db, retailOwnerId).get().catch(() => null);
    const settingsAllowlist = normalizeAllowlist(settingsSnap?.data()?.allowlist || {});
    if (settingsAllowlist.emails.length || settingsAllowlist.domains.length) {
        return settingsAllowlist;
    }

    // Backward-compatible fallback for older tenants that still only have the
    // allowlist entries in the collection documents.
    const snap = await retailAllowlistCollection(db, retailOwnerId).get();

    const emails = [];
    const domains = [];

    snap.forEach((docSnap) => {
        const data = docSnap.data() || {};
        const type = String(data.type || "").trim().toLowerCase();
        const pattern = String(data.pattern || "").trim();

        if (!pattern) return;

        if (type === "email") {
            const safe = normalizeEmailEntry(pattern);
            if (safe) emails.push(safe);
            return;
        }

        if (type === "domain") {
            const safe = normalizeDomainEntry(pattern);
            if (safe) domains.push(safe);
        }
    });

    return normalizeAllowlist({ emails, domains });
}

function extractSenderEmail(fromHeader) {
    const raw = String(fromHeader || "").trim().toLowerCase();
    if (!raw) return "";

    const angle = raw.match(/<([^>]+)>/);
    const candidate =
        angle?.[1] ||
        raw
            .split(/[\s,]+/)
            .find((part) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part)) ||
        raw;

    const clean = String(candidate)
        .replace(/^mailto:/, "")
        .replace(/[<>"']/g, "")
        .trim();

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? clean : "";
}

function matchesSenderAllowlist(sender, allowlist = {}) {
    const safe = normalizeAllowlist(allowlist);
    if (!safe.emails.length && !safe.domains.length) return true;

    const email = extractSenderEmail(sender);
    if (!email) return false;

    const domain = email.split("@")[1] || "";
    if (!domain) return false;

    if (safe.emails.includes(email)) return true;

    return safe.domains.some(
        (allowed) => domain === allowed || domain.endsWith(`.${allowed}`)
    );
}

function normalizeGmailLabelToken(value) {
    const s = String(value || "").trim();
    return /^[A-Za-z0-9_./-]+$/.test(s) ? s : "";
}

function normalizeSyncWindow(value) {
    if (!value || (value.maxDaysAgo == null && value.minDaysAgo == null)) {
        return null;
    }

    const minDaysAgo = normalizeIntInRange(value?.minDaysAgo, 0, 0, 3650);
    const rawMax =
        value?.maxDaysAgo == null ? Math.max(1, minDaysAgo + 1) : value.maxDaysAgo;

    const maxDaysAgo = normalizeIntInRange(
        rawMax,
        Math.max(1, minDaysAgo + 1),
        Math.max(1, minDaysAgo + 1),
        3650
    );

    return { minDaysAgo, maxDaysAgo };
}

function buildSyncWindowClauses({
    days = 30,
    window = null,
    lastSyncCursorIso = "",
    overlapMinutes = DEFAULT_SYNC_OVERLAP_MINUTES,
    ignoreCursor = false,
} = {}) {
    return resolveSyncTimePlan({
        days,
        window,
        lastSyncCursorIso,
        overlapMinutes,
        ignoreCursor,
    }).clauses;
}

function buildAllowlistSenderTerms(allowlist = {}) {
    const safe = normalizeAllowlist(allowlist);

    return uniqueNonEmpty([
        ...safe.emails.map((email) => `from:${email}`),
        ...safe.domains.map((domain) => `from:${domain}`),
    ]);
}

function buildRetailGmailQueries({
    days = 30,
    window = null,
    allowlist = {},
    anySender = false,
    skipProcessed = true,
    processedLabel = DEFAULT_RETAIL_IMPORTED_LABEL,
    queryChunkSize = DEFAULT_ALLOWLIST_QUERY_CHUNK_SIZE,
    lastSyncCursorIso = "",
    overlapMinutes = DEFAULT_SYNC_OVERLAP_MINUTES,
    ignoreCursor = false,
} = {}) {
    const timePlan = resolveSyncTimePlan({
        days,
        window,
        lastSyncCursorIso,
        overlapMinutes,
        ignoreCursor,
    });

    const qParts = [
        ...timePlan.clauses,
        RETAIL_RECEIPT_SIGNAL_QUERY,
        RETAIL_NEGATIVE_SUBJECT_QUERY,
        ...RETAIL_NOISE_EXCLUSIONS,
    ];

    const safeProcessedLabel = normalizeGmailLabelToken(processedLabel);
    if (skipProcessed && safeProcessedLabel) {
        qParts.push(`-label:${safeProcessedLabel}`);
    }

    const baseQuery = qParts.filter(Boolean).join(" ");

    if (anySender) return [baseQuery];

    const senderTerms = buildAllowlistSenderTerms(allowlist);
    if (!senderTerms.length) {
        return [baseQuery];
    }

    const chunkSize = Math.max(
        10,
        Math.min(50, Number(queryChunkSize || DEFAULT_ALLOWLIST_QUERY_CHUNK_SIZE))
    );

    const queries = [];
    for (let i = 0; i < senderTerms.length; i += chunkSize) {
        const chunk = senderTerms.slice(i, i + chunkSize);
        queries.push(`${baseQuery} (${chunk.join(" OR ")})`);
    }

    return uniqueNonEmpty(queries);
}

async function exchangeCodeForTokens(code) {
    const body = new URLSearchParams({
        code,
        client_id: RETAIL_GMAIL_CLIENT_ID,
        client_secret: RETAIL_GMAIL_CLIENT_SECRET,
        redirect_uri: RETAIL_GMAIL_REDIRECT_URI,
        grant_type: "authorization_code",
    });

    const res = await nodeFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
    });

    const json = await res.json();
    if (!res.ok || !json.access_token) {
        throw new Error(json.error_description || json.error || "OAuth token exchange failed");
    }
    return json;
}

async function refreshAccessToken(refreshToken) {
    const body = new URLSearchParams({
        refresh_token: refreshToken,
        client_id: RETAIL_GMAIL_CLIENT_ID,
        client_secret: RETAIL_GMAIL_CLIENT_SECRET,
        grant_type: "refresh_token",
    });

    const res = await nodeFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
    });

    const json = await res.json();
    if (!res.ok || !json.access_token) {
        throw new Error(json.error_description || json.error || "Refresh token failed");
    }
    return json.access_token;
}

async function gmailGetJson(accessToken, url) {
    const res = await nodeFetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = await res.json();
    if (!res.ok) {
        throw new Error(json.error?.message || `Gmail API failed (${res.status})`);
    }
    return json;
}

async function fetchGoogleProfile(accessToken) {
    return gmailGetJson(
        accessToken,
        "https://gmail.googleapis.com/gmail/v1/users/me/profile"
    );
}

async function listGmailLabels(accessToken) {
    const json = await gmailGetJson(
        accessToken,
        "https://gmail.googleapis.com/gmail/v1/users/me/labels"
    );

    return Array.isArray(json.labels) ? json.labels : [];
}

async function createGmailLabel(accessToken, name) {
    const labelName = String(name || "").trim();
    if (!labelName) throw new Error("Missing Gmail label name");

    const res = await nodeFetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
                name: labelName,
                labelListVisibility: "labelShow",
                messageListVisibility: "show",
            }),
        }
    );

    const json = await res.json();
    if (!res.ok || !json.id) {
        throw new Error(json.error?.message || `Create Gmail label failed (${res.status})`);
    }

    return json;
}

async function ensureGmailLabelIds(accessToken, labelNames = []) {
    const wanted = uniqueNonEmpty(labelNames);
    if (!wanted.length) return {};

    const byName = {};
    const existing = await listGmailLabels(accessToken);
    existing.forEach((label) => {
        const name = String(label?.name || "").trim();
        if (name && label?.id) {
            byName[name] = label.id;
        }
    });

    for (const name of wanted) {
        if (byName[name]) continue;
        const created = await createGmailLabel(accessToken, name);
        if (created?.id) {
            byName[name] = created.id;
        }
    }

    return wanted.reduce((acc, name) => {
        if (byName[name]) acc[name] = byName[name];
        return acc;
    }, {});
}

async function batchModifyGmailMessages(
    accessToken,
    messageIds = [],
    { addLabelIds = [], removeLabelIds = [] } = {}
) {
    const ids = uniqueNonEmpty(messageIds);
    if (!ids.length) {
        return { ok: true, modified: 0 };
    }

    const res = await nodeFetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
                ids,
                addLabelIds: uniqueNonEmpty(addLabelIds),
                removeLabelIds: uniqueNonEmpty(removeLabelIds),
            }),
        }
    );

    const text = await res.text();
    let json = {};
    try {
        json = text ? JSON.parse(text) : {};
    } catch {
        json = {};
    }

    if (!res.ok) {
        throw new Error(
            json.error?.message || text || `Gmail batchModify failed (${res.status})`
        );
    }

    return { ok: true, modified: ids.length };
}

function standardBase64(input) {
    return String(input || "").replace(/-/g, "+").replace(/_/g, "/");
}

function decodeBase64UrlText(input) {
    const raw = String(input || "");
    if (!raw) return "";
    try {
        return Buffer.from(standardBase64(raw), "base64").toString("utf8");
    } catch {
        return "";
    }
}

function findHeader(payload, name) {
    const target = String(name || "").toLowerCase();
    const headers = payload?.headers || [];
    const hit = headers.find((h) => String(h.name || "").toLowerCase() === target);
    return hit?.value || "";
}

function stripHtml(html) {
    return String(html || "")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/\s+/g, " ")
        .trim();
}

function collectBodyParts(node, out = { plain: [], html: [] }) {
    if (!node) return out;

    const mimeType = String(node.mimeType || "").toLowerCase();
    const bodyData = node?.body?.data ? decodeBase64UrlText(node.body.data) : "";

    if (mimeType === "text/plain" && bodyData) out.plain.push(bodyData);
    if (mimeType === "text/html" && bodyData) out.html.push(bodyData);

    const parts = Array.isArray(node.parts) ? node.parts : [];
    parts.forEach((part) => collectBodyParts(part, out));

    return out;
}

function collectAttachmentMetas(node, out = []) {
    if (!node) return out;

    const mimeType = String(node.mimeType || "").toLowerCase();
    const filename = String(node.filename || "").trim();
    const attachmentId = node?.body?.attachmentId || "";

    if (
        attachmentId &&
        filename &&
        (mimeType.includes("pdf") || mimeType.startsWith("image/"))
    ) {
        out.push({
            attachmentId,
            filename,
            contentType: node.mimeType || "application/octet-stream",
        });
    }

    const parts = Array.isArray(node.parts) ? node.parts : [];
    parts.forEach((part) => collectAttachmentMetas(part, out));

    return out;
}

async function fetchAttachmentBase64(accessToken, messageId, attachmentId) {
    const json = await gmailGetJson(
        accessToken,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
            messageId
        )}/attachments/${encodeURIComponent(attachmentId)}`
    );
    return standardBase64(json.data || "");
}

async function listReceiptMessageIds(
    accessToken,
    { queries = [], maxMessages = 25, rawFetchLimit = null } = {}
) {
    const plannedQueries = uniqueNonEmpty(queries);
    if (!plannedQueries.length) return [];

    const targetRaw = Math.max(
        maxMessages,
        normalizeIntInRange(rawFetchLimit, maxMessages * 3, maxMessages, 500)
    );

    const perQueryBudget = Math.max(
        maxMessages,
        Math.ceil(targetRaw / plannedQueries.length)
    );

    const ids = [];

    for (const query of plannedQueries) {
        let pageToken = "";
        let addedForQuery = 0;

        while (ids.length < targetRaw && addedForQuery < perQueryBudget) {
            const pageSize = Math.min(
                50,
                targetRaw - ids.length,
                perQueryBudget - addedForQuery
            );

            const url = new URL(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages"
            );
            url.searchParams.set("q", query);
            url.searchParams.set("maxResults", String(pageSize));

            if (pageToken) {
                url.searchParams.set("pageToken", pageToken);
            }

            const json = await gmailGetJson(accessToken, url.toString());
            const rows = Array.isArray(json.messages) ? json.messages : [];

            let freshAdded = 0;
            rows.forEach((row) => {
                if (row?.id && !ids.includes(row.id)) {
                    ids.push(row.id);
                    freshAdded += 1;
                }
            });

            addedForQuery += freshAdded;

            if (!json.nextPageToken || !rows.length || freshAdded === 0) {
                break;
            }

            pageToken = json.nextPageToken;
        }

        if (ids.length >= targetRaw) break;
    }

    return ids;
}

async function fetchFullMessage(accessToken, messageId) {
    return gmailGetJson(
        accessToken,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
            messageId
        )}?format=full`
    );
}

function buildRetailEmailPermalink({ gmailId = "", messageId = "" } = {}) {
    const safeMessageId = String(messageId || "").trim().replace(/^<|>$/g, "");
    const safeGmailId = String(gmailId || "").trim();

    if (safeMessageId && safeMessageId.includes("@")) {
        return `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(
            safeMessageId
        )}`;
    }

    if (safeGmailId) {
        return `https://mail.google.com/mail/u/0/#all/${safeGmailId}`;
    }

    return "";
}

async function buildImportMessage(accessToken, messageId, inboxEmail) {
    const full = await fetchFullMessage(accessToken, messageId);
    const payload = full.payload || {};
    const bodyParts = collectBodyParts(payload);
    const plain = bodyParts.plain.join("\n").trim();
    const htmlText = stripHtml(bodyParts.html.join("\n"));
    const attachmentMetas = collectAttachmentMetas(payload).slice(0, 2);

    const attachments = [];
    for (const meta of attachmentMetas) {
        const base64 = await fetchAttachmentBase64(
            accessToken,
            messageId,
            meta.attachmentId
        );
        if (base64) {
            attachments.push({
                name: meta.filename,
                contentType: meta.contentType,
                base64,
            });
        }
    }

    const headerMessageId =
        String(findHeader(payload, "Message-Id") || "").replace(/^<|>$/g, "") ||
        full.id;

    const rawDateHeader = findHeader(payload, "Date");
    let messageDateIso = "";
    try {
        messageDateIso = full.internalDate
            ? new Date(Number(full.internalDate)).toISOString()
            : new Date(rawDateHeader).toISOString();
    } catch {
        messageDateIso = new Date().toISOString();
    }

    return {
        gmailId: full.id,
        messageId: headerMessageId,
        emailPermalink: buildRetailEmailPermalink({
            gmailId: full.id,
            messageId: headerMessageId,
        }),
        sender: findHeader(payload, "From"),
        subject: findHeader(payload, "Subject"),
        rawDate: rawDateHeader,
        messageDate: messageDateIso,
        inboxEmail: inboxEmail || "",
        bodyPlain: plain || htmlText || "",
        snippet: full.snippet || "",
        attachments,
    };
}

function parseSenderDisplayName(fromHeader = "") {
    const raw = String(fromHeader || "").trim();
    if (!raw) return "";

    const angle = raw.match(/^(.*?)(<[^>]+>)$/);
    const candidate = angle?.[1] || raw.split("<")[0] || "";
    return String(candidate).replace(/["']/g, "").trim();
}

function extractSenderDomain(fromHeader = "") {
    const email = extractSenderEmail(fromHeader);
    if (!email || !email.includes("@")) return "";
    return normalizeDomainEntry(email.split("@")[1] || "");
}

function coerceIsoDate(value) {
    const safe = normalizeIsoUtc(value);
    return safe || new Date().toISOString();
}

async function buildDiscoveryMessage(accessToken, messageId, inboxEmail) {
    const full = await fetchFullMessage(accessToken, messageId);
    const payload = full.payload || {};
    const bodyParts = collectBodyParts(payload);
    const plain = bodyParts.plain.join("\n").trim();
    const htmlText = stripHtml(bodyParts.html.join("\n"));

    const headerMessageId =
        String(findHeader(payload, "Message-Id") || "").replace(/^<|>$/g, "") ||
        full.id;

    const rawDateHeader = findHeader(payload, "Date");
    let messageDateIso = "";
    try {
        messageDateIso = full.internalDate
            ? new Date(Number(full.internalDate)).toISOString()
            : new Date(rawDateHeader).toISOString();
    } catch {
        messageDateIso = new Date().toISOString();
    }

    const attachmentMetas = collectAttachmentMetas(payload).slice(0, 4);

    return {
        gmailId: full.id,
        messageId: headerMessageId,
        emailPermalink: buildRetailEmailPermalink({
            gmailId: full.id,
            messageId: headerMessageId,
        }),
        sender: findHeader(payload, "From"),
        subject: findHeader(payload, "Subject"),
        rawDate: rawDateHeader,
        messageDate: messageDateIso,
        inboxEmail: inboxEmail || "",
        bodyPlain: plain || htmlText || "",
        snippet: full.snippet || "",
        attachmentNames: attachmentMetas.map((item) => String(item.filename || "").trim()).filter(Boolean),
        attachmentTypes: attachmentMetas.map((item) => String(item.contentType || "").trim().toLowerCase()).filter(Boolean),
    };
}

function countRegexMatches(text = "", regex) {
    const source = String(text || "");
    if (!source) return 0;
    const matches = source.match(regex);
    return Array.isArray(matches) ? matches.length : 0;
}

function dedupeTrimmed(values = []) {
    return Array.from(new Set((Array.isArray(values) ? values : [values]).map((value) => String(value || "").trim()).filter(Boolean)));
}

function buildSuggestionDocId(senderEmail = "") {
    const safe = normalizeEmailKey(senderEmail);
    if (!safe) {
        return `sender__${crypto.randomUUID().slice(0, 12)}`;
    }

    const base = safe
        .replace(/[^a-z0-9_.-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 180);

    return `sender__${base || crypto.createHash("sha1").update(safe).digest("hex").slice(0, 16)}`;
}

function inferSuggestedBusinessCategory(text = "") {
    return buildSuggestionClassification(text).suggestedCategory;
}

function buildSuggestionClassification(text = "", memory = {}, meta = {}) {
    return classifySenderText(text, memory, meta);
}

function scoreSenderSuggestion(message = {}, { memory = {} } = {}) {
    return scoreSenderSuggestionV2(message, { memory });
}

async function persistPendingReviewCandidates({
    retailOwnerId,
    onboarding = {},
    registryEntry = {},
    candidates = [],
}) {
    const db = getFirestore();
    const rows = [];

    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        if (!candidate?.senderEmail) continue;
        const message = candidate.message || {};
        rows.push({
            ...buildBiNormalizedEvent({
                tenantId: retailOwnerId,
                sourceKey: 'gmail',
                payload: {
                    sender: candidate.senderEmail,
                    senderDomain: candidate.senderDomain,
                    subject: message.subject,
                    snippet: message.snippet,
                    bodyPlain: message.bodyPlain,
                    suggestedCategory: candidate.suggestedCategory,
                    reasons: candidate.reasons,
                    confidence: candidate.confidence,
                    autoImportDisposition: candidate.autoImportDisposition,
                },
                onboarding,
                registryEntry,
                extraContext: {
                    sourceMeta: {
                        lane: 'retail_receipts',
                        senderEmail: candidate.senderEmail,
                        senderDomain: candidate.senderDomain,
                        suggestionHeadline: candidate.suggestionHeadline,
                        suggestionId: candidate.suggestionId,
                    },
                },
            }),
            reviewStatus: 'pending_review',
            sourceLane: 'retail_receipts',
            sourceHint: 'unknown_sender_auto_import_candidate',
            autoImportDisposition: candidate.autoImportDisposition,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    }

    for (const row of rows) {
        await tenantCollection(db, retailOwnerId, 'businessIntelligenceNormalized').add(row);
    }

    return rows.length;
}

function autoImportDispositionRank(value = "") {
    const key = String(value || "").trim().toLowerCase();
    if (key === "auto_import_now") return 2;
    if (key === "pending_review_import") return 1;
    return 0;
}

async function discoverRetailSenderSuggestions({
    retailOwnerId,
    accessToken,
    inboxEmail = "",
    allowlist = {},
    days = 30,
    window = null,
    skipProcessed = true,
    processedLabel = DEFAULT_RETAIL_IMPORTED_LABEL,
    lastSyncCursorIso = "",
    overlapMinutes = DEFAULT_SYNC_OVERLAP_MINUTES,
    ignoreCursor = false,
    matchedMessageIds = [],
    maxMessages = DEFAULT_SENDER_DISCOVERY_MAX_MESSAGES,
    rawFetchLimit = DEFAULT_SENDER_DISCOVERY_RAW_FETCH_LIMIT,
    categoryMemory = null,
}) {
    const queries = buildRetailGmailQueries({
        days,
        window,
        allowlist,
        anySender: true,
        skipProcessed,
        processedLabel,
        lastSyncCursorIso,
        overlapMinutes,
        ignoreCursor,
    });

    const ids = await listReceiptMessageIds(accessToken, {
        queries,
        maxMessages: normalizeIntInRange(maxMessages, DEFAULT_SENDER_DISCOVERY_MAX_MESSAGES, 1, 80),
        rawFetchLimit: normalizeIntInRange(rawFetchLimit, DEFAULT_SENDER_DISCOVERY_RAW_FETCH_LIMIT, 10, 200),
    });

    const memory = categoryMemory || await readBiCategoryMemory(getFirestore(), retailOwnerId).catch(() => ({}));
    const skipIds = new Set(uniqueNonEmpty(matchedMessageIds));
    const buckets = new Map();
    const autoImportNowCandidateIds = new Set();
    const pendingReviewCandidates = [];
    let inspected = 0;

    for (const id of ids) {
        if (skipIds.has(id)) continue;
        inspected += 1;

        const message = await buildDiscoveryMessage(accessToken, id, inboxEmail);
        const senderEmail = extractSenderEmail(message.sender);

        if (!senderEmail || matchesSenderAllowlist(senderEmail, allowlist)) {
            continue;
        }

        const scored = scoreSenderSuggestion(message, { memory });
        if (!scored.shouldSuggest) {
            continue;
        }

        const current = buckets.get(scored.senderEmail) || {
            suggestionId: buildSuggestionDocId(scored.senderEmail),
            senderEmail: scored.senderEmail,
            senderDomain: scored.senderDomain,
            senderDisplayName: scored.senderDisplayName,
            score: 0,
            confidence: "medium",
            reasons: [],
            suggestedKinds: [],
            suggestedCategory: scored.suggestedCategory,
            primaryKind: scored.primaryKind,
            likelyLabel: scored.likelyLabel,
            suggestionHeadline: scored.suggestionHeadline,
            suggestionCopy: scored.suggestionCopy,
            notificationTone: scored.notificationTone,
            recommendedApprovalMode: scored.recommendedApprovalMode,
            autoImportDisposition: scored.autoImportDisposition,
            autoImportLabel: scored.autoImportLabel,
            reviewStatus: scored.reviewStatus,
            sampleGmailId: "",
            sampleMessageId: "",
            samplePermalink: "",
            sampleSubject: "",
            sampleSnippet: "",
            sampleMessageDate: scored.sampleMessageDate,
            firstSeenAt: scored.sampleMessageDate,
            lastSeenAt: scored.sampleMessageDate,
            runSeenCount: 0,
            observedMessageIds: [],
        };

        current.score = Math.max(Number(current.score || 0), Number(scored.score || 0));
        current.confidence = current.score >= 7 ? "high" : current.score >= RETAIL_SUGGESTION_SCORE_THRESHOLD ? "medium" : "low";
        current.reasons = dedupeTrimmed([...(current.reasons || []), ...(scored.reasons || [])]);
        current.suggestedKinds = dedupeTrimmed([...(current.suggestedKinds || []), ...(scored.suggestedKinds || [])]);
        current.suggestedCategory = current.suggestedCategory || scored.suggestedCategory;
        current.primaryKind = current.primaryKind || scored.primaryKind;
        current.likelyLabel = current.likelyLabel || scored.likelyLabel;
        current.suggestionHeadline = current.suggestionHeadline || scored.suggestionHeadline;
        current.suggestionCopy = current.suggestionCopy || scored.suggestionCopy;
        current.notificationTone = current.notificationTone || scored.notificationTone;
        current.recommendedApprovalMode = current.recommendedApprovalMode || scored.recommendedApprovalMode;
        if (autoImportDispositionRank(scored.autoImportDisposition) >= autoImportDispositionRank(current.autoImportDisposition)) {
            current.autoImportDisposition = scored.autoImportDisposition;
            current.autoImportLabel = scored.autoImportLabel;
            current.reviewStatus = scored.reviewStatus;
        }
        current.runSeenCount = Number(current.runSeenCount || 0) + 1;
        current.observedMessageIds = dedupeTrimmed([...(current.observedMessageIds || []), message.gmailId]).slice(-20);

        const nextSeenAt = coerceIsoDate(message.messageDate || scored.sampleMessageDate);
        if (Date.parse(nextSeenAt) >= Date.parse(current.lastSeenAt || 0)) {
            current.lastSeenAt = nextSeenAt;
            current.sampleGmailId = String(message.gmailId || "").trim();
            current.sampleMessageId = String(message.messageId || "").trim();
            current.samplePermalink = String(message.emailPermalink || "").trim();
            current.sampleSubject = scored.sampleSubject;
            current.sampleSnippet = scored.sampleSnippet;
            current.sampleMessageDate = nextSeenAt;
        }

        if (!current.firstSeenAt || Date.parse(nextSeenAt) < Date.parse(current.firstSeenAt || nextSeenAt)) {
            current.firstSeenAt = nextSeenAt;
        }

        if (scored.autoImportDisposition === 'auto_import_now') {
            autoImportNowCandidateIds.add(id);
        } else if (scored.autoImportDisposition === 'pending_review_import') {
            pendingReviewCandidates.push({
                ...scored,
                suggestionId: current.suggestionId,
                message,
            });
        }

        buckets.set(scored.senderEmail, current);
    }

    const rows = Array.from(buckets.values());
    if (!rows.length) {
        return {
            discovered: 0,
            stored: 0,
            inspected,
            approvedAlready: 0,
            pending: 0,
            autoImportNowCandidateIds: [],
            pendingReviewCandidates: [],
        };
    }

    const existingSnaps = await Promise.all(
        rows.map((row) => retailSenderSuggestionRef(retailOwnerId, row.suggestionId).get().catch(() => null))
    );

    const batch = getFirestore().batch();
    let approvedAlready = 0;
    let pending = 0;

    rows.forEach((row, index) => {
        const existingData = existingSnaps[index]?.exists ? existingSnaps[index].data() || {} : {};
        const existingIds = dedupeTrimmed(existingData.observedMessageIds || []);
        const nextObservedIds = dedupeTrimmed([...existingIds, ...(row.observedMessageIds || [])]).slice(-20);
        const newMessageCount = row.observedMessageIds.filter((id) => !existingIds.includes(id)).length;
        const status = String(existingData.status || 'pending').trim().toLowerCase() || 'pending';

        if (status === 'approved') approvedAlready += 1;
        if (status === 'pending') pending += 1;

        batch.set(
            retailSenderSuggestionRef(retailOwnerId, row.suggestionId),
            {
                ...buildRetailOwnedPayload(retailOwnerId, {
                    suggestionId: row.suggestionId,
                    kind: 'retail_sender_suggestion',
                    sourceLane: 'retail_receipts',
                    status,
                    senderEmail: row.senderEmail,
                    senderDomain: row.senderDomain,
                    senderDisplayName: row.senderDisplayName,
                    score: Math.max(Number(existingData.score || 0), Number(row.score || 0)),
                    confidence: row.confidence,
                    reasons: row.reasons,
                    suggestedKinds: row.suggestedKinds,
                    suggestedCategory: row.suggestedCategory,
                    primaryKind: row.primaryKind,
                    likelyLabel: row.likelyLabel,
                    suggestionHeadline: row.suggestionHeadline,
                    suggestionCopy: row.suggestionCopy,
                    notificationTone: row.notificationTone,
                    recommendedApprovalMode: row.recommendedApprovalMode,
                    autoImportDisposition: row.autoImportDisposition,
                    autoImportLabel: row.autoImportLabel,
                    reviewStatus: row.reviewStatus,
                    firstSeenAt: existingData.firstSeenAt || row.firstSeenAt,
                    lastSeenAt: row.lastSeenAt,
                    seenCount: Number(existingData.seenCount || 0) + Math.max(1, newMessageCount || row.runSeenCount || 1),
                    observedMessageIds: nextObservedIds,
                    sampleGmailId: row.sampleGmailId,
                    sampleMessageId: row.sampleMessageId,
                    samplePermalink: row.samplePermalink,
                    sampleSubject: row.sampleSubject,
                    sampleSnippet: row.sampleSnippet,
                    sampleMessageDate: row.sampleMessageDate,
                    sourceLastRunAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                }),
                createdAt: existingData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );
    });

    await batch.commit();

    return {
        discovered: rows.length,
        stored: rows.length,
        inspected,
        approvedAlready,
        pending,
        autoImportNowCandidateIds: Array.from(autoImportNowCandidateIds),
        pendingReviewCandidates,
        rows: rows.map((row) => ({
            suggestionId: row.suggestionId,
            senderEmail: row.senderEmail,
            suggestedCategory: row.suggestedCategory,
            primaryKind: row.primaryKind,
            likelyLabel: row.likelyLabel,
            suggestionHeadline: row.suggestionHeadline,
            suggestionCopy: row.suggestionCopy,
            notificationTone: row.notificationTone,
            recommendedApprovalMode: row.recommendedApprovalMode,
            autoImportDisposition: row.autoImportDisposition,
            autoImportLabel: row.autoImportLabel,
            score: row.score,
            confidence: row.confidence,
        })),
    };
}

function estimateJsonBytes(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value || {}), "utf8");
    } catch {
        return 0;
    }
}

function trimText(value, max = 12000) {
    const s = String(value || "");
    if (s.length <= max) return s;
    return s.slice(0, max);
}

function sanitizeAttachmentForAppsScript(att = {}) {
    const name = String(att.name || "").trim();
    const contentType = String(att.contentType || "").trim();
    const base64 = String(att.base64 || "").trim();

    // Giant attachments Apps Script web app POST me fragile hote hain.
    // Safe ceiling rakho.
    if (!base64 || base64.length > 350000) return null;

    return {
        name,
        contentType,
        base64,
    };
}

function buildAppsScriptImportMessage(message = {}, { includeAttachments = true } = {}) {
    const next = {
        gmailId: String(message.gmailId || "").trim(),
        messageId: String(message.messageId || "").trim(),
        emailPermalink: String(
            message.emailPermalink ||
            buildRetailEmailPermalink({
                gmailId: message.gmailId,
                messageId: message.messageId,
            }) ||
            ""
        ).trim(),
        sender: String(message.sender || "").trim(),
        subject: trimText(message.subject || "", 500),
        rawDate: String(message.rawDate || "").trim(),
        messageDate: String(message.messageDate || "").trim(),
        inboxEmail: String(message.inboxEmail || "").trim(),
        bodyPlain: trimText(message.bodyPlain || "", 12000),
        snippet: trimText(message.snippet || "", 1200),

        // IMPORTANT: preserve manual PDF metadata for Apps Script
        source: String(message.source || "gmail").trim().toLowerCase(),
        receiptUrl: String(message.receiptUrl || "").trim(),

        attachments: [],
    };

    if (includeAttachments) {
        next.attachments = (Array.isArray(message.attachments) ? message.attachments : [])
            .slice(0, 1)
            .map(sanitizeAttachmentForAppsScript)
            .filter(Boolean);
    }

    return next;
}

function chunkImportMessages(messages = [], { maxChunkCount = 4, maxChunkBytes = 900000 } = {}) {
    const chunks = [];
    let current = [];
    let currentBytes = 0;

    for (const raw of messages) {
        const msg = buildAppsScriptImportMessage(raw, { includeAttachments: true });
        const msgBytes = estimateJsonBytes(msg);

        const wouldOverflow =
            current.length > 0 &&
            (current.length >= maxChunkCount || currentBytes + msgBytes > maxChunkBytes);

        if (wouldOverflow) {
            chunks.push(current);
            current = [];
            currentBytes = 0;
        }

        current.push(msg);
        currentBytes += msgBytes;
    }

    if (current.length) chunks.push(current);

    return chunks;
}

function emptyGasSummary() {
    return {
        ok: true,
        processed: 0,
        rowsPrepared: 0,
        writeCount: 0,
        parseFailed: 0,
        skipped: 0,
        writeErrors: 0,
        messageErrors: 0,
        reason: "",
        sampleErrors: [],
        metrics: {},
        chunkCount: 0,
        fallbackChunkCount: 0,
    };
}

function mergeGasMetrics(totalMetrics = {}, partMetrics = {}) {
    const merged = { ...(totalMetrics || {}) };

    Object.entries(partMetrics || {}).forEach(([key, value]) => {
        if (typeof value === "number") {
            merged[key] = Number(merged[key] || 0) + Number(value || 0);
            return;
        }

        if (Array.isArray(value)) {
            merged[key] = [
                ...(Array.isArray(merged[key]) ? merged[key] : []),
                ...value,
            ].slice(0, 10);
            return;
        }

        if (value && typeof value === "object") {
            merged[key] = {
                ...(merged[key] && typeof merged[key] === "object" ? merged[key] : {}),
                ...value,
            };
            return;
        }

        if (!merged[key]) {
            merged[key] = value;
        }
    });

    return merged;
}

function mergeGasSummary(total, part) {
    const safePart = part || {};

    const totalSampleErrors = Array.isArray(total.sampleErrors) ? total.sampleErrors : [];
    const partSampleErrors = Array.isArray(safePart.sampleErrors) ? safePart.sampleErrors : [];

    return {
        ok: total.ok && safePart.ok !== false,
        processed: (total.processed || 0) + Number(safePart.processed || 0),
        rowsPrepared: (total.rowsPrepared || 0) + Number(safePart.rowsPrepared || 0),
        writeCount: (total.writeCount || 0) + Number(safePart.writeCount || 0),
        parseFailed: (total.parseFailed || 0) + Number(safePart.parseFailed || 0),
        skipped: (total.skipped || 0) + Number(safePart.skipped || 0),
        writeErrors: (total.writeErrors || 0) + Number(safePart.writeErrors || 0),
        messageErrors: (total.messageErrors || 0) + Number(safePart.messageErrors || 0),
        reason:
            String(total.reason || "").trim() ||
            String(safePart.reason || "").trim() ||
            "",
        sampleErrors: [...totalSampleErrors, ...partSampleErrors].slice(0, 10),
        metrics: mergeGasMetrics(total.metrics || {}, safePart.metrics || {}),
        chunkCount: (total.chunkCount || 0) + 1,
        fallbackChunkCount: total.fallbackChunkCount || 0,
    };
}

async function ingestMessagesViaAppsScript({
    retailOwnerId,
    actorUid,
    inboxEmail,
    connectionEmail,
    lane,
    debug,
    dry,
    messages,
}) {
    const chunks = chunkImportMessages(messages, {
        maxChunkCount: 4,
        maxChunkBytes: 900000,
    });

    let summary = emptyGasSummary();

    for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];

        try {
            const part = await postBatchToAppsScript({
                action: "ingestBatch",
                secret: RETAIL_GMAIL_WEBAPP_SECRET,
                uid: String(actorUid || retailOwnerId || "").trim(),
                workspaceId: retailOwnerId,
                retailOwnerId,
                tenantId: retailOwnerId,
                inboxEmail,
                connectionEmail,
                lane,
                debug,
                dry,
                messages: chunk,
            });

            summary = mergeGasSummary(summary, part);
            continue;
        } catch (err) {
            console.warn(
                `[retail sync] chunk ${i + 1}/${chunks.length} failed with attachments, retrying body-only`,
                err?.message || err
            );
        }

        // fallback: same chunk without attachments
        const fallbackChunk = chunk.map((msg) =>
            buildAppsScriptImportMessage(msg, { includeAttachments: false })
        );

        try {
            const fallbackPart = await postBatchToAppsScript({
                action: "ingestBatch",
                secret: RETAIL_GMAIL_WEBAPP_SECRET,
                uid: String(actorUid || retailOwnerId || "").trim(),
                workspaceId: retailOwnerId,
                retailOwnerId,
                tenantId: retailOwnerId,
                inboxEmail,
                connectionEmail,
                lane,
                debug,
                dry,
                messages: fallbackChunk,
            });

            summary = mergeGasSummary(summary, fallbackPart);
            summary.fallbackChunkCount = Number(summary.fallbackChunkCount || 0) + 1;
        } catch (fallbackErr) {
            throw new Error(
                `Apps Script ingest failed on chunk ${i + 1}/${chunks.length}: ${fallbackErr?.message || fallbackErr
                }`
            );
        }
    }

    return summary;
}

async function pingAppsScript() {
    const pingUrl = `${RETAIL_GMAIL_WEBAPP_URL}${RETAIL_GMAIL_WEBAPP_URL.includes("?") ? "&" : "?"}mode=ping`;

    const res = await nodeFetch(pingUrl, {
        method: "GET",
        redirect: "follow",
    });

    const text = await res.text();
    let json = {};

    try {
        json = JSON.parse(text || "{}");
    } catch {
        throw new Error(
            `Apps Script ping returned non-JSON (HTTP ${res.status}) from ${pingUrl}: ${String(text || "").slice(0, 300)}`
        );
    }

    if (!res.ok || json.ok === false) {
        throw new Error(
            json.error || `Apps Script ping failed (${res.status}) at ${pingUrl}`
        );
    }

    return {
        ok: true,
        status: res.status,
        ...json,
    };
}

async function postBatchToAppsScript(payload) {
    const res = await nodeFetch(RETAIL_GMAIL_WEBAPP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    const text = await res.text();
    let json = {};

    try {
        json = JSON.parse(text || "{}");
    } catch {
        const shortBody = String(text || "").slice(0, 400);
        throw new Error(
            `Apps Script non-JSON response (HTTP ${res.status}) from ${RETAIL_GMAIL_WEBAPP_URL}: ${shortBody}`
        );
    }

    if (!res.ok || json.ok === false) {
        throw new Error(
            json.error || `Apps Script POST failed (${res.status})`
        );
    }

    return json;
}

router.get("/status", ...retailTenantMemberMiddleware, async (req, res) => {
    try {
        const retailOwnerId = getRetailTenantIdFromReq(req);

        const [connSnap, settingsSnap] = await Promise.all([
            retailConnectionRef(retailOwnerId).get(),
            retailSettingsRef(retailOwnerId).get(),
        ]);

        const conn = connSnap.exists ? connSnap.data() || {} : {};
        const settings = settingsSnap.exists ? settingsSnap.data() || {} : {};
        const setupState = buildRetailSetupState(settings, settingsSnap.exists);

        return res.json({
            ok: true,
            connected: Boolean(conn.refreshTokenEncrypted?.data),
            retailOwnerId,

            connection: {
                gmailEmail: conn.gmailEmail || conn.email || "",
                connectedAt: conn.connectedAt || null,
                scopes: Array.isArray(conn.scopes) ? conn.scopes : [],
                watchStatus: conn.watchStatus || null,
                lastSyncAt: conn.lastSyncAt || null,
                lastSyncSummary: conn.lastSyncSummary || null,
                historyId: String(conn.historyId || "").trim(),
                lastHistoryId: String(conn.lastHistoryId || conn.historyId || "").trim(),
                lastSyncCursorIso: normalizeIsoUtc(conn.lastSyncCursorIso || ""),
                syncOverlapMinutes: normalizeIntInRange(
                    conn.syncOverlapMinutes,
                    DEFAULT_SYNC_OVERLAP_MINUTES,
                    0,
                    1440
                ),
            },

            settings: {
                configured: settingsSnap.exists,
                allowlist: normalizeAllowlist(settings.allowlist || {}),
                allowlistInput: String(settings.allowlistInput || ""),
                lane: String(settings.lane || "").trim(),
                yearScope: normalizeRetailYearScope(
                    settings.yearScope,
                    inferRetailYearScopeFromDays(settings.daysDefault)
                ),
                daysDefault: normalizeIntInRange(settings.daysDefault, 30, 1, MAX_RETAIL_SYNC_DAYS),
                maxMessagesDefault: normalizeIntInRange(
                    settings.maxMessagesDefault,
                    35,
                    1,
                    50
                ),
                onboardingCompleted: Boolean(settings.onboardingCompleted),
                skipProcessed: settings.skipProcessed !== false,
                processedLabel: normalizeGmailLabelToken(
                    settings.processedLabel || DEFAULT_RETAIL_IMPORTED_LABEL
                ),
                receiptsLabel: String(
                    settings.receiptsLabel || DEFAULT_RETAIL_RECEIPTS_LABEL
                ).trim(),
                lastHistoryId: String(settings.lastHistoryId || "").trim(),
                lastSyncCursorIso: normalizeIsoUtc(settings.lastSyncCursorIso || ""),
                syncOverlapMinutes: normalizeIntInRange(
                    settings.syncOverlapMinutes,
                    DEFAULT_SYNC_OVERLAP_MINUTES,
                    0,
                    1440
                ),
                autoScheduler: normalizeAutoSchedulerSettings(
                    settings.autoScheduler || {},
                    settings.autoScheduler || {}
                ),
                lastSyncPrefs: settings.lastSyncPrefs || null,
                setupState,
            },

            email: conn.gmailEmail || conn.email || "",
            connectedAt: conn.connectedAt || null,
            lastSyncAt: conn.lastSyncAt || null,
            lastSyncSummary: conn.lastSyncSummary || null,
        });
    } catch (err) {
        console.error("receipts/google/status error", err);
        return res.status(500).json({ ok: false, error: "Failed to load Gmail status" });
    }
});

router.get("/settings", ...retailTenantMemberMiddleware, async (req, res) => {
    try {
        const retailOwnerId = getRetailTenantIdFromReq(req);
        const savedSnap = await retailSettingsRef(retailOwnerId).get();
        const saved = savedSnap.exists ? savedSnap.data() || {} : {};
        const setupState = buildRetailSetupState(saved, savedSnap.exists);

        return res.json({
            ok: true,
            retailOwnerId,
            settings: {
                configured: savedSnap.exists,
                allowlist: normalizeAllowlist(saved.allowlist || {}),
                allowlistInput: String(saved.allowlistInput || ""),
                lane: String(saved.lane || "").trim(),
                yearScope: normalizeRetailYearScope(
                    saved.yearScope,
                    inferRetailYearScopeFromDays(saved.daysDefault)
                ),
                daysDefault: normalizeIntInRange(saved.daysDefault, 30, 1, MAX_RETAIL_SYNC_DAYS),
                maxMessagesDefault: normalizeIntInRange(
                    saved.maxMessagesDefault,
                    35,
                    1,
                    50
                ),
                onboardingCompleted: Boolean(saved.onboardingCompleted),
                skipProcessed: saved.skipProcessed !== false,
                processedLabel:
                    normalizeGmailLabelToken(
                        saved.processedLabel || DEFAULT_RETAIL_IMPORTED_LABEL
                    ) || DEFAULT_RETAIL_IMPORTED_LABEL,
                receiptsLabel:
                    String(saved.receiptsLabel || DEFAULT_RETAIL_RECEIPTS_LABEL).trim() ||
                    DEFAULT_RETAIL_RECEIPTS_LABEL,
                lastHistoryId: String(saved.lastHistoryId || "").trim(),
                lastSyncCursorIso: normalizeIsoUtc(saved.lastSyncCursorIso || ""),
                syncOverlapMinutes: normalizeIntInRange(
                    saved.syncOverlapMinutes,
                    DEFAULT_SYNC_OVERLAP_MINUTES,
                    0,
                    1440
                ),
                autoScheduler: normalizeAutoSchedulerSettings(
                    saved.autoScheduler || {},
                    saved.autoScheduler || {}
                ),
                lastSyncPrefs: saved.lastSyncPrefs || null,
                setupState,
            },
        });
    } catch (err) {
        console.error("receipts/google/settings get error", err);
        return res.status(500).json({
            ok: false,
            error: err.message || "Failed to load retail Gmail settings",
        });
    }
});

router.post("/settings", ...retailTenantManagerMiddleware, async (req, res) => {
    try {
        const retailOwnerId = getRetailTenantIdFromReq(req);

        if (!retailOwnerId) {
            return res.status(401).json({ ok: false, error: "Missing Firebase user" });
        }

        const savedSettingsSnap = await retailSettingsRef(retailOwnerId).get().catch(() => null);
        const savedSettingsDoc = savedSettingsSnap?.exists ? savedSettingsSnap.data() || {} : {};

        const patch = {};

        if (hasOwn(req.body, "lane")) {
            patch.lane = String(req.body?.lane || "").trim();
        }

        if (hasOwn(req.body, "daysDefault")) {
            patch.daysDefault = normalizeIntInRange(req.body?.daysDefault, 30, 1, MAX_RETAIL_SYNC_DAYS);
        }

        if (hasOwn(req.body, "yearScope")) {
            patch.yearScope = normalizeRetailYearScope(
                req.body?.yearScope,
                inferRetailYearScopeFromDays(req.body?.daysDefault || savedSettingsDoc.daysDefault)
            );
        }

        if (hasOwn(req.body, "maxMessagesDefault")) {
            patch.maxMessagesDefault = normalizeIntInRange(
                req.body?.maxMessagesDefault,
                20,
                1,
                50
            );
        }

        if (hasOwn(req.body, "allowlist")) {
            patch.allowlist = normalizeAllowlist(req.body?.allowlist || {});
        }

        if (hasOwn(req.body, "allowlistInput")) {
            patch.allowlistInput = String(req.body?.allowlistInput || "");
        }

        if (hasOwn(req.body, "onboardingCompleted")) {
            patch.onboardingCompleted = !!req.body?.onboardingCompleted;
        } else if (hasOwn(req.body, "completed")) {
            patch.onboardingCompleted = !!req.body?.completed;
        }

        if (hasOwn(req.body, "skipProcessed")) {
            patch.skipProcessed = !!req.body?.skipProcessed;
        }

        if (hasOwn(req.body, "processedLabel")) {
            patch.processedLabel =
                normalizeGmailLabelToken(req.body?.processedLabel) ||
                DEFAULT_RETAIL_IMPORTED_LABEL;
        }

        if (hasOwn(req.body, "receiptsLabel")) {
            patch.receiptsLabel =
                String(req.body?.receiptsLabel || "").trim() ||
                DEFAULT_RETAIL_RECEIPTS_LABEL;
        }

        if (hasOwn(req.body, "syncOverlapMinutes")) {
            patch.syncOverlapMinutes = normalizeIntInRange(
                req.body?.syncOverlapMinutes,
                DEFAULT_SYNC_OVERLAP_MINUTES,
                0,
                1440
            );
        }

        const shouldResetSyncCursor = Boolean(
            hasOwn(req.body, "resetSyncCursor") && req.body?.resetSyncCursor
        );

        if (shouldResetSyncCursor) {
            patch.lastSyncCursorIso = "";
            patch.lastHistoryId = "";
        }

        if (hasOwn(req.body, "autoScheduler")) {
            patch.autoScheduler = normalizeAutoSchedulerSettings(
                req.body?.autoScheduler || {},
                savedSettingsDoc.autoScheduler || {}
            );
        }

        if (!Object.keys(patch).length) {
            return res.status(400).json({
                ok: false,
                error: "No settings fields provided",
            });
        }

        patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();

        const writes = [
            retailSettingsRef(retailOwnerId).set(
                retailValidatedPayload("settings", retailOwnerId, patch),
                { merge: true }
            ),
        ];

        if (shouldResetSyncCursor) {
            writes.push(
                retailConnectionRef(retailOwnerId).set(
                    retailValidatedPayload("connection", retailOwnerId, {
                        lastSyncCursorIso: "",
                        lastHistoryId: "",
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    }),
                    { merge: true }
                )
            );
        }

        await Promise.all(writes);

        const savedSnap = await retailSettingsRef(retailOwnerId).get();
        const saved = savedSnap.exists ? savedSnap.data() || {} : {};
        const setupState = buildRetailSetupState(saved, savedSnap.exists);

        return res.json({
            ok: true,
            retailOwnerId,

            settings: {
                configured: savedSnap.exists,
                allowlist: normalizeAllowlist(saved.allowlist || {}),
                allowlistInput: String(saved.allowlistInput || ""),
                lane: String(saved.lane || "").trim(),
                yearScope: normalizeRetailYearScope(
                    saved.yearScope,
                    inferRetailYearScopeFromDays(saved.daysDefault)
                ),
                daysDefault: normalizeIntInRange(saved.daysDefault, 30, 1, MAX_RETAIL_SYNC_DAYS),
                maxMessagesDefault: normalizeIntInRange(
                    saved.maxMessagesDefault,
                    35,
                    1,
                    50
                ),
                onboardingCompleted: Boolean(saved.onboardingCompleted),
                skipProcessed: saved.skipProcessed !== false,
                processedLabel:
                    normalizeGmailLabelToken(
                        saved.processedLabel || DEFAULT_RETAIL_IMPORTED_LABEL
                    ) || DEFAULT_RETAIL_IMPORTED_LABEL,
                receiptsLabel:
                    String(saved.receiptsLabel || DEFAULT_RETAIL_RECEIPTS_LABEL).trim() ||
                    DEFAULT_RETAIL_RECEIPTS_LABEL,
                lastHistoryId: String(saved.lastHistoryId || "").trim(),
                lastSyncCursorIso: normalizeIsoUtc(saved.lastSyncCursorIso || ""),
                syncOverlapMinutes: normalizeIntInRange(
                    saved.syncOverlapMinutes,
                    DEFAULT_SYNC_OVERLAP_MINUTES,
                    0,
                    1440
                ),
                autoScheduler: normalizeAutoSchedulerSettings(
                    saved.autoScheduler || {},
                    saved.autoScheduler || {}
                ),
                lastSyncPrefs: saved.lastSyncPrefs || null,
                setupState,
            },
        });
    } catch (err) {
        console.error("receipts/google/settings error", err);
        return res.status(500).json({
            ok: false,
            error: err.message || "Failed to save retail Gmail settings",
        });
    }
});

router.get("/connect", ...retailTenantManagerMiddleware, async (req, res) => {
    try {
        ensureGoogleConfig();

        const retailOwnerId = getRetailTenantIdFromReq(req);
        if (!retailOwnerId) {
            return res.status(401).json({ ok: false, error: "Missing Firebase user" });
        }

        const state = crypto.randomUUID();
        const actorUid = getRetailActorUidFromReq(req);

        const requestedReturnTo = normalizeRetailSuccessUrl(
            req.query?.returnTo || req.query?.successUrl || ""
        );

        await oauthStateRef(state).set({
            tenantId: retailOwnerId,
            actorUid,
            returnTo: requestedReturnTo || "",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return res.json({
            ok: true,
            authUrl: buildGoogleAuthUrl(state),
        });
    } catch (err) {
        console.error("receipts/google/connect error", err);
        return res.status(500).json({ ok: false, error: err.message || "Connect failed" });
    }
});

router.get("/callback", async (req, res) => {
    try {
        ensureGoogleConfig();

        const code = String(req.query.code || "");
        const state = String(req.query.state || "");

        if (!code || !state) {
            return res.status(400).send("Missing code/state");
        }

        const stateSnap = await oauthStateRef(state).get();
        if (!stateSnap.exists) {
            return res.status(400).send("OAuth state expired or invalid");
        }

        const stateData = stateSnap.data() || {};
        const retailOwnerId = String(
            stateData.tenantId || stateData.retailOwnerId || stateData.workspaceId || ""
        ).trim();
        const actorUid = String(stateData.actorUid || "").trim();

        const tokenJson = await exchangeCodeForTokens(code);
        const gmailProfile = await fetchGoogleProfile(tokenJson.access_token);

        const existingConnSnap = await retailConnectionRef(retailOwnerId).get();
        const existingConn = existingConnSnap.exists ? existingConnSnap.data() || {} : {};

        await retailConnectionRef(retailOwnerId).set(
            retailValidatedPayload("connection", retailOwnerId, {
                gmailEmail: gmailProfile.emailAddress || "",
                email: gmailProfile.emailAddress || "",
                historyId: gmailProfile.historyId || "",
                lastHistoryId: gmailProfile.historyId || existingConn.lastHistoryId || "",
                lastSyncCursorIso: existingConn.lastSyncCursorIso || "",
                syncOverlapMinutes: normalizeIntInRange(
                    existingConn.syncOverlapMinutes,
                    DEFAULT_SYNC_OVERLAP_MINUTES,
                    0,
                    1440
                ),
                refreshTokenEncrypted: tokenJson.refresh_token
                    ? encryptText(tokenJson.refresh_token)
                    : existingConn.refreshTokenEncrypted || null,
                accessTokenEncrypted: tokenJson.access_token
                    ? encryptText(tokenJson.access_token)
                    : existingConn.accessTokenEncrypted || null,
                scopes: normalizeScopeList(tokenJson.scope || existingConn.scopes || []),
                watchStatus: buildManualWatchStatus({
                    state: "connected",
                }),
                connectedByUid: actorUid || existingConn.connectedByUid || "",
                connectedAt:
                    existingConn.connectedAt || admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }),
            { merge: true }
        );

        const successUrl =
            normalizeRetailSuccessUrl(stateData.returnTo || "") ||
            normalizeRetailSuccessUrl(RETAIL_GMAIL_SUCCESS_URL) ||
            "http://localhost:5173/retail-receipts/setup?gmail=connected";

        await oauthStateRef(state).delete().catch(() => { });

        return res
            .status(200)
            .type("html")
            .send(`
<!doctype html>
<html>
  <body style="font-family:system-ui;padding:24px">
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage(
            {
              type: "retail-gmail-connected",
              tenantId: ${JSON.stringify(retailOwnerId)},
              successUrl: ${JSON.stringify(successUrl)}
            },
            "*"
          );
          window.close();
        } else {
          window.location.replace(${JSON.stringify(successUrl)});
        }
      } catch (e) {
        window.location.replace(${JSON.stringify(successUrl)});
      }
    </script>
    Gmail connected. You can close this window.
  </body>
</html>`);
    } catch (err) {
        console.error("receipts/google/callback error", err);
        return res.status(500).send(`Connect failed: ${err.message || err}`);
    }
});

router.post("/disconnect", ...retailTenantManagerMiddleware, async (req, res) => {
    try {
        const retailOwnerId = getRetailTenantIdFromReq(req);
        await retailConnectionRef(retailOwnerId).delete().catch(() => { });
        return res.json({ ok: true });
    } catch (err) {
        console.error("receipts/google/disconnect error", err);
        return res.status(500).json({ ok: false, error: "Disconnect failed" });
    }
});

router.get("/cutover-status", ...retailTenantManagerMiddleware, async (req, res) => {
    try {
        const retailOwnerId = getRetailTenantIdFromReq(req);
        const settingsSnap = await retailSettingsRef(retailOwnerId).get().catch(() => null);
        const settings = settingsSnap?.exists ? settingsSnap.data() || {} : {};

        return res.json({
            ok: true,
            cutover: settings.legacyCutover || null,
        });
    } catch (err) {
        console.error("receipts/google/cutover-status error", err);
        return res.status(500).json({
            ok: false,
            error: err.message || "Retail cutover status lookup failed",
        });
    }
});

router.post("/cutover-legacy", ...retailTenantManagerMiddleware, async (req, res) => {
    try {
        const retailOwnerId = getRetailTenantIdFromReq(req);
        const actorUid = getRetailActorUidFromReq(req);
        const force = !!req.body?.force;
        const inboxEmail = String(req.body?.inboxEmail || "").trim();
        const connectionEmail = String(req.body?.connectionEmail || "").trim();

        const result = await runRetailLegacyCutover({
            retailOwnerId,
            actorUid,
            force,
            inboxEmail,
            connectionEmail,
        });

        return res.json({
            ok: true,
            alreadyCompleted: !!result.alreadyCompleted,
            cutover: result.cutover,
        });
    } catch (err) {
        console.error("receipts/google/cutover-legacy error", err);
        return res.status(500).json({
            ok: false,
            error: err.message || "Retail legacy cutover failed",
        });
    }
});

router.post("/migrate-legacy", ...retailTenantManagerMiddleware, async (req, res) => {
    try {
        const retailOwnerId = getRetailTenantIdFromReq(req);
        const actorUid = getRetailActorUidFromReq(req);
        const force = !!req.body?.force;
        const inboxEmail = String(req.body?.inboxEmail || "").trim();
        const connectionEmail = String(req.body?.connectionEmail || "").trim();

        const result = await runRetailLegacyCutover({
            retailOwnerId,
            actorUid,
            force,
            inboxEmail,
            connectionEmail,
        });

        return res.json({
            ok: true,
            alreadyCompleted: !!result.alreadyCompleted,
            cutover: result.cutover,
            legacyAlias: true,
        });
    } catch (err) {
        console.error("receipts/google/migrate-legacy error", err);
        return res.status(500).json({
            ok: false,
            error: err.message || "Legacy retail migration failed",
        });
    }
});

async function runRetailGmailSyncForOwner({
    retailOwnerId,
    actorUid = "",
    body = {},
    trigger = "manual",
} = {}) {
    ensureGoogleConfig();

    const syncTrigger = String(trigger || "manual").trim() || "manual";
    const debug = !!body?.debug;
    const dry = !!body?.dry;
    const ignoreCursor = !!body?.ignoreCursor;
    const syncStartedAtIso = new Date().toISOString();

    const db = getFirestore();

    const [settingsSnap, connSnap, receiptProbeSnap] = await Promise.all([
        retailSettingsRef(retailOwnerId).get(),
        retailConnectionRef(retailOwnerId).get(),
        retailReceiptsCollection(db, retailOwnerId)
            .limit(1)
            .get()
            .catch(() => ({ empty: true })),
    ]);

    const savedSettings = settingsSnap.exists ? settingsSnap.data() || {} : {};

    if (!connSnap.exists) {
        const err = new Error("Gmail is not connected");
        err.statusCode = 404;
        throw err;
    }

    const conn = connSnap.data() || {};
    const syncActorUid = String(actorUid || conn.connectedByUid || "").trim();

    const hasExistingReceiptData =
        receiptProbeSnap && typeof receiptProbeSnap.empty === "boolean"
            ? !receiptProbeSnap.empty
            : false;

    const hasRequestedBackfillWindow =
        hasOwn(body, "days") ||
        hasOwn(body, "window") ||
        hasOwn(body, "minDaysAgo") ||
        hasOwn(body, "maxDaysAgo");

    const forceInitialManualBackfill =
        syncTrigger === "manual" &&
        !ignoreCursor &&
        hasRequestedBackfillWindow &&
        !hasExistingReceiptData;

    const effectiveIgnoreCursor = ignoreCursor || forceInitialManualBackfill;

    const savedLane = String(savedSettings.lane || "").trim();
    const savedDaysDefault = normalizeIntInRange(
        savedSettings.daysDefault,
        30,
        1,
        MAX_RETAIL_SYNC_DAYS
    );
    const savedMaxMessagesDefault = Math.max(
        35,
        normalizeIntInRange(savedSettings.maxMessagesDefault, 35, 1, 50)
    );
    const savedSkipProcessed = savedSettings.skipProcessed !== false;
    const savedProcessedLabel =
        normalizeGmailLabelToken(
            savedSettings.processedLabel || DEFAULT_RETAIL_IMPORTED_LABEL
        ) || DEFAULT_RETAIL_IMPORTED_LABEL;
    const savedReceiptsLabel =
        String(savedSettings.receiptsLabel || DEFAULT_RETAIL_RECEIPTS_LABEL).trim() ||
        DEFAULT_RETAIL_RECEIPTS_LABEL;
    const savedSyncWindow = normalizeSyncWindow(savedSettings.syncWindow || null);
    const savedLastHistoryId = String(
        conn.lastHistoryId || savedSettings.lastHistoryId || conn.historyId || ""
    ).trim();
    const savedLastSyncCursorIso = normalizeIsoUtc(
        conn.lastSyncCursorIso || savedSettings.lastSyncCursorIso || ""
    );
    const savedSyncOverlapMinutes = hasOwn(savedSettings, "syncOverlapMinutes")
        ? normalizeIntInRange(
            savedSettings.syncOverlapMinutes,
            DEFAULT_SYNC_OVERLAP_MINUTES,
            0,
            1440
        )
        : normalizeIntInRange(
            conn.syncOverlapMinutes,
            DEFAULT_SYNC_OVERLAP_MINUTES,
            0,
            1440
        );

    const days = hasOwn(body, "days")
        ? normalizeIntInRange(body?.days, savedDaysDefault, 1, MAX_RETAIL_SYNC_DAYS)
        : savedDaysDefault;

    const yearScope = normalizeRetailYearScope(
        body?.yearScope,
        normalizeRetailYearScope(
            savedSettings.yearScope,
            inferRetailYearScopeFromDays(days)
        )
    );

    const maxMessages = hasOwn(body, "maxMessages")
        ? normalizeIntInRange(body?.maxMessages, savedMaxMessagesDefault, 1, 50)
        : savedMaxMessagesDefault;

    const lane = savedLane;
    const allowlist = await loadRetailAllowlistFromDb(retailOwnerId);

    const reqWindow = hasOwn(body, "window")
        ? body?.window
        : hasOwn(body, "minDaysAgo") || hasOwn(body, "maxDaysAgo")
            ? {
                minDaysAgo: body?.minDaysAgo,
                maxDaysAgo: body?.maxDaysAgo,
            }
            : savedSyncWindow;

    const window = normalizeSyncWindow(reqWindow);
    const anySender = !!body?.anySender;

    const skipProcessed = hasOwn(body, "skipProcessed")
        ? !!body?.skipProcessed
        : savedSkipProcessed;

    const processedLabel = hasOwn(body, "processedLabel")
        ? normalizeGmailLabelToken(body?.processedLabel) || savedProcessedLabel
        : savedProcessedLabel;

    const receiptsLabel = hasOwn(body, "receiptsLabel")
        ? String(body?.receiptsLabel || "").trim() || savedReceiptsLabel
        : savedReceiptsLabel;

    const allowChunkSize = hasOwn(body, "allowChunkSize")
        ? normalizeIntInRange(
            body?.allowChunkSize,
            DEFAULT_ALLOWLIST_QUERY_CHUNK_SIZE,
            10,
            50
        )
        : DEFAULT_ALLOWLIST_QUERY_CHUNK_SIZE;

    const syncOverlapMinutes = hasOwn(body, "syncOverlapMinutes")
        ? normalizeIntInRange(
            body?.syncOverlapMinutes,
            savedSyncOverlapMinutes,
            0,
            1440
        )
        : savedSyncOverlapMinutes;

    const refreshToken = decryptText(conn.refreshTokenEncrypted || {});
    if (!refreshToken) {
        const err = new Error("Missing refresh token");
        err.statusCode = 400;
        throw err;
    }

    const accessToken = await refreshAccessToken(refreshToken);
    const gmailProfile = await fetchGoogleProfile(accessToken);
    const inboxEmail = gmailProfile.emailAddress || conn.email || "";
    const connectionEmail = String(
        conn.gmailEmail || conn.email || inboxEmail || ""
    )
        .trim()
        .toLowerCase();

    const timePlan = resolveSyncTimePlan({
        days,
        window,
        lastSyncCursorIso: savedLastSyncCursorIso,
        overlapMinutes: syncOverlapMinutes,
        ignoreCursor: effectiveIgnoreCursor,
    });

    const queries = buildRetailGmailQueries({
        days,
        window,
        allowlist,
        anySender,
        skipProcessed,
        processedLabel,
        queryChunkSize: allowChunkSize,
        lastSyncCursorIso: savedLastSyncCursorIso,
        overlapMinutes: syncOverlapMinutes,
        ignoreCursor: effectiveIgnoreCursor,
    });

    const rawFetchLimit = hasOwn(body, "rawFetchLimit")
        ? normalizeIntInRange(body?.rawFetchLimit, maxMessages * 8, maxMessages, 500)
        : Math.min(500, Math.max(200, maxMessages * 8));

    const ids = await listReceiptMessageIds(accessToken, {
        queries,
        maxMessages,
        rawFetchLimit,
    });

    let appsScriptPing = { ok: false, skipped: false, warning: "" };

    try {
        appsScriptPing = await pingAppsScript();
    } catch (err) {
        const strictPing = String(process.env.RETAIL_GMAIL_STRICT_WEBAPP_PING || "false")
            .trim()
            .toLowerCase() === "true";

        if (strictPing) {
            throw err;
        }

        console.warn("[retail sync] Apps Script ping skipped:", err?.message || err);
        appsScriptPing = {
            ok: false,
            skipped: true,
            warning: err?.message || "Apps Script ping failed",
        };
    }

    const matchedMessages = [];
    let filteredOut = 0;

    for (const id of ids) {
        const message = await buildImportMessage(accessToken, id, inboxEmail);

        if (matchesSenderAllowlist(message.sender, allowlist)) {
            if (matchedMessages.length < maxMessages) {
                matchedMessages.push(message);
            }
        } else {
            filteredOut += 1;
        }
    }

    const categoryMemory = await readBiCategoryMemory(getFirestore(), retailOwnerId).catch(() => ({}));

    let senderSuggestionsSummary = {
        discovered: 0,
        stored: 0,
        inspected: 0,
        approvedAlready: 0,
        pending: 0,
        autoImportedNow: 0,
        pendingReviewImported: 0,
        rows: [],
    };

    try {
        senderSuggestionsSummary = await discoverRetailSenderSuggestions({
            retailOwnerId,
            accessToken,
            inboxEmail,
            allowlist,
            days,
            window,
            skipProcessed,
            processedLabel,
            lastSyncCursorIso: savedLastSyncCursorIso,
            overlapMinutes: syncOverlapMinutes,
            ignoreCursor: effectiveIgnoreCursor,
            matchedMessageIds: matchedMessages.map((message) => message?.gmailId),
            categoryMemory,
        });

        const autoImportBudget = Math.max(0, maxMessages - matchedMessages.length);
        const autoImportIds = (Array.isArray(senderSuggestionsSummary.autoImportNowCandidateIds)
            ? senderSuggestionsSummary.autoImportNowCandidateIds
            : [])
            .filter((id) => id && !matchedMessages.some((message) => message?.gmailId === id))
            .slice(0, autoImportBudget);

        for (const candidateId of autoImportIds) {
            const autoMessage = await buildImportMessage(accessToken, candidateId, inboxEmail);
            matchedMessages.push(autoMessage);
        }
        senderSuggestionsSummary.autoImportedNow = autoImportIds.length;

        const pendingReviewImported = dry
            ? 0
            : await persistPendingReviewCandidates({
                retailOwnerId,
                onboarding: {},
                registryEntry: {},
                candidates: Array.isArray(senderSuggestionsSummary.pendingReviewCandidates)
                    ? senderSuggestionsSummary.pendingReviewCandidates.slice(0, 12)
                    : [],
            }).catch(() => 0);
        senderSuggestionsSummary.pendingReviewImported = pendingReviewImported;
    } catch (suggestErr) {
        console.warn("[retail sync] sender discovery failed", suggestErr?.message || suggestErr);
        senderSuggestionsSummary = {
            discovered: 0,
            stored: 0,
            inspected: 0,
            approvedAlready: 0,
            pending: 0,
            autoImportedNow: 0,
            pendingReviewImported: 0,
            error: suggestErr?.message || "sender discovery failed",
            rows: [],
        };
    }

    try {
        senderSuggestionsSummary = await discoverRetailSenderSuggestions({
            retailOwnerId,
            accessToken,
            inboxEmail,
            allowlist,
            days,
            window,
            skipProcessed,
            processedLabel,
            lastSyncCursorIso: savedLastSyncCursorIso,
            overlapMinutes: syncOverlapMinutes,
            ignoreCursor: effectiveIgnoreCursor,
            matchedMessageIds: matchedMessages.map((message) => message?.gmailId),
        });
    } catch (suggestErr) {
        console.warn("[retail sync] sender discovery failed", suggestErr?.message || suggestErr);
        senderSuggestionsSummary = {
            discovered: 0,
            stored: 0,
            inspected: 0,
            approvedAlready: 0,
            pending: 0,
            error: suggestErr?.message || "sender discovery failed",
            rows: [],
        };
    }

    let gasJson = {
        ok: true,
        processed: 0,
        writeCount: 0,
        parseFailed: 0,
        skipped: 0,
        writeErrors: 0,
    };

    if (matchedMessages.length > 0) {
        gasJson = await ingestMessagesViaAppsScript({
            retailOwnerId,
            actorUid: syncActorUid,
            inboxEmail,
            connectionEmail,
            lane,
            debug,
            dry,
            messages: matchedMessages,
        });
    } else {
        gasJson = {
            ok: true,
            processed: 0,
            writeCount: 0,
            parseFailed: 0,
            skipped: filteredOut || 0,
            writeErrors: 0,
            reason: ids.length
                ? "allowlist_filtered_all_messages"
                : "gmail_query_or_empty_window",
        };
    }

    const nextHistoryId =
        String(gmailProfile.historyId || "").trim() || savedLastHistoryId;

    async function verifyRetailReceiptRowsVisible(retailOwnerId, matchedMessages = []) {
        const db = getFirestore();

        const candidateRawIds = uniqueNonEmpty(
            (Array.isArray(matchedMessages) ? matchedMessages : []).flatMap((message) => [
                String(message?.gmailId || "").trim(),
                String(message?.messageId || "").trim().replace(/^<|>$/g, ""),
            ])
        ).slice(0, 80);

        if (!candidateRawIds.length) {
            return {
                checked: 0,
                visible: 0,
                missingSample: [],
                ok: true,
            };
        }

        const snaps = await Promise.all(
            candidateRawIds.map((rawId) =>
                retailReceiptDoc(db, retailOwnerId, rawId)
                    .get()
                    .catch((err) => ({
                        exists: false,
                        __verifyError: err?.message || "verify_failed",
                    }))
            )
        );

        const visible = snaps.filter((snap) => snap?.exists).length;
        const missingSample = candidateRawIds
            .filter((_, index) => !snaps[index]?.exists)
            .slice(0, 10);

        return {
            checked: candidateRawIds.length,
            visible,
            missingSample,
            ok: visible > 0,
        };
    }

    const receiptVisibility = matchedMessages.length
        ? await verifyRetailReceiptRowsVisible(retailOwnerId, matchedMessages).catch((err) => ({
            checked: 0,
            visible: 0,
            missingSample: [],
            ok: false,
            error: err?.message || "receipt_visibility_verify_failed",
        }))
        : {
            checked: 0,
            visible: 0,
            missingSample: [],
            ok: true,
        };

    const hasVisibleReceiptRows =
        matchedMessages.length === 0 || Number(receiptVisibility.visible || 0) > 0;

    const cursorAdvanceAllowed =
        !dry &&
        gasJson?.ok !== false &&
        Number(gasJson?.writeErrors || 0) === 0 &&
        !String(gasJson?.error || "").trim() &&
        hasVisibleReceiptRows;

    const nextLastSyncCursorIso = cursorAdvanceAllowed
        ? syncStartedAtIso
        : savedLastSyncCursorIso;

    const matchedMessageIds = uniqueNonEmpty(
        matchedMessages.map((message) => message?.gmailId)
    );

    let labelsApplied = {
        ok: false,
        attempted: 0,
        modified: 0,
        names: [],
        error: "",
    };

    if (cursorAdvanceAllowed && matchedMessageIds.length) {
        const labelNames = uniqueNonEmpty([
            processedLabel || DEFAULT_RETAIL_IMPORTED_LABEL,
            receiptsLabel || DEFAULT_RETAIL_RECEIPTS_LABEL,
        ]);

        try {
            const labelMap = await ensureGmailLabelIds(accessToken, labelNames);
            const addLabelIds = uniqueNonEmpty(labelNames.map((name) => labelMap[name]));

            if (addLabelIds.length) {
                const result = await batchModifyGmailMessages(accessToken, matchedMessageIds, {
                    addLabelIds,
                });

                labelsApplied = {
                    ok: true,
                    attempted: matchedMessageIds.length,
                    modified: Number(result?.modified || matchedMessageIds.length),
                    names: labelNames,
                    error: "",
                };
            }
        } catch (labelErr) {
            labelsApplied = {
                ok: false,
                attempted: matchedMessageIds.length,
                modified: 0,
                names: labelNames,
                error: labelErr?.message || "Failed to apply Gmail labels",
            };
        }
    }

    const runId = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    await Promise.all([
        retailConnectionRef(retailOwnerId).set(
            retailValidatedPayload("connection", retailOwnerId, {
                gmailEmail: inboxEmail,
                email: inboxEmail,
                connectionEmail,
                historyId: nextHistoryId || conn.historyId || "",
                lastHistoryId: nextHistoryId || savedLastHistoryId || "",
                lastSyncCursorIso: nextLastSyncCursorIso || "",
                syncOverlapMinutes,
                scopes: Array.isArray(conn.scopes) ? conn.scopes : [],
                watchStatus: buildManualWatchStatus({
                    state: "checked",
                }),
                lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
                lastSyncSummary: {
                    requested: ids.length,
                    matched: matchedMessages.length,
                    filteredOut,
                    processed: gasJson.processed || 0,
                    written: gasJson.writeCount || 0,
                    parseFailed: gasJson.parseFailed || 0,
                    skipped: gasJson.skipped || 0,
                    writeErrors: gasJson.writeErrors || 0,
                    chunkCount: gasJson.chunkCount || 0,
                    fallbackChunkCount: gasJson.fallbackChunkCount || 0,
                    queryCount: queries.length,
                    skipProcessed,
                    processedLabel: skipProcessed ? processedLabel : "",
                    receiptsLabel,
                    labelsApplied,
                    cursorMode: timePlan.mode,
                    savedCursorIso: savedLastSyncCursorIso || "",
                    appliedCursorIso: timePlan.appliedCursorIso || "",
                    nextCursorIso: nextLastSyncCursorIso || "",
                    cursorAdvanceAllowed,
                    lastHistoryId: nextHistoryId || "",
                    syncStartedAtIso,
                    overlapMinutes: syncOverlapMinutes,
                    window: timePlan.window || null,
                    syncTrigger,
                    autoImportedNow: Number(senderSuggestionsSummary.autoImportedNow || 0),
                    pendingReviewImported: Number(senderSuggestionsSummary.pendingReviewImported || 0),
                },
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }),
            { merge: true }
        ),

        retailSettingsRef(retailOwnerId).set(
            retailValidatedPayload("settings", retailOwnerId, {
                inboxEmail,
                allowlist,
                lane: lane || "",
                yearScope,
                daysDefault: days,
                maxMessagesDefault: maxMessages,
                skipProcessed,
                processedLabel: processedLabel || DEFAULT_RETAIL_IMPORTED_LABEL,
                receiptsLabel,
                syncWindow: timePlan.window || null,
                lastHistoryId: nextHistoryId || "",
                lastSyncCursorIso: nextLastSyncCursorIso || "",
                syncOverlapMinutes,
                lastSyncPrefs: {
                    lane: lane || "",
                    yearScope,
                    days,
                    maxMessages,
                    filteredOut,
                    requested: ids.length,
                    matched: matchedMessages.length,
                    queryCount: queries.length,
                    skipProcessed,
                    processedLabel: processedLabel || DEFAULT_RETAIL_IMPORTED_LABEL,
                    receiptsLabel,
                    labelsApplied,
                    cursorMode: timePlan.mode,
                    savedCursorIso: savedLastSyncCursorIso || "",
                    appliedCursorIso: timePlan.appliedCursorIso || "",
                    nextCursorIso: nextLastSyncCursorIso || "",
                    cursorAdvanceAllowed,
                    overlapMinutes: syncOverlapMinutes,
                    window: timePlan.window || null,
                    syncTrigger,
                    at: admin.firestore.FieldValue.serverTimestamp(),
                    autoImportedNow: Number(senderSuggestionsSummary.autoImportedNow || 0),
                    pendingReviewImported: Number(senderSuggestionsSummary.pendingReviewImported || 0),
                },
                lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }),
            { merge: true }
        ),

        retailRunRef(retailOwnerId, runId).set(
            retailValidatedPayload("run", retailOwnerId, {
                runId,
                type: "gmail_sync",
                inboxEmail,
                requested: ids.length,
                matched: matchedMessages.length,
                filteredOut,
                queryCount: queries.length,
                skipProcessed,
                processedLabel: processedLabel || DEFAULT_RETAIL_IMPORTED_LABEL,
                receiptsLabel,
                labelsApplied,
                cursorMode: timePlan.mode,
                savedCursorIso: savedLastSyncCursorIso || "",
                appliedCursorIso: timePlan.appliedCursorIso || "",
                nextCursorIso: nextLastSyncCursorIso || "",
                cursorAdvanceAllowed,
                lastHistoryId: nextHistoryId || "",
                overlapMinutes: syncOverlapMinutes,
                window: timePlan.window || null,
                syncTrigger,
                gas: gasJson,
                queries: debug ? queries : [],
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }),
            { merge: true }
        ),
    ]);

    const messageErrors =
        Number(gasJson?.messageErrors || 0) ||
        Number(gasJson?.metrics?.messageErrors || 0);

    const writeCount = Number(gasJson?.writeCount || 0);
    const parseFailed = Number(gasJson?.parseFailed || 0);
    const writeErrors = Number(gasJson?.writeErrors || 0);
    const labelError = String(labelsApplied?.error || "").trim();

    const warnings = [];
    if (writeCount > 0 && labelError) {
        warnings.push("gmail_labels_not_applied");
    }

    const likelyBlocker =
        ids.length === 0
            ? "gmail_query_or_empty_window"
            : matchedMessages.length === 0
                ? "allowlist_filtered_all_messages"
                : !hasVisibleReceiptRows
                    ? "apps_script_wrong_firestore_path_or_live_env"
                    : messageErrors > 0
                        ? "apps_script_message_processing"
                        : writeErrors > 0
                            ? "apps_script_firestore_write"
                            : parseFailed > 0 && writeCount === 0
                                ? "parser_to_failure_queue"
                                : writeCount > 0
                                    ? "none"
                                    : labelError
                                        ? "gmail_label_apply"
                                        : "unknown_zero_write";

    const cursorPayload = {
        mode: timePlan.mode,
        savedCursorIso: savedLastSyncCursorIso || "",
        appliedCursorIso: timePlan.appliedCursorIso || "",
        nextCursorIso: nextLastSyncCursorIso || "",
        lastHistoryId: nextHistoryId || "",
        overlapMinutes: syncOverlapMinutes,
        advanced: cursorAdvanceAllowed,
        window: timePlan.window || null,
        startedAtIso: syncStartedAtIso,
    };

    const normalizedReason =
        ids.length === 0
            ? "gmail_query_or_empty_window"
            : matchedMessages.length === 0 && filteredOut > 0
                ? "allowlist_filtered_all_messages"
                : String(gasJson?.reason || "").trim() ||
                String(labelsApplied?.error || "").trim() ||
                "";

    const diagnostics = {
        likelyBlocker,
        reason: normalizedReason,
        gmail: {
            requested: ids.length,
            matched: matchedMessages.length,
            filteredOut,
            queryCount: queries.length,
        },
        ingest: {
            processed: Number(gasJson?.processed || 0),
            writeCount: Number(gasJson?.writeCount || 0),
            parseFailed: Number(gasJson?.parseFailed || 0),
            skipped: Number(gasJson?.skipped || 0),
            writeErrors: Number(gasJson?.writeErrors || 0),
            chunkCount: Number(gasJson?.chunkCount || 0),
            fallbackChunkCount: Number(gasJson?.fallbackChunkCount || 0),
            reason: String(gasJson?.reason || "").trim(),
            metrics: gasJson?.metrics || {},
            rowsPrepared: Number(gasJson?.rowsPrepared || 0),
            messageErrors: Number(gasJson?.messageErrors || 0),
            sampleErrors: Array.isArray(gasJson?.sampleErrors)
                ? gasJson.sampleErrors
                : [],
        },
        labelsApplied,
        receiptVisibility,
        cursor: cursorPayload,
        warnings,
        syncPlan: {
            hasExistingReceiptData,
            ignoreCursorRequested: ignoreCursor,
            ignoreCursorEffective: effectiveIgnoreCursor,
            forceInitialManualBackfill,
            requestedDays: days,
        },
    };

    return {
        ok: true,
        retailOwnerId,
        runId,
        inboxEmail,
        requested: ids.length,
        matched: matchedMessages.length,
        filteredOut,
        lane,
        allowlist,
        queryCount: queries.length,
        skipProcessed,
        processedLabel: processedLabel || DEFAULT_RETAIL_IMPORTED_LABEL,
        receiptsLabel,
        window: timePlan.window || null,
        queries: debug ? queries : [],
        cursor: cursorPayload,
        labelsApplied,
        receiptVisibility,
        gas: gasJson,
        likelyBlocker,
        diagnostics,
        syncTrigger,
        appsScriptPing,
        senderSuggestions: senderSuggestionsSummary,
        autoImportedNow: Number(senderSuggestionsSummary.autoImportedNow || 0),
        pendingReviewImported: Number(senderSuggestionsSummary.pendingReviewImported || 0),
    };
}

router.use("/sender-suggestions", createRetailSenderReviewRouter({
    retailTenantMemberMiddleware,
    retailTenantManagerMiddleware,
    getRetailTenantIdFromReq,
}));

router.post("/sync", ...retailTenantManagerMiddleware, async (req, res) => {
    try {
        const result = await runRetailGmailSyncForOwner({
            retailOwnerId: getRetailTenantIdFromReq(req),
            actorUid: getRetailActorUidFromReq(req),
            body: req.body || {},
            trigger: "manual",
        });

        return res.json(result);
    } catch (err) {
        console.error("receipts/google/sync error", err);

        const message = err?.message || "Sync failed";
        const stage =
            /Apps Script/i.test(message)
                ? "apps_script"
                : /Gmail/i.test(message)
                    ? "gmail"
                    : /allowlist/i.test(message)
                        ? "allowlist"
                        : "sync";

        return res.status(err.statusCode || 500).json({
            ok: false,
            error: message,
            likelyBlocker:
                stage === "apps_script"
                    ? "apps_script_request_failed"
                    : stage === "gmail"
                        ? "gmail_request_failed"
                        : "sync_request_failed",
            diagnostics: {
                stage,
                reason: message,
            },
        });
    }
});

router.post(
    "/pdf-upload",
    ...retailTenantManagerMiddleware,
    retailPdfUploadMiddleware,
    async (req, res) => {
        try {
            ensureRetailPdfUploadConfig();

            const retailOwnerId = getRetailTenantIdFromReq(req);
            const actorUid = getRetailActorUidFromReq(req);
            const files = Array.isArray(req.files) ? req.files : [];

            if (!files.length) {
                return res.status(400).json({ ok: false, error: "Select at least one PDF file" });
            }

            const [settingsSnap, connectionSnap] = await Promise.all([
                retailSettingsRef(retailOwnerId).get().catch(() => null),
                retailConnectionRef(retailOwnerId).get().catch(() => null),
            ]);

            const savedSettings = settingsSnap?.exists ? settingsSnap.data() || {} : {};
            const connection = connectionSnap?.exists ? connectionSnap.data() || {} : {};
            const lane = String(savedSettings?.lane || "").trim();
            const inboxEmail = String(connection?.gmailEmail || connection?.email || "manual-upload")
                .trim()
                .toLowerCase();
            const connectionEmail = String(
                connection?.gmailEmail || connection?.email || inboxEmail || "manual-upload"
            )
                .trim()
                .toLowerCase();

            const uploadedFiles = [];
            const importMessages = [];

            for (const file of files) {
                const safeName = safeUploadFilename(file.originalname || "receipt.pdf");
                try {
                    const uploaded = await uploadPdfBufferToCloudinary(file.buffer, {
                        retailOwnerId,
                        fileName: safeName,
                    });

                    const syntheticMessageId = buildPdfUploadMessageId(safeName);
                    const nowIso = new Date().toISOString();

                    importMessages.push({
                        gmailId: "",
                        messageId: syntheticMessageId,
                        emailPermalink: "",
                        sender: "manual-pdf-upload@local.receipts",
                        subject: `Manual PDF receipt upload - ${safeName}`,
                        rawDate: nowIso,
                        messageDate: nowIso,
                        inboxEmail,
                        bodyPlain: `Manual PDF receipt upload. File: ${safeName}`,
                        snippet: safeName,
                        source: "pdf_upload",
                        receiptUrl: String(uploaded?.secure_url || "").trim(),
                        attachments: [
                            {
                                name: safeName,
                                contentType: "application/pdf",
                                base64: file.buffer.toString("base64"),
                            },
                        ],
                    });

                    uploadedFiles.push({
                        name: safeName,
                        size: Number(file.size || 0),
                        status: "uploaded",
                        receiptUrl: String(uploaded?.secure_url || "").trim(),
                        publicId: String(uploaded?.public_id || "").trim(),
                        bytes: Number(uploaded?.bytes || file.size || 0),
                    });
                } catch (fileErr) {
                    uploadedFiles.push({
                        name: safeName,
                        size: Number(file.size || 0),
                        status: "upload_failed",
                        error: fileErr?.message || "Cloudinary upload failed",
                    });
                }
            }

            if (!importMessages.length) {
                return res.status(500).json({
                    ok: false,
                    error: "No PDF files could be uploaded",
                    files: uploadedFiles,
                });
            }

            const gas = await ingestMessagesViaAppsScript({
                retailOwnerId,
                actorUid,
                inboxEmail,
                connectionEmail,
                lane,
                debug: false,
                dry: false,
                messages: importMessages,
            });

            await Promise.all([
                retailConnectionRef(retailOwnerId).set(
                    retailValidatedPayload("connection", retailOwnerId, {
                        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    }),
                    { merge: true }
                ),
                retailSettingsRef(retailOwnerId).set(
                    retailValidatedPayload("settings", retailOwnerId, {
                        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        lastSyncPrefs: {
                            mode: "pdf_upload",
                            filesRequested: files.length,
                            filesUploaded: importMessages.length,
                            at: admin.firestore.FieldValue.serverTimestamp(),
                        },
                    }),
                    { merge: true }
                ),
            ]);

            return res.json({
                ok: true,
                retailOwnerId,
                lane,
                uploaded: importMessages.length,
                uploadFailed: uploadedFiles.filter((item) => item.status === "upload_failed").length,
                files: uploadedFiles,
                gas,
            });
        } catch (err) {
            console.error("receipts/google/pdf-upload error", err);
            return res.status(err.statusCode || 500).json({
                ok: false,
                error: err?.message || "PDF receipt upload failed",
            });
        }
    }
);

router.use("/", createRetailGmailSchedulerRouter({
    firebaseAuth,
    requireOpsAdmin,
    getRetailReceiptSchedulerStatus,
    runRetailReceiptSchedulerPass,
    handleRetailSchedulerHttp,
    normalizeIntInRange,
    DEFAULT_AUTO_SCHEDULER_LIMIT,
}));
registerRetailSyncRunner(runRetailGmailSyncForOwner);

module.exports = router;
module.exports.runRetailGmailSyncForOwner = runRetailGmailSyncForOwner;