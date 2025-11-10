const { Schema, model, models } = require("mongoose");

const whSchema = new Schema({
  code: { type: String, required: true, unique: true, index: true, trim: true },
  name: { type: String, required: true, trim: true }
}, { timestamps: true });

// Reuse compiled model if it exists to avoid OverwriteModelError
module.exports = models.Warehouse || model("Warehouse", whSchema);
