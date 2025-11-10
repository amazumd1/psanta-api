
// src/routes/payments/paypal.route.js
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch'); // built-in in Node18+, else add dep
const { paypalClient } = require('../../services/paypal');
const paypalSdk = require('@paypal/checkout-server-sdk');
const Payment = require('../../models/Payment');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const Event = require('../../models/Event');
const Invoice = require('../../models/Invoice');
const Property = require('../../models/Property');
const WarehouseOrder = require('../../models/WarehouseOrder'); // ✅ add
const Order = require('../../../models/Order');
const { auth } = require('../../../middleware/auth'); // top of file
const Counter = require('../../models/Counter');
const PORTAL_JWT_TTL = process.env.CP_JWT_TTL || '7d';              // e.g. '7d'
const PORTAL_JWT_TTL_MS =
  Number(process.env.CP_JWT_TTL_MS || 7 * 24 * 60 * 60 * 1000);      // 7d in ms
const PORTAL_BASE_URL = process.env.PORTAL_BASE_URL || 'http://localhost:3000';




// const portalUrl = process.env.PORTAL_PUBLIC_URL || 'http://localhost:3002/customer' || '/customer';

// TODO: replace with your real server-side pricing recomputation
async function computeEstimatedMonthlyOnServer({ propertyId, amountOverride }) {
  if (!propertyId) throw new Error('propertyId required');

  const n = Number(amountOverride);
  if (Number.isFinite(n) && n > 0) {
    return { amount: +n.toFixed(2) };
  }

  if (process.env.PRICING_DEFAULT && Number(process.env.PRICING_DEFAULT) > 0) {
    const d = Number(process.env.PRICING_DEFAULT);
    return { amount: +d.toFixed(2) };
  }

  return { amount: 800.99 }; // fallback for now
}

// Atomically allocate a block of sequential IDs
async function allocateSequenceBlock(key, count, startAt = 100) {
  const doc = await Counter.findOneAndUpdate(
    { key },
    [
      { $set: { seq: { $add: [{ $ifNull: ['$seq', startAt - 1] }, count] } } }
    ],
    { new: true, upsert: true }
  ).lean();

  const end = doc.seq;
  const start = end - count + 1;
  return Array.from({ length: count }, (_, i) => start + i);
}




// Simple hash to bind the server-computed snapshot to the payment
function makeQuoteHash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj || {})).digest('hex');
}

// ---- Ensure/merge a customer property (non-destructive) ----
async function ensureCustomerProperty(userId, bizId, prop = {}) {
  let p = await Property.findOne({ propertyId: bizId, customer: userId }).lean();
  if (p) {
    const upd = {};
    if (!p.name || p.name === 'My Property') upd.name = prop.name || 'My Property';
    if (!p.address && prop.address) upd.address = prop.address;
    if (!p.city && prop.city) upd.city = prop.city;
    if (!p.state && prop.state) upd.state = prop.state;
    if (!p.zip && prop.zip) upd.zip = prop.zip;
    if ((!p.squareFootage || p.squareFootage === 1200) && Number(prop.squareFootage) > 0) {
      upd.squareFootage = Number(prop.squareFootage);
    }
    const cyc = prop.cycle || prop.cleaningCycle;
    if (!p.cycle && cyc) upd.cycle = cyc;
    if (p.isActive === false) upd.isActive = true;

    if (Object.keys(upd).length) {
      await Property.updateOne({ _id: p._id }, { $set: upd });
      p = { ...p, ...upd };
    }
    return p;
  }

  const base = {
    propertyId: bizId,
    name: prop.name || 'My Property',
    address: prop.address || '',
    city: prop.city || '',
    state: prop.state || '',
    zip: prop.zip || '',
    type: prop.type || 'house',
    squareFootage: Number(prop.squareFootage || 1200),
    cycle: prop.cycle || prop.cleaningCycle || 'monthly',
    customer: userId,
    isActive: true,
  };

  try {
    const created = await (new Property(base)).save();
    return created.toObject();
  } catch (e) {
    if (e?.code === 11000 && e.keyPattern?.propertyId) {
      const alt = `${bizId}-${String(userId).slice(-4)}`;
      const dup = await (new Property({ ...base, propertyId: alt })).save();
      return dup.toObject();
    }
    throw e;
  }
}




