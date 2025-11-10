// services/api/src/routes/ics.route.js
const express = require('express');
const router = express.Router();
const { URL } = require('url');

// --- tiny ICS parser (VEVENT blocks se DTSTART/DTEND read) ---
function parseICS(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let inEvent = false;
  let cur = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { inEvent = true; cur = {}; continue; }
    if (line === 'END:VEVENT')   { inEvent = false; out.push(cur); continue; }
    if (!inEvent) continue;
    if (line.startsWith('DTSTART')) {
      const v = line.split(':')[1];
      cur.DTSTART = v;
    } else if (line.startsWith('DTEND')) {
      const v = line.split(':')[1];
      cur.DTEND = v;
    } else if (line.startsWith('SUMMARY:')) {
      cur.SUMMARY = line.slice('SUMMARY:'.length);
    } else if (line.startsWith('UID:')) {
      cur.UID = line.slice('UID:'.length);
    }
  }
  return out;
}

// yyyymmdd or yyyymmddT000000Z → Date (local midnight)
function icsDateToLocalDate(dstr) {
  if (!dstr) return null;
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(dstr);
  if (!m) return null;
  const [ , y, mo, d ] = m;
  return new Date(Number(y), Number(mo)-1, Number(d));
}

// month filter
function isInMonth(d, year, monthIndex) {
  return d.getFullYear() === year && d.getMonth() === monthIndex;
}

// source from hostname
function sourceFromHost(host) {
  const h = (host || '').toLowerCase();
  if (h.includes('airbnb')) return 'airbnb';
  if (h.includes('vrbo'))   return 'vrbo';
  return 'other';
}

/**
 * GET /api/ics/events?url=<ics_url>[&y=YYYY&mm=1-12]
 * Returns only **next month** (default) events’ dates (unique YYYY-MM-DD).
 * If y+mm provided, filter that month instead.
 */
router.get('/events', async (req, res) => {
  try {
    const { url, y, mm } = req.query || {};
    if (!url) return res.status(400).json({ ok:false, error:'missing_url' });

    let u;
    try { u = new URL(url); } catch { return res.status(400).json({ ok:false, error:'invalid_url' }); }

    // fetch ICS (server-side to avoid CORS)
    const r = await fetch(u.toString(), {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/calendar,text/plain,*/*'
      }
    });
    if (!r.ok) return res.status(r.status).json({ ok:false, error:`upstream_${r.status}` });

    const icsText = await r.text();
    const events  = parseICS(icsText);

    // compute month (default = next month from server time)
    const now = new Date();
    let year, monthIndex;
    if (y && mm) {
      year = Number(y);
      monthIndex = Number(mm) - 1;
    } else {
      const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      year = next.getFullYear();
      monthIndex = next.getMonth();
    }

    // collect unique dates falling in that month
    const setDates = new Set();
    for (const ev of events) {
      const d0 = icsDateToLocalDate(ev.DTSTART);
      const d1 = icsDateToLocalDate(ev.DTEND);

      if (!d0) continue;

      // all-day events typically have DTSTART as the day; some calendars use [start, endExclusive]
      // Walk each day from d0 to (d1 || d0)
      const start = d0;
      const end   = d1 ? new Date(d1.getTime() - 86400000) : d0; // end-exclusive -> inclusive last day
      for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate()+1)) {
        if (isInMonth(d, year, monthIndex)) {
          const iso = d.toISOString().slice(0,10); // YYYY-MM-DD
          setDates.add(iso);
        }
      }
      // if no DTEND, still add start day (already handled)
    }

    const src = sourceFromHost(u.hostname);
    const monthKey = `${year}-${String(monthIndex+1).padStart(2,'0')}`;

    return res.json({
      ok: true,
      source: src,
      month: monthKey,
      count: setDates.size,
      dates: Array.from(setDates).sort(), // sorted strings
    });
  } catch (e) {
    console.error('GET /api/ics/events error', e);
    return res.status(500).json({ ok:false, error:'parse_failed' });
  }
});

// raw ICS passthrough (kept if you already used earlier)
router.get('/', async (req, res) => {
  try {
    const { url } = req.query || {};
    if (!url) return res.status(400).send('Missing url');
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/calendar,text/plain,*/*' } });
    if (!r.ok) return res.status(r.status).send(`Upstream HTTP ${r.status}`);
    res.set('Content-Type','text/calendar; charset=utf-8');
    res.send(await r.text());
  } catch (e) {
    console.error('GET /api/ics error', e);
    res.status(500).send('proxy_failed');
  }
});

module.exports = router;
