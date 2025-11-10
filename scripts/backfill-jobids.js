#!/usr/bin/env node
/* Backfill sequential jobId for existing Jobs.
 * Usage:
 *   node scripts/backfill-jobids.js --dry-run
 *   node scripts/backfill-jobids.js --startAt=100 --batchSize=1000
 */

const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

// ---- load env from repo root OR services/api/.env ----
const rootEnv = path.join(__dirname, '..', '.env');
const apiEnv  = path.join(__dirname, '..', 'services', 'api', '.env');
try { if (fs.existsSync(rootEnv)) require('dotenv').config({ path: rootEnv }); } catch {}
try { if (fs.existsSync(apiEnv))  require('dotenv').config({ path: apiEnv  }); } catch {}

const MONGODB_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URL ||
  'mongodb://127.0.0.1:27017/ai-property-app';

mongoose.set('strictQuery', false);

// models
const Job = require(path.join(__dirname, '..', 'services', 'api', 'src', 'models', 'Job'));
const Counter = require(path.join(__dirname, '..', 'services', 'api', 'src', 'models', 'Counter'));

// args
const argv = process.argv.slice(2).reduce((acc, tok) => {
  const m = tok.match(/^--([^=]+)(=(.*))?$/);
  if (m) acc[m[1]] = m[3] === undefined ? true : m[3];
  return acc;
}, {});
const DRY        = !!(argv['dry-run'] || argv.dryRun);
const START_AT   = Number(argv.startAt || 100);
const BATCH_SIZE = Number(argv.batchSize || 500);

async function allocateSequenceBlock(key, count, startAt = 100) {
  const doc = await Counter.findOneAndUpdate(
    { key },
    [
      {
        $set: {
          // if seq is null/missing, treat as (startAt-1), then add count
          seq: { $add: [ { $ifNull: [ '$seq', startAt - 1 ] }, count ] }
        }
      }
    ],
    { new: true, upsert: true }
  ).lean();

  const end = doc.seq;
  const start = end - count + 1;
  return Array.from({ length: count }, (_, i) => start + i);
}

(async () => {
  console.log('Connecting to', MONGODB_URI);
  await mongoose.connect(MONGODB_URI);

  // ensure index (unique + sparse)
  try {
    await Job.collection.createIndex({ jobId: 1 }, { unique: true, sparse: true });
  } catch (e) {
    console.warn('Index create warn:', e.message);
  }

  // set counter >= max(jobId) and >= START_AT-1
  const maxDoc = await Job.find({ jobId: { $type: 'number' } })
                          .sort({ jobId: -1 }).limit(1).lean();
  const currentMax = maxDoc?.[0]?.jobId || 0;
  const target = Math.max(currentMax, START_AT - 1);
  await Counter.findOneAndUpdate(
    { key: 'jobId' },
    { $max: { seq: target } },
    { upsert: true, new: true }
  );

  const filter = { $or: [ { jobId: { $exists: false } }, { jobId: null } ] };
  const totalToFix = await Job.countDocuments(filter);
  console.log(`Jobs without jobId: ${totalToFix}, next will start from ${Math.max(currentMax + 1, START_AT)}`);

  if (DRY || totalToFix === 0) {
    await mongoose.disconnect();
    process.exit(0);
  }

  let fixed = 0, batch = [];
  const cursor = Job.find(filter, { _id: 1 }).sort({ createdAt: 1 }).lean().cursor();

  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= BATCH_SIZE) {
      const ids = await allocateSequenceBlock('jobId', batch.length, START_AT);
      const ops = batch.map((b, i) => ({
        updateOne: { filter: { _id: b._id }, update: { $set: { jobId: ids[i] } } }
      }));
      await Job.bulkWrite(ops);
      fixed += batch.length;
      console.log(`Assigned jobId for ${fixed}/${totalToFix}`);
      batch = [];
    }
  }
  if (batch.length) {
    const ids = await allocateSequenceBlock('jobId', batch.length, START_AT);
    const ops = batch.map((b, i) => ({
      updateOne: { filter: { _id: b._id }, update: { $set: { jobId: ids[i] } } }
    }));
    await Job.bulkWrite(ops);
    fixed += batch.length;
    console.log(`Assigned jobId for ${fixed}/${totalToFix}`);
  }

  await mongoose.disconnect();
  console.log('Done ✔');
})().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
