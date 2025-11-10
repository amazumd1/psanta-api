// services/api/src/services/autopilot.service.js
const crypto = require('crypto');
const admin = require('firebase-admin');
const JobOffer = require('../models/JobOffer');
const Job = require('../models/Job');
const { sendSMS } = require('./sms.service');
const path = require('path');

const {
  OFFERS_SIGNING_SECRET = 'please-change-me',
  API_BASE_URL = 'http://localhost:5000/api',
  OFFER_EXPIRE_MIN = '15',
  OFFER_MAX_CANDIDATES = '10',
} = process.env;


// --- Firestore Admin init (robust) ---
const fs = require('fs');

function initFirestoreOnce() {
  if (admin.apps.length) return;

  const ENV_PATH   = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const LOCAL_PATH = path.resolve(__dirname, '../../serviceAccount.json');

  let saPath = null;
  if (ENV_PATH && fs.existsSync(ENV_PATH)) {
    saPath = ENV_PATH;
  } else if (fs.existsSync(LOCAL_PATH)) {
    saPath = LOCAL_PATH;
    // if an invalid env path was set, kill it so ADC doesn't try it later
    if (ENV_PATH && !fs.existsSync(ENV_PATH)) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  } else {
    if (ENV_PATH) {
      console.warn(`⚠️ GOOGLE_APPLICATION_CREDENTIALS points to missing file: ${ENV_PATH}`);
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }
  }

  let sa = null;
  if (saPath) {
    try { sa = require(saPath); } catch (e) {
      console.warn(`⚠️ Failed to load service account at ${saPath}: ${e.message}`);
    }
  }

  const PROJECT_ID =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    (sa && (sa.project_id || sa.projectId));

  if (sa) {
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: PROJECT_ID || sa.project_id,
    });
    console.log('✅ Firestore: initialized with service account file');
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: PROJECT_ID,
    });
    console.log('✅ Firestore: initialized via ADC');
  }
}

let fdb = null;
function getFdb() {
  if (!fdb) { initFirestoreOnce(); fdb = admin.firestore(); }
  return fdb;
}




initFirestoreOnce();

/* ---------- Helpers ---------- */
function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', OFFERS_SIGNING_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verifyToken(token) {
  const [data, sig] = token.split('.');
  const exp = crypto.createHmac('sha256', OFFERS_SIGNING_SECRET).update(data).digest('base64url');
  if (exp !== sig) return null;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { return null; }
}
const digitsOnly = (s) => String(s || '').replace(/\D/g, '');

/* ---------- THIS mirrors OpsCalendarPage.jsx cleaners ---------- */
async function getCleaners() {
  const col = getFdb().collection('contractBusinesses');

  // Try filtered query first
  let snap = await col.where('status', '==', 'approved').limit(500).get().catch(() => null);
  if (!snap || snap.empty) {
    const all = await col.get();
    const allRows = all.docs.map((d) => ({ id: d.id, ...d.data() }));
    return allRows
      .filter((r) => String(r.status || '').toLowerCase() === 'approved')
      .map(mapBusiness);
  }
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return rows.map(mapBusiness);
}

function mapBusiness(b) {
  const serviceAreas = b.serviceAreas || {};
  const address = b.address || {};
  const contact = b.contact || {};

  const zips =
    serviceAreas.zips ||
    serviceAreas.coverageZips ||
    b.coverageZips ||
    address.coverageZips ||
    [];

  const contactDigits = b.contactDigits || digitsOnly(b.contactNumber) || digitsOnly(b.phone);

  return {
    _id: String(b.id), // Firestore doc id
    displayName: b.businessName || b.displayName || b.name || b.ownerName || 'Business',
    email: b.email || contact.email || b.ownerEmail || null,
    phone: b.contactNumber || b.phone || null,
    phoneDigits: contactDigits || null,      // VERY IMPORTANT for SMS
    state: b.state || address.state || serviceAreas.state || null,
    zip: b.zip || address.zip || b.homeZip || null,
    coverageZips: Array.isArray(zips) ? zips : [],
    rating: b.rating || null,
    notes: b.notes || '',
  };
}

