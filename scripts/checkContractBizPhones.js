/**
 * Verify Contract Businesses phone fields.
 * Prints: total docs, missing phones, bad digits, and few samples.
 *
 * Usage:
 *   set GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_PROJECT_ID as needed
 *   node scripts/checkContractBizPhones.js
 */
const admin = require("firebase-admin");
const path = require("path");

const SA_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.resolve(__dirname, "../serviceAccount.json");
let sa = null;
try { sa = require(SA_PATH); } catch (e) {}

const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  (sa && (sa.project_id || sa.projectId));

if (sa) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: PROJECT_ID || sa.project_id });
} else {
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID });
}

const db = admin.firestore();

(async () => {
  const col = db.collection("contractBusinesses");
  const snap = await col.get();
  const docs = snap.docs;
  const total = docs.length;

  const PHONE_RE = /^\d{10}$/;
  let missing = 0, bad = 0;
  const samples = [];

  for (const d of docs) {
    const x = d.data() || {};
    const digits = (x.contactDigits || "").toString();
    if (!x.contactNumber || !x.contactDigits) missing++;
    else if (!PHONE_RE.test(digits)) bad++;
    if (samples.length < 8) {
      samples.push({ id: d.id, businessName: x.businessName || "", contactNumber: x.contactNumber || null, contactDigits: x.contactDigits || null });
    }
  }

  console.log("Project:", PROJECT_ID || "(unknown)");
  console.log("Total docs:", total);
  console.log("Missing phone fields:", missing);
  console.log("Invalid digits (!=10):", bad);
  console.log("Samples:", samples);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
