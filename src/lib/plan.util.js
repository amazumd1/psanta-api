const PLAN_CATALOG = {
  free: {
    code: "free",
    name: "Free",
    badge: "Start",
    monthlyPrice: 0,
    yearlyPrice: 0,
    trialDays: 14,
    seatsIncluded: 1,
    description: "For solo trialing and basic workspace setup.",
    features: [
      "1 active member",
      "Workspace setup",
      "Basic receipts",
      "Basic invoices",
    ],
    featureFlags: {
      workspaceMembers: 1,
      receipts: true,
      invoices: true,
      payroll: false,
      bankReconcile: false,
      compliance1099: false,
      aiAutomation: false,
      auditExports: false,
      prioritySupport: false,
    },
  },
  starter: {
    code: "starter",
    name: "Starter",
    badge: "Best for solo ops",
    monthlyPrice: 29,
    yearlyPrice: 290,
    trialDays: 14,
    seatsIncluded: 1,
    description: "For single-operator businesses running the core back office.",
    features: [
      "1 active member",
      "Receipts + invoices",
      "Payroll basics",
      "Basic 1099 tracking",
    ],
    featureFlags: {
      workspaceMembers: 1,
      receipts: true,
      invoices: true,
      payroll: true,
      bankReconcile: false,
      compliance1099: true,
      aiAutomation: false,
      auditExports: false,
      prioritySupport: false,
    },
  },
  pro: {
    code: "pro",
    name: "Pro",
    badge: "Popular",
    monthlyPrice: 79,
    yearlyPrice: 790,
    trialDays: 14,
    seatsIncluded: 3,
    description: "For growing teams that need compliance and reconciliation.",
    features: [
      "Up to 3 active members",
      "Bank reconcile",
      "1099 compliance",
      "AI-assisted workflows",
    ],
    featureFlags: {
      workspaceMembers: 3,
      receipts: true,
      invoices: true,
      payroll: true,
      bankReconcile: true,
      compliance1099: true,
      aiAutomation: true,
      auditExports: false,
      prioritySupport: false,
    },
  },
  team: {
    code: "team",
    name: "Team",
    badge: "Operations team",
    monthlyPrice: 149,
    yearlyPrice: 1490,
    trialDays: 14,
    seatsIncluded: 10,
    description: "For multi-seat SaaS customers with real team workflows.",
    features: [
      "Up to 10 active members",
      "Advanced audit trail",
      "Priority billing support",
      "Full automation stack",
    ],
    featureFlags: {
      workspaceMembers: 10,
      receipts: true,
      invoices: true,
      payroll: true,
      bankReconcile: true,
      compliance1099: true,
      aiAutomation: true,
      auditExports: true,
      prioritySupport: true,
    },
  },
  enterprise: {
    code: "enterprise",
    name: "Enterprise",
    badge: "Custom",
    monthlyPrice: null,
    yearlyPrice: null,
    trialDays: 14,
    seatsIncluded: 999,
    description: "For custom contracts, onboarding, and negotiated billing.",
    features: [
      "Custom seats",
      "Custom onboarding",
      "Priority support",
      "Custom agreement",
    ],
    featureFlags: {
      workspaceMembers: 999,
      receipts: true,
      invoices: true,
      payroll: true,
      bankReconcile: true,
      compliance1099: true,
      aiAutomation: true,
      auditExports: true,
      prioritySupport: true,
    },
  },
};

function normalizePlanCode(value = "free") {
  const code = String(value || "").trim().toLowerCase();
  return PLAN_CATALOG[code] ? code : "free";
}

function normalizeInterval(value = "monthly") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "year" || raw === "yearly" || raw === "annual") return "yearly";
  return "monthly";
}

function getPlanConfig(planCode = "free") {
  return PLAN_CATALOG[normalizePlanCode(planCode)];
}

function listPlans() {
  return Object.values(PLAN_CATALOG);
}

function getFeatureFlags(planCode = "free") {
  return { ...getPlanConfig(planCode).featureFlags };
}

function buildPayPalPlanEnvName(planCode, interval) {
  const code = normalizePlanCode(planCode).toUpperCase();
  const cycle = normalizeInterval(interval) === "yearly" ? "YEARLY" : "MONTHLY";
  return `PAYPAL_PLAN_${code}_${cycle}_ID`;
}

function getPayPalPlanId(planCode, interval) {
  const envName = buildPayPalPlanEnvName(planCode, interval);
  return String(process.env[envName] || "").trim();
}

function getPlanFromPayPalPlanId(planId) {
  const needle = String(planId || "").trim();
  if (!needle) return null;

  for (const plan of Object.values(PLAN_CATALOG)) {
    for (const interval of ["monthly", "yearly"]) {
      const mapped = getPayPalPlanId(plan.code, interval);
      if (mapped && mapped === needle) {
        return { planCode: plan.code, interval };
      }
    }
  }

  return null;
}

function getPlanSnapshot({ planCode, interval, billingStatus }) {
  const plan = getPlanConfig(planCode);
  const cycle = normalizeInterval(interval);
  return {
    planCode: plan.code,
    planName: plan.name,
    badge: plan.badge,
    billingStatus: String(billingStatus || "").trim().toLowerCase() || "inactive",
    interval: cycle,
    price: cycle === "yearly" ? plan.yearlyPrice : plan.monthlyPrice,
    featureFlags: getFeatureFlags(plan.code),
  };
}

module.exports = {
  PLAN_CATALOG,
  normalizePlanCode,
  normalizeInterval,
  getPlanConfig,
  listPlans,
  getFeatureFlags,
  getPayPalPlanId,
  getPlanFromPayPalPlanId,
  getPlanSnapshot,
};