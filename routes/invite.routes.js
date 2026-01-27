// services/api/routes/invite.routes.js
const express = require("express");
const router = express.Router();

function esc(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[c]));
}

function inviteHtml({ toEmail, role, onboardingUrl, contractorUrl }) {
  const is1099 = String(role || "").toLowerCase() === "1099";
  const title = is1099 ? "Contractor setup" : "Employee onboarding";
  const primaryText = is1099 ? "Start W-9 Onboarding" : "Start Onboarding";

  const contractorBlock =
    is1099 && contractorUrl
      ? `
      <div style="margin-top:14px; padding:12px; border:1px solid #e5e7eb; border-radius:12px;">
        <div style="font-weight:700; margin-bottom:6px;">Contractor Business Form (if applicable)</div>
        <a href="${esc(contractorUrl)}"
          style="display:inline-block; background:#111827; color:#fff; text-decoration:none; padding:10px 14px; border-radius:10px; font-weight:700; font-size:14px;">
          Complete Business Form
        </a>
        <div style="margin-top:10px; font-size:12px; color:#6b7280;">Or copy/paste: ${esc(contractorUrl)}</div>
      </div>
    `
      : "";

  return `
  <div style="font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial; background:#f8fafc; padding:24px;">
    <div style="max-width:640px; margin:0 auto; background:#fff; border:1px solid #e5e7eb; border-radius:16px; overflow:hidden;">
      <div style="padding:18px 20px; background:linear-gradient(135deg,#2563eb,#4f46e5); color:#fff;">
        <div style="font-size:16px; font-weight:800;">Property Santa</div>
        <div style="font-size:12px; opacity:.9;">Ops • Secure onboarding</div>
      </div>

      <div style="padding:20px;">
        <div style="font-size:18px; font-weight:900; color:#111827;">${esc(title)}</div>
        <div style="margin-top:8px; color:#374151; font-size:14px;">
          Hi ${esc(toEmail)},<br/>
          Please complete your onboarding using the secure link below.
        </div>

        <div style="margin-top:16px; padding:12px; border:1px solid #e5e7eb; border-radius:12px;">
          <div style="font-weight:700; margin-bottom:6px;">Start here</div>
          <a href="${esc(onboardingUrl)}"
             style="display:inline-block; background:#2563eb; color:#fff; text-decoration:none; padding:12px 16px; border-radius:10px; font-weight:800; font-size:14px;">
            ${esc(primaryText)}
          </a>
          <div style="margin-top:10px; font-size:12px; color:#6b7280;">Or copy/paste: ${esc(onboardingUrl)}</div>
        </div>

        ${contractorBlock}

        <div style="margin-top:16px; font-size:13px; color:#6b7280; line-height:1.5;">
          <b>Security note:</b> We will never ask you to send SSN/EIN over email. Please enter information only on the Property Santa page.
        </div>

        <div style="margin-top:18px; font-size:12px; color:#9ca3af;">
          © ${new Date().getFullYear()} Property Santa
        </div>
      </div>
    </div>
  </div>`;
}

async function nodeFetch(url, options) {
  if (typeof fetch === "function") return fetch(url, options); // Node 18+
  const mod = await import("node-fetch");
  return (mod.default || mod)(url, options);
}

router.post("/send-invite", async (req, res) => {
  try {
    const { toEmail, role, onboardingUrl, contractorUrl } = req.body || {};

    if (!toEmail || !onboardingUrl) {
      return res.status(400).json({ ok: false, error: "Missing toEmail or onboardingUrl" });
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "RESEND_API_KEY not set on server" });
    }

    const from = process.env.INVITE_FROM || "Property Santa <no-reply@propertysanta.com>";
    const reply_to = process.env.INVITE_REPLY_TO || "support@propertysanta.com";

    const subject =
      String(role || "").toLowerCase() === "1099"
        ? "Property Santa — Contractor setup link"
        : "Property Santa — Complete your onboarding";

    const html = inviteHtml({ toEmail, role, onboardingUrl, contractorUrl });

    const r = await nodeFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [toEmail],
        subject,
        reply_to,
        html,
      }),
    });

    const text = await r.text().catch(() => "");
    if (!r.ok) {
      console.error("Resend error:", r.status, text);
      return res.status(502).json({ ok: false, error: "Email provider failed", details: text });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("send-invite error:", e);
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
});

module.exports = router;
