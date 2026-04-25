// services/api/src/routes/customer/tasks.route.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const { auth: requireAuth } = require("../../../middleware/auth");
const Task = require("../../models/Task");
const Property = require("../../models/Property");
const { getCleaners } = require("../../../services/cleaners");

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

function parseBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v || "").toLowerCase();
  return s === "true" || s === "1" || s === "yes";
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

    const props = await Property.find(
      { tenantId: req.tenantId, customer: myId },
      { _id: 1, propertyId: 1 }
    ).lean();

    const mongoIds = props.map((p) => String(p._id));
    const bizIds = props.map((p) => String(p.propertyId || "")).filter(Boolean);

    const q = {
      tenantId: req.tenantId,
      $or: [{ propertyId: { $in: mongoIds } }, { propertyId: { $in: bizIds } }],
    };

    if (typeof req.query.isActive !== "undefined") {
      q.isActive = parseBool(req.query.isActive);
    }

    const tasks = await Task.find(q).sort({ createdAt: -1 }).lean();

    const raw = await getCleaners(req.tenantId);
    const cleaners = Array.isArray(raw?.data) ? raw.data : raw;

    const idOf = (c) =>
      String(c?._id || c?.id || c?.docId || c?.uid || c?.documentId || "");
    const nameOf = (c) =>
      c?.displayName ||
      c?.businessName ||
      c?.name ||
      c?.contactName ||
      c?.email ||
      idOf(c);

    const nameById = new Map((cleaners || []).map((c) => [idOf(c), nameOf(c)]));

    const enriched = tasks.map((t) => {
      const a = t?.assignedTo;
      const aId =
        typeof a === "string"
          ? a
          : String(a?._id || a?.id || a?.docId || a?.uid || a?.documentId || "");
      const assignedCleanerName = aId ? nameById.get(aId) || aId : null;
      return { ...t, assignedCleanerName };
    });

    res.json({ success: true, tasks: enriched });
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
        .json({ success: false, message: "invalid_task_id" });
    }

    const task = await Task.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
    }).lean();

    if (!task) {
      return res
        .status(404)
        .json({ success: false, message: "Task not found" });
    }

    const owns = await Property.exists({
      _id: task.propertyId,
      tenantId: req.tenantId,
      customer: myId,
    });

    if (!owns) {
      return res
        .status(404)
        .json({ success: false, message: "Task not found" });
    }

    res.json({ success: true, task });
  } catch (err) {
    next(err);
  }
});

module.exports = router;