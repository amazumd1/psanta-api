// services/api/routes/pricing.routes.js
const router = require('express').Router();
const c = require('../controllers/pricing.controller');

router.get('/config', c.getConfig);
router.put('/config', c.replaceConfig);

router.post('/state', c.addState);
router.delete('/state/:code', c.deleteState);
router.patch('/state/:code', c.updateStatePatch);

router.post('/quote', c.quote);

module.exports = router;
