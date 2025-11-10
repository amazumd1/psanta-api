// const mongoose = require("mongoose");
// const { Schema } = mongoose;


// const WarehouseOrderSchema = new Schema({
//   orderId: { type: Schema.Types.ObjectId, ref: "Order" },
//   status: { type: String, enum: ["pending_pick","picking","ready","shipped","stocked","closed"], default: "pending_pick" },
//   assignedTo: { type: String, default: "" },
//   hold: {
//     isHeld: { type: Boolean, default: false },
//     reason: { type: String, default: "" },
//     at: { type: Date }
//   },
//   allocated: { type: Boolean, default: false },
//   allocatedAt: { type: Date }
// }, { timestamps: true });

// WarehouseOrderSchema.index({ status: 1, createdAt: -1 });
// WarehouseOrderSchema.index({ orderId: 1 });


// module.exports =
//   mongoose.models.WarehouseOrder ||
//   mongoose.model("WarehouseOrder", WarehouseOrderSchema);
  