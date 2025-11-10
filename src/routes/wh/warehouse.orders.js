const router = require("express").Router();
const mongoose = require("mongoose"); 
const WarehouseOrder = require('../../models/WarehouseOrder');  // from src/routes/wh/*
const Event = require('../../models/Event');


let Order;
try { Order = require("../../../models/Order"); } catch (e) {
  console.warn("Order model not loaded:", e.message);
  Order = null;
}

// Allowed statuses (UI aur DB dono yahi use karein)
const WH_ALLOWED = ["pending_pick", "picking", "ready", "shipped", "stocked", "closed"];

// Forward-only transitions
const WH_NEXT = {
  pending_pick: ["picking"],
  picking: ["ready"],
  ready: ["shipped"],
  shipped: ["stocked", "closed"],   // shipped ke baad stock reconcile ya close
  stocked: ["closed"],
  closed: []
};

// Single source of truth
const FLOW = ["pending_pick", "picking", "ready", "shipped", "stocked", "closed"];
const ALLOWED = new Set(FLOW);


// -------- List WOs --------
router.get("/orders", async (req, res) => {
  try {
    const q = {};
    if (req.query.status) q.status = req.query.status;
    const rows = await WarehouseOrder.find(q).sort({ createdAt: -1 }).lean();
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------- Full detail (wo + linked order) --------
router.get("/orders/:id/full", async (req, res) => {
  try {
    const wo = await WarehouseOrder.findById(req.params.id).lean();
    if (!wo) return res.status(404).json({ ok: false, error: "Not found" });

    let order = null;

    if (Order && wo.orderId) {
      const oid = String(wo.orderId);

      // Try several ways: _id, orderId, id
      const queries = [];
      if (mongoose.isValidObjectId(oid)) queries.push({ _id: oid });
      queries.push({ orderId: oid });
      queries.push({ id: oid });

      for (const q of queries) {
        order = await Order.findOne(q).lean().catch(() => null);
        if (order) break;
      }
    }

    // Normalize items so UI always gets "items"
    let items = [];
    if (order) {
      if (Array.isArray(order.items)) items = order.items;
      else if (Array.isArray(order.lineItems)) items = order.lineItems;
      else if (Array.isArray(order.products)) {
        items = order.products.map(p => ({
          skuId: p.skuId || p.sku || p.code,
          name: p.name,
          qty: p.qty || p.quantity || 1,
          unitPrice: p.unitPrice || p.price || 0,
        }));
      }
    }

    if (!order) order = { orderId: wo.orderId, items: [] };
    else order.items = items;

    return res.json({ ok: true, warehouseOrder: wo, order });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});




// -------- Update status (forward-only) --------

router.patch("/orders/:id/status", async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!ALLOWED.has(status)) {
      return res.status(400).json({ ok: false, error: "Invalid status" });
    }

    const wo = await WarehouseOrder.findById(req.params.id);
    if (!wo) return res.status(404).json({ ok: false, error: "Not found" });

    const allowedNext = WH_NEXT[wo.status] || [];
    // same status allowed? (optional)
    if (wo.status !== status && !allowedNext.includes(status)) {
      return res.status(400).json({ ok: false, error: `Bad transition: ${wo.status} → ${status}` });
    }

    wo.status = status;
    wo.updatedAt = new Date();
    await wo.save();
     await Event.create({ type: 'wh_fulfilled', payload: { orderId: String(wo._id), items: wo.items }, createdAt: new Date() });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


// -------- Allocate / Unallocate (stub) --------

router.post("/orders/:id/allocate", async (req, res) => {
  try {
    const { id } = req.params;
    const wo = await WarehouseOrder.findById(id);
    if (!wo) return res.status(404).json({ ok: false, error: "Not found" });

    if (wo.status !== "pending_pick") {
      return res.status(400).json({ ok: false, error: `Can allocate only from pending_pick (current: ${wo.status})` });
    }

    // TODO: yahan inventory reservation logic add kar sakte ho
    wo.status = "picking";
    wo.allocatedAt = new Date();
    await wo.save();

    return res.json({ ok: true, data: wo });
  } catch (e) {
    console.error("allocate error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/orders/:id/unallocate", async (req, res) => {
  try {
    const wo = await WarehouseOrder.findById(req.params.id);
    if (!wo) return res.status(404).json({ ok: false, error: "Not found" });
    wo.allocated = false;
    wo.allocatedAt = null;
    await wo.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------- Assign picker --------
router.post("/orders/:id/assign", async (req, res) => {
  try {
    const { assignee } = req.body || {};
    if (!assignee) return res.status(400).json({ ok: false, error: "assignee required" });
    const wo = await WarehouseOrder.findById(req.params.id);
    if (!wo) return res.status(404).json({ ok: false, error: "Not found" });
    wo.assignedTo = String(assignee);
    await wo.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------- Hold / Unhold --------
router.post("/orders/:id/hold", async (req, res) => {
  try {
    const { reason } = req.body || {};
    const wo = await WarehouseOrder.findById(req.params.id);
    if (!wo) return res.status(404).json({ ok: false, error: "Not found" });
    wo.hold = { isHeld: true, reason: reason || "", at: new Date() };
    await wo.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
router.post("/orders/:id/unhold", async (req, res) => {
  try {
    const wo = await WarehouseOrder.findById(req.params.id);
    if (!wo) return res.status(404).json({ ok: false, error: "Not found" });
    wo.hold = { isHeld: false };
    await wo.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------- Print (stub) --------

router.post("/orders/:id/print", async (req, res) => {
  try {
    const { id } = req.params;
    const { type = "picklist" } = req.body || {};
    const wo = await WarehouseOrder.findById(id);
    if (!wo) return res.status(404).json({ ok: false, error: "Not found" });

    // TODO: yahan apni print queue/service ko call karo (picklist, packlist, labels, etc.)
    // await printService.queue({ type, orderId: wo.orderId, warehouseOrderId: wo._id });

    return res.json({ ok: true, queued: type });
  } catch (e) {
    console.error("print error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});


// ===== DEV / DEBUG ROUTES (use only in dev) =====
const mg = require("mongoose");

// Quick status
router.get("/dev/debug", async (req, res) => {
  try {
    const dbName = mg.connection?.db?.databaseName || "(unknown)";
    const woCount = await WarehouseOrder.countDocuments();
    const orderCount = Order ? await Order.countDocuments() : null;
    const latestWO = await WarehouseOrder.find().sort({ createdAt: -1 }).limit(3).lean();
    res.json({ ok: true, db: dbName, counts: { WarehouseOrder: woCount, Order: orderCount }, latestWO });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Seed 1 sample Sales Order + linked Warehouse Order (pending_pick)
router.post("/dev/seed", async (req, res) => {
  try {
    if (!Order) return res.status(400).json({ ok: false, error: "Order model not available" });

    const so = await Order.create({
      items: [
        { skuId: "SKU-RED",  name: "Red Shirt",  qty: 2, unitPrice: 10 },
        { skuId: "SKU-BLUE", name: "Blue Shirt", qty: 1, unitPrice: 15 },
      ],
      total: 35
    });

    const wo = await WarehouseOrder.create({
      orderId: so._id,          // IMPORTANT: link by _id
      status: "pending_pick"
    });

    res.json({ ok: true, warehouseOrderId: wo._id, orderId: so._id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Sirf WarehouseOrder seed (agar Order model missing ho)
router.post("/dev/seed-wo", async (req, res) => {
  try {
    const wo = await WarehouseOrder.create({
      orderId: `SO-${Date.now()}`,
      status: "pending_pick"
    });
    res.json({ ok: true, warehouseOrderId: wo._id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


module.exports = router;
