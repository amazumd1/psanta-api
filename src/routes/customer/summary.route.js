const express = require("express");
const router = express.Router();
const { auth } = require("../../../middleware/auth");
const WarehouseOrder = require("../../models/WarehouseOrder");
const Job = require("../../models/Job");
const Payment = require("../../models/Payment");
const User = require("../../models/User");

router.use(auth);

function getMyId(req) {
  return String(
    req.user?.userId ||
      req.user?._id ||
      req.userId ||
      req.userDoc?._id ||
      req.userDoc?.id ||
      ""
  );
}

function requireTenant(req, res) {
  if (!req.tenantId) {
    res.status(400).json({ success: false, message: "tenantId missing" });
    return false;
  }
  return true;
}

// GET /api/customer/summary?orderId=...
router.get("/", async (req, res, next) => {
  try {
    if (!requireTenant(req, res)) return;

    const userId = getMyId(req);
    const { orderId } = req.query;

    const [order, jobs, payments, profile] = await Promise.all([
      orderId
        ? WarehouseOrder.findOne({ orderId, customerId: userId }).lean()
        : null,
      Job.find({ tenantId: req.tenantId, customerId: userId })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
      Payment.find({ tenantId: req.tenantId, userId: String(userId) })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
      User.findById(userId).lean(),
    ]);

    const profileComplete = Boolean(
      profile &&
        profile.fullName &&
        profile.phone &&
        profile.address &&
        profile.city &&
        profile.state &&
        profile.postalCode
    );

    res.json({
      success: true,
      profile: profile ? { ...profile, profileComplete } : null,
      order: order || null,
      jobs,
      payments,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;