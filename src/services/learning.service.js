// services/api/src/services/learning.service.js
const Suggestion = require('../models/Suggestion');

/**
 * Simple rule: shortage/wrong_item ⇒ +1 unit bump next cycle
 * damaged ⇒ optional (0 or +1 based on your policy)
 * default ⇒ 0
 */
function reasonToDelta(reason) {
  switch (reason) {
    case 'shortage':
    case 'wrong_item':
      return 1;
    case 'damaged':
      return 1; // ya 0, aapki policy. For now +1 to be safe.
    default:
      return 0;
  }
}

/**
 * Create suggestion(s) for a job/plan on the basis of a customer message.
 * For SINGLE-SKU flows we just store one suggestion with sku=SINGLE_SKU.
 */
async function createSuggestionFromMessage({ jobId, planName, reason, messageId }) {
  const delta = reasonToDelta(reason);
  if (!delta) return null;

  const doc = await Suggestion.create({
    jobId,
    planName,
    sku: 'SINGLE_SKU',
    deltaQty: delta,
    source: 'message',
    messageId,
    status: 'pending',
    nextApplicableCycle: null, // optional: set by scheduler
  });

  return doc;
}

module.exports = {
  createSuggestionFromMessage,
};


const JobSkuLearning = require('../models/JobSkuLearning');

async function updateOveruseFactor({ jobId, skuId, expected, actual, ewma = 0.5 }) {
  const inst = Math.max(0.5, Math.min(2.0, (expected > 0 ? actual / expected : 1.0)));
  const doc = await JobSkuLearning.findOneAndUpdate(
    { jobId, skuId },
    { $setOnInsert: { overuseFactor: 1.0 }, $push: { history: { expected, actual, factor: inst } } },
    { new: true, upsert: true }
  );
  const next = ewma * inst + (1 - ewma) * (doc ? doc.overuseFactor : 1.0);
  doc.overuseFactor = next;
  await doc.save();
  return doc.overuseFactor;
}

async function getOveruseFactor({ jobId, skuId }) {
  const doc = await JobSkuLearning.findOne({ jobId, skuId });
  return doc?.overuseFactor ?? 1.0;
}

module.exports = { updateOveruseFactor, getOveruseFactor };

