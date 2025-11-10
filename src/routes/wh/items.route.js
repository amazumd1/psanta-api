// services/api/src/routes/wh/items.route.js
const express = require("express");
const { query, body, param } = require("express-validator");
const mongoose = require("mongoose");
const router = express.Router();

const { Item } = require("./helpers"); // expects helpers to export Item model

// ---------- utils ----------
const isObjectId = (s) => mongoose.isValidObjectId(String(s || ""));
const trim = (v) => (typeof v === "string" ? v.trim() : v);
const escReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isNumericBarcode = (s) => /^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(String(s || "").trim()); // EAN-8/UPC-A/EAN-13/GTIN-14

function sanitizeItemPayload(p = {}) {
  return {
    sku: trim(p.sku),
    name: trim(p.name),
    uom: trim(p.uom),
    barcode: trim(p.barcode),
    lotTracked: typeof p.lotTracked === "boolean" ? p.lotTracked : undefined,
    expiryTracked: typeof p.expiryTracked === "boolean" ? p.expiryTracked : undefined,
    packSize: p.packSize != null ? Number(p.packSize) : undefined,
    reorderPoint: p.reorderPoint != null ? Number(p.reorderPoint) : undefined,
  };
}

// ---------- LIST / SEARCH ----------
router.get(
  "/",
  [
    query("q").optional().isString(),
    query("search").optional().isString(),
    query("limit").optional().isInt({ min: 1, max: 200 }),
  ],
  async (req, res, next) => {
    try {
      const s = trim(req.query.q ?? req.query.search ?? "");
      const limit = Number(req.query.limit || 50);

      if (!s) {
        const rows = await Item.find({}).sort({ sku: 1 }).limit(limit).lean();
        return res.json(rows);
      }

      // if pure numeric barcode length -> exact barcode match first
      if (isNumericBarcode(s)) {
        const exact = await Item.find({ barcode: s }).limit(limit).lean();
        if (exact.length) return res.json(exact);
      }

      const rx = new RegExp(escReg(s), "i");
      const rows = await Item.find({
        $or: [{ sku: rx }, { name: rx }, { barcode: rx }],
      })
        .sort({ sku: 1 })
        .limit(limit)
        .lean();

      res.json(rows);
    } catch (e) {
      next(e);
    }
  }
);

// Dedicated /search (same behavior; some frontends prefer it)
router.get(
  "/search",
  [query("q").isString()],
  async (req, res, next) => {
    try {
      const s = trim(req.query.q);
      const limit = Number(req.query.limit || 50);

      if (isNumericBarcode(s)) {
        const exact = await Item.find({ barcode: s }).limit(limit).lean();
        if (exact.length) return res.json(exact);
      }

      const rx = new RegExp(escReg(s), "i");
      const rows = await Item.find({
        $or: [{ sku: rx }, { name: rx }, { barcode: rx }],
      })
        .sort({ sku: 1 })
        .limit(limit)
        .lean();

      res.json(rows);
    } catch (e) {
      next(e);
    }
  }
);

// ---------- GET by id OR sku ----------
router.get(
  "/:idOrSku",
  [param("idOrSku").isString().notEmpty()],
  async (req, res, next) => {
    try {
      const key = trim(req.params.idOrSku);
      let row = null;

      if (isObjectId(key)) {
        row = await Item.findById(key).lean();
      }
      if (!row) {
        row = await Item.findOne({ sku: key }).lean();
      }
      if (!row) return res.status(404).json({ error: "Not found" });

      res.json(row);
    } catch (e) {
      next(e);
    }
  }
);

// ---------- CREATE ----------
router.post(
  "/",
  [
    body("sku").isString().notEmpty(),
    body("name").optional().isString(),
    body("uom").optional().isString(),
    body("barcode").optional().isString(),
    body("lotTracked").optional().isBoolean(),
    body("expiryTracked").optional().isBoolean(),
    body("packSize").optional().isNumeric(),
    body("reorderPoint").optional().isNumeric(),
  ],
  async (req, res, next) => {
    try {
      const payload = sanitizeItemPayload(req.body);

      // simple dup check by SKU
      const exists = await Item.findOne({ sku: payload.sku }).lean();
      if (exists) return res.status(409).json({ error: "SKU already exists" });

      const row = await Item.create(payload);
      res.status(201).json(row);
    } catch (e) {
      next(e);
    }
  }
);

// ---------- UPDATE (PUT/PATCH) ----------
const updateValidators = [
  param("id").isString().notEmpty(),
  body("sku").optional().isString(),
  body("name").optional().isString(),
  body("uom").optional().isString(),
  body("barcode").optional().isString(),
  body("lotTracked").optional().isBoolean(),
  body("expiryTracked").optional().isBoolean(),
  body("packSize").optional().isNumeric(),
  body("reorderPoint").optional().isNumeric(),
];

router.put("/:id", updateValidators, async (req, res, next) => {
  try {
    const payload = sanitizeItemPayload(req.body);
    const row = await Item.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  } catch (e) {
    next(e);
  }
});

router.patch("/:id", updateValidators, async (req, res, next) => {
  try {
    const payload = sanitizeItemPayload(req.body);
    const row = await Item.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  } catch (e) {
    next(e);
  }
});

// ---------- DELETE ----------
router.delete("/:id", [param("id").isString().notEmpty()], async (req, res, next) => {
  try {
    const out = await Item.findByIdAndDelete(req.params.id);
    if (!out) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---------- BULK UPSERT by SKU ----------
router.post(
  "/bulk-upsert",
  [body("rows").isArray({ min: 1 })],
  async (req, res, next) => {
    try {
      const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
      const results = [];
      for (const r of rows) {
        const payload = sanitizeItemPayload(r);
        if (!payload.sku) continue;
        const up = await Item.findOneAndUpdate(
          { sku: payload.sku },
          { $set: payload },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        results.push(up);
      }
      res.json({ count: results.length, items: results });
    } catch (e) {
      next(e);
    }
  }
);

module.exports = router;
