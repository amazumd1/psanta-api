const mongoose = require("mongoose");

const User1099TransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // compatibility / easy debugging
    ownerAuthId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    ownerEmail: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
    },
    ownerName: {
      type: String,
      default: null,
      trim: true,
    },

    txnDate: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    date: {
      type: String,
      default: null,
      trim: true,
    },

    amount: {
      type: Number,
      required: true,
    },
    merchant: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: null,
      trim: true,
    },
    referenceId: {
      type: String,
      default: null,
      trim: true,
    },
    paymentMethod: {
      type: String,
      default: null,
      trim: true,
    },
    sourceEmail: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
    },

    source: {
      type: String,
      default: "payment-screenshot",
      trim: true,
    },
    sourceApp: {
      type: String,
      default: "ops-app",
      trim: true,
    },

    proofUrl: {
      type: String,
      default: null,
      trim: true,
    },
    ocrText: {
      type: String,
      default: null,
    },

    status: {
      type: String,
      enum: ["VERIFIED", "UNVERIFIED", "FLAGGED"],
      default: "UNVERIFIED",
      index: true,
    },

    matchedLineId: {
      type: String,
      default: null,
      trim: true,
    },
    headerId: {
      type: String,
      default: null,
      trim: true,
    },
  },
  { timestamps: true }
);

User1099TransactionSchema.index({ userId: 1, txnDate: -1, createdAt: -1 });

module.exports =
  mongoose.models.User1099Transaction ||
  mongoose.model("User1099Transaction", User1099TransactionSchema);