const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const ROOT = path.resolve(__dirname, "..");

require("dotenv").config({ path: path.join(ROOT, "config.env") });
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

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

function asObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? { ...v } : {};
}

function patchPreview(preview, fix) {
  let s = String(preview || "");

  const title = fix.title || "";
  const loc = fix.locationLabel || [fix.city, fix.state].filter(Boolean).join(", ");

  if (title) {
    if (/^Headline: .+$/m.test(s)) {
      s = s.replace(/^Headline: .+$/m, `Headline: ${title}`);
    } else if (s.trim()) {
      s = `Headline: ${title}\n${s}`;
    }
  }

  if (loc) {
    if (/^Location: .+$/m.test(s)) {
      s = s.replace(/^Location: .+$/m, `Location: ${loc}`);
    } else if (s.trim()) {
      s = s.replace(/^Description:/m, `Location: ${loc}\nDescription:`);
    }
  }

  return s;
}

/**
 * Notes:
 * - Some Airbnb listings hide exact street/postal until booking.
 * - For those, use the most precise visible neighborhood/city postal.
 * - If no reliable location exists, use TBD to remove the false Florida ZIP.
 */
const FIXES = {
  // Washington DC / Capitol Hill
  "str_1777775774264_ticdfl": {
    zip: "20003",
    city: "Washington",
    state: "DC",
    title: "Steps to Metro | Capitol Hill 1BR | Sleeps 4",
    locationLabel: "Capitol Hill / Eastern Market, Washington, DC",
    confidence: "high_area",
  },
  "str_1777499133637_gygcuo": {
    zip: "20003",
    city: "Washington",
    state: "DC",
    title: "Spacious, stylish Capitol Hill home (free parking)",
    locationLabel: "Capitol Hill / Eastern Market, Washington, DC",
    confidence: "high_area",
  },
  "str_1777382879756_rze8bd": {
    zip: "20002",
    city: "Washington",
    state: "DC",
    title: "Charming Convenient 1BR, CapHill",
    locationLabel: "Capitol Hill / Union Station, Washington, DC",
    confidence: "high_area",
  },

  // Florida
  "str_1777677074652_zj5n1r": {
    zip: "33140",
    city: "Miami Beach",
    state: "FL",
    title: "3470 Sheridan Ave, Miami Beach, FL 33140",
    locationLabel: "3470 Sheridan Ave, Miami Beach, FL 33140",
    confidence: "exact_address",
  },
  "str_1776894771648_k6w6pt": {
    zip: "33060",
    city: "Pompano Beach",
    state: "FL",
    title: "Enchanting Casita w/Pool/Hot Tub near the Beach",
    locationLabel: "Pompano Beach near Atlantic Blvd & Federal Hwy, FL",
    confidence: "high_area",
  },
  "str_1776614178559_g4dm4n": {
    zip: "33312",
    city: "Fort Lauderdale",
    state: "FL",
    title: "Seaside Retreat. Heated Pool/BBQ. Tiki Bar",
    locationLabel: "Fort Lauderdale near airport / Hard Rock / Las Olas, FL",
    confidence: "area_level",
  },

  // North Carolina
  "str_1773604158485_e565yy": {
    zip: "27614",
    city: "Raleigh",
    state: "NC",
    title: "Modern Home minutes from Falls of Neuse landmarks",
    locationLabel: "Wakefield / North Raleigh, NC",
    confidence: "high_area",
  },
  "str_1772391677673_35xcbe": {
    zip: "27403",
    city: "Greensboro",
    state: "NC",
    title: "Cute cottage by UNCG",
    locationLabel: "Glenwood / UNCG, Greensboro, NC",
    confidence: "high_area",
  },
  "str_1772144016220_b3y7h4": {
    zip: "27403",
    city: "Greensboro",
    state: "NC",
    title: "Cute cottage by UNCG",
    locationLabel: "Glenwood / UNCG, Greensboro, NC",
    confidence: "high_area",
  },

  // India
  "str_1773618886503_hkw4vj": {
    zip: "734301",
    city: "Kalimpong",
    state: "West Bengal, India",
    title: "Hill View Jungle Cottages, Rooms & Gardens.",
    locationLabel: "Kalimpong, West Bengal, India",
    confidence: "city_level",
  },
  "str_1773606917235_z7mj59": {
    zip: "75000",
    city: "Paris",
    state: "France",
    title: "3BR · 2.5BA · apartment · Paris — Cozy stay",
    locationLabel: "Paris, France",
    confidence: "city_level",
  },
  "str_1773605729957_p5b38l": {
    zip: "737126",
    city: "Namchi",
    state: "Sikkim, India",
    title: "Samdruptse BNB",
    locationLabel: "Namchi, Sikkim, India",
    confidence: "city_level",
  },
  "str_1773604398488_l3e1ye": {
    zip: "734101",
    city: "Darjeeling",
    state: "West Bengal, India",
    title: "Cloud Studio by The Erina House",
    locationLabel: "Darjeeling near Mall Road, West Bengal, India",
    confidence: "city_level",
  },
  "str_1772749711308_ya3buc": {
    zip: "734101",
    city: "Darjeeling",
    state: "West Bengal, India",
    title: "Cloud Studio by The Erina House",
    locationLabel: "Darjeeling near Mall Road, West Bengal, India",
    confidence: "city_level",
  },
  "str_1772278154137_fy2c7l": {
    zip: "737126",
    city: "Namchi",
    state: "Sikkim, India",
    title: "Samdruptse BNB",
    locationLabel: "Namchi / South Sikkim, India",
    confidence: "city_level",
  },
  "str_1771724938192_8zayzm": {
    zip: "700046",
    city: "Kolkata",
    state: "West Bengal, India",
    title: "Charming 2BHK Apt beside Science City, EM Bypass",
    locationLabel: "Science City / EM Bypass, Kolkata, West Bengal, India",
    confidence: "high_area",
  },

  // Korea
  "str_1771556690091_xfvsx0": {
    zip: "08300",
    city: "Seoul",
    state: "South Korea",
    title: "Seoul Chinatown, Namguro Market 1 minute, Room 203",
    locationLabel: "Namguro Market / Guro-gu, Seoul, South Korea",
    confidence: "area_level",
  },
  "str_1771630932021_ordz0g": {
    zip: "04700",
    city: "Seongdong-gu",
    state: "Seoul, South Korea",
    title: "A house with a good view next to the park located 5 minutes away from Gangnam and Itaewon",
    locationLabel: "Seongdong-gu, Seoul, South Korea",
    confidence: "area_level",
  },

  // France
  "str_1771632618454_8r44bo": {
    zip: "92600",
    city: "Asnières-sur-Seine",
    state: "France",
    title: "3BR · 2.5BA · apartment · Asnières-sur-Seine — Cozy stay",
    locationLabel: "Asnières-sur-Seine, France",
    confidence: "city_level",
  },
  "str_1771546215540_vgwiak": {
    zip: "93260",
    city: "Les Lilas",
    state: "France",
    title: "4BR · 1BA · apartment · Les Lilas — Cozy stay",
    locationLabel: "Les Lilas, France",
    confidence: "city_level",
  },

  // Brazil / Costa Rica
  "str_1772166189949_biz954": {
    zip: "07500-000",
    city: "Santa Isabel",
    state: "São Paulo, Brazil",
    title: "3BR · 2BA · house · Santa Isabel — Cozy stay",
    locationLabel: "Santa Isabel, São Paulo, Brazil",
    confidence: "city_level",
  },
  "str_1772154475716_m0bbdx": {
    zip: "11740-000",
    city: "Itanhaém",
    state: "São Paulo, Brazil",
    title: "House with pool and barbecue Itanhaem-Cibratel",
    locationLabel: "Cibratel, Itanhaém, São Paulo, Brazil",
    confidence: "area_level",
  },
  "str_1772155577807_oijncw": {
    zip: "10901",
    city: "San José",
    state: "Costa Rica",
    title: "Stone House, Endless Mountain Views in San Jose.",
    locationLabel: "San José / Santa Ana area, Costa Rica",
    confidence: "area_level",
  },
  "str_1772148975858_k15ape": {
    zip: "20501",
    city: "Atenas",
    state: "Alajuela, Costa Rica",
    title: "Treehouse on a Coffee Farm with Ocean View",
    locationLabel: "Atenas, Alajuela, Costa Rica",
    confidence: "city_level",
  },

  // UK
  "str_1771537223197_4gax0v": {
    zip: "LU2",
    city: "Luton",
    state: "England, United Kingdom",
    title: "Contractors/Relocations/Family/Driveway/fast WiFi",
    locationLabel: "Luton LU2, England, United Kingdom",
    confidence: "area_level",
  },
  "str_1772056574964_wurbcy": {
    zip: "TBD",
    city: "Surrey",
    state: "England, United Kingdom",
    title: "Lovely 3 bedroom cottage with garden",
    locationLabel: "Surrey, England, United Kingdom",
    confidence: "needs_exact_postcode",
  },
  "str_1771546526002_0ggvv8": {
    zip: "TBD",
    city: "London",
    state: "England, United Kingdom",
    title: "4BR · 3BA · apartment · London — Cozy stay",
    locationLabel: "London, England, United Kingdom",
    confidence: "needs_exact_postcode",
  },

  // Could not resolve from visible Airbnb/public data
  "str_1773620754328_rktaqs": {
    zip: "TBD",
    city: "",
    state: "",
    title: "1BR · 2BA · apartment — Location TBD",
    locationLabel: "Location TBD",
    confidence: "needs_manual_address",
  },
};

