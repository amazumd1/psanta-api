const mongoose = require("mongoose");
const { Schema } = mongoose;

const CuratedInterestRequestSchema = new Schema(
  {
    action: { type: String, trim: true, maxlength: 80, default: "curated_request", index: true },
    lookId: { type: String, trim: true, maxlength: 140, index: true },
    lookTitle: { type: String, trim: true, maxlength: 220 },
    projectId: { type: String, trim: true, maxlength: 140, index: true },
    projectTitle: { type: String, trim: true, maxlength: 220 },
    intent: { type: String, trim: true, maxlength: 120, index: true },
    productIds: [{ type: String, trim: true, maxlength: 140 }],
    productCount: { type: Number, default: 0 },

    zip: { type: String, trim: true, maxlength: 10, index: true },
    path: { type: String, trim: true, maxlength: 300 },
    visitorId: { type: String, trim: true, maxlength: 120, index: true },
    sessionId: { type: String, trim: true, maxlength: 120, index: true },
    source: { type: String, trim: true, maxlength: 80, default: "frontPage", index: true },
    reviewStatus: {
  type: String,
  enum: ["new", "reviewed", "approved", "task_created", "pricing_needed", "contacted", "ignored"],
  default: "new",
  index: true,
},
adminAction: { type: String, trim: true, maxlength: 120, default: "" },
adminNote: { type: String, trim: true, maxlength: 1200, default: "" },
reviewedAt: { type: Date, default: null, index: true },
reviewedBy: { type: String, trim: true, maxlength: 160, default: "" },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, versionKey: false }
);

CuratedInterestRequestSchema.index({ createdAt: -1 });
CuratedInterestRequestSchema.index({ lookId: 1, createdAt: -1 });
CuratedInterestRequestSchema.index({ projectId: 1, createdAt: -1 });
CuratedInterestRequestSchema.index({ zip: 1, createdAt: -1 });
CuratedInterestRequestSchema.index({ reviewStatus: 1, createdAt: -1 });

module.exports =
  mongoose.models.CuratedInterestRequest ||
  mongoose.model("CuratedInterestRequest", CuratedInterestRequestSchema);