/* ---------- Matching ---------- */
function scoreCleaner(job, c) {
  let score = 0;
  const jZip = String(job?.property?.zip || '');
  const jState = String(job?.property?.state || '');
  const cState = String(c.state || '');
  const cZip = String(c.zip || '');
  const cZips = Array.isArray(c.coverageZips) ? c.coverageZips.map(String) : [];

  if (jZip && (cZips.includes(jZip) || cZip === jZip)) score += 10;
  else if (jState && cState && jState === cState) score += 5;

  if (c.rating) score += Number(c.rating) * 0.5;
  return score;
}
async function rankCandidates(job, cleaners, k) {
  const scored = cleaners.map((c) => ({ c, s: scoreCleaner(job, c) }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, k).map((x) => x.c);
}

/* ---------- Offer send / cascade ---------- */
async function sendOffer(job, cleaner, attemptNo, expireMinutes) {
  const expiresAt = new Date(Date.now() + expireMinutes * 60 * 1000);
  const payload = { jobId: String(job._id), cleanerId: String(cleaner._id), attemptNo };
  const token = signToken(payload);

  const acceptUrl = `${API_BASE_URL}/offers/respond?token=${encodeURIComponent(token)}&action=accept`;
  const declineUrl = `${API_BASE_URL}/offers/respond?token=${encodeURIComponent(token)}&action=decline`;

  const addr = [job?.property?.address, job?.property?.city, job?.property?.state, job?.property?.zip]
    .filter(Boolean).join(', ');
  const start = job.date ? new Date(job.date).toLocaleString() : '—';
  const duration = job.durationMinutes || 120;

  const body = [
    `New cleaning job offer`,
    `Property: ${addr || 'N/A'}`,
    `When: ${start} (${duration} min)`,
    `Pay: ${job?.payTotal ? `$${job.payTotal}` : '—'}`,
    ``,
    `Accept: ${acceptUrl}`,
    `Decline: ${declineUrl}`,
    ``,
    `You have ${expireMinutes} minutes to respond.`,
  ].join('\n');

  const to = cleaner.phoneDigits ? `+1${cleaner.phoneDigits}` : cleaner.phone;
  let smsSid = '', smsError = '';
  try {
    const sent = await sendSMS(to, body);
    smsSid = sent.sid || 'DRY_RUN';
  } catch (e) { smsError = e?.message || String(e); }

  const offer = await JobOffer.findOneAndUpdate(
    { jobId: job._id, attemptNo },
    {
      $set: {
        cleanerId: String(cleaner._id),
        status: 'offered',
        token,
        sentAt: new Date(),
        expiresAt,
        propertyId: job.propertyId || '',
        propertyZip: job?.property?.zip || '',
        propertyState: job?.property?.state || '',
        smsSid, smsError,
      }
    },
    { upsert: true, new: true }
  );
  return offer;
}

async function ensureProgress(jobId, { expireMinutes = Number(OFFER_EXPIRE_MIN) || 15, maxCandidates = Number(OFFER_MAX_CANDIDATES) || 10 } = {}) {
  const job = await Job.findById(jobId);
  if (!job) return { progressed: false, reason: 'JOB_NOT_FOUND' };

  if (job.assignedContractorId) {
    await JobOffer.updateMany({ jobId, status: 'offered' }, { $set: { status: 'cancelled' } });
    return { progressed: false, reason: 'ALREADY_ASSIGNED' };
  }

  const last = (await JobOffer.find({ jobId }).sort({ attemptNo: -1 }).limit(1))[0] || null;

  if (!last) {
    const cleaners = await getCleaners();
    const ranked = await rankCandidates(job, cleaners, maxCandidates);
    if (!ranked.length) return { progressed: false, reason: 'NO_CANDIDATES' };
    return { progressed: true, offer: await sendOffer(job, ranked[0], 1, expireMinutes) };
  }

  if (last.status === 'offered') {
    if (Date.now() < new Date(last.expiresAt).getTime()) {
      return { progressed: false, reason: 'WAITING_CURRENT' };
    }
    await JobOffer.updateOne({ _id: last._id }, { $set: { status: 'expired' } });
  }

  const cleaners = await getCleaners();
  const ranked = await rankCandidates(job, cleaners, maxCandidates);
  const idx = ranked.findIndex((c) => String(c._id) === String(last.cleanerId));
  const nextIdx = idx < 0 ? 0 : idx + 1;
  if (nextIdx >= ranked.length) return { progressed: false, reason: 'DEPLETED' };

  return { progressed: true, offer: await sendOffer(job, ranked[nextIdx], last.attemptNo + 1, expireMinutes) };
}

async function skipCurrent(jobId, opts) {
  const cur = (await JobOffer.find({ jobId }).sort({ attemptNo: -1 }).limit(1))[0];
  if (cur && cur.status === 'offered') {
    await JobOffer.updateOne({ _id: cur._id }, { $set: { status: 'expired' } });
  }
  return ensureProgress(jobId, opts);
}

async function startAutopilot(jobId, opts) {
  const active = await JobOffer.findOne({ jobId, status: 'offered' }).sort({ attemptNo: -1 });
  if (active && Date.now() < new Date(active.expiresAt).getTime()) {
    return { ok: true, message: 'already-offering', offer: active };
  }
  return ensureProgress(jobId, opts);
}

async function stopAutopilot(jobId) {
  await JobOffer.updateMany({ jobId, status: 'offered' }, { $set: { status: 'cancelled' } });
  return { ok: true };
}

async function handleRespond(token, action) {
  const p = verifyToken(String(token || ''));
  if (!p) throw new Error('INVALID_TOKEN');
  const { jobId, cleanerId, attemptNo } = p;

  const offer = await JobOffer.findOne({ jobId, cleanerId, attemptNo });
  if (!offer) throw new Error('OFFER_NOT_FOUND');
  if (offer.status !== 'offered') return { ok: true, offer };

  if (action === 'accept') {
    const job = await Job.findOneAndUpdate(
      { _id: jobId, $or: [{ assignedContractorId: null }, { assignedContractorId: '' }, { assignedContractorId: { $exists: false } }] },
      { $set: { assignedContractorId: cleanerId, status: 'accepted' } },
      { new: true }
    );
    if (!job) {
      await JobOffer.updateOne({ _id: offer._id }, { $set: { status: 'expired' } });
      return { ok: false, reason: 'ALREADY_ASSIGNED' };
    }
    await JobOffer.updateOne({ _id: offer._id }, { $set: { status: 'accepted' } });
    await JobOffer.updateMany({ jobId, status: 'offered' }, { $set: { status: 'cancelled' } });
    return { ok: true, offer, job };
  }

  if (action === 'decline') {
    await JobOffer.updateOne({ _id: offer._id }, { $set: { status: 'declined' } });
    await ensureProgress(jobId);
    return { ok: true, offer };
  }

  throw new Error('INVALID_ACTION');
}

async function listOffers(jobId) {
  return JobOffer.find({ jobId }).sort({ attemptNo: 1 });
}

module.exports = {
  startAutopilot,
  stopAutopilot,
  skipCurrent,
  ensureProgress,
  handleRespond,
  listOffers,
  // exported for tests if needed
  getCleaners,
};
