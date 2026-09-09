/**
 * Suite for Telegram identity verification.
 *
 * index.html is served from GitHub Pages, so API_KEY inside it is public —
 * on 2026-09-08 it was committed and published, and a stranger could reach
 * production with it. A static page cannot hold a secret, so the real gate is
 * Telegram's HMAC signature over initData, keyed with the bot token.
 *
 * The signatures below are built here with Node's own crypto, independently of
 * the implementation, so these checks verify the algorithm rather than merely
 * agreeing with themselves.
 */

const crypto = require('crypto');
const stub = require('./helpers/apps-script-stub.js');

module.exports = function (t) {
  const { SS, PROPS } = stub.install();
  eval(stub.backendSource());

  const BOT_TOKEN = PROPS.TELEGRAM_BOT_TOKEN;
  const OWNER_ID = PROPS.TELEGRAM_OWNER_CHAT_ID;

  /** Builds initData exactly the way Telegram documents it. */
  function sign(fields, token) {
    const check = Object.keys(fields).sort().map(k => k + '=' + fields[k]).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token || BOT_TOKEN).digest();
    const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
    const qs = Object.keys(fields).map(k => k + '=' + encodeURIComponent(fields[k]));
    qs.push('hash=' + hash);
    return qs.join('&');
  }

  function launch(overrides) {
    return sign(Object.assign({
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: 'AAF_test',
      user: JSON.stringify({ id: Number(OWNER_ID), first_name: 'Umair', username: 'owner' })
    }, overrides || {}));
  }

  t.section('A genuine Telegram launch is accepted');
  const good = validateInitData_(launch());
  t.check('signature verifies', good.ok === true, good.reason);
  t.check('the user is identified', good.user && String(good.user.id) === String(OWNER_ID));

  t.section('Forged and tampered launches are rejected');
  t.check('a launch signed with the wrong token fails',
    validateInitData_(sign({ auth_date: '1', user: '{"id":1}' }, '9999:WRONGTOKEN')).ok === false);

  const tampered = launch().replace(/user=[^&]*/, 'user=' + encodeURIComponent('{"id":999,"first_name":"Mallory"}'));
  t.check('editing the user after signing breaks the hash', validateInitData_(tampered).ok === false);

  t.check('empty initData is rejected', validateInitData_('').ok === false);
  t.check('missing hash is rejected', validateInitData_('auth_date=1&user=%7B%22id%22%3A1%7D').ok === false);
  t.check('a random string is rejected', validateInitData_('garbage').ok === false);
  t.check('a valid signature with no user is rejected',
    validateInitData_(sign({ auth_date: String(Math.floor(Date.now() / 1000)) })).ok === false);

  t.section('Stale launches expire');
  const old = launch({ auth_date: String(Math.floor(Date.now() / 1000) - 40 * 3600) });
  const stale = validateInitData_(old);
  t.check('a 40-hour-old launch is refused', stale.ok === false, stale.reason);
  t.check('and says so in words the owner can act on', /expired|reopen/i.test(stale.reason), stale.reason);

  t.section('Only the owner may use the deployment');
  const stranger = sign({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 777777, first_name: 'Stranger', username: 'nosy' })
  });
  t.check('a correctly signed stranger still verifies as genuine', validateInitData_(stranger).ok === true);
  t.throws('but is refused access', () => requireTelegramAuth_(stranger, 'orders'));
  t.check('the rejection is logged for review',
    SS.getSheetByName('Log').rows.some(r => /Rejected Telegram user 777777/.test(String(r[2]))));
  t.check('the owner is allowed', !!requireTelegramAuth_(launch(), 'orders'));

  PROPS.EXTRA_TELEGRAM_USER_IDS = '777777, 888888';
  t.check('an explicitly allowed extra user gets in', !!requireTelegramAuth_(stranger, 'orders'));
  delete PROPS.EXTRA_TELEGRAM_USER_IDS;

  t.section('The published API key alone opens nothing');
  const publicKey = PROPS.API_KEY;
  const readAttempt = JSON.parse(doGet({ parameter: { action: 'orders', key: publicKey } }).getContent());
  t.check('reading orders with only the key fails', readAttempt.status === 'error', JSON.stringify(readAttempt).slice(0, 90));
  t.check('and leaks no customer data', !JSON.stringify(readAttempt).includes('customerName'));

  const writeAttempt = JSON.parse(doPost({
    parameter: {},
    postData: { contents: JSON.stringify({ action: 'markPaid', orderId: 'ORD-X', key: publicKey }) }
  }).getContent());
  t.check('marking an order paid with only the key fails', writeAttempt.status === 'error', writeAttempt.message);

  const cancelAttempt = JSON.parse(doPost({
    parameter: {},
    postData: { contents: JSON.stringify({ action: 'cancelOrder', orderId: 'ORD-X', key: publicKey }) }
  }).getContent());
  t.check('cancelling an order with only the key fails', cancelAttempt.status === 'error');

  t.section('Health stays open, so setup can still be checked');
  const health = JSON.parse(doGet({ parameter: { action: 'health' } }).getContent());
  t.check('anonymous health check works', health.status === 'ok');
  t.check('but reveals no order counts', health.totalOrders === undefined);

  // API_KEY is published in index.html, so gating counts on it gated them on
  // nothing — order totals were readable by anyone who viewed source.
  const keyed = JSON.parse(doGet({ parameter: { action: 'health', key: publicKey } }).getContent());
  t.check('the published key alone still reveals no counts', keyed.totalOrders === undefined,
    JSON.stringify(keyed));
  t.check('nor whether a webhook is configured', keyed.webhookConfigured === undefined);
  t.check('it says how to see them instead', /Telegram/.test(String(keyed.detail)), String(keyed.detail));

  const authed = JSON.parse(doGet({ parameter: { action: 'health', key: publicKey, initData: launch() } }).getContent());
  t.check('a verified Telegram launch does see the counts', typeof authed.totalOrders === 'number',
    JSON.stringify(authed));

  t.section('The browser escape hatch is read-only and off by default');
  PROPS.ALLOW_BROWSER_ACCESS = 'YES';
  t.check('reads are permitted when switched on', requireTelegramAuth_('', 'orders') === null);
  t.throws('writes are still refused', () => requireTelegramAuth_('', 'markPaid'));
  t.throws('and so is cancelling', () => requireTelegramAuth_('', 'cancelOrder'));
  delete PROPS.ALLOW_BROWSER_ACCESS;
  t.throws('with it off, even reads need Telegram', () => requireTelegramAuth_('', 'orders'));

  t.section('A real order still goes through when properly signed');
  const ok = JSON.parse(doPost({
    parameter: {},
    postData: {
      contents: JSON.stringify({
        action: 'newOrder', key: publicKey, initData: launch(),
        order: {
          itemsJson: [{ name: 'Chicken Dum Biryani', unit: 'Pax', qty: 50, rate: 950 }],
          itemsSummary: 'Chicken Dum Biryani: 50 Pax',
          deliveryDate: '2026-09-11', deliveryTime: '13:00',
          customerName: 'Real Customer', customerPhone: '0771234567',
          totalAmount: 47500, advancePaid: 0
        }
      })
    }
  }).getContent());
  t.check('the order is accepted', ok.status === 'success', JSON.stringify(ok).slice(0, 120));
  t.check('and reaches the sheet', SS.getSheetByName('Orders').rows.length === 2);
};
