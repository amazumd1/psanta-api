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
  suppliesTravelBuffer: { type: Number, default: 0, min: 0 },

  confidence: { type: Number, default: 0.35, min: 0, max: 1 },
  sourceCount: { type: Number, default: 1, min: 0 },
  sources: { type: [String], default: [] },
  notes: { type: String, default: '' },
}, { timestamps: true });

MarketRateProfileSchema.index({ zip: 1, service: 1 }, { unique: true });

module.exports = mongoose.model('MarketRateProfile', MarketRateProfileSchema);