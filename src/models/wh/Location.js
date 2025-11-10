const { Schema, model, Types } = require("mongoose");

const locSchema = new Schema({
  warehouseId: { type: Types.ObjectId, ref: "Warehouse", required: true, index: true },
  code:        { type: String, required: true, trim: true, index: true },   // e.g. STAGE, A-01-01
  type:        { type: String, enum: ["STAGE","BIN","PICK","BACK"], default: "BIN", index: true },
  blocked:     { type: Boolean, default: false }
}, { timestamps: true });

locSchema.index({ warehouseId: 1, code: 1 }, { unique: true });

module.exports = model("WhLocation", locSchema);
