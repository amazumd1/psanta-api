const mongoose = require("mongoose");
const { Schema } = mongoose;

const SearchbaseRecommendationSchema = new Schema(
    {
        range: { type: String, trim: true, maxlength: 40, default: "30d", index: true },
        source: { type: String, trim: true, maxlength: 80, default: "searchbase", index: true },
        generatedBy: { type: String, trim: true, maxlength: 80, default: "heuristic", index: true },
        status: { type: String, enum: ["ok", "fallback", "error"], default: "ok", index: true },
        headline: { type: String, trim: true, maxlength: 240 },
        summary: { type: String, trim: true, maxlength: 1400 },
        confidence: { type: Number, default: 0 },
        recommendations: { type: [Schema.Types.Mixed], default: [] },
        snapshot: { type: Schema.Types.Mixed, default: {} },
        llmPrompt: { type: String, trim: true, maxlength: 12000 },
        llmRaw: { type: String, trim: true, maxlength: 12000 },
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

SearchbaseRecommendationSchema.index({ createdAt: -1 });
SearchbaseRecommendationSchema.index({ range: 1, createdAt: -1 });
SearchbaseRecommendationSchema.index({ generatedBy: 1, createdAt: -1 });
SearchbaseRecommendationSchema.index({ reviewStatus: 1, createdAt: -1 });

module.exports =
    mongoose.models.SearchbaseRecommendation ||
    mongoose.model("SearchbaseRecommendation", SearchbaseRecommendationSchema);