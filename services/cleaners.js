/**
 * Cleaners service: pulls from Firebase Admin if creds present; else demo fallback.
 * Now supports BOTH 'cleaners' and 'contractBusinesses' collections,
 * and normalizes IDs + names (uses businessName fallback).
 */

let _cache = { at: 0, rows: [] };
const TTL_MS = 5 * 60 * 1000; // 5 minutes

function normalizeCleaner(docId, d = {}) {
  const id =
    String(
      d._id || d.id || d.docId || d.uid || d.documentId || docId || ''
    );

  const displayName =
    d.displayName ||
    d.businessName ||
    d.name ||
    d.contactName ||
    d.ownerName ||
    d.email ||
    'Cleaner';

  return {
    _id: id,
    displayName,
    phone: d.phone || d.contactDigits || d.contactNumber || null,
    email: d.email || null,
    status: d.status || (d.approvedDate ? 'active' : 'active'),
    serviceAreas: d.serviceAreas || { states: [], zips: [] },
    skills: d.skills || [],
    capacity: d.capacity || { perDay: 4 },
    homeZip: d.homeZip || null,
    homeLatLng: d.homeLatLng || null,
    rating: d.rating || null,
    jobsCompleted: d.jobsCompleted || 0,
  };
}

async function fetchFromFirebase() {
  try {
    if (!process.env.FIREBASE_PROJECT_ID) return null;

    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: process.env.FIREBASE_PROJECT_ID,
      });
    }

    const db = admin.firestore();

    // We’ll collect from both collections and de-dup by _id:
    const rowsMap = new Map();

    // 1) cleaners (active)
    try {
      const snap = await db
        .collection('cleaners')
        .where('status', '==', 'active')
        .get();

      snap.forEach((doc) => {
        const d = doc.data() || {};
        const norm = normalizeCleaner(doc.id, d);
        rowsMap.set(norm._id, norm);
      });
    } catch (e) {
      console.warn('fetch cleaners failed:', e.message);
    }

    // 2) contractBusinesses (some assignments use these IDs)
    try {
      const cSnap = await db.collection('contractBusinesses').get();
      cSnap.forEach((doc) => {
        const d = doc.data() || {};
        const norm = normalizeCleaner(doc.id, {
          ...d,
          // make sure displayName falls back to businessName
          displayName: d.displayName || d.businessName || d.name,
          phone: d.contactDigits || d.contactNumber || d.phone,
        });

        // prefer existing 'cleaners' entry, but if name missing/placeholder, override
        const prev = rowsMap.get(norm._id);
        if (!prev || !prev.displayName || prev.displayName === 'Cleaner') {
          rowsMap.set(norm._id, norm);
        }
      });
    } catch (e) {
      console.warn('fetch contractBusinesses failed:', e.message);
    }

    return Array.from(rowsMap.values());
  } catch (e) {
    console.warn('Cleaners Firebase fetch failed:', e.message);
    return null;
  }
}

async function getCleaners() {
  const now = Date.now();
  if (_cache.rows.length && now - _cache.at < TTL_MS) return _cache.rows;

  const fb = await fetchFromFirebase();
  const rows =
    fb && fb.length
      ? fb
      : [
          // ---- demo fallback ----
          {
            _id: 'cleaner-001',
            displayName: 'Alex Johnson',
            status: 'active',
            serviceAreas: { states: ['TX'], zips: ['78701', '78702', '78704'] },
            skills: ['turnover', 'deep'],
            capacity: { perDay: 4 },
            rating: 4.8,
            jobsCompleted: 120,
          },
          {
            _id: 'cleaner-002',
            displayName: 'Maria Gomez',
            status: 'active',
            serviceAreas: { states: ['TX'], zips: ['78745', '78748', '78749'] },
            skills: ['turnover'],
            capacity: { perDay: 3 },
            rating: 4.6,
            jobsCompleted: 90,
          },
        ];

  _cache = { at: now, rows };
  return rows;
}

module.exports = { getCleaners };
