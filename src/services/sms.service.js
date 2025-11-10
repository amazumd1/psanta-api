// services/api/src/services/sms.service.js
const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM, // +1XXXXXXXXXX
} = process.env;

let client = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

async function sendSMS(to, body) {
  if (!client) {
    console.log('[SMS:DRY]', { to, body });
    return { sid: 'DRY_RUN' };
  }
  return client.messages.create({ from: TWILIO_FROM, to, body });
}

module.exports = { sendSMS };
