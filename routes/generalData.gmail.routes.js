const express = require("express");
const crypto = require("crypto");
const { simpleParser } = require("mailparser");
const { auth } = require("../middleware/auth");
const { requireTenantAccess, requireTenantRole, getActorFirebaseUid } = require("../middleware/tenantAccess");
const { admin, getFirestore } = require("../lib/firebaseAdmin");
const { decryptText } = require("../lib/secretBox");
const { retailConnectionDoc } = require("../lib/retailPaths");
const {
    generalSettingsDoc,
    generalAllowlistCollection,
    generalAllowlistDoc,
    generalDocumentsCollection,
    generalDocumentDoc,
    generalFailuresCollection,
    generalFailureDoc,
    generalRunsCollection,
    generalRunDoc,
    buildGeneralOwnedPayload,
} = require("../lib/generalDataPaths");
const { parseGeneralEmailDocument } = require("../services/generalData/generalDataRuleParser");

const router = express.Router();

function envFirst(...names) {
    for (const name of names) {
        const value = process.env[name];
        if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return "";
}

function getRetailOAuthClient() {
    return {
        clientId: envFirst(
            "RETAIL_GMAIL_CLIENT_ID",
            "GOOGLE_OAUTH_CLIENT_ID",
            "GOOGLE_GMAIL_CLIENT_ID"
        ),
        clientSecret: envFirst(
            "RETAIL_GMAIL_CLIENT_SECRET",
            "GOOGLE_OAUTH_CLIENT_SECRET",
            "GOOGLE_GMAIL_CLIENT_SECRET"
        ),
    };
}

const DEFAULT_SYNC_DAYS = 30;
const QUERY_CHUNK_SIZE = 20;

const tenantManagerMiddleware = [auth, requireTenantAccess, requireTenantRole(["owner", "admin", "ops"])];
const tenantMemberMiddleware = [auth, requireTenantAccess];

function getTenantIdFromReq(req) {
    const tenantId = String(req.tenantId || req.body?.tenantId || req.query?.tenantId || req.headers["x-tenant-id"] || "").trim();
    if (!tenantId) throw new Error("Missing tenantId");
    return tenantId;
}

function getActorUid(req) {
    return String(getActorFirebaseUid(req) || req.firebaseUser?.uid || "").trim();
}

async function nodeFetch(url, options) {
    if (typeof fetch === "function") return fetch(url, options);
    const mod = await import("node-fetch");
    const fn = mod.default || mod;
    return fn(url, options);
}

function normalizeEmailEntry(value) {
    const s = String(value || "").trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
}

function normalizeDomainEntry(value) {
    let s = String(value || "").trim().toLowerCase();
    s = s.replace(/^@\*/, "").replace(/^@/, "").replace(/^\*\./, "").replace(/^www\./, "");
    s = s.replace(/^https?:\/\//, "").split("/")[0].trim();
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s) ? s : "";
}

function uniqueStrings(list = []) {
    return Array.from(new Set((Array.isArray(list) ? list : [list]).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)));
}

function parseBoundedInt(value, { fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(num)));
}

function parseBooleanFlag(value, fallback = false) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;

    const safe = String(value || "").trim().toLowerCase();
    if (!safe) return fallback;
    if (["true", "1", "yes", "y", "on"].includes(safe)) return true;
    if (["false", "0", "no", "n", "off"].includes(safe)) return false;
    return fallback;
}

function hasStoredRefreshToken(payload) {
    return Boolean(payload && typeof payload === "object" && payload.iv && payload.tag && payload.data);
}

function normalizeAllowlist(value = {}) {
    const emails = uniqueStrings((Array.isArray(value?.emails) ? value.emails : []).map(normalizeEmailEntry).filter(Boolean));
    const domains = uniqueStrings((Array.isArray(value?.domains) ? value.domains : []).map(normalizeDomainEntry).filter(Boolean));
    return { emails, domains };
}

