// services/api/routes/psStrCalendar.js
const express = require("express");
const router = express.Router();
const { URL } = require("url");

// If you add the model, this will persist blocks.
// If model not added yet, this route will still work but won't save.
let StrCalendar = null;
try {
  StrCalendar = require("../models/StrCalendar");
} catch (e) {
  // model optional for MVP wiring
  StrCalendar = null;
}

/* -------------------- tiny ICS parser (VEVENT blocks) -------------------- */
function parseICS(text) {
  const out = [];
  const lines = String(text || "").split(/\r?\n/);
  let inEvent = false;
  let cur = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      inEvent = false;
      out.push(cur);
      continue;
    }
    if (!inEvent) continue;

    if (line.startsWith("DTSTART")) cur.DTSTART = line.split(":")[1];
    else if (line.startsWith("DTEND")) cur.DTEND = line.split(":")[1];
    else if (line.startsWith("UID:")) cur.UID = line.slice("UID:".length);
    else if (line.startsWith("SUMMARY:")) cur.SUMMARY = line.slice("SUMMARY:".length);
  }
  return out;
}

// yyyymmdd or yyyymmddT000000Z → Date (local midnight)
function icsDateToLocalDate(dstr) {
  if (!dstr) return null;
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(dstr);
  if (!m) return null;
  const [, y, mo, d] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d));
}

function sourceFromHost(host) {
  const h = String(host || "").toLowerCase();
  if (h.includes("airbnb")) return "airbnb";
  if (h.includes("vrbo") || h.includes("homeaway")) return "vrbo";
  return "other";
}

function toISODate(d) {
  // local date -> YYYY-MM-DD
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Normalize events into date blocks:
 * - Treat DTEND as end-exclusive if present (common for all-day events)
 * - Output blocks: { start:"YYYY-MM-DD", end:"YYYY-MM-DD" } inclusive end
 * - Merge overlaps/adjacent blocks
 */
function eventsToBlocks(events) {
  const rawBlocks = [];

  for (const ev of events || []) {
    const d0 = icsDateToLocalDate(ev.DTSTART);
    const d1 = icsDateToLocalDate(ev.DTEND);

    if (!d0) continue;

    // If DTEND exists, most all-day ICS uses end-exclusive; make inclusive end
    let end = d1 ? new Date(d1.getTime() - 86400000) : new Date(d0);
    const start = new Date(d0);

    // Defensive: if end < start, clamp
    if (end < start) end = new Date(start);

    rawBlocks.push({
      start,
      end,
    });
  }

  // sort by start date
  rawBlocks.sort((a, b) => a.start - b.start);

  // merge overlaps/adjacent
  const merged = [];
  for (const b of rawBlocks) {
    if (!merged.length) {
      merged.push(b);
      continue;
    }
    const last = merged[merged.length - 1];
    const lastEndPlus1 = new Date(last.end.getTime() + 86400000);

    if (b.start <= lastEndPlus1) {
      // overlap or adjacent: extend end
      if (b.end > last.end) last.end = b.end;
    } else {
      merged.push(b);
    }
  }

  return merged.map((b) => ({
    start: toISODate(b.start),
    end: toISODate(b.end),
  }));
}

/* -------------------- POST /api/ps/str/calendar/import -------------------- */
router.post("/import", async (req, res) => {
  try {
    const { zip, calendar_id, ical_urls } = req.body || {};

    const urls = Array.isArray(ical_urls) ? ical_urls.filter(Boolean) : [];
    if (!urls.length) {
      return res.status(400).json({ ok: false, error: "missing_ical_urls" });
    }

    const nowIso = new Date().toISOString();

    // fetch all ICS urls
    const allBlocks = [];
    const sources = [];

    for (const raw of urls) {
      let u;
      try {
        u = new URL(raw);
      } catch {
        return res.status(400).json({ ok: false, error: "invalid_url", url: raw });
      }

      const src = sourceFromHost(u.hostname);
      sources.push(src);

      const r = await fetch(u.toString(), {
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "text/calendar,text/plain,*/*",
        },
      });

      if (!r.ok) {
        return res.status(r.status).json({ ok: false, error: `upstream_${r.status}`, url: raw });
      }

      const icsText = await r.text();
      const events = parseICS(icsText);
      const blocks = eventsToBlocks(events);

      for (const b of blocks) {
        allBlocks.push({
          ...b,
          source: src,
          url: raw,
        });
      }
    }

    // Optional: persist if model exists
    let doc = null;
    if (StrCalendar) {
      const query = calendar_id ? { calendar_id } : null;

      if (query) {
        doc = await StrCalendar.findOne(query);
      }

      if (!doc) {
        doc = new StrCalendar({
          calendar_id: calendar_id || undefined,
          zip: zip || "",
          ical_urls: urls,
          sources,
          last_sync_at: nowIso,
          blocks: allBlocks,
        });
      } else {
        doc.zip = zip || doc.zip || "";
        doc.ical_urls = urls;
        doc.sources = sources;
        doc.last_sync_at = nowIso;
        doc.blocks = allBlocks;
      }

      await doc.save();
    }

    return res.json({
      ok: true,
      calendar_id: doc?.calendar_id || calendar_id || (doc ? doc._id?.toString() : ""),
      calendar_connected: true,
      sources,
      last_sync_at: nowIso,
      blocks_count: allBlocks.length,
    });
  } catch (e) {
    console.error("POST /api/ps/str/calendar/import error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

module.exports = router;
