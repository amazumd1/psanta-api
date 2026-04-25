const mongoose = require("mongoose");

const ServiceRequestSchema = new mongoose.Schema(
  {
    // location
    zip: { type: String, required: true, index: true },
    zip3: { type: String, default: "", index: true },
    state: { type: String, default: "" },

    // which UX surface created it
    tab: { type: String, default: "services" },

    // user's natural-language intent
    query: { type: String, required: true },
    serviceType: { type: String, default: "other", index: true },

    // ✅ NEW: allow owners to pause/unpause a post (hidden from public match lists)
// Older docs may not have this field; treat missing as active.
active: { type: Boolean, default: true, index: true },

    // MVP: user intent signal + budget signal
    intent: { type: String, default: "", index: true }, // 'need' | 'offer'
    budgetMax: { type: Number, default: 0 },

    // optional structured inputs
    addressText: { type: String, default: "" },
    beds: { type: Number, default: 0 },
    baths: { type: Number, default: 0 },
    sqft: { type: Number, default: 0 },
    date: { type: String, default: "" },

    // ✅ NEW: contact + arbitrary per-tab structured fields (MVP)
    contactEmail: { type: String, default: "" },
    contactPhone: { type: String, default: "" },
    fields: { type: mongoose.Schema.Types.Mixed, default: null },

    // auth optional
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    userEmail: { type: String, default: "" },

    source: { type: String, default: "frontPage" },
    reason: { type: String, default: "" },

    // Pro interaction (for leads / replies)
    contactedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    lastContactedAt: { type: Date, default: null },
    responses: [
      {
        proId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        message: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now },
      },
    ],

    // dedupe / safety
    ipHash: { type: String, default: "" },
    dedupeKey: { type: String, index: true },
  },
  { timestamps: true }
);

ServiceRequestSchema.index({ createdAt: -1 });
ServiceRequestSchema.index({ zip3: 1, serviceType: 1, createdAt: -1 });
ServiceRequestSchema.index({ zip: 1, serviceType: 1, createdAt: -1 });
ServiceRequestSchema.index({ contactedBy: 1, createdAt: -1 });

module.exports = mongoose.model("ServiceRequest", ServiceRequestSchema);