/* ---------- Create One-Time Order ---------- */
router.post('/create-order', async (req, res, next) => {
  try {
    const { propertyId, userId, amountOverride } = req.body || {};
    const { amount, reason } = await computeEstimatedMonthlyOnServer({ propertyId, amountOverride });

    if (!propertyId) return res.status(400).json({ ok: false, error: 'propertyId required' });
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'PRICE_NOT_AVAILABLE', reason });
    }

    const client = paypalClient();

    const request = new paypalSdk.orders.OrdersCreateRequest();

    request.prefer('return=representation');
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'USD', value: amount.toFixed(2) },
        custom_id: propertyId,
      }],
      application_context: {
        brand_name: 'PropertySanta',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW',
        return_url: `${PORTAL_BASE_URL}/customer/after-pay`,
        cancel_url: `${PORTAL_BASE_URL}/orders`,
      },

    });

    const createRes = await client.execute(request);

    const quoteHash = makeQuoteHash({ propertyId, amount });
    await Payment.create({
      type: 'one_time',
      propertyId,
      userId,
      currency: 'USD',
      amount,
      quoteHash,
      paypal: { orderId: createRes.result.id, rawCreateResponse: createRes.result },
      cart: req.body?.cart || null,
      status: 'created',
    });

    const approveUrl = (createRes.result.links || []).find(l => l.rel === 'approve')?.href;
    return res.json({ ok: true, orderID: createRes.result.id, approveUrl });
  } catch (e) { next(e); }
});


