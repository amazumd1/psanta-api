const { GoogleGenerativeAI } = require('@google/generative-ai');
const { tenantCollection } = require('../../lib/tenantFirestore');
const {
  buildFinanceRollups,
  resolveRangeWindow,
  shouldIncludeNormalizedInFinance,
  readNormalizedAmount,
} = require('./biFinanceRollupService');

function clampInt(value, fallback = 120, min = 1, max = 200) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value?.toDate === 'function') return value.toDate().getTime();
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function cleanText(value = '') {
  return String(value || '').trim();
}

async function loadRows(queryRef, limit = 120) {
  const snap = await queryRef.limit(limit).get().catch(() => ({ docs: [] }));
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
}

function inWindow(row, window, ...dateFields) {
  const ms = toMillis(dateFields.map((field) => row?.[field]).find(Boolean));
  return !!ms && ms >= window.startMs && ms <= window.endMs;
}

function monthBucketKey(value) {
  const ts = toMillis(value);
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthBucketLabel(key = '') {
  const [year, month] = String(key || '').split('-');
  const ts = Date.UTC(Number(year || 0), Math.max(0, Number(month || 1) - 1), 1);
  return Number.isFinite(ts)
    ? new Date(ts).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
    : key;
}

function sumBy(rows = [], getter) {
  return (Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + Number(getter(row) || 0), 0);
}

function avgBy(rows = [], getter) {
  const values = (Array.isArray(rows) ? rows : []).map((row) => Number(getter(row))).filter((value) => Number.isFinite(value));
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function detectPropertySignals(row = {}) {
  const text = [
    row.summary,
    row.evidenceText,
    row.category,
    row.canonicalCategoryLabel,
    row.metricKey,
    row.sourceHint,
    row.sourceLane,
    row.title,
    row.detectedType,
    row.status,
  ].filter(Boolean).join(' \n ').toLowerCase();

  return {
    maintenance: /(maintenance|repair|plumbing|hvac|electrical|roof|pest|landscaping|handyman|service call)/i.test(text),
    utilities: /(utility|water|electric|power|gas|internet|phone|trash|sewer)/i.test(text),
    incident: /(incident|issue|ticket|alert|leak|failure|urgent|critical)/i.test(text),
    property: /(property|tenant|landlord|rent|unit|apartment|home|house)/i.test(text),
    temperature: /(temperature|thermostat|degree|sensor|climate)/i.test(text),
    ph: /((^|[^a-z])ph([^a-z]|$)|soil|crop|water test)/i.test(text),
  };
}

function isReceiptLikeRow(row = {}) {
  return (
    Object.prototype.hasOwnProperty.call(row, "merchant") ||
    Object.prototype.hasOwnProperty.call(row, "vendor") ||
    Object.prototype.hasOwnProperty.call(row, "orderDate") ||
    Object.prototype.hasOwnProperty.call(row, "total")
  );
}

function buildTrendSeries(rows = []) {
  const buckets = new Map();
  rows.forEach((row) => {
    const key = monthBucketKey(row.observedAt || row.createdAtIso || row.createdAt || row.updatedAt);
    if (!key) return;
    const current = buckets.get(key) || { label: monthBucketLabel(key), expense: 0, incidents: 0, telemetry: 0 };
    const amount = Number(row.amount || row.metricValue || 0);
    const signals = detectPropertySignals(row);
    const financeEligible = isReceiptLikeRow(row) || shouldIncludeNormalizedInFinance(row);

    if (financeEligible && (signals.maintenance || signals.utilities || String(row.direction || '').trim() === 'expense')) {
      current.expense += Number.isFinite(amount) ? amount : 0;
    }
    if (signals.incident) current.incidents += 1;
    if (signals.temperature || signals.ph) current.telemetry += 1;
    buckets.set(key, current);
  });

  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, value]) => ({
      ...value,
      expense: Number(value.expense.toFixed(2)),
    }))
    .slice(-6);
}

