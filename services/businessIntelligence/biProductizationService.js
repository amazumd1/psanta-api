const { serverTimestamp } = require('../../lib/firebaseAdminApp');
const { tenantCollection, tenantDoc } = require('../../lib/tenantFirestore');
const { buildFinanceRollups } = require('./biFinanceRollupService');
const { normalizeCategoryToken } = require('./biCategories');

const BI_MAIN_DOC_ID = 'main';

function toMillis(value) {
  if (!value) return 0;
  if (typeof value?.toDate === 'function') return value.toDate().getTime();
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function clampInt(value, fallback = 10, min = 1, max = 200) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function cleanUndefined(value) {
  if (Array.isArray(value)) return value.map(cleanUndefined).filter((item) => item !== undefined);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [key, next] of Object.entries(value)) {
      const cleaned = cleanUndefined(next);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return value === undefined ? undefined : value;
}

async function listLatestNormalizedEvents(db, tenantId, { limit = 20 } = {}) {
  const safeLimit = clampInt(limit, 20, 1, 100);
  const snap = await tenantCollection(db, tenantId, 'businessIntelligenceNormalized')
    .orderBy('createdAt', 'desc')
    .limit(safeLimit)
    .get()
    .catch(() => ({ docs: [] }));

  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
}

function summarizeSourceHealth({ normalizedRows = [], runs = [], sourceConfig = {} } = {}) {
  const keys = ['gmail', 'sheets', 'api', 'manual', 'upload'];
  return keys.map((key) => {
    const rows = normalizedRows.filter((row) => String(row.sourceKey || '').trim() === key);
    const latestRow = [...rows].sort((a, b) => toMillis(b.observedAt || b.createdAtIso || b.createdAt) - toMillis(a.observedAt || a.createdAtIso || a.createdAt))[0] || null;
    const latestRun = [...runs].filter((row) => String(row.sourceKey || '').trim() === key)
      .sort((a, b) => toMillis(b.updatedAt || b.createdAt) - toMillis(a.updatedAt || a.createdAt))[0] || null;
    const config = sourceConfig?.[key] || {};
    const enabled = config.enabled !== false;
    const cadence = String(config.cadence || (key === 'api' ? 'scheduled' : 'on_demand')).trim();
    return {
      key,
      enabled,
      cadence,
      status: !enabled ? 'paused' : rows.length ? 'live' : latestRun ? 'configured' : 'ready',
      normalizedCount: rows.length,
      latestObservedAt: latestRow?.observedAt || latestRow?.createdAtIso || latestRow?.createdAt || '',
      latestRunAt: latestRun?.updatedAt || latestRun?.createdAt || '',
      pendingReviewCount: rows.filter((row) => /pending/i.test(String(row.reviewStatus || ''))).length,
      alertCandidateCount: rows.filter((row) => Array.isArray(row.anomalies) && row.anomalies.length).length,
    };
  });
}

function buildReviewQueueRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => {
      const status = String(row.reviewStatus || '').trim().toLowerCase();
      return status === 'pending_review' || status === 'normalized' || status === 'suggestion_only';
    })
    .map((row) => ({
      id: row.id,
      reviewStatus: row.reviewStatus || 'pending_review',
      sourceKey: row.sourceKey || 'manual',
      title: row.summary || row.category || 'BI event review',
      category: row.canonicalCategoryLabel || row.category || 'General Ops',
      amount: Number(row.amount || row.metricValue || 0),
      observedAt: row.observedAt || row.createdAtIso || row.createdAt || '',
      evidenceText: String(row.evidenceText || '').slice(0, 300),
      anomalies: Array.isArray(row.anomalies) ? row.anomalies : [],
      autoImportDisposition: row.autoImportDisposition || '',
      sourceHint: row.sourceHint || '',
      sourceLane: row.sourceLane || '',
    }))
    .sort((a, b) => toMillis(b.observedAt) - toMillis(a.observedAt))
    .slice(0, 25);
}

