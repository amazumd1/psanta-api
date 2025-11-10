const mongoose = require('mongoose');

const SuggestionSchema = new mongoose.Schema({
  messageId: { type: String },
  orderId:   { type: String },
  jobId:     { type: String },
  reason:    { type: String },
  planName:  { type: String },
  items: [{
    sku: String,
    extraQty: Number
  }],
  status: { type: String, enum: ['pending','applied','rejected'], default: 'pending' },
  appliedAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('Suggestion', SuggestionSchema);


