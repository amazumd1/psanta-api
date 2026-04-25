const { serverTimestamp } = require('../../lib/firebaseAdminApp');
const { tenantDoc } = require('../../lib/tenantFirestore');
const { findCanonicalBiCategory, resolveCanonicalBiCategory } = require('./biCategories');

const BI_MAIN_DOC_ID = 'main';

function normalizeKey(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeKeywordList(values = []) {
  const raw = Array.isArray(values)
    ? values
    : String(values || '')
      .split(',')
      .map((item) => item.trim());

  return Array.from(new Set(raw.map((item) => normalizeKey(item)).filter(Boolean))).slice(0, 25);
}

function normalizeMemoryEntry(entry = {}, fallbackCategory = '') {
  const category = findCanonicalBiCategory(entry.category || fallbackCategory) || resolveCanonicalBiCategory({
    value: entry.category || fallbackCategory,
    text: [entry.category, entry.lastReason, ...(Array.isArray(entry.keywordHints) ? entry.keywordHints : [])].filter(Boolean).join(' \n '),
    fallbackLabel: fallbackCategory || 'General Ops',
  });

  return {
    category: category?.label || String(entry.category || fallbackCategory || '').trim() || '',
    categoryKey: category?.key || null,
    learnCount: Number(entry.learnCount || 0),
    confidence: String(entry.confidence || '').trim() || 'operator_confirmed',
    source: String(entry.source || '').trim() || 'manual_override',
    actorUid: String(entry.actorUid || '').trim() || '',
    actorEmail: String(entry.actorEmail || '').trim() || '',
    lastReason: String(entry.lastReason || '').trim() || '',
    keywordHints: normalizeKeywordList(entry.keywordHints || []),
    updatedAtIso: String(entry.updatedAtIso || '').trim() || '',
  };
}

function normalizeCategoryMemory(raw = {}) {
  const bySender = {};
  const byDomain = {};
  const keywordRules = {};

  Object.entries(raw?.bySender || {}).forEach(([key, entry]) => {
    const safeKey = normalizeKey(key);
    if (!safeKey) return;
    bySender[safeKey] = normalizeMemoryEntry(entry || {});
  });

  Object.entries(raw?.byDomain || {}).forEach(([key, entry]) => {
    const safeKey = normalizeKey(key);
    if (!safeKey) return;
    byDomain[safeKey] = normalizeMemoryEntry(entry || {});
  });

  Object.entries(raw?.keywordRules || {}).forEach(([key, entry]) => {
    const safeKey = normalizeKey(key);
    if (!safeKey) return;
    keywordRules[safeKey] = normalizeMemoryEntry(entry || {}, entry?.category || 'General Ops');
  });

  return { bySender, byDomain, keywordRules };
}

async function readBiCategoryMemory(db, tenantId) {
  const snap = await tenantDoc(db, tenantId, 'businessIntelligence', BI_MAIN_DOC_ID).get();
  const data = snap.exists ? snap.data() || {} : {};
  return normalizeCategoryMemory(data.categoryMemory || data.settings?.categoryMemory || {});
}

function resolveCategoryMemoryMatch(memory = {}, { senderEmail = '', senderDomain = '', text = '' } = {}) {
  const safeSender = normalizeKey(senderEmail);
  const safeDomain = normalizeKey(senderDomain || (safeSender.includes('@') ? safeSender.split('@')[1] : ''));
  const haystack = String(text || '').toLowerCase();

  if (safeSender && memory?.bySender?.[safeSender]?.category) {
    const matched = normalizeMemoryEntry(memory.bySender[safeSender]);
    return {
      matchedBy: 'sender',
      matchedKey: safeSender,
      category: matched.category,
      categoryKey: matched.categoryKey,
      reasons: [`Learned sender memory matched ${safeSender}`],
      confidence: 'learned_high',
    };
  }

  if (safeDomain && memory?.byDomain?.[safeDomain]?.category) {
    const matched = normalizeMemoryEntry(memory.byDomain[safeDomain]);
    return {
      matchedBy: 'domain',
      matchedKey: safeDomain,
      category: matched.category,
      categoryKey: matched.categoryKey,
      reasons: [`Learned domain memory matched ${safeDomain}`],
      confidence: 'learned_medium',
    };
  }

  const keywordEntries = Object.entries(memory?.keywordRules || {});
  for (const [keyword, entry] of keywordEntries) {
    if (!keyword || !haystack.includes(keyword)) continue;
    const matched = normalizeMemoryEntry(entry);
    return {
      matchedBy: 'keyword',
      matchedKey: keyword,
      category: matched.category,
      categoryKey: matched.categoryKey,
      reasons: [`Learned keyword memory matched ${keyword}`],
      confidence: 'learned_medium',
    };
  }

  return null;
}

async function learnBiCategoryMemory(db, tenantId, input = {}) {
  const current = await readBiCategoryMemory(db, tenantId);
  const next = normalizeCategoryMemory(current);
  const category = findCanonicalBiCategory(input.category) || resolveCanonicalBiCategory({
    value: input.category,
    text: [input.category, input.note, ...(Array.isArray(input.keywordHints) ? input.keywordHints : [])].filter(Boolean).join(' \n '),
    fallbackLabel: 'General Ops',
  });

  if (!category?.label) {
    throw new Error('A valid canonical BI category is required to learn category memory.');
  }

  const nowIso = new Date().toISOString();
  const baseEntry = {
    category: category.label,
    categoryKey: category.key,
    confidence: String(input.confidence || '').trim() || 'operator_confirmed',
    source: String(input.source || '').trim() || 'manual_override',
    actorUid: String(input.actorUid || '').trim() || '',
    actorEmail: String(input.actorEmail || '').trim() || '',
    lastReason: String(input.note || '').trim() || '',
    keywordHints: normalizeKeywordList(input.keywordHints || []),
    updatedAtIso: nowIso,
  };

  const senderEmail = normalizeKey(input.senderEmail);
  const senderDomain = normalizeKey(input.senderDomain || (senderEmail.includes('@') ? senderEmail.split('@')[1] : ''));
  const keywordHints = normalizeKeywordList(input.keywordHints || []);

  if (senderEmail) {
    const prev = next.bySender[senderEmail] || {};
    next.bySender[senderEmail] = {
      ...normalizeMemoryEntry(prev, category.label),
      ...baseEntry,
      learnCount: Number(prev.learnCount || 0) + 1,
    };
  }

  if (senderDomain) {
    const prev = next.byDomain[senderDomain] || {};
    next.byDomain[senderDomain] = {
      ...normalizeMemoryEntry(prev, category.label),
      ...baseEntry,
      learnCount: Number(prev.learnCount || 0) + 1,
    };
  }

  keywordHints.forEach((keyword) => {
    const prev = next.keywordRules[keyword] || {};
    next.keywordRules[keyword] = {
      ...normalizeMemoryEntry(prev, category.label),
      ...baseEntry,
      learnCount: Number(prev.learnCount || 0) + 1,
    };
  });

  await tenantDoc(db, tenantId, 'businessIntelligence', BI_MAIN_DOC_ID).set({
    categoryMemory: next,
    updatedAt: serverTimestamp(),
    lastSavedAt: nowIso,
  }, { merge: true });

  return next;
}

module.exports = {
  BI_MAIN_DOC_ID,
  normalizeKey,
  normalizeKeywordList,
  normalizeCategoryMemory,
  readBiCategoryMemory,
  resolveCategoryMemoryMatch,
  learnBiCategoryMemory,
};