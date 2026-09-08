/**
 * Builds a signed Telegram initData string, implemented straight from the
 * published spec using Node's crypto — deliberately independent of the
 * backend's own implementation, so tests verify the algorithm rather than
 * simply agreeing with the code under test.
 *
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */

const crypto = require('crypto');

function signInitData(botToken, fields) {
  const checkString = Object.keys(fields).sort()
    .map(k => k + '=' + fields[k])
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

  return Object.keys(fields)
    .map(k => k + '=' + encodeURIComponent(fields[k]))
    .concat('hash=' + hash)
    .join('&');
}

/** A launch by the given user, valid as of now. */
function launchAs(botToken, userId, extra) {
  return signInitData(botToken, Object.assign({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAF_test',
    user: JSON.stringify({ id: Number(userId), first_name: 'Test', username: 'tester' })
  }, extra || {}));
}

module.exports = { signInitData, launchAs };
