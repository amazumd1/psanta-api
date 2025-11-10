// services/api/routes/host.onboarding.js
const express = require("express");
const router = express.Router();

const Property = require("../models/Property");
const Order = require("../models/Order");
const Approval = require("../models/Approval");
const CleaningOffer = require("../models/CleaningOffer");

// NOTE: file is ../utils/weight from routes/
const { fillExpectedOnOrder } = require("../utils/weight");

// Per-SKU weights lookup
// Make sure you have services/api/models/Sku.js with fields: skuId (String), gross_weight_g (Number)
const Sku = require("../models/Sku");

// Server-trusted catalog (price & names)
const SKU = {
  shampoo:            { skuId: "SH-REFILL", name: "Shampoo (refill)",       price: 4.5 },
  conditioner:        { skuId: "CD-REFILL", name: "Conditioner (refill)",    price: 4.5 },
  body_wash:          { skuId: "BW-BOTTLE", name: "Body wash",               price: 4.0 },
  hand_soap:          { skuId: "HS-BOTTLE", name: "Hand soap",               price: 3.0 },
  dish_soap:          { skuId: "DS-BOTTLE", name: "Dish soap",               price: 3.5 },
  toilet_paper:       { skuId: "TP-ROLL",   name: "Toilet paper",            price: 0.6 },
  paper_towels:       { skuId: "PT-ROLL",   name: "Paper towels",            price: 1.2 },
  trash_liners:       { skuId: "TL-PACK",   name: "Trash liners",            price: 2.8 },
  laundry_detergent:  { skuId: "LD-BOTTLE", name: "Laundry detergent",       price: 6.0 },
  coffee_pods:        { skuId: "CP-BOX12",  name: "Coffee pods (12)",        price: 6.5 },
  tea_bags:           { skuId: "TB-BOX25",  name: "Tea bags (25)",           price: 3.2 },
  tv:                 { skuId: "TV-43",     name: "Smart TV",                price: 15 },
  microwave:          { skuId: "MW-STD",    name: "Microwave",               price: 8 },
  vacuum:             { skuId: "VC-STD",    name: "Vacuum cleaner",          price: 12 },
  washing_machine:    { skuId: "WM-STD",    name: "Washing machine",         price: 30 },
  iron:               { skuId: "IR-SET",    name: "Iron + board",            price: 4 },
  spoon_set:          { skuId: "SP-SET6",   name: "Spoon set (6)",           price: 3 },
  cutlery_set:        { skuId: "CT-SET24",  name: "Cutlery set (24)",        price: 6 },
  dinnerware:         { skuId: "DW-SET4",   name: "Dinnerware (4)",          price: 7 },
  bedsheets:          { skuId: "BS-SET",    name: "Bedsheet set",            price: 5 },
  towels:             { skuId: "TW-SET4",   name: "Bath towel set (4)",      price: 6 },
};