async function buildPropertyOpsMetrics(db, tenantId, { rangeKey = '30d', year = '', propertyId = '', limit = 120 } = {}) {
  const safeLimit = clampInt(limit, 120, 20, 200);
  const window = resolveRangeWindow({ rangeKey, year });

  const [normalizedRows, receipts, generalDocs] = await Promise.all([
    loadRows(tenantCollection(db, tenantId, 'businessIntelligenceNormalized').orderBy('createdAt', 'desc'), safeLimit),
    loadRows(tenantCollection(db, tenantId, 'retailReceipts').orderBy('createdAt', 'desc'), safeLimit),
    loadRows(tenantCollection(db, tenantId, 'generalDocuments').orderBy('createdAt', 'desc'), safeLimit),
  ]);

  const propertyNeedle = cleanText(propertyId).toLowerCase();

  const normalizedFiltered = normalizedRows.filter((row) => {
    if (!inWindow(row, window, 'observedAt', 'createdAtIso', 'createdAt', 'updatedAt')) return false;
    if (!propertyNeedle) return true;
    const haystack = [row.summary, row.evidenceText, row.sourceMeta?.propertyId, row.propertyId].filter(Boolean).join(' \n ').toLowerCase();
    return haystack.includes(propertyNeedle);
  });

  const receiptFiltered = receipts.filter((row) => {
    if (!inWindow(row, window, 'orderDate', 'createdAt', 'updatedAt')) return false;
    if (!propertyNeedle) return true;
    const haystack = [row.propertyId, row.notes, row.description, row.category, row.merchant].filter(Boolean).join(' \n ').toLowerCase();
    return haystack.includes(propertyNeedle);
  });

  const docsFiltered = generalDocs.filter((row) => {
    if (!inWindow(row, window, 'receivedAt', 'createdAt', 'updatedAt')) return false;
    if (!propertyNeedle) return true;
    const haystack = [row.propertyId, row.title, row.detectedType, row.status].filter(Boolean).join(' \n ').toLowerCase();
    return haystack.includes(propertyNeedle);
  });

  const normalizedExpenseRows = normalizedFiltered.filter(
    (row) => shouldIncludeNormalizedInFinance(row) && String(row.direction || '').trim() === 'expense'
  );

  const maintenanceRows = normalizedExpenseRows.filter((row) => detectPropertySignals(row).maintenance);
  const utilityRows = normalizedExpenseRows.filter((row) => detectPropertySignals(row).utilities);
  const incidentRows = normalizedFiltered.filter((row) => detectPropertySignals(row).incident)
    .concat(docsFiltered.filter((row) => detectPropertySignals(row).incident));
  const temperatureRows = normalizedFiltered.filter((row) => detectPropertySignals(row).temperature);
  const phRows = normalizedFiltered.filter((row) => detectPropertySignals(row).ph);
  const telemetryRows = normalizedFiltered.filter((row) => detectPropertySignals(row).temperature || detectPropertySignals(row).ph);

  const maintenanceExpense =
    sumBy(maintenanceRows, readNormalizedAmount) +
    sumBy(receiptFiltered.filter((row) => /(maintenance|repair|plumbing|hvac|electrical)/i.test(`${row.category || ''} ${row.notes || ''}`)), (row) => row.total || row.amount || 0);

  const utilitiesExpense =
    sumBy(utilityRows, readNormalizedAmount) +
    sumBy(receiptFiltered.filter((row) => /(utility|water|electric|power|gas|internet|phone|trash|sewer)/i.test(`${row.category || ''} ${row.notes || ''}`)), (row) => row.total || row.amount || 0);

  const avgTemperature = avgBy(temperatureRows, (row) => row.metricValue);
  const maxTemperature = Math.max(0, ...temperatureRows.map((row) => Number(row.metricValue || 0)).filter((value) => Number.isFinite(value)));
  const avgPh = avgBy(phRows, (row) => row.metricValue);

  const sourceMix = [
    { key: 'normalized', count: normalizedFiltered.length },
    { key: 'receipts', count: receiptFiltered.length },
    { key: 'documents', count: docsFiltered.length },
  ].filter((row) => row.count > 0);

  const trendSeries = buildTrendSeries(normalizedFiltered.concat(receiptFiltered));

  const summary = {
    propertyId: propertyId || '',
    maintenanceExpense: Number(maintenanceExpense.toFixed(2)),
    utilitiesExpense: Number(utilitiesExpense.toFixed(2)),
    incidentCount: incidentRows.length,
    telemetryCount: telemetryRows.length,
    temperatureReadings: temperatureRows.length,
    avgTemperature: Number(avgTemperature.toFixed(1)),
    maxTemperature: Number(maxTemperature.toFixed(1)),
    phReadings: phRows.length,
    avgPh: Number(avgPh.toFixed(2)),
    evidenceCount: docsFiltered.length,
    receiptCount: receiptFiltered.length,
    normalizedCount: normalizedFiltered.length,
  };

  const highlights = [];
  if (summary.maintenanceExpense > 0) highlights.push(`Maintenance spend ${summary.maintenanceExpense.toFixed(2)}`);
  if (summary.utilitiesExpense > 0) highlights.push(`Utilities spend ${summary.utilitiesExpense.toFixed(2)}`);
  if (summary.incidentCount > 0) highlights.push(`${summary.incidentCount} incident-like signal(s)`);
  if (summary.temperatureReadings > 0) highlights.push(`Temperature avg ${summary.avgTemperature.toFixed(1)}`);
  if (summary.phReadings > 0) highlights.push(`pH avg ${summary.avgPh.toFixed(2)}`);

  return {
    rangeKey,
    year: year || '',
    summary,
    highlights,
    sourceMix,
    trendSeries,
    latestTelemetry: telemetryRows.slice(0, 10).map((row) => ({
      id: row.id,
      observedAt: row.observedAt || row.createdAtIso || row.createdAt || '',
      metricKey: row.metricKey || '',
      metricValue: Number(row.metricValue || 0),
      metricUnit: row.metricUnit || '',
      category: row.canonicalCategoryLabel || row.category || '',
      summary: row.summary || '',
    })),
  };
}

