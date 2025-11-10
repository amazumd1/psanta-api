// services/api/models/PropertyStock.js
const mongoose = require('mongoose');

const PropertyStockSchema = new mongoose.Schema({
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', index: true },
  orderId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  jobId:      { type: String, index: true }, // WarehouseJob.jobId
  sscc:       { type: String, index: true }, // label-trace

  skuId:      { type: String, index: true },
  name:       String,
  qty_ea:     { type: Number, default: 0 },

  // optional: weights/lot/expiry copied for audits
  expected_line_gross_g: Number,
  packed_line_gross_g:   Number,
  lot: String,
  expiry: Date,

  // status in property
  status: { type: String, enum: ['active','consumed','lost','returned'], default: 'active', index: true },

  // consumption logs
  events: [{
    ts: { type: Date, default: Date.now },
    type: { type: String, enum: ['consume','adjust','return'], default: 'consume' },
    qty_ea: Number,
    note: String,
    by: String // user/cleaner
  }]
}, { timestamps: true });

module.exports = mongoose.model('PropertyStock', PropertyStockSchema);
