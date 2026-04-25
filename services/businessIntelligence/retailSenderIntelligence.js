const { resolveCanonicalBiCategory } = require('./biCategories');
const { categorizeBusinessSignal, dedupe, countMatches } = require('./biUnifiedCategorization');
const { resolveCategoryMemoryMatch } = require('./biCategoryMemoryService');

const RETAIL_SUGGESTION_SCORE_THRESHOLD = 4;

function normalizeEmail(value = '') {
  const text = String(value || '').trim().toLowerCase();
  const angle = text.match(/<([^>]+)>/);
  return String(angle?.[1] || text).trim().toLowerCase();
}

function extractSenderEmail(sender = '') {
  const email = normalizeEmail(sender);
  return /@/.test(email) ? email : '';
}

function extractSenderDomain(sender = '') {
  const email = extractSenderEmail(sender);
  return email.includes('@') ? email.split('@')[1] : '';
}

function parseDisplayName(sender = '') {
  const raw = String(sender || '').trim();
  if (!raw) return '';
  const angle = raw.match(/^(.*?)\s*</);
  return String(angle?.[1] || raw.replace(/<[^>]+>/g, '')).trim().replace(/^\"|\"$/g, '');
}

function classifySenderText(text = '', memory = {}, meta = {}) {
  const source = String(text || '').toLowerCase();
  const senderEmail = String(meta.senderEmail || '').trim().toLowerCase();
  const senderDomain = String(meta.senderDomain || '').trim().toLowerCase();
  const memoryMatch = resolveCategoryMemoryMatch(memory, { senderEmail, senderDomain, text: source });

  if (memoryMatch?.category) {
    return {
      primaryKind: 'learned_memory',
      suggestedCategory: memoryMatch.category,
      likelyLabel: 'Learned business sender',
      suggestionHeadline: 'Learned sender memory matched',
      suggestionCopy: `This sender matches learned BI memory from prior operator decisions. The system will favor ${memoryMatch.category} automatically.`,
      notificationTone: 'emerald',
      recommendedApprovalMode: memoryMatch.matchedBy === 'domain' ? 'domain' : 'email',
      matchedBy: memoryMatch.matchedBy,
    };
  }

  const categorized = categorizeBusinessSignal({
    text: source,
    senderEmail,
    senderDomain,
    memory,
  });

  const canonical = resolveCanonicalBiCategory({
    value: categorized.category,
    text: source,
    fallbackLabel: categorized.category || 'General Ops',
  });

  const category = canonical?.label || categorized.category || 'General Ops';
  const lowerCategory = category.toLowerCase();

  if (/1099/.test(lowerCategory)) {
    return {
      primaryKind: '1099_tax',
      suggestedCategory: category,
      likelyLabel: 'Likely 1099 / tax',
      suggestionHeadline: 'Tax or contractor document detected',
      suggestionCopy: 'This sender looks like a 1099, W-9, IRS, or contractor-payment source. Approve it to keep future tax-related emails visible in Business Intelligence.',
      notificationTone: 'violet',
      recommendedApprovalMode: 'domain',
    };
  }

  if (/rental income|business income/.test(lowerCategory)) {
    return {
      primaryKind: 'income',
      suggestedCategory: category,
      likelyLabel: 'Likely income',
      suggestionHeadline: 'Income or payout signal detected',
      suggestionCopy: 'This sender looks like a payout or income source. Approve it so future income emails can appear in your business view, not just your inbox.',
      notificationTone: 'emerald',
      recommendedApprovalMode: 'domain',
    };
  }

  if (/utilities/.test(lowerCategory)) {
    return {
      primaryKind: 'utility',
      suggestedCategory: category,
      likelyLabel: 'Likely utility',
      suggestionHeadline: 'Utility-type sender detected',
      suggestionCopy: 'This sender looks like a utilities vendor. Approve it to automatically catch future water, electric, gas, internet, or trash charges.',
      notificationTone: 'amber',
      recommendedApprovalMode: 'domain',
    };
  }

  if (/maintenance/.test(lowerCategory)) {
    return {
      primaryKind: 'maintenance',
      suggestedCategory: category,
      likelyLabel: 'Likely maintenance',
      suggestionHeadline: 'Maintenance or repair sender detected',
      suggestionCopy: 'This sender looks like a property maintenance or repair vendor. Approve it to track repeat issues and vendor spend inside Business Intelligence.',
      notificationTone: 'amber',
      recommendedApprovalMode: 'email',
    };
  }

  if (/insurance/.test(lowerCategory)) {
    return {
      primaryKind: 'insurance',
      suggestedCategory: category,
      likelyLabel: 'Likely insurance',
      suggestionHeadline: 'Insurance billing signal detected',
      suggestionCopy: 'This sender looks like an insurance source. Approve it to keep future premium notices and policy invoices in your business records.',
      notificationTone: 'sky',
      recommendedApprovalMode: 'domain',
    };
  }

  if (/professional fees/.test(lowerCategory)) {
    return {
      primaryKind: 'professional_services',
      suggestedCategory: category,
      likelyLabel: 'Likely professional fee',
      suggestionHeadline: 'Professional-service spend detected',
      suggestionCopy: 'This sender looks like a legal, accounting, consulting, or other professional-services vendor. Approve it to surface future business fees automatically.',
      notificationTone: 'sky',
      recommendedApprovalMode: 'email',
    };
  }

  if (/supplies/.test(lowerCategory)) {
    return {
      primaryKind: 'supplies',
      suggestedCategory: category,
      likelyLabel: 'Likely supplies',
      suggestionHeadline: 'Supply or retail spend detected',
      suggestionCopy: 'This sender looks like a supply or retail purchase source. Approve it if these charges should flow into your tracked business expenses.',
      notificationTone: 'slate',
      recommendedApprovalMode: 'email',
    };
  }

  if (/general ops/.test(lowerCategory)) {
    return {
      primaryKind: 'business_email',
      suggestedCategory: category,
      likelyLabel: 'Likely business email',
      suggestionHeadline: 'Business-like sender detected',
      suggestionCopy: 'This sender looks relevant to business operations. Approve it if you want future emails from this sender considered during sync.',
      notificationTone: 'slate',
      recommendedApprovalMode: 'email',
    };
  }

  return {
    primaryKind: 'expense',
    suggestedCategory: category,
    likelyLabel: 'Likely business expense',
    suggestionHeadline: 'Business expense sender detected',
    suggestionCopy: 'This sender looks like it regularly sends billing or receipt emails. Approve it to import future business expenses automatically.',
    notificationTone: 'sky',
    recommendedApprovalMode: 'email',
  };
}

function determineAutoImportDisposition({ score = 0, classification = {}, seenCount = 1 }) {
  const category = String(classification?.suggestedCategory || '').toLowerCase();
  const domainMode = String(classification?.recommendedApprovalMode || '').toLowerCase() === 'domain';
  const strongCategory = /(1099|income|utilities|maintenance|insurance|professional fees)/i.test(category);

  if (score >= 8 || (score >= 7 && strongCategory && domainMode) || (score >= 6 && strongCategory && seenCount >= 2)) {
    return { key: 'auto_import_now', label: 'Auto import now', reviewStatus: 'auto_imported' };
  }
  if (score >= RETAIL_SUGGESTION_SCORE_THRESHOLD) {
    return { key: 'pending_review_import', label: 'Pending review import', reviewStatus: 'pending_review' };
  }
  return { key: 'review_only', label: 'Review only', reviewStatus: 'suggestion_only' };
}

function scoreSenderSuggestion(message = {}, { memory = {} } = {}) {
  const senderEmail = extractSenderEmail(message.sender);
  const senderDomain = extractSenderDomain(message.sender);
  const senderDisplayName = parseDisplayName(message.sender);
  const subject = String(message.subject || '');
  const snippet = String(message.snippet || '');
  const bodyPlain = String(message.bodyPlain || '');
  const attachmentNames = Array.isArray(message.attachmentNames) ? message.attachmentNames : [];
  const attachmentTypes = Array.isArray(message.attachmentTypes) ? message.attachmentTypes : [];
  const sourceText = [subject, snippet, bodyPlain, senderDisplayName, senderDomain, attachmentNames.join(' \n ')].join(' \n ').toLowerCase();

  let score = 0;
  const reasons = [];
  const suggestedKinds = [];

  const receiptHits = countMatches(sourceText, /(receipt|invoice|order confirmation|bill|statement|amount due|paid|payment confirmation|payment received|subtotal|total)/gi);
  if (receiptHits > 0) {
    score += Math.min(3, receiptHits);
    reasons.push('Receipt or invoice language detected');
    suggestedKinds.push('expense');
  }

  const amountHits = countMatches(sourceText, /\$\s?\d[\d,]*(?:\.\d{2})?/g);
  if (amountHits > 0) {
    score += 1;
    reasons.push('Contains dollar amounts');
  }

  const attachmentBoost = attachmentNames.some((name) => /\.(pdf|csv|xlsx?)$/i.test(name)) || attachmentTypes.some((type) => /(pdf|csv|sheet|excel)/i.test(type));
  if (attachmentBoost) {
    score += 1;
    reasons.push('Business attachment present');
  }

  if (/(billing|invoice|receipts|accounts|payments|support|statements|notices|documents|tax|forms)/i.test(senderEmail)) {
    score += 1;
    reasons.push('Sender name looks operational');
  }

  const categorized = categorizeBusinessSignal({
    text: sourceText,
    senderEmail,
    senderDomain,
    memory,
  });
  if (categorized.category) {
    score += categorized.confidence === 'high' ? 3 : categorized.confidence === 'medium' ? 2 : 1;
    reasons.push(`Unified categorization mapped to ${categorized.category}`);
    suggestedKinds.push(categorized.category);
  }

  const negativeHits = countMatches(sourceText, /(newsletter|sale ends|coupon|promo code|marketing|review your purchase|survey|discount|deal alert|unsubscribe)/gi);
  if (negativeHits > 0) {
    score -= Math.min(3, negativeHits);
    reasons.push('Marketing-like wording also present');
  }

  const classification = classifySenderText(sourceText, memory, { senderEmail, senderDomain });
  const autoImportDisposition = determineAutoImportDisposition({ score, classification, seenCount: 1 });

  return {
    senderEmail,
    senderDomain,
    senderDisplayName,
    score,
    confidence: score >= 7 ? 'high' : score >= RETAIL_SUGGESTION_SCORE_THRESHOLD ? 'medium' : 'low',
    reasons: dedupe([...(categorized.reasons || []), ...reasons]),
    suggestedKinds: dedupe([...(suggestedKinds || []), classification.primaryKind]),
    suggestedCategory: classification.suggestedCategory,
    primaryKind: classification.primaryKind,
    likelyLabel: classification.likelyLabel,
    suggestionHeadline: classification.suggestionHeadline,
    suggestionCopy: classification.suggestionCopy,
    notificationTone: classification.notificationTone,
    recommendedApprovalMode: classification.recommendedApprovalMode,
    autoImportDisposition: autoImportDisposition.key,
    autoImportLabel: autoImportDisposition.label,
    reviewStatus: autoImportDisposition.reviewStatus,
    shouldSuggest: Boolean(senderEmail) && score >= RETAIL_SUGGESTION_SCORE_THRESHOLD,
    sampleSubject: String(subject || snippet || '').slice(0, 240),
    sampleSnippet: String(snippet || bodyPlain || '').slice(0, 400),
    sampleMessageDate: String(message.messageDate || '').trim(),
  };
}

module.exports = {
  RETAIL_SUGGESTION_SCORE_THRESHOLD,
  normalizeEmail,
  extractSenderEmail,
  extractSenderDomain,
  parseDisplayName,
  classifySenderText,
  determineAutoImportDisposition,
  scoreSenderSuggestion,
};