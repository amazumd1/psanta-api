// services/api/src/routes/invoices.route.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const fetch = require('node-fetch');
const { cloudinary } = require('../services/cloudinary');
const mongoose = require('mongoose');
const { auth: requireAuth } = require("../../middleware/auth");
const { requireTenantAccess } = require("../../middleware/tenantAccess");
const { makeRateLimiter } = require("../../middleware/rateLimit");


const publicInvoiceLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: process.env.NODE_ENV === "production" ? 120 : 300,
  keyPrefix: "invoice_public",
});

const syncFromFsLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: process.env.NODE_ENV === "production" ? 30 : 120,
  keyPrefix: "invoice_sync",
});

function validateRequest(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  return res.status(400).json({
    ok: false,
    error: "validation_failed",
    details: result.array().map((item) => ({
      field: item.path,
      message: item.msg,
    })),
  });
}

function requireNonProdDebug(req, res, next) {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ ok: false, error: "Not found" });
  }
  return next();
}

router.use("/__debug", requireNonProdDebug);


// this is for manual invoices -->

// PUBLIC: email / pay link ke liye lightweight invoice view (no auth)
router.get('/public/:invoiceId', publicInvoiceLimiter, async (req, res, next) => {
  try {
    const { invoiceId } = req.params;

    let invoice = null;

    // 1) Agar ye 24-char valid ObjectId hai to _id se find karo
    if (mongoose.Types.ObjectId.isValid(invoiceId)) {
      invoice = await Invoice.findById(invoiceId).lean();
    } else {
      // 2) Nahi to Firestore style id assume karo (e.g. ZuCW8SkPtHThzuRSXWnv)
      //    aur fsId field par search karo (neeche model me add karenge)
      invoice = await Invoice.findOne({ fsId: invoiceId }).lean();
    }

    if (!invoice) {
      return res
        .status(404)
        .json({ ok: false, error: 'Invoice not found for this id' });
    }

    const total = Number(invoice.total || 0);
    const alreadyPaid = Number(invoice.amountPaid || 0);
    let balanceDue =
      typeof invoice.balanceDue === 'number'
        ? Number(invoice.balanceDue)
        : total - alreadyPaid;

    if (Number.isNaN(balanceDue)) balanceDue = 0;
    if (balanceDue < 0) balanceDue = 0;

    return res.json({
      ok: true,
      data: {
        _id: invoice._id,
        number: invoice.number,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        status: invoice.status,
        subtotal: invoice.subtotal,
        taxTotal: invoice.tax,
        discountTotal: invoice.discountTotal,
        total,
        amountPaid: alreadyPaid,
        balanceDue,
        customerName: invoice.customerName || invoice.customer?.name,
        customerEmail: invoice.customerEmail || invoice.customer?.email,
        customerAddress: invoice.customerAddress || '',
        // monthly invoices ke liye lines bhi support kar lo
        lineItems: invoice.lineItems || invoice.lines || [],
      },
    });
  } catch (err) {
    next(err);
  }
});

