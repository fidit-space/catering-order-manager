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

  t.section('A launch from a modern client, which sends a signature field');
  // Bot API 8.0 added "signature". Telegram's spec excludes only "hash" from
  // the HMAC check string, so signature belongs in it. Dropping it made every
  // launch from a recent Telegram client fail verification in production while
  // every test here passed, because none of them sent the field.
  const modern = sign({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAF_test',
    signature: 'k1LDlOJqRk7wZ0nQ2s8xYbAaCcDdEeFf',
    user: JSON.stringify({ id: Number(OWNER_ID), first_name: 'Umair', username: 'owner' })
  });
  const modernResult = validateInitData_(modern);
  t.check('it verifies', modernResult.ok === true, modernResult.reason);
  t.check('and identifies the user', String(modernResult.user.id) === String(OWNER_ID));
  t.check('the owner is let in', !!requireTelegramAuth_(modern, 'orders'));

  // Belt and braces: a client that signed WITHOUT the signature field must
  // still verify, since which form is signed is not worth guessing at.
  const legacyStyle = (function () {
    const fields = {
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: 'AAF_legacy',
      user: JSON.stringify({ id: Number(OWNER_ID), first_name: 'Umair' })
    };
    const signed = sign(fields);                       // hash over fields WITHOUT signature
    return signed + '&signature=' + encodeURIComponent('addedAfterTheHash');
  })();
  t.check('a signature added after the hash still verifies',
    validateInitData_(legacyStyle).ok === true, validateInitData_(legacyStyle).reason);

  t.section('Forged and tampered launches are rejected');
  t.check('a launch signed with the wrong token fails',
    validateInitData_(sign({ auth_date: '1', user: '{"id":1}' }, '9999:WRONGTOKEN')).ok === false);

  const tampered = launch().replace(/user=[^&]*/, 'user=' + encodeURIComponent('{"id":999,"first_name":"Mallory"}'));
  t.check('editing the user after signing breaks the hash', validateInitData_(tampered).ok === false);
  const tamperedModern = modern.replace(/user=[^&]*/, 'user=' + encodeURIComponent('{"id":999,"first_name":"Mallory"}'));
  t.check('and still breaks it when a signature is present',
    validateInitData_(tamperedModern).ok === false);
  t.check('a forged signature field cannot be swapped in',
    validateInitData_(modern.replace(/signature=[^&]*/, 'signature=forged')).ok === false);
  t.check('a failed verification is logged for diagnosis',
    SS.getSheetByName('Log').rows.some(r => /did not verify/.test(String(r[2]))));

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
  // The version is open on purpose. /status can report it too, but /status
  // answers over Telegram, and a dead webhook is the fault you most need to
  // diagnose — so the only tool that names it is silenced by it.
  t.check('it does report the running version', health.version === VERSION, String(health.version));
  t.check('which is a real marker, not a placeholder',
    typeof VERSION === 'string' && VERSION.length > 0, String(VERSION));

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
  t.check('and the version survives the authenticated path too', authed.version === VERSION,
    String(authed.version));

  t.section('The browser escape hatch is off by default and narrow when on');
  PROPS.ALLOW_BROWSER_ACCESS = 'YES';
  t.check('health is permitted when switched on', requireTelegramAuth_('', 'health') === null);
  t.throws('reading orders is NOT — it carries names, phones and addresses',
    () => requireTelegramAuth_('', 'orders'));
  t.throws('writes are still refused', () => requireTelegramAuth_('', 'markPaid'));
  t.throws('and so is cancelling', () => requireTelegramAuth_('', 'cancelOrder'));
  delete PROPS.ALLOW_BROWSER_ACCESS;
  t.throws('with it off, even health needs Telegram', () => requireTelegramAuth_('', 'health'));

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

  t.section('The browser escape hatch cannot reach money or customers');
  // This was a deny-list of write actions written before the finance release.
  // recordPayment / recordRefund / recordExpense were not on it, so with the
  // hatch on they were treated as reads: money could be written into the
  // Ledger with nothing but the API key, which is published in index.html.
  PROPS.ALLOW_BROWSER_ACCESS = 'YES';

  ['recordPayment', 'recordRefund', 'recordExpense'].forEach(function (action) {
    let threw = '';
    try { requireTelegramAuth_('', action); } catch (e) { threw = e.message; }
    t.check(action + ' still demands a signed launch', threw.length > 0, threw || 'ALLOWED THROUGH');
  });

  ['orders', 'unpaid', 'money', 'ledger', 'customer'].forEach(function (action) {
    let threw = '';
    try { requireTelegramAuth_('', action); } catch (e) { threw = e.message; }
    t.check(action + ' does not leak customer data to the hatch', threw.length > 0, threw || 'ALLOWED THROUGH');
  });

  t.check('health stays open, which is what the hatch is for',
    requireTelegramAuth_('', 'health') === null);
  t.check('menu stays open — it carries no personal data',
    requireTelegramAuth_('', 'menu') === null);

  // Default-deny: a route nobody remembered to classify must be closed.
  let unknown = '';
  try { requireTelegramAuth_('', 'someRouteAddedNextYear'); } catch (e) { unknown = e.message; }
  t.check('an unclassified future route defaults to denied', unknown.length > 0, unknown || 'ALLOWED THROUGH');

  delete PROPS.ALLOW_BROWSER_ACCESS;


  t.section('Reads work over POST as well as GET, gated identically');
  // initData in a query string is a 24-hour replay credential written into
  // execution logs, proxies and referrers. Writes have always used the body;
  // reads are moving there. Both verbs are accepted for one release because
  // the frontend reaches the edge in a minute while each business's backend is
  // a manual paste — switching in one go would break reads for a live client.
  const READS = ['menu', 'unpaid', 'money', 'ledger', 'orders', 'customer'];

  function viaGet(action, extra) {
    return JSON.parse(doGet({ parameter: Object.assign(
      { action: action, key: publicKey, initData: launch() }, extra || {}) }).getContent());
  }
  function viaPost(action, extra) {
    return JSON.parse(doPost({ postData: { contents: JSON.stringify(Object.assign(
      { action: action, key: publicKey, initData: launch() }, extra || {})) } }).getContent());
  }

  READS.forEach(function (action) {
    const got = viaPost(action);
    t.check(action + ' is served over POST', got.status === 'ok',
      JSON.stringify(got).slice(0, 90));
    // Same route, same data — not a second implementation that can drift.
    t.check(action + ' returns the same keys either way',
      Object.keys(got).sort().join(',') === Object.keys(viaGet(action)).sort().join(','),
      Object.keys(got).sort().join(',') + '  vs  ' + Object.keys(viaGet(action)).sort().join(','));
  });

  t.check('parameters are read from the body, not only the query string',
    viaPost('ledger', { limit: 1 }).entries.length <= 1,
    String(viaPost('ledger', { limit: 1 }).entries.length));

  // The whole point is that access does not loosen by changing verb.
  READS.forEach(function (action) {
    const keyOnly = JSON.parse(doPost({ postData: { contents: JSON.stringify(
      { action: action, key: publicKey }) } }).getContent());
    t.check(action + ' over POST still refuses a key-only caller', keyOnly.status === 'error',
      JSON.stringify(keyOnly).slice(0, 80));
  });

  t.check('a read over POST leaks nothing to a key-only caller',
    !/customerPhone|customerName/.test(JSON.stringify(JSON.parse(doPost({ postData: { contents:
      JSON.stringify({ action: 'orders', key: publicKey }) } }).getContent()))));

  t.check('GET reads are unchanged, so an un-redeployed frontend keeps working',
    viaGet('menu').status === 'ok' && Array.isArray(viaGet('menu').menu));
  t.check('an unknown action is still an error over POST',
    viaPost('noSuchThing').status === 'error', JSON.stringify(viaPost('noSuchThing')).slice(0, 80));
  t.check('and over GET', viaGet('noSuchThing').status === 'error');

  // Anonymous GET health is what tools/instances.js relies on; it must not
  // have been narrowed by sharing the read router.
  const anon = JSON.parse(doGet({ parameter: { action: 'health' } }).getContent());
  t.check('anonymous health over GET still answers', anon.status === 'ok');
  t.check('and still reports the version for the fleet check', anon.version === VERSION);

};
