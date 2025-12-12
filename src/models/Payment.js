// const mongoose = require('mongoose');

// const PaymentSchema = new mongoose.Schema({
//   type: { type: String, enum: ['one_time','subscription'], required: true },
//   propertyId: { type: String, index: true },
//   userId: { type: String },
//   currency: { type: String, default: 'USD' },
//   amount: { type: Number, required: true },         // in dollars
//   quoteHash: { type: String },                      // server-side recompute snapshot hash
//   cart: { type: mongoose.Schema.Types.Mixed, default: null },
//   paypal: {
//     orderId: String,
//     captureId: String,
//     subscriptionId: String,
//     rawCreateResponse: Object,
//     rawCaptureResponse: Object,
//     payer: Object,
//   },
//   status: { type: String, enum: ['created','approved','captured','failed','refunded'], default: 'created' },
// }, { timestamps: true });


// module.exports = mongoose.model('Payment', PaymentSchema);



// models/Payment.js
const mongoose = require('mongoose');

const PaymentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['one_time', 'subscription'],
      required: true,
    },

    // 🔗 Invoice link (important for invoice update)
    invoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Invoice',
    },

    // Existing fields
    propertyId: { type: String, index: true },
    userId: { type: String },

    currency: { type: String, default: 'USD' },

    // in dollars
    amount: { type: Number, required: true },

    // Optional: gross same as amount (some flows use `gross`)
    gross: { type: Number },

    // kis source se aaya (customer_portal, paypal_invoice, etc.)
    source: { type: String },

    // customer email store karne ke liye
    customerEmail: { type: String },

    // server-side recompute snapshot hash
    quoteHash: { type: String },

    cart: { type: mongoose.Schema.Types.Mixed, default: null },

    paypal: {
      orderId: String,
      captureId: String,
      subscriptionId: String,
      rawCreateResponse: Object,
      rawCaptureResponse: Object,
      payer: Object,
      invoiceId: String, // invoice-specific PayPal id
    },

    status: {
      type: String,
      enum: ['created', 'approved', 'captured', 'failed', 'refunded', 'void'],
      default: 'created',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payment', PaymentSchema);
