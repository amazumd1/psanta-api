const express = require('express');
const router = express.Router();
const Job = require('../models/Job');
const { getCleaners } = require('../../services/cleaners');
const Task = require('../models/Task');
const Property = require('../models/Property');
const mongoose = require('mongoose');


async function resolvePropertyIdForTask(job) {
  const pid = job?.propertyId;
  const customerId = job?.customerId ? String(job.customerId) : null;

  const qWithCust = (base) => (customerId ? { ...base, customer: customerId } : base);

  // Try by _id if looks like ObjectId
  if (pid && mongoose.isValidObjectId(pid)) {
    const byMongo = await Property.findOne(qWithCust({ _id: pid })).lean();
    if (byMongo?._id) return String(byMongo._id);
  }

  // Try by business propertyId (string)
  if (pid) {
    const byBiz = await Property.findOne(qWithCust({ propertyId: String(pid) })).lean();
    if (byBiz?._id) return String(byBiz._id);
  }

  // Fallback by address text if present
  if (job?.property?.address) {
    const byAddr = await Property.findOne(qWithCust({ address: job.property.address })).lean();
    if (byAddr?._id) return String(byAddr._id);
  }

  // Final fallback: return original pid (best-effort)
  return pid ? String(pid) : null;
}


// GET /api/jobs/calendar?from=&to=&propertyId=&statusIn=comma,sep&assigned=unassigned|any|cleanerId
router.get('/calendar', async (req, res, next) => {
  try {
    const { from, to, propertyId, statusIn, assigned } = req.query || {};
    const q = {};

    // time range on `date`
    if (from || to) q.date = {};
    if (from) q.date.$gte = new Date(from + 'T00:00:00.000Z');
    if (to) q.date.$lte = new Date(to + 'T23:59:59.999Z');

    if (propertyId) q.propertyId = propertyId;

    if (statusIn) {
      const arr = String(statusIn).split(',').map(s => s.trim()).filter(Boolean);
      if (arr.length) q.status = { $in: arr };
    }

    if (assigned) {
      if (assigned === 'unassigned') q.assignedContractorId = null;
      else if (assigned !== 'any') q.assignedContractorId = String(assigned);
      // 'any' -> no condition
    }

    const rows = await Job.find(q).sort({ date: 1 }).lean();
    // attach computed endAt for UI convenience
    rows.forEach(r => {
      r.endAt = new Date(new Date(r.date).getTime() + (r.durationMinutes || 120) * 60000);
      if (!r.aiEstimateMinutes) r.aiEstimateMinutes = (r.ai?.minutes || r.durationMinutes || 0);
      if (typeof r.priceUsd !== 'number') r.priceUsd = Number(r.priceUsd || 0);
    });

    res.json({ ok: true, data: rows });
  } catch (e) { next(e); }
});

// PATCH /api/jobs/:id/assign
// Body: { cleanerId, startAt?, durationMinutes? }
// router.patch('/:id/assign', async (req, res, next) => {
//   try {
//     const { id } = req.params;
//     const { cleanerId, startAt, durationMinutes } = req.body || {};
//     if (!cleanerId) return res.status(400).json({ ok: false, error: 'cleanerId required' });

//     const $set = {
//       assignedContractorId: String(cleanerId),
//       status: 'accepted', // or 'confirmed' if ops locks
//     };
//     if (startAt) $set.date = new Date(startAt);
//     if (durationMinutes) $set.durationMinutes = Number(durationMinutes);

//     // TODO: optional conflict check here

//     const doc = await Job.findByIdAndUpdate(id, { $set }, { new: true });
//     if (!doc) return res.status(404).json({ ok: false, error: 'not found' });

//     res.json({ ok: true, data: doc });
//   } catch (e) { next(e); }
// });

// PATCH /api/jobs/:id/assign
router.patch('/:id/assign', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { cleanerId, startAt, durationMinutes } = req.body || {};
    if (!cleanerId) return res.status(400).json({ ok: false, error: 'cleanerId required' });

    const $set = {
      assignedContractorId: String(cleanerId),
      status: 'accepted',
    };
    if (startAt) $set.date = new Date(startAt);
    if (durationMinutes) $set.durationMinutes = Number(durationMinutes);

    // 1) Update job
    const job = await Job.findByIdAndUpdate(id, { $set }, { new: true }).lean();
    if (!job) return res.status(404).json({ ok: false, error: 'not found' });

    // 2) Resolve Property Mongo _id to keep customer filter working
    const propIdForTask = await resolvePropertyIdForTask(job);
    const scheduled = job.date ? new Date(job.date) : new Date();

    // 3) Upsert Task linked by jobId (also fix older tasks' propertyId)
    await Task.findOneAndUpdate(
      { jobId: String(job._id) },
      {
        $setOnInsert: {
          jobId: String(job._id),
          isActive: true,
          requirements: [],
        },
        $set: {
          propertyId: propIdForTask || String(job.propertyId || ''),
          assignedTo: String(cleanerId),
          scheduledTime: scheduled,
          specialRequirement: 'Auto-created from Job assignment',
        },
      },
      { new: true, upsert: true }
    );

    res.json({ ok: true, data: job });
  } catch (e) { next(e); }
});



