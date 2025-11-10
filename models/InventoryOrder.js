// services/api/models/InventoryOrder.js
const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
  {
    id: String,           // FE se aata id (e.g., "shampoo")
    name: String,         // readable name, server fill karega
    qty: { type: Number, default: 0 },
    unitPrice: { type: Number, default: 0 },
    contract: { type: Boolean, default: false },
  },
  { _id: false }
);

const inventoryOrderSchema = new mongoose.Schema(
  {
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
    items: [orderItemSchema],
    total: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['submitted', 'approved', 'rejected'],
      default: 'submitted',
    },
    source: { type: String, default: 'host_onboarding' },
    approvedAt: Date,
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

inventoryOrderSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('InventoryOrder', inventoryOrderSchema);
