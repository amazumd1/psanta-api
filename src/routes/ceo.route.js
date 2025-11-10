const express = require('express');
const router = express.Router();

const Payment = require('../models/Payment');      // adjust if your relative path differs
const Job = require('../models/Job');
let InventoryItem, StockMovement;
try {
    InventoryItem = require('../models/wh/InventoryItem');
    StockMovement = require('../models/wh/StockMovement');
} catch { /* warehouse optional */ }
const Event = require('../models/Event');

// ---------- utils ----------
function rangeToDates(range = 'MTD') {
    const now = new Date();
    const end = new Date(now);
    let start;

    if (range === '24h') {
        start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    } else if (range === 'WTD') {
        const d = new Date(now);
        const dow = (d.getDay() + 6) % 7; // Mon=0
        d.setDate(d.getDate() - dow);
        d.setHours(0, 0, 0, 0);
        start = d;
    } else { // MTD default
        start = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    return { start, end };
}

function toISODate(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x.toISOString().slice(0, 10);
}

function hourFromDoc(doc) {
    const dt = doc?.window?.start || doc?.date;
    const d = dt ? new Date(dt) : null;
    return d ? d.getHours() : null;
}

const PEAK_START = Number(process.env.CEO_PEAK_START_HOUR || 17);
const PEAK_END = Number(process.env.CEO_PEAK_END_HOUR || 20);
function isPeakHour(h) {
    if (typeof h !== 'number') return false;
    return h >= PEAK_START && h <= PEAK_END;
}

// capacity minutes per day (fallback 2 techs * 6h = 720)
const CAPACITY_MIN_PER_DAY = Number(process.env.CEO_CAPACITY_MIN_PER_DAY || 720);
const LABOR_RATE_DEFAULT = Number(process.env.CEO_LABOR_RATE_DEFAULT || 25); // $/hr

async function sumPayments(range) {
    const { start, end } = rangeToDates(range);
    const match = { createdAt: { $gte: start, $lte: end } };
    const byStatus = await Payment.aggregate([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }
    ]);

    const map = byStatus.reduce((m, r) => {
        m[r._id || 'unknown'] = { count: r.count, amount: r.amount };
        return m;
    }, {});

    const cap = map['captured'] || { count: 0, amount: 0 };
    const created = map['created'] || { count: 0, amount: 0 };
    const approved = map['approved'] || { count: 0, amount: 0 };
    const voided = map['void'] || { count: 0, amount: 0 };

    const avgTicket = cap.count > 0 ? (cap.amount / cap.count) : 0;

    return {
        revenueCaptured: Number((cap.amount || 0).toFixed(2)),
        paymentsByStatus: { created, approved, captured: cap, void: voided },
        avgTicket: Number(avgTicket.toFixed(2))
    };
}

async function jobsOverview(range) {
    const { start, end } = rangeToDates(range);
    // Jobs "created" in range
    const created = await Job.countDocuments({ createdAt: { $gte: start, $lte: end } }).lean();
    // Jobs scheduled in range (by main date)
    const scheduled = await Job.countDocuments({ date: { $gte: start, $lte: end } }).lean();
    // Completed in range (by updatedAt) – tweak to your schema if you store completedAt
    const completed = await Job.countDocuments({
        status: 'completed',
        updatedAt: { $gte: start, $lte: end }
    }).lean();

    // status counts (all-time quick snapshot)
    const statusAgg = await Job.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    const statusCounts = statusAgg.reduce((m, r) => (m[r._id || 'unknown'] = r.count, m), {});

    return { created, scheduled, completed, statusCounts };
}

async function lowStockCount() {
    if (!InventoryItem) return 0;
    const n = await InventoryItem.countDocuments({
        $expr: { $lte: ['$onHand', { $ifNull: ['$reorderPoint', 0] }] }
    }).lean();
    return n || 0;
}

// ---------- routes ----------

// Overview KPIs
router.get('/overview', async (req, res, next) => {
    try {
        const range = (req.query.range || 'MTD').toUpperCase();
        const [pay, jobs, lowStock] = await Promise.all([
            sumPayments(range),
            jobsOverview(range),
            lowStockCount()
        ]);

        return res.json({
            ok: true,
            data: {
                range,
                revenueCaptured: pay.revenueCaptured,
                paymentsByStatus: pay.paymentsByStatus,
                avgTicket: pay.avgTicket,
                jobs: jobs,
                lowStockCount: lowStock
            }
        });
    } catch (e) { next(e); }
});

