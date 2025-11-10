const { Router } = require("express");
const Alert = require("../models/Alert");

const router = Router();

router.get("/ops/alerts", async (req, res) => {
  const { cursor } = req.query;
  const q = cursor ? { createdAt: { $lt: new Date(cursor) } } : {};
  const rows = await Alert.find(q).sort({ createdAt: -1 }).limit(50).lean();
  const nextCursor = rows.length ? rows[rows.length - 1].createdAt.toISOString() : "";
  res.json({ ok: true, rows, nextCursor });
});

router.post("/ops/alerts", async (req, res) => {
  const { title, level = "info", note = "" } = req.body || {};
  if (!title) return res.status(400).send("title required");
  const doc = await Alert.create({ title, level, note });
  res.json({ ok: true, id: doc._id });
});

module.exports = router;
