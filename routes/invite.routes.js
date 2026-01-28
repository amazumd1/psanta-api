// services/api/routes/invite.routes.js
const express = require("express");
const router = express.Router();

/* ----------------------------- helpers ---------------------------- */
function esc(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[c]));
}

function truncateMiddle(str = "", max = 72) {
  const s = String(str);
  if (s.length <= max) return s;
  const a = Math.ceil((max - 3) / 2);
  const b = Math.floor((max - 3) / 2);
  return `${s.slice(0, a)}...${s.slice(s.length - b)}`;
}

function inviteHtml({ toEmail, role, onboardingUrl, contractorUrl }) {
  const is1099 = String(role || "").toLowerCase() === "1099";

  const title = is1099 ? "Contractor setup" : "Employee onboarding";
  const subtitle = is1099
    ? "Complete your W-9 onboarding securely."
    : "Complete your onboarding securely.";

  const primaryText = is1099 ? "Start W-9 onboarding" : "Start onboarding";
  const secondaryText = is1099 ? "Business info (if applicable)" : null;

  const year = new Date().getFullYear();

  // keep emails pretty
  const safeToEmail = esc(toEmail || "");
  const safeOnboardingUrl = esc(onboardingUrl || "");
  const safeContractorUrl = esc(contractorUrl || "");

  const contractorBlock =
    is1099 && contractorUrl
      ? `
        <tr>
          <td style="padding:0 24px 18px;">
            <div style="border:1px solid #e5e7eb; border-radius:14px; padding:14px 14px 12px; background:#ffffff;">
              <div style="font-size:13px; font-weight:800; color:#111827; margin-bottom:6px;">${esc(
                secondaryText
              )}</div>
              <div style="font-size:13px; color:#4b5563; margin-bottom:12px; line-height:1.5;">
                If you operate as a business (LLC/Corp), fill this section too.
              </div>

              <a href="${safeContractorUrl}"
                 target="_blank" rel="noopener noreferrer"
                 style="display:inline-block; background:#111827; color:#ffffff; text-decoration:none; padding:11px 16px; border-radius:12px; font-weight:800; font-size:14px;">
                Complete business form
              </a>

              <div style="margin-top:10px; font-size:12px; color:#6b7280;">
                Or copy/paste:
                <span style="word-break:break-all; font-family: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">
                  ${esc(truncateMiddle(contractorUrl, 96))}
                </span>
              </div>
            </div>
          </td>
        </tr>
      `
      : "";

  // Email-safe layout: table-based, conservative CSS
  return `
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${esc(title)} • Property Santa</title>
  </head>
  <body style="margin:0; padding:0; background:#f3f4f6;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">
      Your secure Property Santa onboarding link.
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6; padding:24px 0;">
      <tr>
        <td align="center">

          <table role="presentation" width="640" cellpadding="0" cellspacing="0"
                 style="width:640px; max-width:640px; background:#ffffff; border:1px solid #e5e7eb; border-radius:18px; overflow:hidden;">
            <!-- Header -->
            <tr>
              <td style="padding:18px 24px; background:#0f172a;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <div style="font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:16px; font-weight:900; color:#ffffff; letter-spacing:0.2px;">
                        Property Santa
                      </div>
                      <div style="margin-top:4px; font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:12px; color:#cbd5e1;">
                        Ops • Secure onboarding
                      </div>
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      <div style="font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:12px; color:#94a3b8;">
                        ${is1099 ? "Contractor" : "Employee"}
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:22px 24px 8px; font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;">
                <div style="font-size:18px; font-weight:900; color:#0f172a; letter-spacing:0.2px;">
                  ${esc(title)}
                </div>
                <div style="margin-top:6px; font-size:13.5px; color:#475569; line-height:1.55;">
                  ${esc(subtitle)}
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:0 24px 18px; font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;">
                <div style="font-size:14px; color:#334155; line-height:1.6;">
                  Hi <b style="color:#0f172a;">${safeToEmail}</b>,<br/>
                  Use the button below to continue. This link is intended for you.
                </div>
              </td>
            </tr>

            <!-- Primary CTA Card -->
            <tr>
              <td style="padding:0 24px 18px;">
                <div style="border:1px solid #e5e7eb; border-radius:14px; padding:14px; background:#ffffff;">
                  <div style="font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:13px; font-weight:800; color:#111827; margin-bottom:10px;">
                    Start here
                  </div>

                  <a href="${safeOnboardingUrl}"
                     target="_blank" rel="noopener noreferrer"
                     style="display:inline-block; background:#2563eb; color:#ffffff; text-decoration:none; padding:12px 18px; border-radius:12px; font-weight:900; font-size:14px;">
                    ${esc(primaryText)}
                  </a>

                  <div style="margin-top:10px; font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:12px; color:#6b7280;">
                    Or copy/paste:
                    <span style="word-break:break-all; font-family: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">
                      ${esc(truncateMiddle(onboardingUrl, 96))}
                    </span>
                  </div>
                </div>
              </td>
            </tr>

            ${contractorBlock}

            <!-- Security note -->
            <tr>
              <td style="padding:0 24px 10px;">
                <div style="border-radius:14px; padding:12px 14px; background:#f8fafc; border:1px dashed #cbd5e1;
                            font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial; color:#475569; font-size:12.5px; line-height:1.55;">
                  <b style="color:#0f172a;">Security note:</b>
                  We will never ask you to send SSN/EIN over email. Enter information only on the official Property Santa page.
                </div>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:14px 24px 22px; font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;">
                <div style="font-size:12px; color:#94a3b8; line-height:1.6;">
                  If you didn’t request this, you can ignore this email.
                </div>
                <div style="margin-top:10px; font-size:12px; color:#cbd5e1;">
                  <span style="color:#94a3b8;">© ${year} Property Santa</span>
                </div>
              </td>
            </tr>
          </table>

          <div style="height:18px;"></div>

          <div style="font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:11px; color:#9ca3af; max-width:640px; line-height:1.5; padding:0 14px;">
            This message was sent by Property Santa Ops.
          </div>

        </td>
      </tr>
    </table>
  </body>
  </html>`;
}

async function nodeFetch(url, options) {
  if (typeof fetch === "function") return fetch(url, options); // Node 18+
  const mod = await import("node-fetch");
  return (mod.default || mod)(url, options);
}

/* ------------------------------ route ----------------------------- */
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

    // NOTE: for production, set INVITE_FROM to a verified domain address
    // e.g. "Property Santa <no-reply@propertysanta.app>"
    const from = process.env.INVITE_FROM || "Property Santa <onboarding@resend.dev>";
    const reply_to = process.env.INVITE_REPLY_TO || "support@propertysanta.app";

    const is1099 = String(role || "").toLowerCase() === "1099";
    const subject = is1099
      ? "Property Santa — Contractor onboarding"
      : "Property Santa — Employee onboarding";

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
