const { getFirestore, serverTimestamp } = require("../../../lib/firebaseAdminApp");
const { tenantCollection, tenantDoc } = require("../../../lib/tenantFirestore");
const {
  getPlanFromPayPalPlanId,
  normalizePlanCode,
  normalizeInterval,
} = require("../../lib/plan.util");
const {
  verifyPayPalWebhookSignature,
  getPayPalSubscription,
} = require("../../services/paypalBilling");

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

function mapState(status = "") {
  const raw = String(status || "").trim().toUpperCase();
  switch (raw) {
    case "APPROVAL_PENDING":
      return { billingStatus: "pending", subscriptionStatus: "approval_pending" };
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

async function writeBillingEvent(db, tenantId, payload = {}) {
  await tenantCollection(db, tenantId, "billingEvents").add({
    ...payload,
    tenantId,
    createdAt: serverTimestamp(),
  });
}

async function applySnapshot(db, tenantId, subscription, eventType) {
  const parsedCustom = parseCustomId(subscription?.custom_id || "");
  const mappedPlan = getPlanFromPayPalPlanId(
    subscription?.plan_id || subscription?.plan?.id || ""
  );
  const mappedState = mapState(subscription?.status || "");
  const billingInfo = subscription?.billing_info || {};
  const lastPayment = billingInfo?.last_payment || {};

  const patch = removeUndefined({
    plan: normalizePlanCode(mappedPlan?.planCode || parsedCustom.plan || "free"),
    billingInterval: normalizeInterval(mappedPlan?.interval || parsedCustom.interval || "monthly"),
    billingProvider: "paypal",
    billingStatus: mappedState.billingStatus,
    subscriptionStatus: mappedState.subscriptionStatus,
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
    pendingProviderSubscriptionId: null,
    pendingProviderPlanId: null,
    billingApprovalUrl: null,
    billingLastSyncedAt: serverTimestamp(),
    billingUpdatedAt: serverTimestamp(),
  });

  if (mappedState.billingStatus === "active") {
    patch.trialEndedAt = serverTimestamp();
  }

  await db.collection("tenants").doc(tenantId).set(patch, { merge: true });

  if (subscription?.id) {
    await tenantDoc(db, tenantId, "billingSubscriptions", subscription.id).set(
      {
        ...patch,
        raw: subscription,
        lastEventType: eventType,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }

  await writeBillingEvent(db, tenantId, {
    type: eventType,
    providerSubscriptionId: subscription?.id || null,
    providerPlanId: subscription?.plan_id || subscription?.plan?.id || null,
    status: subscription?.status || null,
  });
}

module.exports = async function paypalWebhookHandler(req, res) {
  try {
    const db = getFirestore();
    const event = await verifyPayPalWebhookSignature(req);
    const type = String(event?.event_type || "").trim();

    let subscription = null;
    let tenantId = "";

    if (type.startsWith("BILLING.SUBSCRIPTION.")) {
      if (event?.resource?.id) {
        subscription = await getPayPalSubscription(event.resource.id);
      }
    } else if (type === "PAYMENT.SALE.COMPLETED") {
      const billingAgreementId =
        event?.resource?.billing_agreement_id ||
        event?.resource?.billing_agreement?.id ||
        "";
      if (billingAgreementId) {
        subscription = await getPayPalSubscription(billingAgreementId);
      }
    }

    if (!subscription) {
      return res.json({ ok: true, ignored: true });
    }

    const parsedCustom = parseCustomId(subscription?.custom_id || "");
    tenantId =
      String(parsedCustom.tenant || "").trim() ||
      String(event?.resource?.custom_id || "").trim();

    if (!tenantId) {
      await tenantCollection(db, "_orphans", "billingEvents").add({
        type,
        reason: "missing_tenant_id",
        raw: event,
        createdAt: serverTimestamp(),
      });
      return res.json({ ok: true, orphaned: true });
    }

    if (type === "BILLING.SUBSCRIPTION.PAYMENT.FAILED") {
      await db.collection("tenants").doc(tenantId).set(
        {
          billingStatus: "past_due",
          failedPaymentsCount: Number(subscription?.billing_info?.failed_payments_count || 1),
          billingUpdatedAt: serverTimestamp(),
          billingLastSyncedAt: serverTimestamp(),
        },
        { merge: true }
      );

      await writeBillingEvent(db, tenantId, {
        type,
        providerSubscriptionId: subscription?.id || null,
        status: "PAYMENT_FAILED",
      });

      return res.json({ ok: true });
    }

    await applySnapshot(db, tenantId, subscription, type);
    return res.json({ ok: true });
  } catch (err) {
    console.error("paypal billing webhook failed:", err);
    return res.status(500).json({ ok: false, error: "WEBHOOK_ERROR" });
  }
};