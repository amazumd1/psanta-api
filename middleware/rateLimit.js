// services/api/middleware/rateLimit.js
const buckets = new Map();

function getClientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.ip || req.connection?.remoteAddress || "";
}

function makeRateLimiter({ windowMs = 60000, max = 60, keyPrefix = "rl", keyFn } = {}) {
  const getKey =
    typeof keyFn === "function"
      ? keyFn
      : (req) => {
          const uid = req.userId || req.user?.id || req.user?._id || req.user?.userId || "";
          const ip = getClientIp(req);
          return uid ? `u:${uid}` : `ip:${ip}`;
        };

  return function rateLimit(req, res, next) {
    try {
      const now = Date.now();
      const key = `${keyPrefix}:${getKey(req)}`;
      let b = buckets.get(key);

      if (!b || now >= b.resetAt) {
        b = { count: 0, resetAt: now + windowMs };
        buckets.set(key, b);
      }

      b.count += 1;
      res.setHeader("X-RateLimit-Limit", String(max));
      res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - b.count)));

      if (b.count > max) {
        const retryAfterMs = Math.max(0, b.resetAt - now);
        res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
        return res.status(429).json({ ok: false, code: "rate_limited", retryAfterMs });
      }

      next();
    } catch {
      next();
    }
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets.entries()) {
    if (!b || now >= b.resetAt + 60000) buckets.delete(k);
  }
}, 60000).unref?.();

module.exports = { makeRateLimiter, getClientIp };
