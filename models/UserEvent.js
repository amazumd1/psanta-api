const mongoose = require("mongoose");
const { Schema } = mongoose;

const UserEventSchema = new Schema(
  {
    eventName: { type: String, trim: true, maxlength: 120, index: true },
    eventType: { type: String, trim: true, maxlength: 60, default: "custom_event", index: true },

    flow: { type: String, trim: true, maxlength: 80, index: true },
    step: { type: String, trim: true, maxlength: 120, index: true },
    intent: { type: String, trim: true, maxlength: 120, index: true },
    serviceType: { type: String, trim: true, maxlength: 120, index: true },

    page: { type: String, trim: true, maxlength: 120, index: true },
    path: { type: String, trim: true, maxlength: 300, index: true },
    source: { type: String, trim: true, maxlength: 80, default: "frontPage", index: true },

    productId: { type: String, trim: true, maxlength: 140, index: true },
    productTitle: { type: String, trim: true, maxlength: 220 },
    productCategory: { type: String, trim: true, maxlength: 120, index: true },
    productStatus: { type: String, trim: true, maxlength: 80, index: true },

    lookId: { type: String, trim: true, maxlength: 140, index: true },
    lookTitle: { type: String, trim: true, maxlength: 220 },
    projectId: { type: String, trim: true, maxlength: 140, index: true },
    projectTitle: { type: String, trim: true, maxlength: 220 },

    zip: { type: String, trim: true, maxlength: 10, index: true },
    role: { type: String, trim: true, maxlength: 120, index: true },
    category: { type: String, trim: true, maxlength: 120, index: true },

    visitorId: { type: String, trim: true, maxlength: 120, index: true },
    sessionId: { type: String, trim: true, maxlength: 120, index: true },
    userAgent: { type: String, trim: true, maxlength: 260 },
    referrer: { type: String, trim: true, maxlength: 400 },

    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, versionKey: false }
);

UserEventSchema.index({ createdAt: -1 });
UserEventSchema.index({ flow: 1, eventName: 1, createdAt: -1 });
UserEventSchema.index({ productId: 1, createdAt: -1 });
UserEventSchema.index({ lookId: 1, createdAt: -1 });
UserEventSchema.index({ zip: 1, createdAt: -1 });
UserEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });

module.exports = mongoose.models.UserEvent || mongoose.model("UserEvent", UserEventSchema);