// PUBLIC: ops-app Firestore invoice ko Mongo me sync/upsert karne ke liye
// body me fsId etc aayega
router.post(
  '/sync-from-fs',
  syncFromFsLimiter,
  requireAuth,
  requireTenantAccess,
  [
    body('fsId').isString().trim().notEmpty(),
    body('number').optional({ nullable: true }).isString().trim(),
    body('issueDate').optional({ nullable: true }).isString(),
    body('dueDate').optional({ nullable: true }).isString(),
    body('status').optional({ nullable: true }).isString().trim(),
    body('subtotal').optional({ nullable: true }).isNumeric(),
    body('taxTotal').optional({ nullable: true }).isNumeric(),
    body('discountTotal').optional({ nullable: true }).isNumeric(),
    body('total').optional({ nullable: true }).isNumeric(),
    body('amountPaid').optional({ nullable: true }).isNumeric(),
    body('balanceDue').optional({ nullable: true }).isNumeric(),
    body('customerName').optional({ nullable: true }).isString(),
    body('customerEmail').optional({ checkFalsy: true }).isEmail(),
    body('customerAddress').optional({ nullable: true }).isString(),
    body('lineItems').optional({ nullable: true }).isArray(),
  ],
  validateRequest,
  async (req, res, next) => {
    try {
      const {
        fsId,
        number,
        issueDate,
        dueDate,
        status = 'issued',
        subtotal = 0,
        taxTotal = 0,
        discountTotal = 0,
        total = 0,
        amountPaid = 0,
        balanceDue,
        customerName,
        customerEmail,
        customerAddress,
        lineItems = [],
      } = req.body || {};

      if (!fsId) {
        return res.status(400).json({ ok: false, error: 'fsId required' });
      }

      const safeSubtotal = Number(subtotal) || 0;
      const safeTax = Number(taxTotal) || 0;
      const safeDiscount = Number(discountTotal) || 0;
      const safeTotal =
        Number(total) || Number((safeSubtotal + safeTax - safeDiscount).toFixed(2));
      const safePaid = Number(amountPaid) || 0;

      let safeBalance =
        typeof balanceDue === 'number'
          ? Number(balanceDue)
          : Number((safeTotal - safePaid).toFixed(2));

      if (!Number.isFinite(safeBalance)) safeBalance = 0;

      const update = {
        fsId,
        number: number || fsId,
        issueDate: issueDate || null,
        dueDate: dueDate || null,
        status,
        subtotal: safeSubtotal,
        tax: safeTax,
        discountTotal: safeDiscount,
        total: safeTotal,
        amountPaid: safePaid,
        balanceDue: safeBalance,
        customerName: customerName || null,
        customerEmail: customerEmail || null,
        customerAddress: customerAddress || null,
        lineItems,
      };

      const doc = await Invoice.findOneAndUpdate(
        { tenantId: req.tenantId, fsId },
        { $set: { ...update, tenantId: req.tenantId } },
        { new: true, upsert: true }
      ).lean();

      return res.json({ ok: true, data: doc });
    } catch (err) {
      next(err);
    }
  });



router.use(requireAuth, requireTenantAccess);

function tenantFilter(req, extra = {}) {
  return { tenantId: req.tenantId, ...extra };
}

function tenantIdFilter(req, id) {
  return { _id: id, tenantId: req.tenantId };
}

function getMyId(req) {
  return String(
    req.user?.userId ||
    req.user?._id ||
    req.userId ||
    req.userDoc?._id ||
    req.userDoc?.id ||
    ''
  ).trim();
}

function getMyEmail(req) {
  return String(
    req.userDoc?.email ||
    req.user?.email ||
    ''
  )
    .trim()
    .toLowerCase();
}

function customerInvoiceVisibilityOr(req) {
  const myId = getMyId(req);
  const myEmail = getMyEmail(req);

  return [
    myId ? { customerId: myId } : null,
    myEmail ? { customerEmail: myEmail } : null,
  ].filter(Boolean);
}

function customerPaymentVisibilityOr(req) {
  const myId = getMyId(req);
  const myEmail = getMyEmail(req);

  return [
    myId ? { userId: myId } : null,
    myEmail ? { customerEmail: myEmail } : null,
  ].filter(Boolean);
}

function lineFromPayment(payment = {}) {
  const cart = payment.cart || {};
  const amount = Number(payment.amount || payment.gross || 0);

  const label =
    cart?.property?.serviceRequestLabel ||
    cart?.property?.serviceType ||
    cart?.planName ||
    'AI Cleaning Service';

  return {
    sku: 'SERVICE-CLEANING',
    description: String(label).replace(/[_-]+/g, ' '),
    qty: 1,
    unitPrice: amount,
    amount,
  };
}

