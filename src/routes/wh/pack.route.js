// services/api/src/routes/wh/pack.route.js
const express = require('express');
const router = express.Router();

const WarehouseJob = require('../../../models/WarehouseJob');
const { gToLbOz } = require('../../../utils/weight'); // tolerance calc local, distribute local

// GET /api/wh/jobs/:jobId/status
// Tip: add ?events=10 to also return last N pack events
router.get('/jobs/:jobId/status', async (req, res, next) => {
  try {
    const limitEvents = Math.max(0, Math.min(50, Number(req.query.events || 0)));
    const job = await WarehouseJob.findOne({ jobId: req.params.jobId }).lean();
    if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });

    const payload = {
      ok: true,
      job: {
        jobId: job.jobId,
        status: job.status || null,
        expected_carton_weight_g: Number(job.expected_carton_weight_g || 0),
        carton_tare_g: Number(job.carton_tare_g || 0),
        packed_gross_g: Number(job.packed_gross_g || 0),
        packed_net_g: Number(job.packed_net_g || 0),
        pass: (typeof job.pass === 'boolean') ? job.pass : null,
        variance_g: (typeof job.variance_g === 'number') ? job.variance_g : null,
        tol_g: (typeof job.tolerance_g === 'number') ? job.tolerance_g : null,
        tol_pct: (typeof job.tolerance_pct === 'number') ? job.tolerance_pct : null,
        sscc: job.sscc || job.jobId,
        closedAt: job.closedAt || null,
        lines: Array.isArray(job.lines) ? job.lines : [],
      },
    };

    if (limitEvents && Array.isArray(job.pack_events)) {
      payload.job.pack_events = job.pack_events.slice(-limitEvents);
    }

    return res.json(payload);
  } catch (e) { next(e); }
});

// POST /api/wh/jobs/:jobId/pack/weight
// body: { packed_carton_weight_g (required, gross), tare_g?, scale_capture_raw?, pack_session_id?,
//         sscc?, note?, source?, scale_serial?, firmware_ver?, distributePackedToLines? }
router.post('/jobs/:jobId/pack/weight', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const {
      packed_carton_weight_g,
      tare_g,
      scale_capture_raw,
      pack_session_id,
      sscc,
      note,
      source = 'manual',
      scale_serial,
      firmware_ver,
      distributePackedToLines = false,
    } = req.body || {};

    if (packed_carton_weight_g == null) {
      return res.status(400).json({ ok: false, error: 'packed_carton_weight_g required' });
    }

    const job = await WarehouseJob.findOne({ jobId });
    if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });

    // compute net (gross - tare)
    job.packed_gross_g = Number(packed_carton_weight_g);
    const tare = Number((tare_g ?? job.carton_tare_g) || 0);
    const expected = Number(job.expected_carton_weight_g || 0);
    job.packed_net_g = Math.max(0, Math.round(job.packed_gross_g - tare));
    job.scale_capture_raw = scale_capture_raw || job.scale_capture_raw || '';
    job.pack_session_id = pack_session_id || job.pack_session_id;
    job.sscc = sscc || job.sscc || job.jobId;
    job.packed_at = new Date();

    // tolerance: NET vs expected
    const absG = (typeof job.tolerance_g === 'number') ? job.tolerance_g : 50;
    const pct = (typeof job.tolerance_pct === 'number') ? job.tolerance_pct : 0.015;
    const variance = Math.round(job.packed_net_g - expected);
    const tolAbs = Number(absG);
    const tolPct = Math.round(Number(pct) * expected);
    const tol = Math.max(tolAbs, tolPct);
    const pass = Math.abs(variance) <= tol;
    job.pass = pass;
    job.variance_g = variance;

    // audit event
    job.pack_events = job.pack_events || [];
    job.pack_events.push({
      ts: new Date(),
      gross_carton_weight_g: job.packed_gross_g,
      carton_tare_g: tare,
      net_carton_weight_g: job.packed_net_g,
      expected_carton_weight_g: expected,
      variance_g: variance,
      pass,
      captured_by: (req.user && (req.user.email || req.user.id)) || 'unknown',
      source, scale_serial, firmware_ver, note,
    });

    // optional: distribute packed to lines proportionally to expected lines
    if (distributePackedToLines && Array.isArray(job.lines) && job.lines.length) {
      const expectedLines = job.lines.map(l => Number(l.expected_ship_weight_g || 0));
      const net = Number(job.packed_net_g || 0);

      // local proportional distribution
      const totalExp = expectedLines.reduce((a, b) => a + b, 0);
      let packedLines;
      if (totalExp > 0) {
        packedLines = expectedLines.map(x => Math.round(net * (x / totalExp)));
      } else {
        const base = Math.floor(net / job.lines.length);
        packedLines = expectedLines.map(() => base);
      }
      // fix drift so sum == net
      const drift = net - packedLines.reduce((a, b) => a + b, 0);
      if (packedLines.length) packedLines[0] += drift;

      // set & mark modified so Mongoose persists
      const newLines = job.lines.map((l, i) => {
        const base = l.toObject ? l.toObject() : l;
        return { ...base, packed_weight_g: Number(packedLines[i] || 0) };
      });
      job.set('lines', newLines);
      job.markModified('lines');
    }

    await job.save();

    const expPretty = gToLbOz(expected);
    const actPretty = gToLbOz(job.packed_gross_g);

    return res.json({
      ok: true,
      pass,
      variance_g: variance,
      tolerance_g: tol,
      expected: { g: expected, ...expPretty },
      packed: { g: job.packed_gross_g, ...actPretty },
      net_g: job.packed_net_g,
      sscc: job.sscc,
    });
  } catch (e) { next(e); }
});

