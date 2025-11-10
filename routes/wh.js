const router = require('express').Router();
const ctrl = require('../controllers/warehouseController');

router.get('/health', (req,res)=>res.json({ok:true}));
router.post('/orders', ctrl.createOrder);
router.get('/orders', ctrl.listOrders);

router.get('/warehouses', ctrl.list);
router.post('/warehouses', ctrl.create);
router.get('/warehouses/:id', ctrl.get);
router.put('/warehouses/:id', ctrl.update);
router.delete('/warehouses/:id', ctrl.remove);

module.exports = router;


// routes/wh.js
router.get('/warehouses', async (req, res) => {
  try {
    const Warehouse = require('../models/Warehouse');
    const rows = await Warehouse.find({}).lean();
    res.json({ success: true, data: rows }); // << array in data
  } catch (e) {
    res.status(500).json({ success: false, message: e.message, data: [] });
  }
});
