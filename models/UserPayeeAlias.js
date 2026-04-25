const mongoose = require("mongoose");

const UserPayeeAliasSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    ownerAuthId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    merchantKey: {
      type: String,
      required: true,
      trim: true,
    },
    merchant: {
      type: String,
      required: true,
      trim: true,
    },
    sourceEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
  },
  { timestamps: true }
);

UserPayeeAliasSchema.index({ userId: 1, merchantKey: 1 }, { unique: true });

module.exports =
  mongoose.models.UserPayeeAlias ||
  mongoose.model("UserPayeeAlias", UserPayeeAliasSchema);