/* ---------- Capture Order ---------- */
router.post('/capture-order', async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });

    // ✅ get client
    const client = paypalClient();

    // ✅ use paypalSdk not "paypal"
    const request = new paypalSdk.orders.OrdersCaptureRequest(orderId);
    request.requestBody({});

    const capRes = await client.execute(request);
    const result = capRes?.result;
    const status = result?.status || 'FAILED';

    const payer = result?.payer || {};
    const payerEmail = payer.email_address || null;
    const payerName = [payer?.name?.given_name, payer?.name?.surname].filter(Boolean).join(' ').trim() || null;

    const captureId = result?.purchase_units?.[0]?.payments?.captures?.[0]?.id || null;
    const amountObj = result?.purchase_units?.[0]?.payments?.captures?.[0]?.amount || {};
    const gross = Number(amountObj.value || 0);
    const currency = amountObj.currency_code || 'USD';

    // 🔁 LOAD existing payment WITHOUT .lean() so we can preserve cart
    const payDoc = await Payment.findOne({ 'paypal.orderId': orderId }); // no .lean()
    const cart = payDoc?.cart || req.body?.cart || {};

    // 🔧 Build base (preserving cart)
    const base = {
      type: 'one_time',
      propertyId: payDoc?.propertyId || cart?.propertyId || undefined,
      userId: payDoc?.userId,
      amount: gross || payDoc?.amount || 0,
      currency,
      status: status.toLowerCase() === 'completed' ? 'captured' : 'failed',
      cart, // ✅ IMPORTANT: store it back
      paypal: {
        ...(payDoc?.paypal?.toObject?.() || payDoc?.paypal || {}),
        orderId,
        captureId,
        rawCaptureResponse: result,
        payer,
      },
    };

    let saved;
    if (payDoc) {
      saved = await Payment.findByIdAndUpdate(payDoc._id, { $set: base }, { new: true });
    } else {
      saved = await (new Payment(base)).save();
    }

    // --- User linking (prefer existing → then by payer email) ---
    let userDoc = null;

    const sessionUserId = req.user?.id || req.userId || null;
    if (sessionUserId || saved?.userId) {
      const uid = sessionUserId || saved.userId;
      try { userDoc = await User.findById(uid); } catch (_) { }
    }

    if (!userDoc && payerEmail) {
      userDoc = await User.findOne({ email: payerEmail });
      if (!userDoc) {
        const randomPwd = Math.random().toString(36).slice(2) + 'A1!';
        userDoc = await (new User({
          name: payerName || 'New Customer',
          email: payerEmail,
          password: randomPwd,
          role: 'customer',
          isActive: true,
          mustSetPassword: true,

        })).save();
      }
    }

    if (userDoc && (!saved.userId || saved.userId !== String(userDoc._id))) {
      saved = await Payment.findByIdAndUpdate(
        saved._id,
        { $set: { userId: String(userDoc._id) } },
        { new: true }
      );
    }

    // --- Ensure property + customer-facing Order ---
    let ensuredProp = null;

    // ✅ ensure/merge property (minimal)
    try {
      const bizPropId = saved?.propertyId || cart?.propertyId;
      if (userDoc && bizPropId) {
        const raw = cart?.property || {};
        const norm = { ...raw };
        if (norm.address && (!norm.city || !norm.state || !norm.zip)) {
          try {
            const parts = String(norm.address).split(',').map(s => s.trim());
            if (!norm.city && parts[1]) norm.city = parts[1];
            if (parts[2]) {
              const t = parts[2].split(/\s+/);
              if (!norm.state && t[0]) norm.state = t[0];
              if (!norm.zip && t[1]) norm.zip = t.slice(1).join(' ');
            }
          } catch { }
        }
        ensuredProp = await ensureCustomerProperty(String(userDoc._id), String(bizPropId), norm);
      }
    } catch (e) {
      console.warn('property ensure failed:', e.message);
    }


    try {
      const bizPropId = saved?.propertyId || cart?.propertyId;
      if (userDoc && bizPropId) {
        // normalize city/state/zip if only single-line address is present
        const rawProp = cart?.property || {};
        const normalizedProp = (() => {
          const out = { ...rawProp };
          try {
            if ((!out.city || !out.state || !out.zip) && out.address) {
              const line = String(out.address).split('\n')[0];
              const parts = line.split(',').map(s => s.trim());
              // e.g. "1208 Enchanted Oaks Drive, Raleigh, NC 27606"
              if (!out.city && parts[1]) out.city = parts[1];
              if (!out.state || !out.zip) {
                if (parts[2]) {
                  const tokens = parts[2].trim().split(/\s+/);
                  if (!out.state && tokens[0]) out.state = tokens[0];
                  if (!out.zip && tokens[1]) out.zip = tokens.slice(1).join(' ');
                }
              }
            }
          } catch (_) { }
          return out;
        })();

        ensuredProp = await ensureCustomerProperty(
          String(userDoc._id),
          String(bizPropId),
          normalizedProp
        );

        // Light non-destructive update from cart.property (overwrite only if given)
        if (ensuredProp && cart?.property) {
          const u = {};
          if (cart.property.address) u.address = cart.property.address;
          if (cart.property.city) u.city = cart.property.city;
          if (cart.property.state) u.state = cart.property.state;
          if (cart.property.zip) u.zip = cart.property.zip;
          if (cart.property.type) u.type = cart.property.type;
          if (Number(cart.property.squareFootage) > 0)
            u.squareFootage = Number(cart.property.squareFootage);
          const cyc = cart.property.cycle || cart.property.cleaningCycle;
          if (cyc) u.cycle = cyc;
          if (Object.keys(u).length) {
            await Property.updateOne({ _id: ensuredProp._id }, { $set: u });
          }
        }

        const lineAmt = Number(saved?.amount || 0);
        const propObjectId = ensuredProp?._id || saved?.propertyId || null;  // ✅ ObjectId
        const propBizCode = bizPropId;


        // // Customer-facing pending Order (for /customer/orders/pending)
        // await Order.create({
        //   customerId: String(userDoc._id),
        //   propertyId: ensuredProp?._id,
        //   items: [
        //     { skuId: 'SERVICE_BOOKING', name: 'Cleaning Service', qty: 1, unitPrice: lineAmt }
        //   ],
        //   subtotal: lineAmt,
        //   total: lineAmt,
        //   status: 'submitted',
        //   type: 'inventory',
        //   source: 'capture',
        //   externalOrderId: orderId,
        // });

        // // Minimal Warehouse row
        // await WarehouseOrder.updateOne(
        //   { orderId: String(result?.id || orderId) },
        //   {
        //     $setOnInsert: {
        //       orderId: String(result?.id || orderId),
        //       customerId: String(userDoc._id),
        //       status: 'pending_pick',
        //       items: [
        //         { skuId: 'SERVICE_BOOKING', name: 'Cleaning Service', qty: 1, unitPrice: lineAmt }
        //       ],
        //       meta: {
        //         paymentId: String(saved?._id || ''),
        //         propertyId: propObjectId,               // ✅ correct type: ObjectId
        //         propertyCode: propBizCode,              // ✅ business code ko yahan rakho
        //         schedule: Array.isArray(cart?.schedule) ? cart.schedule : [],
        //       },
        //     },
        //   },
        //   { upsert: true }
        // );

        // --- Inventory-only order creation (guarded) ---
        try {
          const cart = saved?.cart || req.body?.cart || {};

          const invAmt = Number(cart?.inventoryAmount || 0);
          const cleanAmt = Number(cart?.cleaningAmount || 0); // FYI: cleaning jobs alag flow me jate hain

          // Prefer detailed items coming from cart.inventoryItems
          const invItems = Array.isArray(cart?.inventoryItems) && cart.inventoryItems.length
            ? cart.inventoryItems.map(it => ({
              skuId: it.skuId || it.sku || it.id || 'SKU',
              name: it.name || it.title || it.sku || 'Item',
              qty: Number(it.qty ?? 1),
              unitPrice: Number(it.unitPrice ?? it.price ?? 0),
            }))
            : (invAmt > 0
              ? [{ skuId: 'INVENTORY_PACK', name: 'Inventory Pack', qty: 1, unitPrice: invAmt }]
              : []);

          // Recompute subtotal from line items (fallback to invAmt if needed)
          const invSubtotal = invItems.length
            ? invItems.reduce((s, it) => s + (Number(it.unitPrice) * Number(it.qty || 1)), 0)
            : invAmt;


          // 1) Sirf tab Customer "Order" banao jab inventory pack liya ho
          if (invItems.length) {
            const orderDoc = await Order.create({
              customerId: String(userDoc._id),
              propertyId: ensuredProp?._id,
              items: invItems,
              subtotal: invSubtotal,
              total: invSubtotal,
              status: 'submitted',
              type: 'inventory',
              source: 'customer_portal',
              externalOrderId: String(result?.id || orderId),
            });

            // 2) Optional: auto-approve to WarehouseOrder (env toggle)
            const autoApprove = String(process.env.AUTO_APPROVE_INVENTORY || 'true') === 'true';
            if (autoApprove) {
              await WarehouseOrder.updateOne(
                { orderId: String(result?.id || orderId) },
                {
                  $setOnInsert: {
                    orderId: String(result?.id || orderId),
                    customerId: String(userDoc._id),
                    status: 'pending_pick',
                    items: invItems,
                    meta: {
                      paymentId: String(saved?._id || ''),
                      propertyId: ensuredProp?._id || null,
                      propertyCode: String(ensuredProp?.propertyId || ''),
                      paypalOrderId: String(result?.id || orderId),
                      schedule: Array.isArray(cart?.schedule) ? cart.schedule : [],
                    },
                  },
                },
                { upsert: true }
              );
            }
          }

          // NOTE: Cleaning-only case → WarehouseOrder NA banao.
          // Cleaning jobs aapke jobs/appointments system me already create ho rahe hain.
        } catch (e) {
          console.warn('capture-order: ensure inventory order failed:', e.message);
        }

      }
    } catch (e) {
      console.warn('capture-order: ensure property/order failed:', e.message);
    }

    // Create one paid invoice per Payment (idempotent)
    try {
      const lineAmt = Number(saved?.amount || 0);
      const exists = await Invoice.findOne({ payments: saved._id }).lean();
      if (!exists) {
        await (new Invoice({
          customerId: saved.userId || undefined,
          propertyId: saved.propertyId || undefined,
          lines: [
            { sku: 'SERVICE-CLEANING', description: 'Cleaning Service', qty: 1, unitPrice: lineAmt, amount: lineAmt }
          ],
          subtotal: lineAmt,
          tax: 0,
          total: lineAmt,
          status: 'paid',
          payments: [saved._id],
        })).save();
      }
    } catch (e) {
      console.warn('invoice create failed:', e.message);
    }

    // Short-lived portal JWT
    let jwtToken = null;
    if (userDoc) {
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        console.warn('⚠️ JWT_SECRET missing; not issuing JWT from capture-order');
      } else {
        jwtToken = jwt.sign(
          { userId: String(userDoc._id), role: userDoc.role || 'customer' },
          secret,
          { expiresIn: PORTAL_JWT_TTL }
        );
      }
    }


    // --- Ensure/merge property for this customer from cart (address/city/state/zip) ---
    try {
      const cart = saved?.cart || req.body?.cart || {};
      if (userDoc && (saved?.propertyId || cart?.propertyId)) {
        const rawProp = cart?.property || {};
        // Best-effort split if city/state/zip missing but address is like "Street, City, ST ZIP"
        const normalized = { ...rawProp };
        if (normalized.address && (!normalized.city || !normalized.state || !normalized.zip)) {
          try {
            const parts = String(normalized.address).split(',').map(s => s.trim());
            if (!normalized.city && parts[1]) normalized.city = parts[1];
            if (parts[2]) {
              const t = parts[2].split(/\s+/);
              if (!normalized.state && t[0]) normalized.state = t[0];
              if (!normalized.zip && t[1]) normalized.zip = t.slice(1).join(' ');
            }
          } catch { }
        }
        await ensureCustomerProperty(
          String(userDoc._id),
          String(saved?.propertyId || cart.propertyId),
          normalized
        );
      }
    } catch (e) {
      console.warn('capture-order: property ensure failed:', e.message);
    }


    // ✅ CREATE JOBS from preserved cart
    try {
      const Job = require('../../models/Job');
      const Counter = require('../../models/Counter');

      // prefer cart.schedule
      let schedule = Array.isArray(cart?.schedule) ? cart.schedule : [];
      if (!schedule.length && Array.isArray(cart?.selectedDates)) {
        const tmap = cart?.selectedTimes || {};
        schedule = cart.selectedDates
          .map(d => ({ date: d, time: tmap[d] || '10:00' }))
          .filter(x => x.date);
      }

      // 💰 SPLIT: total -> per-visit shares (in cents), perfect sum
      const totalPaid = Number(saved?.amount ?? gross ?? 0);
      const nVisits = Math.max(0, schedule.length);
      const visitCurrency = String(saved?.currency || currency || 'USD').toUpperCase();

      let shareCentsArr = [];
      if (nVisits > 0) {
        const cents = Math.round(totalPaid * 100);
        const base = Math.floor(cents / nVisits);
        const rem = cents - base * nVisits;
        // first `rem` visits get +1 cent
        shareCentsArr = Array.from({ length: nVisits }, (_, i) => base + (i < rem ? 1 : 0));
      }


      const property = cart?.property || { address: '', city: '', state: '', zip: '' };
      const customerId = (userDoc?._id && String(userDoc._id)) || saved?.userId || 'walkin';

      const aiCandidates = [
        cart?.aiMinutes,
        cart?.aiEstimateMinutes,
        cart?.ai?.minutes,
        cart?.ai?.estimateMinutes,
      ];
      const estMins = Number(aiCandidates.find(v => Number(v) > 0)) || 120;

      function toWindow(dateStr, timeStr) {
        const hhmm = (timeStr || '10:00').padStart(5, '0');
        const start = new Date(`${dateStr}T${hhmm}:00.000Z`);
        const end = new Date(start.getTime() + estMins * 60 * 1000);
        return { start, end };
      }

      const docs = [];
      for (let i = 0; i < (schedule || []).length; i++) {
        const slot = schedule[i];
        const { start, end } = toWindow(slot.date, slot.time);

        // 💰 per-visit price from split
        const priceUsd = shareCentsArr.length ? (shareCentsArr[i] / 100) : 0;

        docs.push({
          customerId,
          propertyId: saved?.propertyId || cart?.propertyId || null,
          property,
          date: start,
          window: { start, end },
          status: 'offered',
          durationMinutes: estMins,
          ai: { minutes: estMins },
          offer: { status: 'sent', expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
          aiEstimateMinutes: estMins,
          priceUsd,
          currency: visitCurrency,
        });
      }

      const paymentIdStr = String(saved?._id || '');
      const already = await Job.countDocuments({ paymentId: paymentIdStr });

      if (!already && docs.length) {
        const withLink = docs.map(d => ({
          ...d,
          paymentId: paymentIdStr,
          orderId,           // traceability
          source: 'capture',
        }));

        if (docs.length > 0) {
          // Allocate a contiguous block of jobIds for this batch
          const jobIds = await allocateSequenceBlock('jobId', docs.length, 100);
          // Attach jobId to each doc, preserving order
          for (let i = 0; i < docs.length; i++) {
            docs[i].jobId = jobIds[i];
          }
        }


        await Job.insertMany(withLink);
        console.log(`✅ Jobs created on capture: ${withLink.length}`);

        try {
          await Event.create({
            type: 'payment_captured',
            message: `Payment captured ${currency} ${gross}`,
            propertyId: saved?.propertyId || null,
            orderId,
            paymentId: String(saved?._id || ''),
            userId: String(userDoc?._id || saved?.userId || ''),
            meta: { captureId, currency, amount: gross }
          });

          await Event.create({
            type: 'jobs_created',
            message: `Created ${withLink.length} cleaning job(s)`,
            propertyId: saved?.propertyId || withLink[0]?.propertyId || null,
            orderId,
            paymentId: String(saved?._id || ''),
            userId: String(userDoc?._id || saved?.userId || ''),
            meta: {
              dates: (schedule || []).map(s => `${s.date} ${s.time || ''}`.trim()),
              durationMinutes: estMins
            }
          });
        } catch (e) {
          console.warn('events emit failed:', e.message);
        }

      } else if (already) {
        console.log('ℹ️ Jobs already exist for this payment; skipping.');
      } else {
        console.log('ℹ️ No schedule found on capture; skipping job creation.');
      }

    } catch (e) {
      console.error('❌ job creation on capture failed:', e);
    }

    // JWT cookie
    if (jwtToken) {
      res.cookie('cp_jwt', jwtToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: PORTAL_JWT_TTL_MS
      });
    }

    return res.json({
      ok: true,
      data: saved,
      payer: { email: payerEmail, name: payerName },
      jwt: jwtToken,
      portalRedirect: '/customer/after-pay'
    });

  } catch (e) {
    console.error('capture-order failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});





/* ---------- Webhook Verify (strongly recommended) ---------- */
router.post('/paypal/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // PayPal signature verify
    const {
      'paypal-transmission-id': transmission_id,
      'paypal-transmission-time': transmission_time,
      'paypal-transmission-sig': transmission_sig,
      'paypal-cert-url': cert_url,
      'paypal-auth-algo': auth_algo,
      'webhook-id': webhook_id
    } = req.headers;

    const body = req.body; // Buffer (because express.raw)

    const token = await getAccessToken();
    const verifyRes = await fetch(paypalVerifyUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        auth_algo,
        cert_url,
        transmission_id,
        transmission_sig,
        transmission_time,
        webhook_id: process.env.PAYPAL_WEBHOOK_ID,
        webhook_event: JSON.parse(body.toString('utf8')),
      })
    }).then(r => r.json());

    if (verifyRes.verification_status !== 'SUCCESS') {
      return res.status(400).json({ ok: false, error: 'BAD_SIGNATURE' });
    }

    const event = verifyRes.webhook_event;
    // Handle events:
    // - CHECKOUT.ORDER.APPROVED
    // - PAYMENT.CAPTURE.COMPLETED
    // etc.
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const orderId = event?.resource?.supplementary_data?.related_ids?.order_id;
      const captureId = event?.resource?.id;
      await Payment.findOneAndUpdate(
        { 'paypal.orderId': orderId },
        { $set: { status: 'captured', 'paypal.captureId': captureId } }
      );
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'WEBHOOK_ERROR' });
  }
});