function normalizeAllowlistPayload(body = {}) {
    const source =
        body?.allowlist && typeof body.allowlist === "object"
            ? body.allowlist
            : body;

    return normalizeAllowlist(source || {});
}

function areAllowlistsEqual(left = {}, right = {}) {
    const a = normalizeAllowlist(left);
    const b = normalizeAllowlist(right);

    const aEmails = [...a.emails].sort();
    const bEmails = [...b.emails].sort();
    const aDomains = [...a.domains].sort();
    const bDomains = [...b.domains].sort();

    return (
        aEmails.length === bEmails.length &&
        aDomains.length === bDomains.length &&
        aEmails.every((value, index) => value === bEmails[index]) &&
        aDomains.every((value, index) => value === bDomains[index])
    );
}

function extractSenderEmail(fromHeader) {
    const raw = String(fromHeader || "").trim().toLowerCase();
    if (!raw) return "";
    const angle = raw.match(/<([^>]+)>/);
    const candidate = angle?.[1] || raw.split(/[\s,]+/).find((part) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part)) || raw;
    const clean = String(candidate).replace(/^mailto:/, "").replace(/[<>"']/g, "").trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? clean : "";
}

function buildSenderTerms(allowlist = {}) {
    const safe = normalizeAllowlist(allowlist);
    return [...safe.emails.map((email) => `from:${email}`), ...safe.domains.map((domain) => `from:${domain}`)];
}

function buildQueries({ days = DEFAULT_SYNC_DAYS, allowlist = {} } = {}) {
    const senderTerms = buildSenderTerms(allowlist);
    if (!senderTerms.length) return [];
    const base = [`newer_than:${Math.max(1, Number(days || DEFAULT_SYNC_DAYS))}d`, "-in:spam", "-in:trash"].join(" ");
    const out = [];
    for (let i = 0; i < senderTerms.length; i += QUERY_CHUNK_SIZE) {
        out.push(`${base} (${senderTerms.slice(i, i + QUERY_CHUNK_SIZE).join(" OR ")})`);
    }
    return out;
}

async function refreshAccessToken(refreshToken) {
    const { clientId, clientSecret } = getRetailOAuthClient();

    if (!(clientId && clientSecret)) {
        throw new Error("Google OAuth client is not configured");
    }

    const body = new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
    });

    const res = await nodeFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok || !json.access_token) {
        throw new Error(
            json.error_description ||
            json.error ||
            `Google token refresh failed (${res.status})`
        );
    }

    return json.access_token;
}

async function gmailGetJson(accessToken, url) {
    const res = await nodeFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || `Gmail API failed (${res.status})`);
    return json;
}

function standardBase64(input) {
    return String(input || "").replace(/-/g, "+").replace(/_/g, "/");
}

async function listMessageIds(accessToken, { queries = [], maxMessages = 50 } = {}) {
    const ids = [];
    for (const query of queries) {
        let pageToken = "";
        while (ids.length < maxMessages) {
            const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
            url.searchParams.set("q", query);
            url.searchParams.set("maxResults", String(Math.min(50, maxMessages - ids.length)));
            if (pageToken) url.searchParams.set("pageToken", pageToken);
            const json = await gmailGetJson(accessToken, url.toString());
            const rows = Array.isArray(json.messages) ? json.messages : [];
            let fresh = 0;
            for (const row of rows) {
                if (row?.id && !ids.includes(row.id)) {
                    ids.push(row.id);
                    fresh += 1;
                }
            }
            if (!json.nextPageToken || !rows.length || fresh === 0) break;
            pageToken = json.nextPageToken;
        }
        if (ids.length >= maxMessages) break;
    }
    return ids;
}

async function fetchRawMessage(accessToken, messageId) {
    return gmailGetJson(accessToken, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=raw`);
}

function buildEmailPermalink({ gmailId = "", messageId = "" } = {}) {
    const safeMessageId = String(messageId || "").trim().replace(/^<|>$/g, "");
    const safeGmailId = String(gmailId || "").trim();
    if (safeMessageId && safeMessageId.includes("@")) {
        return `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(safeMessageId)}`;
    }
    if (safeGmailId) return `https://mail.google.com/mail/u/0/#all/${safeGmailId}`;
    return "";
}