const APPLY = process.argv.includes("--apply");

(async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI missing. Check config.env / .env.local / .env");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const ids = Object.keys(FIXES);
  const before = await StrListing.find({ listing_id: { $in: ids } })
    .sort({ updatedAt: -1 })
    .lean();

  const backupDir = path.join(__dirname, "backups");
  fs.mkdirSync(backupDir, { recursive: true });

  const backupFile = path.join(
    backupDir,
    `str-listing-location-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );

  fs.writeFileSync(backupFile, JSON.stringify(before, null, 2));

  console.log(`Backup saved: ${backupFile}`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log("");

  const results = [];

  for (const [listing_id, fix] of Object.entries(FIXES)) {
    const doc = await StrListing.findOne({ listing_id }).lean();

    if (!doc) {
      results.push({ ok: false, listing_id, reason: "not_found" });
      continue;
    }

    const nextZip = cleanPostalCode(fix.zip);
    const nextZip3 = zip3FromPostal(nextZip);

    const draft = asObject(doc.draft);
    const oldLocationHint = asObject(draft.locationHint);

    const nextLocationHint = {
      ...oldLocationHint,
      city: fix.city || oldLocationHint.city || "",
      state: fix.state || oldLocationHint.state || "",
      zip: nextZip,
      locationLabel: fix.locationLabel || "",
      confidence: fix.confidence || "",
      correctedBy: "patch-str-listing-locations-v2",
      correctedAt: new Date().toISOString(),
    };

    const nextDraft = {
      ...draft,
      city: fix.city || draft.city || "",
      state: fix.state || draft.state || "",
      title: fix.title || draft.title || draft.headline || draft.name || "",
      headline: fix.title || draft.headline || draft.title || draft.name || "",
      locationLabel: fix.locationLabel || draft.locationLabel || "",
      locationConfidence: fix.confidence || draft.locationConfidence || "",
      locationHint: nextLocationHint,
    };

    const nextPreview = patchPreview(doc.public_preview || "", fix);

    const row = {
      ok: true,
      listing_id,
      old_zip: doc.zip || "",
      next_zip: nextZip,
      old_zip3: doc.zip3 || "",
      next_zip3: nextZip3,
      city: fix.city || "",
      state: fix.state || "",
      confidence: fix.confidence || "",
      title: fix.title || doc.public_title || "",
      apply: APPLY,
    };

    if (APPLY) {
      await StrListing.updateOne(
        { listing_id },
        {
          $set: {
            zip: nextZip,
            zip3: nextZip3,
            state: fix.state || doc.state || "",
            public_title: fix.title || doc.public_title || "",
            public_preview: nextPreview,
            draft: nextDraft,
            updatedAt: new Date(),
          },
        }
      );

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
            state: fix.state || "",
            addressText: fix.locationLabel || "",
            "fields.city": fix.city || "",
            "fields.state": fix.state || "",
            "fields.zip": nextZip,
            "fields.locationLabel": fix.locationLabel || "",
            "fields.locationConfidence": fix.confidence || "",
            updatedAt: new Date(),
          },
        }
      );
    }

    results.push(row);
  }

  console.table(results);

  console.log("");
  console.log("Needs manual exact postal/address later:");
  console.table(
    results
      .filter((r) => String(r.confidence || "").includes("needs_"))
      .map((r) => ({
        listing_id: r.listing_id,
        title: r.title,
        city: r.city,
        state: r.state,
        zip: r.next_zip,
        reason: r.confidence,
      }))
  );

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