function paypalVerifyUrl() {
  return (process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com') + '/v1/notifications/verify-webhook-signature';
}

async function getAccessToken() {
  const url = (process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com') + '/v1/oauth2/token';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('Failed to get PayPal token');
  return json.access_token;
}



/**
 * GET /api/payments/list?status=&userId=&propertyId=&limit=&skip=&sort=
 * sort examples: -createdAt, createdAt, -amount
 */
// router.get('/list', async (req, res, next) => {
//   try {


//     // add these to destructure:
//     const { status, userId, propertyId, paymentId, orderId, limit = 50, skip = 0, sort = '-createdAt' } = req.query || {};

//     const q = {};
//     if (status) q.status = status;
//     if (userId) q.userId = userId;
//     if (propertyId) q.propertyId = propertyId;

//     // 🔽 new filters
//     if (paymentId) {
//       const ids = String(paymentId).split(',').map(s => s.trim()).filter(Boolean);
//       q._id = { $in: ids };
//     }
//     if (orderId) {
//       const oids = String(orderId).split(',').map(s => s.trim()).filter(Boolean);
//       q['paypal.orderId'] = { $in: oids };
//     }

//     const sortObj = {};
//     sort.split(',').forEach(tok => {
//       const t = tok.trim();
//       if (!t) return;
//       if (t.startsWith('-')) sortObj[t.slice(1)] = -1;
//       else sortObj[t] = 1;
//     });

//     const rows = await Payment.find(q).sort(sortObj).skip(Number(skip)).limit(Number(limit)).lean();
//     res.json({ ok: true, data: rows });
//   } catch (e) { next(e); }
// });



router.get('/list', auth, async (req, res, next) => {
  try {
    const { status, userId, propertyId, paymentId, orderId, limit = 50, skip = 0, sort = '-createdAt' } = req.query || {};

    const q = {};
    if (status) q.status = status;
    if (userId) q.userId = userId;            // explicit filter still allowed
    if (propertyId) q.propertyId = propertyId;

    // NEW: tenant-scope for non-admin
    if (!req.userDoc || req.userDoc.role !== 'admin') {
      q.userId = String(req.userId);          // always pin to self
    }

    if (paymentId) {
      const ids = String(paymentId).split(',').map(s => s.trim()).filter(Boolean);

      // avoid CastErrors on bad ids
      const { Types } = require('mongoose');
      const oidList = ids
        .filter(Types.ObjectId.isValid)
        .map(id => new Types.ObjectId(id));

      if (oidList.length > 0) q._id = { $in: oidList };
      else q._id = { $in: [] };               // nothing matches if all invalid
    }

    if (orderId) {
      const oids = String(orderId).split(',').map(s => s.trim()).filter(Boolean);
      q['paypal.orderId'] = { $in: oids };
    }

    const sortObj = {};
    sort.split(',').forEach(tok => {
      const t = tok.trim();
      if (!t) return;
      sortObj[t.startsWith('-') ? t.slice(1) : t] = t.startsWith('-') ? -1 : 1;
    });

    const rows = await Payment.find(q).sort(sortObj).skip(Number(skip)).limit(Number(limit)).lean();
    res.json({ ok: true, data: rows });
  } catch (e) { next(e); }
});


// -------- DEBUG: insert a captured Payment for testing monthly aggregation --------
router.post('/__debug/insert', async (req, res, next) => {
  try {
    let {
      userId = 'demo-user-001',
      propertyId = 'PROP-DEMO-001',
      amount = 49.99,
      currency = 'USD',
      status = 'captured',                 // created | approved | captured
      createdAt = '2025-09-15T12:00:00.000Z',
      orderId = 'DBG-ORDER-001',
      captureId,
      // 👇 optional: set a specific type if your schema enum requires (e.g., 'one_time' | 'subscription')
      type = 'one_time',
      quoteHash = undefined,               // optional; only if your schema requires/binds pricing snapshots
    } = req.body || {};

    // ensure unique debug captureId if not provided
    if (!captureId) captureId = `DBG-CAP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    // ensure numeric
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ ok: false, error: 'amount must be > 0' });

    const doc = await (new Payment({
      type,                                // ✅ REQUIRED by your schema
      userId,
      propertyId,
      amount: amt,
      currency,
      status,
      quoteHash,                           // keep undefined if not required
      paypal: {
        orderId,
        captureId,
        rawCreateResponse: { debug: true },
        rawCaptureResponse: { debug: true },
      },
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    })).save();

    res.json({ ok: true, data: doc });
  } catch (e) { next(e); }
});

/**
 * DEBUG ONLY: force mark an order as captured (no PayPal API call)
 * POST /api/payments/__debug/capture
 * Body: { orderId: string, amount?: number }
 */
router.post('/__debug/capture', async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ ok: false, error: 'forbidden in production' });
    }
    const { orderId, amount } = req.body || {};
    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });

    const payDoc = await Payment.findOneAndUpdate(
      { 'paypal.orderId': orderId },
      {
        $set: {
          status: 'captured',
          ...(amount ? { amount: Number(amount) } : {}),
          'paypal.captureId': `DBG-${Date.now()}`
        }
      },
      { new: true }
    ).lean();

    if (!payDoc) return res.status(404).json({ ok: false, error: 'payment not found' });

    // create invoice (same logic as real capture)
    try {
      const Invoice = require('../../models/Invoice');
      const lineAmt = Number(payDoc.amount || 0);
      const line = {
        sku: 'SERVICE-ONBOARDING',
        description: 'Host Onboarding Service',
        qty: 1,
        unitPrice: lineAmt,
        amount: lineAmt,
      };
      const existing = await Invoice.findOne({
        customerId: payDoc.userId || undefined,
        propertyId: payDoc.propertyId || undefined,
        payments: payDoc._id,
      }).lean();
      if (!existing) {
        await (new Invoice({
          customerId: payDoc.userId || undefined,
          propertyId: payDoc.propertyId || undefined,
          lines: [line],
          subtotal: lineAmt,
          tax: 0,
          total: lineAmt,
          status: 'paid',
          payments: [payDoc._id],
        })).save();
      }
    } catch (e) {
      console.error('DEBUG capture: invoice creation failed:', e.message);
    }

    // --- CREATE JOBS from cart.schedule (DEBUG path only) ---
    try {
      const Job = require('../../models/Job');

      // cart from PS body
      const bodyCart = (req.body && req.body.cart) ? req.body.cart : {};
      const schedule = Array.isArray(bodyCart.schedule) ? bodyCart.schedule : [];
      const prop = bodyCart.property || {};
      const propIdFromCart = bodyCart.propertyId;

      // 💰 SPLIT (DEBUG): total -> per-visit shares
      const totalPaidDbg = Number(paySaved?.amount ?? amount ?? 0);
      const nVisitsDbg = Math.max(0, schedule.length);
      const visitCurrencyDbg = String(paySaved?.currency || 'USD').toUpperCase();

      let shareCentsArrDbg = [];
      if (nVisitsDbg > 0) {
        const cents = Math.round(totalPaidDbg * 100);
        const base = Math.floor(cents / nVisitsDbg);
        const rem = cents - base * nVisitsDbg;
        shareCentsArrDbg = Array.from({ length: nVisitsDbg }, (_, i) => base + (i < rem ? 1 : 0));
      }


      // use the payDoc we already updated above (DON'T shadow the name)
      const paySaved = payDoc; // <- payDoc from the findOneAndUpdate earlier

      const customerId = paySaved?.userId ? String(paySaved.userId) : 'demo-user-001';
      const propertyId = propIdFromCart || paySaved?.propertyId || undefined;

      const estMins =
        (Number(bodyCart?.aiEstimateMinutes) > 0 && Number(bodyCart.aiEstimateMinutes)) || 120;

      const jobsToInsert = [];
      for (let i = 0; i < schedule.length; i++) {
        const s = schedule[i];
        if (!s?.date || !s?.time) continue;

        const startIso = `${s.date}T${s.time}:00.000Z`;
        const start = new Date(startIso);
        const end = new Date(start.getTime() + estMins * 60 * 1000);

        const priceUsd = shareCentsArrDbg.length ? (shareCentsArrDbg[i] / 100) : 0;

        jobsToInsert.push({
          customerId,
          propertyId,
          property: {
            address: prop.address || '',
            city: prop.city || '',
            state: prop.state || '',
            zip: prop.zip || '',
          },
          date: start,
          window: { start, end },
          status: 'pending',
          durationMinutes: estMins,
          ai: { minutes: estMins },
          aiEstimateMinutes: estMins,
          offer: {
            status: 'sent',
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
          candidates: [],
          priceUsd,
          currency: visitCurrencyDbg,
        });
      }

      let createdJobs = 0;
      if (jobsToInsert.length) {
        const inserted = await Job.insertMany(jobsToInsert);
        createdJobs = inserted.length;
        console.log(`DEBUG capture: created ${createdJobs} job(s) from schedule`);
      } else {
        console.log('DEBUG capture: no schedule provided => no jobs created');
      }

      // --- emit CEOLive events (DEBUG) ---
      try {
        await Event.create({
          type: 'payment_captured',
          message: `[DEBUG] Payment captured ${payDoc.amount}`,
          propertyId: payDoc.propertyId || null,
          orderId,
          paymentId: String(payDoc._id || ''),
          userId: String(payDoc.userId || ''),
          meta: { debug: true }
        });

        if (createdJobs > 0) {
          await Event.create({
            type: 'jobs_created',
            message: `[DEBUG] Created ${createdJobs} cleaning job(s)`,
            propertyId: payDoc.propertyId || null,
            orderId,
            paymentId: String(payDoc._id || ''),
            userId: String(payDoc.userId || ''),
            meta: {
              dates: (bodyCart.schedule || []).map(s => `${s.date} ${s.time}`),
              durationMinutes: estMins,
              debug: true
            }
          });
        }
      } catch (e) {
        console.warn('debug events emit failed:', e.message);
      }


      // return with a proper field instead of __createdJobs
      return res.json({ ok: true, data: paySaved, createdJobs });
    } catch (err) {
      console.error('DEBUG capture: failed to create jobs from cart:', err.message);
      return res.json({ ok: true, data: payDoc, createdJobs: 0 });
    }



  } catch (e) { next(e); }
});


// DEBUG: mark payments void so they are excluded from invoices
router.post('/__debug/mark-void', async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ ok: false, error: 'forbidden in production' });
    }
    const { ids = [] } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ ok: false, error: 'ids[] required' });
    }
    const r = await Payment.updateMany({ _id: { $in: ids } }, { $set: { status: 'void' } });
    res.json({ ok: true, modified: r.modifiedCount });
  } catch (e) { next(e); }
});

// DEBUG: void by orderIds or captureIds
router.post('/__debug/mark-void-by', async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ ok: false, error: 'forbidden in production' });
    }
    const { orderIds = [], captureIds = [] } = req.body || {};
    const or = [];
    if (Array.isArray(orderIds) && orderIds.length) or.push({ 'paypal.orderId': { $in: orderIds } });
    if (Array.isArray(captureIds) && captureIds.length) or.push({ 'paypal.captureId': { $in: captureIds } });
    if (!or.length) return res.status(400).json({ ok: false, error: 'orderIds[] or captureIds[] required' });

    const r = await Payment.updateMany({ status: 'captured', $or: or }, { $set: { status: 'void' } });
    res.json({ ok: true, modified: r.modifiedCount });
  } catch (e) { next(e); }
});





module.exports = router;

