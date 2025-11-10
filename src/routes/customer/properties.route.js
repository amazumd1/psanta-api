// services/api/src/routes/customer/properties.route.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { auth: requireAuth } = require('../../../middleware/auth');
const Property = require('../../models/Property');

/* ✅ Uniform current-user resolver (works with req.user, req.userId, req.userDoc) */
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

router.use(requireAuth);

/* GET /api/customer/properties */
router.get('/', async (req, res, next) => {
  try {
    const myId = getMyId(req);
    if (!myId) return res.status(401).json({ success: false, message: 'unauthorized' });

    const properties = await Property.find({ customer: myId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, properties });
  } catch (err) {
    next(err);
  }
});

/* GET /api/customer/properties/:id */
router.get('/:id', async (req, res, next) => {
  try {
    const myId = getMyId(req);
    if (!myId) return res.status(401).json({ success: false, message: 'unauthorized' });

    // guard invalid ObjectId to avoid CastError
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'invalid_property_id' });
    }

    const property = await Property.findOne({ _id: req.params.id, customer: myId }).lean();
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });

    res.json({ success: true, property });
  } catch (err) {
    next(err);
  }
});


// POST /api/customer/properties
router.post('/', async (req, res, next) => {
  try {
    const myId = getMyId(req);
    if (!myId) return res.status(401).json({ success: false, message: 'unauthorized' });

    const body = req.body || {};
    const doc = await (new Property({
      propertyId: body.propertyId,
      name: body.name,
      address: body.address || '',
      city: body.city || '',
      state: body.state || '',
      zip: body.zip || '',
      type: body.type,
      squareFootage: Number(body.squareFootage || 0),
      cycle: body.cycle || '',
      customer: myId,
      isActive: body.isActive !== undefined ? !!body.isActive : true,
      roomTasks: Array.isArray(body.roomTasks) ? body.roomTasks : [],
    })).save();

    res.status(201).json({ success: true, property: doc });
  } catch (e) { next(e); }
});

// PUT /api/customer/properties/:id
router.put('/:id', async (req, res, next) => {
  try {
    const myId = getMyId(req);
    if (!myId) return res.status(401).json({ success: false, message: 'unauthorized' });

    const doc = await Property.findOneAndUpdate(
      { _id: req.params.id, customer: myId },
      { $set: req.body },
      { new: true }
    );

    if (!doc) return res.status(404).json({ success: false, message: 'Property not found' });
    res.json({ success: true, property: doc });
  } catch (e) { next(e); }
});

// DELETE /api/customer/properties/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const myId = getMyId(req);
    if (!myId) return res.status(401).json({ success: false, message: 'unauthorized' });

    const r = await Property.deleteOne({ _id: req.params.id, customer: myId });
    if (!r.deletedCount) return res.status(404).json({ success: false, message: 'Property not found' });
    res.json({ success: true });
  } catch (e) { next(e); }
});


module.exports = router;



// // GET /api/customer/properties
// router.get('/', async (req, res, next) => {
// try {
// const userId = req.user?.userId || req.user?._id;
// const properties = await Property.find({ customer: userId }).lean();
// res.json({ success: true, properties });
// } catch (err) {
// next(err);
// }
// });


// GET /api/customer/properties/:id
// router.get('/:id', async (req, res, next) => {
// try {
// const userId = req.user?.userId || req.user?._id;
// const property = await Property.findOne({ _id: req.params.id, customer: userId }).lean();
// if (!property) return res.status(404).json({ success: false, message: 'Property not found' });
// res.json({ success: true, property });
// } catch (err) {
// next(err);
// }
// });


module.exports = router;