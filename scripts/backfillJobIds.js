const path = require('path');
const fs = require('fs');

// Load dotenv from best-guess locations so MONGO_URI mil jaaye
const dotenv = require('dotenv');
const tryPaths = [
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '..', '..', '.env'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/api/.env'),
  path.resolve(process.cwd(), 'config.env'),
];
for (const p of tryPaths) {
  if (fs.existsSync(p)) { dotenv.config({ path: p }); break; }
}

const mongoose = require('mongoose');
const Job = require('../src/models/Job');
const Counter = require('../src/models/Counter');

(async () => {
  try {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) {
      console.error('❌ MONGO_URI not set. Add it to services/api/.env (or pass via env).');
      process.exit(1);
    }

    console.log('ℹ️ Connecting to:', uri.replace(/\/\/.*@/, '//<redacted>@'));
    await mongoose.connect(uri);

    // Counter ko current max se align karo, taaki 200 se ya existing max+1 se chale
    const maxDoc = await Job.findOne({ jobId: { $ne: null } })
      .sort({ jobId: -1 })
      .select('jobId')
      .lean();

    const maxJobId = maxDoc?.jobId ?? 199;
    const c = await Counter.findOneAndUpdate(
      { key: 'jobId' },
      { $setOnInsert: { seq: maxJobId } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    // Agar counter.seq < max, to bump up
    if (c.seq < maxJobId) {
      await Counter.updateOne({ key: 'jobId' }, { $set: { seq: maxJobId } });
      console.log(`🔧 Counter bumped to ${maxJobId}`);
    } else {
      console.log(`ℹ️ Counter at ${c.seq}`);
    }

    // Missing jobId backfill
    const cursor = Job.find({ $or: [{ jobId: { $exists: false } }, { jobId: null }] }).cursor();
    let n = 0;
    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
      doc.jobId = await Counter.next('jobId');
      await doc.save();
      n++;
      if (n % 100 === 0) console.log(`…backfilled ${n}`);
    }

    console.log(`✅ Backfilled jobs: ${n}`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error('❌ Backfill failed:', e);
    process.exit(1);
  }
})();
