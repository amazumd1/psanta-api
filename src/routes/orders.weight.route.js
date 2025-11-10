// services/api/src/routes/orders.weight.route.js  (CommonJS)
const { Router } = require('express');
const router = Router();

// ---- add your real handlers here ----
// Example endpoints (placeholders):
router.get('/weight/health', (req, res) => {
  res.json({ ok: true, route: 'orders.weight', msg: 'up' });
});

router.post('/weight/recalc', async (req, res, next) => {
  try {
    // TODO: your recalc logic using WarehouseOrder, etc.
    res.json({ ok: true, ran: 'recalc' });
  } catch (e) { next(e); }
});

// -------------------------------------
module.exports = router;