async function backfillPaidInvoicesForCapturedPayments(req, opts = {}) {
  const role = (req.userDoc?.role || req.user?.role || '').toLowerCase();
  const myId = getMyId(req);
  const myEmail = getMyEmail(req);

  const pq = {
    tenantId: req.tenantId,
    status: 'captured',
  };

  if (role !== 'admin' && role !== 'ops') {
    const ownership = customerPaymentVisibilityOr(req);
    if (!ownership.length) return 0;
    pq.$or = ownership;
  } else if (opts.customerId) {
    pq.userId = opts.customerId;
  }

  if (opts.propertyId) {
    const propertyOr = [
      { propertyId: opts.propertyId },
      { 'cart.propertyId': opts.propertyId },
      { 'cart.propertyMongoId': opts.propertyId },
    ];

    if (pq.$or) {
      pq.$and = [{ $or: pq.$or }, { $or: propertyOr }];
      delete pq.$or;
    } else {
      pq.$or = propertyOr;
    }
  }

  const payments = await Payment.find(pq)
    .sort({ createdAt: -1 })
    .limit(25)
    .lean();

  let created = 0;

  for (const payment of payments) {
    const existing = await Invoice.findOne({
      tenantId: req.tenantId,
      payments: payment._id,
    }).lean();

    if (existing) {
      const patch = {};

      if (!existing.customerId && (payment.userId || myId)) {
        patch.customerId = String(payment.userId || myId);
      }

      if (!existing.customerEmail && (payment.customerEmail || myEmail)) {
        patch.customerEmail = String(payment.customerEmail || myEmail).toLowerCase();
      }

      if (!Array.isArray(existing.lineItems) || !existing.lineItems.length) {
        const lines =
          Array.isArray(existing.lines) && existing.lines.length
            ? existing.lines
            : [lineFromPayment(payment)];

        patch.lineItems = lines;
      }

      if (Object.keys(patch).length) {
        await Invoice.updateOne(
          { _id: existing._id, tenantId: req.tenantId },
          { $set: patch }
        );
      }

      if (!payment.invoice) {
        await Payment.updateOne(
          { _id: payment._id, tenantId: req.tenantId },
          { $set: { invoice: existing._id } }
        );
      }

      continue;
    }

    const amount = Number(payment.amount || payment.gross || 0);
    const line = lineFromPayment(payment);

    const propertyId = String(
      payment?.cart?.propertyMongoId ||
      payment?.propertyId ||
      ''
    ).trim();

    const customerId = String(payment.userId || myId || '').trim();

    const customerEmail = String(
      payment.customerEmail ||
      myEmail ||
      payment?.cart?.customerEmail ||
      ''
    )
      .trim()
      .toLowerCase();

    const createdAt = payment.createdAt ? new Date(payment.createdAt) : new Date();

    const inv = await new Invoice({
      tenantId: req.tenantId,
      customerId: customerId || undefined,
      customerEmail: customerEmail || undefined,
      propertyId: propertyId || undefined,
      year: createdAt.getFullYear(),
      profitChannel: payment.profitChannel || 'customer',

      lines: [line],
      lineItems: [line],

      subtotal: amount,
      tax: 0,
      total: amount,
      amountPaid: amount,
      balanceDue: 0,
      status: 'paid',
      payments: [payment._id],
    }).save();

    await Payment.updateOne(
      { _id: payment._id, tenantId: req.tenantId },
      { $set: { invoice: inv._id } }
    );

    created += 1;
  }

  return created;
}

/* ----------------- LIST ----------------- */
router.get('/', async (req, res, next) => {
  try {
    const { customerId, propertyId, month, year, limit = 50, skip = 0 } = req.query || {};
    const q = { tenantId: req.tenantId };

    // ✅ Role + tenancy
    const role = (req.userDoc?.role || req.user?.role || '').toLowerCase();
    const myId = getMyId(req);

    // Default: restrict to current customer unless admin/ops
    if (role !== 'admin' && role !== 'ops') {
      const ownership = customerInvoiceVisibilityOr(req);

      if (!ownership.length) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }

      q.$or = ownership;
    } else {
      if (customerId) q.customerId = customerId;
    }

    if (propertyId) q.propertyId = propertyId;
    if (month || year) {
      if (month) q['period.month'] = Number(month);
      if (year) q['period.year'] = Number(year);
    }

    await backfillPaidInvoicesForCapturedPayments(req, {
      customerId,
      propertyId,
    });

    const rows = await Invoice.find(q)
      .sort({ createdAt: -1 })
      .skip(Number(skip))
      .limit(Number(limit))
      .lean();

    if (role !== 'admin' && role !== 'ops' && myId && getMyEmail(req)) {
      const myEmail = getMyEmail(req);

      const idsToPatch = rows
        .filter((inv) => {
          return (
            !String(inv.customerId || '').trim() &&
            String(inv.customerEmail || '').toLowerCase() === myEmail
          );
        })
        .map((inv) => inv._id);

      if (idsToPatch.length) {
        await Invoice.updateMany(
          {
            tenantId: req.tenantId,
            _id: { $in: idsToPatch },
          },
          {
            $set: { customerId: myId },
          }
        );

        rows.forEach((inv) => {
          if (idsToPatch.some((id) => String(id) === String(inv._id))) {
            inv.customerId = myId;
          }
        });
      }
    }

    res.json({ ok: true, data: rows });
  } catch (e) { next(e); }
});





