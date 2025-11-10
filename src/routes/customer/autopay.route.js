// services/api/src/routes/customer/autopay.route.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { auth: requireAuth } = require('../../../middleware/auth');

const Property = require('../../../models/Property');
const Order = require('../../../models/Order');
const WarehouseOrder = require('../../models/WarehouseOrder');
const Subscription = require('../../models/Subscription');

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_PLAN_IDS = {
  CLEAN_WEEKLY: process.env.PP_PLAN_CLEAN_WEEKLY || '',
  CLEAN_BIWEEKLY: process.env.PP_PLAN_CLEAN_BIWEEKLY || '',
  CLEAN_MONTHLY: process.env.PP_PLAN_CLEAN_MONTHLY || ''
};

function myId(req) {
  return String(req.user?.userId || req.user?._id || req.userId || '');
}

async function resolveProperty(propertyId) {
  let prop = null;
  if (mongoose.Types.ObjectId.isValid(propertyId)) prop = await Property.findById(propertyId).lean();
  if (!prop) prop = await Property.findOne({ $or: [{ propertyId }, { name: propertyId }] }).lean();
  return prop;
}

async function ensureOwnership(prop, userId) {
  if (!prop) return 'property_not_found';
  if (prop.customer && String(prop.customer) !== String(userId)) return 'forbidden_property';
  if (!prop.customer) await Property.updateOne({ _id: prop._id }, { $set: { customer: userId } });
  return null;
}

async function latestSelection(propertyId, customerId) {
  const wo = await WarehouseOrder.findOne({ propertyId, customerId }).sort({ createdAt: -1 }).lean();
  if (wo?.items?.length) {
    return wo.items.map(it => ({
      skuId: it.skuId || it.sku || it.id || '',
      name: it.name || 'Item',
      qty: Number(it.qty || it.quantity || 1),
      priceCents: Math.round((it.unitPrice ?? it.price ?? 0) * 100)
    }));
  }
  const o = await Order.findOne({ propertyId, customerId }).sort({ createdAt: -1 }).lean();
  if (o?.items?.length) {
    return o.items.map(it => ({
      skuId: it.skuId || it.sku || it.id || '',
      name: it.name || 'Item',
      qty: Number(it.qty || 1),
      priceCents: Math.round((it.unitPrice ?? it.price ?? 0) * 100)
    }));
  }
  return [];
}

function sumCents(items = []) {
  return items.reduce((s, it) => s + (Number(it.priceCents || 0) * Number(it.qty || 1)), 0);
}

function nextPeriodFrom(start, interval) {
  const s = new Date(start);
  const e = new Date(s);
  if (interval === 'week') e.setDate(e.getDate() + 7);
  else e.setMonth(e.getMonth() + 1);
  return { startOut: s, endOut: e };
}

router.use(requireAuth);

