const mongoose = require("mongoose");
const { Schema } = mongoose;

const ProductInterestSchema = new Schema(
    {
        action: { type: String, trim: true, maxlength: 80, default: "request_availability", index: true },
        productId: { type: String, trim: true, maxlength: 140, required: true, index: true },
        productTitle: { type: String, trim: true, maxlength: 220 },
        category: { type: String, trim: true, maxlength: 120, index: true },
        productStatus: { type: String, trim: true, maxlength: 80, index: true },
        price: { type: Number, default: null },
        minimumPurchase: { type: Number, default: 50 },

        sourceLookId: { type: String, trim: true, maxlength: 140, index: true },
        sourceLookTitle: { type: String, trim: true, maxlength: 220 },
        activeLookId: { type: String, trim: true, maxlength: 140, index: true },
        activeLookTitle: { type: String, trim: true, maxlength: 220 },

        path: { type: String, trim: true, maxlength: 300 },
        visitorId: { type: String, trim: true, maxlength: 120, index: true },
        sessionId: { type: String, trim: true, maxlength: 120, index: true },
        zip: { type: String, trim: true, maxlength: 10, index: true },
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

ProductInterestSchema.index({ createdAt: -1 });
ProductInterestSchema.index({ productId: 1, createdAt: -1 });
ProductInterestSchema.index({ sourceLookId: 1, createdAt: -1 });
ProductInterestSchema.index({ activeLookId: 1, createdAt: -1 });
ProductInterestSchema.index({ reviewStatus: 1, createdAt: -1 });

module.exports = mongoose.models.ProductInterest || mongoose.model("ProductInterest", ProductInterestSchema);