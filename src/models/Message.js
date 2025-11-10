// services/api/src/models/Message.js
const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema(
  {
    messageId: { type: String, unique: true, index: true },
    jobId: { type: String, required: true },           // a.k.a orderId
    details: { type: String, required: true },         // message text
    reason: {
      type: String,
      enum: ['shortage', 'damaged', 'wrong_item', 'other'],
      default: 'other'
    },
    tags: [{ type: String }],                          // e.g. ["weight_exhausted"]
    from: { type: String, enum: ['customer', 'admin'], default: 'customer' },
    triage_state: { type: String, enum: ['new', 'in_progress', 'resolved', 'dismissed'], default: 'new' },
    planName: { type: String },                        // optional
    meta: { type: Object },                            // optional extra info
  },
  { timestamps: true }
);

module.exports = mongoose.models.Message || mongoose.model('Message', MessageSchema);
