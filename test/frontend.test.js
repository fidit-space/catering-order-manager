/**
 * Suite for the Telegram Mini App.
 *
 * The headline check is that a rejected save reaches the user as an error and
 * is kept on the device — the original build reported success regardless of
 * what the server said, which could lose an order silently.
 */

const dom = require('./helpers/dom-stub.js');

module.exports = function (t, done) {
  const page = dom.install();
  const el = page.el;
  eval(dom.appSource());

  t.section('Date defaults use local time, not UTC');
  // Freeze "now" at 9pm local — the exact conditions under which the original
  // toISOString() approach rolled "tomorrow" back to today.
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate('2026-09-08T21:00:00+05:30'); }
    static now() { return new RealDate('2026-09-08T21:00:00+05:30').getTime(); }
  };
  const today = localDate(0);
  const tomorrow = localDate(1);
  t.check('today is the 8th at 9pm', today === '2026-09-08', today);
  t.check('tomorrow is the 9th, not today', tomorrow === '2026-09-09', tomorrow);
  t.check('the old UTC approach would have been wrong',
    new Date().toISOString().split('T')[0] === '2026-09-08' && tomorrow !== '2026-09-08');
  global.Date = RealDate;

  t.section('Phone numbers typed the local way');
  t.check('077 123 4567 becomes 94771234567', normalizePhone('077 123 4567') === '94771234567', normalizePhone('077 123 4567'));
  t.check('+94 77 123 4567 matches it', normalizePhone('+94 77 123 4567') === '94771234567');
  t.check('empty stays empty', normalizePhone('') === '');

  t.section('Money and escaping');
  t.check('thousands separated', money(157000) === 'Rs. 157,000', money(157000));
  t.check('undefined is not NaN', money(undefined) === 'Rs. 0');
  t.check('tags neutralised', esc('<img src=x onerror=1>') === '&lt;img src=x onerror=1&gt;');
  t.check('quotes escaped for attributes', esc('a"b') === 'a&quot;b');

  t.section('Order payload');
  el('customerName').value = 'Test Person';
  el('customerPhone').value = '0771234567';
  el('deliveryDate').value = '2026-09-09';
  el('deliveryTime').value = '13:00';
  el('totalAmount').value = '57000';
  el('advancePaid').value = '20000';
  menu = [{ id: 'x1', category: 'Biryani', name: 'Chicken Dum Biryani', unit: 'Pax', rate: 950, step: 5 }];
  quantities = { x1: 60 };

  APPS_SCRIPT_WEBAPP_URL = 'https://script.google.com/macros/s/TEST/exec';
  API_KEY = 'testkey';
  t.check('a real url and key count as configured', isConfigured() === true);
  APPS_SCRIPT_WEBAPP_URL = 'PASTE_YOUR_WEB_APP_URL_HERE';
  t.check('the placeholder url does not', isConfigured() === false);
  APPS_SCRIPT_WEBAPP_URL = 'https://script.google.com/macros/s/TEST/exec';

  const payload = buildPayload();
  t.check('items sent as structured data', payload.itemsJson.length === 1 && payload.itemsJson[0].qty === 60);
  t.check('phone normalised before sending', payload.customerPhone === '94771234567');
  t.check('balance is total minus advance', payload.balanceDue === 37000, String(payload.balanceDue));
  t.check('a complete order validates', validate(payload) === null, String(validate(payload)));
  t.check('an empty order is caught', validate(Object.assign({}, payload, { itemsJson: [] })) !== null);
  t.check('a short phone is caught', validate(Object.assign({}, payload, { customerPhone: '123' })) !== null);

  t.section('A rejected save must not look like success');
  page.serve(() => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ status: 'error', message: 'Unauthorised: bad or missing key.' })
  }));
  page.clearAlerts();
  submitOrder();

  setTimeout(() => {
    const said = page.saidToUser();
    t.check('the real reason reaches the user', /Unauthorised/.test(said), said.slice(0, 80));
    t.check('it never claims the order was saved', !/Order saved/i.test(said));

    const queued = JSON.parse(page.store['cat_pending_v1'] || '[]');
    t.check('the order is kept on the phone', queued.length === 1);
    t.check('the queued copy is the real order', queued[0].request.order.customerName === 'Test Person');

    t.section('Queued orders go out when the signal returns');
    page.serve(() => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ status: 'success', orderId: 'ORD-1' })
    }));
    flushPending(true);

    setTimeout(() => {
      t.check('queue drains', JSON.parse(page.store['cat_pending_v1'] || '[]').length === 0);

      t.section('The summary sent to the customer');
      const text = customerSummaryText(payload, 'ORD-260908-120000-A1B');
      t.check('lists the dishes', text.includes('Chicken Dum Biryani — 60 Pax'));
      t.check('states the balance', text.includes('Balance on delivery: Rs. 37,000'));
      t.check('asks them to confirm', /confirm/i.test(text));

      done();
    }, 40);
  }, 40);
};
