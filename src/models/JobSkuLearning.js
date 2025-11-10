const mongoose = require('mongoose');

const JobSkuLearningSchema = new mongoose.Schema({
  jobId: { type: String, required: true },
  skuId: { type: String, required: true },
  overuseFactor: { type: Number, default: 1.0 }, // EWMA multiplier
  history: [{
    ts: { type: Date, default: Date.now },
    expected: Number,
    actual: Number,
    factor: Number,
    note: String
  }]
}, { timestamps: true });

JobSkuLearningSchema.index({ jobId: 1, skuId: 1 }, { unique: true });

module.exports = mongoose.model('JobSkuLearning', JobSkuLearningSchema);
