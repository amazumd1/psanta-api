const mongoose = require("mongoose");
const { Schema } = mongoose;

const PSDemandEventSchema = new Schema(
  {
    action: { type: String, required: true, trim: true, maxlength: 64, index: true },
    tab: { type: String, trim: true, maxlength: 32 },
    zip: { type: String, trim: true, maxlength: 10, index: true },
    zip3: { type: String, trim: true, maxlength: 3, index: true },

    // "what user typed" (truncate)
    query: { type: String, trim: true, maxlength: 300 },

    // where it came from (frontPage/admin/ops/etc)
    source: { type: String, trim: true, maxlength: 64, default: "frontPage", index: true },

    // optional (only when you already have auth in that endpoint)
    userId: { type: String, trim: true, maxlength: 64, index: true },

    // privacy: store hashed ip, not raw
    ipHash: { type: String, trim: true, maxlength: 128, index: true },
    ua: { type: String, trim: true, maxlength: 220 },
    ref: { type: String, trim: true, maxlength: 400 },
    refHost: { type: String, index: true },

    // small object (truncate if too big in route)
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

// TTL (auto-delete after 180 days)
PSDemandEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

// useful analytics indexes
PSDemandEventSchema.index({ zip3: 1, createdAt: -1 });
PSDemandEventSchema.index({ action: 1, createdAt: -1 });
PSDemandEventSchema.index({ userId: 1, createdAt: -1 });

// TTL cleanup: keep 365 days
PSDemandEventSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 365 }
);


module.exports = mongoose.model("PSDemandEvent", PSDemandEventSchema);
