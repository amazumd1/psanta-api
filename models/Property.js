// services/api/models/Property.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

/* ---------- Room Tasks ---------- */
const roomTaskSchema = new Schema(
  {
    roomType: { type: String, required: false, trim: true },
    notes: { type: String, default: '' }, // <-- controller.updateRoomTaskNotes() के लिए
    tasks: [
      {
        description: { type: String, required: false, trim: true },
        Regular: { type: String, default: '', trim: true }, // e.g. "weekly"
        isCompleted: { type: Boolean, default: false },     // <-- UI में use होता है
      },
    ],
  },
  { _id: true }
);

/* ---------- Property ---------- */
const propertySchema = new Schema(
  {
    // optional legacy/business id (globally unique if present)
    propertyId: { type: String, unique: true, sparse: true, trim: true },

    // external joins (optional)
    externalRef: { type: String, trim: true },

    // address
    address: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    zip: { type: String, trim: true, default: '' },

    // props
    name: { type: String, trim: true, default: 'My Property' },
    type: { type: String, trim: true, default: 'house' },
    squareFootage: { type: Number, default: 1200 },

    manual: {
      title: { type: String, default: 'Live Cleaning & Maintenance Manual', trim: true },
      content: { type: String, default: '' },
      lastUpdated: { type: Date, default: Date.now },
    },

    roomTasks: [roomTaskSchema],

    customer: { type: Schema.Types.ObjectId, ref: 'User', index: true },

    cycle: { type: String, trim: true, default: 'monthly' }, // e.g. 'weekly' | 'bi-weekly' | 'monthly'
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

/* ---------- Indexes ---------- */
propertySchema.index({ externalRef: 1 });
propertySchema.index({ address: 1, zip: 1 });
propertySchema.index({ isActive: 1 });
propertySchema.index({ customer: 1, createdAt: -1 });

/* ---------- Virtuals / Helpers ---------- */
propertySchema.virtual('fullAddress').get(function () {
  return [this.address, this.city, this.state, this.zip].filter(Boolean).join(', ');
});

/* ---------- JSON shaping ---------- */
propertySchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id?.toString();
    delete ret.__v;
    return ret;
  },
});

/* ---------- Small hygiene before save ---------- */
propertySchema.pre('save', function (next) {
  // Ensure squareFootage is a number
  if (this.squareFootage != null) {
    this.squareFootage = Number(this.squareFootage) || 0;
  }
  next();
});

module.exports = mongoose.model('Property', propertySchema);
