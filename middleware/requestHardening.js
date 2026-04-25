const crypto = require("crypto");
const { getClientIp } = require("./rateLimit");

function requestContext(req, res, next) {
  const incomingId = String(req.headers["x-request-id"] || "").trim();
  const requestId = incomingId || crypto.randomUUID();

  req.requestId = requestId;
  req.requestStartedAt = Date.now();
  res.locals.requestId = requestId;

  res.setHeader("X-Request-Id", requestId);
  return next();
}

function securityHeaders(req, res, next) {
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");

  const proto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  if (process.env.NODE_ENV === "production" && (req.secure || proto === "https")) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=15552000; includeSubDomains"
    );
  }

  return next();
}

function httpAuditLogger(req, res, next) {
  const startedAt = Date.now();

  res.on("finish", () => {
    try {
      const payload = {
        ts: new Date().toISOString(),
        requestId: req.requestId || null,
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        ip: getClientIp(req),
        userId:
          req.userId ||
          req.user?._id ||
          req.user?.userId ||
          req.userDoc?._id ||
          null,
        tenantId:
          req.tenantId ||
          req.headers["x-tenant-id"] ||
          req.body?.tenantId ||
          req.query?.tenantId ||
          null,
      };

      const logger = res.statusCode >= 500 ? console.error : console.info;
      logger("[http_audit]", JSON.stringify(payload));
    } catch (_) {}
  });

  return next();
}

function blockDebugInProduction(req, res, next) {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({
      ok: false,
      error: "Not found",
      requestId: req.requestId || null,
    });
  }

  return next();
}

module.exports = {
  requestContext,
  securityHeaders,
  httpAuditLogger,
  blockDebugInProduction,
};