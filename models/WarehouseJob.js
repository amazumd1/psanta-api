// services/api/models/WarehouseJob.js
const mongoose = require('mongoose');

const LineSchema = new mongoose.Schema({
  skuId: String,
  name: String,
  qty: Number,

  // expected vs actual per line
  expected_ship_weight_g: { type: Number, default: 0 },
  packed_weight_g: { type: Number, default: 0 },

  // optional per-line tolerance overrides
  tolerance_g: { type: Number, default: 10 },
  tolerance_pct: { type: Number, default: 0.02 },

  // traceability (optional)
  lot: String,
  expiry: Date
}, { _id: false });

const PackEventSchema = new mongoose.Schema({
  ts: { type: Date, default: Date.now },

  // raw capture
  gross_carton_weight_g: Number,  // gross at time of capture
  carton_tare_g: Number,          // tare used in that capture
  net_carton_weight_g: Number,    // derived (gross - tare)

  // expectation & decision
  expected_carton_weight_g: Number,
  variance_g: Number,             // net - expected
  pass: Boolean,

  // who/what
  captured_by: String,            // userId/email
  source: { type: String, enum: ['manual','scale'], default: 'manual' },
  scale_serial: String,
  firmware_ver: String,
  note: String
}, { _id: false });

const JobSchema = new mongoose.Schema({
  // identity
  jobId: { type: String, unique: true, index: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true },

  // status (optional workflow)
  status: { type: String, index: true },

  // order lines snapshot
  lines: [LineSchema],

  // ---- Carton-level expectations & capture ----
  expected_carton_weight_g: { type: Number, default: 0 }, // expected NET carton
  carton_tare_g:           { type: Number, default: 0 },

  // actual capture (new fields used by routes)
  packed_gross_g:          { type: Number, default: 0 },  // last gross captured
  packed_net_g:            { type: Number, default: 0 },  // last net captured (gross - tare)
  variance_g:              { type: Number, default: 0 },  // last net - expected
  pass:                    { type: Boolean, default: null },
  packed_at:               { type: Date },

  // legacy aliases (kept for compatibility with any old code/UI)
  gross_carton_weight_g:   { type: Number, default: 0 },
  net_carton_weight_g:     { type: Number, default: 0 },
  variance_carton_g:       { type: Number, default: 0 },
  pass_fail_carton:        { type: Boolean, default: false },

  // ---- Tolerance (both names supported) ----
  tolerance_g:  { type: Number, default: 50 },    // abs grams
  tolerance_pct:{ type: Number, default: 0.015 }, // 1.5%
  // alt names some parts might read:
  tol_abs_g:    { type: Number, default: 50 },
  tol_pct:      { type: Number, default: 0.015 },

  // labels & traceability
  sscc:            { type: String, index: true },
  cartonCode:      String,
  label_zpl_hash:  String,
  pack_session_id: String,
  scale_capture_raw: String,

  // close-out / ops
  closed: { type: Boolean, default: false, index: true },
  stockout: { type: Boolean, default: false },
  topups_sent: { type: Number, default: 0 },
  notes: String,
  closedAt: Date,

  // audit trail
  pack_events: [PackEventSchema],
}, { timestamps: true });

// keep legacy <-> new in sync on save (optional safety)
JobSchema.pre('save', function(next) {
  // mirror to legacy fields for any old reader
  this.gross_carton_weight_g = this.packed_gross_g || this.gross_carton_weight_g || 0;
  this.net_carton_weight_g   = this.packed_net_g   || this.net_carton_weight_g   || 0;
  this.variance_carton_g     = (typeof this.variance_g === 'number') ? this.variance_g : this.variance_carton_g || 0;
  if (typeof this.pass === 'boolean') this.pass_fail_carton = this.pass;

  // ensure primary tolerance also filled from alt names
  if (typeof this.tolerance_g !== 'number')  this.tolerance_g  = this.tol_abs_g;
  if (typeof this.tolerance_pct !== 'number') this.tolerance_pct = this.tol_pct;

  next();
});

module.exports = mongoose.model('WarehouseJob', JobSchema);
