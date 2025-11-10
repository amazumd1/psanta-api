const Job = require('../models/Job');
const User = require('../models/User');

async function matchAndOffer(job) {
  // naive ZIP/state matching
  const zip = job?.property?.zip;
  const state = job?.property?.state;

  let contractors = await User.find({ role: 'contractor', isActive: true }).lean();
  const tried = new Set((job.candidates || []).map(c => String(c.contractorId)));

  // rank: same zip -> same prefix -> same state -> rest
  const sameZip      = contractors.filter(c => c.location?.zip === zip);
  const samePrefix   = contractors.filter(c => c.location?.zip?.slice(0,3) === String(zip||'').slice(0,3) && c.location?.zip !== zip);
  const sameState    = contractors.filter(c => c.location?.state === state && !sameZip.includes(c) && !samePrefix.includes(c));
  const others       = contractors.filter(c => !sameZip.includes(c) && !samePrefix.includes(c) && !sameState.includes(c));

  const ranked = [...sameZip, ...samePrefix, ...sameState, ...others];

  const pick = ranked.find(c => !tried.has(String(c._id)));
  if (!pick) {
    await Job.findByIdAndUpdate(job._id, { $set: { status: 'expired' } });
    return;
  }

  const expiresAt = new Date(Date.now() + 45 * 60 * 1000);
  await Job.findByIdAndUpdate(job._id, {
    $set: { status: 'offered', offer: { contractorId: pick._id, status: 'sent', expiresAt } },
    $push: { candidates: { contractorId: pick._id, result: 'sent' } }
  });
  // TODO: send email/SMS/in-app
}

async function acceptOffer(jobId, contractorId) {
  const job = await Job.findById(jobId);
  if (!job || String(job.offer?.contractorId) !== String(contractorId)) {
    throw new Error('No active offer for this contractor');
  }
  await Job.findByIdAndUpdate(jobId, {
    $set: {
      status: 'confirmed',
      assignedContractorId: contractorId,
      offer: { ...job.offer?.toObject?.() || job.offer, status: 'accepted' }
    },
    $push: { candidates: { contractorId, result: 'accepted' } }
  });
}

async function declineOffer(jobId, contractorId) {
  const job = await Job.findById(jobId);
  if (!job || String(job.offer?.contractorId) !== String(contractorId)) return;
  await Job.findByIdAndUpdate(jobId, {
    $set: { offer: { ...job.offer, status: 'declined' } },
    $push: { candidates: { contractorId, result: 'declined' } }
  });
  const fresh = await Job.findById(jobId).lean();
  await matchAndOffer(fresh); // try next
}

module.exports = { matchAndOffer, acceptOffer, declineOffer };
