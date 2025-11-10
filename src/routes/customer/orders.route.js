// services/api/src/routes/customer/orders.route.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// ✅ auth import (CJS/ESM safe)
const { auth: requireAuth } = require('../../../middleware/auth');
if (typeof requireAuth !== 'function') {
  throw new TypeError('Auth middleware must export a function');
}

// Models
const Order = require('../../../models/Order');                 // admin-facing "submitted" orders (pre-warehouse)
const Property = require('../../../models/Property');           // business propertyId (e.g., "EO-1208-RDU")
const WarehouseOrder = require('../../models/WarehouseOrder');  // after approval/packing lives here

/* ---------------- helpers ---------------- */
function getMyId(req) {
  return String(
    req.user?.userId ||
    req.user?._id ||
    req.userId ||
    req.userDoc?._id ||
    req.userDoc?.id ||
    ''
  );
}

// Map incoming line items to Order schema-ish rows
function normalizeItems(items = []) {
  return items.map(it => ({
    skuId: it.sku || it.skuId || it.id || '',
    name: it.name || it.title || 'Item',
    qty: Number(it.qty || 1),
    unitPrice: Number(it.unitPrice ?? it.price ?? 0),
    contract: !!it.contract,
    expected_ship_weight_g: it.expected_ship_weight_g ?? null,
    packed_weight_g: it.packed_weight_g ?? 0,
    tolerance_g: it.tolerance_g ?? null,
    tolerance_pct: it.tolerance_pct ?? null,
  }));
}
// Helper: normalize shapes from Order & WarehouseOrder
function normalizeOrder(doc, kind = 'warehouse') {
  if (!doc) return null;
  const isWH = kind === 'warehouse' || !!doc.meta || doc.status === 'pending_pick';
  return {
    _id: String(doc._id || ''),
    orderId: String(doc.orderId || ''),
    status: String(doc.status || ''),
    createdAt: doc.createdAt || doc.created_at || null,
    items: Array.isArray(doc.items) ? doc.items.map(it => ({
      sku: it.sku || it.skuId || '',
      name: it.name || it.title || 'Item',
      qty: Number(it.qty ?? 1),
      unitPrice: Number(it.unitPrice ?? it.price ?? 0),
    })) : [],
    total: Number(doc.total ?? doc.subtotal ?? 0),
    type: isWH ? 'warehouse' : 'pending',         // FE ke liye clear tag
    meta: doc.meta || {},
  };
}


router.use(requireAuth);

/**
 * POST /api/customer/orders
 * Create an order (customer-submitted; admin will approve → WarehouseOrder).
 *
 * Accepts propertyId as either:
 *  - Mongo _id
 *  - business propertyId (e.g. "EO-1208-RDU")
 *  - property name
 */
router.post('/', async (req, res) => {
  try {
    const myId = getMyId(req);
    if (!myId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const { orderId, propertyId, items = [] } = req.body || {};
    if (!propertyId) return res.status(400).json({ ok: false, error: 'propertyId_required' });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'items_required' });
    }

    // ---------- Resolve the property FIRST (by _id OR business propertyId OR name) ----------
    let propDoc = null;
    if (mongoose.Types.ObjectId.isValid(propertyId)) {
      propDoc = await Property.findById(propertyId).lean();
    }
    if (!propDoc) {
      propDoc = await Property.findOne({
        $or: [{ propertyId }, { name: propertyId }]
      }).lean();
    }
    if (!propDoc) {
      return res.status(400).json({ ok: false, error: 'property_not_found' });
    }

    // ---------- Ownership rule ----------
    // If the property already has an owner, it must be the current user.
    // If it has no owner, auto-link it to the current user.
    if (propDoc.customer) {
      if (String(propDoc.customer) !== myId) {
        return res.status(403).json({ ok: false, error: 'forbidden_property' });
      }
    } else {
      // Auto-claim unowned property (optional; comment out if not desired)
      await Property.updateOne({ _id: propDoc._id }, { $set: { customer: myId } });
    }

    // ---------- Create customer-facing order (pre-warehouse) ----------
    const lineItems = normalizeItems(items);
    const subtotal = lineItems.reduce((s, it) => s + it.qty * it.unitPrice, 0);
    const total = Math.round(subtotal * 100) / 100;

    const doc = await Order.create({
      propertyId: propDoc._id,           // store canonical Mongo _id
      customerId: myId,
      items: lineItems,
      subtotal: total,
      total,
      status: 'submitted',
      type: 'inventory',
      source: 'customer_portal',
      externalOrderId: orderId || undefined,
    });

    return res.status(201).json({ ok: true, order: doc });
  } catch (e) {
    console.error('customer/orders:create', e);
    return res.status(500).json({ ok: false, error: 'failed_to_create_order', detail: e.message });
  }
});

/**
 * GET /api/customer/orders/pending?status=submitted
 * Customer’s own submitted orders (not yet a WarehouseOrder).
 */