function buildLiveAlerts({ dashboard = {}, reviewQueue = [], sourceHealth = [], normalizedRows = [] } = {}) {
  const alerts = [];
  const summary = dashboard?.finance?.summary || {};

  if (Number(summary.totalBusinessExpense || 0) > Number(summary.totalIncome || 0) && Number(summary.totalBusinessExpense || 0) >= 1000) {
    alerts.push({
      id: 'expense-over-income',
      tone: 'rose',
      severityLabel: 'Expense over income',
      title: 'Tracked expense is ahead of tracked income',
      summary: `Current BI rollups show ${Number(summary.totalBusinessExpense || 0).toFixed(2)} of expense versus ${Number(summary.totalIncome || 0).toFixed(2)} of income.`,
      evidence: ['Finance rollups', 'Needs review'],
      actionKey: 'finance',
    });
  }

  if (Number(summary.pendingReviewCount || 0) > 0 || reviewQueue.length > 0) {
    alerts.push({
      id: 'pending-review-queue',
      tone: reviewQueue.length >= 5 ? 'amber' : 'sky',
      severityLabel: 'Pending BI review',
      title: 'Business events are waiting for operator review',
      summary: `${reviewQueue.length || Number(summary.pendingReviewCount || 0)} BI event(s) are pending review in the unified queue.`,
      evidence: ['Review queue', 'Import hub'],
      actionKey: 'review',
    });
  }

  const staleSources = sourceHealth.filter((item) => item.enabled && item.status !== 'paused' && !item.latestObservedAt && !item.latestRunAt);
  if (staleSources.length) {
    alerts.push({
      id: 'configured-source-without-data',
      tone: 'amber',
      severityLabel: 'Configured sources idle',
      title: 'Some BI source connectors have no recent data',
      summary: `${staleSources.map((item) => item.key).join(', ')} are enabled but have not produced live BI events yet.`,
      evidence: ['Connector setup', 'Import hub'],
      actionKey: 'sources',
    });
  }

  const anomalyRows = normalizedRows.filter((row) => Array.isArray(row.anomalies) && row.anomalies.length);
  if (anomalyRows.length) {
    const latest = anomalyRows[0];
    alerts.push({
      id: 'latest-anomaly',
      tone: 'rose',
      severityLabel: 'BI anomaly detected',
      title: 'A normalized BI event contains anomaly signals',
      summary: latest.summary || `Latest anomaly from ${latest.sourceKey || 'source'}.`,
      evidence: (latest.anomalies || []).slice(0, 3),
      actionKey: 'alerts',
    });
  }

  return alerts.slice(0, 8);
}

function buildNotifications({ alerts = [], reviewQueue = [], sourceHealth = [] } = {}) {
  const notifications = [];
  alerts.slice(0, 4).forEach((alert, index) => {
    notifications.push({
      id: `alert-${alert.id || index}`,
      kind: 'alert',
      title: alert.title || 'BI alert',
      body: alert.summary || '',
      tone: alert.tone || 'sky',
      actionKey: alert.actionKey || 'alerts',
      createdAtIso: new Date().toISOString(),
      read: false,
    });
  });

  if (reviewQueue.length) {
    notifications.push({
      id: 'review-queue-pending',
      kind: 'review_queue',
      title: 'BI review queue updated',
      body: `${reviewQueue.length} item(s) are ready for operator review.`,
      tone: reviewQueue.length >= 5 ? 'amber' : 'sky',
      actionKey: 'review',
      createdAtIso: new Date().toISOString(),
      read: false,
    });
  }

  const liveSources = sourceHealth.filter((item) => item.status === 'live').length;
  notifications.push({
    id: 'source-health-summary',
    kind: 'source_health',
    title: 'BI source health snapshot',
    body: `${liveSources} source(s) are currently live in the BI pipeline.`,
    tone: liveSources >= 3 ? 'emerald' : liveSources >= 1 ? 'sky' : 'slate',
    actionKey: 'sources',
    createdAtIso: new Date().toISOString(),
    read: false,
  });

  return notifications.slice(0, 8);
}

async function persistNotifications(db, tenantId, notifications = []) {
  const safe = Array.isArray(notifications) ? notifications : [];
  for (const row of safe) {
    await tenantCollection(db, tenantId, 'businessIntelligenceNotifications').doc(String(row.id || '').trim() || undefined).set(cleanUndefined({
      ...row,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    }), { merge: true });
  }
  return safe.length;
}

