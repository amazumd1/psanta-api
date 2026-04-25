// services/api/lib/firebaseAdmin.js
const admin = require("firebase-admin");

function ensureFirebaseAdmin() {
  if (admin.apps.length) return admin;

  const raw =
    process.env.FIREBASE_ADMIN_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    "";

  if (raw) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
    });
    return admin;
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID || undefined,
  });

  return admin;
}

function getFirestore() {
  return ensureFirebaseAdmin().firestore();
}

module.exports = {
  admin,
  ensureFirebaseAdmin,
  getFirestore,
};