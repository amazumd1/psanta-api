// services/api/models/Sku.js
const mongoose = require('mongoose');

const skuSchema = new mongoose.Schema({
  skuId: { type: String, unique: true, index: true },
  name: String,
  uom: { type: String, default: 'ea' },

  // weight controls
  net_weight_g: { type: Number, default: 0 },    // contents
  gross_weight_g: { type: Number, default: 0 },  // shipped unit incl. packaging
  tare_g: { type: Number, default: 0 },          // empty container (if you weighback)

  // consumption planning
  consumption_g_per_day: { type: Number, default: 0 },

  // pricing (optional; you already price elsewhere)
  price: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Sku', skuSchema);