// Next 7 days bookings & capacity
router.get('/bookings-week', async (req, res, next) => {
    try {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 7);

        const jobs = await Job.find({ date: { $gte: start, $lte: end } })
            .select({ date: 1, window: 1, durationMinutes: 1 })
            .lean();

        const byDay = {};
        for (let i = 0; i < 7; i++) {
            const d = new Date(start);
            d.setDate(start.getDate() + i);
            byDay[toISODate(d)] = { date: toISODate(d), jobs: 0, minutes: 0, peakCount: 0 };
        }

        for (const j of jobs) {
            const key = toISODate(j.date);
            if (!byDay[key]) continue;
            const h = hourFromDoc(j);
            const dur = Number(j.durationMinutes || 0);
            byDay[key].jobs += 1;
            byDay[key].minutes += dur;
            if (isPeakHour(h)) byDay[key].peakCount += 1;
        }

        const days = Object.values(byDay).map(d => ({
            ...d,
            peakShare: d.jobs > 0 ? Number((d.peakCount / d.jobs * 100).toFixed(1)) : 0
        }));

        const totalMinutes = days.reduce((s, d) => s + d.minutes, 0);
        const capacity = CAPACITY_MIN_PER_DAY * 7;
        const utilizationPct = capacity > 0 ? Number((totalMinutes / capacity * 100).toFixed(1)) : 0;

        res.json({ ok: true, data: { days, capacity: { minutes: capacity, utilizationPct } } });
    } catch (e) { next(e); }
});

// Payments funnel
router.get('/funnel', async (req, res, next) => {
    try {
        const range = (req.query.range || 'WTD').toUpperCase();
        const { start, end } = rangeToDates(range);
        const match = { createdAt: { $gte: start, $lte: end } };

        const agg = await Payment.aggregate([
            { $match: match },
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);

        const map = agg.reduce((m, r) => (m[r._id || 'unknown'] = r.count, m), {});
        const created = map['created'] || 0;
        const approved = map['approved'] || 0;
        const captured = map['captured'] || 0;
        const pct = created > 0 ? Number((captured / created * 100).toFixed(1)) : 0;

        res.json({ ok: true, data: { range, created, approved, captured, pct } });
    } catch (e) { next(e); }
});

// Inventory top usage (7d)
router.get('/inventory/top', async (req, res, next) => {
    try {
        if (!StockMovement || !InventoryItem) return res.json({ ok: true, data: [] });

        const limit = Math.max(1, Math.min(50, Number(req.query.limit || 8)));
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);



        // OUT movements -> usage
        const used = await StockMovement.aggregate([
            { $match: { createdAt: { $gte: since }, type: { $in: ['OUT', 'CONSUME', 'USE'] } } },
            { $group: { _id: '$sku', weekUsed: { $sum: '$qty' } } },
            { $sort: { weekUsed: -1 } },
            { $limit: limit }
        ]);

        const skus = used.map(u => u._id);
        const items = await InventoryItem.find({ sku: { $in: skus } })
            .select({ sku: 1, name: 1, onHand: 1, reorderPoint: 1, eta: 1 })
            .lean();

        const map = items.reduce((m, i) => (m[i.sku] = i, m), {});
        const rows = used.map(u => ({
            sku: u._id,
            name: map[u._id]?.name || u._id,
            onHand: map[u._id]?.onHand ?? null,
            reorderPoint: map[u._id]?.reorderPoint ?? null,
            eta: map[u._id]?.eta ?? null,
            weekUsed: u.weekUsed
        }));

        res.json({ ok: true, data: rows });
    } catch (e) { next(e); }
});

// Events feed
router.get('/events', async (req, res, next) => {
    try {
        const since = new Date(req.query.since || Date.now() - 3600 * 1000);
        const q = { $or: [{ createdAt: { $gte: since } }, { ts: { $gte: since } }] };
        const rows = await Event.find(q).sort({ createdAt: -1 }).limit(100).lean();
        res.json({ ok: true, data: rows });
    } catch (e) { next(e); }
});

// Simple P&L (v1)
router.get('/pnl', async (req, res, next) => {
    try {
        const range = (req.query.range || 'MTD').toUpperCase();
        const { start, end } = rangeToDates(range);

        // Revenue
        const revAgg = await Payment.aggregate([
            { $match: { status: 'captured', createdAt: { $gte: start, $lte: end } } },
            { $group: { _id: null, sum: { $sum: '$amount' } } }
        ]);
        const revenue = Number((revAgg[0]?.sum || 0).toFixed(2));

        // Labor cost
        const jobs = await Job.find({ date: { $gte: start, $lte: end } })
            .select({ durationMinutes: 1, property: 1 })
            .lean();

        // very simple rate resolver (upgrade later with your pricing states)
        const rate = (/*job*/) => LABOR_RATE_DEFAULT;
        const labor = jobs.reduce((s, j) => {
            const hrs = Number(j.durationMinutes || 0) / 60;
            return s + (hrs * rate(j));
        }, 0);

        // Supplies COGS
        let supplies = 0;
        if (StockMovement) {
            const cogs = await StockMovement.aggregate([
                { $match: { createdAt: { $gte: start, $lte: end }, type: { $in: ['OUT', 'CONSUME', 'USE'] } } },
                { $project: { amt: { $multiply: ['$qty', { $ifNull: ['$unitCost', 0] }] } } },
                { $group: { _id: null, sum: { $sum: '$amt' } } }
            ]);
            supplies = Number((cogs[0]?.sum || 0).toFixed(2));
        }

        const gross = Number((revenue - (labor + supplies)).toFixed(2));
        const opex = Number(process.env.CEO_OPEX_MONTHLY || 0);
        const operating = Number((gross - opex).toFixed(2));

        res.json({ ok: true, data: { range, revenue, labor: Number(labor.toFixed(2)), supplies, gross, opex, operating } });
    } catch (e) { next(e); }
});

module.exports = router;