async function listBiNotifications(db, tenantId, { limit = 20 } = {}) {
  const safeLimit = clampInt(limit, 20, 1, 100);
  const snap = await tenantCollection(db, tenantId, 'businessIntelligenceNotifications')
    .orderBy('updatedAt', 'desc')
    .limit(safeLimit)
    .get()
    .catch(() => ({ docs: [] }));
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
}

async function acknowledgeBiNotification(db, tenantId, notificationId, { read = true } = {}) {
  const ref = tenantCollection(db, tenantId, 'businessIntelligenceNotifications').doc(String(notificationId || '').trim());
  await ref.set({ read: !!read, updatedAt: serverTimestamp(), readAtIso: new Date().toISOString() }, { merge: true });
  const snap = await ref.get();
  return { id: snap.id, ...(snap.data() || {}) };
}

async function readBiSchedulerSettings(db, tenantId) {
  const snap = await tenantDoc(db, tenantId, 'businessIntelligence', BI_MAIN_DOC_ID).get();
  const data = snap.exists ? snap.data() || {} : {};
  const sourceConfig = data.settings?.sourceConfig || data.sourceConfig || {};
  const scheduler = data.scheduler || {};
  return {
    mode: String(scheduler.mode || 'smart').trim() || 'smart',
    enabled: scheduler.enabled !== false,
    nextRunPreference: String(scheduler.nextRunPreference || 'manual').trim() || 'manual',
    sources: ['gmail', 'sheets', 'api', 'manual', 'upload'].map((key) => ({
      key,
      enabled: sourceConfig?.[key]?.enabled !== false,
      cadence: String(sourceConfig?.[key]?.cadence || (key === 'api' ? 'scheduled' : 'on_demand')).trim(),
    })),
    alertNotificationsEnabled: scheduler.alertNotificationsEnabled !== false,
  };
}

async function saveBiSchedulerSettings(db, tenantId, payload = {}) {
  const current = await readBiSchedulerSettings(db, tenantId);
  const incomingSources = Array.isArray(payload.sources) ? payload.sources : [];
  const mergedSources = current.sources.map((row) => {
    const found = incomingSources.find((item) => String(item?.key || '').trim() === row.key) || {};
    return {
      key: row.key,
      enabled: typeof found.enabled === 'boolean' ? found.enabled : row.enabled,
      cadence: String(found.cadence || row.cadence || '').trim() || row.cadence,
    };
  });

  await tenantDoc(db, tenantId, 'businessIntelligence', BI_MAIN_DOC_ID).set({
    scheduler: cleanUndefined({
      mode: String(payload.mode || current.mode || 'smart').trim() || 'smart',
      enabled: typeof payload.enabled === 'boolean' ? payload.enabled : current.enabled,
      nextRunPreference: String(payload.nextRunPreference || current.nextRunPreference || 'manual').trim() || 'manual',
      alertNotificationsEnabled: typeof payload.alertNotificationsEnabled === 'boolean'
        ? payload.alertNotificationsEnabled
        : current.alertNotificationsEnabled,
      updatedAtIso: new Date().toISOString(),
    }),
    settings: {
      sourceConfig: mergedSources.reduce((acc, row) => {
        acc[row.key] = { enabled: row.enabled, cadence: row.cadence };
        return acc;
      }, {}),
    },
    updatedAt: serverTimestamp(),
  }, { merge: true });

  return readBiSchedulerSettings(db, tenantId);
}

async function resolveBiReviewQueueItem(db, tenantId, itemId, payload = {}) {
  const ref = tenantCollection(db, tenantId, 'businessIntelligenceNormalized').doc(String(itemId || '').trim());
  const nextStatus = String(payload.status || 'reviewed').trim() || 'reviewed';
  const nextCategory = String(payload.category || '').trim();
  await ref.set(cleanUndefined({
    reviewStatus: nextStatus,
    canonicalCategoryLabel: nextCategory || undefined,
    category: nextCategory || undefined,
    resolvedAtIso: new Date().toISOString(),
    reviewerNote: String(payload.note || '').trim() || undefined,
    updatedAt: serverTimestamp(),
  }), { merge: true });
  const snap = await ref.get();
  return { id: snap.id, ...(snap.data() || {}) };
}

