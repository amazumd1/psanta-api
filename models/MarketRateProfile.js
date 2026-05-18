// services/api/models/MarketRateProfile.js
const mongoose = require('mongoose');

const MarketRateProfileSchema = new mongoose.Schema({
  zip: { type: String, required: true, trim: true, index: true },
  service: { type: String, required: true, trim: true, index: true },

  marketLow: { type: Number, required: true, min: 0 },
  marketMedian: { type: Number, required: true, min: 0 },
  marketHigh: { type: Number, required: true, min: 0 },

  cleanerPayoutFloor: { type: Number, required: true, min: 0 },
  platformMarginPct: { type: Number, default: 22, min: 0, max: 80 },
  paymentFeeBuffer: { type: Number, default: 8, min: 0 },
  suppliesTravelBuffer: { type: Number, default: 0 },

  confidence: { type: Number, default: 0.35, min: 0, max: 1 },
  sourceCount: { type: Number, default: 1, min: 0 },
  sources: { type: [String], default: [] },
  notes: { type: String, default: '' },

  // New governance fields
  status: {
    type: String,
    enum: ['verified', 'review_required', 'rejected'],
    default: 'verified',
    index: true,
  },
  pricingSource: {
    type: String,
    enum: [
      'manual_admin',
      'manual_admin_review',
      'ai_search_consensus',
      'ai_search_local_vendor',
      'ai_search_nearby_consensus',
      'ai_search_incomplete',
    ],
    default: 'manual_admin',
    index: true,
  },
  reviewStatus: { type: String, default: 'manual_verified' },
  safeToAutoSave: { type: Boolean, default: true },

  canAutoApprove: { type: Boolean, default: false },
  originalReviewStatus: { type: String, default: '' },

  quality: { type: mongoose.Schema.Types.Mixed, default: {} },
  evidence: { type: [mongoose.Schema.Types.Mixed], default: [] },
  rejectedPriceSignals: { type: [mongoose.Schema.Types.Mixed], default: [] },

  verifiedAt: { type: Date, default: null },
  reviewedAt: { type: Date, default: null },
}, { timestamps: true });

MarketRateProfileSchema.index({ zip: 1, service: 1 }, { unique: true });

module.exports = mongoose.model('MarketRateProfile', MarketRateProfileSchema);