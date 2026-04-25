const express = require("express");
const crypto = require("crypto");
const { auth } = require("../middleware/auth");
const {
  requireTenantAccess,
  requireTenantRole,
  getActorFirebaseUid,
} = require("../middleware/tenantAccess");
const { getFirestore, serverTimestamp } = require("../lib/firebaseAdminApp");
const { tenantCollection, tenantDoc } = require("../lib/tenantFirestore");
const { ensureUserTenantContext } = require("../lib/tenantBootstrap");
const User = require("../models/User");

const {
  getPlanConfig,
  getFeatureFlags,
  normalizePlanCode,
  normalizeInterval,
} = require("../src/lib/plan.util");

const router = express.Router();

const INVITABLE_ROLES = new Set(["admin", "ops", "accountant", "viewer"]);
const ROLE_UPDATE_OPTIONS = new Set(["admin", "ops", "accountant", "viewer"]);

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanString(value) {
  return String(value || "").trim();
}

function normalizeRole(value, fallback = "viewer") {
  const role = cleanString(value).toLowerCase();
  return INVITABLE_ROLES.has(role) || role === "owner" ? role : fallback;
}

function timestampToIso(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

async function getQueryCount(ref) {
  try {
    if (ref && typeof ref.count === "function") {
      const snap = await ref.count().get();
      const data = typeof snap?.data === "function" ? snap.data() : {};
      const count = Number(data?.count || 0);
      if (Number.isFinite(count)) return count;
    }
  } catch (err) {
    // fallback below
  }

  const snap = await ref.get();
  return snap.size || 0;
}

function makeInviteToken() {
  return crypto.randomBytes(24).toString("hex");
}

function hashInviteToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function getPortalBaseUrl(req) {
  const configured = cleanString(process.env.PORTAL_BASE_URL);
  if (configured) return configured.replace(/\/+$/, "");

  const origin = cleanString(req.headers.origin);
  if (origin) return origin.replace(/\/+$/, "");

  return "http://localhost:5173";
}

function buildAcceptInviteUrl(req, token) {
  return `${getPortalBaseUrl(req)}/accept-invite?token=${encodeURIComponent(token)}`;
}

async function sendInviteEmail({ toEmail, role, tenantName, invitedBy, acceptUrl }) {
  const apiKey = cleanString(process.env.RESEND_API_KEY);
  if (!apiKey) {
    return { sent: false, provider: "disabled" };
  }

  const subject = `You were invited to join ${tenantName}`;
  const from = process.env.INVITE_FROM || "Property Santa <onboarding@resend.dev>";
  const replyTo = process.env.INVITE_REPLY_TO || "support@propertysanta.app";

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:640px; margin:0 auto; padding:24px; color:#0f172a;">
      <h2 style="margin:0 0 12px;">Workspace invite</h2>
      <p style="margin:0 0 12px;">You were invited to join <strong>${tenantName}</strong>.</p>
      <p style="margin:0 0 12px;">Assigned role: <strong>${role}</strong></p>
      <p style="margin:0 0 20px;">Invited by: <strong>${invitedBy}</strong></p>
      <a href="${acceptUrl}" style="display:inline-block; background:#111827; color:#fff; text-decoration:none; padding:12px 18px; border-radius:10px;">
        Accept invite
      </a>
      <p style="margin:20px 0 0; font-size:12px; color:#64748b;">
        If you did not expect this email, you can ignore it.
      </p>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [toEmail],
      subject,
      reply_to: replyTo,
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Invite email failed with HTTP ${res.status}`);
  }

  return { sent: true, provider: "resend" };
}

async function findInviteByToken(db, token) {
  const tokenHash = hashInviteToken(token);

  const snap = await db
    .collectionGroup("invites")
    .where("tokenHash", "==", tokenHash)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const inviteDoc = snap.docs[0];
  const invite = inviteDoc.data() || {};
  const tenantId = inviteDoc.ref.parent.parent?.id || cleanString(invite.tenantId);

  return {
    inviteRef: inviteDoc.ref,
    invite,
    tenantId,
  };
}

async function getFreshSessionForRequest(req) {
  const firebaseUid = getActorFirebaseUid(req);
  const user = await User.findById(req.userId);

  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  const session = await ensureUserTenantContext(user, {
    firebaseUid,
    email: req.user?.email || user.email,
    displayName: user.name,
  });

  return {
    user,
    session,
  };
}

const MANAGE_WORKSPACE_ROLES = new Set(["owner", "admin"]);
const SUPPORT_CATEGORIES = new Set(["general", "billing", "technical", "onboarding"]);
const SUPPORT_PRIORITIES = new Set(["low", "normal", "high"]);

function canManageWorkspaceRole(role) {
  return MANAGE_WORKSPACE_ROLES.has(cleanString(role).toLowerCase());
}

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function sortDescByCreatedAt(a, b) {
  return timestampMs(b.createdAt) - timestampMs(a.createdAt);
}

function normalizeSupportCategory(value, fallback = "general") {
  const v = cleanString(value).toLowerCase();
  return SUPPORT_CATEGORIES.has(v) ? v : fallback;
}

function normalizeSupportPriority(value, fallback = "normal") {
  const v = cleanString(value).toLowerCase();
  return SUPPORT_PRIORITIES.has(v) ? v : fallback;
}

function titleizeEvent(value = "") {
  return cleanString(value)
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

async function buildWorkspaceOverview(db, tenantId, tenantRole, actorUid) {
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  if (!tenantSnap.exists) {
    const err = new Error("Tenant not found");
    err.statusCode = 404;
    throw err;
  }

  const tenant = tenantSnap.data() || {};
  const planCode = normalizePlanCode(tenant.plan || "free");
  const billingInterval = normalizeInterval(tenant.billingInterval || "monthly");
  const plan = getPlanConfig(planCode);
  const featureFlags = getFeatureFlags(planCode);

  const canManage = canManageWorkspaceRole(tenantRole);

  const supportRef = tenantCollection(db, tenantId, "supportTickets");
  const auditRef = tenantCollection(db, tenantId, "auditLogs");
  const billingRef = tenantCollection(db, tenantId, "billingEvents");

  const [activeMembers, pendingInvites, receiptsCount, invoicesCount, contractorsCount, supportOpenCount, supportSnap, auditSnap, billingSnap] = await Promise.all([
    getQueryCount(tenantCollection(db, tenantId, "members").where("status", "==", "active")),
    getQueryCount(tenantCollection(db, tenantId, "invites").where("status", "==", "pending")),
    getQueryCount(tenantCollection(db, tenantId, "retailReceipts")),
    getQueryCount(tenantCollection(db, tenantId, "invoices")),
    getQueryCount(tenantCollection(db, tenantId, "contractBusinesses")),
    getQueryCount(supportRef.where("status", "==", "open")),
    canManage
      ? supportRef.orderBy("createdAt", "desc").limit(20).get()
      : supportRef.where("requesterUid", "==", cleanString(actorUid)).get(),
    canManage
      ? auditRef.orderBy("createdAt", "desc").limit(8).get()
      : Promise.resolve(null),
    canManage
      ? billingRef.orderBy("createdAt", "desc").limit(8).get()
      : Promise.resolve(null),
  ]);

  const seatsIncluded = Number(plan.seatsIncluded || 1);
  const seatsRemaining =
    seatsIncluded >= 900 ? 999 : Math.max(seatsIncluded - activeMembers, 0);
  const usagePercent =
    seatsIncluded > 0 && seatsIncluded < 900
      ? Math.min(100, Math.round((activeMembers / seatsIncluded) * 100))
      : 0;


  const auditRows = canManage
    ? auditSnap.docs.map((doc) => {
      const row = doc.data() || {};
      return {
        id: `audit_${doc.id}`,
        kind: "audit",
        title: titleizeEvent(row.action || "workspace.activity"),
        description:
          cleanString(row.actorEmail || "") ||
          cleanString(row.targetEmail || "") ||
          cleanString(row.targetCollection || ""),
        createdAt: timestampToIso(row.createdAt),
      };
    })
    : [];

  const billingRows = canManage
    ? billingSnap.docs.map((doc) => {
      const row = doc.data() || {};
      return {
        id: `billing_${doc.id}`,
        kind: "billing",
        title: titleizeEvent(row.type || "billing.event"),
        description:
          cleanString(row.status || "") ||
          cleanString(row.providerPlanId || "") ||
          cleanString(row.providerSubscriptionId || ""),
        createdAt: timestampToIso(row.createdAt),
      };
    })
    : [];

  const supportRows = supportSnap.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
    .filter((row) => canManage || cleanString(row.requesterUid) === cleanString(actorUid))
    .map((row) => ({
      id: `support_${row.id}`,
      kind: "support",
      title: row.subject ? `Support · ${row.subject}` : "Support ticket",
      description:
        cleanString(row.status || "open") +
        (row.category ? ` • ${cleanString(row.category)}` : ""),
      createdAt: timestampToIso(row.createdAt),
    }));

  const recentActivity = [...auditRows, ...billingRows, ...supportRows]
    .sort(sortDescByCreatedAt)
    .slice(0, 8);

  const checklist = [
    {
      id: "workspace_profile",
      title: "Complete workspace profile",
      description: "Give your workspace a clean product-facing name.",
      done: cleanString(tenant.name).length >= 3,
      actionKey: "profile",
    },
    {
      id: "invite_first_member",
      title: "Invite your first member",
      description: "Add a teammate, accountant, or ops user.",
      done: activeMembers + pendingInvites > 1,
      actionKey: "invite",
    },
    {
      id: "billing_ready",
      title: "Review plan and billing",
      description: "Choose the right plan and confirm billing state.",
      done: ["trialing", "pending", "active", "paused"].includes(
        cleanString(tenant.billingStatus || "trialing").toLowerCase()
      ),
      actionKey: "billing",
    },
    {
      id: "receipt_flow",
      title: "Import first receipt",
      description: "Validate that receipt ingestion works for this workspace.",
      done: receiptsCount > 0,
      actionKey: "receipts",
    },
    {
      id: "invoice_flow",
      title: "Create first invoice",
      description: "Confirm invoice creation and payment flow.",
      done: invoicesCount > 0,
      actionKey: "invoices",
    },
    {
      id: "contractor_or_vendor",
      title: "Add contractor or vendor",
      description: "Prepare compliance and payment reconciliation.",
      done: contractorsCount > 0,
      actionKey: "contractor",
    },
  ];

  return {
    workspace: {
      tenantId,
      name: cleanString(tenant.name || tenantId),
      slug: cleanString(tenant.slug || ""),
      description: cleanString(tenant.description || ""),
      planCode,
      billingInterval,
      billingStatus: cleanString(tenant.billingStatus || "trialing"),
      trialEndsAt: timestampToIso(tenant.trialEndsAt),
    },
    featureFlags,
    canManageBilling: canManage,
    usage: {
      activeMembers,
      pendingInvites,
      seatsIncluded,
      seatsRemaining,
      usagePercent,
      limitsReached: seatsIncluded < 900 && activeMembers >= seatsIncluded,
      receiptsCount: receiptsCount || 0,
      invoicesCount: invoicesCount || 0,
      contractorsCount: contractorsCount || 0,
      supportOpenCount,
    },
    checklist,
    recentActivity,
    support: {
      supportEmail: cleanString(process.env.SUPPORT_EMAIL || "support@propertysanta.app"),
      latestTickets: supportRows.slice(0, 5),
    },
  };
}

router.get("/invites/public/:token", async (req, res) => {
  try {
    const db = getFirestore();
    const token = cleanString(req.params.token);

    if (!token) {
      return res.status(400).json({ ok: false, error: "Invite token is required" });
    }

    const found = await findInviteByToken(db, token);
    if (!found) {
      return res.status(404).json({ ok: false, error: "Invite not found" });
    }

    const { invite, tenantId } = found;
    const expiresAt = timestampToIso(invite.expiresAt);

    if (invite.status !== "pending") {
      return res.status(400).json({ ok: false, error: "Invite is no longer pending" });
    }

    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
      return res.status(400).json({ ok: false, error: "Invite has expired" });
    }

    const tenantSnap = await getFirestore().collection("tenants").doc(tenantId).get();
    const tenant = tenantSnap.exists ? tenantSnap.data() || {} : {};

    return res.json({
      ok: true,
      data: {
        tenantId,
        tenantName: cleanString(tenant.name || tenantId),
        role: cleanString(invite.role || "viewer"),
        email: cleanString(invite.email || ""),
        status: cleanString(invite.status || "pending"),
        expiresAt,
      },
    });
  } catch (err) {
    console.error("public invite lookup failed:", err);
    return res.status(500).json({ ok: false, error: "Could not load invite" });
  }
});

router.use(auth);

router.get("/session", async (req, res) => {
  try {
    const { user, session } = await getFreshSessionForRequest(req);

    return res.json({
      ok: true,
      data: {
        user: user.toJSON(),
        ...session,
      },
    });
  } catch (err) {
    console.error("workspace session failed:", err);
    return res.status(err.statusCode || 500).json({
      ok: false,
      error: err.message || "Could not load workspace session",
    });
  }
});

router.post("/switch", async (req, res) => {
  try {
    const db = getFirestore();
    const tenantId = cleanString(req.body?.tenantId);
    const firebaseUid = getActorFirebaseUid(req);

    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "tenantId is required" });
    }

    if (!firebaseUid) {
      return res.status(401).json({ ok: false, error: "Firebase identity is required" });
    }

    const memberSnap = await db
      .collection("tenants")
      .doc(tenantId)
      .collection("members")
      .doc(firebaseUid)
      .get();

    if (!memberSnap.exists || cleanString(memberSnap.data()?.status) !== "active") {
      return res.status(403).json({
        ok: false,
        error: "You do not have access to this tenant",
      });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    user.defaultTenantId = tenantId;
    await user.save();

    await db.collection("users").doc(firebaseUid).set(
      {
        defaultTenantId: tenantId,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    const session = await ensureUserTenantContext(user, {
      firebaseUid,
      email: req.user?.email || user.email,
      displayName: user.name,
    });

    return res.json({
      ok: true,
      data: {
        user: user.toJSON(),
        ...session,
      },
    });
  } catch (err) {
    console.error("workspace switch failed:", err);
    return res.status(500).json({ ok: false, error: "Could not switch workspace" });
  }
});

router.get("/overview", requireTenantAccess, async (req, res) => {
  try {
    const db = getFirestore();
    const data = await buildWorkspaceOverview(
      db,
      req.tenantId,
      req.tenantRole,
      getActorFirebaseUid(req)
    );

    return res.json({ ok: true, data });
  } catch (err) {
    console.error("workspace overview failed:", err);
    return res.status(err.statusCode || 500).json({
      ok: false,
      error: err.message || "Could not load workspace overview",
    });
  }
});

router.patch(
  "/profile",
  requireTenantAccess,
  requireTenantRole(["owner", "admin"]),
  async (req, res) => {
    try {
      const db = getFirestore();
      const name = cleanString(req.body?.name || "");
      const description = cleanString(req.body?.description || "");

      if (name.length < 3) {
        return res.status(400).json({
          ok: false,
          error: "Workspace name must be at least 3 characters",
        });
      }

      await db.collection("tenants").doc(req.tenantId).set(
        {
          name,
          description,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      await tenantCollection(db, req.tenantId, "auditLogs").add({
        action: "workspace_profile_updated",
        tenantId: req.tenantId,
        actorUid: getActorFirebaseUid(req),
        actorEmail: cleanEmail(req.user?.email),
        createdAt: serverTimestamp(),
      });

      return res.json({
        ok: true,
        data: {
          tenantId: req.tenantId,
          name,
          description,
        },
      });
    } catch (err) {
      console.error("workspace profile update failed:", err);
      return res.status(500).json({
        ok: false,
        error: "Could not update workspace profile",
      });
    }
  }
);

router.get(
  "/activity",
  requireTenantAccess,
  requireTenantRole(["owner", "admin"]),
  async (req, res) => {
    try {
      const db = getFirestore();
      const limit = Math.max(1, Math.min(100, Number(req.query?.limit || 40)));

      const [auditSnap, billingSnap, supportSnap] = await Promise.all([
        tenantCollection(db, req.tenantId, "auditLogs").get(),
        tenantCollection(db, req.tenantId, "billingEvents").get(),
        tenantCollection(db, req.tenantId, "supportTickets").get(),
      ]);

      const rows = [
        ...auditSnap.docs.map((doc) => {
          const row = doc.data() || {};
          return {
            id: `audit_${doc.id}`,
            kind: "audit",
            title: titleizeEvent(row.action || "workspace.activity"),
            description:
              cleanString(row.actorEmail || "") ||
              cleanString(row.targetEmail || "") ||
              cleanString(row.targetCollection || ""),
            createdAt: timestampToIso(row.createdAt),
          };
        }),
        ...billingSnap.docs.map((doc) => {
          const row = doc.data() || {};
          return {
            id: `billing_${doc.id}`,
            kind: "billing",
            title: titleizeEvent(row.type || "billing.event"),
            description:
              cleanString(row.status || "") ||
              cleanString(row.providerPlanId || "") ||
              cleanString(row.providerSubscriptionId || ""),
            createdAt: timestampToIso(row.createdAt),
          };
        }),
        ...supportSnap.docs.map((doc) => {
          const row = doc.data() || {};
          return {
            id: `support_${doc.id}`,
            kind: "support",
            title: row.subject ? `Support · ${row.subject}` : "Support ticket",
            description:
              cleanString(row.status || "open") +
              (row.category ? ` • ${cleanString(row.category)}` : ""),
            createdAt: timestampToIso(row.createdAt),
          };
        }),
      ]
        .sort(sortDescByCreatedAt)
        .slice(0, limit);

      return res.json({ ok: true, data: rows });
    } catch (err) {
      console.error("workspace activity failed:", err);
      return res.status(500).json({
        ok: false,
        error: "Could not load workspace activity",
      });
    }
  }
);

router.get("/support", requireTenantAccess, async (req, res) => {
  try {
    const db = getFirestore();
    const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 10)));
    const canManage = canManageWorkspaceRole(req.tenantRole);
    const actorUid = cleanString(getActorFirebaseUid(req));

    const snap = await tenantCollection(db, req.tenantId, "supportTickets").get();

    const rows = snap.docs
      .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
      .filter((row) => canManage || cleanString(row.requesterUid) === actorUid)
      .sort(sortDescByCreatedAt)
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        subject: cleanString(row.subject),
        category: cleanString(row.category || "general"),
        priority: cleanString(row.priority || "normal"),
        status: cleanString(row.status || "open"),
        requesterEmail: cleanString(row.requesterEmail || ""),
        createdAt: timestampToIso(row.createdAt),
      }));

    return res.json({
      ok: true,
      data: {
        supportEmail: cleanString(process.env.SUPPORT_EMAIL || "support@propertysanta.app"),
        tickets: rows,
      },
    });
  } catch (err) {
    console.error("workspace support list failed:", err);
    return res.status(500).json({
      ok: false,
      error: "Could not load support tickets",
    });
  }
});

router.post("/support", requireTenantAccess, async (req, res) => {
  try {
    const db = getFirestore();
    const subject = cleanString(req.body?.subject || "");
    const message = cleanString(req.body?.message || "");
    const category = normalizeSupportCategory(req.body?.category || "general");
    const priority = normalizeSupportPriority(req.body?.priority || "normal");

    if (subject.length < 3) {
      return res.status(400).json({
        ok: false,
        error: "Support subject must be at least 3 characters",
      });
    }

    if (message.length < 8) {
      return res.status(400).json({
        ok: false,
        error: "Support message must be at least 8 characters",
      });
    }

    const ref = tenantCollection(db, req.tenantId, "supportTickets").doc();

    await ref.set({
      subject,
      message,
      category,
      priority,
      status: "open",
      requesterUid: cleanString(getActorFirebaseUid(req)),
      requesterEmail: cleanEmail(req.user?.email),
      requesterRole: cleanString(req.tenantRole || ""),
      tenantId: req.tenantId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await tenantCollection(db, req.tenantId, "auditLogs").add({
      action: "workspace_support_ticket_created",
      tenantId: req.tenantId,
      actorUid: getActorFirebaseUid(req),
      actorEmail: cleanEmail(req.user?.email),
      createdAt: serverTimestamp(),
    });

    return res.status(201).json({
      ok: true,
      data: {
        id: ref.id,
        subject,
        status: "open",
      },
    });
  } catch (err) {
    console.error("workspace support create failed:", err);
    return res.status(500).json({
      ok: false,
      error: "Could not create support ticket",
    });
  }
});

router.get(
  "/members",
  requireTenantAccess,
  requireTenantRole(["owner", "admin"]),
  async (req, res) => {
    try {
      const snap = await tenantCollection(getFirestore(), req.tenantId, "members").get();
      const rows = snap.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) => {
          const aRole = cleanString(a.role);
          const bRole = cleanString(b.role);
          if (aRole !== bRole) return aRole.localeCompare(bRole);
          return cleanString(a.email).localeCompare(cleanString(b.email));
        });

      return res.json({ ok: true, data: rows });
    } catch (err) {
      console.error("workspace members failed:", err);
      return res.status(500).json({ ok: false, error: "Could not load workspace members" });
    }
  }
);

router.get(
  "/invites",
  requireTenantAccess,
  requireTenantRole(["owner", "admin"]),
  async (req, res) => {
    try {
      const snap = await tenantCollection(getFirestore(), req.tenantId, "invites").get();
      const rows = snap.docs
        .map((doc) => {
          const data = doc.data() || {};
          return {
            id: doc.id,
            email: cleanString(data.email),
            role: cleanString(data.role),
            status: cleanString(data.status || "pending"),
            invitedByEmail: cleanString(data.invitedByEmail),
            invitedByUid: cleanString(data.invitedByUid),
            createdAt: timestampToIso(data.createdAt),
            updatedAt: timestampToIso(data.updatedAt),
            expiresAt: timestampToIso(data.expiresAt),
            acceptedAt: timestampToIso(data.acceptedAt),
          };
        })
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

      return res.json({ ok: true, data: rows });
    } catch (err) {
      console.error("workspace invites failed:", err);
      return res.status(500).json({ ok: false, error: "Could not load workspace invites" });
    }
  }
);

router.post(
  "/invites",
  requireTenantAccess,
  requireTenantRole(["owner", "admin"]),
  async (req, res) => {
    try {
      const db = getFirestore();
      const tenantId = req.tenantId;
      const email = cleanEmail(req.body?.email);
      const displayName = cleanString(req.body?.displayName);
      const role = normalizeRole(req.body?.role, "viewer");
      const firebaseUid = getActorFirebaseUid(req);

      if (!email) {
        return res.status(400).json({ ok: false, error: "Invite email is required" });
      }

      if (!INVITABLE_ROLES.has(role)) {
        return res.status(400).json({ ok: false, error: "Invalid invite role" });
      }

      if (email === cleanEmail(req.user?.email)) {
        return res.status(400).json({ ok: false, error: "You cannot invite your own email" });
      }

      const actor = await User.findById(req.userId).select("_id email name firebaseUid");
      const tenantSnap = await db.collection("tenants").doc(tenantId).get();
      const tenant = tenantSnap.exists ? tenantSnap.data() || {} : {};

      const existingInvitesSnap = await tenantCollection(db, tenantId, "invites")
        .where("emailLower", "==", email)
        .get();

      const batch = db.batch();
      existingInvitesSnap.docs.forEach((doc) => {
        const data = doc.data() || {};
        const status = cleanString(data.status || "pending");
        if (status === "pending") {
          batch.set(
            doc.ref,
            {
              status: "replaced",
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
        }
      });

      const rawToken = makeInviteToken();
      const inviteRef = tenantCollection(db, tenantId, "invites").doc();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      batch.set(inviteRef, {
        tenantId,
        email,
        emailLower: email,
        displayName: displayName || null,
        role,
        status: "pending",
        tokenHash: hashInviteToken(rawToken),
        invitedByUid: firebaseUid,
        invitedByEmail: cleanEmail(actor?.email || req.user?.email),
        invitedByName: cleanString(actor?.name || actor?.email || req.user?.email),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        expiresAt,
      });

      batch.set(
        tenantCollection(db, tenantId, "auditLogs").doc(),
        {
          action: "workspace_invite_created",
          tenantId,
          targetEmail: email,
          role,
          actorUid: firebaseUid,
          actorEmail: cleanEmail(actor?.email || req.user?.email),
          createdAt: serverTimestamp(),
        },
        { merge: true }
      );

      await batch.commit();

      const acceptUrl = buildAcceptInviteUrl(req, rawToken);
      const emailResult = await sendInviteEmail({
        toEmail: email,
        role,
        tenantName: cleanString(tenant.name || tenantId),
        invitedBy: cleanString(actor?.name || actor?.email || req.user?.email),
        acceptUrl,
      }).catch((err) => ({
        sent: false,
        provider: "resend",
        error: err.message || "Email send failed",
      }));

      return res.json({
        ok: true,
        data: {
          tenantId,
          email,
          role,
          status: "pending",
          inviteId: inviteRef.id,
          emailSent: !!emailResult.sent,
          ...(process.env.NODE_ENV !== "production" ? { devAcceptUrl: acceptUrl } : {}),
          ...(emailResult.error ? { emailError: emailResult.error } : {}),
        },
      });
    } catch (err) {
      console.error("workspace invite create failed:", err);
      return res.status(500).json({ ok: false, error: "Could not create workspace invite" });
    }
  }
);

router.post("/invites/accept", async (req, res) => {
  try {
    const db = getFirestore();
    const token = cleanString(req.body?.token);
    const makeDefault = req.body?.makeDefault !== false;
    const firebaseUid = getActorFirebaseUid(req);

    if (!token) {
      return res.status(400).json({ ok: false, error: "Invite token is required" });
    }

    if (!firebaseUid) {
      return res.status(401).json({ ok: false, error: "Firebase identity is required" });
    }

    const found = await findInviteByToken(db, token);
    if (!found) {
      return res.status(404).json({ ok: false, error: "Invite not found" });
    }

    const { inviteRef, invite, tenantId } = found;
    const inviteEmail = cleanEmail(invite.email || invite.emailLower);
    const actorEmail = cleanEmail(req.user?.email);

    if (invite.status !== "pending") {
      return res.status(400).json({ ok: false, error: "Invite is no longer pending" });
    }

    const expiresAt = timestampToIso(invite.expiresAt);
    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
      await inviteRef.set(
        {
          status: "expired",
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      return res.status(400).json({ ok: false, error: "Invite has expired" });
    }

    if (inviteEmail && actorEmail && inviteEmail !== actorEmail) {
      return res.status(403).json({
        ok: false,
        error: "This invite was issued for a different email address",
      });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const userRef = db.collection("users").doc(firebaseUid);
    const userSnap = await userRef.get();
    const firestoreUser = userSnap.exists ? userSnap.data() || {} : {};

    const activeTenantIds = Array.from(
      new Set([
        ...(Array.isArray(user.activeTenantIds) ? user.activeTenantIds : []),
        ...(Array.isArray(firestoreUser.activeTenantIds) ? firestoreUser.activeTenantIds : []),
        tenantId,
      ])
    );

    const nextDefaultTenantId = makeDefault
      ? tenantId
      : cleanString(user.defaultTenantId || firestoreUser.defaultTenantId || tenantId);

    const memberRef = tenantDoc(db, tenantId, "members", firebaseUid);

    const batch = db.batch();
    batch.set(
      memberRef,
      {
        uid: firebaseUid,
        email: actorEmail || cleanEmail(user.email),
        emailLower: actorEmail || cleanEmail(user.email),
        displayName: cleanString(user.name || actorEmail || user.email),
        role: normalizeRole(invite.role, "viewer"),
        status: "active",
        invitedByUid: cleanString(invite.invitedByUid),
        invitedByEmail: cleanString(invite.invitedByEmail),
        invitedAt: invite.createdAt || serverTimestamp(),
        joinedAt: serverTimestamp(),
        userId: String(user._id),
        updatedAt: serverTimestamp(),
        lastActiveAt: serverTimestamp(),
      },
      { merge: true }
    );

    batch.set(
      userRef,
      {
        uid: firebaseUid,
        email: actorEmail || cleanEmail(user.email),
        emailLower: actorEmail || cleanEmail(user.email),
        displayName: cleanString(user.name || actorEmail || user.email),
        defaultTenantId: nextDefaultTenantId,
        activeTenantIds,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    batch.set(
      inviteRef,
      {
        status: "accepted",
        acceptedByUid: firebaseUid,
        acceptedByEmail: actorEmail || cleanEmail(user.email),
        acceptedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    batch.set(
      tenantCollection(db, tenantId, "auditLogs").doc(),
      {
        action: "workspace_invite_accepted",
        tenantId,
        actorUid: firebaseUid,
        actorEmail: actorEmail || cleanEmail(user.email),
        role: normalizeRole(invite.role, "viewer"),
        createdAt: serverTimestamp(),
      },
      { merge: true }
    );

    await batch.commit();

    user.activeTenantIds = activeTenantIds;
    user.defaultTenantId = nextDefaultTenantId;
    await user.save();

    const session = await ensureUserTenantContext(user, {
      firebaseUid,
      email: actorEmail || user.email,
      displayName: user.name,
    });

    return res.json({
      ok: true,
      data: {
        user: user.toJSON(),
        acceptedTenantId: tenantId,
        ...session,
      },
    });
  } catch (err) {
    console.error("workspace invite accept failed:", err);
    return res.status(500).json({ ok: false, error: "Could not accept workspace invite" });
  }
});

router.patch(
  "/members/:uid/role",
  requireTenantAccess,
  requireTenantRole(["owner"]),
  async (req, res) => {
    try {
      const db = getFirestore();
      const targetUid = cleanString(req.params.uid);
      const role = normalizeRole(req.body?.role, "");

      if (!targetUid) {
        return res.status(400).json({ ok: false, error: "Member uid is required" });
      }

      if (!ROLE_UPDATE_OPTIONS.has(role)) {
        return res.status(400).json({ ok: false, error: "Invalid role update" });
      }

      if (targetUid === getActorFirebaseUid(req)) {
        return res.status(400).json({
          ok: false,
          error: "Owner cannot demote themselves from this screen",
        });
      }

      const memberRef = tenantDoc(db, req.tenantId, "members", targetUid);
      const memberSnap = await memberRef.get();

      if (!memberSnap.exists) {
        return res.status(404).json({ ok: false, error: "Member not found" });
      }

      await memberRef.set(
        {
          role,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      await tenantCollection(db, req.tenantId, "auditLogs").add({
        action: "workspace_member_role_updated",
        tenantId: req.tenantId,
        targetUid,
        role,
        actorUid: getActorFirebaseUid(req),
        actorEmail: cleanEmail(req.user?.email),
        createdAt: serverTimestamp(),
      });

      return res.json({
        ok: true,
        data: {
          uid: targetUid,
          role,
        },
      });
    } catch (err) {
      console.error("workspace member role update failed:", err);
      return res.status(500).json({ ok: false, error: "Could not update member role" });
    }
  }
);

module.exports = router;