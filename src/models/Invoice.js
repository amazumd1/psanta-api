// services/api/src/models/Invoice.js
const mongoose = require('mongoose');

const InvoiceLineSchema = new mongoose.Schema({
  sku: { type: String },
  description: { type: String, required: true },
  qty: { type: Number, default: 1 },
  unitPrice: { type: Number, required: true }, // dollars
  amount: { type: Number, required: true },    // qty * unitPrice (dollars)
}, { _id: false });

const InvoiceSchema = new mongoose.Schema({
  customerId: { type: String, index: true },   // maps to Payment.userId
  propertyId: { type: String, index: true },   // maps to Payment.propertyId
  period: {
    month: { type: Number }, // 1-12 (optional for one-off)
    year: { type: Number },  // YYYY
  },
  lines: { type: [InvoiceLineSchema], default: [] },
  subtotal: { type: Number, required: true },
  tax: { type: Number, default: 0 },
  total: { type: Number, required: true },
  status: { type: String, enum: ['issued', 'paid', 'void'], default: 'paid' },
  payments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Payment' }],
  pdfUrl: { type: String },                    // if you generate & upload from ops-app
}, { timestamps: true });

module.exports = mongoose.model('Invoice', InvoiceSchema);