async function buildImportMessage(accessToken, messageId, inboxEmail) {
    const raw = await fetchRawMessage(accessToken, messageId);
    const parsed = await simpleParser(Buffer.from(standardBase64(raw.raw || ""), "base64"));
    const headerMessageId = String(parsed.messageId || raw.id || "").replace(/^<|>$/g, "");
    const rawDate = parsed.date ? parsed.date.toUTCString() : "";
    const messageDate = parsed.date ? parsed.date.toISOString() : new Date().toISOString();

    return {
        gmailId: raw.id,
        messageId: headerMessageId,
        emailPermalink: buildEmailPermalink({ gmailId: raw.id, messageId: headerMessageId }),
        sender: parsed.from?.text || "",
        senderEmail: extractSenderEmail(parsed.from?.text || ""),
        subject: String(parsed.subject || "").trim(),
        rawDate,
        messageDate,
        inboxEmail: String(inboxEmail || "").trim(),
        bodyPlain: String(parsed.text || "").trim(),
        bodyHtml: String(parsed.html || "").trim(),
        snippet: String(parsed.text || parsed.subject || "").trim().slice(0, 240),
    };
}

async function loadAllowlist(tenantId) {
    const db = getFirestore();
    const snap = await generalAllowlistCollection(db, tenantId).get();
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
        }
        if (type === "domain") {
            const safe = normalizeDomainEntry(pattern);
            if (safe) domains.push(safe);
        }
    });
    return normalizeAllowlist({ emails, domains });
}

