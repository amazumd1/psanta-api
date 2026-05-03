// services/api/src/routes/ics.route.js
const express = require("express");
const router = express.Router();
const { URL } = require("url");

/* -------------------- helpers -------------------- */

function unfoldIcsLines(text = "") {
  const rawLines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const lines = [];

  for (const raw of rawLines) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length) {
      lines[lines.length - 1] += raw.slice(1);
    } else {
      lines.push(raw.trim());
    }
  }

  return lines.filter(Boolean);
}

function splitIcsLine(line = "") {
  const idx = line.indexOf(":");
  if (idx < 0) return { key: "", value: "" };

  const meta = line.slice(0, idx);
  const value = line.slice(idx + 1).trim();
  const key = meta.split(";")[0].toUpperCase();

  return { key, value };
}

// VEVENT blocks se DTSTART/DTEND/SUMMARY/UID read
function parseICS(text) {
  const out = [];
  const lines = unfoldIcsLines(text);

  let inEvent = false;
  let cur = {};

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      cur = {};
      continue;
    }

    if (line === "END:VEVENT") {
      inEvent = false;
      if (cur.DTSTART) out.push(cur);
      cur = {};
      continue;
    }

    if (!inEvent) continue;

    const { key, value } = splitIcsLine(line);

    if (key === "DTSTART") cur.DTSTART = value;
    if (key === "DTEND") cur.DTEND = value;
    if (key === "SUMMARY") cur.SUMMARY = value;
    if (key === "UID") cur.UID = value;
  }

  return out;
}

// YYYYMMDD or YYYYMMDDT000000Z -> local date midnight
function icsDateToLocalDate(dstr) {
  if (!dstr) return null;

  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(dstr));
  if (!m) return null;

  const [, y, mo, d] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d));
}

function toISODate(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.toISOString().slice(0, 10);
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  d.setHours(0, 0, 0, 0);
  return d;
}

function monthStart(year, monthIndex) {
  return new Date(Number(year), Number(monthIndex), 1);
}

function monthEndExclusive(year, monthIndex) {
  return new Date(Number(year), Number(monthIndex) + 1, 1);
}

function sourceFromHost(host) {
  const h = String(host || "").toLowerCase();

  if (h.includes("airbnb")) return "airbnb";
  if (h.includes("vrbo") || h.includes("homeaway")) return "vrbo";

  return "other";
}

function addEventDatesToSet({ event, setDates, rangeStart, rangeEndExclusive }) {
  const d0 = icsDateToLocalDate(event.DTSTART);
  const d1 = icsDateToLocalDate(event.DTEND);

  if (!d0) return;

  const start = new Date(d0);
  start.setHours(0, 0, 0, 0);

  // Airbnb/VRBO all-day ICS usually uses checkout/end date as exclusive.
  const end = d1 ? new Date(d1.getTime() - 86400000) : new Date(start);
  end.setHours(0, 0, 0, 0);

  for (
    let d = new Date(start);
    d <= end;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  ) {
    if (d >= rangeStart && d < rangeEndExclusive) {
      setDates.add(toISODate(d));
    }
  }
}

/* -------------------- routes -------------------- */

/**
 * GET /api/ics/events?url=<ics_url>&months=12
 * Also supports old style:
 * GET /api/ics/events?url=<ics_url>&y=2026&mm=8
 */
router.get("/events", async (req, res) => {
  try {
    const { url, y, mm } = req.query || {};
    const monthsRaw = Number(req.query.months || 12);
    const months = Math.min(24, Math.max(1, Number.isFinite(monthsRaw) ? monthsRaw : 12));

    if (!url) {
      return res.status(400).json({ ok: false, error: "missing_url" });
    }

    let u;
    try {
      u = new URL(url);
    } catch {
      return res.status(400).json({ ok: false, error: "invalid_url" });
    }

    const r = await fetch(u.toString(), {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 PropertySantaICS/1.0",
        Accept: "text/calendar,text/plain,*/*",
      },
    });

    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: `upstream_${r.status}`,
      });
    }

    const icsText = await r.text();
    const events = parseICS(icsText);

    let rangeStart;
    let rangeEndExclusive;
    let monthKey = null;

    // Old mode: exact month filter
    if (y && mm) {
      const year = Number(y);
      const monthIndex = Number(mm) - 1;

      if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || monthIndex < 0 || monthIndex > 11) {
        return res.status(400).json({ ok: false, error: "invalid_month" });
      }

      rangeStart = monthStart(year, monthIndex);
      rangeEndExclusive = monthEndExclusive(year, monthIndex);
      monthKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
    } else {
      // New mode: rolling upcoming N months
      rangeStart = startOfToday();
      rangeEndExclusive = addMonths(rangeStart, months);
    }

    const setDates = new Set();

    for (const event of events) {
      addEventDatesToSet({
        event,
        setDates,
        rangeStart,
        rangeEndExclusive,
      });
    }

    const dates = Array.from(setDates).sort();
    const src = sourceFromHost(u.hostname);

    return res.json({
      ok: true,
      source: src,
      month: monthKey,
      months: y && mm ? 1 : months,
      range: {
        start: toISODate(rangeStart),
        endExclusive: toISODate(rangeEndExclusive),
      },
      count: dates.length,
      dates,
    });
  } catch (e) {
    console.error("GET /api/ics/events error", e);
    return res.status(500).json({
      ok: false,
      error: "parse_failed",
    });
  }
});

// raw ICS passthrough
router.get("/", async (req, res) => {
  try {
    const { url } = req.query || {};

    if (!url) {
      return res.status(400).send("Missing url");
    }

    const r = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 PropertySantaICS/1.0",
        Accept: "text/calendar,text/plain,*/*",
      },
    });

    if (!r.ok) {
      return res.status(r.status).send(`Upstream HTTP ${r.status}`);
    }

    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.send(await r.text());
  } catch (e) {
    console.error("GET /api/ics error", e);
    res.status(500).send("proxy_failed");
  }
});

module.exports = router;