const express = require("express");
const { authOptional } = require("../middleware/auth");
const { makeRateLimiter } = require("../middleware/rateLimit");
const startHereAiController = require("../controllers/startHereAiController");

const router = express.Router();

const publicChatLimiter = makeRateLimiter({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === "production" ? 20 : 120,
  keyPrefix: "start_here_ai_chat",
});

// Public StartHere website intake chat.
// This is intentionally separate from /api/ai/*, which is the existing cleaner/task AI module.
router.post("/chat", publicChatLimiter, authOptional, startHereAiController.startHereChat);

module.exports = router;