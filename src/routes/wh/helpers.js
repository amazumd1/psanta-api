const Item = require("../../models/wh/Item");
const Warehouse = require("../../models/wh/Warehouse");
const Location = require("../../models/wh/Location");
const Balance = require("../../models/wh/Balance");
const Txn = require("../../models/wh/Txn");

async function getOrCreateItemBySku(sku, name = "") {
  sku = String(sku).trim();
  if (!sku) throw Object.assign(new Error("sku_required"), { status: 400 });
  const existing = await Item.findOne({ sku });
  if (existing) return existing;
  return Item.create({ sku, name: name || sku });
}

async function findWarehouseByIdOrCode(idOrCode) {
  if (!idOrCode) throw Object.assign(new Error("warehouse_required"), { status: 400 });
  return idOrCode.match(/^[0-9a-f]{24}$/i)
    ? Warehouse.findById(idOrCode)
    : Warehouse.findOne({ code: idOrCode });
}

async function getOrCreateStageLoc(warehouseId) {
  let loc = await Location.findOne({ warehouseId, code: "STAGE" });
  if (!loc) loc = await Location.create({ warehouseId, code: "STAGE", type: "STAGE" });
  return loc;
}

async function getLocByCode(warehouseId, code) {
  const loc = await Location.findOne({ warehouseId, code });
  if (!loc) throw Object.assign(new Error("location_not_found"), { status: 404 });
  if (loc.blocked) throw Object.assign(new Error("location_blocked"), { status: 400 });
  return loc;
}

// Apply +/- qty on Balance doc
async function incBalance({ warehouseId, locationId, itemId, sku, lot, expiry, qty }) {
  const key = { warehouseId, locationId, itemId, sku, lot: lot || "", expiry: expiry || null };
  const doc = await Balance.findOneAndUpdate(
    key,
    { $inc: { qty } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (doc.qty < 0) {
    // rollback increment to keep non-negative invariant
    await Balance.updateOne(key, { $inc: { qty: -qty } });
    throw Object.assign(new Error("insufficient_stock"), { status: 400 });
  }
  return doc;
}

async function postTxn({ type, warehouse, item, qty, fromLoc, toLoc, lot, expiry, ref }) {
  const payload = {
    type, warehouseId: warehouse._id, itemId: item._id, sku: item.sku, qty,
    fromLocId: fromLoc?._id, toLocId: toLoc?._id, lot: lot || "", expiry: expiry || null,
    refType: ref?.type, refId: ref?.id, userId: ref?.userId
  };
  const t = await Txn.create(payload);

  // Balance updates
  if (fromLoc) await incBalance({
    warehouseId: warehouse._id, locationId: fromLoc._id,
    itemId: item._id, sku: item.sku, lot, expiry, qty: -Math.abs(qty)
  });
  if (toLoc) await incBalance({
    warehouseId: warehouse._id, locationId: toLoc._id,
    itemId: item._id, sku: item.sku, lot, expiry, qty: Math.abs(qty)
  });

  return t;
}

module.exports = {
  Item, Warehouse, Location, Balance, Txn,
  getOrCreateItemBySku, findWarehouseByIdOrCode, getOrCreateStageLoc, getLocByCode, postTxn
};
