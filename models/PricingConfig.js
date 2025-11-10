// services/api/models/PricingConfig.js
const mongoose = require('mongoose');

const TimeSchema = new mongoose.Schema({
  base_minutes: { type: Number, default: 60 },
  per_bed_minutes: { type: Number, default: 18 },
  per_bath_minutes: { type: Number, default: 22 },
  per_1000sqft_minutes: { type: Number, default: 12 },
  min_minutes_floor: { type: Number, default: 60 },
  max_minutes_cap: { type: Number, default: 600 },
}, { _id: false });

const BillingSchema = new mongoose.Schema({
  use_direct_rate: { type: Boolean, default: false },
  labor_hourly_cost: { type: Number, default: 22 },
  margin_percent: { type: Number, default: 45 },
  direct_billing_hourly_rate: { type: Number, default: 45 },
  visit_fee: { type: Number, default: 0 },
  min_job_value: { type: Number, default: 0 },
  weekend_factor: { type: Number, default: 1.15 },
  holiday_factor: { type: Number, default: 1.3 },
  zip_factor_default: { type: Number, default: 1 },
  rounding_step: { type: Number, default: 5 },
  charm_style: { type: String, enum: ['.99', '.00'], default: '.99' },
}, { _id: false });

const StateSchema = new mongoose.Schema({
  code: { type: String, required: true },        // e.g. "NC"
  time: { type: TimeSchema, default: () => ({}) },
  billing: { type: BillingSchema, default: () => ({}) },
  zips: { type: Map, of: Number, default: undefined },  // optional zip multipliers
}, { _id: false });

const MultiVisitTier = new mongoose.Schema({
  min: Number,
  percent: Number,
}, { _id: false });

const PricingConfigSchema = new mongoose.Schema({
  states: { type: Map, of: StateSchema, default: {} }, // key = "NC" -> StateSchema
  multiVisit: {
    tiers: { type: [MultiVisitTier], default: [
      { min: 4, percent: 5 }, { min: 8, percent: 7 }, { min: 12, percent: 10 }
    ]},
  },
}, { timestamps: true });

module.exports = mongoose.model('PricingConfig', PricingConfigSchema);
