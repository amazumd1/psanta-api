const { loadLocalEnv } = require("../lib/loadLocalEnv");
loadLocalEnv();

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");

(async () => {
  try {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error("Missing MONGODB_URI or MONGO_URI");

    const email = process.env.ADMIN_EMAIL;
    const plain = process.env.ADMIN_SEED_PASSWORD;
    const name = process.env.ADMIN_NAME || "Admin";

    if (!email || !plain) {
      throw new Error("ADMIN_EMAIL and ADMIN_SEED_PASSWORD are required");
    }

    await mongoose.connect(uri);

    let u = await User.findOne({ email });
    if (!u) {
      const hash = await bcrypt.hash(plain, 12);
      u = await User.create({
        email,
        password: hash,
        role: "admin",
        name,
      });
      console.log("✅ Seeded admin:", u.email);
    } else {
      console.log("ℹ️ Admin already exists:", u.email);
    }
  } catch (e) {
    console.error("Seed error:", e);
    process.exit(1);
  }
  process.exit(0);
})();