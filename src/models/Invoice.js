// // services/api/src/models/Invoice.js
// const mongoose = require('mongoose');

// const InvoiceLineSchema = new mongoose.Schema({
//   sku: { type: String },
//   description: { type: String, required: true },
//   qty: { type: Number, default: 1 },
//   unitPrice: { type: Number, required: true }, // dollars
//   amount: { type: Number, required: true },    // qty * unitPrice (dollars)
// }, { _id: false });

// // const InvoiceSchema = new mongoose.Schema({
// //   fsId: { type: String, index: true },
// //   customerId: { type: String, index: true },   // maps to Payment.userId
// //   propertyId: { type: String, index: true },   // maps to Payment.propertyId
// //   period: {
// //     month: { type: Number }, // 1-12 (optional for one-off)
// //     year: { type: Number },  // YYYY
// //   },
// //   lines: { type: [InvoiceLineSchema], default: [] },
// //   subtotal: { type: Number, required: true },
// //   tax: { type: Number, default: 0 },
// //   total: { type: Number, required: true },
// //   status: { type: String, enum: ['issued', 'paid', 'void'], default: 'paid' },
// //   payments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Payment' }],
// //   pdfUrl: { type: String },                    // if you generate & upload from ops-app
// // }, { timestamps: true });

// const InvoiceSchema = new mongoose.Schema({
//   // 🔹 Firestore-backed manual invoice id (ops-app)
//   fsId: { type: String, index: true },

//   // 🔹 Basic identity
//   number: { type: String, index: true },
//   issueDate: { type: String },  // string hi theek hai abhi
//   dueDate: { type: String },

//   // 🔹 Customer info (manual invoices ke liye)
//   customerName: { type: String },
//   customerEmail: { type: String },
//   customerAddress: { type: String },

//   customerId: { type: String, index: true },   // maps to Payment.userId
//   propertyId: { type: String, index: true },   // maps to Payment.propertyId

//   period: {
//     month: { type: Number }, // 1-12 (optional for one-off)
//     year: { type: Number },  // YYYY
//   },

//   // 🔹 Line items
//   lines: { type: [InvoiceLineSchema], default: [] },      // monthly invoices
//   lineItems: { type: [InvoiceLineSchema], default: [] },  // manual FS → Mongo sync

//   subtotal: { type: Number, required: true },
//   tax: { type: Number, default: 0 },
//   discountTotal: { type: Number, default: 0 },
//   total: { type: Number, required: true },

//   amountPaid: { type: Number, default: 0 },
//   balanceDue: { type: Number, default: 0 },

//   status: {
//     type: String,
//     enum: ['issued', 'paid', 'void', 'partial'],
//     default: 'issued',
//   },

//   payments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Payment' }],
//   pdfUrl: { type: String },                    // if you generate & upload from ops-app
// }, { timestamps: true });


// module.exports = mongoose.model('Invoice', InvoiceSchema);



// services/api/src/models/Invoice.js
const mongoose = require('mongoose');

const InvoiceLineSchema = new mongoose.Schema(
  {
    sku: { type: String },
    description: { type: String },
    qty: { type: Number, default: 1 },
    unitPrice: { type: Number, required: true }, // dollars

    // 🔥 yahan se REQUIRED hata diya + smart default
    amount: {
      type: Number,
      default: function () {
        const q = Number(this.qty || 0);
        const u = Number(this.unitPrice || 0);
        if (!Number.isFinite(q) || !Number.isFinite(u)) return 0;
        return +(q * u).toFixed(2);
      },
    },
  },
  { _id: false }
);

const InvoiceSchema = new mongoose.Schema(
  {
    // 🔹 Firestore-backed manual invoice id (ops-app)
    fsId: { type: String, index: true },

    // 🔹 Basic identity
    number: { type: String, index: true },
    issueDate: { type: String }, // "2025-11-19"
    dueDate: { type: String },   // "2025-12-04"

    // 🔹 Customer info (manual invoices ke liye)
    customerName: { type: String },
    customerEmail: { type: String },
    customerAddress: { type: String },

    customerId: { type: String, index: true },   // maps to Payment.userId
    propertyId: { type: String, index: true },   // maps to Payment.propertyId

    year: { type: Number, index: true },
    
    profitChannel: { type: String, index: true },
    period: {
      month: { type: Number }, // 1-12 (optional for one-off)
      year: { type: Number },  // YYYY
    },

    // 🔹 Line items (do arrays support kar rahe hain)
    lines: { type: [InvoiceLineSchema], default: [] },      // monthly invoices
    lineItems: { type: [InvoiceLineSchema], default: [] },  // manual FS → Mongo sync

    subtotal: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    total: { type: Number, default: 0 },

    amountPaid: { type: Number, default: 0 },
    balanceDue: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ['draft', 'sent', 'issued', 'paid', 'void', 'partial'],
      default: 'draft',
    },

    payments: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Payment',
      },
    ],

    pdfUrl: { type: String }, // if you generate & upload from ops-app
  },
  { timestamps: true }
);

// 🔁 Auto-fix hook: line amounts + subtotal/total/balanceDue
InvoiceSchema.pre('save', function (next) {
  try {
    const inv = this;

    const fixArray = (arr) => {
      if (!Array.isArray(arr)) return;
      arr.forEach((li) => {
        if (!li) return;
        if (typeof li.amount !== 'number' || Number.isNaN(li.amount)) {
          const q = Number(li.qty || 0);
          const u = Number(li.unitPrice || 0);
          li.amount = +(q * u).toFixed(2);
        }
      });
    };

    // 1) Dono arrays me amount auto-set
    fixArray(inv.lineItems);
    fixArray(inv.lines);

    // 2) Subtotal from whichever array has data (prefer lineItems)
    const items =
      (Array.isArray(inv.lineItems) && inv.lineItems.length
        ? inv.lineItems
        : inv.lines) || [];

    const subtotal = items.reduce((sum, li) => {
      const v =
        typeof li.amount === 'number'
          ? li.amount
          : Number(li.unitPrice || 0) * Number(li.qty || 0);
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);

    inv.subtotal = +subtotal.toFixed(2);

    const tax = Number(inv.tax || 0);
    const discount = Number(inv.discountTotal || 0);
    inv.total = +(inv.subtotal + tax - discount).toFixed(2);

    const paid = Number(inv.amountPaid || 0);
    inv.balanceDue = +(inv.total - paid).toFixed(2);

    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model('Invoice', InvoiceSchema);
