const mongoose = require("mongoose");
const { Schema } = mongoose;

const VendorLeadSchema = new Schema(
    {
        name: { type: String, trim: true, maxlength: 160 },
        contact: { type: String, trim: true, maxlength: 220 },
        zip: { type: String, trim: true, maxlength: 10, index: true },
        role: { type: String, trim: true, maxlength: 120, index: true },
        roleLabel: { type: String, trim: true, maxlength: 160 },
        availability: { type: String, trim: true, maxlength: 120 },
        hasTools: { type: String, trim: true, maxlength: 40 },
        note: { type: String, trim: true, maxlength: 1200 },
        status: { type: String, enum: ["new", "reviewed", "contacted", "rejected"], default: "new", index: true },
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

        path: { type: String, trim: true, maxlength: 300 },
        visitorId: { type: String, trim: true, maxlength: 120, index: true },
        sessionId: { type: String, trim: true, maxlength: 120, index: true },
        source: { type: String, trim: true, maxlength: 80, default: "careers", index: true },
        meta: { type: Schema.Types.Mixed, default: {} },
    },
    { timestamps: true, versionKey: false }
);

VendorLeadSchema.index({ createdAt: -1 });
VendorLeadSchema.index({ zip: 1, role: 1, createdAt: -1 });
VendorLeadSchema.index({ contact: 1, createdAt: -1 });
VendorLeadSchema.index({ reviewStatus: 1, createdAt: -1 });

module.exports = mongoose.models.VendorLead || mongoose.model("VendorLead", VendorLeadSchema);