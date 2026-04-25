const mongoose = require("mongoose");

const PCPersonaSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, required: true },

    kind: {
      type: String,
      enum: ["landlord", "renter", "pro"],
      required: true,
      index: true,
    },

    zip: { type: String, trim: true, index: true },
    address: { type: String, trim: true },

    // Pro-only
    skills: [{ type: String, trim: true }],
    matchCount: { type: Number, default: 0 },
    verified: { type: Boolean, default: false },

    minRate: { type: Number, default: 0 },
    rateUnit: { type: String, enum: ["hr", "job"], default: "hr" },
    conditions: { type: String, default: "" },
    focusTags: [{ type: String }],


    // Optional: public profile proof (opt-in; imported from public links)
    evidenceLinks: [{ type: String, trim: true }],
    showExternalRating: { type: Boolean, default: false },
    externalRating: { type: Number, default: 0 },
    externalReviewCount: { type: Number, default: 0 },

    // Future: your platform-derived metrics (not scraped)
    jobsCount: { type: Number, default: 0 },
    usdSpent: { type: Number, default: 0 },

    // Owner-match visibility boost (profile-level)
    matchBoostEnabled: { type: Boolean, default: false, index: true },
    matchBoostFreeOpen: { type: Boolean, default: false },
    matchBoostTier: { type: String, enum: ["", "priority"], default: "" },
    matchBoostLabel: { type: String, default: "" },
    matchBoostColor: { type: String, enum: ["", "amber", "emerald"], default: "" },
    matchBoostUpdatedAt: { type: Date, default: null, index: true },

    isActive: { type: Boolean, default: true, index: true },
    activeUntil: { type: Date, default: null, index: true },
    consentUntil: { type: Date, default: null }, // “show me jobs for 90 days”

    // Pro dashboard state (persisted server-side)
    dashboardState: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true, versionKey: false }
);

// Unique per user + kind
PCPersonaSchema.index({ userId: 1, kind: 1 }, { unique: true });
PCPersonaSchema.index({
  kind: 1,
  isActive: 1,
  zip: 1,
  matchBoostEnabled: -1,
  matchBoostUpdatedAt: -1,
  updatedAt: -1,
});

module.exports = mongoose.models.PCPersona || mongoose.model("PCPersona", PCPersonaSchema);