function matchesAllowlist(sender, allowlist = {}) {
    const safe = normalizeAllowlist(allowlist);
    if (!safe.emails.length && !safe.domains.length) return false;
    const email = extractSenderEmail(sender);
    if (!email) return false;
    const domain = email.split("@")[1] || "";
    return safe.emails.includes(email) || safe.domains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

function toIsoOrNull(value) {
    if (!value) return null;
    if (typeof value?.toDate === "function") return value.toDate().toISOString();
    const safe = String(value || "").trim();
    return safe || null;
}

async function countCollectionDocs(collRef) {
    try {
        if (collRef && typeof collRef.count === "function") {
            const snap = await collRef.count().get();
            const data = typeof snap?.data === "function" ? snap.data() : {};
            const count = Number(data?.count || 0);
            if (Number.isFinite(count)) return count;
        }
    } catch (err) {
        // swallow and let caller fall back to lighter-weight UI counts
    }

    return null;
}

function toFiniteNumberOrNull(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function getStoredSummaryCounts(settings = {}) {
    const summary = settings?.summary && typeof settings.summary === "object" ? settings.summary : {};
    return {
        parsedDocumentCount: toFiniteNumberOrNull(summary.parsedDocumentCount),
        failedDocumentCount: toFiniteNumberOrNull(summary.failedDocumentCount),
        totalDocumentCount: toFiniteNumberOrNull(summary.totalDocumentCount),
    };
}

function getStoredAllowlist(settings = {}) {
    return normalizeAllowlist(settings?.allowlist || {});
}

function mapLatestRun(data = {}) {
    if (!data || typeof data !== "object") return null;
    const finishedAt = toIsoOrNull(data.finishedAt || data.updatedAt || data.createdAt);

    return {
        runId: String(data.runId || "").trim() || null,
        finishedAt,
        syncDays: Number(data.syncDays || DEFAULT_SYNC_DAYS),
        processed: Number(data.processed || 0),
        writeCount: Number(data.writeCount || 0),
        failedCount: Number(data.failedCount || 0),
        skipped: Number(data.skipped || 0),
        existingSkipped: Number(data.existingSkipped || 0),
    };
}

router.get("/documents", ...tenantMemberMiddleware, async (req, res) => {
    try {
        const tenantId = getTenantIdFromReq(req);
        const db = getFirestore();
        const limit = parseBoundedInt(req.query?.limit, { fallback: 40, min: 1, max: 100 });

        const docsRef = generalDocumentsCollection(db, tenantId)
            .orderBy("updatedAt", "desc")
            .limit(limit);

        const failedRef = generalFailuresCollection(db, tenantId)
            .orderBy("updatedAt", "desc")
            .limit(limit);

        const [docsSnap, failedSnap] = await Promise.all([
            docsRef.get().catch(() => null),
            failedRef.get().catch(() => null),
        ]);

        const rows = [];
        const pushSnapRows = (snap, fallbackStatus = "READY") => {
            if (!snap || snap.empty) return;
            snap.forEach((docSnap) => {
                const data = docSnap.data() || {};
                const extractedData = data.extractedData && typeof data.extractedData === "object" ? data.extractedData : {};
                const updatedAt = data.updatedAt?.toDate ? data.updatedAt.toDate().toISOString() : (data.updatedAt || data.createdAt || null);
                rows.push({
                    id: docSnap.id,
                    title: String(data.subject || data.summary || data.documentType || "Untitled document").trim(),
                    sender: String(data.senderEmail || data.sender || "").trim(),
                    receivedAt: String(data.messageDate || data.rawDate || updatedAt || new Date().toISOString()).trim(),
                    source: String(data.source || "gmail").trim(),
                    detectedType: String(data.documentType || "unknown").trim(),
                    status: String(data.parseStatus || fallbackStatus).trim().toUpperCase(),
                    confidence: Number(data.confidence || 0),
                    summary: String(data.summary || "").trim(),
                    entities: Number(data.entityCount || 0),
                    tags: [],
                    account: String(data.inboxEmail || "").trim(),
                    fileName: data.fileName ? String(data.fileName).trim() : "email-only",
                    highlights: Array.isArray(extractedData.keyValueLines) ? extractedData.keyValueLines.slice(0, 8) : [],
                    extractedData,
                    emailPermalink: String(data.emailPermalink || "").trim(),
                    messageId: String(data.messageId || "").trim(),
                });
            });
        };

        pushSnapRows(docsSnap, "READY");
        pushSnapRows(failedSnap, "FAILED");

        rows.sort((a, b) => new Date(b.receivedAt || 0).getTime() - new Date(a.receivedAt || 0).getTime());

        return res.json({
            ok: true,
            rows: rows.slice(0, limit),
            count: rows.length,
        });
    } catch (err) {
        console.error("general-data/google/documents error", err);
        return res.status(500).json({ ok: false, error: err?.message || "Document list failed" });
    }
});

router.get("/status", ...tenantMemberMiddleware, async (req, res) => {
    try {
        const tenantId = getTenantIdFromReq(req);
        const db = getFirestore();

        const [settingsSnap, connectionSnap, latestRunSnap] = await Promise.all([
            generalSettingsDoc(db, tenantId).get().catch(() => null),
            retailConnectionDoc(db, tenantId).get().catch(() => null),
            generalRunsCollection(db, tenantId)
                .orderBy("finishedAt", "desc")
                .limit(1)
                .get()
                .catch(() => null),
        ]);

        const settings = settingsSnap?.exists ? settingsSnap.data() || {} : {};
        const storedCounts = getStoredSummaryCounts(settings);
        const storedAllowlist = getStoredAllowlist(settings);
        const allowlist =
            storedAllowlist.emails.length || storedAllowlist.domains.length
                ? storedAllowlist
                : await loadAllowlist(tenantId);

        const connection = connectionSnap?.exists ? connectionSnap.data() || {} : {};
        const { clientId, clientSecret } = getRetailOAuthClient();
        const hasOAuthClient = Boolean(clientId && clientSecret);
        const latestRun =
            latestRunSnap && !latestRunSnap.empty
                ? mapLatestRun({
                    runId: latestRunSnap.docs[0].id,
                    ...(latestRunSnap.docs[0].data() || {}),
                })
                : null;

        const allowlistCount =
            storedAllowlist.emails.length || storedAllowlist.domains.length
                ? (
                    toFiniteNumberOrNull(settings?.allowlistCount) ??
                    (storedAllowlist.emails.length + storedAllowlist.domains.length)
                )
                : (allowlist.emails.length + allowlist.domains.length);

        return res.json({
            ok: true,
            pipelineType: "general_data",
            connected: hasStoredRefreshToken(connection.refreshTokenEncrypted),
            gmailEmail: connection.gmailEmail || connection.email || "",
            connectionStatus: {
                connected: hasStoredRefreshToken(connection.refreshTokenEncrypted),
                hasOAuthClient,
                missingReason: !connectionSnap?.exists
                    ? "connection_not_found"
                    : !hasStoredRefreshToken(connection.refreshTokenEncrypted)
                        ? "refresh_token_missing"
                        : !hasOAuthClient
                            ? "oauth_client_not_configured"
                            : null,
            },
            settings: {
                syncDays: Number(settings.syncDays || DEFAULT_SYNC_DAYS),
                maxMessagesDefault: parseBoundedInt(settings.maxMessagesDefault, { fallback: 35, min: 1, max: 100 }),
                enabled: settings.enabled !== false,
                onboardingCompleted: Boolean(settings.onboardingCompleted),
                lastSyncAt: toIsoOrNull(settings.lastSyncAt),
            },
            allowlist,
            allowlistCount,
            summary: {
                allowlistCount,
                parsedDocumentCount: storedCounts.parsedDocumentCount,
                failedDocumentCount: storedCounts.failedDocumentCount,
                totalDocumentCount: storedCounts.totalDocumentCount,
                latestRun,
            },
        });
    } catch (err) {
        console.error("general-data/google/status error", err);
        return res.status(500).json({ ok: false, error: err?.message || "Status failed" });
    }
});

router.post("/settings", ...tenantManagerMiddleware, express.json({ limit: "1mb" }), async (req, res) => {
    try {
        const tenantId = getTenantIdFromReq(req);
        const db = getFirestore();
        const syncDays = parseBoundedInt(req.body?.syncDays, {
            fallback: DEFAULT_SYNC_DAYS,
            min: 1,
            max: 365,
        });
        const resetSyncCursor = parseBooleanFlag(req.body?.resetSyncCursor, false);
        const patch = buildGeneralOwnedPayload(tenantId, {
            enabled: parseBooleanFlag(req.body?.enabled, true),
            syncDays,
            maxMessagesDefault: parseBoundedInt(req.body?.maxMessagesDefault, { fallback: 35, min: 1, max: 100 }),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedBy: getActorUid(req),
        });

        if (Object.prototype.hasOwnProperty.call(req.body || {}, "onboardingCompleted")) {
            patch.onboardingCompleted = Boolean(req.body?.onboardingCompleted);
        }

        if (resetSyncCursor) {
            patch.lastSyncAt = null;
            patch.lastResetAt = admin.firestore.FieldValue.serverTimestamp();
        }

        await generalSettingsDoc(db, tenantId).set(patch, { merge: true });

        return res.json({
            ok: true,
            syncDays,
            maxMessagesDefault: Number(patch.maxMessagesDefault || 35),
            enabled: patch.enabled !== false,
            onboardingCompleted: Boolean(patch.onboardingCompleted),
            resetSyncCursor,
        });
    } catch (err) {
        console.error("general-data/google/settings error", err);
        return res.status(500).json({ ok: false, error: err?.message || "Save settings failed" });
    }
});

router.post("/allowlist", ...tenantManagerMiddleware, express.json({ limit: "1mb" }), async (req, res) => {
    try {
        const tenantId = getTenantIdFromReq(req);
        const db = getFirestore();
        const allowlist = normalizeAllowlistPayload(req.body || {});
        const actorUid = getActorUid(req);
        const settingsRef = generalSettingsDoc(db, tenantId);
        const settingsSnap = await settingsRef.get().catch(() => null);
        const currentSettings = settingsSnap?.exists ? settingsSnap.data() || {} : {};
        const currentAllowlist = getStoredAllowlist(currentSettings);
        const allowlistCount = allowlist.emails.length + allowlist.domains.length;

        if (areAllowlistsEqual(currentAllowlist, allowlist)) {
            await settingsRef.set(
                buildGeneralOwnedPayload(tenantId, {
                    allowlist,
                    allowlistCount,
                    summary: {
                        allowlistCount,
                    },
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedBy: actorUid,
                }),
                { merge: true }
            );

            return res.json({
                ok: true,
                allowlist,
                allowlistCount,
            });
        }

        const coll = generalAllowlistCollection(db, tenantId);
        const snap = await coll.get();
        const batch = db.batch();

        snap.forEach((docSnap) => batch.delete(docSnap.ref));

        allowlist.emails.forEach((pattern) => {
            batch.set(
                generalAllowlistDoc(db, tenantId, `email-${pattern.replace(/[^a-z0-9]+/gi, "-")}`),
                buildGeneralOwnedPayload(tenantId, {
                    type: "email",
                    pattern,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                })
            );
        });

        allowlist.domains.forEach((pattern) => {
            batch.set(
                generalAllowlistDoc(db, tenantId, `domain-${pattern.replace(/[^a-z0-9]+/gi, "-")}`),
                buildGeneralOwnedPayload(tenantId, {
                    type: "domain",
                    pattern,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                })
            );
        });

        batch.set(
            settingsRef,
            buildGeneralOwnedPayload(tenantId, {
                allowlist,
                allowlistCount,
                summary: {
                    allowlistCount,
                },
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedBy: actorUid,
            }),
            { merge: true }
        );

        await batch.commit();

        return res.json({
            ok: true,
            allowlist,
            allowlistCount,
        });
    } catch (err) {
        console.error("general-data/google/allowlist error", err);
        return res.status(500).json({ ok: false, error: err?.message || "Save allowlist failed" });
    }
});

router.post("/sync", ...tenantManagerMiddleware, express.json({ limit: "1mb" }), async (req, res) => {
    try {
        const tenantId = getTenantIdFromReq(req);
        const actorUid = getActorUid(req);
        const db = getFirestore();

        const { clientId, clientSecret } = getRetailOAuthClient();

        if (!(clientId && clientSecret)) {
            return res.status(400).json({ ok: false, error: "Google OAuth client is not configured" });
        }

        const [connectionSnap, settingsSnap] = await Promise.all([
            retailConnectionDoc(db, tenantId).get(),
            generalSettingsDoc(db, tenantId).get().catch(() => null),
        ]);

        if (!connectionSnap.exists) {
            return res.status(400).json({ ok: false, error: "Gmail connection not found" });
        }

        const connection = connectionSnap.data() || {};
        const settings = settingsSnap?.exists ? settingsSnap.data() || {} : {};
        const storedAllowlist = getStoredAllowlist(settings);
        const allowlist =
            storedAllowlist.emails.length || storedAllowlist.domains.length
                ? storedAllowlist
                : await loadAllowlist(tenantId);

        if (!allowlist.emails.length && !allowlist.domains.length) {
            return res.status(400).json({ ok: false, error: "General-data allowlist is empty" });
        }

        const refreshToken = decryptText(connection.refreshTokenEncrypted || {});
        if (!refreshToken) {
            return res.status(400).json({ ok: false, error: "Stored Gmail refresh token missing" });
        }

        const accessToken = await refreshAccessToken(refreshToken);
        const syncDays = parseBoundedInt(req.body?.syncDays, {
            fallback: Number(settings.syncDays || DEFAULT_SYNC_DAYS),
            min: 1,
            max: 365,
        });
        const maxMessages = parseBoundedInt(req.body?.maxMessages, {
            fallback: parseBoundedInt(settings.maxMessagesDefault, {
                fallback: 25,
                min: 1,
                max: 100,
            }),
            min: 1,
            max: 100,
        });

        const queries = buildQueries({ days: syncDays, allowlist });
        const messageIds = await listMessageIds(accessToken, { queries, maxMessages });
        const allowlistCount = allowlist.emails.length + allowlist.domains.length;

        const nowIso = new Date().toISOString();
        const runId = `general-sync-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

        let processed = 0;
        let writeCount = 0;
        let failedCount = 0;
        let skipped = 0;
        let existingSkipped = 0;
        const sampleErrors = [];
        const importedMessages = [];

        for (const messageId of messageIds) {
            try {
                const msg = await buildImportMessage(accessToken, messageId, connection.gmailEmail || connection.email || "");
                if (!matchesAllowlist(msg.sender || msg.senderEmail, allowlist)) {
                    skipped += 1;
                    continue;
                }

                importedMessages.push({
                    sourceMessageId: messageId,
                    docKey: msg.messageId || msg.gmailId || messageId,
                    msg,
                });
            } catch (err) {
                failedCount += 1;
                if (sampleErrors.length < 8) sampleErrors.push(err?.message || String(err));
            }
        }

        const successRefs = importedMessages.map(({ docKey }) => generalDocumentDoc(db, tenantId, docKey));
        const failureRefs = importedMessages.map(({ docKey }) => generalFailureDoc(db, tenantId, docKey));
        const existingSuccess = new Map();
        const existingFailure = new Map();

        if (importedMessages.length) {
            const existingSnaps = await db.getAll(...successRefs, ...failureRefs);
            successRefs.forEach((ref, index) => {
                const snap = existingSnaps[index];
                existingSuccess.set(ref.id, Boolean(snap?.exists));
            });
            failureRefs.forEach((ref, index) => {
                const snap = existingSnaps[successRefs.length + index];
                existingFailure.set(ref.id, Boolean(snap?.exists));
            });
        }

        const batch = db.batch();
        const storedCounts = getStoredSummaryCounts(settings);
        const needsSummaryBackfill = [
            storedCounts.parsedDocumentCount,
            storedCounts.failedDocumentCount,
            storedCounts.totalDocumentCount,
        ].some((value) => value === null);

        if (needsSummaryBackfill) {
            const [seedParsedCount, seedFailedCount] = await Promise.all([
                countCollectionDocs(generalDocumentsCollection(db, tenantId)).catch(() => null),
                countCollectionDocs(generalFailuresCollection(db, tenantId)).catch(() => null),
            ]);

            storedCounts.parsedDocumentCount = toFiniteNumberOrNull(seedParsedCount) ?? 0;
            storedCounts.failedDocumentCount = toFiniteNumberOrNull(seedFailedCount) ?? 0;
            storedCounts.totalDocumentCount =
                storedCounts.parsedDocumentCount + storedCounts.failedDocumentCount;
        }

        let parsedCountDelta = 0;
        let failedCountDelta = 0;
        let totalCountDelta = 0;

        for (const entry of importedMessages) {
            const { docKey, msg } = entry;
            const successRef = generalDocumentDoc(db, tenantId, docKey);
            const failureRef = generalFailureDoc(db, tenantId, docKey);
            const hasSuccess = existingSuccess.get(successRef.id) === true;
            const hasFailure = existingFailure.get(failureRef.id) === true;

            if (hasSuccess) {
                existingSkipped += 1;
                continue;
            }

            try {
                const parsed = parseGeneralEmailDocument({
                    sender: msg.senderEmail || msg.sender,
                    subject: msg.subject,
                    text: msg.bodyPlain,
                    html: msg.bodyHtml,
                    emailPermalink: msg.emailPermalink,
                    messageId: msg.messageId,
                    gmailId: msg.gmailId,
                    inboxEmail: msg.inboxEmail,
                    rawDate: msg.rawDate,
                    messageDate: msg.messageDate,
                });

                processed += 1;

                const payload = buildGeneralOwnedPayload(tenantId, {
                    source: "gmail",
                    parseStatus: parsed.status,
                    confidence: parsed.confidence,
                    documentType: parsed.documentType,
                    summary: parsed.summary,
                    sender: msg.sender,
                    senderEmail: msg.senderEmail,
                    subject: msg.subject,
                    emailPermalink: msg.emailPermalink,
                    inboxEmail: msg.inboxEmail,
                    messageId: msg.messageId,
                    gmailId: msg.gmailId,
                    rawDate: msg.rawDate,
                    messageDate: msg.messageDate,
                    extractedData: parsed.extractedData,
                    rawText: parsed.rawText,
                    rawHtmlText: parsed.rawHtmlText,
                    entityCount: parsed.entityCount,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedBy: actorUid,
                });

                if (parsed.ok) {
                    batch.set(successRef, payload, { merge: true });
                    writeCount += 1;

                    if (hasFailure) {
                        batch.delete(failureRef);
                        parsedCountDelta += 1;
                        failedCountDelta -= 1;
                    } else {
                        parsedCountDelta += 1;
                        totalCountDelta += 1;
                    }

                    continue;
                }

                if (hasFailure) {
                    existingSkipped += 1;
                    continue;
                }

                batch.set(
                    failureRef,
                    {
                        ...payload,
                        parseReason: "Low-confidence or empty general-data parse",
                    },
                    { merge: true }
                );
                failedCount += 1;
                failedCountDelta += 1;
                totalCountDelta += 1;
            } catch (err) {
                failedCount += 1;
                if (sampleErrors.length < 8) sampleErrors.push(err?.message || String(err));
            }
        }

        const nextParsedCount = Math.max(
            0,
            Number(storedCounts.parsedDocumentCount || 0) + parsedCountDelta
        );
        const nextFailedCount = Math.max(
            0,
            Number(storedCounts.failedDocumentCount || 0) + failedCountDelta
        );
        const nextTotalCount = Math.max(
            0,
            Number(storedCounts.totalDocumentCount || 0) + totalCountDelta
        );

        const latestRun = {
            runId,
            finishedAt: nowIso,
            syncDays,
            processed,
            writeCount,
            failedCount,
            skipped,
            existingSkipped,
        };

        batch.set(
            generalRunDoc(db, tenantId, runId),
            buildGeneralOwnedPayload(tenantId, {
                pipelineType: "general_data",
                processed,
                writeCount,
                failedCount,
                skipped,
                existingSkipped,
                syncDays,
                maxMessages,
                queries,
                finishedAt: nowIso,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedBy: actorUid,
                sampleErrors,
            }),
            { merge: true }
        );

        batch.set(
            generalSettingsDoc(db, tenantId),
            buildGeneralOwnedPayload(tenantId, {
                enabled: settings.enabled !== false,
                syncDays,
                maxMessagesDefault: parseBoundedInt(settings.maxMessagesDefault, {
                    fallback: maxMessages,
                    min: 1,
                    max: 100,
                }),
                allowlist,
                allowlistCount,
                lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
                lastSyncCompletedAt: nowIso,
                summary: {
                    allowlistCount,
                    parsedDocumentCount: nextParsedCount,
                    failedDocumentCount: nextFailedCount,
                    totalDocumentCount: nextTotalCount,
                    latestRun,
                },
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedBy: actorUid,
            }),
            { merge: true }
        );

        await batch.commit();

        return res.json({
            ok: true,
            pipelineType: "general_data",
            syncDays,
            processed,
            writeCount,
            failedCount,
            skipped,
            existingSkipped,
            queries,
            sampleErrors,
        });
    } catch (err) {
        console.error("general-data/google/sync error", err);
        return res.status(500).json({ ok: false, error: err?.message || "General data sync failed" });
    }
});

module.exports = router;