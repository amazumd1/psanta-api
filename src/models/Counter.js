const mongoose = require('mongoose');

const CounterSchema = new mongoose.Schema(
  { key: { type: String, required: true, unique: true },
    seq: { type: Number, required: true, default: 200 } },
  { versionKey: false, timestamps: false }
);

module.exports = mongoose.models.Counter || mongoose.model('Counter', CounterSchema);


