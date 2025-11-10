// services/api/src/routes/customer/tasks.route.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const { auth: requireAuth } = require('../../../middleware/auth');
const Task = require('../../models/Task');
const Property = require('../../models/Property');
const { getCleaners } = require('../../../services/cleaners');



/* ✅ Uniform current-user resolver */
function getMyId(req) {
  return String(
    req.user?.userId ||
    req.user?._id ||
    req.userId ||
    req.userDoc?._id ||
    req.userDoc?.id ||
    ''
  );
}

function parseBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v || '').toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

router.use(requireAuth);

/* GET /api/customer/tasks?isActive=true */
// router.get('/', async (req, res, next) => {
//   try {
//     const myId = getMyId(req);
//     if (!myId) return res.status(401).json({ success: false, message: 'unauthorized' });

//     // find all property ids belonging to this customer
//     const props = await Property.find({ customer: myId }, { _id: 1 }).lean();
//     const propIds = props.map(p => String(p._id));

//     const q = { propertyId: { $in: propIds } };
//     if (typeof req.query.isActive !== 'undefined') {
//       q.isActive = parseBool(req.query.isActive);
//     }

//     const tasks = await Task.find(q).sort({ createdAt: -1 }).lean();
//     res.json({ success: true, tasks });
//   } catch (err) {
//     next(err);
//   }
// });


/* GET /api/customer/tasks?isActive=true */
router.get('/', async (req, res, next) => {
  try {
    const myId = getMyId(req);
    if (!myId) return res.status(401).json({ success: false, message: 'unauthorized' });

    // ---- fetch customer properties (both Mongo _id & business propertyId) ----
    const props = await Property.find({ customer: myId }, { _id: 1, propertyId: 1 }).lean();
    const mongoIds = props.map(p => String(p._id));
    const bizIds   = props.map(p => String(p.propertyId)).filter(Boolean);

    const q = { $or: [ { propertyId: { $in: mongoIds } }, { propertyId: { $in: bizIds } } ] };
    if (typeof req.query.isActive !== 'undefined') q.isActive = parseBool(req.query.isActive);

    const tasks = await Task.find(q).sort({ createdAt: -1 }).lean();

    // ---- normalize cleaners from Firebase ----
    const raw = await getCleaners();
    const cleaners = Array.isArray(raw?.data) ? raw.data : raw;

    const idOf = (c) => String(c?._id || c?.id || c?.docId || c?.uid || c?.documentId || '');
    const nameOf = (c) =>
      c?.displayName || c?.businessName || c?.name || c?.contactName || c?.email || idOf(c);

    const nameById = new Map((cleaners || []).map(c => [idOf(c), nameOf(c)]));

    // ---- attach assignedCleanerName using assignedTo (string or object) ----
    const enriched = tasks.map(t => {
      const a = t?.assignedTo;
      const aId = typeof a === 'string'
        ? a
        : String(a?._id || a?.id || a?.docId || a?.uid || a?.documentId || '');
      const assignedCleanerName = aId ? (nameById.get(aId) || aId) : null;
      return { ...t, assignedCleanerName };
    });

    res.json({ success: true, tasks: enriched });
  } catch (err) {
    next(err);
  }
});



/* GET /api/customer/tasks/:id */
router.get('/:id', async (req, res, next) => {
  try {
    const myId = getMyId(req);
    if (!myId) return res.status(401).json({ success: false, message: 'unauthorized' });

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'invalid_task_id' });
    }

    const task = await Task.findById(req.params.id).lean();
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    // ensure the task's property belongs to this customer
    const owns = await Property.exists({ _id: task.propertyId, customer: myId });
    if (!owns) return res.status(404).json({ success: false, message: 'Task not found' });

    res.json({ success: true, task });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
