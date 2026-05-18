const express = require("express");
const { authOptional } = require("../middleware/auth");
const { makeRateLimiter } = require("../middleware/rateLimit");
const startHereAiController = require("../controllers/startHereAiController");
const startHereAiCache = require("../services/startHereAiCache");

const router = express.Router();

const publicChatLimiter = makeRateLimiter({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === "production" ? 20 : 120,
  keyPrefix: "start_here_ai_chat",
});

router.get("/status", (req, res) => {
  const geminiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_AI_API_KEY ||
    "";

  res.json({
    ok: true,
    service: "start_here_ai",
    hasGeminiKey: String(geminiKey).trim().length > 0,
    model: process.env.START_HERE_GEMINI_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
    timeoutMs: Number(process.env.START_HERE_GEMINI_TIMEOUT_MS || process.env.GEMINI_TIMEOUT_MS || 9000),
    cache: startHereAiCache.getStats(),
    nodeEnv: process.env.NODE_ENV || "development",
  });
});

// Public StartHere website intake chat.
// This is intentionally separate from /api/ai/*, which is the existing cleaner/task AI module.
router.post("/chat", publicChatLimiter, authOptional, startHereAiController.startHereChat);

module.exports = router;