const { Router } = require("express");
const WarehouseOrder = require("../src/models/WarehouseOrder");

const ENUM = new Set(WarehouseOrder.schema.path('status').enumValues);
// forward flow ko runtime enum ke hisaab se filter karo
const FLOW_ALL = ["pending_pick", "picking", "picked", "ready", "shipped"];
const FLOW = FLOW_ALL.filter(s => ENUM.has(s));
const TERMINAL = new Set(["shipped","cancelled","stocked","closed"].filter(s => ENUM.has(s)));

const router = Router();

router.get("/ops/orders", async (req, res) => {
  const { status } = req.query;
  const q = status ? { status } : {};
  const rows = await WarehouseOrder.find(q).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ ok: true, rows });
});

router.patch("/ops/orders/:id/advance", async (req, res) => {
  const row = await WarehouseOrder.findById(req.params.id);
  if (!row) return res.status(404).send("Not found");

  const s = row.status;
  if (TERMINAL.has(s)) return res.json({ ok: true, status: s });

  const idx = FLOW.indexOf(s);
  if (idx === -1) return res.json({ ok: true, status: s }); // unknown -> skip

  const next = FLOW[Math.min(idx + 1, FLOW.length - 1)];
  if (!ENUM.has(next)) return res.json({ ok: true, status: s }); // safety
  row.status = next;
  await row.save();
  res.json({ ok: true, status: row.status });
});

module.exports = router;