// POST /api/invoices  (optional manual creation; ops-app ya cron se call kar sakte ho)
router.post('/', async (req, res, next) => {
  try {
    const { customerId, propertyId, lines = [], tax = 0, pdfUrl, payments = [], period } = req.body || {};
    if (!customerId && !propertyId) return res.status(400).json({ ok: false, error: 'customerId or propertyId required' });

    const subtotal = lines.reduce((s, l) => s + (Number(l.amount ?? (l.qty || 1) * (l.unitPrice || 0)) || 0), 0);
    const total = Number((subtotal + Number(tax || 0)).toFixed(2));

    const doc = await (
      new Invoice({
        tenantId: req.tenantId,
        customerId,
        propertyId,
        lines,
        subtotal,
        tax,
        total,
        pdfUrl,
        payments,
        period: period || undefined,
        status: "paid",
      })
    ).save();

    res.json({ ok: true, data: doc });
  } catch (e) { next(e); }
});



/**
 * GET /api/invoices/generate-monthly?year=YYYY&month=MM&customerId=&propertyId=&mode=
 * mode:
 *  - upsert (default): if invoice exists for (cust, prop, period), update it by re-aggregating whole month
 *  - createOnly: keep old behavior, skip if exists
 */
router.get('/generate-monthly', async (req, res, next) => {
  try {
    const y = Number(req.query.year);
    const m = Number(req.query.month); // 1-12
    const { customerId, propertyId, mode = 'upsert' } = req.query || {};
    if (!y || !m || m < 1 || m > 12) {
      return res.status(400).json({ ok: false, error: 'Valid year & month required' });
    }

    const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
    const end = new Date(Date.UTC(y, m, 1, 0, 0, 0)); // exclusive

    const pq = {
      tenantId: req.tenantId,
      status: "captured",
      createdAt: { $gte: start, $lt: end },
    };
    if (customerId) pq.userId = customerId;
    if (propertyId) pq.propertyId = propertyId;

    const pays = await Payment.find(pq).lean();
    if (!pays.length) {
      return res.json({ ok: true, created: 0, updated: 0, message: 'No captured payments in range', period: { month: m, year: y } });
    }

    // group by (userId, propertyId)
    const groups = new Map();
    for (const p of pays) {
      const key = `${p.userId || 'NA'}|${p.propertyId || 'NA'}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    let created = 0, updated = 0;
    for (const [key, arr] of groups.entries()) {
      const [uid, pid] = key.split('|');
      const payments = arr.map(x => x._id);
      const sum = Number(arr.reduce((s, x) => s + Number(x.amount || 0), 0).toFixed(2));

      const qExist = {
        tenantId: req.tenantId,
        customerId: uid === "NA" ? undefined : uid,
        propertyId: pid === "NA" ? undefined : pid,
        "period.month": m,
        "period.year": y,
      };

      // find existing invoice for this group+period
      const existing = await Invoice.findOne(qExist).lean();

      if (existing) {
        if (mode === 'createOnly') continue; // keep old behavior (skip)

        // Recompute to a single monthly line and replace totals + payments set
        const newDoc = await Invoice.findOneAndUpdate(
          { _id: existing._id, tenantId: req.tenantId },
          {
            $set: {
              lines: [{
                sku: 'SERVICE-MONTHLY',
                description: `Monthly services for ${m}/${y}`,
                qty: 1,
                unitPrice: sum,
                amount: sum,
              }],
              subtotal: sum,
              tax: 0,
              total: sum,
              status: 'paid',
              period: { month: m, year: y },
              payments, // replace with full set for the month
            }
          },
          { new: true }
        ).lean();
        updated++;
      } else {
        await (
          new Invoice({
            tenantId: req.tenantId,
            customerId: uid === "NA" ? undefined : uid,
            propertyId: pid === "NA" ? undefined : pid,
            period: { month: m, year: y },
            lines: [
              {
                sku: "SERVICE-MONTHLY",
                description: `Monthly services for ${m}/${y}`,
                qty: 1,
                unitPrice: sum,
                amount: sum,
              },
            ],
            subtotal: sum,
            tax: 0,
            total: sum,
            status: "paid",
            payments,
          })
        ).save();
        created++;
      }
    }

    res.json({ ok: true, created, updated, period: { month: m, year: y } });
  } catch (e) { next(e); }
});


// ...file ke bottom ke paas yeh block ADD karo:

/**
 * PATCH /api/invoices/:id
 * Body: { pdfUrl?: string, status?: 'issued'|'paid'|'void' }
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params || {};
    const { pdfUrl, status } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });

    const $set = {};
    if (typeof pdfUrl === 'string') $set.pdfUrl = pdfUrl;
    if (status && ['issued', 'paid', 'void'].includes(status)) $set.status = status;
    if (!Object.keys($set).length) return res.status(400).json({ ok: false, error: 'nothing to update' });

    const doc = await Invoice.findOneAndUpdate(
      tenantIdFilter(req, id),
      { $set },
      { new: true }
    ).lean();
    if (!doc) return res.status(404).json({ ok: false, error: 'invoice not found' });

    res.json({ ok: true, data: doc });
  } catch (e) { next(e); }
});

// DELETE /api/invoices/:id  – hard delete from Mongo
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params || {};
    if (!id) {
      return res
        .status(400)
        .json({ ok: false, error: 'Invoice id required' });
    }

    // (optional) role check – sirf admin/ops ko allow karna ho to uncomment:
    // const role = (req.userDoc?.role || req.user?.role || '').toLowerCase();
    // if (role !== 'admin' && role !== 'ops') {
    //   return res.status(403).json({ ok: false, error: 'forbidden' });
    // }

    const inv = await Invoice.findOne(tenantIdFilter(req, id));
    if (!inv) {
      return res
        .status(404)
        .json({ ok: false, error: 'Invoice not found' });
    }

    // ❌ Mongo se hatao
    await inv.deleteOne();

    // (optional) agar tum Firestore me bhi mirror rakhte ho to yahan clean-up kar sakte ho
    // try {
    //   await firestore.collection('invoices').doc(String(id)).delete();
    // } catch (e) {
    //   console.error('Firestore invoice delete failed:', e);
    // }

    return res.json({
      ok: true,
      data: { id },
    });
  } catch (err) {
    console.error('DELETE /invoices/:id error', err);
    return res.status(500).json({
      ok: false,
      error: err.message || 'Server error',
    });
  }
});



// GET /api/invoices/:id/pdf?download=0|1
router.get('/:id/pdf', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { download = '0' } = req.query;



    if (!inv || !inv.pdfUrl) {
      return res.status(404).json({ ok: false, error: 'PDF_NOT_SET' });
    }

    // fetch the Cloudinary file server-side
    const r = await fetch(inv.pdfUrl);
    if (!r.ok) {
      const msg = await r.text().catch(() => r.statusText);
      return res.status(502).json({ ok: false, error: 'CLOUDINARY_FETCH_FAILED', status: r.status, detail: msg });
    }

    // forward headers safely
    const disp = download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disp}; filename="invoice-${id}.pdf"`);

    // stream it
    r.body.pipe(res);
  } catch (e) { next(e); }
});


