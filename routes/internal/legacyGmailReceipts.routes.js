const express = require("express");
const jwt = require("jsonwebtoken");
const { auth } = require("../../middleware/auth");
const { requireTenantAccess, getActorFirebaseUid } = require("../../middleware/tenantAccess");
const { getFirestore, serverTimestamp } = require("../../lib/firebaseAdminApp");
const { tenantDoc, tenantCollection } = require("../../lib/tenantFirestore");
const { encryptString, decryptString } = require("../../lib/oauthTokenCrypto");

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

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const STATE_TTL = "10m";

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
  s = s.replace(/^@\*/, "").replace(/^@/, "").replace(/^\*\./, "").replace(/^www\./, "");
  s = s.replace(/^https?:\/\//, "").split("/")[0].trim();
  if (!s) return "";
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s) ? s : "";
}

function normalizeAllowlist(value = {}) {
  if (typeof value === "string") {
    const tokens = value.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
    const emails = uniqueStrings(tokens.map(normalizeEmailEntry).filter(Boolean));
    const domains = uniqueStrings(
      tokens
        .filter((x) => !x.includes("@") || x.startsWith("@"))
        .map(normalizeDomainEntry)
        .filter(Boolean)
    );
    return { emails, domains };
  }

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

function normalizeSettingsPayload(raw = {}) {
  return {
    lane: String(raw?.lane || "").trim(),
    yearScope: String(raw?.yearScope || "").trim(),
    allowlist: normalizeAllowlist(raw?.allowlist || {}),
  };
}

async function getSettingsRef(db, tenantId, userId) {
  return tenantDoc(db, tenantId, "gmailReceiptSettings", userId);
}

async function loadSavedSettings(db, tenantId, userId) {
  const ref = await getSettingsRef(db, tenantId, userId);
  const snap = await ref.get();
  const row = snap.exists ? snap.data() || {} : {};

  return {
    lane: String(row.lane || "").trim(),
    yearScope: String(row.yearScope || "").trim(),
    allowlist: normalizeAllowlist(row.allowlist || {}),
  };
}

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

function getOAuthConfig() {
  const clientId = envFirst(
    "RETAIL_GMAIL_CLIENT_ID",
    "GOOGLE_GMAIL_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_ID"
  );
  const clientSecret = envFirst(
    "RETAIL_GMAIL_CLIENT_SECRET",
    "GOOGLE_GMAIL_CLIENT_SECRET",
    "GOOGLE_OAUTH_CLIENT_SECRET"
  );
  const redirectUri = envFirst(
    "RETAIL_GMAIL_REDIRECT_URI",
    "GOOGLE_GMAIL_REDIRECT_URI",
    "RETAIL_GMAIL_OAUTH_REDIRECT_URI"
  );

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Missing RETAIL_GMAIL_CLIENT_ID / RETAIL_GMAIL_CLIENT_SECRET / RETAIL_GMAIL_REDIRECT_URI"
    );
  }

  return { clientId, clientSecret, redirectUri };
}

function getStateSecret() {
  return env("GOOGLE_GMAIL_STATE_SECRET") || env("JWT_SECRET");
}

function getDefaultReturnTo() {
  return (
    envFirst("RETAIL_GMAIL_SUCCESS_URL", "FRONTEND_APP_URL", "APP_URL") ||
    "http://localhost:3004/retail-receipts/setup"
  );
}