function buildDashboardSummaryFromFinance(finance = {}) {
  return {
    sourceSummary: {
      pendingReview: Number(finance?.summary?.pendingReviewCount || 0),
    },
  };
}

async function buildBiSharedSnapshot(db, tenantId, options = {}, preloaded = {}) {
  const finance = preloaded.finance || await buildFinanceRollups(db, tenantId, options);
  const propertyOps = preloaded.propertyOps || await buildPropertyOpsMetrics(db, tenantId, options);
  const dashboard = preloaded.dashboard || buildDashboardSummaryFromFinance(finance);
  const recommendations = Array.isArray(preloaded.recommendations)
    ? preloaded.recommendations
    : buildHeuristicRecommendations({ finance, propertyOps, dashboard });

  return {
    finance,
    propertyOps,
    dashboard,
    recommendations,
  };
}

function buildHeuristicRecommendations({ finance = {}, propertyOps = {}, dashboard = {} } = {}) {
  const recommendations = [];
  const summary = finance.summary || {};
  const ops = propertyOps.summary || {};
  const sourceSummary = dashboard.sourceSummary || {};

  if (Number(summary.totalBusinessExpense || 0) > Number(summary.totalIncome || 0) && Number(summary.totalBusinessExpense || 0) >= 1000) {
    recommendations.push({
      id: 'pricing-or-margin-review',
      tone: 'rose',
      title: 'Expense pressure suggests a margin review',
      summary: `Business Intelligence sees ${Number(summary.totalBusinessExpense || 0).toFixed(2)} of tracked expense against ${Number(summary.totalIncome || 0).toFixed(2)} of tracked income in the selected window.`,
      bullets: [
        `Net ${Number(summary.netPosition || 0).toFixed(2)}`,
        'Check pricing, missing income imports, or concentrated vendors',
      ],
      actionKey: 'finance',
    });
  }

  if (Number(ops.maintenanceExpense || 0) >= 750 || Number(ops.incidentCount || 0) >= 3) {
    recommendations.push({
      id: 'property-maintenance-trend',
      tone: 'amber',
      title: 'Recurring maintenance pattern detected',
      summary: `Property and ops telemetry shows ${Number(ops.incidentCount || 0)} incident-like signal(s) with ${Number(ops.maintenanceExpense || 0).toFixed(2)} in maintenance-related spend.`,
      bullets: [
        `Utilities ${Number(ops.utilitiesExpense || 0).toFixed(2)}`,
        'Consider vendor review or preventive maintenance planning',
      ],
      actionKey: 'property',
    });
  }

  if (Number(ops.temperatureReadings || 0) > 0 && Number(ops.maxTemperature || 0) >= 90) {
    recommendations.push({
      id: 'temperature-risk',
      tone: 'rose',
      title: 'Temperature telemetry moved outside a normal band',
      summary: `The latest BI telemetry includes temperature readings with a max of ${Number(ops.maxTemperature || 0).toFixed(1)} degrees.`,
      bullets: [
        `Average ${Number(ops.avgTemperature || 0).toFixed(1)} degrees`,
        'Useful for HVAC, crop, or property-risk review',
      ],
      actionKey: 'telemetry',
    });
  }

  if (Number(ops.phReadings || 0) > 0 && (Number(ops.avgPh || 0) < 5.5 || Number(ops.avgPh || 0) > 7.5)) {
    recommendations.push({
      id: 'ph-band-review',
      tone: 'amber',
      title: 'pH trend may need operational review',
      summary: `Average pH is ${Number(ops.avgPh || 0).toFixed(2)} based on current telemetry.`,
      bullets: [
        `${Number(ops.phReadings || 0)} pH reading(s)`,
        'Good candidate for ops intervention or agronomy review',
      ],
      actionKey: 'telemetry',
    });
  }

  if (Number(sourceSummary.pendingReview || 0) >= 5) {
    recommendations.push({
      id: 'review-queue-drag',
      tone: 'sky',
      title: 'Review queue is large enough to affect dashboard trust',
      summary: `${Number(sourceSummary.pendingReview || 0)} item(s) are still pending BI review.`,
      bullets: [
        'Resolve pending imports to strengthen finance and ops summaries',
        'High-confidence Gmail items can usually be approved in batches',
      ],
      actionKey: 'review',
    });
  }

  return recommendations.slice(0, 8);
}

