// const express = require("express");
// const router = express.Router();
// const WarehouseOrder = require("../src/models/WarehouseOrder");
// const Order = require("../models/Order");

// // List warehouse orders
// router.get("/orders", async (req, res, next) => {
//   try {
//     const status = req.query.status || "pending_pick";
//     const data = await WarehouseOrder.find({ status }).sort({ createdAt: -1 }).limit(200);
//     res.json({ ok: true, data });
//   } catch (e) { next(e); }
// });

// // Update warehouse order status (picked/packed/shipped/stocked)
// router.patch("/orders/:id/status", async (req, res, next) => {
//   try {
//     const { id } = req.params;
//     const { status } = req.body || {};
//     const allowed = ["pending_pick","picked","packed","shipped","stocked","closed"];
//     if (!allowed.includes(status)) return res.status(400).json({ ok: false, error: "Bad status" });

//     const wo = await WarehouseOrder.findById(id);
//     if (!wo) return res.status(404).json({ ok: false, error: "Not found" });
//     wo.status = status;
//     await wo.save();
//     res.json({ ok: true, id: wo._id, status: wo.status });
//   } catch (e) { next(e); }
// });

// module.exports = router;


// // (add at top)

// // Get full order (with items) for a warehouseOrderId
// router.get("/orders/:id/full", async (req, res, next) => {
//   try {
//     const { id } = req.params;
//     const wo = await WarehouseOrder.findById(id);
//     if (!wo) return res.status(404).json({ ok: false, error: "Warehouse order not found" });
//     const order = await Order.findById(wo.orderId);
//     if (!order) return res.status(404).json({ ok: false, error: "Order not found" });
//     res.json({ ok: true, warehouseOrder: wo, order });
//   } catch (e) { next(e); }
// });
