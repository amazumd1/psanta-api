// services/api/src/models/wh/Item.js
const mongoose = require("mongoose");

const ItemSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, default: "", trim: true },
    uom: { type: String, default: "EA" },
    barcode: { type: String, default: "" },
    lotTracked: { type: Boolean, default: false },
    expiryTracked: { type: Boolean, default: false },
    packSize: { type: Number, default: 1 },
    reorderPoint: { type: Number, default: 0 }, // low-stock threshold
  },
  { timestamps: true, collection: "wh_items" }
);

// 🔎 Indexes (fast search + uniqueness on SKU)
ItemSchema.index({ sku: 1 }, { unique: true });
ItemSchema.index({ barcode: 1 });
ItemSchema.index({ name: "text" });

module.exports = mongoose.model("Item", ItemSchema);
