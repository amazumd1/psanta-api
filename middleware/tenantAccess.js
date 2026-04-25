// const { getFirestore } = require("../lib/firebaseAdminApp");

// function normString(v) {
//   const s = String(v ?? "").trim();
//   return s || "";
// }

// function uniqueStrings(values = []) {
//   return Array.from(
//     new Set(
//       (Array.isArray(values) ? values : [values])
//         .map((v) => String(v || "").trim())
//         .filter(Boolean)
//     )
//   );
// }

// function getTenantIdFromReq(req, { allowDefault = true } = {}) {
//   const explicit = normString(
//     req.body?.tenantId ||
//       req.query?.tenantId ||
//       req.headers["x-tenant-id"]
//   );

//   if (explicit) return explicit;
//   if (!allowDefault) return "";

//   return normString(
//     req.userDoc?.defaultTenantId ||
//       req.user?.defaultTenantId
//   );
// }

// function getActorFirebaseUid(req) {
//   const resolved = normString(
//     req.firebaseUser?.uid ||
//       req.userDoc?.firebaseUid ||
//       req.user?.firebaseUid
//   );

//   if (resolved) return resolved;

//   const legacyUserId = normString(
//     req.userId ||
//       req.user?.userId ||
//       req.userDoc?._id
//   );

//   return legacyUserId ? `legacy:${legacyUserId}` : "";
// }

// function getActorActiveTenantIds(req) {
//   return uniqueStrings(
//     req.userDoc?.activeTenantIds ||
//       req.user?.activeTenantIds ||
//       []
//   );
// }

// function buildTenantMongoFilter(req, extra = {}) {
//   if (!req.tenantId) {
//     throw new Error("req.tenantId is not set");
//   }
//   return { ...extra, tenantId: req.tenantId };
// }

// async function requireTenantAccess(req, res, next) {
//   try {
//     const db = getFirestore();
//     const tenantId = getTenantIdFromReq(req);
//     const firebaseUid = getActorFirebaseUid(req);
//     const activeTenantIds = getActorActiveTenantIds(req);

//     if (!tenantId) {
//       return res.status(400).json({
//         success: false,
//         message: "tenantId is required",
//       });
//     }

//     if (!firebaseUid) {
//       return res.status(401).json({
//         success: false,
//         message: "Firebase identity is required for tenant access",
//       });
//     }

//     if (activeTenantIds.length && !activeTenantIds.includes(tenantId)) {
//       return res.status(403).json({
//         success: false,
//         message: "This tenant is not assigned to your account",
//       });
//     }

//     const memberSnap = await db
//       .collection("tenants")
//       .doc(tenantId)
//       .collection("members")
//       .doc(firebaseUid)
//       .get();

//     if (!memberSnap.exists) {
//       return res.status(403).json({
//         success: false,
//         message: "You are not a member of this tenant",
//       });
//     }

//     const member = memberSnap.data() || {};
//     if (String(member.status || "active").toLowerCase() !== "active") {
//       return res.status(403).json({
//         success: false,
//         message: "Tenant membership is not active",
//       });
//     }

//     req.tenantId = tenantId;
//     req.tenantMembership = member;
//     req.tenantRole = String(member.role || "").trim().toLowerCase() || "member";

//     return next();
//   } catch (err) {
//     console.error("requireTenantAccess failed:", err);
//     return res.status(500).json({
//       success: false,
//       message: "Could not validate tenant access",
//     });
//   }
// }

// function requireTenantRole(roles = []) {
//   const allowed = new Set(
//     (Array.isArray(roles) ? roles : [roles])
//       .map((r) => String(r || "").trim().toLowerCase())
//       .filter(Boolean)
//   );

//   return (req, res, next) => {
//     const role = String(req.tenantRole || "").trim().toLowerCase();
//     if (!allowed.size || allowed.has(role)) {
//       return next();
//     }

//     return res.status(403).json({
//       success: false,
//       message: "Tenant role is not allowed for this action",
//     });
//   };
// }

// module.exports = {
//   normString,
//   getTenantIdFromReq,
//   getActorFirebaseUid,
//   getActorActiveTenantIds,
//   buildTenantMongoFilter,
//   requireTenantAccess,
//   requireTenantRole,
// };


const { getFirestore } = require("../lib/firebaseAdminApp");

const TENANT_MEMBERSHIP_CACHE_TTL_MS = Number(process.env.TENANT_MEMBERSHIP_CACHE_TTL_MS || 5 * 60 * 1000);
const tenantMembershipCache = new Map();

