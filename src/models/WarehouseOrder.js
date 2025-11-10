// services/api/src/models/WarehouseOrder.js
const { Schema, model, models } = require('mongoose');

const ItemSchema = new Schema({
  skuId: String,
  name: String,
  qty: Number,
  unitPrice: Number,
  expected_ship_weight_g: Number,
  packed_weight_g: Number,
  tolerance_g: Number,
  tolerance_pct: Number,
}, { _id: false });

const WarehouseOrderSchema = new Schema({
  orderId: { type: String, index: true, unique: true, sparse: true, required: true },
  status: {
    type: String,
    enum: ['pending_pick','picking','picked','ready','shipped','stocked','closed','cancelled'],
    default: 'pending_pick',
    index: true,
  },
  customerId: { type: Schema.Types.ObjectId, ref: 'User' },
  items: { type: [ItemSchema], default: [] },
  meta: {
    propertyId: { type: Schema.Types.ObjectId, ref: 'Property' },
  },
}, { timestamps: true, versionKey: false });

WarehouseOrderSchema.index({ customerId: 1 });
WarehouseOrderSchema.index({ 'meta.propertyId': 1 });

WarehouseOrderSchema.index(
  { 'meta.requestId': 1 },
  { unique: true, partialFilterExpression: { 'meta.requestId': { $type: 'string' } } }
);

module.exports = models.WarehouseOrder || model('WarehouseOrder', WarehouseOrderSchema);
