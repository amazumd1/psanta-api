const express = require('express');
const router = express.Router();
// TODO: replace with your actual subscription line model
const Alert = require('../models/Alert');

router.post('/apply-reco', async (req, res, next) => {
  try {
    const { alertId, subscriptionLineId } = req.body;
    // TODO: lookup alert.recommendation.suggestedNextCyclePackGrams and set it into subscription line
    // await SubscriptionLine.findByIdAndUpdate(subscriptionLineId, { $set: { nextPackRecommendationGrams: grams } });
    await Alert.findByIdAndUpdate(alertId, { $set: { status: 'applied', 'links.subscriptionLineId': subscriptionLineId } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
