const { Schema, model, models } = require('mongoose');
const AlertSchema = new Schema({
  title: { type: String, required: true },
  level: { type: String, enum: ["info","warn","critical"], default: "info" },
  note:  { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });
module.exports = models.Alert || model('Alert', AlertSchema);
