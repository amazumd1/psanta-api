const express = require("express");
const { body, query } = require("express-validator");
const router = express.Router();
const {
  getOrCreateItemBySku, findWarehouseByIdOrCode,
  getOrCreateStageLoc, getLocByCode, postTxn, Balance
} = require("./helpers");

// ---- Stock view (aggregated) ----
router.get(
  "/stock",
  [ query("warehouseId").isString().notEmpty(), query("sku").optional().isString() ],
  async (req, res, next) => {
    try {
      const { warehouseId, sku } = req.query;
      const match = { warehouseId };
      if (sku) match.sku = sku;
      const rows = await Balance.find(match).sort({ sku: 1, locationId: 1, lot: 1, expiry: 1 });
      res.json(rows);
    } catch (e) { next(e); }
  }
);

// ---- Receive to STAGE ----
router.post(
  "/receive",
  [
    body("warehouseId").isString().notEmpty(),
    body("lines").isArray({ min: 1 }),
    body("lines.*.sku").isString().notEmpty(),
    body("lines.*.qty").isNumeric(),
    body("lines.*.lot").optional().isString(),
    body("lines.*.expiry").optional().isString()
  ],
  async (req, res, next) => {
    try {
      const { warehouseId, lines } = req.body;
      const warehouse = await findWarehouseByIdOrCode(warehouseId);
      if (!warehouse) throw Object.assign(new Error("warehouse_not_found"), { status: 404 });
      const stage = await getOrCreateStageLoc(warehouse._id);

      const results = [];
      for (const l of lines) {
        const item = await getOrCreateItemBySku(l.sku);
        const expiry = l.expiry ? new Date(l.expiry) : null;
        const t = await postTxn({
          type: "RECEIPT", warehouse, item, qty: Math.abs(Number(l.qty || 1)),
          toLoc: stage, lot: l.lot, expiry, ref: { type: "RECEIVE_DOC" }
        });
        results.push(t);
      }
      res.status(201).json({ ok: true, count: results.length });
    } catch (e) { next(e); }
  }
);

// ---- Putaway from STAGE -> target BIN ----
router.post(
  "/putaway",
  [
    body("warehouseId").isString().notEmpty(),
    body("moves").isArray({ min: 1 }),
    body("moves.*.sku").isString().notEmpty(),
    body("moves.*.qty").isNumeric(),
    body("moves.*.toLoc").isString().notEmpty(),
    body("moves.*.lot").optional().isString(),
    body("moves.*.expiry").optional().isString()
  ],
  async (req, res, next) => {
    try {
      const { warehouseId, moves } = req.body;
      const warehouse = await findWarehouseByIdOrCode(warehouseId);
      if (!warehouse) throw Object.assign(new Error("warehouse_not_found"), { status: 404 });
      const stage = await getOrCreateStageLoc(warehouse._id);

      for (const m of moves) {
        const item = await getOrCreateItemBySku(m.sku);
        const to = await getLocByCode(warehouse._id, m.toLoc);
        const expiry = m.expiry ? new Date(m.expiry) : null;
        await postTxn({
          type: "MOVE", warehouse, item, qty: Math.abs(Number(m.qty || 1)),
          fromLoc: stage, toLoc: to, lot: m.lot, expiry, ref: { type: "PUTAWAY" }
        });
      }
      res.json({ ok: true, count: moves.length });
    } catch (e) { next(e); }
  }
);

// ---- Transfer between any two locs ----
router.post(
  "/transfer",
  [
    body("warehouseId").isString().notEmpty(),
    body("sku").isString().notEmpty(),
    body("qty").isNumeric(),
    body("fromLoc").isString().notEmpty(),
    body("toLoc").isString().notEmpty(),
    body("lot").optional().isString(),
    body("expiry").optional().isString()
  ],
  async (req, res, next) => {
    try {
      const { warehouseId, sku, qty, fromLoc, toLoc, lot, expiry } = req.body;
      const warehouse = await findWarehouseByIdOrCode(warehouseId);
      if (!warehouse) throw Object.assign(new Error("warehouse_not_found"), { status: 404 });

      const item = await getOrCreateItemBySku(sku);
      const from = await getLocByCode(warehouse._id, fromLoc);
      const to = await getLocByCode(warehouse._id, toLoc);

      await postTxn({
        type: "MOVE", warehouse, item, qty: Math.abs(Number(qty || 1)),
        fromLoc: from, toLoc: to, lot, expiry: expiry ? new Date(expiry) : null,
        ref: { type: "TRANSFER" }
      });

      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);

// ---- Issue / Dispatch (stock out to customer job) ----
router.post(
  "/issue",
  [
    body("warehouseId").isString().notEmpty(),
    body("jobId").isString().notEmpty(),
    body("lines").isArray({ min: 1 }),
  ],
  async (req, res, next) => {
    try {
      const { warehouseId, jobId, lines } = req.body;
      const warehouse = await findWarehouseByIdOrCode(warehouseId);

      // All balances for allocation (exclude STAGE)
      const { Location } = require("./helpers");
      const stageIds = await Location.find({ warehouseId: warehouse._id, type: "STAGE" }).distinct("_id");

      for (const L of lines) {
        const item = await getOrCreateItemBySku(L.sku);
        let remaining = Math.abs(Number(L.qty || 1));

        // Prefer FEFO (expiry earliest first), then bigger qty
        const balances = await Balance.find({
          warehouseId: warehouse._id,
          itemId: item._id,
          qty: { $gt: 0 },
          locationId: { $nin: stageIds },
        }).populate("locationId").exec();

        // Optional fromLoc preference
        let picks = balances;
        if (L.fromLoc) {
          picks = balances.filter(b => (b.locationId?.code || "") === L.fromLoc);
          if (!picks.length) picks = balances; // fallback
        }

        picks.sort((a, b) => {
          const ea = a.expiry ? new Date(a.expiry).getTime() : Infinity;
          const eb = b.expiry ? new Date(b.expiry).getTime() : Infinity;
          if (ea !== eb) return ea - eb; // earliest expiry first
          return (b.qty || 0) - (a.qty || 0);
        });

        for (const b of picks) {
          if (remaining <= 0) break;
          const take = Math.min(b.qty, remaining);
          await postTxn({
            type: "MOVE",            // using MOVE with toLoc null == out
            warehouse,
            item,
            qty: take,
            fromLoc: b.locationId,
            toLoc: null,
            lot: b.lot || "",
            expiry: b.expiry || null,
            ref: { type: "JOB", id: String(jobId) },
          });
          remaining -= take;
        }

        if (remaining > 0) {
          const err = new Error(`Insufficient stock for ${item.sku}`);
          err.status = 400;
          throw err;
        }
      }

      res.status(201).json({ ok: true });
    } catch (e) { next(e); }
  }
);


module.exports = router;
