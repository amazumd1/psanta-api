const { tenantCollection } = require('../../lib/tenantFirestore');
const { retailReceiptsCollection } = require('../../lib/retailPaths');
const { generalDocumentsCollection } = require('../../lib/generalDataPaths');
const { normalizeCategoryToken } = require('./biCategories');

function toMillis(value) {
  if (!value) return 0;
  if (typeof value?.toDate === 'function') return value.toDate().getTime();
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function clampInt(value, fallback = 30, min = 1, max = 366) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

function resolveRangeWindow({ rangeKey = '30d', year, now = Date.now() } = {}) {
  const currentYear = Number(year || new Date(now).getUTCFullYear());
  if (rangeKey === 'ytd') {
    return {
      startMs: Date.parse(`${currentYear}-01-01T00:00:00.000Z`),
      endMs: now,
    };
  }
  if (rangeKey === 'year') {
    return {
      startMs: Date.parse(`${currentYear}-01-01T00:00:00.000Z`),
      endMs: Date.parse(`${currentYear + 1}-01-01T00:00:00.000Z`) - 1,
    };
  }
  const days = clampInt(String(rangeKey || '').replace(/\D+/g, ''), 30, 1, 366);
  return {
    startMs: now - (days * 24 * 60 * 60 * 1000),
    endMs: now,
  };
}

function inWindow(value, window) {
  const ms = toMillis(value);
  return !!ms && ms >= window.startMs && ms <= window.endMs;
}

function sumBy(rows = [], getter) {
  return rows.reduce((sum, row) => sum + Number(getter(row) || 0), 0);
}

function groupMoney(rows = [], { labelGetter, amountGetter, limit = 8 } = {}) {
  const bucket = new Map();
  rows.forEach((row) => {
    const label = String(labelGetter(row) || '').trim() || 'Unknown';
    const amount = Number(amountGetter(row) || 0);
    if (!Number.isFinite(amount) || amount === 0) return;
    bucket.set(label, Number(bucket.get(label) || 0) + amount);
  });
  return Array.from(bucket.entries())
    .map(([label, amount]) => ({ label, amount: Number(amount.toFixed(2)) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

function isCategoryLike(value = '', token) {
  return normalizeCategoryToken(value).includes(normalizeCategoryToken(token));
}

function isFinanceApprovedNormalizedRow(row = {}) {
  return row?.financeApproved === true;
}

function isCollectionBackedNormalizedRow(row = {}) {
  const raw = [
    row?.sourceLane,
    row?.sourceHint,
    row?.sourceMeta?.lane,
    row?.sourceMeta?.sourceLane,
    row?.sourceMeta?.sourceCollection,
    row?.sourceMeta?.collection,
    row?.sourceMeta?.documentPath,
    row?.sourceMeta?.sourcePath,
  ].filter(Boolean).join(" \n ").toLowerCase();

  return /(retail[_\s-]*receipts?|invoices?|paystubs?|submitted1099lines|1099|contractor[_\s-]*1099|payroll)/i.test(raw);
}

function shouldIncludeNormalizedInFinance(row = {}) {
  return isFinanceApprovedNormalizedRow(row) && !isCollectionBackedNormalizedRow(row);
}

function readNormalizedAmount(row = {}) {
  const num = Number(row?.amount ?? row?.metricValue ?? 0);
  return Number.isFinite(num) ? num : 0;
}

function clampReadLimit(value, fallback = 120, min = 20, max = 200) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

async function loadCollectionRows(queryRef, limit = 120) {
  const safeLimit = clampReadLimit(limit);
  const snap = await queryRef.limit(safeLimit).get();
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
}

async function buildFinanceRollups(db, tenantId, { rangeKey = '30d', year = '', limit = 120 } = {}) {
  const window = resolveRangeWindow({ rangeKey, year });

  const [receipts, invoices, paystubs, submitted1099Lines, normalizedEvents, generalDocs] = await Promise.all([
    loadCollectionRows(retailReceiptsCollection(db, tenantId), limit).catch(() => []),
    loadCollectionRows(tenantCollection(db, tenantId, 'invoices'), limit).catch(() => []),
    loadCollectionRows(tenantCollection(db, tenantId, 'paystubs'), limit).catch(() => []),
    loadCollectionRows(tenantCollection(db, tenantId, 'submitted1099Lines'), limit).catch(() => []),
    loadCollectionRows(tenantCollection(db, tenantId, 'businessIntelligenceNormalized'), limit).catch(() => []),
    loadCollectionRows(generalDocumentsCollection(db, tenantId), limit).catch(() => []),
  ]);

  const filteredReceipts = receipts.filter((row) => inWindow(row.orderDate || row.updatedAt || row.createdAt, window));
  const filteredInvoices = invoices.filter((row) => inWindow(row.issueDate || row.createdAt || row.updatedAt, window));
  const filteredPaystubs = paystubs.filter((row) => inWindow(row.payDate || row.createdAt, window));
  const filtered1099 = submitted1099Lines.filter((row) => inWindow(row.date || row.createdAt || row.updatedAt, window));
  const filteredNormalized = normalizedEvents.filter((row) => inWindow(row.observedAt || row.createdAtIso || row.createdAt || row.updatedAt, window));
  const filteredDocs = generalDocs.filter((row) => inWindow(row.receivedAt || row.updatedAt || row.createdAt, window));

  const receiptExpense = sumBy(filteredReceipts, (row) => row.total || row.amount || 0);
  const invoiceIncome = sumBy(filteredInvoices, (row) => row.total || row.amount || row.balance || 0);
  const payrollExpense = sumBy(filteredPaystubs, (row) => row.totalPay || row.netPay || row.amount || 0);
  const contractorExpense = sumBy(filtered1099, (row) => row.amount || row.total || row.nonemployeeCompensation || 0);

  const normalizedFinanceRows = filteredNormalized.filter((row) => shouldIncludeNormalizedInFinance(row));
  const normalizedExpenseRows = normalizedFinanceRows.filter((row) => String(row.direction || '').trim() === 'expense');
  const normalizedIncomeRows = normalizedFinanceRows.filter((row) => String(row.direction || '').trim() === 'income');
  const normalizedPendingReviewRows = filteredNormalized.filter((row) => /pending/i.test(String(row.reviewStatus || '')));
  const normalizedExcludedRows = filteredNormalized.filter((row) => !shouldIncludeNormalizedInFinance(row));

  const normalizedExpense = sumBy(normalizedExpenseRows, readNormalizedAmount);
  const normalizedIncome = sumBy(normalizedIncomeRows, readNormalizedAmount);

  const utilityExpense =
    sumBy(filteredReceipts.filter((row) => isCategoryLike(row.category, 'utility')), (row) => row.total || 0) +
    sumBy(
      normalizedExpenseRows.filter((row) => isCategoryLike(row.canonicalCategoryLabel || row.category, 'utility')),
      readNormalizedAmount
    );

  const maintenanceExpense =
    sumBy(filteredReceipts.filter((row) => isCategoryLike(row.category, 'maintenance') || isCategoryLike(row.category, 'repair')), (row) => row.total || 0) +
    sumBy(
      normalizedExpenseRows.filter((row) => isCategoryLike(row.canonicalCategoryLabel || row.category, 'maintenance')),
      readNormalizedAmount
    );

  const professionalFeesExpense =
    sumBy(
      normalizedExpenseRows.filter((row) => isCategoryLike(row.canonicalCategoryLabel || row.category, 'professional')),
      readNormalizedAmount
    );

  const totalBusinessExpense = receiptExpense + payrollExpense + contractorExpense + normalizedExpense;
  const totalIncome = invoiceIncome + normalizedIncome;
  const netPosition = totalIncome - totalBusinessExpense;

  const topVendors = groupMoney(
    [
      ...filteredReceipts.map((row) => ({ label: row.merchant || row.senderEmail || row.vendor || 'Unknown vendor', amount: row.total || row.amount || 0 })),
      ...normalizedExpenseRows.map((row) => ({ label: row.sourceLabel || row.sourceKey || row.category || 'BI source', amount: readNormalizedAmount(row) })),
    ],
    { labelGetter: (row) => row.label, amountGetter: (row) => row.amount, limit: 10 }
  );

  const categoryBreakdown = groupMoney(
    normalizedExpenseRows.map((row) => ({
      label: row.canonicalCategoryLabel || row.category || 'Uncategorized',
      amount: readNormalizedAmount(row),
    })),
    { labelGetter: (row) => row.label, amountGetter: (row) => row.amount, limit: 10 }
  );

  const incidentCount = filteredDocs.filter((row) => /(incident|issue|ticket|repair|maintenance|leak|alert|failure)/i.test(`${row.title || ''} ${row.detectedType || ''} ${row.status || ''}`)).length;

  return {
    rangeKey,
    year: year || '',
    window: {
      startIso: new Date(window.startMs).toISOString(),
      endIso: new Date(window.endMs).toISOString(),
    },
    summary: {
      totalIncome: Number(totalIncome.toFixed(2)),
      totalBusinessExpense: Number(totalBusinessExpense.toFixed(2)),
      retailReceiptsExpense: Number(receiptExpense.toFixed(2)),
      payrollExpense: Number(payrollExpense.toFixed(2)),
      contractor1099Expense: Number(contractorExpense.toFixed(2)),
      normalizedExpense: Number(normalizedExpense.toFixed(2)),
      normalizedIncome: Number(normalizedIncome.toFixed(2)),
      normalizedFinanceApproved: Number(normalizedExpense.toFixed(2)) + Number(normalizedIncome.toFixed(2)),
      normalizedExcludedCount: normalizedExcludedRows.length,
      utilitiesExpense: Number(utilityExpense.toFixed(2)),
      maintenanceExpense: Number(maintenanceExpense.toFixed(2)),
      professionalFeesExpense: Number(professionalFeesExpense.toFixed(2)),
      netPosition: Number(netPosition.toFixed(2)),
      pendingReviewCount: normalizedPendingReviewRows.length,
      incidentCount,
    },
    counts: {
      receipts: filteredReceipts.length,
      invoices: filteredInvoices.length,
      paystubs: filteredPaystubs.length,
      contractor1099: filtered1099.length,
      normalized: filteredNormalized.length,
      normalizedFinanceApproved: normalizedFinanceRows.length,
      normalizedExcluded: normalizedExcludedRows.length,
      normalizedPendingReview: normalizedPendingReviewRows.length,
      documents: filteredDocs.length,
    },
    topVendors,
    categoryBreakdown,
  };
}

module.exports = {
  toMillis,
  resolveRangeWindow,
  buildFinanceRollups,
  isFinanceApprovedNormalizedRow,
  isCollectionBackedNormalizedRow,
  shouldIncludeNormalizedInFinance,
  readNormalizedAmount,
};