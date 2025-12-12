// services/api/routes/receipts.routes.js

const express = require("express");
const router = express.Router();

// Apps Script config from .env
const GAS_URL = process.env.GAS_RECEIPTS_WEBAPP_URL;
const GAS_SECRET = process.env.GAS_RECEIPTS_SECRET;

// Helper: build Apps Script URL with query params
function buildGasUrl(action, extra = {}) {
    if (!GAS_URL) return null;

    const url = new URL(GAS_URL);
    url.searchParams.set("action", action);

    if (GAS_SECRET) {
        url.searchParams.set("secret", GAS_SECRET);
    }

    Object.entries(extra).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
            url.searchParams.set(key, String(value));
        }
    });

    return url.toString();
}

/**
 * Universal fetch helper for Node:
 * - Agar Node 18+ hai → global fetch use karega
 * - Warna node-fetch (ESM) ko dynamic import se load karega
 */
async function nodeFetch(url, options) {
    // Node 18+ : global fetch available
    if (typeof fetch === "function") {
        return fetch(url, options);
    }

    // Node < 18: fallback to node-fetch (ESM)
    const mod = await import("node-fetch");
    const fn = mod.default || mod;
    return fn(url, options);
}

/**
 * GET /api/receipts/jobs
 * → Calls Apps Script with action=listJobs
 * → Returns: { ok: true, jobs: [...] }
 */
router.get("/jobs", async (req, res) => {
    try {
        if (!GAS_URL) {
            console.warn(
                "⚠️ GAS_RECEIPTS_WEBAPP_URL is not set. /api/receipts/jobs will fail."
            );
            return res
                .status(500)
                .json({ ok: false, error: "GAS url not configured on server" });
        }

        const url = buildGasUrl("listJobs", { kind: "ops-app" });  // ✅ important

        const gasRes = await nodeFetch(url);

        if (!gasRes.ok) {
            const bodyText = await gasRes.text().catch(() => "<no body>");
            console.error(
                "❌ Apps Script listJobs returned non-200",
                gasRes.status,
                bodyText
            );
            return res
                .status(502)
                .json({ ok: false, error: "Apps Script listJobs failed" });
        }

        const raw = await gasRes.text();
        let data;
        try {
            data = JSON.parse(raw);
        } catch (err) {
            console.error("❌ Apps Script listJobs returned non-JSON. First 200 chars:\n", raw.slice(0, 200));
            return res.status(500).json({
                ok: false,
                error:
                    "Apps Script listJobs did not return JSON (probably login/HTML). " +
                    "Check Web App deployment access (Anyone with link) and URL.",
            });
        }

        if (!data || data.ok === false) {
            return res.status(500).json({
                ok: false,
                error:
                    (data && data.error) || "Invalid response from Apps Script (listJobs)",
            });
        }

        const jobs = data.jobs || (data.data && data.data.jobs) || [];

        return res.json({ ok: true, jobs });
    } catch (err) {
        console.error("❌ Error in GET /api/receipts/jobs", err);
        return res.status(500).json({
            ok: false,
            error: "Internal error while fetching receipt jobs",
        });
    }
});

/**
 * POST /api/receipts/run
 * Body: { jobId: string }
 * → Calls Apps Script with action=runJob&jobId=...
 */
router.post("/run", async (req, res) => {
    try {
        if (!GAS_URL) {
            console.warn(
                "⚠️ GAS_RECEIPTS_WEBAPP_URL is not set. /api/receipts/run will fail."
            );
            return res
                .status(500)
                .json({ ok: false, error: "GAS url not configured on server" });
        }

        const { jobId } = req.body || {};
        if (!jobId) {
            return res.status(400).json({ ok: false, error: "jobId is required" });
        }

        const url = buildGasUrl("runJob", { jobId, kind: "ops-app" });  // ✅ yahan bhi

        const gasRes = await nodeFetch(url);

        if (!gasRes.ok) {
            const bodyText = await gasRes.text().catch(() => "<no body>");
            console.error(
                "❌ Apps Script runJob returned non-200",
                gasRes.status,
                bodyText
            );
            return res
                .status(502)
                .json({ ok: false, error: "Apps Script runJob failed" });
        }

        const data = await gasRes.json().catch((err) => {
            console.error("❌ Error parsing runJob JSON from Apps Script", err);
            return null;
        });

        if (!data || data.ok === false) {
            return res.status(500).json({
                ok: false,
                error:
                    (data && data.error) || "Invalid response from Apps Script (runJob)",
            });
        }

        // Apps Script response direct forward kar rahe hain
        return res.json(data);
    } catch (err) {
        console.error("❌ Error in POST /api/receipts/run", err);
        return res.status(500).json({
            ok: false,
            error: "Internal error while running receipt job",
        });
    }
});

module.exports = router;