// --------- helpers: parse publicId + resourceType from saved url ----------
function parseFromUrl(url) {
  // resource_type (raw|image)
  const rt = (url.match(/\/(raw|image)\/upload\//i)?.[1] || 'raw').toLowerCase();

  // public_id (without .pdf), supports optional s--sig--/v123 blocks
  // matches:
  //   .../upload/v123/.../INV-xxx.pdf
  //   .../upload/s--abc123xyz--/v1/.../INV-xxx.pdf
  const m = url.match(/\/upload\/(?:s--[A-Za-z0-9_-]{10,}--\/)?v\d+\/(.+?)\.pdf(?:$|\?)/i);
  if (!m) return { ok: false, error: 'BAD_CLOUDINARY_URL' };
  const publicId = m[1]; // e.g. 1099_forms/INV-...

  return { ok: true, publicId, resourceType: rt };
}


// --------- probe Cloudinary to find correct delivery "type" ----------
async function findResourceVariant(publicId, resourceType) {
  // we will try these combinations in order:
  const candidates = [
    { type: 'upload', resource_type: resourceType },
    { type: 'authenticated', resource_type: resourceType },
    { type: 'private', resource_type: resourceType },
    // also try opposite resource_type in case legacy invoices are image/raw swapped
    { type: 'upload', resource_type: resourceType === 'raw' ? 'image' : 'raw' },
    { type: 'authenticated', resource_type: resourceType === 'raw' ? 'image' : 'raw' },
    { type: 'private', resource_type: resourceType === 'raw' ? 'image' : 'raw' },
  ];

  // use Admin API to check which one exists
  for (const c of candidates) {
    try {
      // will throw if not found / not accessible
      await cloudinary.api.resource(publicId, { type: c.type, resource_type: c.resource_type });
      return { ok: true, ...c };
    } catch (e) {
      // continue
    }
  }
  return { ok: false, error: 'RESOURCE_NOT_FOUND_IN_ANY_TYPE' };
}
// GET /api/invoices/:id/pdf-signed?download=0|1
router.get('/:id/pdf-signed', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { download = '0', debug = '0' } = req.query;

    const inv = await Invoice.findOne(tenantIdFilter(req, id)).lean();
    if (!inv || !inv.pdfUrl) return res.status(404).json({ ok: false, error: 'PDF_NOT_SET' });

    // Parse publicId + guessed resourceType from stored URL
    const parsed = parseFromUrl(inv.pdfUrl);
    if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });

    const { publicId } = parsed;

    // We know from your debug that the asset exists as image/upload.
    // Try combos in this order (NO format/flags in URL options).
    const combos = [
      { resource_type: 'image', type: 'upload' },         // <- Admin API said this exists
      { resource_type: 'image', type: 'authenticated' },
      { resource_type: 'image', type: 'private' },
      { resource_type: 'raw', type: 'upload' },
      { resource_type: 'raw', type: 'authenticated' },
      { resource_type: 'raw', type: 'private' },
    ];

    const tried = [];
    let chosen = null;

    for (const c of combos) {
      const opts = {
        resource_type: c.resource_type,
        type: c.type,
        secure: true,
        sign_url: true,
        expires_at: Math.floor(Date.now() / 1000) + 300, // 5 min
        // NOTE: NO format, NO flags — keep URL plain
      };

      const u = cloudinary.url(publicId, opts);

      // Instead of HEAD (some setups reject HEAD), do a lightweight GET and cancel if bad.
      try {
        const r = await fetch(u, { method: 'GET' });
        tried.push({ try: c, status: r.status, ct: r.headers.get('content-type') || null, url: u });

        if (r.ok) {
          chosen = { url: u, combo: c, resp: r };
          break;
        } else {
          // read and discard a small portion to free socket (optional)
          await r.arrayBuffer().catch(() => { });
        }
      } catch (e) {
        tried.push({ try: c, error: e.message, url: u });
      }
    }

    if (debug === '1' && process.env.NODE_ENV !== 'production') {
      return res.json({
        ok: !!chosen,
        parsed,
        tried,
        chosen: chosen ? { combo: chosen.combo, url: chosen.url } : null
      });
    }


    if (!chosen) {
      // Fallback: try the saved pdfUrl once.
      try {
        if (inv.pdfUrl) {
          const test = await fetch(inv.pdfUrl, { method: 'GET' });
          if (test.ok) {
            const disp = download === '1' ? 'attachment' : 'inline';
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `${disp}; filename="invoice-${id}.pdf"`);
            return test.body.pipe(res);
          }
        }
      } catch (_) { }
      // Graceful not-found for legacy/missing files
      return res.status(404).json({ ok: false, error: 'PDF_MISSING', tried });
    }


    // Stream bytes and set disposition ourselves
    const disp = download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disp}; filename="invoice-${id}.pdf"`);

    chosen.resp.body.pipe(res);
  } catch (e) {
    next(e);
  }
});


// GET /api/invoices/__debug/cloudinary?publicId=1099_forms/INV-...&rt=raw|image&type=upload|authenticated|private
router.get('/__debug/cloudinary', async (req, res) => {
  try {
    const { cloudinary } = require('../services/cloudinary');
    const cfg = cloudinary.config();

    // 1) Basic config presence (no secrets exposed)
    const configOk = !!(cfg.cloud_name && cfg.api_key && cfg.api_secret);

    // 2) Ping Admin API (requires correct key/secret)
    let ping, pingErr;
    try {
      ping = await cloudinary.api.ping(); // {status: "ok"} on success
    } catch (e) {
      pingErr = e?.response?.text || e?.message || String(e);
    }

    // 3) Optionally test a specific asset variant via Admin API
    const { publicId, rt = 'raw', type = 'upload' } = req.query || {};
    let resource, resourceErr;
    if (publicId) {
      try {
        resource = await cloudinary.api.resource(publicId, {
          resource_type: rt,
          type,
        });
      } catch (e) {
        resourceErr = e?.response?.text || e?.message || String(e);
      }
    }

    res.json({
      ok: true,
      configPresent: configOk,
      cloud_name: cfg.cloud_name,
      api_key_present: !!cfg.api_key,
      api_secret_present: !!cfg.api_secret,
      ping: ping || null,
      pingErr: pingErr || null,
      testPublicId: publicId || null,
      testVariant: publicId ? { rt, type } : null,
      resourceOk: !!resource,
      resourceErr: resourceErr || null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});




module.exports = router;
