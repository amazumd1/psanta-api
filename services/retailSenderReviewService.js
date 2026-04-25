const crypto = require("crypto");
const { admin, getFirestore } = require("../lib/firebaseAdmin");
const {
  retailAllowlistCollection,
  retailAllowlistDoc,
  retailSettingsDoc,
  retailSenderSuggestionsCollection,
  retailSenderSuggestionDoc,
  buildRetailOwnedPayload,
} = require("../lib/retailPaths");
const { learnBiCategoryMemory } = require("./businessIntelligence/biCategoryMemoryService");

function normalizeIntInRange(value, fallback = 20, min = 1, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function uniqueStrings(list = []) {
  return Array.from(
    new Set(
      (Array.isArray(list) ? list : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
}

function normalizeEmailEntry(value) {
  const raw = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : "";
}

function normalizeDomainEntry(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/^@+/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(raw) ? raw : "";
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

function extractSenderEmail(fromHeader = "") {
  const raw = String(fromHeader || "").trim().toLowerCase();
  if (!raw) return "";

  const angle = raw.match(/<([^>]+)>/);
  const candidate =
    angle?.[1] ||
    raw.split(/[\s,]+/).find((part) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part)) ||
    raw;

  const clean = String(candidate)
    .replace(/^mailto:/, "")
    .replace(/[<>"']/g, "")
    .trim();

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? clean : "";
}

function extractSenderDomain(fromHeader = "") {
  const email = extractSenderEmail(fromHeader);
  return normalizeDomainEntry(email.split("@")[1] || "");
}

function trimText(value, max = 12000) {
  return String(value == null ? "" : value).trim().slice(0, Math.max(0, Number(max) || 0));
}

function buildRetailAllowlistDocId(type = "email", pattern = "") {
  const raw = `${String(type || "email").trim().toLowerCase()}__${String(pattern || "").trim().toLowerCase()}`;
  return (
    raw
      .replace(/[^a-z0-9_.-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 220) || `allow__${crypto.randomUUID().slice(0, 12)}`
  );
}

function formatRetailAllowlistInput(allowlist = {}) {
  const emails = Array.isArray(allowlist?.emails) ? allowlist.emails : [];
  const domains = Array.isArray(allowlist?.domains) ? allowlist.domains.map((value) => `@${value}`) : [];
  return [...emails, ...domains].join("\n");
}

async function loadRetailAllowlistFromDb(retailOwnerId) {
  const db = getFirestore();

  const settingsSnap = await retailSettingsDoc(db, retailOwnerId).get().catch(() => null);
  const settingsAllowlist = normalizeAllowlist(settingsSnap?.data()?.allowlist || {});

  if (settingsAllowlist.emails.length || settingsAllowlist.domains.length) {
    return settingsAllowlist;
  }

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

async function listRetailSenderSuggestionRows(retailOwnerId, { status = "pending", limit = 20 } = {}) {
  const db = getFirestore();
  const safeLimit = normalizeIntInRange(limit, 20, 1, 250);
  const safeStatus = String(status || "pending").trim().toLowerCase();

  try {
    let qRef = retailSenderSuggestionsCollection(db, retailOwnerId)
      .orderBy("score", "desc")
      .limit(safeLimit);

    if (safeStatus && safeStatus !== "all") {
      qRef = retailSenderSuggestionsCollection(db, retailOwnerId)
        .where("status", "==", safeStatus)
        .orderBy("score", "desc")
        .limit(safeLimit);
    }

    const snap = await qRef.get();

    const rows = snap.docs
      .map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() || {}),
      }))
      .sort((a, b) => {
        const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
        if (scoreDiff !== 0) return scoreDiff;
        return Date.parse(b.lastSeenAt || b.updatedAt || 0) - Date.parse(a.lastSeenAt || a.updatedAt || 0);
      });

    return rows.slice(0, safeLimit);
  } catch (err) {
    const message = String(err?.details || err?.message || "");
    const isMissingIndex =
      Number(err?.code) === 9 ||
      message.includes("FAILED_PRECONDITION") ||
      message.toLowerCase().includes("requires an index");

    if (!isMissingIndex) {
      throw err;
    }

    console.warn(
      "[retail-sender-suggestions] missing composite index, falling back to legacy in-memory filter"
    );

    const fallbackSnap = await retailSenderSuggestionsCollection(db, retailOwnerId)
      .limit(Math.max(safeLimit * 3, 100))
      .get();

    let rows = fallbackSnap.docs.map((docSnap) => ({
      id: docSnap.id,
      ...(docSnap.data() || {}),
    }));

    if (safeStatus && safeStatus !== "all") {
      rows = rows.filter(
        (row) => String(row.status || "pending").trim().toLowerCase() === safeStatus
      );
    }

    rows.sort((a, b) => {
      const scoreDiff = Number(b.score || 0) - Number(a.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return Date.parse(b.lastSeenAt || b.updatedAt || 0) - Date.parse(a.lastSeenAt || a.updatedAt || 0);
    });

    return rows.slice(0, safeLimit);
  }
}

function isHighConfidence(row = {}) {
  const raw = String(row?.confidence || "").trim().toLowerCase();
  const score = Number(row?.score || 0);
  return /high|strong|approved_sender/.test(raw) || score >= 90;
}

function classifyBucketTone(label = "") {
  const raw = String(label || "").toLowerCase();
  if (/(1099|tax)/.test(raw)) return "violet";
  if (/(income|payout|rental)/.test(raw)) return "emerald";
  if (/(utility|maintenance|repair)/.test(raw)) return "amber";
  if (/(expense|invoice|professional|ops|service)/.test(raw)) return "sky";
  return "slate";
}

async function buildRetailSenderReviewSummary(retailOwnerId, { status = "pending", preview = 5, summaryLimit = 100 } = {}) {
  const rows = await listRetailSenderSuggestionRows(retailOwnerId, {
    status: status || "pending",
    limit: summaryLimit,
  });

  const categorizedCount = rows.filter((row) => String(row?.suggestedCategory || row?.primaryKind || "").trim()).length;
  const highConfidenceCount = rows.filter((row) => isHighConfidence(row)).length;
  const approvedCount = rows.filter((row) => String(row?.status || "").trim().toLowerCase() === "approved").length;
  const dismissedCount = rows.filter((row) => String(row?.status || "").trim().toLowerCase() === "dismissed").length;

  const bucketMap = rows.reduce((acc, row) => {
    const key = String(row?.suggestedCategory || row?.primaryKind || "Uncategorized").trim() || "Uncategorized";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const statusBuckets = {
    pending: rows.filter((row) => String(row?.status || "pending").trim().toLowerCase() === "pending").length,
    approved: approvedCount,
    dismissed: dismissedCount,
  };

  const topBuckets = Object.entries(bucketMap)
    .map(([label, count]) => ({ label, count, tone: classifyBucketTone(label) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const headline = rows.length
    ? `${rows.length} sender${rows.length === 1 ? "" : "s"} waiting for review`
    : "No pending sender review";
  const copy = rows.length
    ? "Approve trusted business senders to make future Gmail syncs cleaner and more automatic."
    : "No business-like Gmail senders are currently waiting in the sender-review queue.";

  return {
    total: rows.length,
    categorizedCount,
    highConfidenceCount,
    approvedCount,
    dismissedCount,
    headline,
    copy,
    statusBuckets,
    topBuckets,
    previewRows: rows.slice(0, normalizeIntInRange(preview, 5, 1, 20)),
  };
}

async function approveRetailSenderSuggestion(retailOwnerId, suggestionId, { mode = "email", actorUid = "", actorEmail = "" } = {}) {
  const db = getFirestore();
  const safeSuggestionId = String(suggestionId || "").trim();
  const safeMode = String(mode || "email").trim().toLowerCase() === "domain" ? "domain" : "email";

  if (!safeSuggestionId) {
    const err = new Error("Missing suggestionId");
    err.status = 400;
    throw err;
  }

  const suggestionRef = retailSenderSuggestionDoc(db, retailOwnerId, safeSuggestionId);
  const suggestionSnap = await suggestionRef.get();

  if (!suggestionSnap.exists) {
    const err = new Error("Sender suggestion not found");
    err.status = 404;
    throw err;
  }

  const suggestion = suggestionSnap.data() || {};
  const senderEmail = normalizeEmailEntry(suggestion.senderEmail || "");
  const senderDomain = normalizeDomainEntry(suggestion.senderDomain || extractSenderDomain(suggestion.senderEmail || ""));
  const pattern = safeMode === "domain" ? senderDomain : senderEmail;

  if (!pattern) {
    const err = new Error(`Suggestion missing a valid ${safeMode}`);
    err.status = 400;
    throw err;
  }

  const allowlist = await loadRetailAllowlistFromDb(retailOwnerId);
  const nextAllowlist = {
    emails: [...(allowlist.emails || [])],
    domains: [...(allowlist.domains || [])],
  };

  if (safeMode === "domain") {
    nextAllowlist.domains = uniqueStrings([...(nextAllowlist.domains || []), pattern]);
  } else {
    nextAllowlist.emails = uniqueStrings([...(nextAllowlist.emails || []), pattern]);
  }

  const allowDocId = buildRetailAllowlistDocId(safeMode, pattern);

  await Promise.all([
    retailAllowlistDoc(db, retailOwnerId, allowDocId).set(
      buildRetailOwnedPayload(retailOwnerId, {
        type: safeMode,
        pattern,
        note: `Approved from BI sender suggestion ${safeSuggestionId}`,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }),
      { merge: true }
    ),
    retailSettingsDoc(db, retailOwnerId).set(
      buildRetailOwnedPayload(retailOwnerId, {
        allowlist: normalizeAllowlist(nextAllowlist),
        allowlistInput: formatRetailAllowlistInput(nextAllowlist),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }),
      { merge: true }
    ),
    suggestionRef.set(
      buildRetailOwnedPayload(retailOwnerId, {
        status: "approved",
        approvedMode: safeMode,
        approvedPattern: pattern,
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }),
      { merge: true }
    ),
    learnBiCategoryMemory(getFirestore(), retailOwnerId, {
      senderEmail,
      senderDomain,
      category: suggestion.suggestedCategory || "General Ops",
      note: `Approved from BI sender suggestion ${safeSuggestionId}`,
      confidence: "approved_sender",
      source: safeMode === "domain" ? "sender_suggestion_domain_approval" : "sender_suggestion_email_approval",
      actorUid,
      actorEmail,
      keywordHints: Array.isArray(suggestion.reasons) ? suggestion.reasons.slice(0, 3) : [],
    }).catch(() => null),
  ]);

  return {
    suggestionId: safeSuggestionId,
    mode: safeMode,
    pattern,
    allowlist: normalizeAllowlist(nextAllowlist),
    suggestion,
  };
}

async function dismissRetailSenderSuggestion(retailOwnerId, suggestionId, { reason = "" } = {}) {
  const db = getFirestore();
  const safeSuggestionId = String(suggestionId || "").trim();
  if (!safeSuggestionId) {
    const err = new Error("Missing suggestionId");
    err.status = 400;
    throw err;
  }

  await retailSenderSuggestionDoc(db, retailOwnerId, safeSuggestionId).set(
    buildRetailOwnedPayload(retailOwnerId, {
      status: "dismissed",
      dismissedReason: trimText(reason || "", 240) || "dismissed_in_bi",
      dismissedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }),
    { merge: true }
  );

  return { suggestionId: safeSuggestionId, status: "dismissed" };
}

module.exports = {
  listRetailSenderSuggestionRows,
  buildRetailSenderReviewSummary,
  approveRetailSenderSuggestion,
  dismissRetailSenderSuggestion,
};