async function syncBiAlertsAndNotifications(db, tenantId, options = {}) {
  const mainSnap = await tenantDoc(db, tenantId, 'businessIntelligence', BI_MAIN_DOC_ID).get();
  const main = mainSnap.exists ? mainSnap.data() || {} : {};
  const [finance, normalizedRows, runSnap] = await Promise.all([
    buildFinanceRollups(db, tenantId, { rangeKey: options.rangeKey || '30d', year: options.year || '', limit: options.limit || 500 }),
    listLatestNormalizedEvents(db, tenantId, { limit: 80 }),
    tenantCollection(db, tenantId, 'businessIntelligenceRuns').orderBy('createdAt', 'desc').limit(25).get().catch(() => ({ docs: [] })),
  ]);
  const runs = runSnap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
  const sourceHealth = summarizeSourceHealth({ normalizedRows, runs, sourceConfig: main.settings?.sourceConfig || main.sourceConfig || {} });
  const reviewQueue = buildReviewQueueRows(normalizedRows);
  const alerts = buildLiveAlerts({ dashboard: { finance }, reviewQueue, sourceHealth, normalizedRows });
  const notifications = buildNotifications({ alerts, reviewQueue, sourceHealth });

  const batchWrites = [];
  alerts.forEach((alert) => {
    const ref = tenantCollection(db, tenantId, 'businessIntelligenceAlerts').doc(String(alert.id || '').trim());
    batchWrites.push(ref.set(cleanUndefined({ ...alert, updatedAt: serverTimestamp(), createdAt: serverTimestamp(), active: true }), { merge: true }));
  });
  await Promise.all(batchWrites);
  await persistNotifications(db, tenantId, notifications);

  return { alerts, notifications, reviewQueue, sourceHealth, finance };
}

async function listBiAlerts(db, tenantId, { limit = 20 } = {}) {
  const safeLimit = clampInt(limit, 20, 1, 100);
  const snap = await tenantCollection(db, tenantId, 'businessIntelligenceAlerts')
    .orderBy('updatedAt', 'desc')
    .limit(safeLimit)
    .get()
    .catch(() => ({ docs: [] }));
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
}

async function buildSourceAgnosticDashboard(db, tenantId, { rangeKey = '30d', year = '', limit = 500 } = {}) {
  const mainSnap = await tenantDoc(db, tenantId, 'businessIntelligence', BI_MAIN_DOC_ID).get();
  const main = mainSnap.exists ? mainSnap.data() || {} : {};
  const [finance, normalizedRows, runs, alerts, notifications, scheduler] = await Promise.all([
    buildFinanceRollups(db, tenantId, { rangeKey, year, limit }),
    listLatestNormalizedEvents(db, tenantId, { limit: 24 }),
    tenantCollection(db, tenantId, 'businessIntelligenceRuns').orderBy('createdAt', 'desc').limit(20).get().then((snap) => snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }))).catch(() => []),
    listBiAlerts(db, tenantId, { limit: 8 }),
    listBiNotifications(db, tenantId, { limit: 8 }),
    readBiSchedulerSettings(db, tenantId),
  ]);

  const sourceHealth = summarizeSourceHealth({ normalizedRows, runs, sourceConfig: main.settings?.sourceConfig || main.sourceConfig || {} });
  const reviewQueue = buildReviewQueueRows(normalizedRows);

  const sourceSummary = {
    totalConfigured: sourceHealth.length,
    enabled: sourceHealth.filter((item) => item.enabled).length,
    live: sourceHealth.filter((item) => item.status === 'live').length,
    pendingReview: sourceHealth.reduce((sum, item) => sum + Number(item.pendingReviewCount || 0), 0),
  };

  return {
    finance,
    sourceHealth,
    sourceSummary,
    latestEvents: normalizedRows.slice(0, 12),
    reviewQueue,
    alerts,
    notifications,
    scheduler,
  };
}

module.exports = {
  BI_MAIN_DOC_ID,
  clampInt,
  toMillis,
  listLatestNormalizedEvents,
  summarizeSourceHealth,
  buildReviewQueueRows,
  buildLiveAlerts,
  buildNotifications,
  listBiNotifications,
  acknowledgeBiNotification,
  readBiSchedulerSettings,
  saveBiSchedulerSettings,
  resolveBiReviewQueueItem,
  syncBiAlertsAndNotifications,
  listBiAlerts,
  buildSourceAgnosticDashboard,
};