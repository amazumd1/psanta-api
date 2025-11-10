const mongoose = require("mongoose");

const OrderItemSchema = new mongoose.Schema({
  skuId: String,
  name: String,
  qty: Number,
  unitPrice: Number,
  contract: Boolean,

    // NEW: weight fields (line level)
  expected_ship_weight_g: { type: Number, default: 0 }, // qty * gross_weight_g
  packed_weight_g: { type: Number, default: 0 },        // optional per-line capture
  tolerance_g: { type: Number, default: 10 },
  tolerance_pct: { type: Number, default: 0.02 },
}, { _id: false });

const OrderSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: "Property" },
  items: [OrderItemSchema],
  subtotal: Number,
  total: Number,
  status: { type: String, enum: ["submitted","approved","to_warehouse","completed","rejected"], default: "submitted", index: true },
  type: { type: String, default: "inventory" },
  source: String,
  approvedAt: Date,
  toWarehouseAt: Date,
}, { timestamps: true });

module.exports = mongoose.model("Order", OrderSchema);
