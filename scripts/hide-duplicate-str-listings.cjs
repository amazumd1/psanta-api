const path = require("path");
const mongoose = require("mongoose");

const ROOT = path.resolve(__dirname, "..");

require("dotenv").config({ path: path.join(ROOT, "config.env") });
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const StrListing = require("../models/StrListing");

const APPLY = process.argv.includes("--apply");

function cleanKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function keyOf(d) {
  return `${cleanKey(d.public_title)}|${String(d.zip || "").trim()}`;
}

(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI missing");

  await mongoose.connect(process.env.MONGODB_URI);

  const rows = await StrListing.find({ published: true })
    .sort({ updatedAt: -1, publishedAt: -1, createdAt: -1 })
    .lean();

  const groups = new Map();

  for (const d of rows) {
    const key = keyOf(d);
    if (!key || key === "|") continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }

  const actions = [];

  for (const [key, docs] of groups.entries()) {
    if (docs.length <= 1) continue;

    const keep = docs[0];
    const remove = docs.slice(1);

    for (const d of remove) {
      actions.push({
        key,
        keep_listing_id: keep.listing_id,
        hide_listing_id: d.listing_id,
        title: d.public_title,
        zip: d.zip,
      });

      if (APPLY) {
        await StrListing.updateOne(
          { _id: d._id },
          {
            $set: {
              published: false,
              duplicateHidden: true,
              duplicateOf: keep.listing_id,
              updatedAt: new Date(),
            },
          }
        );
      }
    }
  }

  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.table(actions);

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});