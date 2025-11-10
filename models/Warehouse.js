const mongoose = require('mongoose');

const WarehouseSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true, trim: true },
  name: { type: String, required: true, trim: true },
  address: {
    line1: String, line2: String, city: String, state: String, zip: String
  },
  status: {
    type: String,
    enum: ["pending_pick", "picking", "ready", "shipped", "stocked", "closed"],
    default: "stocked"
  }
}, { timestamps: true });

// Reuse compiled model if exists
module.exports = mongoose.models.Warehouse || mongoose.model('Warehouse', WarehouseSchema);
