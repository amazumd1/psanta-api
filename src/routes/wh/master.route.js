const express = require("express");
const { body, query } = require("express-validator");
const router = express.Router();
const { Warehouse, Location, getOrCreateStageLoc } = require("./helpers");

// Warehouses
router.get("/warehouses", async (_req, res, next) => {
  try { res.json(await Warehouse.find().sort({ code: 1 })); }
  catch (e) { next(e); }
});

router.post(
  "/warehouses",
  [ body("code").isString().notEmpty(), body("name").isString().notEmpty() ],
  async (req, res, next) => {
    try {
      const wh = await Warehouse.create(req.body);
      // auto-create STAGE
      await getOrCreateStageLoc(wh._id);
      res.status(201).json(wh);
    } catch (e) { next(e); }
  }
);

// Locations
router.get(
  "/locations",
  [ query("warehouseId").isString().notEmpty() ],
  async (req, res, next) => {
    try {
      const rows = await Location.find({ warehouseId: req.query.warehouseId }).sort({ code: 1 });
      res.json(rows);
    } catch (e) { next(e); }
  }
);

router.post(
  "/locations",
  [
    body("warehouseId").isString().notEmpty(),
    body("code").isString().notEmpty(),
    body("type").optional().isString().isIn(["STAGE","BIN","PICK","BACK"])
  ],
  async (req, res, next) => {
    try {
      const row = await Location.create(req.body);
      res.status(201).json(row);
    } catch (e) { next(e); }
  }
);

module.exports = router;
