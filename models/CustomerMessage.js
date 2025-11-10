const mongoose = require('mongoose');

const LineMsgSchema = new mongoose.Schema({
  skuId: { type: String, required: true },
  name: String,
  expected_qty: { type: Number, default: 0 },
  reported_missing_qty: { type: Number, default: 0 },
  note: String,
}, { _id: false });

const JobSnapSchema = new mongoose.Schema({
  expected_g: Number,
  packed_net_g: Number,
  variance_g: Number,
  pass: Boolean,
  sscc: String,
}, { _id: false });

const MessageSchema = new mongoose.Schema({
  messageId: { type: String, unique: true, index: true },        // e.g. MSG-abc123
  jobId:     { type: String, index: true, required: true },

  // denorm references for filters
  orderId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  propertyId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Property' },
  customerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // plan snapshot (denorm)
  planId: String,
  planName: String,
  activeServices: [String],

  // payload
  reason: { type: String, enum: ['shortage','damaged','wrong_item','other'], required: true },
  lines:  [LineMsgSchema],
  note:   String,
  photos: [String], // store URLs (can add upload route later)

  // job snapshot at time of message
  job_snapshot: JobSnapSchema,

  // triage & tags
  triage_state: { type: String, enum: ['open','ack','in_progress','resolved'], default: 'open', index: true },
  tags: [String],
}, { timestamps: true });

MessageSchema.index({ jobId: 1, createdAt: -1 });
MessageSchema.index({ triage_state: 1, reason: 1, propertyId: 1, planId: 1, createdAt: -1 });

module.exports = mongoose.model('CustomerMessage', MessageSchema);
