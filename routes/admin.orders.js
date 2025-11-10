// services/api/routes/admin.orders.js
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const { fillExpectedOnOrder } = require('../utils/weight');

const Order = require("../models/Order");
const Approval = require("../models/Approval");
const WarehouseOrder = require("../src/models/WarehouseOrder");

// List orders for Admin table
router.get("/orders", async (req, res) => {
  try {
    const status = String(req.query.status || "submitted");
    const data = await Order.find({ status }).sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ ok: true, data });
  } catch (e) {
    console.error("Admin list orders error:", e);
    return res.status(200).json({ ok: false, error: e.message });
  }
});

// Approve (idempotent + never 500 on side-effects)
router.patch("/orders/:id/approve", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, error: "Invalid order id" });
    }

    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ ok: false, error: "Order not found" });

    const prevStatus = order.status;

    // Already processed → soft success
    if (["approved", "to_warehouse", "completed"].includes(prevStatus)) {
      return res.json({ ok: true, data: { orderId: order._id, prevStatus, newStatus: order.status, idempotent: true } });
    }

    // Only allow from submitted
    if (prevStatus !== "submitted") {
      return res.json({ ok: true, data: { orderId: order._id, prevStatus, newStatus: order.status, noChange: true } });
    }

    // 1) approve
    order.status = "approved";
    order.approvedAt = new Date();
    await order.save();

    // 2) approval doc
    await Approval.findOneAndUpdate(
      { entity: "order", entityId: order._id },
      { $set: { status: "approved" } },
      { upsert: true }
    );

    // 3) ensure WarehouseOrder exists (guard duplicates)
    const warnings = [];
    try {
      const exists = await WarehouseOrder.findOne({ orderId: order._id }).lean();
      if (!exists) {
        const whItems = (order.items || []).map(it => ({
          skuId: it.sku || it.skuId || it.id || '',
          name: it.name || it.title || 'Item',
          qty: Number(it.qty || 1),
          unitPrice: Number(it.unitPrice ?? it.price ?? 0),
          expected_ship_weight_g: it.expected_ship_weight_g ?? null,
          packed_weight_g: null,
          tolerance_g: it.tolerance_g ?? null,
          tolerance_pct: it.tolerance_pct ?? null,
        }));
        await WarehouseOrder.create({
          orderId: order._id.toString(),
          customerId: order.customerId,
          items: whItems,
          meta: { propertyId: order.propertyId },
          status: 'pending_pick',
        });
      }
    } catch (e) {
      // duplicate key / model issues should not break approve
      warnings.push(`Warehouse enqueue failed: ${e.message}`);
      console.warn("Warehouse enqueue failed:", e);
    }

    // 4) move to to_warehouse regardless
    order.status = "to_warehouse";
    order.toWarehouseAt = new Date();
    fillExpectedOnOrder(order);
    await order.save();

    return res.json({ ok: true, data: { orderId: order._id, prevStatus, newStatus: order.status }, warnings });
  } catch (e) {
    console.error("Admin approve error:", e);
    // 200 with ok:false so frontend me red 500 na aaye
    return res.status(200).json({ ok: false, error: e.message });
  }
});

// Reject
router.patch("/orders/:id/reject", async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, error: "Invalid order id" });
    }

    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ ok: false, error: "Order not found" });

    const prevStatus = order.status;
    if (prevStatus !== "submitted") {
      return res.json({ ok: true, data: { orderId: order._id, prevStatus, newStatus: order.status, noChange: true } });
    }

    order.status = "rejected";
    order.rejectedAt = new Date();
    await order.save();

    await Approval.findOneAndUpdate(
      { entity: "order", entityId: order._id },
      { $set: { status: "rejected", note: note || "" } },
      { upsert: true }
    );

    return res.json({ ok: true, data: { orderId: order._id, prevStatus, newStatus: order.status } });
  } catch (e) {
    console.error("Admin reject error:", e);
    return res.status(200).json({ ok: false, error: e.message });
  }
});

module.exports = router;
