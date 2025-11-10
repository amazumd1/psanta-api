const { Schema, model, Types } = require("mongoose");

const balSchema = new Schema({
  warehouseId: { type: Types.ObjectId, ref: "Warehouse", required: true, index: true },
  locationId:  { type: Types.ObjectId, ref: "WhLocation", required: true, index: true },
  itemId:      { type: Types.ObjectId, ref: "WhItem", required: true, index: true },
  sku:         { type: String, required: true, index: true },
  lot:         { type: String, default: "" },
  expiry:      { type: Date },
  qty:         { type: Number, default: 0 }
}, { timestamps: true });

balSchema.index({ warehouseId: 1, locationId: 1, itemId: 1, lot: 1, expiry: 1 }, { unique: true });

module.exports = model("WhBalance", balSchema);
