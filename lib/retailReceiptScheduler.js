const { admin, getFirestore } = require("./firebaseAdmin");
const {
  retailConnectionDoc,
  retailSettingsDoc,
  buildRetailOwnedPayload,
  RETAIL_CONNECTIONS_COLLECTION,
} = require("./retailPaths");

const DEFAULT_TICK_MINUTES = (() => {
  const n = Number(process.env.RETAIL_AUTO_SCHEDULER_TICK_MINUTES || 15);
  if (!Number.isFinite(n)) return 15;
  return Math.max(1, Math.min(1440, Math.trunc(n)));
})();

const DEFAULT_BATCH_LIMIT = (() => {
  const n = Number(process.env.RETAIL_AUTO_SCHEDULER_BATCH_LIMIT || 5);
  if (!Number.isFinite(n)) return 25;
  return Math.max(1, Math.min(100, Math.trunc(n)));
})();

const state = {
  started: false,
  enabled: false,
  tickMinutes: DEFAULT_TICK_MINUTES,
  intervalId: null,
  inFlight: false,
  lastTickStartedAt: "",
  lastTickCompletedAt: "",
  lastSummary: null,
  lastError: "",
  registeredRunner: false,
  disabledReason: "",
};

let syncRunner = null;

function normalizeIntInRange(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (value?._seconds != null) {
    return Number(value._seconds) * 1000 + Math.trunc(Number(value._nanoseconds || 0) / 1e6);
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function isoNow() {
  return new Date().toISOString();
}

function shouldRunByAge(lastMs, intervalMs, force) {
  if (force) return true;
  if (!lastMs) return true;
  return Date.now() - lastMs >= intervalMs;
}

function registerRetailSyncRunner(fn) {
  syncRunner = typeof fn === "function" ? fn : null;
  state.registeredRunner = !!syncRunner;
}

function buildRetailAutoSchedulerConfig(settings = {}) {
  const auto = settings?.autoScheduler || {};
  const backfillStartDaysAgo = normalizeIntInRange(auto.backfillStartDaysAgo, 30, 1, 3650);
  const backfillChunkDays = normalizeIntInRange(auto.backfillChunkDays, 30, 7, 365);

  const envRecentEveryMinutes = normalizeIntInRange(
    process.env.RETAIL_AUTO_RECENT_EVERY_MINUTES,
    5,
    5,
    1440
  );

  const recentEveryMinutes = normalizeIntInRange(
    auto.recentEveryMinutes,
    envRecentEveryMinutes,
    5,
    1440
  );

  return {
    enabled: auto.enabled !== false,
    recentEveryMinutes,
    recentDays: normalizeIntInRange(auto.recentDays, 3, 1, 30),
    recentMaxMessages: Math.max(
      35,
      normalizeIntInRange(
        auto.recentMaxMessages,
        Math.max(35, normalizeIntInRange(settings.maxMessagesDefault, 35, 1, 50)),
        1,
        50
      )
    ),
    backfillEveryDays: normalizeIntInRange(auto.backfillEveryDays, 7, 1, 60),
    backfillStartDaysAgo,
    nextBackfillStartDaysAgo: normalizeIntInRange(
      auto.nextBackfillStartDaysAgo,
      backfillStartDaysAgo,
      1,
      3650
    ),
    backfillChunkDays,
    backfillMaxDays: normalizeIntInRange(
      auto.backfillMaxDays,
      360,
      backfillStartDaysAgo + backfillChunkDays,
      3650
    ),
    backfillMaxMessages: Math.max(
      50,
      normalizeIntInRange(
        auto.backfillMaxMessages,
        Math.max(50, normalizeIntInRange(settings.maxMessagesDefault, 50, 1, 50)),
        1,
        50
      )
    ),
    syncOverlapMinutes: normalizeIntInRange(
      settings.syncOverlapMinutes,
      normalizeIntInRange(process.env.RETAIL_GMAIL_SYNC_OVERLAP_MINUTES, 15, 0, 1440),
      0,
      1440
    ),
    skipProcessed: settings.skipProcessed !== false,
    processedLabel: String(settings.processedLabel || process.env.RETAIL_GMAIL_IMPORTED_LABEL || "RECEIPT_IMPORTED").trim() || "RECEIPT_IMPORTED",
    receiptsLabel: String(settings.receiptsLabel || process.env.RETAIL_GMAIL_RECEIPTS_LABEL || "Auto/Receipts").trim() || "Auto/Receipts",
    lastAutoRecentAtMs: toMillis(auto.lastAutoRecentAt),
    lastAutoBackfillAtMs: toMillis(auto.lastAutoBackfillAt),
  };
}

function buildBackfillWindow(config) {
  const minDaysAgo = Math.max(config.backfillStartDaysAgo, config.nextBackfillStartDaysAgo);
  const maxDaysAgo = Math.min(config.backfillMaxDays, minDaysAgo + config.backfillChunkDays);
  if (maxDaysAgo <= minDaysAgo) return null;
  return { minDaysAgo, maxDaysAgo };
}

function advanceBackfillPointer(config, currentWindow) {
  const nextStart = currentWindow.maxDaysAgo;
  if (nextStart >= config.backfillMaxDays) {
    return config.backfillStartDaysAgo;
  }
  return nextStart;
}

async function listConnectedRetailOwners({ retailOwnerId = "", limit = DEFAULT_BATCH_LIMIT } = {}) {
  const db = getFirestore();
  if (retailOwnerId) {
    const connSnap = await retailConnectionDoc(db, retailOwnerId).get();
    if (!connSnap.exists) return [];
    return [{ retailOwnerId, connectionSnap: connSnap }];
  }

  const snap = await db.collectionGroup(RETAIL_CONNECTIONS_COLLECTION).get();
  const out = [];

  snap.forEach((docSnap) => {
    if (docSnap.id !== "main") return;
    const parentDoc = docSnap.ref.parent.parent;
    if (!parentDoc) return;

    const ownerId = String(parentDoc.id || "").trim();
    if (!ownerId) return;

    const data = docSnap.data() || {};
    if (!data?.refreshTokenEncrypted?.data) return;

    out.push({ retailOwnerId: ownerId, connectionSnap: docSnap });
  });

  out.sort((a, b) => {
    const aMs = toMillis(a.connectionSnap.data()?.lastSyncAt || a.connectionSnap.data()?.connectedAt);
    const bMs = toMillis(b.connectionSnap.data()?.lastSyncAt || b.connectionSnap.data()?.connectedAt);
    return aMs - bMs;
  });

  return out.slice(0, Math.max(1, Math.min(100, Number(limit || DEFAULT_BATCH_LIMIT))));
}

async function updateAutoSchedulerState(retailOwnerId, nextAutoScheduler) {
  const db = getFirestore();
  await retailSettingsDoc(db, retailOwnerId).set(
    buildRetailOwnedPayload(retailOwnerId, {
      autoScheduler: nextAutoScheduler,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }),
    { merge: true }
  );
}

async function runRetailReceiptSchedulerPass({
  mode = "all",
  limit = DEFAULT_BATCH_LIMIT,
  retailOwnerId = "",
  dry = false,
  force = false,
  source = "manual",
} = {}) {
  if (!syncRunner) {
    throw new Error("Retail scheduler sync runner is not registered");
  }

  if (state.inFlight) {
    return {
      ok: false,
      error: "scheduler_busy",
      message: "Retail receipt scheduler is already running",
    };
  }

  const safeMode = ["all", "recent", "backfill"].includes(String(mode || "").trim())
    ? String(mode || "").trim()
    : "all";

  state.inFlight = true;
  state.lastTickStartedAt = isoNow();
  state.lastError = "";

  const summary = {
    ok: true,
    mode: safeMode,
    dry: !!dry,
    force: !!force,
    source: String(source || "manual"),
    startedAt: state.lastTickStartedAt,
    considered: 0,
    recentRuns: 0,
    backfillRuns: 0,
    skipped: 0,
    errors: [],
    owners: [],
  };

  try {
    const owners = await listConnectedRetailOwners({ retailOwnerId, limit });
    summary.considered = owners.length;

    const db = getFirestore();

    for (const item of owners) {
      const ownerId = item.retailOwnerId;
      const settingsSnap = await retailSettingsDoc(db, ownerId).get().catch(() => null);
      const settings = settingsSnap?.exists ? settingsSnap.data() || {} : {};
      const config = buildRetailAutoSchedulerConfig(settings);

      const ownerSummary = {
        retailOwnerId: ownerId,
        recent: null,
        backfill: null,
        skipped: false,
      };

      if (!config.enabled) {
        ownerSummary.skipped = true;
        ownerSummary.reason = "auto_scheduler_disabled";
        summary.skipped += 1;
        summary.owners.push(ownerSummary);
        continue;
      }

      const recentDue = (safeMode === "all" || safeMode === "recent") && shouldRunByAge(
        config.lastAutoRecentAtMs,
        config.recentEveryMinutes * 60 * 1000,
        force || !!retailOwnerId
      );

      const backfillDue = (safeMode === "all" || safeMode === "backfill") && shouldRunByAge(
        config.lastAutoBackfillAtMs,
        config.backfillEveryDays * 24 * 60 * 60 * 1000,
        force || !!retailOwnerId
      );

      if (!recentDue && !backfillDue) {
        ownerSummary.skipped = true;
        ownerSummary.reason = "not_due";
        summary.skipped += 1;
        summary.owners.push(ownerSummary);
        continue;
      }

      const nextAutoScheduler = {
        ...settings.autoScheduler,
        enabled: config.enabled,
        recentEveryMinutes: config.recentEveryMinutes,
        recentEveryHours: Math.max(1, Math.ceil(config.recentEveryMinutes / 60)),
        recentDays: config.recentDays,
        recentMaxMessages: config.recentMaxMessages,
        backfillEveryDays: config.backfillEveryDays,
        backfillStartDaysAgo: config.backfillStartDaysAgo,
        nextBackfillStartDaysAgo: config.nextBackfillStartDaysAgo,
        backfillChunkDays: config.backfillChunkDays,
        backfillMaxDays: config.backfillMaxDays,
        backfillMaxMessages: config.backfillMaxMessages,
        lastRunSource: String(source || "manual"),
      };

      if (recentDue) {
        try {
          const result = await syncRunner({
            retailOwnerId: ownerId,
            body: {
              days: config.recentDays,
              maxMessages: config.recentMaxMessages,
              skipProcessed: config.skipProcessed,
              processedLabel: config.processedLabel,
              receiptsLabel: config.receiptsLabel,
              syncOverlapMinutes: config.syncOverlapMinutes,
              ignoreCursor: false,
              dry,
            },
            trigger: "scheduler_recent",
          });

          ownerSummary.recent = {
            ok: true,
            runId: result.runId,
            matched: result.matched,
            requested: result.requested,
          };
          summary.recentRuns += 1;
          nextAutoScheduler.lastAutoRecentAt = admin.firestore.FieldValue.serverTimestamp();
          nextAutoScheduler.lastRunAt = admin.firestore.FieldValue.serverTimestamp();
          nextAutoScheduler.lastRunMode = "recent";
          nextAutoScheduler.lastRunSummary = {
            type: "recent",
            ok: true,
            runId: result.runId,
            matched: result.matched,
            requested: result.requested,
            at: admin.firestore.FieldValue.serverTimestamp(),
          };
        } catch (err) {
          ownerSummary.recent = { ok: false, error: err.message || String(err) };
          summary.errors.push({ retailOwnerId: ownerId, type: "recent", error: err.message || String(err) });
        }
      }

      if (backfillDue) {
        const window = buildBackfillWindow(config);
        if (!window) {
          ownerSummary.backfill = { ok: false, error: "invalid_backfill_window" };
          summary.errors.push({ retailOwnerId: ownerId, type: "backfill", error: "invalid_backfill_window" });
        } else {
          try {
            const result = await syncRunner({
              retailOwnerId: ownerId,
              body: {
                window,
                maxMessages: config.backfillMaxMessages,
                skipProcessed: config.skipProcessed,
                processedLabel: config.processedLabel,
                receiptsLabel: config.receiptsLabel,
                syncOverlapMinutes: config.syncOverlapMinutes,
                ignoreCursor: true,
                dry,
              },
              trigger: "scheduler_backfill",
            });

            ownerSummary.backfill = {
              ok: true,
              runId: result.runId,
              matched: result.matched,
              requested: result.requested,
              window,
            };
            summary.backfillRuns += 1;
            nextAutoScheduler.lastAutoBackfillAt = admin.firestore.FieldValue.serverTimestamp();
            nextAutoScheduler.lastRunAt = admin.firestore.FieldValue.serverTimestamp();
            nextAutoScheduler.lastRunMode = "backfill";
            nextAutoScheduler.nextBackfillStartDaysAgo = advanceBackfillPointer(config, window);
            nextAutoScheduler.lastRunSummary = {
              type: "backfill",
              ok: true,
              runId: result.runId,
              matched: result.matched,
              requested: result.requested,
              window,
              at: admin.firestore.FieldValue.serverTimestamp(),
            };
          } catch (err) {
            ownerSummary.backfill = { ok: false, error: err.message || String(err), window };
            summary.errors.push({ retailOwnerId: ownerId, type: "backfill", error: err.message || String(err), window });
          }
        }
      }

      await updateAutoSchedulerState(ownerId, nextAutoScheduler);
      summary.owners.push(ownerSummary);
    }

    summary.completedAt = isoNow();
    state.lastTickCompletedAt = summary.completedAt;
    state.lastSummary = summary;
    return summary;
  } finally {
    state.inFlight = false;
  }
}

function getRetailReceiptSchedulerStatus() {
  return {
    ...state,
    intervalActive: !!state.intervalId,
    batchLimit: DEFAULT_BATCH_LIMIT,
    recentEveryMinutes: normalizeIntInRange(
      process.env.RETAIL_AUTO_RECENT_EVERY_MINUTES,
      5,
      5,
      1440
    ),
  };
}

function startRetailReceiptScheduler() {
  if (state.started) return getRetailReceiptSchedulerStatus();

  const enabled = String(process.env.RETAIL_AUTO_SCHEDULER_ENABLED || "").trim() === "true";
  state.enabled = enabled;
  state.tickMinutes = DEFAULT_TICK_MINUTES;
  state.started = true;

  if (process.env.VERCEL) {
    state.disabledReason = "vercel_serverless_runtime";
    return getRetailReceiptSchedulerStatus();
  }

  if (!enabled) {
    state.disabledReason = "env_disabled";
    return getRetailReceiptSchedulerStatus();
  }

  state.intervalId = setInterval(() => {
    runRetailReceiptSchedulerPass({
      mode: "all",
      limit: DEFAULT_BATCH_LIMIT,
      source: "interval",
    }).catch((err) => {
      state.lastError = err.message || String(err);
      console.error("[retail-scheduler] interval run failed", err);
    });
  }, DEFAULT_TICK_MINUTES * 60 * 1000);

  if (String(process.env.RETAIL_AUTO_SCHEDULER_RUN_ON_START || "false").trim() === "true") {
    setTimeout(() => {
      runRetailReceiptSchedulerPass({
        mode: "all",
        limit: DEFAULT_BATCH_LIMIT,
        source: "startup",
      }).catch((err) => {
        state.lastError = err.message || String(err);
        console.error("[retail-scheduler] startup run failed", err);
      });
    }, 5000);
  }

  return getRetailReceiptSchedulerStatus();
}

module.exports = {
  registerRetailSyncRunner,
  buildRetailAutoSchedulerConfig,
  runRetailReceiptSchedulerPass,
  getRetailReceiptSchedulerStatus,
  startRetailReceiptScheduler,
};