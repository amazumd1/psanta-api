const mongoose = require('mongoose');

const AlertSchema = new mongoose.Schema({
  type: { type: String, enum: ['next_pack_recommendation'], required: true },
  status: { type: String, enum: ['open', 'applied', 'dismissed'], default: 'open' },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  jobId: { type: String },
  skuId: { type: String, required: true },
  remainingDays: { type: Number }, // computed at alert time
  signal: {
    earlyDepletionConfidence: { type: Number }, // 0..1
    projectionDays: { type: Number },           // nullable
    historyFastCycles: { type: Number }         // count
  },
  recommendation: {
    currentPackGrams: { type: Number },
    suggestedTopUpGrams: { type: Number },
    suggestedNextCyclePackGrams: { type: Number },
    safetyPct: { type: Number, default: 0.10 },
    packStep: { type: Number, default: 250 }
  },
  links: {
    messageId: { type: String },
    subscriptionLineId: { type: mongoose.Schema.Types.ObjectId },
    linkedOrderId: { type: mongoose.Schema.Types.ObjectId }
  },
  meta: {
    source: { type: String, default: 'customer_message' }, // or 'nightly_projection'
    reason: { type: String },
  }
}, { timestamps: true });

AlertSchema.index({ customerId: 1, skuId: 1, type: 1, status: 1 });
AlertSchema.index({ 'links.messageId': 1 }, { sparse: true });

AlertSchema.index({ status: 1, createdAt: -1 });
AlertSchema.index({ jobId: 1, skuId: 1 });

module.exports = mongoose.model('Alert', AlertSchema);
