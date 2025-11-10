const crypto = require('crypto');
function shortId(n = 6) {
  return crypto.randomBytes(Math.ceil(n/2)).toString('hex').slice(0, n);
}
function genMessageId() {
  return `MSG-${shortId(8)}`;
}
module.exports = { genMessageId };
