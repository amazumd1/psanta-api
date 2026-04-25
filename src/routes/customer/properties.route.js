// services/api/src/routes/customer/properties.route.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { auth: requireAuth } = require("../../../middleware/auth");
const Property = require("../../models/Property");

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

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    if (!requireTenant(req, res)) return;

    const myId = getMyId(req);
    if (!myId) {
      return res
        .status(401)
        .json({ success: false, message: "unauthorized" });
    }

    const properties = await Property.find({
      tenantId: req.tenantId,
      customer: myId,
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, properties });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    if (!requireTenant(req, res)) return;

    const myId = getMyId(req);
    if (!myId) {
      return res
        .status(401)
        .json({ success: false, message: "unauthorized" });
    }

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "invalid_property_id" });
    }

    const property = await Property.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
      customer: myId,
    }).lean();

    if (!property) {
      return res
        .status(404)
        .json({ success: false, message: "Property not found" });
    }

    res.json({ success: true, property });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    if (!requireTenant(req, res)) return;

    const myId = getMyId(req);
    if (!myId) {
      return res
        .status(401)
        .json({ success: false, message: "unauthorized" });
    }

    const body = req.body || {};
    const doc = await new Property({
      tenantId: req.tenantId,
      propertyId: body.propertyId,
      name: body.name,
      address: body.address || "",
      city: body.city || "",
      state: body.state || "",
      zip: body.zip || "",
      type: body.type,
      squareFootage: Number(body.squareFootage || 0),
      cycle: body.cycle || "",
      customer: myId,
      isActive: body.isActive !== undefined ? !!body.isActive : true,
      roomTasks: Array.isArray(body.roomTasks) ? body.roomTasks : [],
    }).save();

    res.status(201).json({ success: true, property: doc });
  } catch (e) {
    next(e);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    if (!requireTenant(req, res)) return;

    const myId = getMyId(req);
    if (!myId) {
      return res
        .status(401)
        .json({ success: false, message: "unauthorized" });
    }

    const doc = await Property.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId, customer: myId },
      { $set: req.body },
      { new: true }
    );

    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: "Property not found" });
    }

    res.json({ success: true, property: doc });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    if (!requireTenant(req, res)) return;

    const myId = getMyId(req);
    if (!myId) {
      return res
        .status(401)
        .json({ success: false, message: "unauthorized" });
    }

    const r = await Property.deleteOne({
      _id: req.params.id,
      tenantId: req.tenantId,
      customer: myId,
    });

    if (!r.deletedCount) {
      return res
        .status(404)
        .json({ success: false, message: "Property not found" });
    }

    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;