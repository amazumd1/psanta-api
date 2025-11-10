const mongoose = require('mongoose');

const PaymentSchema = new mongoose.Schema({
  type: { type: String, enum: ['one_time','subscription'], required: true },
  propertyId: { type: String, index: true },
  userId: { type: String },
  currency: { type: String, default: 'USD' },
  amount: { type: Number, required: true },         // in dollars
  quoteHash: { type: String },                      // server-side recompute snapshot hash
  paypal: {
    orderId: String,
    captureId: String,
    subscriptionId: String,
    rawCreateResponse: Object,
    rawCaptureResponse: Object,
    payer: Object,
  },
  status: { type: String, enum: ['created','approved','captured','failed','refunded'], default: 'created' },
}, { timestamps: true });

module.exports = mongoose.model('Payment', PaymentSchema);
