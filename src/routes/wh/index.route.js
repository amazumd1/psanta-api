const express = require("express");
const router = express.Router();
const items = require("./items.route");
const core = require("./ops.route");
const master = require("./master.route");
const orders = require("./warehouse.orders");   // <— ADD THIS
const { auth } = require('../../../middleware/auth');       // add
const { requireRole } = require('../../../middleware/roles'); // add

router.use(auth, requireRole(['admin','warehouse']));

router.use(express.json());
router.use("/items", items);
router.use("/", master);      // warehouses, locations
router.use("/", core);        // receive, putaway, transfer, stock
router.use("/", orders);      // <— ADD THIS (exposes /api/wh/orders/*)
router.use('/prop', require('../prop/stock.route'));
router.use('/', require('./pack.route'));
router.use('/', require('./jobs.route'));
router.use('/topup', require('./topup.route'));

module.exports = router;


