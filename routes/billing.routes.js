const express = require("express");
const router = express.Router();

const { requireTenantAccess, requireTenantRole, normString } = require("../middleware/tenantAccess");
const { getFirestore, serverTimestamp } = require("../lib/firebaseAdminApp");
const { tenantCollection, tenantDoc } = require("../lib/tenantFirestore");
const {
  listPlans,
  getPlanConfig,
  getFeatureFlags,
  normalizePlanCode,
  normalizeInterval,
  getPayPalPlanId,
  getPlanFromPayPalPlanId,
  getPlanSnapshot,
} = require("../src/lib/plan.util");
const {
  createPayPalSubscription,
  revisePayPalSubscription,
  getPayPalSubscription,
  suspendPayPalSubscription,
  activatePayPalSubscription,
  cancelPayPalSubscription,
} = require("../src/services/paypalBilling");

const MANAGE_ROLES = ["owner", "admin"];

function tsToIso(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

function parseCustomId(value = "") {
  const out = {};
  String(value || "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const i = part.indexOf(":");
      if (i === -1) return;
      const key = part.slice(0, i).trim();
      const val = part.slice(i + 1).trim();
      if (key) out[key] = val;
    });
  return out;
}

function mapPayPalSubscriptionState(status = "") {
  const raw = String(status || "").trim().toUpperCase();

  switch (raw) {
    case "APPROVAL_PENDING":
      return { billingStatus: "pending", subscriptionStatus: "approval_pending" };
    case "APPROVED":
      return { billingStatus: "pending", subscriptionStatus: "approved" };
    case "ACTIVE":
      return { billingStatus: "active", subscriptionStatus: "active" };
    case "SUSPENDED":
      return { billingStatus: "paused", subscriptionStatus: "suspended" };
    case "CANCELLED":
      return { billingStatus: "canceled", subscriptionStatus: "cancelled" };
    case "EXPIRED":
      return { billingStatus: "expired", subscriptionStatus: "expired" };
    default:
      return { billingStatus: "inactive", subscriptionStatus: raw.toLowerCase() || "inactive" };
  }
}

function removeUndefined(obj = {}) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined)
  );
}

function canManageBillingForRole(role) {
  return MANAGE_ROLES.includes(String(role || "").trim().toLowerCase());
}