async function buildBiRecommendations(db, tenantId, options = {}) {
  const snapshot = await buildBiSharedSnapshot(db, tenantId, options);

  return {
    financeSummary: snapshot.finance.summary,
    propertyOpsSummary: snapshot.propertyOps.summary,
    recommendations: snapshot.recommendations,
  };
}

async function buildBiCeoBridge(db, tenantId, options = {}) {
  const snapshot = await buildBiSharedSnapshot(db, tenantId, options);

  const ceoKpis = {
    revenueTracked: Number(snapshot.finance.summary?.totalIncome || 0),
    expenseTracked: Number(snapshot.finance.summary?.totalBusinessExpense || 0),
    netTracked: Number(snapshot.finance.summary?.netPosition || 0),
    maintenanceExpense: Number(snapshot.propertyOps.summary?.maintenanceExpense || 0),
    utilitiesExpense: Number(snapshot.propertyOps.summary?.utilitiesExpense || 0),
    incidentCount: Number(snapshot.propertyOps.summary?.incidentCount || 0),
    telemetryCount: Number(snapshot.propertyOps.summary?.telemetryCount || 0),
    recommendationCount: snapshot.recommendations.length,
    pendingReviewCount: Number(snapshot.finance.summary?.pendingReviewCount || 0),
  };

  return {
    rangeKey: options.rangeKey || '30d',
    year: options.year || '',
    ceoKpis,
    finance: snapshot.finance,
    propertyOps: snapshot.propertyOps,
    recommendations: snapshot.recommendations,
  };
}

function buildLlmContext({ question = '', finance = {}, propertyOps = {}, ceoBridge = {}, recommendations = [] } = {}) {
  return {
    question: cleanText(question),
    financeSummary: finance.summary || {},
    topVendors: finance.topVendors || [],
    categoryBreakdown: finance.categoryBreakdown || [],
    propertyOpsSummary: propertyOps.summary || {},
    propertyOpsHighlights: propertyOps.highlights || [],
    propertyTrendSeries: propertyOps.trendSeries || [],
    ceoKpis: ceoBridge.ceoKpis || {},
    recommendations,
  };
}

