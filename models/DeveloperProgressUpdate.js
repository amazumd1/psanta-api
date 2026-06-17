const mongoose = require("mongoose");

const LinkSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, default: "Open link" },
    url: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const AttachmentSchema = new mongoose.Schema(
  {
    type: { type: String, trim: true, default: "file" },
    title: { type: String, trim: true, default: "Attachment" },
    url: { type: String, trim: true, default: "" },
    publicId: { type: String, trim: true, default: "" },
    provider: { type: String, trim: true, default: "" },
    mimeType: { type: String, trim: true, default: "" },
    sizeBytes: { type: Number, default: 0 },
    originalName: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const DeveloperProgressUpdateSchema = new mongoose.Schema(
  {
    updateId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },

    date: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 240,
    },

    phase: {
      type: String,
      trim: true,
      default: "Daily Build",
      maxlength: 120,
    },

    category: {
      type: String,
      trim: true,
      default: "Development",
      maxlength: 120,
    },

    status: {
      type: String,
      trim: true,
      default: "In Progress",
      maxlength: 80,
    },

    summary: {
      type: String,
      trim: true,
      default: "",
      maxlength: 12000,
    },

    businessValue: {
      type: String,
      trim: true,
      default: "",
      maxlength: 12000,
    },

    technicalDetails: {
      type: [String],
      default: [],
    },

    links: {
      type: [LinkSchema],
      default: [],
    },

    attachments: {
      type: [AttachmentSchema],
      default: [],
    },

    createdBy: {
      type: String,
      trim: true,
      default: "developer-progress-page",
    },
  },
  {
    timestamps: true,
    collection: "developer_progress_updates",
  }
);

DeveloperProgressUpdateSchema.index({ date: -1, createdAt: -1 });
DeveloperProgressUpdateSchema.index({ category: 1, status: 1 });

DeveloperProgressUpdateSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret) {
    ret.id = ret.updateId || String(ret._id);
    delete ret._id;
    delete ret.updateId;
    return ret;
  },
});

module.exports =
  mongoose.models.DeveloperProgressUpdate ||
  mongoose.model("DeveloperProgressUpdate", DeveloperProgressUpdateSchema);