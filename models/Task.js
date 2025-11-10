// services/api/models/Task.js
const { Schema, model, models } = require('mongoose');

/* Subdocs */
const PhotoSchema = new Schema({
  url: { type: String, required: true },
  type: { type: String, enum: ['before','during','after'], required: true },
  uploadedAt: { type: Date, default: Date.now },
  isUploaded: { type: Boolean, default: true },
  localPath: String,
  tags: [String],
  notes: String,
}, { _id: true });

const IssueSchema = new Schema({
  type: { type: String, required: true },
  description: { type: String, required: true },
  photoId: { type: Schema.Types.ObjectId, ref: 'Photo' },
  location: String,
  notes: String,
  isResolved: { type: Boolean, default: false },
  resolvedAt: Date
}, { timestamps: true });

const AiFeedbackSchema = new Schema({
  photoId: { type: Schema.Types.ObjectId, ref: 'Photo' },
  issueId: { type: Schema.Types.ObjectId, ref: 'Issue' },
  feedback: { type: String, required: true },
  improvements: [String],
  confidence: { type: Number, min: 0, max: 1, required: true },
  suggestions: [String],
}, { timestamps: true });

const RequirementSchema = new Schema({
  roomType: { type: String, required: true },
  tasks: [{ description: { type: String, required: true } }],
  isCompleted: { type: Boolean, default: false }
}, { _id: true });

/* Main Task */
const TaskSchema = new Schema({
  propertyId: { type: String, required: true },
  jobId: { type: String },
  requirements: [RequirementSchema],
  specialRequirement: String,
  scheduledTime: Date,
  assignedTo: String,
  photos: [PhotoSchema],
  issues: [IssueSchema],
  status: { type: String, enum: ['pending','in-progress','completed'], default: 'pending', index: true },
  aiFeedback: [AiFeedbackSchema],
  chatHistory: [{
    message: { type: String, required: true },
    sender: { type: String, enum: ['user','system'], required: true },
    timestamp: { type: Date, default: Date.now },
    type: { type: String, enum: ['text','photo','command','system','scoring','workflow','manual'], default: 'text' },
    isCommand: { type: Boolean, default: false },
    commandType: { type: String, enum: ['start','photo','task','complete','note'], default: undefined },
    data: { type: Schema.Types.Mixed, default: undefined },
    imageUrl: { type: String, default: undefined },
    imageType: { type: String, enum: ['before','after','during'], default: undefined },
    roomType: { type: String, default: undefined },
  }],
  isActive: { type: Boolean, default: true },
}, { timestamps: true, versionKey: false });

/* Helpful indexes (valid fields only) */
TaskSchema.index({ propertyId: 1 });
TaskSchema.index({ isActive: 1 });
TaskSchema.index({ createdAt: -1 });

/* GUARD to prevent OverwriteModelError */
module.exports = models.Task || model('Task', TaskSchema);
