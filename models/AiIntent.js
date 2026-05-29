const mongoose = require("mongoose");
const { Schema } = mongoose;

const AiIntentSchema = new Schema(
    {
        contextType: { type: String, trim: true, maxlength: 80, index: true },
        intent: { type: String, trim: true, maxlength: 140, index: true },
        userMessage: { type: String, trim: true, maxlength: 2000 },
        page: { type: String, trim: true, maxlength: 120, index: true },
        path: { type: String, trim: true, maxlength: 300 },

        productId: { type: String, trim: true, maxlength: 140, index: true },
        productTitle: { type: String, trim: true, maxlength: 220 },
        lookId: { type: String, trim: true, maxlength: 140, index: true },
        lookTitle: { type: String, trim: true, maxlength: 220 },
        projectId: { type: String, trim: true, maxlength: 140, index: true },
        projectTitle: { type: String, trim: true, maxlength: 220 },
        zip: { type: String, trim: true, maxlength: 10, index: true },
        category: { type: String, trim: true, maxlength: 120 },

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

AiIntentSchema.index({ createdAt: -1 });
AiIntentSchema.index({ contextType: 1, intent: 1, createdAt: -1 });
AiIntentSchema.index({ productId: 1, createdAt: -1 });
AiIntentSchema.index({ lookId: 1, createdAt: -1 });
AiIntentSchema.index({ zip: 1, createdAt: -1 });
AiIntentSchema.index({ reviewStatus: 1, createdAt: -1 });

module.exports = mongoose.models.AiIntent || mongoose.model("AiIntent", AiIntentSchema);