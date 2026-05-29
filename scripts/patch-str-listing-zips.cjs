require("dotenv").config({ path: "./config.env" });
require("dotenv").config({ path: "./.env.local" });
require("dotenv").config({ path: "./.env" });

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const StrListing = require("../models/StrListing");
const ServiceRequest = require("../models/ServiceRequest");

function cleanPostalCode(v) {
  return String(v || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9 -]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 12);
}

function zip3FromPostal(v) {
  const compact = cleanPostalCode(v).replace(/[^A-Z0-9]/g, "");
  return compact.length >= 3 ? compact.slice(0, 3) : "";
}

/**
 * SAFE VERIFIED fixes only.
 * Do not put city-only guesses here unless you are okay with non-exact ZIP.
 */
const ZIP_FIXES = {
  // Capitol Hill / Eastern Market DC
  "str_1777775774264_ticdfl": "20003",

  // 3470 Sheridan Ave, Miami Beach, FL
  "str_1777677074652_zj5n1r": "33140",

  // Palm-Aire / Pompano Beach area
  "str_1776894771648_k6w6pt": "33069",

  // Fort Lauderdale / Roosevelt Gardens
  "str_1776614178559_g4dm4n": "33311",

  // Santa Isabel, Puerto Rico
  "str_1772166189949_biz954": "00757",

  // Stone House, San Jose / Santa Ana, Costa Rica
  "str_1772155577807_oijncw": "10901",

  // Asnières-sur-Seine, France
  "str_1771632618454_8r44bo": "92600",

  // Les Lilas, France
  "str_1771546215540_vgwiak": "93260",
};

const APPLY = process.argv.includes("--apply");

(async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI missing. Check config.env / .env.local / .env");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const ids = Object.keys(ZIP_FIXES);
  const before = await StrListing.find({ listing_id: { $in: ids } })
    .sort({ updatedAt: -1 })
    .lean();

  const backupDir = path.join(__dirname, "backups");
  fs.mkdirSync(backupDir, { recursive: true });

  const backupFile = path.join(
    backupDir,
    `str-listing-zip-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );

  fs.writeFileSync(backupFile, JSON.stringify(before, null, 2));

  console.log(`Backup saved: ${backupFile}`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log("");

  const results = [];

  for (const [listing_id, nextZipRaw] of Object.entries(ZIP_FIXES)) {
    const nextZip = cleanPostalCode(nextZipRaw);
    const nextZip3 = zip3FromPostal(nextZip);

    const doc = await StrListing.findOne({ listing_id }).lean();

    if (!doc) {
      results.push({ listing_id, ok: false, reason: "not_found" });
      continue;
    }

    const row = {
      listing_id,
      title: doc.public_title || "",
      old_zip: doc.zip || "",
      old_zip3: doc.zip3 || "",
      next_zip: nextZip,
      next_zip3: nextZip3,
      apply: APPLY,
    };

    if (APPLY) {
      await StrListing.updateOne(
        { listing_id },
        {
          $set: {
            zip: nextZip,
            zip3: nextZip3,
            updatedAt: new Date(),
          },
        }
      );

      // Sync housing feed created by STR publish / ensure_feed
      await ServiceRequest.updateMany(
        {
          $or: [
            { dedupeKey: `str_listing|${listing_id}` },
            { "fields.referenceId": listing_id },
          ],
        },
        {
          $set: {
            zip: nextZip,
            zip3: nextZip3,
            updatedAt: new Date(),
          },
        }
      );
    }

    results.push({ ok: true, ...row });
  }

  console.table(results);

  console.log("");
  console.log("Rows not patched because public output does not include exact address:");
  console.log([
    "str_1777499133637_gygcuo — title only says Spacious",
    "str_1777382879756_rze8bd — Washington city only",
    "str_1773620754328_rktaqs — no city/address in title",
    "str_1773618886503_hkw4vj — Kalimpong/Hill View needs exact PIN/address",
    "str_1773606917235_z7mj59 — Paris city only",
    "str_1773605729957_p5b38l — no city/address in title",
    "str_1773604398488_l3e1ye — no city/address in title",
    "str_1773604158485_e565yy — Raleigh city only",
    "str_1772278154137_fy2c7l — South Sikkim broad area only",
    "str_1772749711308_ya3buc — no city/address in title",
    "str_1772391677673_35xcbe — Greensboro city only",
    "str_1772154475716_m0bbdx — gated community title only",
    "str_1772148975858_k15ape — no city/address in title",
    "str_1772144016220_b3y7h4 — Greensboro city only",
    "str_1772056574964_wurbcy — Surrey UK needs full postal code",
    "str_1771724938192_8zayzm — Kolkata city only",
    "str_1771630932021_ordz0g — Seongdong-gu has many postal codes",
    "str_1771556690091_xfvsx0 — Seoul Chinatown not exact enough",
    "str_1771546526002_0ggvv8 — London UK needs full postal code",
    "str_1771537223197_4gax0v — Luton UK needs full postal code",
  ].join("\n"));

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});

