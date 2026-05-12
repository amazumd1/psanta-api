// services/api/routes/pricing.routes.js
const router = require('express').Router();
const c = require('../controllers/pricing.controller');

router.get('/config', c.getConfig);
router.put('/config', c.replaceConfig);

router.post('/state', c.addState);
router.delete('/state/:code', c.deleteState);
router.patch('/state/:code', c.updateStatePatch);

router.get('/market-rates', c.listMarketRates);
router.put('/market-rates', c.upsertMarketRate);
router.post('/market-rates/suggest', c.suggestMarketRate);
router.post('/market-rates/suggest-batch', c.suggestMarketRatesBatch);

router.post('/quote', c.quote);

module.exports = router;
