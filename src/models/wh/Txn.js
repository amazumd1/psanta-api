const { Schema, model, Types } = require("mongoose");

const txnSchema = new Schema({
  ts:   { type: Date, default: () => new Date(), index: true },
  type: { type: String, enum: ["RECEIPT","MOVE","ADJUST"], required: true, index: true },
  warehouseId: { type: Types.ObjectId, ref: "Warehouse", required: true, index: true },
  itemId:      { type: Types.ObjectId, ref: "WhItem", required: true, index: true },
  sku:         { type: String, required: true, index: true },
  qty:         { type: Number, required: true },       // positive; move uses from/to below
  fromLocId:   { type: Types.ObjectId, ref: "WhLocation" },
  toLocId:     { type: Types.ObjectId, ref: "WhLocation" },
  lot:         { type: String, default: "" },
  expiry:      { type: Date },
  refType:     { type: String },                       // e.g. "RECEIVE_DOC"
  refId:       { type: String },                       // client-side ID/UUID
  userId:      { type: String }                        // optional
}, { timestamps: true });

module.exports = model("WhTxn", txnSchema);
