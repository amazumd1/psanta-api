// services/api/src/models/JobOffer.js
const mongoose = require('mongoose');

const jobOfferSchema = new mongoose.Schema(
  {
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', index: true, required: true },
    cleanerId: { type: String, index: true, required: true }, // Firestore contractBusinesses doc id
    status: {
      type: String,
      enum: ['offered', 'accepted', 'declined', 'expired', 'assigned', 'cancelled'],
      default: 'offered',
      index: true,
    },
    attemptNo: { type: Number, default: 1 },
    token: { type: String, index: true, required: true },
    sentAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },

    // optional denorm
    propertyId: { type: String, default: '' },
    propertyZip: { type: String, default: '' },
    propertyState: { type: String, default: '' },

    // sms audit
    smsSid: { type: String, default: '' },
    smsError: { type: String, default: '' },
  },
  { timestamps: true }
);

jobOfferSchema.index({ jobId: 1, attemptNo: 1 }, { unique: true });

module.exports = mongoose.model('JobOffer', jobOfferSchema);
