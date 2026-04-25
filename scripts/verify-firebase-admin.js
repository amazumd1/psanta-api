const { loadLocalEnv } = require("../lib/loadLocalEnv");
loadLocalEnv();

const { admin, ensureFirebaseAdmin } = require("../lib/firebaseAdminApp");
ensureFirebaseAdmin();

async function run() {
  const email = process.env.ADMIN_EMAIL;
  if (!email) {
    throw new Error("ADMIN_EMAIL is required");
  }

  const user = await admin.auth().getUserByEmail(email);

  console.log("Before:", {
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified,
  });

  if (!user.emailVerified) {
    await admin.auth().updateUser(user.uid, {
      emailVerified: true,
    });
  }

  const updated = await admin.auth().getUser(user.uid);

  console.log("After:", {
    uid: updated.uid,
    email: updated.email,
    emailVerified: updated.emailVerified,
  });

  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});