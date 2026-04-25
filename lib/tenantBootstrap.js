const { getFirestore, serverTimestamp } = require("./firebaseAdminApp");

function toSlug(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function uniqueStrings(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [values])
        .map((v) => String(v || "").trim())
        .filter(Boolean)
    )
  );
}

function sameString(a, b) {
  return String(a || "").trim() === String(b || "").trim();
}

function sameStringArray(a = [], b = []) {
  return uniqueStrings(a).join("|") === uniqueStrings(b).join("|");
}

function buildOwnedWorkspaceTenantId(user) {
  return `tenant_${String(user?._id || "unknown")}`;
}

function buildActorUid(identity = {}, user = null) {
  const firebaseUid = String(identity?.firebaseUid || "").trim();
  if (firebaseUid) return firebaseUid;

  const mongoUserId = String(identity?.userId || user?._id || "").trim();
  if (mongoUserId) return `legacy:${mongoUserId}`;

  return "";
}

function normalizeRole(value, fallback = "viewer") {
  const role = String(value || "").trim().toLowerCase();
  if (["owner", "admin", "ops", "accountant", "viewer"].includes(role)) {
    return role;
  }
  return fallback;
}

function normalizeStatus(value, fallback = "active") {
  const status = String(value || "").trim().toLowerCase();
  if (["invited", "active", "suspended", "removed"].includes(status)) {
    return status;
  }
  return fallback;
}

function pickCurrentTenantId(preferredTenantId, activeTenantIds = [], ownedTenantId = null) {
  const active = uniqueStrings(activeTenantIds);
  const preferred = String(preferredTenantId || "").trim();
  const owned = String(ownedTenantId || "").trim();

  if (preferred && active.includes(preferred)) return preferred;
  if (owned && active.includes(owned)) return owned;
  return active[0] || owned || null;
}

async function ensureOwnedWorkspace(db, user, identity) {
  const firebaseUid = String(identity?.firebaseUid || "").trim();
  const actorUid = buildActorUid(identity, user);
  const email = String(identity?.email || "").trim().toLowerCase();
  const displayName =
    String(identity?.displayName || user?.name || "").trim() ||
    (email ? email.split("@")[0] : "Workspace");

  const tenantId = buildOwnedWorkspaceTenantId(user);
  const tenantRef = db.collection("tenants").doc(tenantId);
  const memberRef = tenantRef.collection("members").doc(actorUid);

  const [tenantSnap, memberSnap] = await Promise.all([tenantRef.get(), memberRef.get()]);

  const desiredTenantName = `${displayName} Workspace`;
  const desiredTenantSlug = toSlug(`${displayName}-${tenantId}`) || tenantId;

  const tenantData = tenantSnap.exists ? tenantSnap.data() || {} : {};
  const memberData = memberSnap.exists ? memberSnap.data() || {} : {};

  const tenantNeedsWrite =
    !tenantSnap.exists ||
    !sameString(tenantData.name, desiredTenantName) ||
    !sameString(tenantData.slug, desiredTenantSlug) ||
    !sameString(tenantData.ownerUid, actorUid) ||
    !sameString(tenantData.ownerFirebaseUid, firebaseUid || "") ||
    !sameString(tenantData.ownerMongoUserId, String(user._id)) ||
    !sameString(tenantData.status, "active") ||
    !sameString(tenantData.plan, "free") ||
    !sameString(tenantData.billingProvider, "paypal") ||
    !sameString(tenantData.billingInterval, "monthly") ||
    !sameString(tenantData.billingStatus, "trialing");

  const memberNeedsWrite =
    !memberSnap.exists ||
    !sameString(memberData.uid, actorUid) ||
    !sameString(memberData.firebaseUid, firebaseUid || "") ||
    !sameString(memberData.email, email) ||
    !sameString(memberData.emailLower, email) ||
    !sameString(memberData.displayName, displayName) ||
    !sameString(memberData.role, "owner") ||
    !sameString(memberData.status, "active") ||
    !sameString(memberData.userId, String(user._id));

  if (tenantNeedsWrite || memberNeedsWrite) {
    const batch = db.batch();

    if (tenantNeedsWrite) {
      const tenantPayload = {
        name: desiredTenantName,
        slug: desiredTenantSlug,
        ownerUid: actorUid,
        ownerFirebaseUid: firebaseUid || null,
        ownerMongoUserId: String(user._id),
        status: "active",
        plan: "free",
        billingProvider: "paypal",
        billingInterval: "monthly",
        billingStatus: "trialing",
        updatedAt: serverTimestamp(),
      };

      if (!tenantSnap.exists) {
        tenantPayload.createdAt = serverTimestamp();
        tenantPayload.trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      }

      batch.set(tenantRef, tenantPayload, { merge: true });
    }

    if (memberNeedsWrite) {
      const memberPayload = {
        uid: actorUid,
        firebaseUid: firebaseUid || null,
        email,
        emailLower: email,
        displayName,
        role: "owner",
        status: "active",
        userId: String(user._id),
        updatedAt: serverTimestamp(),
      };

      if (!memberSnap.exists) {
        memberPayload.joinedAt = serverTimestamp();
      }

      batch.set(memberRef, memberPayload, { merge: true });
    }

    await batch.commit();
  }

  return tenantId;
}