// POST /api/host/onboarding/submit
router.post("/onboarding/submit", async (req, res, next) => {
  try {
    const {
      property,
      cleaningOffer,
      inventoryPlan: planBody,
      inventoryChoice: choiceBody,
      inventory: legacyInv, // { choice, plan }
    } = req.body || {};

    if (!property) {
      return res.status(400).json({ ok: false, error: "Invalid payload: property missing" });
    }

    const inventoryPlan   = planBody || legacyInv?.plan || null;
    const inventoryChoice = choiceBody || legacyInv?.choice || "none";

    // 1) Upsert Property
    const key = property.externalRef
      ? { externalRef: property.externalRef }
      : { address: property.address, zip: property.zip };

    const toNumber = (x) => (x === undefined || x === null || x === "" ? 0 : Number(x));
    const normalized = {
      propertyId: property?.propertyId || property?.externalRef || undefined,
      name: property?.name || (property?.address ? property.address.split(",")[0] : "Short-term rental"),
      address: property?.address || "",
      city: property?.city || "",
      state: property?.state || "",
      zip: property?.zip || "",
      type: property?.type || "house",
      squareFootage: toNumber(property?.squareFootage ?? property?.sqft),
      cycle: property?.cycle || "short-stay",
      isActive: property?.isActive !== undefined ? property.isActive : true,
      externalRef: property?.externalRef || "",
    };

    let prop = await Property.findOne(key);
    if (!prop) prop = await Property.create(normalized);
    else {
      Object.assign(prop, normalized);
      await prop.save();
    }

    // 2) Cleaning Offer (optional)
    if (cleaningOffer) {
      const existing = await CleaningOffer.findOne({ propertyId: prop._id });
      const payload = {
        propertyId: prop._id,
        minutes: Number(cleaningOffer.minutes || 0),
        hourly: Number(cleaningOffer.hourly || 0),
        total: Number(cleaningOffer.total || 0),
        locked: !!cleaningOffer.locked,
        schedule: Array.isArray(cleaningOffer.schedule) ? cleaningOffer.schedule : [],
        status: cleaningOffer.locked ? "active" : "draft",
      };
      if (existing) {
        Object.assign(existing, payload);
        await existing.save();
      } else {
        await CleaningOffer.create(payload);
      }
    }

    // 3) Inventory → normalize + expected weight
    const SKU_BY_ID  = SKU;
    const SKU_BY_SKU = Object.fromEntries(Object.values(SKU).map((x) => [x.skuId, x]));
    const rawItems   = Array.isArray(inventoryPlan?.items) ? inventoryPlan.items : [];

    const mapped = rawItems.map((it) => {
      const qty     = Math.max(0, Number(it?.qty || 0));
      const keyId   = it?.id || it?.skuId || "";
      const meta    = SKU_BY_ID[keyId] || SKU_BY_SKU[keyId];
      const price   = meta ? Number(meta.price) : 0;
      const skuId   = meta?.skuId || keyId;
      const name    = meta?.name || it?.name || keyId;
      return { skuId, name, qty, unitPrice: price, contract: !!it?.contract };
    });

    const itemsWithQty = mapped.filter((x) => x.qty > 0);
    if (itemsWithQty.length === 0) {
      return res.json({ ok: true, propertyId: prop._id, orderId: null, note: "No inventory selected — order skipped." });
    }

    // 3.1 Expected weight (from Sku model)
    const skuDocs = await Sku.find({ skuId: { $in: itemsWithQty.map((i) => i.skuId) } }).lean();
    const weightBySku = new Map(skuDocs.map((d) => [d.skuId, Number(d.gross_weight_g || 0)]));

    const weightedItems = itemsWithQty.map((x) => {
      const perUnitG = weightBySku.get(x.skuId) || 0;
      const expected = Math.round(perUnitG * x.qty);
      return { ...x, expected_ship_weight_g: expected };
    });

    // 3.2 price subtotals
    const items = weightedItems
      .map((x) => ({ ...x, subtotal: Math.round(x.qty * x.unitPrice * 100) / 100 }))
      .filter((x) => x.subtotal > 0);

    const subtotal = Math.round(items.reduce((s, x) => s + x.subtotal, 0) * 100) / 100;
    if (subtotal <= 0) {
      return res.json({ ok: true, propertyId: prop._id, orderId: null, note: "No billable items — order skipped." });
    }

    // 3.3 Ensure any missing expected/tolerance set (fallback logic from utils/weight)
    const tmpOrder = { items: items.map(({ subtotal, ...rest }) => rest) };
    fillExpectedOnOrder(tmpOrder);

    // 4) Create order + approval
    const order = await Order.create({
      propertyId: prop._id,
      items: tmpOrder.items,
      subtotal,
      total: subtotal,
      status: "submitted",
      type: "inventory",
      source: "host_custom",
      meta: { supply_days: Number(req?.body?.inventoryPlan?.supply_days || 0) },
    });

    const approval = await Approval.create({
      entity: "order",
      entityId: order._id,
      status: "pending",
    });

    return res.json({
      ok: true,
      propertyId: prop._id,
      orderId: order._id,
      approvalId: approval._id,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