router.get('/pending', async (req, res) => {
  try {
    const myId = getMyId(req);
    if (!myId) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const status = String(req.query.status || 'submitted');
    const data = await Order.find({ customerId: myId, status })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ ok: true, orders: data });
  } catch (e) {
    console.error('customer/orders:pending', e);
    res.status(500).json({ ok: false, error: 'failed_to_list_orders' });
  }
});

/**
 * GET /api/customer/orders
 * WarehouseOrders (after approval/packing).
 */
// router.get('/', async (req, res) => {
//   try {
//     const myId = getMyId(req);
//     if (!myId) return res.status(401).json({ ok: false, error: 'unauthorized' });

//     const orders = await WarehouseOrder.find({ customerId: myId })
//       .sort({ createdAt: -1 })
//       .lean();

//     res.json({ ok: true, orders });
//   } catch (e) {
//     console.error('orders:list error', e);
//     res.status(500).json({ ok: false, error: 'failed_to_list_orders' });
//   }
// });
// GET /api/customer/orders  — unified list

router.get('/', async (req, res) => {
  try {
    const myId = getMyId(req);
    if (!myId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const [pendingRaw, whRaw] = await Promise.all([
      Order.find({ customerId: myId }).sort({ createdAt: -1 }).lean(),
      WarehouseOrder.find({ customerId: myId }).sort({ createdAt: -1 }).lean(),
    ]);

    const pending = (pendingRaw || []).map(d => normalizeOrder(d, 'pending'));
    const warehouse = (whRaw || []).map(d => normalizeOrder(d, 'warehouse'));

    // flat list + old shape for compatibility
    const orders = [...pending, ...warehouse].sort((a, b) =>
      new Date(b.createdAt) - new Date(a.createdAt)
    );

    return res.json({ ok: true, orders, pending, warehouse });
  } catch (e) {
    console.error('customer/orders:list', e);
    return res.status(500).json({ ok: false, error: 'failed_to_list_orders' });
  }
});



/**
 * GET /api/customer/orders/all
 * Convenience: return BOTH pending (Order) and warehouse (WarehouseOrder) in one call.
 */
router.get('/all', async (req, res) => {
  try {
    const myId = getMyId(req);
    if (!myId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const [pending, warehouse] = await Promise.all([
      Order.find({ customerId: myId }).sort({ createdAt: -1 }).lean(),
      WarehouseOrder.find({ customerId: myId }).sort({ createdAt: -1 }).lean(),
    ]);

    res.json({ ok: true, pending, warehouse });
  } catch (e) {
    console.error('orders:all error', e);
    res.status(500).json({ ok: false, error: 'failed_to_list_orders' });
  }
});

// // Optional detail
// router.get('/:id', async (req, res) => {
//   const myId = getMyId(req);
//   if (!myId) return res.status(401).json({ ok: false, error: 'unauthorized' });
//   const o = await WarehouseOrder.findOne({ _id: req.params.id, customerId: myId }).lean();
//   if (!o) return res.status(404).json({ error: 'not_found' });
//   res.json({ ok: true, order: o });
// });

// router.get('/:id', async (req, res) => {
//   const myId = getMyId(req);
//   if (!myId) return res.status(401).json({ ok:false, error:'unauthorized' });

//   const o = await WarehouseOrder
//     .findOne({ _id: req.params.id, customerId: myId })
//     .lean();

//   if (!o) return res.status(404).json({ error: 'not_found' });
//   res.json({
//     ok: true,
//     order: {
//       ...o,
//       _paymentId: o?.meta?.paymentId || null,
//       _propertyBizId: o?.meta?.propertyId || null,
//     }
//   });
// });

// GET /api/customer/orders/:id — works for both kinds
router.get('/:id', async (req, res) => {
  try {
    const myId = getMyId(req);
    if (!myId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const { id } = req.params;

    // Try by _id in Warehouse first
    let doc = await WarehouseOrder.findOne({ _id: id, customerId: myId }).lean();
    if (doc) return res.json({ ok: true, order: normalizeOrder(doc, 'warehouse') });

    // Try by orderId in Warehouse
    doc = await WarehouseOrder.findOne({ orderId: id, customerId: myId }).lean();
    if (doc) return res.json({ ok: true, order: normalizeOrder(doc, 'warehouse') });

    // Pending Order by _id
    if (mongoose.Types.ObjectId.isValid(id)) {
      doc = await Order.findOne({ _id: id, customerId: myId }).lean();
      if (doc) return res.json({ ok: true, order: normalizeOrder(doc, 'pending') });
    }

    return res.status(404).json({ ok: false, error: 'not_found' });
  } catch (e) {
    console.error('customer/orders:detail', e);
    return res.status(500).json({ ok: false, error: 'failed_to_get_order' });
  }
});


module.exports = router;
