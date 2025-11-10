// const express = require("express");
// const PricingConfig = require("../models/PricingConfig");
// const router = express.Router();

// // GET latest
// router.get("/pricing-config", async (req, res) => {
//   const doc = await PricingConfig.findOne({}, {}, { sort: { updatedAt: -1 } });
//   if (!doc) return res.json({ config: null, version: 0 });
//   res.json({ config: doc.config, version: doc.version, updatedAt: doc.updatedAt });
// });

// // PUT replace (upsert)
// router.put("/pricing-config", async (req, res) => {
//   const { config } = req.body || {};
//   if (!config || typeof config !== "object") {
//     return res.status(400).json({ ok: false, error: "invalid config" });
//   }
//   const doc = new PricingConfig({ config });
//   await doc.save();
//   res.json({ ok: true, version: doc.version, updatedAt: doc.updatedAt });
// });

// module.exports = router;
