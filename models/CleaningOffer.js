// services/api/models/CleaningOffer.js
const mongoose = require('mongoose');

const scheduleSchema = new mongoose.Schema(
  { date: { type: String, required: true }, time: { type: String, default: '' } },
  { _id: false }
);

const cleaningOfferSchema = new mongoose.Schema(
  {
    // NOTE: tumhare route me "propertyId" use ho raha hai — wahi rakha hai
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
    minutes: { type: Number, default: 0 },
    hourly:  { type: Number, default: 0 },
    total:   { type: Number, default: 0 },
    locked:  { type: Boolean, default: false },
    schedule: [scheduleSchema],
    status: { type: String, enum: ['draft','active'], default: 'draft' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CleaningOffer', cleaningOfferSchema);
