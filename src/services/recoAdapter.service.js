// Wrap your existing model call here (HTTP/local/lib). For now, accept payload and return normalized.
async function processCustomerMessage({ messageId, customerId, skuId, jobId, text }) {
  // TODO: hook your actual model
  // Return normalized signal irrespective of phrase:
  return {
    intent: 'early_depletion',
    confidence: 0.8,
    entities: { skuId, jobId },
    rationale: 'Model detected early depletion intent'
  };
}
module.exports = { processCustomerMessage };
