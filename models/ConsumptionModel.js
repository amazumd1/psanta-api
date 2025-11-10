// services/api/models/ConsumptionModel.js
const mongoose = require('mongoose');

/**
 * Per property + SKU consumption learning store (EWMA)
 * μ: grams per occupied day (g/occ-day)
 * σ: variability (g/occ-day)
 */
const Schema = new mongoose.Schema({
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', index: true },
  skuId: { type: String, index: true },

  mu_g_per_day: { type: Number, default: 0 },       // moving average
  sigma_g_per_day: { type: Number, default: 0 },    // moving stddev (EWMA style)
  N: { type: Number, default: 0 },                   // effective samples count

  // diagnostics
  lastSample: {
    days: Number,
    used_g: Number,
    stockout: Boolean,
    topups: Number,
    capturedAt: Date
  },

  // penalty for recent stockouts (0..1+)
  stockout_penalty: { type: Number, default: 1.0 },  // multiplies recommendation slightly if >1

  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

Schema.index({ propertyId: 1, skuId: 1 }, { unique: true });

module.exports = mongoose.model('ConsumptionModel', Schema);
