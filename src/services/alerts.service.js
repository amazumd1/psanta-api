// services/api/src/services/alerts.service.js
const mongoose = require('mongoose');
const Alert = require('../models/Alert');
const { io } = require('../server/socket'); // socket getter (attached in server.js)

/**
 * Upsert/open an alert for next-pack recommendation
 * Ensures single OPEN alert per (customerId, skuId, type)
 */
async function upsertNextPackAlert(payload) {
  const key = {
    customerId: payload.customerId,
    skuId: payload.skuId,
    type: 'next_pack_recommendation',
    status: 'open',
  };

  const doc = await Alert.findOneAndUpdate(
    key,
    { $set: payload },
    { new: true, upsert: true }
  );

  if (io) {
    // global upsert event
    io.emit('admin:alerts', { action: 'upsert', alert: doc });
  }
  return doc;
}

/**
 * Mark alert as applied and optionally link created WO
 */
async function markApplied(alertId, linkedOrderId) {
  const upd = {
    status: 'applied',
    ...(linkedOrderId
      ? { 'links.linkedOrderId': new mongoose.Types.ObjectId(linkedOrderId) }
      : {}),
  };

  const doc = await Alert.findByIdAndUpdate(
    alertId,
    { $set: upd },
    { new: true }
  );

  if (io) {
    // global upsert for list refresh
    io.emit('admin:alerts', { action: 'upsert', alert: doc });
    // optional room-specific event if clients join 'admins'
    io.to && io.to('admins').emit('admin:alerts', { action: 'applied', alert: doc });
  }

  return doc;
}

/**
 * Dismiss alert (hide without applying)
 */
async function dismiss(alertId) {
  const doc = await Alert.findByIdAndUpdate(
    alertId,
    { $set: { status: 'dismissed' } },
    { new: true }
  );

  if (io) {
    io.emit('admin:alerts', { action: 'upsert', alert: doc });
    io.to && io.to('admins').emit('admin:alerts', { action: 'dismissed', alert: doc });
  }

  return doc;
}

module.exports = { upsertNextPackAlert, markApplied, dismiss };