// PATCH /api/jobs/:id/unassign
// router.patch('/:id/unassign', async (req, res, next) => {
//   try {
//     const { id } = req.params;
//     const doc = await Job.findByIdAndUpdate(
//       id,
//       { $set: { assignedContractorId: null, status: 'pending' } },
//       { new: true }
//     );
//     if (!doc) return res.status(404).json({ ok: false, error: 'not found' });
//     res.json({ ok: true, data: doc });
//   } catch (e) { next(e); }
// });

router.patch('/:id/unassign', async (req, res, next) => {
  try {
    const { id } = req.params;

    const doc = await Job.findByIdAndUpdate(
      id,
      { $set: { assignedContractorId: null, status: 'pending' } },
      { new: true }
    ).lean();
    if (!doc) return res.status(404).json({ ok: false, error: 'not found' });

    // Clear assignment + ensure propertyId normalized too
    const propIdForTask = await resolvePropertyIdForTask(doc);
    await Task.findOneAndUpdate(
      { jobId: String(id) },
      { $set: { assignedTo: null, ...(propIdForTask ? { propertyId: propIdForTask } : {}) } },
      { new: true }
    );

    res.json({ ok: true, data: doc });
  } catch (e) { next(e); }
});



// POST /api/jobs/:id/suggest-cleaners  (simple scorer; improve later)
router.post('/:id/suggest-cleaners', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { top = 5 } = req.body || {};
    const job = await Job.findById(id).lean();
    if (!job) return res.status(404).json({ ok: false, error: 'job not found' });

    const cleaners = await getCleaners();

    // basic score: zip/state match + random small jitter
    const out = cleaners.map(c => {
      let score = 0, reasons = [];
      if (job.property?.state && c?.serviceAreas?.states?.includes(job.property.state)) {
        score += 40; reasons.push('state match');
      }
      if (job.property?.zip && c?.serviceAreas?.zips?.includes(job.property.zip)) {
        score += 50; reasons.push('zip match');
      }
      if ((c.capacity?.perDay || 3) >= 3) { score += 5; reasons.push('capacity ok'); }
      score += Math.random() * 5;
      return { cleaner: c, score: Math.round(score), reasons };
    })
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(top));

    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});

// Cleaners list (ops UI needs)
router.get('/cleaners/list', async (req, res, next) => {
  try {
    const rows = await getCleaners();
    res.json({ ok: true, data: rows });
  } catch (e) { next(e); }
});




const {
  startAutopilot, stopAutopilot, skipCurrent, listOffers, ensureProgress
} = require('../services/autopilot.service');

// Start
router.post('/:id/autopilot/start', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { expireMinutes, maxCandidates } = req.body || {};
    const out = await startAutopilot(id, { expireMinutes, maxCandidates });
    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});

// Stop
router.post('/:id/autopilot/stop', async (req, res, next) => {
  try {
    const { id } = req.params;
    const out = await stopAutopilot(id);
    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});

// Skip to next cleaner
router.post('/:id/autopilot/skip', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { expireMinutes, maxCandidates } = req.body || {};
    const out = await skipCurrent(id, { expireMinutes, maxCandidates });
    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});

// Offers timeline (also auto-progress expiries)
router.get('/:id/offers', async (req, res, next) => {
  try {
    const { id } = req.params;
    await ensureProgress(id);
    const rows = await listOffers(id);
    res.json({ ok: true, data: rows });
  } catch (e) { next(e); }
});

router.get('/jobs/:id/offers', async (req, res) => {
  try {
    const jobId = String(req.params.id);
    const rows = await require('../services/autopilot.service').listOffers(jobId);

    // Defensive mapping: null-safe dates/fields
    const data = rows.map(o => ({
      _id: String(o._id),
      jobId: String(o.jobId || jobId),
      cleanerId: o.cleanerId ? String(o.cleanerId) : null,
      status: o.status || 'offered',
      attemptNo: o.attemptNo || 1,
      sentAt: o.sentAt || null,
      expiresAt: o.expiresAt || null,
      secondsLeft: o.expiresAt ? Math.max(0, Math.floor((new Date(o.expiresAt) - Date.now()) / 1000)) : 0,
      smsSid: o.smsSid || null,
      smsError: o.smsError || null,
    }));

    return res.json({ ok: true, data });
  } catch (err) {
    console.error('GET /jobs/:id/offers failed:', err);
    // Debugging ke liye thode time ke liye 200 me error payload bhejo (UI tootega nahi):
    return res.status(200).json({ ok: false, error: err.message });
    // Prod me: res.status(500).json({ ok:false, error:'INTERNAL' })
  }
});



module.exports = router;
