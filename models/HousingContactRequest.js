const mongoose = require("mongoose");

// Housing privacy unlock handshake (MVP)
// - requester asks owner to unlock contact
// - owner unlocks for N minutes
// - requester can fetch contact only during active session

const HousingContactRequestSchema = new mongoose.Schema(
  {
    postId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceRequest",
      required: true,
      index: true,
    },
    zip3: { type: String, default: "", index: true },

    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    requesterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    fromEmail: { type: String, default: "" },
    fromName: { type: String, default: "" },
    message: { type: String, default: "" },

    status: {
      type: String,
      enum: ["pending", "unlocked", "expired", "denied"],
      default: "pending",
      index: true,
    },

    unlockedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null, index: true },

    // snapshot at unlock time
    ownerContact: {
      email: { type: String, default: "" },
      phone: { type: String, default: "" },
    },
    addressText: { type: String, default: "" },
  },
  { timestamps: true }
);

HousingContactRequestSchema.index({ ownerId: 1, createdAt: -1 });
HousingContactRequestSchema.index({ requesterId: 1, createdAt: -1 });
HousingContactRequestSchema.index({ postId: 1, requesterId: 1, createdAt: -1 });

module.exports = mongoose.model("HousingContactRequest", HousingContactRequestSchema);


