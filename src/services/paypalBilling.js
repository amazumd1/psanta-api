const crypto = require("crypto");
const fetch = require("node-fetch");

function paypalBaseUrl() {
  return process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

async function getPayPalAccessToken() {
  const clientId = String(process.env.PAYPAL_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.PAYPAL_CLIENT_SECRET || "").trim();

  if (!clientId || !clientSecret) {
    throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing");
  }

  const res = await fetch(`${paypalBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.access_token) {
    throw new Error(json?.error_description || "Failed to get PayPal access token");
  }

  return json.access_token;
}

async function paypalRequest(path, { method = "GET", body, headers = {} } = {}) {
  const token = await getPayPalAccessToken();

  const res = await fetch(`${paypalBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return null;

  const text = await res.text().catch(() => "");
  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    throw new Error(
      json?.message ||
      json?.details?.[0]?.description ||
      text ||
      `PayPal request failed (${res.status})`
    );
  }

  return json;
}

async function createPayPalSubscription({
  planId,
  customId,
  subscriberEmail = "",
  returnUrl,
  cancelUrl,
}) {
  return paypalRequest("/v1/billing/subscriptions", {
    method: "POST",
    headers: {
      "PayPal-Request-Id": crypto.randomUUID(),
    },
    body: {
      plan_id: planId,
      custom_id: customId,
      ...(subscriberEmail ? { subscriber: { email_address: subscriberEmail } } : {}),
      application_context: {
        brand_name: "Property Santa",
        user_action: "SUBSCRIBE_NOW",
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    },
  });
}

async function revisePayPalSubscription(subscriptionId, { planId, returnUrl, cancelUrl }) {
  return paypalRequest(`/v1/billing/subscriptions/${subscriptionId}/revise`, {
    method: "POST",
    headers: {
      "PayPal-Request-Id": crypto.randomUUID(),
    },
    body: {
      plan_id: planId,
      application_context: {
        brand_name: "Property Santa",
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    },
  });
}

async function getPayPalSubscription(subscriptionId) {
  return paypalRequest(`/v1/billing/subscriptions/${subscriptionId}`);
}

async function suspendPayPalSubscription(subscriptionId, reason = "Paused by workspace admin") {
  return paypalRequest(`/v1/billing/subscriptions/${subscriptionId}/suspend`, {
    method: "POST",
    body: { reason },
  });
}

async function activatePayPalSubscription(subscriptionId, reason = "Reactivated by workspace admin") {
  return paypalRequest(`/v1/billing/subscriptions/${subscriptionId}/activate`, {
    method: "POST",
    body: { reason },
  });
}

async function cancelPayPalSubscription(subscriptionId, reason = "Canceled by workspace admin") {
  return paypalRequest(`/v1/billing/subscriptions/${subscriptionId}/cancel`, {
    method: "POST",
    body: { reason },
  });
}

async function verifyPayPalWebhookSignature(req) {
  const rawBody =
    Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "", "utf8");

  const event = JSON.parse(rawBody.toString("utf8"));
  const token = await getPayPalAccessToken();

  const res = await fetch(
    `${paypalBaseUrl()}/v1/notifications/verify-webhook-signature`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        auth_algo: req.headers["paypal-auth-algo"],
        cert_url: req.headers["paypal-cert-url"],
        transmission_id: req.headers["paypal-transmission-id"],
        transmission_sig: req.headers["paypal-transmission-sig"],
        transmission_time: req.headers["paypal-transmission-time"],
        webhook_id: process.env.PAYPAL_WEBHOOK_ID,
        webhook_event: event,
      }),
    }
  );

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.verification_status !== "SUCCESS") {
    throw new Error("BAD_PAYPAL_WEBHOOK_SIGNATURE");
  }

  return event;
}

module.exports = {
  createPayPalSubscription,
  revisePayPalSubscription,
  getPayPalSubscription,
  suspendPayPalSubscription,
  activatePayPalSubscription,
  cancelPayPalSubscription,
  verifyPayPalWebhookSignature,
};