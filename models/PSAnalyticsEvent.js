const mongoose = require("mongoose");
const { Schema } = mongoose;

const PSAnalyticsEventSchema = new Schema(
  {
    eventType: {
      type: String,
      enum: ["page_view", "custom_event"],
      default: "page_view",
      index: true,
    },
    eventName: { type: String, trim: true, maxlength: 90, index: true },

    path: { type: String, trim: true, maxlength: 260, index: true },
    route: { type: String, trim: true, maxlength: 220, index: true },
    title: { type: String, trim: true, maxlength: 180 },
    host: { type: String, trim: true, maxlength: 120, index: true },

    referrer: { type: String, trim: true, maxlength: 400 },
    refHost: { type: String, trim: true, maxlength: 140, index: true },
    utmSource: { type: String, trim: true, maxlength: 90, index: true },
    utmMedium: { type: String, trim: true, maxlength: 90, index: true },
    utmCampaign: { type: String, trim: true, maxlength: 120, index: true },
    utmTerm: { type: String, trim: true, maxlength: 120 },
    utmContent: { type: String, trim: true, maxlength: 120 },

    sessionId: { type: String, trim: true, maxlength: 90, index: true },
    visitorIdHash: { type: String, trim: true, maxlength: 96, index: true },
    ipHash: { type: String, trim: true, maxlength: 96, index: true },

    country: { type: String, trim: true, maxlength: 80, index: true },
    countryCode: { type: String, trim: true, maxlength: 8, index: true },
    region: { type: String, trim: true, maxlength: 80 },
    city: { type: String, trim: true, maxlength: 90 },

    device: { type: String, trim: true, maxlength: 40, index: true },
    browser: { type: String, trim: true, maxlength: 60, index: true },
    os: { type: String, trim: true, maxlength: 60, index: true },
    ua: { type: String, trim: true, maxlength: 260 },
    screen: { type: String, trim: true, maxlength: 40 },
    timezone: { type: String, trim: true, maxlength: 80 },
    // Business analytics dimensions
    zip: { type: String, trim: true, maxlength: 10, index: true },
    serviceCity: { type: String, trim: true, maxlength: 90, index: true },
    serviceState: { type: String, trim: true, maxlength: 40, index: true },

    flow: { type: String, trim: true, maxlength: 80, index: true }, // chatbot, host_onboarding, market_rates, listing_matches
    step: { type: String, trim: true, maxlength: 120, index: true },
    stage: { type: String, trim: true, maxlength: 120, index: true },
    intent: { type: String, trim: true, maxlength: 80, index: true },
    serviceType: { type: String, trim: true, maxlength: 120, index: true },

    propertyType: { type: String, trim: true, maxlength: 80 },
    bedrooms: { type: Number },
    bathrooms: { type: Number },
    quoteAmount: { type: Number },
    confidence: { type: Number },

    requestId: { type: String, trim: true, maxlength: 120, index: true },
    quoteId: { type: String, trim: true, maxlength: 120, index: true },

    source: { type: String, trim: true, maxlength: 60, default: "frontPage", index: true },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

PSAnalyticsEventSchema.index({ createdAt: -1 });
PSAnalyticsEventSchema.index({ eventType: 1, createdAt: -1 });
PSAnalyticsEventSchema.index({ path: 1, createdAt: -1 });
PSAnalyticsEventSchema.index({ refHost: 1, createdAt: -1 });
PSAnalyticsEventSchema.index({ countryCode: 1, createdAt: -1 });


PSAnalyticsEventSchema.index({ zip: 1, createdAt: -1 });
PSAnalyticsEventSchema.index({ serviceType: 1, zip: 1, createdAt: -1 });
PSAnalyticsEventSchema.index({ flow: 1, step: 1, createdAt: -1 });
PSAnalyticsEventSchema.index({ eventName: 1, zip: 1, createdAt: -1 });
PSAnalyticsEventSchema.index({ zip: 1, flow: 1, createdAt: -1 });

PSAnalyticsEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });

module.exports =
  mongoose.models.PSAnalyticsEvent ||
  mongoose.model("PSAnalyticsEvent", PSAnalyticsEventSchema);