// GET /api/wh/jobs/:jobId/label
router.get('/jobs/:jobId/label', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const job = await WarehouseJob.findOne({ jobId }).lean();
    if (!job) return res.status(404).send('NOT_FOUND');

    // ---- all lines below must be INSIDE the handler ----
    const grossG   = Number(job.packed_gross_g || 0);
    const netG     = Number(job.packed_net_g   || 0);
    const expected = Number(job.expected_carton_weight_g || 0);

    const actGross = gToLbOz(grossG);
    const actNet   = gToLbOz(netG);
    const exp      = gToLbOz(expected);

    const pf = job.pass === true ? 'PASS' : job.pass === false ? 'CHECK' : 'PENDING';
    const variance = (typeof job.variance_g === 'number') ? job.variance_g : 0;

    const sscc = job.sscc || job.jobId;
    const hrSscc = /^\d{18}$/.test(sscc) ? `(00)${sscc}` : sscc;

    const zpl = `^XA
^CF0,32
^FO30,30^FDJob:^FS
^CF0,48
^FO150,26^FD${job.jobId}^FS

^CF0,32
^FO30,80^FDSSCC:^FS
^CF0,40
^FO150,76^FD${hrSscc}^FS

^CF0,32
^FO30,130^FDNet Weight:^FS
^CF0,48
^FO150,126^FD${actNet.lb} lb ${actNet.oz} oz^FS
^CF0,28
^FO30,180^FDExpected:^FS
^FO150,176^FD${exp.lb} lb ${exp.oz} oz^FS

^CF0,28
^FO30,220^FDGross:^FS
^FO150,216^FD${actGross.lb} lb ${actGross.oz} oz^FS

^CF0,28
^FO30,260^FDVariance:^FS
^FO150,256^FD${variance} g (${pf})^FS

^BY2,3,80
^FO30,310^BCN,80,Y,N,N
^FD${sscc}^FS
^XZ`;

    res.set('Content-Type', 'text/plain').send(zpl);
  } catch (e) { next(e); }
});


module.exports = router;
