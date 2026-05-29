const path = require("path");
const mongoose = require("mongoose");

const ROOT = path.resolve(__dirname, "..");

require("dotenv").config({ path: path.join(ROOT, "config.env") });
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const StrListing = require("../models/StrListing");

(async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI missing");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const rows = await StrListing.find({})
    .sort({ updatedAt: -1 })
    .limit(300)
    .lean();

  const out = rows.map((d) => {
    const draft = d.draft && typeof d.draft === "object" ? d.draft : {};
    const fields = d.fields && typeof d.fields === "object" ? d.fields : {};

    return {
      listing_id: d.listing_id,
      current_zip: d.zip || "",
      current_zip3: d.zip3 || "",
      public_title: d.public_title || "",
      public_preview: d.public_preview || "",
      state: d.state || draft.state || fields.state || "",
      city: draft.city || fields.city || "",
      address:
        draft.address ||
        draft.fullAddress ||
        draft.formatted_address ||
        fields.address ||
        fields.fullAddress ||
        fields.formatted_address ||
        "",
      locationHint:
        draft.locationHint ||
        draft.location ||
        fields.locationHint ||
        fields.location ||
        "",
      areaHint:
        draft.areaHint ||
        draft.neighborhood ||
        fields.areaHint ||
        fields.neighborhood ||
        "",
      listingUrl:
        draft.listingUrl ||
        draft.publicLocationUrl ||
        draft.airbnbUrl ||
        draft.vrboUrl ||
        draft.url ||
        draft.link ||
        fields.listingUrl ||
        fields.url ||
        "",
      published: !!d.published,
      updatedAt: d.updatedAt || null
    };
  });

  console.log(JSON.stringify(out, null, 2));
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