function isAllowedReturnTo(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;

  if (/^http:\/\/localhost:\d+/i.test(raw)) return true;
  if (/^http:\/\/127\.0\.0\.1:\d+/i.test(raw)) return true;

  const exactAllowed = (env("CORS_ORIGINS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (exactAllowed.includes(raw)) return true;
  if (/^https:\/\/psanta-warehouse(?:-[a-z0-9-]+)?\.vercel\.app/i.test(raw)) return true;
  if (/^https:\/\/psanta-ops-app(?:-[a-z0-9-]+)?\.vercel\.app/i.test(raw)) return true;

  return false;
}

function sanitizeReturnTo(value) {
  const raw = String(value || "").trim();
  if (!raw) return getDefaultReturnTo();
  return isAllowedReturnTo(raw) ? raw : getDefaultReturnTo();
}

function buildRequestedScopes() {
  return ["https://www.googleapis.com/auth/gmail.readonly"];
}

function toArrayScopes(value) {
  return String(value || "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function signState(payload) {
  const secret = getStateSecret();
  if (!secret) {
    throw new Error("GOOGLE_GMAIL_STATE_SECRET or JWT_SECRET is required");
  }

  return jwt.sign(payload, secret, { expiresIn: STATE_TTL });
}

function verifyState(state) {
  const secret = getStateSecret();
  if (!secret) {
    throw new Error("GOOGLE_GMAIL_STATE_SECRET or JWT_SECRET is required");
  }

  return jwt.verify(String(state || ""), secret);
}

async function postForm(url, formBody) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(formBody),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(data?.error_description || data?.error || `Request failed with ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }

  return data || {};
}

async function gmailFetch(accessToken, path, init = {}) {
  const res = await fetch(`${GMAIL_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(data?.error?.message || `Gmail API failed with ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }

  return data || {};
}

async function exchangeAuthorizationCode(code) {
  const { clientId, clientSecret, redirectUri } = getOAuthConfig();

  return postForm(GOOGLE_TOKEN_URL, {
    code: String(code || ""),
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
}

async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = getOAuthConfig();

  return postForm(GOOGLE_TOKEN_URL, {
    refresh_token: String(refreshToken || ""),
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
}

async function getConnectionRef(db, tenantId, userId) {
  return tenantDoc(db, tenantId, "gmailConnections", userId);
}

function appendQueryParams(target, params = {}) {
  const safeTarget = sanitizeReturnTo(target);
  const url = new URL(safeTarget);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

async function writeAuditLog(db, tenantId, payload = {}) {
  try {
    await tenantCollection(db, tenantId, "auditLogs").add({
      area: "gmail_receipts",
      actorUserId: String(payload.actorUserId || "").trim() || null,
      actorFirebaseUid: String(payload.actorFirebaseUid || "").trim() || null,
      action: String(payload.action || "").trim() || "unknown",
      message: String(payload.message || "").trim() || "",
      meta: payload.meta || {},
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("gmail audit log failed:", err);
  }
}

async function createMailboxWatch({ accessToken }) {
  const topicName = env("GOOGLE_GMAIL_PUBSUB_TOPIC");
  if (!topicName) return null;

  const watchBody = { topicName };

  return gmailFetch(accessToken, "/watch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(watchBody),
  });
}

async function stopMailboxWatch({ accessToken }) {
  return gmailFetch(accessToken, "/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

async function loadConnectionOrThrow(db, tenantId, userId) {
  const ref = await getConnectionRef(db, tenantId, userId);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error("GMAIL_NOT_CONNECTED");
    err.status = 404;
    throw err;
  }
  return { ref, snap, data: snap.data() || {} };
}

async function getUsableAccessToken(db, tenantId, userId) {
  const { ref, data } = await loadConnectionOrThrow(db, tenantId, userId);
  const expiresAt = Number(data.accessTokenExpiresAt || 0);
  const now = Date.now();

  if (data.accessTokenEnc && expiresAt > now + 60 * 1000) {
    return {
      accessToken: decryptString(data.accessTokenEnc),
      connectionRef: ref,
      connection: data,
    };
  }

  const refreshToken = decryptString(data.refreshTokenEnc);
  if (!refreshToken) {
    const err = new Error("GMAIL_REFRESH_TOKEN_MISSING");
    err.status = 400;
    throw err;
  }

  const refreshed = await refreshAccessToken(refreshToken);
  const nextAccessToken = String(refreshed.access_token || "");
  const nextRefreshToken = String(refreshed.refresh_token || "");
  const nextExpiresAt = Date.now() + Number(refreshed.expires_in || 3600) * 1000;

  await ref.set(
    {
      accessTokenEnc: encryptString(nextAccessToken),
      accessTokenExpiresAt: nextExpiresAt,
      ...(nextRefreshToken
        ? {
          refreshTokenEnc: encryptString(nextRefreshToken),
          refreshTokenUpdatedAt: serverTimestamp(),
        }
        : {}),
      updatedAt: serverTimestamp(),
      tokenRefreshedAt: serverTimestamp(),
    },
    { merge: true }
  );

  return {
    accessToken: nextAccessToken,
    connectionRef: ref,
    connection: {
      ...data,
      accessTokenExpiresAt: nextExpiresAt,
      accessTokenEnc: encryptString(nextAccessToken),
    },
  };
}

async function enqueueSyncJob(db, tenantId, payload = {}) {
  const ref = tenantCollection(db, tenantId, "gmailReceiptSyncJobs").doc();
  const nowMs = Date.now();

  const job = {
    id: ref.id,
    tenantId,
    status: "queued",
    kind: "gmail_receipt_sync",
    trigger: String(payload.trigger || "manual"),
    gmailConnectionUserId: String(payload.gmailConnectionUserId || ""),
    accountEmail: String(payload.accountEmail || "").trim().toLowerCase(),
    startHistoryId: payload.startHistoryId ? String(payload.startHistoryId) : null,
    targetHistoryId: payload.targetHistoryId ? String(payload.targetHistoryId) : null,
    filters: payload.filters || {},
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdAtMs: nowMs,
  };

  await ref.set(job);
  return job;
}

router.get("/connect-url", auth, requireTenantAccess, async (req, res) => {
  try {
    const { clientId, redirectUri } = getOAuthConfig();
    const returnTo = sanitizeReturnTo(req.query.returnTo || req.body?.returnTo || getDefaultReturnTo());
    const setup = {
      lane: String(req.query.lane || req.body?.lane || "").trim(),
      mailScope: String(req.query.mailScope || req.body?.mailScope || "").trim(),
      yearScope: String(req.query.yearScope || req.body?.yearScope || "").trim(),
    };

    const state = signState({
      userId: req.userId,
      firebaseUid: getActorFirebaseUid(req) || "",
      tenantId: req.tenantId,
      returnTo,
      setup,
      nonce: Math.random().toString(36).slice(2),
    });

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("scope", buildRequestedScopes().join(" "));
    url.searchParams.set("state", state);

    return res.json({
      ok: true,
      url: url.toString(),
      scopes: buildRequestedScopes(),
      tenantId: req.tenantId,
    });
  } catch (err) {
    console.error("gmail connect-url failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Could not build Gmail connect URL",
    });
  }
});

router.get("/callback", async (req, res) => {
  const fallbackReturnTo = getDefaultReturnTo();

  try {
    const code = String(req.query.code || "").trim();
    const state = String(req.query.state || "").trim();
    const oauthError = String(req.query.error || "").trim();

    if (oauthError) {
      return res.redirect(appendQueryParams(fallbackReturnTo, { gmail: "error", reason: oauthError }));
    }

    if (!code || !state) {
      return res.redirect(appendQueryParams(fallbackReturnTo, { gmail: "error", reason: "missing_code_or_state" }));
    }

    const decoded = verifyState(state);
    const returnTo = sanitizeReturnTo(decoded.returnTo || fallbackReturnTo);
    const tenantId = String(decoded.tenantId || "").trim();
    const userId = String(decoded.userId || "").trim();
    const firebaseUid = String(decoded.firebaseUid || "").trim();

    if (!tenantId || !userId) {
      return res.redirect(appendQueryParams(returnTo, { gmail: "error", reason: "invalid_state_payload" }));
    }

    const db = getFirestore();

    if (firebaseUid) {
      const memberSnap = await db
        .collection("tenants")
        .doc(tenantId)
        .collection("members")
        .doc(firebaseUid)
        .get();

      if (!memberSnap.exists) {
        return res.redirect(appendQueryParams(returnTo, { gmail: "error", reason: "tenant_membership_missing" }));
      }
    }

    const tokenData = await exchangeAuthorizationCode(code);
    const accessToken = String(tokenData.access_token || "");
    const refreshToken = String(tokenData.refresh_token || "");
    const grantedScopes = toArrayScopes(tokenData.scope);
    const expiresAt = Date.now() + Number(tokenData.expires_in || 3600) * 1000;

    const connectionRef = await getConnectionRef(db, tenantId, userId);
    const existingSnap = await connectionRef.get();
    const existing = existingSnap.exists ? existingSnap.data() || {} : {};

    const gmailProfile = await gmailFetch(accessToken, "/profile");
    const accountEmail = String(gmailProfile.emailAddress || "").trim().toLowerCase();

    let watch = null;
    try {
      watch = await createMailboxWatch({ accessToken });
    } catch (watchErr) {
      console.error("gmail watch setup failed:", watchErr);
    }

    await connectionRef.set(
      {
        kind: "gmail_connection",
        provider: "google",
        status: "connected",
        tenantId,
        userId,
        firebaseUid: firebaseUid || null,
        accountEmail,
        grantedScopes,
        refreshTokenEnc: refreshToken
          ? encryptString(refreshToken)
          : existing.refreshTokenEnc || null,
        refreshTokenUpdatedAt: refreshToken ? serverTimestamp() : existing.refreshTokenUpdatedAt || null,
        accessTokenEnc: encryptString(accessToken),
        accessTokenExpiresAt: expiresAt,
        initialSetup: decoded.setup || {},
        lastKnownHistoryId: String(gmailProfile.historyId || watch?.historyId || existing.lastKnownHistoryId || "") || null,
        watch: watch
          ? {
            enabled: true,
            topicName: env("GOOGLE_GMAIL_PUBSUB_TOPIC"),
            expiration: Number(watch.expiration || 0) || null,
            historyId: String(watch.historyId || "") || null,
            updatedAtMs: Date.now(),
          }
          : existing.watch || { enabled: false },
        connectedAt: existing.connectedAt || serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    await writeAuditLog(db, tenantId, {
      actorUserId: userId,
      actorFirebaseUid: firebaseUid,
      action: "gmail_connected",
      message: `Connected Gmail account ${accountEmail}`,
      meta: { accountEmail, grantedScopes },
    });

    return res.redirect(
      appendQueryParams(returnTo, {
        gmail: "connected",
        gmailEmail: accountEmail,
      })
    );
  } catch (err) {
    console.error("gmail callback failed:", err);
    return res.redirect(
      appendQueryParams(fallbackReturnTo, {
        gmail: "error",
        reason: err.message || "oauth_callback_failed",
      })
    );
  }
});

router.get("/settings", auth, requireTenantAccess, async (req, res) => {
  try {
    const db = getFirestore();
    const settings = await loadSavedSettings(db, req.tenantId, req.userId);
    return res.json({ ok: true, settings });
  } catch (err) {
    console.error("gmail settings load failed:", err);
    return res.status(500).json({ ok: false, error: "Could not load Gmail settings" });
  }
});

router.post("/settings", auth, requireTenantAccess, async (req, res) => {
  try {
    const db = getFirestore();
    const ref = await getSettingsRef(db, req.tenantId, req.userId);
    const settings = normalizeSettingsPayload(req.body || {});
    const existing = await ref.get();

    await ref.set(
      {
        tenantId: req.tenantId,
        userId: req.userId,
        lane: settings.lane || null,
        yearScope: settings.yearScope || null,
        allowlist: settings.allowlist,
        updatedAt: serverTimestamp(),
        ...(existing.exists ? {} : { createdAt: serverTimestamp() }),
      },
      { merge: true }
    );

    return res.json({ ok: true, settings });
  } catch (err) {
    console.error("gmail settings save failed:", err);
    return res.status(500).json({ ok: false, error: "Could not save Gmail settings" });
  }
});

router.get("/status", auth, requireTenantAccess, async (req, res) => {
  try {
    const db = getFirestore();
    const { data } = await loadConnectionOrThrow(db, req.tenantId, req.userId);

    return res.json({
      ok: true,
      connected: data.status === "connected",
      connection: {
        accountEmail: data.accountEmail || null,
        grantedScopes: Array.isArray(data.grantedScopes) ? data.grantedScopes : [],
        status: data.status || "disconnected",
        watchEnabled: !!data.watch?.enabled,
        watchExpiration: data.watch?.expiration || null,
        lastKnownHistoryId: data.lastKnownHistoryId || null,
        lastNotifiedHistoryId: data.lastNotifiedHistoryId || null,
        lastSuccessfulSyncAt: data.lastSuccessfulSyncAt || null,
        initialSetup: data.initialSetup || {},
      },
    });
  } catch (err) {
    if (err.message === "GMAIL_NOT_CONNECTED") {
      return res.json({ ok: true, connected: false, connection: null });
    }

    console.error("gmail status failed:", err);
    return res.status(500).json({ ok: false, error: "Could not load Gmail status" });
  }
});

router.post("/sync", auth, requireTenantAccess, async (req, res) => {
  try {
    const db = getFirestore();
    const { data, ref } = await loadConnectionOrThrow(db, req.tenantId, req.userId);

    const savedSettings = await loadSavedSettings(db, req.tenantId, req.userId);
    const incomingAllowlist = normalizeAllowlist(req.body?.allowlist || {});
    const effectiveAllowlist =
      incomingAllowlist.emails.length || incomingAllowlist.domains.length
        ? incomingAllowlist
        : normalizeAllowlist(savedSettings.allowlist || {});

    const job = await enqueueSyncJob(db, req.tenantId, {
      trigger: req.body?.trigger || "manual",
      gmailConnectionUserId: req.userId,
      accountEmail: data.accountEmail,
      startHistoryId: data.lastProcessedHistoryId || data.lastKnownHistoryId || null,
      filters: {
        lane: req.body?.lane || savedSettings.lane || data.initialSetup?.lane || "",
        yearScope: req.body?.yearScope || savedSettings.yearScope || data.initialSetup?.yearScope || "",
        allowlist: effectiveAllowlist,
      },
    });

    await ref.set(
      {
        syncState: "queued",
        lastQueuedSyncAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ ok: true, queued: true, job });
  } catch (err) {
    console.error("gmail sync queue failed:", err);
    return res.status(err.status || 500).json({ ok: false, error: err.message || "Could not queue Gmail sync" });
  }
});

router.post("/watch/refresh", auth, requireTenantAccess, async (req, res) => {
  try {
    const db = getFirestore();
    const { accessToken, connectionRef } = await getUsableAccessToken(db, req.tenantId, req.userId);
    const watch = await createMailboxWatch({ accessToken });

    if (!watch) {
      return res.status(400).json({
        ok: false,
        error: "GOOGLE_GMAIL_PUBSUB_TOPIC is not configured",
      });
    }

    await connectionRef.set(
      {
        watch: {
          enabled: true,
          topicName: env("GOOGLE_GMAIL_PUBSUB_TOPIC"),
          expiration: Number(watch.expiration || 0) || null,
          historyId: String(watch.historyId || "") || null,
          updatedAtMs: Date.now(),
        },
        lastKnownHistoryId: String(watch.historyId || "") || null,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({ ok: true, watch });
  } catch (err) {
    console.error("gmail watch refresh failed:", err);
    return res.status(err.status || 500).json({ ok: false, error: err.message || "Could not refresh Gmail watch" });
  }
});

router.post("/disconnect", auth, requireTenantAccess, async (req, res) => {
  try {
    const db = getFirestore();
    const { accessToken, connectionRef, connection } = await getUsableAccessToken(db, req.tenantId, req.userId);

    try {
      await stopMailboxWatch({ accessToken });
    } catch (stopErr) {
      console.error("gmail stop watch failed:", stopErr);
    }

    await connectionRef.set(
      {
        status: "disconnected",
        refreshTokenEnc: null,
        accessTokenEnc: null,
        accessTokenExpiresAt: null,
        watch: { enabled: false, expiration: null, topicName: null },
        disconnectedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    await writeAuditLog(db, req.tenantId, {
      actorUserId: req.userId,
      actorFirebaseUid: getActorFirebaseUid(req),
      action: "gmail_disconnected",
      message: `Disconnected Gmail account ${connection.accountEmail || ""}`,
      meta: { accountEmail: connection.accountEmail || null },
    });

    return res.json({ ok: true, disconnected: true });
  } catch (err) {
    console.error("gmail disconnect failed:", err);
    return res.status(err.status || 500).json({ ok: false, error: err.message || "Could not disconnect Gmail" });
  }
});

router.post("/pubsub", async (req, res) => {
  try {
    const verificationToken = env("GOOGLE_GMAIL_PUBSUB_WEBHOOK_TOKEN");
    const provided = String(req.query.token || req.headers["x-webhook-token"] || "").trim();

    if (verificationToken && provided !== verificationToken) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_token" });
    }

    const encoded = req.body?.message?.data;
    if (!encoded) {
      return res.status(200).json({ ok: true, ignored: true, reason: "missing_message_data" });
    }

    const decoded = JSON.parse(Buffer.from(String(encoded), "base64url").toString("utf8"));
    const emailAddress = String(decoded.emailAddress || "").trim().toLowerCase();
    const historyId = String(decoded.historyId || "").trim();

    if (!emailAddress || !historyId) {
      return res.status(200).json({ ok: true, ignored: true, reason: "invalid_notification_payload" });
    }

    const db = getFirestore();
    const snaps = await db.collectionGroup("gmailConnections").where("accountEmail", "==", emailAddress).get();

    if (snaps.empty) {
      return res.status(200).json({ ok: true, ignored: true, reason: "connection_not_found" });
    }

    for (const doc of snaps.docs) {
      const data = doc.data() || {};
      if (String(data.status || "") !== "connected") continue;

      await doc.ref.set(
        {
          lastNotifiedHistoryId: historyId,
          lastWebhookReceivedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      await enqueueSyncJob(db, data.tenantId, {
        trigger: "gmail_pubsub",
        gmailConnectionUserId: data.userId,
        accountEmail: emailAddress,
        startHistoryId: data.lastProcessedHistoryId || data.lastKnownHistoryId || null,
        targetHistoryId: historyId,
        filters: data.initialSetup || {},
      });
    }

    return res.status(200).json({ ok: true, enqueued: snaps.size, emailAddress, historyId });
  } catch (err) {
    console.error("gmail pubsub webhook failed:", err);
    return res.status(500).json({ ok: false, error: "gmail_pubsub_failed" });
  }
});

module.exports = router;