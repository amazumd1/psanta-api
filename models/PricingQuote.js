// services/api/models/PricingQuote.js
const mongoose = require('mongoose');

const PricingQuoteSchema = new mongoose.Schema({
  quoteId: { type: String, required: true, unique: true, index: true },
  priceLockToken: { type: String, required: true, index: true },
  tenantId: { type: String, default: '' },
  propertyId: { type: String, default: '' },

  inputSnapshot: { type: Object, default: {} },
  marketProfileSnapshot: { type: Object, default: null },
  pricingConfigVersion: { type: String, default: '' },

  total: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'USD' },
  breakdown: { type: Object, default: {} },

  status: { type: String, enum: ['quoted', 'used', 'expired'], default: 'quoted', index: true },
  expiresAt: { type: Date, required: true, index: true },
  usedAt: { type: Date, default: null },
  quoteHash: { type: String, required: true },
}, { timestamps: true });

module.exports = mongoose.model('PricingQuote', PricingQuoteSchema);