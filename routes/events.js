// services/api/routes/events.js
const express = require("express");
const router = express.Router();
router.post("/search", (req, res) => {
  console.log("AMZ_SEARCH", req.body); // or store in DB
  res.json({ ok: true });
});
module.exports = router;

// server.js
app.use("/api/events", require("./routes/events"));
