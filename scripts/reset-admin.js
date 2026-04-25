const { loadLocalEnv } = require("../lib/loadLocalEnv");
loadLocalEnv();

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

(async () => {
  try {
    const uri =
      process.env.MONGODB_URI ||
      process.env.MONGO_URI ||
      "mongodb://127.0.0.1:27017/psanta";

    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_SEED_PASSWORD;
    const name = process.env.ADMIN_NAME || "PropertySanta Admin";

    if (!email || !password) {
      throw new Error("ADMIN_EMAIL and ADMIN_SEED_PASSWORD are required");
    }

    await mongoose.connect(uri);
    const db = mongoose.connection.db;

    const hash = await bcrypt.hash(password, 12);

    const res = await db.collection("users").updateOne(
      { email },
      {
        $set: {
          email,
          password: hash,
          role: "admin",
          isActive: true,
          name,
        },
      },
      { upsert: true }
    );

    console.log("✅ Admin reset done:", res);
    await mongoose.disconnect();
  } catch (e) {
    console.error("❌ Reset failed:", e);
    process.exit(1);
  }
})();