// services/api/src/routes/invoices.route.js
const express = require('express');
const router = express.Router();
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const fetch = require('node-fetch');
const { cloudinary } = require('../services/cloudinary');

// ✅ import the middleware you actually export
const { auth: requireAuth } = require('../../middleware/auth');

// ✅ mount ONCE for the whole router (not inside handlers)
router.use(requireAuth);

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

/* ----------------- LIST ----------------- */
router.get('/', async (req, res, next) => {
  try {
    const { customerId, propertyId, month, year, limit = 50, skip = 0 } = req.query || {};
    const q = {};

    // ✅ Role + tenancy
    const role = (req.userDoc?.role || req.user?.role || '').toLowerCase();
    const myId = getMyId(req);

    // Default: restrict to current customer unless admin/ops
    if (role !== 'admin' && role !== 'ops') {
      if (!myId) return res.status(401).json({ ok: false, error: 'unauthorized' });
      q.customerId = myId;
    } else {
      // admins/ops: optional filters
      if (customerId) q.customerId = customerId;
    }

    if (propertyId) q.propertyId = propertyId;
    if (month || year) {
      if (month) q['period.month'] = Number(month);
      if (year)  q['period.year']  = Number(year);
    }

    const rows = await Invoice.find(q)
      .sort({ createdAt: -1 })
      .skip(Number(skip))
      .limit(Number(limit))
      .lean();

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

    const doc = await (new Invoice({
      customerId, propertyId,
      lines,
      subtotal, tax, total,
      pdfUrl,
      payments,
      period: period || undefined,
      status: 'paid', // if linked to successful payment; else 'issued'
    })).save();

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
      status: 'captured',
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
        customerId: uid === 'NA' ? undefined : uid,
        propertyId: pid === 'NA' ? undefined : pid,
        'period.month': m,
        'period.year': y,
      };

      // find existing invoice for this group+period
      const existing = await Invoice.findOne(qExist).lean();

      if (existing) {
        if (mode === 'createOnly') continue; // keep old behavior (skip)

        // Recompute to a single monthly line and replace totals + payments set
        const newDoc = await Invoice.findByIdAndUpdate(
          existing._id,
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
        await (new Invoice({
          customerId: uid === 'NA' ? undefined : uid,
          propertyId: pid === 'NA' ? undefined : pid,
          period: { month: m, year: y },
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
          payments,
        })).save();
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

    const doc = await Invoice.findByIdAndUpdate(id, { $set }, { new: true }).lean();
    if (!doc) return res.status(404).json({ ok: false, error: 'invoice not found' });

    res.json({ ok: true, data: doc });
  } catch (e) { next(e); }
});


// GET /api/invoices/:id/pdf?download=0|1
router.get('/:id/pdf', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { download = '0' } = req.query;

    const inv = await Invoice.findById(id).lean();
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

    const inv = await Invoice.findById(id).lean();
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

    if (debug === '1') {
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
