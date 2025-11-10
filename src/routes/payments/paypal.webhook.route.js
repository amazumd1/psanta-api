// services/api/src/routes/payments/paypal.webhook.route.js
const express = require('express');
const router = express.Router();
const bodyParser = require('body-parser');
const Subscription = require('../../models/Subscription');

router.use(bodyParser.json({ type: '*/*' })); // add signature verification later

router.post('/', async (req, res) => {
  try {
    const ev = req.body || {};
    const type = ev?.event_type || ev?.eventType;

    if (type === 'BILLING.SUBSCRIPTION.ACTIVATED') {
      const subId = ev?.resource?.id;
      await Subscription.updateOne({ providerSubscriptionId: subId }, { $set: { status: 'active' } });
    }
    if (type === 'BILLING.SUBSCRIPTION.CANCELLED') {
      const subId = ev?.resource?.id;
      await Subscription.updateOne({ providerSubscriptionId: subId }, { $set: { status: 'canceled' } });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('paypal webhook error', e);
    res.json({ ok: true }); // dev: avoid retries storm
  }
});

module.exports = router;
