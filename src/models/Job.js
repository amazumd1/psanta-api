const mongoose = require('mongoose');
const { Schema } = mongoose;
const Counter = require('./Counter');

const JobSchema = new Schema({
  customerId: { type: String, required: true },
  propertyId: { type: String },
  jobId: { type: Number, index: true, unique: true, sparse: true },
  priceUsd: { type: Number, default: 0 },       // e.g. 129.99
  currency: { type: String, default: 'USD' },
  property: {
    address: String, city: String, state: String, zip: String,
    lat: Number, lng: Number, beds: Number, baths: Number, sqft: Number,
  },
  paymentId: { type: String, index: true },
  date: { type: Date, required: true },
  durationMinutes: { type: Number, default: 120 },
  ai: { minutes: { type: Number, default: 0 }, hourly: { type: Number, default: 0 } },
  aiEstimateMinutes: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['pending','offered','accepted','confirmed','declined','cancelled','canceled','completed'],
    default: 'pending'
  },
  assignedContractorId: { type: String, default: null },
  offer: { status: { type: String, enum: ['sent','accepted','declined','expired'], default: 'sent' }, expiresAt: Date },
  tags: [String],
  source: { type: String, enum: ['payment','capture','manual','import','cleaning_wizard','onboarding'], default: 'payment' },
  notes: [String],
}, { timestamps: true });

JobSchema.index({ date: 1 });
JobSchema.index({ status: 1, date: 1 });
JobSchema.index({ assignedContractorId: 1, date: 1 });
JobSchema.index({ paymentId: 1, date: 1 }, { background: true });

/** Atomic allocator — first ID = 200 (base = 199) */
async function allocNextSeq(incrementBy = 1) {
  const pipeline = [
    { $set: { seq: { $add: [ { $ifNull: ['$seq', 299] }, incrementBy ] } } },
    { $set: { key: 'jobId' } }
  ];

  // 1) Try via Mongoose model (returns document directly)
  try {
    const doc = await Counter.findOneAndUpdate(
      { key: 'jobId' },
      pipeline,
      { upsert: true, new: true, lean: true }
    );
    if (doc && typeof doc.seq === 'number') return doc.seq;
  } catch (_e) {
    // fall through to native; older Mongoose/Server might not accept pipeline here
  }

  // 2) Native collection (return shape can be either doc or { value: doc, ... })
  const res = await Counter.collection.findOneAndUpdate(
    { key: 'jobId' },
    pipeline,
    { upsert: true, returnDocument: 'after' }  // driver v4+: after == updated doc
  );

  const maybeDoc = res && (res.value ?? res); // handle both shapes
  if (maybeDoc && typeof maybeDoc.seq === 'number') return maybeDoc.seq;

  // 3) Super-safe fallback: read it back
  const check = await Counter.collection.findOne({ key: 'jobId' });
  if (check && typeof check.seq === 'number') return check.seq;

  throw new Error('Counter update returned no seq');
}

JobSchema.pre('save', async function(next) {
  try {
    if (this.jobId != null) return next();
    const after = await allocNextSeq(1);
    this.jobId = after;
    next();
  } catch (e) { next(e); }
});

JobSchema.pre('insertMany', async function(next, docs) {
  try {
    const need = (docs || []).filter(d => d.jobId == null);
    if (!need.length) return next();
    const last = await allocNextSeq(need.length);
    const first = last - need.length + 1;
    need.forEach((d, i) => { d.jobId = first + i; });
    next();
  } catch (e) { next(e); }
});

module.exports = mongoose.models.Job || mongoose.model('Job', JobSchema);
