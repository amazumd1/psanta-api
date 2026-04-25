/**
 * Cleaners service: tenant-scoped Firebase Admin reads with demo fallback.
 * Supports tenant collections:
 * - tenants/{tenantId}/cleaners
 * - tenants/{tenantId}/contractBusinesses
 */
const { admin, ensureFirebaseAdmin } = require("../lib/firebaseAdminApp");
const { tenantCollection } = require("../lib/tenantFirestore");

const _cache = new Map();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

function normalizeCleaner(docId, d = {}) {
  const id = String(
    d._id || d.id || d.docId || d.uid || d.documentId || docId || ""
  );

  const displayName =
    d.displayName ||
    d.businessName ||
    d.name ||
    d.contactName ||
    d.ownerName ||
    d.email ||
    "Cleaner";

  return {
    _id: id,
    displayName,
    phone: d.phone || d.contactDigits || d.contactNumber || null,
    email: d.email || null,
    status: d.status || (d.approvedDate ? "active" : "active"),
    serviceAreas: d.serviceAreas || { states: [], zips: [] },
    skills: d.skills || [],
    capacity: d.capacity || { perDay: 4 },
    homeZip: d.homeZip || null,
    homeLatLng: d.homeLatLng || null,
    rating: d.rating || null,
    jobsCompleted: d.jobsCompleted || 0,
  };
}

function getDemoRows() {
  return [
    {
      _id: "cleaner-001",
      displayName: "Alex Johnson",
      status: "active",
      serviceAreas: { states: ["TX"], zips: ["78701", "78702", "78704"] },
      skills: ["turnover", "deep"],
      capacity: { perDay: 4 },
      rating: 4.8,
      jobsCompleted: 120,
    },
    {
      _id: "cleaner-002",
      displayName: "Maria Gomez",
      status: "active",
      serviceAreas: { states: ["TX"], zips: ["78745", "78748", "78749"] },
      skills: ["turnover"],
      capacity: { perDay: 3 },
      rating: 4.6,
      jobsCompleted: 90,
    },
  ];
}

async function fetchFromFirebase(tenantId) {
  if (!tenantId) return null;

  try {
    ensureFirebaseAdmin();
    const db = admin.firestore();
    const rowsMap = new Map();

    try {
      const snap = await tenantCollection(db, tenantId, "cleaners")
        .where("status", "==", "active")
        .get();

      snap.forEach((doc) => {
        const d = doc.data() || {};
        const norm = normalizeCleaner(doc.id, d);
        rowsMap.set(norm._id, norm);
      });
    } catch (e) {
      console.warn("fetch tenant cleaners failed:", e.message);
    }

    try {
      const cSnap = await tenantCollection(db, tenantId, "contractBusinesses").get();
      cSnap.forEach((doc) => {
        const d = doc.data() || {};
        const norm = normalizeCleaner(doc.id, {
          ...d,
          displayName: d.displayName || d.businessName || d.name,
          phone: d.contactDigits || d.contactNumber || d.phone,
        });

        const prev = rowsMap.get(norm._id);
        if (!prev || !prev.displayName || prev.displayName === "Cleaner") {
          rowsMap.set(norm._id, norm);
        }
      });
    } catch (e) {
      console.warn("fetch tenant contractBusinesses failed:", e.message);
    }

    return Array.from(rowsMap.values());
  } catch (e) {
    console.warn("Cleaners Firebase fetch failed:", e.message);
    return null;
  }
}

async function getCleaners(tenantId) {
  const cacheKey = String(tenantId || "global");
  const cached = _cache.get(cacheKey);
  const now = Date.now();

  if (cached?.rows?.length && now - cached.at < TTL_MS) {
    return cached.rows;
  }

  const fb = await fetchFromFirebase(tenantId);
  const rows = fb && fb.length ? fb : getDemoRows();

  _cache.set(cacheKey, { at: now, rows });
  return rows;
}

module.exports = { getCleaners };