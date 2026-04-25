// // services/paypal.js  (ya jo bhi aapka path ho)
// const paypal = require('@paypal/checkout-server-sdk');

// function paypalEnv() {
//   const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV } = process.env;
//   if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
//     throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing');
//   }
//   return PAYPAL_ENV === 'live'
//     ? new paypal.core.LiveEnvironment(PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET)
//     : new paypal.core.SandboxEnvironment(PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET);
// }

// function paypalClient() {
//   return new paypal.core.PayPalHttpClient(paypalEnv());
// }

// module.exports = { paypal, paypalClient }; // ✅ export BOTH


// services/paypal.js  (ya jo bhi aapka path ho)
const paypal = require('@paypal/checkout-server-sdk');

function normalizePayPalEnv(value) {
  const env = String(value || '').trim().toLowerCase();
  return env === 'live' || env === 'production' ? 'live' : 'sandbox';
}

function paypalEnv() {
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV } = process.env;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing');
  }

  const resolvedEnv = normalizePayPalEnv(PAYPAL_ENV);
  return resolvedEnv === 'live'
    ? new paypal.core.LiveEnvironment(PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET)
    : new paypal.core.SandboxEnvironment(PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET);
}

function paypalClient() {
  return new paypal.core.PayPalHttpClient(paypalEnv());
}

module.exports = { paypal, paypalClient, normalizePayPalEnv }; // ✅ export BOTH