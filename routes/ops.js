// services/api/routes/ops.js
const { Router } = require("express");
const Task = require("../models/Task");
const WarehouseOrder = require("../src/models/WarehouseOrder");

const router = Router();

router.get("/ops/overview", async (_req, res) => {
  const [pending, inProg, done] = await Promise.all([
    Task.countDocuments({ status: "pending" }),
    Task.countDocuments({ status: "in-progress" }),
    Task.countDocuments({ status: "completed" }),
  ]);

  const [pendingPick, picking, picked, ready, shipped, cancelled] = await Promise.all([
    WarehouseOrder.countDocuments({ status: "pending_pick" }),
    WarehouseOrder.countDocuments({ status: "picking" }),
    WarehouseOrder.countDocuments({ status: "picked" }),
    WarehouseOrder.countDocuments({ status: "ready" }),
    WarehouseOrder.countDocuments({ status: "shipped" }),
    WarehouseOrder.countDocuments({ status: "cancelled" }),
  ]);

  res.json({
    ok: true,
    tasks: { pending, inProg, done },
    warehouse: { pendingPick, picking, picked, ready, shipped, cancelled },
  });
});

module.exports = router;