async function hydrateMemberships(db, actorUid, tenantIds = []) {
  const ids = uniqueStrings(tenantIds);
  if (!ids.length || !actorUid) return [];

  const rows = await Promise.all(
    ids.map(async (tenantId) => {
      const tenantRef = db.collection("tenants").doc(tenantId);
      const memberRef = tenantRef.collection("members").doc(actorUid);

      const [tenantSnap, memberSnap] = await Promise.all([tenantRef.get(), memberRef.get()]);
      if (!tenantSnap.exists || !memberSnap.exists) return null;

      const tenant = tenantSnap.data() || {};
      const member = memberSnap.data() || {};

      return {
        tenantId,
        tenantName: String(tenant.name || tenantId),
        tenantSlug: String(tenant.slug || ""),
        tenantStatus: String(tenant.status || "active"),
        plan: String(tenant.plan || "free"),
        billingStatus: String(tenant.billingStatus || "trialing"),
        role: normalizeRole(member.role),
        status: normalizeStatus(member.status),
      };
    })
  );

  return rows.filter(Boolean);
}

async function ensureUserTenantContext(user, identity) {
  const db = getFirestore();

  const firebaseUid = String(identity?.firebaseUid || "").trim();
  const actorUid = buildActorUid(identity, user);
  const email = String(identity?.email || "").trim().toLowerCase();
  const displayName =
    String(identity?.displayName || user?.name || "").trim() ||
    (email ? email.split("@")[0] : "Workspace");

  if (!actorUid) {
    throw new Error("ensureUserTenantContext requires actor identity");
  }

  const userRef = db.collection("users").doc(actorUid);
  const userSnap = await userRef.get();
  const firestoreUser = userSnap.exists ? userSnap.data() || {} : {};

  const knownTenantIds = uniqueStrings([
    ...(Array.isArray(user.activeTenantIds) ? user.activeTenantIds : []),
    ...(Array.isArray(firestoreUser.activeTenantIds) ? firestoreUser.activeTenantIds : []),
    user.defaultTenantId,
    firestoreUser.defaultTenantId,
  ]);

  let ownedTenantId = "";
  if (!knownTenantIds.length) {
    ownedTenantId = await ensureOwnedWorkspace(db, user, {
      firebaseUid,
      userId: String(user?._id || ""),
      email,
      displayName,
    });
  }

  const candidateTenantIds = uniqueStrings([...knownTenantIds, ownedTenantId]);

  const memberships = await hydrateMemberships(db, actorUid, candidateTenantIds);
  const activeTenantIds = uniqueStrings(
    memberships.filter((m) => m.status === "active").map((m) => m.tenantId)
  );

  const preferredDefaultTenantId =
    String(user.defaultTenantId || firestoreUser.defaultTenantId || "").trim() ||
    ownedTenantId;

  const defaultTenantId = pickCurrentTenantId(
    preferredDefaultTenantId,
    activeTenantIds,
    ownedTenantId
  );

  const userNeedsWrite =
    !userSnap.exists ||
    !sameString(firestoreUser.uid, actorUid) ||
    !sameString(firestoreUser.firebaseUid, firebaseUid || "") ||
    !sameString(firestoreUser.email, email) ||
    !sameString(firestoreUser.emailLower, email) ||
    !sameString(firestoreUser.displayName, displayName) ||
    !sameString(firestoreUser.defaultTenantId, defaultTenantId || "") ||
    !sameStringArray(firestoreUser.activeTenantIds || [], activeTenantIds);

  if (userNeedsWrite) {
    const userPayload = {
      uid: actorUid,
      firebaseUid: firebaseUid || null,
      email,
      emailLower: email,
      displayName,
      defaultTenantId,
      activeTenantIds,
      updatedAt: serverTimestamp(),
    };

    if (!userSnap.exists) {
      userPayload.createdAt = serverTimestamp();
    }

    await userRef.set(userPayload, { merge: true });
  }

  let mongoChanged = false;

  if (String(user.defaultTenantId || "") !== String(defaultTenantId || "")) {
    user.defaultTenantId = defaultTenantId;
    mongoChanged = true;
  }

  const existingActive = uniqueStrings(user.activeTenantIds || []);
  if (!sameStringArray(existingActive, activeTenantIds)) {
    user.activeTenantIds = activeTenantIds;
    mongoChanged = true;
  }

  if (mongoChanged) {
    await user.save();
  }

  return {
    currentTenantId: defaultTenantId,
    activeTenantIds,
    memberships: memberships.map((m) => ({
      ...m,
      isDefault: m.tenantId === defaultTenantId,
    })),
  };
}

module.exports = {
  buildOwnedWorkspaceTenantId,
  ensureUserTenantContext,
};