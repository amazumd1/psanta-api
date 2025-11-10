// services/api/scripts/reset-admin.js
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

(async () => {
  try {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/psanta";
    await mongoose.connect(uri);
    const db = mongoose.connection.db;

    const email = "admin@gmail.com";
    const hash = await bcrypt.hash("admin123", 10);

    const res = await db.collection("users").updateOne(
      { email },
      { $set: { email, password: hash, role: "admin", isActive: true, name: "PropertySanta Admin" } },
      { upsert: true }
    );

    console.log("✅ Admin reset done:", res);
    await mongoose.disconnect();
  } catch (e) {
    console.error("❌ Reset failed:", e);
    process.exit(1);
  }
})();
