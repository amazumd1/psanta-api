const express = require('express');
const router = express.Router();
const { auth } = require('../../../middleware/auth');
const WarehouseOrder = require('../../models/WarehouseOrder');
const Job = require('../../models/Job');
const Payment = require('../../models/Payment');
const User = require('../../models/User');


router.use(auth);


// GET /api/customer/summary?orderId=...
router.get('/', async (req, res, next) => {
    try {
        const userId = req.user?.userId || req.user?._id;
        const { orderId } = req.query;


        const [order, jobs, payments, profile] = await Promise.all([
            orderId ? WarehouseOrder.findOne({ orderId, customerId: userId }).lean() : null,
            Job.find({ customerId: userId }).sort({ createdAt: -1 }).limit(10).lean(),
            Payment.find({ userId: String(userId) }).sort({ createdAt: -1 }).limit(10).lean(),
            User.findById(userId).lean(),
        ]);


        const profileComplete = Boolean(
            profile && profile.fullName && profile.phone && profile.address && profile.city && profile.state && profile.postalCode
        );


        res.json({
            success: true,
            profile: profile ? { ...profile, profileComplete } : null,
            order,
            jobs,
            payments,
        });
    } catch (err) {
        next(err);
    }
});


module.exports = router;