function buildFallbackLlmAnalysis({ question = '', context = {} } = {}) {
  const finance = context.financeSummary || {};
  const ops = context.propertyOpsSummary || {};
  const recommendations = Array.isArray(context.recommendations) ? context.recommendations : [];

  const keyFindings = [
    `Tracked income is ${Number(finance.totalIncome || 0).toFixed(2)} and tracked expense is ${Number(finance.totalBusinessExpense || 0).toFixed(2)}.`,
    `Net position is ${Number(finance.netPosition || 0).toFixed(2)} with ${Number(finance.pendingReviewCount || 0).toFixed(0)} BI item(s) still pending review.`,
    `Property and ops data shows ${Number(ops.incidentCount || 0).toFixed(0)} incident-like signal(s), ${Number(ops.maintenanceExpense || 0).toFixed(2)} maintenance spend, and ${Number(ops.utilitiesExpense || 0).toFixed(2)} utility spend.`,
  ];

  const answer = [
    question ? `Question received: ${question}` : 'No explicit BI question was provided.',
    keyFindings.join(' '),
    recommendations.length ? `Top recommendation: ${recommendations[0].title}. ${recommendations[0].summary}` : 'No major recommendation was triggered from the current BI snapshot.',
  ].join(' ');

  return {
    mode: 'fallback',
    answer,
    keyFindings,
    recommendations: recommendations.slice(0, 3).map((item) => item.title),
    rawContext: context,
  };
}

async function maybeRunGeminiAnalysis({ question = '', context = {} } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash' });

  const prompt = [
    'You are an operations and finance intelligence analyst.',
    'Return strict JSON with keys: answer, keyFindings, recommendations, riskLevel.',
    'Keep answer concise and actionable. Use only the provided context. Do not invent missing facts.',
    `Question: ${question || 'Summarize the business risks and opportunities in this BI snapshot.'}`,
    `Context JSON: ${JSON.stringify(context).slice(0, 25000)}`,
  ].join('\n\n');

  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Gemini did not return JSON.');

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    mode: 'llm',
    answer: cleanText(parsed.answer || ''),
    keyFindings: Array.isArray(parsed.keyFindings) ? parsed.keyFindings.map((item) => cleanText(item)).filter(Boolean) : [],
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map((item) => cleanText(item)).filter(Boolean) : [],
    riskLevel: cleanText(parsed.riskLevel || ''),
    rawContext: context,
  };
}

async function runBiLlmAnalysis(db, tenantId, { question = '', rangeKey = '30d', year = '', propertyId = '', limit = 120 } = {}) {
  const snapshot = await buildBiSharedSnapshot(db, tenantId, { rangeKey, year, propertyId, limit });

  const ceoBridge = {
    rangeKey,
    year,
    ceoKpis: {
      revenueTracked: Number(snapshot.finance.summary?.totalIncome || 0),
      expenseTracked: Number(snapshot.finance.summary?.totalBusinessExpense || 0),
      netTracked: Number(snapshot.finance.summary?.netPosition || 0),
      maintenanceExpense: Number(snapshot.propertyOps.summary?.maintenanceExpense || 0),
      utilitiesExpense: Number(snapshot.propertyOps.summary?.utilitiesExpense || 0),
      incidentCount: Number(snapshot.propertyOps.summary?.incidentCount || 0),
      telemetryCount: Number(snapshot.propertyOps.summary?.telemetryCount || 0),
      recommendationCount: snapshot.recommendations.length,
      pendingReviewCount: Number(snapshot.finance.summary?.pendingReviewCount || 0),
    },
  };

  const context = buildLlmContext({
    question,
    finance: snapshot.finance,
    propertyOps: snapshot.propertyOps,
    ceoBridge,
    recommendations: snapshot.recommendations,
  });

  try {
    const llm = await maybeRunGeminiAnalysis({ question, context });
    if (llm) return llm;
  } catch (err) {
    return {
      ...buildFallbackLlmAnalysis({ question, context }),
      mode: 'fallback_after_llm_error',
      llmError: err.message || String(err),
    };
  }

  return buildFallbackLlmAnalysis({ question, context });
}

module.exports = {
  clampInt,
  toMillis,
  buildPropertyOpsMetrics,
  buildBiRecommendations,
  buildBiCeoBridge,
  buildLlmContext,
  buildFallbackLlmAnalysis,
  runBiLlmAnalysis,
};