function normString(v) {
  const s = String(v ?? "").trim();
  return s || "";
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

function getTenantIdFromReq(req, { allowDefault = true } = {}) {
  const explicit = normString(
    req.body?.tenantId ||
      req.query?.tenantId ||
      req.headers["x-tenant-id"]
  );

  if (explicit) return explicit;
  if (!allowDefault) return "";

  return normString(
    req.userDoc?.defaultTenantId ||
      req.user?.defaultTenantId
  );
}

function getActorFirebaseUid(req) {
  const resolved = normString(
    req.firebaseUser?.uid ||
      req.userDoc?.firebaseUid ||
      req.user?.firebaseUid
  );

  if (resolved) return resolved;

  const legacyUserId = normString(
    req.userId ||
      req.user?.userId ||
      req.userDoc?._id
  );

  return legacyUserId ? `legacy:${legacyUserId}` : "";
}

function getActorActiveTenantIds(req) {
  return uniqueStrings(
    req.userDoc?.activeTenantIds ||
      req.user?.activeTenantIds ||
      []
  );
}

function buildTenantMongoFilter(req, extra = {}) {
  if (!req.tenantId) {
    throw new Error("req.tenantId is not set");
  }
  return { ...extra, tenantId: req.tenantId };
}

function buildOwnedWorkspaceTenantId(req) {
  const userId = normString(req.userId || req.user?.userId || req.userDoc?._id);
  return userId ? `tenant_${userId}` : "";
}

function buildCacheKey(tenantId, firebaseUid) {
  return `${String(tenantId || "").trim()}::${String(firebaseUid || "").trim()}`;
}

function getCachedTenantMembership(tenantId, firebaseUid) {
  const key = buildCacheKey(tenantId, firebaseUid);
  const entry = tenantMembershipCache.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    tenantMembershipCache.delete(key);
    return null;
  }

  return entry.value || null;
}

function setCachedTenantMembership(tenantId, firebaseUid, membership) {
  const key = buildCacheKey(tenantId, firebaseUid);
  tenantMembershipCache.set(key, {
    value: membership,
    expiresAt: Date.now() + Math.max(30_000, TENANT_MEMBERSHIP_CACHE_TTL_MS),
  });
}

function looksLikeQuotaOrFirestorePressure(err) {
  const msg = String(err?.message || "").toLowerCase();
  const code = String(err?.code || "").toLowerCase();
  return (
    msg.includes("quota") ||
    msg.includes("resource_exhausted") ||
    msg.includes("deadline exceeded") ||
    msg.includes("too much contention") ||
    code === "resource-exhausted" ||
    code === "8"
  );
}

function applyTenantAccess(req, tenantId, membership = {}) {
  req.tenantId = tenantId;
  req.tenantMembership = membership;
  req.tenantRole = String(membership.role || "").trim().toLowerCase() || "member";
}

async function requireTenantAccess(req, res, next) {
  const tenantId = getTenantIdFromReq(req);
  const firebaseUid = getActorFirebaseUid(req);
  const activeTenantIds = getActorActiveTenantIds(req);
  const ownedTenantId = buildOwnedWorkspaceTenantId(req);

  if (!tenantId) {
    return res.status(400).json({
      success: false,
      message: "tenantId is required",
    });
  }

  if (!firebaseUid) {
    return res.status(401).json({
      success: false,
      message: "Firebase identity is required for tenant access",
    });
  }

  if (activeTenantIds.length && !activeTenantIds.includes(tenantId)) {
    return res.status(403).json({
      success: false,
      message: "This tenant is not assigned to your account",
    });
  }

  if (ownedTenantId && tenantId === ownedTenantId) {
    applyTenantAccess(req, tenantId, {
      uid: firebaseUid,
      role: "owner",
      status: "active",
      source: "owned_workspace_shortcut",
    });
    return next();
  }

  const cachedMembership = getCachedTenantMembership(tenantId, firebaseUid);
  if (cachedMembership) {
    applyTenantAccess(req, tenantId, cachedMembership);
    return next();
  }

  try {
    const db = getFirestore();
    const memberSnap = await db
      .collection("tenants")
      .doc(tenantId)
      .collection("members")
      .doc(firebaseUid)
      .get();

    if (!memberSnap.exists) {
      return res.status(403).json({
        success: false,
        message: "You are not a member of this tenant",
      });
    }

    const member = memberSnap.data() || {};
    if (String(member.status || "active").toLowerCase() !== "active") {
      return res.status(403).json({
        success: false,
        message: "Tenant membership is not active",
      });
    }

    setCachedTenantMembership(tenantId, firebaseUid, member);
    applyTenantAccess(req, tenantId, member);
    return next();
  } catch (err) {
    console.error("requireTenantAccess failed:", {
      message: err?.message || String(err),
      code: err?.code || null,
      tenantId,
      firebaseUid,
    });

    if (looksLikeQuotaOrFirestorePressure(err) && activeTenantIds.includes(tenantId)) {
      applyTenantAccess(req, tenantId, {
        uid: firebaseUid,
        role: tenantId === ownedTenantId ? "owner" : "viewer",
        status: "active",
        source: "quota_fallback",
      });
      return next();
    }

    return res.status(500).json({
      success: false,
      message: "Could not validate tenant access",
      error: "TENANT_ACCESS_CHECK_FAILED",
      debug:
        process.env.NODE_ENV !== "production"
          ? {
              details: err?.message || String(err),
              code: err?.code || null,
              tenantId,
              firebaseUid,
            }
          : undefined,
    });
  }
}

function requireTenantRole(roles = []) {
  const allowed = new Set(
    (Array.isArray(roles) ? roles : [roles])
      .map((r) => String(r || "").trim().toLowerCase())
      .filter(Boolean)
  );

  return (req, res, next) => {
    const role = String(req.tenantRole || "").trim().toLowerCase();
    if (!allowed.size || allowed.has(role)) {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: "Tenant role is not allowed for this action",
    });
  };
}

module.exports = {
  normString,
  getTenantIdFromReq,
  getActorFirebaseUid,
  getActorActiveTenantIds,
  buildTenantMongoFilter,
  requireTenantAccess,
  requireTenantRole,
};