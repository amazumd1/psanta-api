// services/api/src/models/Subscription.js
const mongoose = require('mongoose');

const SubscriptionSchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', index: true, required: true },

    planCode: { type: String, default: 'CLEAN_MONTHLY' }, // CLEAN_WEEKLY | CLEAN_BIWEEKLY | CLEAN_MONTHLY
    interval: { type: String, enum: ['week', 'month'], default: 'month' },

    priceCents: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },

    status: { type: String, enum: ['active', 'paused', 'canceled', 'trialing', 'incomplete'], default: 'incomplete', index: true },
    nextChargeAt: { type: Date, index: true },
    currentPeriodStart: { type: Date },
    currentPeriodEnd: { type: Date },

    provider: { type: String, enum: ['paypal', 'stripe'], default: 'paypal' },
    providerCustomerId: { type: String },
    providerSubscriptionId: { type: String },

    cancelAtPeriodEnd: { type: Boolean, default: false },

    meta: {
      minNoticeHours: { type: Number, default: 24 },
      maxExtendDays: { type: Number, default: 14 },
    },

    // UI snapshot (optional)
    selectedItems: [
      {
        skuId: String,
        name: String,
        qty: Number,
        priceCents: Number
      }
    ]
  },
  { timestamps: true }
);

module.exports = mongoose.models.Subscription || mongoose.model('Subscription', SubscriptionSchema);
