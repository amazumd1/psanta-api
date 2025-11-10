const mongoose = require("mongoose");

const ApprovalSchema = new mongoose.Schema({
  entity: { type: String, required: true },            // "order"
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  status: { type: String, enum: ["pending","approved","rejected"], default: "pending" },
  note: String,
}, { timestamps: true });

module.exports = mongoose.model("Approval", ApprovalSchema);