/** GET /api/customer/autopay/summary?propertyId=... */
router.get('/summary', async (req, res) => {
  try {
    const userId = myId(req);
    const { propertyId } = req.query || {};
    if (!propertyId) return res.status(400).json({ ok: false, error: 'propertyId_required' });

    const prop = await resolveProperty(propertyId);
    const own = await ensureOwnership(prop, userId);
    if (own) return res.status(own === 'forbidden_property' ? 403 : 404).json({ ok: false, error: own });

    const sub = await Subscription.findOne({ customerId: userId, propertyId: prop._id, status: { $ne: 'canceled' } }).lean();
    const items = await latestSelection(prop._id, userId);
    const subTotalCents = sumCents(items);
    const taxCents = 0;
    const totalCents = sub?.priceCents ?? (subTotalCents + taxCents);

    res.json({
      ok: true,
      property: {
        _id: prop._id,
        propertyId: prop.propertyId,
        name: prop.name,
        address: prop.address,
        type: prop.type,
        squareFootage: prop.squareFootage,
        cycle: prop.cycle,
        roomTasks: prop.roomTasks || []
      },
      selection: items,
      pricing: { subTotalCents, taxCents, totalCents, currency: sub?.currency || 'USD' },
      subscription: sub || null,
      limits: { minNoticeHours: sub?.meta?.minNoticeHours || 24, maxExtendDays: sub?.meta?.maxExtendDays || 14 },
      paypal: { clientId: PAYPAL_CLIENT_ID, planIds: PAYPAL_PLAN_IDS }
    });
  } catch (e) {
    console.error('autopay:summary', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/** POST /api/customer/autopay/enable  { propertyId, planCode, interval?, nextChargeAt? } */
router.post('/enable', async (req, res) => {
  try {
    const userId = myId(req);
    const { propertyId, planCode = 'CLEAN_MONTHLY', interval, nextChargeAt } = req.body || {};
    if (!propertyId) return res.status(400).json({ ok: false, error: 'propertyId_required' });

    const prop = await resolveProperty(propertyId);
    const own = await ensureOwnership(prop, userId);
    if (own) return res.status(own === 'forbidden_property' ? 403 : 404).json({ ok: false, error: own });

    const items = await latestSelection(prop._id, userId);
    const cents = sumCents(items);
    const chosenInterval = interval || (planCode.includes('WEEK') ? 'week' : 'month');
    const when = nextChargeAt ? new Date(nextChargeAt) : new Date();
    const { startOut, endOut } = nextPeriodFrom(when, chosenInterval);

    const doc = await Subscription.create({
      customerId: userId,
      propertyId: prop._id,
      planCode,
      interval: chosenInterval,
      priceCents: cents,
      currency: 'USD',
      status: 'incomplete',
      nextChargeAt: when,
      currentPeriodStart: startOut,
      currentPeriodEnd: endOut,
      provider: 'paypal',
      selectedItems: items,
      meta: { minNoticeHours: 24, maxExtendDays: 14 }
    });

    res.status(201).json({ ok: true, subscription: doc, paypal: { clientId: PAYPAL_CLIENT_ID, planIds: PAYPAL_PLAN_IDS } });
  } catch (e) {
    console.error('autopay:enable', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/** PATCH /api/customer/autopay/subscriptions/:id */
router.patch('/subscriptions/:id', async (req, res) => {
  try {
    const userId = myId(req);
    const { id } = req.params;
    const { action, nextChargeAt, newPlanCode, providerSubscriptionId } = req.body || {};

    const sub = await Subscription.findOne({ _id: id, customerId: userId }).lean();
    if (!sub) return res.status(404).json({ ok: false, error: 'not_found' });

    const minH = sub?.meta?.minNoticeHours || 24;
    const maxExt = sub?.meta?.maxExtendDays || 14;

    const set = {};
    if (providerSubscriptionId) set.providerSubscriptionId = providerSubscriptionId;

    if (action === 'pause') set.status = 'paused';
    else if (action === 'resume') set.status = 'active';
    else if (action === 'change_plan') set.planCode = newPlanCode || sub.planCode;
    else if (action === 'skip') {
      const cur = new Date(sub.nextChargeAt || new Date());
      const bumped = new Date(cur);
      if (sub.interval === 'week') bumped.setDate(bumped.getDate() + 7);
      else bumped.setMonth(bumped.getMonth() + 1);
      set.nextChargeAt = bumped;
    } else if (action === 'change_date' || action === 'extend_date') {
      if (!nextChargeAt) return res.status(400).json({ ok: false, error: 'nextChargeAt_required' });
      const next = new Date(nextChargeAt);
      const diffH = Math.abs((next.getTime() - Date.now()) / 36e5);
      if (diffH < minH) return res.status(400).json({ ok: false, error: 'min_notice_violation', detail: { minNoticeHours: minH } });
      if (action === 'extend_date') {
        const cur = new Date(sub.nextChargeAt || new Date());
        const diffD = Math.round((next - cur) / 86400000);
        if (diffD > maxExt) return res.status(400).json({ ok: false, error: 'max_extend_violation', detail: { maxExtendDays: maxExt } });
      }
      set.nextChargeAt = next;
    } else if (action === 'confirm') {
      set.status = 'active';
    } else {
      return res.status(400).json({ ok: false, error: 'invalid_action' });
    }

    await Subscription.updateOne({ _id: id }, { $set: set });
    const fresh = await Subscription.findById(id).lean();
    res.json({ ok: true, subscription: fresh });
  } catch (e) {
    console.error('autopay:update', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/** DELETE /api/customer/autopay/subscriptions/:id?at_period_end=true */
router.delete('/subscriptions/:id', async (req, res) => {
  try {
    const userId = myId(req);
    const { id } = req.params;
    const atEnd = String(req.query.at_period_end || 'true') === 'true';
    const sub = await Subscription.findOne({ _id: id, customerId: userId }).lean();
    if (!sub) return res.status(404).json({ ok: false, error: 'not_found' });

    await Subscription.updateOne({ _id: id }, { $set: { status: 'canceled', cancelAtPeriodEnd: !!atEnd } });
    const fresh = await Subscription.findById(id).lean();
    res.json({ ok: true, subscription: fresh });
  } catch (e) {
    console.error('autopay:delete', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
