// services/api/scripts/backfillContractBusinessPhones.verify.js
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

/* Seeded RNG (deterministic if SEED set) */
function mulberry32(seed){let t=seed>>>0;return function(){t+=0x6D2B79F5;let r=Math.imul(t^(t>>>15),1|t);r^=r+Math.imul(r^(r>>>7),61|r);return((r^(r>>>14))>>>0)/4294967296;}}
const seedStr = process.env.SEED;
const rng = seedStr ? mulberry32(Number(seedStr)||1) : Math.random;
const rint = (min,max)=>{const r=seedStr?rng():Math.random();return Math.floor(r*(max-min+1))+min;};

function randomPhone(){
  const area=`${rint(2,9)}${rint(0,9)}${rint(0,9)}`;
  const prefix=`${rint(2,9)}${rint(0,9)}${rint(0,9)}`;
  const line=`${rint(0,9)}${rint(0,9)}${rint(0,9)}${rint(0,9)}`;
  const digits=`${area}${prefix}${line}`;
  const pretty=`(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  return { digits, pretty };
}

(async()=>{
  const ONLY_MISSING = process.env.ONLY_MISSING !== "0"; // default: true
  const DRY_RUN = process.env.DRY_RUN === "1";
  const LIMIT = Number(process.env.LIMIT || 0);

  console.log("Project:", PROJECT_ID || "(unknown)");
  console.log({ ONLY_MISSING, DRY_RUN, LIMIT, SEED: seedStr || "(none)" });

  const col = db.collection("contractBusinesses");
  const all = (await col.get()).docs;
  if(!all.length){ console.log("No docs in 'contractBusinesses'"); process.exit(0); }

  const docs = ONLY_MISSING
    ? all.filter(d => { const x=d.data()||{}; return !x.contactNumber || !x.contactDigits; })
    : all;

  console.log("Docs to process:", docs.length);
  let ok=0, processed=0;

  for (const d of docs){
    if(LIMIT && processed>=LIMIT) break;
    const data = d.data() || {};
    const {digits, pretty} = randomPhone();
    const contactNumber = data.contactNumber || pretty;
    const contactDigits = data.contactDigits || digits;

    console.log(`${DRY_RUN ? "[DRY]" : "[UPD]"} ${d.id} -> ${contactNumber} [${contactDigits}]`);

    if(!DRY_RUN){
      await d.ref.set({
        contactNumber,
        contactDigits,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        backfill_phone: true,
      }, { merge: true });

      // verify read
      const after = await d.ref.get();
      const ax = after.data() || {};
      if (ax.contactNumber && ax.contactDigits && String(ax.contactDigits).length === 10) ok++;
    }
    processed++;
  }
  console.log("Processed:", processed, "OK:", ok);
  process.exit(0);
})().catch(e=>{ console.error(e); process.exit(1); });
