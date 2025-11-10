const mongoose = require('mongoose');

const EventSchema = new mongoose.Schema(
  {
    type: { type: String, required: true }, // 'payment_captured' | 'jobs_created' | ...
    message: String,
    propertyId: String,
    orderId: String,
    paymentId: String,
    userId: String,
    meta: {},
    // 👇 CEO feed yahi field pe query karega
    createdAt: { type: Date, default: Date.now }
  },
  { timestamps: false, collection: 'events' }
);

EventSchema.index({ createdAt: -1 });
EventSchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model('Event', EventSchema);