function getPortalBaseUrl(req) {
  const configured = String(process.env.PORTAL_BASE_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");

  const origin = String(req.headers.origin || "").trim();
  if (origin) return origin.replace(/\/+$/, "");

  return "http://localhost:5173";
}

function getReturnUrls(req) {
  const base = getPortalBaseUrl(req);
  return {
    returnUrl: `${base}/workspace?billing=approved`,
    cancelUrl: `${base}/workspace?billing=cancelled`,
  };
}

async function appendBillingEvent(db, tenantId, payload = {}) {
  await tenantCollection(db, tenantId, "billingEvents").add({
    ...payload,
    tenantId,
    createdAt: serverTimestamp(),
  });
}

async function ensureTenantBillingDefaults(db, tenantId) {
  const tenantRef = db.collection("tenants").doc(String(tenantId));
  const snap = await tenantRef.get();

  if (!snap.exists) {
    const err = new Error("Tenant not found");
    err.statusCode = 404;
    throw err;
  }

  const tenant = snap.data() || {};
  const patch = {};

  const planCode = normalizePlanCode(tenant.plan || "free");
  const interval = normalizeInterval(tenant.billingInterval || "monthly");

  const createdAtIso = tsToIso(tenant.createdAt);
  const createdAt = createdAtIso ? new Date(createdAtIso) : new Date();
  const trialEndsAtIso = tsToIso(tenant.trialEndsAt);
  const defaultTrialEndsAt = trialEndsAtIso
    ? new Date(trialEndsAtIso)
    : addDays(createdAt, getPlanConfig(planCode).trialDays || 14);

  const trialExpired = defaultTrialEndsAt.getTime() <= Date.now();

  if (!tenant.plan) patch.plan = planCode;
  if (!tenant.billingProvider) patch.billingProvider = "paypal";
  if (!tenant.billingInterval) patch.billingInterval = interval;
  if (!tenant.trialEndsAt) patch.trialEndsAt = defaultTrialEndsAt;
  if (!tenant.billingStatus) {
    patch.billingStatus = tenant.providerSubscriptionId
      ? "pending"
      : trialExpired
        ? "inactive"
        : "trialing";
  }

  if (Object.keys(patch).length) {
    patch.billingUpdatedAt = serverTimestamp();
    await tenantRef.set(patch, { merge: true });
  }

  return {
    tenantRef,
    tenant: { ...tenant, ...patch },
  };
}

async function applySubscriptionSnapshot(db, tenantId, subscription, { eventType = "" } = {}) {
  const tenantRef = db.collection("tenants").doc(String(tenantId));
  const parsedCustom = parseCustomId(subscription?.custom_id || "");
  const mapped = mapPayPalSubscriptionState(subscription?.status || "");
  const planLookup = getPlanFromPayPalPlanId(subscription?.plan_id || subscription?.plan?.id || "");

  const planCode = normalizePlanCode(
    planLookup?.planCode || parsedCustom.plan || "free"
  );
  const interval = normalizeInterval(
    planLookup?.interval || parsedCustom.interval || "monthly"
  );

  const billingInfo = subscription?.billing_info || {};
  const lastPayment = billingInfo?.last_payment || {};
  const patch = removeUndefined({
    plan: planCode,
    billingProvider: "paypal",
    billingInterval: interval,
    billingStatus: mapped.billingStatus,
    subscriptionStatus: mapped.subscriptionStatus,
    providerSubscriptionId: subscription?.id || null,
    providerPlanId: subscription?.plan_id || subscription?.plan?.id || null,
    billingPayerEmail: subscription?.subscriber?.email_address || null,
    billingPayerId: subscription?.subscriber?.payer_id || null,
    nextBillingAt: billingInfo?.next_billing_time || null,
    currentPeriodEnd: billingInfo?.next_billing_time || null,
    failedPaymentsCount: Number(billingInfo?.failed_payments_count || 0),
    lastPaymentAt: lastPayment?.time || null,
    lastPaymentAmount: lastPayment?.amount?.value
      ? Number(lastPayment.amount.value)
      : undefined,
    currency: lastPayment?.amount?.currency_code || undefined,
    billingStartedAt: subscription?.create_time || undefined,
    pendingProviderSubscriptionId: null,
    pendingProviderPlanId: null,
    billingApprovalUrl: null,
    billingLastSyncedAt: serverTimestamp(),
    billingUpdatedAt: serverTimestamp(),
  });

  if (mapped.billingStatus === "active") {
    patch.trialEndedAt = serverTimestamp();
  }

  await tenantRef.set(patch, { merge: true });

  if (subscription?.id) {
    await tenantDoc(db, tenantId, "billingSubscriptions", subscription.id).set(
      {
        ...patch,
        raw: subscription,
        updatedAt: serverTimestamp(),
        ...(eventType ? { lastEventType: eventType } : {}),
      },
      { merge: true }
    );
  }

  if (eventType) {
    await appendBillingEvent(db, tenantId, {
      type: eventType,
      providerSubscriptionId: subscription?.id || null,
      providerPlanId: subscription?.plan_id || subscription?.plan?.id || null,
      status: subscription?.status || null,
    });
  }

  return patch;
}

function buildSummaryPayload(tenant = {}, tenantId, role) {
  const planCode = normalizePlanCode(tenant.plan || "free");
  const interval = normalizeInterval(tenant.billingInterval || "monthly");
  const trialEndsAt = tsToIso(tenant.trialEndsAt);
  const trialExpired = trialEndsAt ? new Date(trialEndsAt).getTime() <= Date.now() : false;
  const currentPlan = getPlanSnapshot({
    planCode,
    interval,
    billingStatus: tenant.billingStatus || "inactive",
  });

  return {
    tenantId,
    provider: "paypal",
    canManageBilling: canManageBillingForRole(role),
    catalog: listPlans(),
    featureFlags: getFeatureFlags(planCode),
    state: {
      ...currentPlan,
      providerSubscriptionId: tenant.providerSubscriptionId || null,
      providerPlanId: tenant.providerPlanId || null,
      billingStatus: String(tenant.billingStatus || "inactive"),
      subscriptionStatus: String(tenant.subscriptionStatus || "").trim().toLowerCase() || null,
      billingInterval: interval,
      trialEndsAt,
      trialExpired,
      billingPayerEmail: tenant.billingPayerEmail || null,
      nextBillingAt: tsToIso(tenant.nextBillingAt),
      currentPeriodEnd: tsToIso(tenant.currentPeriodEnd),
      lastPaymentAt: tsToIso(tenant.lastPaymentAt),
      lastPaymentAmount:
        tenant.lastPaymentAmount == null ? null : Number(tenant.lastPaymentAmount),
      failedPaymentsCount: Number(tenant.failedPaymentsCount || 0),
      pendingProviderSubscriptionId: tenant.pendingProviderSubscriptionId || null,
      pendingProviderPlanId: tenant.pendingProviderPlanId || null,
      approvalUrlPending: tenant.billingApprovalUrl || null,
      seatsIncluded: getPlanConfig(planCode).seatsIncluded,
    },
  };
}

router.use(requireTenantAccess);

router.get("/summary", async (req, res) => {
  try {
    const db = getFirestore();
    const { tenant } = await ensureTenantBillingDefaults(db, req.tenantId);

    return res.json({
      ok: true,
      data: buildSummaryPayload(tenant, req.tenantId, req.tenantRole),
    });
  } catch (err) {
    console.error("billing summary failed:", err);
    return res.status(err.statusCode || 500).json({
      ok: false,
      error: err.message || "Could not load billing summary",
    });
  }
});

router.post("/subscribe", requireTenantRole(MANAGE_ROLES), async (req, res) => {
  try {
    const db = getFirestore();
    const { tenantRef, tenant } = await ensureTenantBillingDefaults(db, req.tenantId);

    const planCode = normalizePlanCode(req.body?.planCode || "starter");
    const interval = normalizeInterval(req.body?.interval || "monthly");

    if (planCode === "enterprise") {
      return res.status(400).json({
        ok: false,
        error: "Enterprise is handled manually. Contact sales for this tier.",
      });
    }

    if (planCode === "free") {
      await tenantRef.set(
        {
          plan: "free",
          billingInterval: "monthly",
          billingStatus:
            tenant.trialEndsAt && new Date(tsToIso(tenant.trialEndsAt)).getTime() > Date.now()
              ? "trialing"
              : "inactive",
          subscriptionStatus: null,
          providerSubscriptionId: null,
          providerPlanId: null,
          pendingProviderSubscriptionId: null,
          pendingProviderPlanId: null,
          billingApprovalUrl: null,
          billingUpdatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      await appendBillingEvent(db, req.tenantId, {
        type: "billing.switch_free",
        targetPlan: "free",
      });

      const fresh = (await tenantRef.get()).data() || {};
      return res.json({
        ok: true,
        data: buildSummaryPayload(fresh, req.tenantId, req.tenantRole),
      });
    }

    const paypalPlanId = getPayPalPlanId(planCode, interval);
    if (!paypalPlanId) {
      return res.status(400).json({
        ok: false,
        error: `Missing PayPal plan id for ${planCode}/${interval}`,
      });
    }

    const { returnUrl, cancelUrl } = getReturnUrls(req);
    const customId = `tenant:${req.tenantId}|plan:${planCode}|interval:${interval}`;

    let providerResponse = null;
    let mode = "create";

    if (tenant.providerSubscriptionId) {
      providerResponse = await revisePayPalSubscription(tenant.providerSubscriptionId, {
        planId: paypalPlanId,
        returnUrl,
        cancelUrl,
      });
      mode = "revise";
    } else {
      providerResponse = await createPayPalSubscription({
        planId: paypalPlanId,
        customId,
        subscriberEmail: req.user?.email || "",
        returnUrl,
        cancelUrl,
      });
    }

    const approveUrl =
      (providerResponse?.links || []).find((item) => item.rel === "approve")?.href || null;

    const providerSubscriptionId =
      providerResponse?.id || tenant.providerSubscriptionId || null;

    await tenantRef.set(
      {
        plan: planCode,
        billingInterval: interval,
        billingProvider: "paypal",
        billingStatus: approveUrl ? "pending" : "inactive",
        subscriptionStatus: approveUrl ? "approval_pending" : null,
        pendingProviderSubscriptionId: providerSubscriptionId,
        pendingProviderPlanId: paypalPlanId,
        billingApprovalUrl: approveUrl,
        billingUpdatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    if (providerSubscriptionId) {
      await tenantDoc(
        db,
        req.tenantId,
        "billingSubscriptions",
        providerSubscriptionId
      ).set(
        {
          providerSubscriptionId,
          providerPlanId: paypalPlanId,
          plan: planCode,
          billingInterval: interval,
          status: "approval_pending",
          updatedAt: serverTimestamp(),
          raw: providerResponse,
        },
        { merge: true }
      );
    }

    await appendBillingEvent(db, req.tenantId, {
      type: "billing.subscribe_requested",
      mode,
      targetPlan: planCode,
      targetInterval: interval,
      providerSubscriptionId,
      providerPlanId: paypalPlanId,
    });

    return res.json({
      ok: true,
      data: {
        mode,
        planCode,
        interval,
        providerSubscriptionId,
        approveUrl,
      },
    });
  } catch (err) {
    console.error("billing subscribe failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Could not start billing checkout",
    });
  }
});

router.post("/sync", async (req, res) => {
  try {
    const db = getFirestore();
    const { tenantRef, tenant } = await ensureTenantBillingDefaults(db, req.tenantId);

    const subscriptionId =
      normString(req.body?.subscriptionId) ||
      normString(tenant.providerSubscriptionId) ||
      normString(tenant.pendingProviderSubscriptionId);

    if (!subscriptionId) {
      const fresh = (await tenantRef.get()).data() || {};
      return res.json({
        ok: true,
        data: buildSummaryPayload(fresh, req.tenantId, req.tenantRole),
      });
    }

    const providerSubscription = await getPayPalSubscription(subscriptionId);
    await applySubscriptionSnapshot(db, req.tenantId, providerSubscription, {
      eventType: "billing.manual_sync",
    });

    const fresh = (await tenantRef.get()).data() || {};
    return res.json({
      ok: true,
      data: buildSummaryPayload(fresh, req.tenantId, req.tenantRole),
    });
  } catch (err) {
    console.error("billing sync failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Could not sync billing state",
    });
  }
});

router.post("/pause", requireTenantRole(MANAGE_ROLES), async (req, res) => {
  try {
    const db = getFirestore();
    const { tenantRef, tenant } = await ensureTenantBillingDefaults(db, req.tenantId);
    const subscriptionId = normString(tenant.providerSubscriptionId);

    if (!subscriptionId) {
      return res.status(400).json({
        ok: false,
        error: "No active PayPal subscription found for this tenant",
      });
    }

    await suspendPayPalSubscription(
      subscriptionId,
      normString(req.body?.reason || "Paused by workspace admin")
    );

    await tenantRef.set(
      {
        billingStatus: "paused",
        subscriptionStatus: "suspended",
        billingUpdatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    await appendBillingEvent(db, req.tenantId, {
      type: "billing.paused",
      providerSubscriptionId: subscriptionId,
    });

    const fresh = (await tenantRef.get()).data() || {};
    return res.json({
      ok: true,
      data: buildSummaryPayload(fresh, req.tenantId, req.tenantRole),
    });
  } catch (err) {
    console.error("billing pause failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Could not pause billing",
    });
  }
});

router.post("/reactivate", requireTenantRole(MANAGE_ROLES), async (req, res) => {
  try {
    const db = getFirestore();
    const { tenantRef, tenant } = await ensureTenantBillingDefaults(db, req.tenantId);
    const subscriptionId =
      normString(tenant.providerSubscriptionId) ||
      normString(tenant.pendingProviderSubscriptionId);

    if (!subscriptionId) {
      return res.status(400).json({
        ok: false,
        error: "No PayPal subscription found for this tenant",
      });
    }

    await activatePayPalSubscription(
      subscriptionId,
      normString(req.body?.reason || "Reactivated by workspace admin")
    );

    const providerSubscription = await getPayPalSubscription(subscriptionId);
    await applySubscriptionSnapshot(db, req.tenantId, providerSubscription, {
      eventType: "billing.reactivated",
    });

    const fresh = (await tenantRef.get()).data() || {};
    return res.json({
      ok: true,
      data: buildSummaryPayload(fresh, req.tenantId, req.tenantRole),
    });
  } catch (err) {
    console.error("billing reactivate failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Could not reactivate billing",
    });
  }
});

router.post("/cancel", requireTenantRole(MANAGE_ROLES), async (req, res) => {
  try {
    const db = getFirestore();
    const { tenantRef, tenant } = await ensureTenantBillingDefaults(db, req.tenantId);
    const subscriptionId = normString(tenant.providerSubscriptionId);

    if (!subscriptionId) {
      return res.status(400).json({
        ok: false,
        error: "No active PayPal subscription found for this tenant",
      });
    }

    await cancelPayPalSubscription(
      subscriptionId,
      normString(req.body?.reason || "Canceled by workspace admin")
    );

    await tenantRef.set(
      {
        billingStatus: "canceled",
        subscriptionStatus: "cancelled",
        billingApprovalUrl: null,
        pendingProviderSubscriptionId: null,
        pendingProviderPlanId: null,
        billingUpdatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    await appendBillingEvent(db, req.tenantId, {
      type: "billing.cancelled",
      providerSubscriptionId: subscriptionId,
    });

    const fresh = (await tenantRef.get()).data() || {};
    return res.json({
      ok: true,
      data: buildSummaryPayload(fresh, req.tenantId, req.tenantRole),
    });
  } catch (err) {
    console.error("billing cancel failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Could not cancel billing",
    });
  }
});

module.exports = router;