/**
 * Regression suite for the Apps Script backend.
 *
 * Every check here corresponds to a defect found in the pre-launch audit of
 * commit c808775. They exist so those defects cannot come back silently —
 * which matters especially for the reminder engine, whose original failure
 * mode produced no error at all.
 */

const stub = require('./helpers/apps-script-stub.js');

module.exports = function (t) {
  const { SENT, SS } = stub.install();
  eval(stub.backendSource());

  t.section('C2: delivery date/time parsing (the bug that killed every reminder)');
  t.check('string date + time parses', !!parseDeliveryInstant_('2026-09-09', '13:00'));
  const inst = parseDeliveryInstant_('2026-09-09', '13:00');
  t.check('13:00 Colombo == 07:30 UTC', inst.toISOString() === '2026-09-09T07:30:00.000Z', inst.toISOString());
  t.check('Date OBJECT cell -> yyyy-MM-dd', toDateStr_(new Date('2026-09-09T06:00:00Z')) === '2026-09-09', toDateStr_(new Date('2026-09-09T06:00:00Z')));
  t.check('time-as-Date cell -> HH:mm', toTimeStr_(new Date('2026-09-09T07:30:00Z')) === '13:00', toTimeStr_(new Date('2026-09-09T07:30:00Z')));
  t.check('string time passthrough', toTimeStr_('9:05') === '09:05', toTimeStr_('9:05'));
  t.check('garbage returns empty, not NaN', toDateStr_('') === '' && toTimeStr_('') === '');

  t.section('H7: phone normalisation');
  t.check('local 077 123 4567', normalizePhone_('077 123 4567') === '94771234567', normalizePhone_('077 123 4567'));
  t.check('+94 form', normalizePhone_('+94 77 123 4567') === '94771234567');
  t.check('bare 771234567', normalizePhone_('771234567') === '94771234567');
  t.check('00 international', normalizePhone_('0094771234567') === '94771234567');
  t.check('all forms collapse to one key',
    new Set(['077 123 4567', '+94771234567', '94771234567', '0094771234567'].map(normalizePhone_)).size === 1);

  t.section('C5: Telegram HTML escaping');
  t.check('escapes angle brackets', esc_('a <b> & c') === 'a &lt;b&gt; &amp; c', esc_('a <b> & c'));
  t.check('underscores/asterisks left alone (safe in HTML mode)', esc_('Mohamed_Rizwan *VIP*') === 'Mohamed_Rizwan *VIP*');

  t.section('C4: order id collisions');
  // Checked against ids already issued, so this is a guarantee rather than a
  // probability — a duplicate id means marking the wrong order delivered.
  const taken = {};
  let firstDuplicate = null;
  for (let i = 0; i < 2000; i++) {
    const id = makeOrderId_(taken);
    if (taken[id]) { firstDuplicate = id; break; }
    taken[id] = true;
  }
  t.check('2000 ids issued within the same second, none repeated',
    firstDuplicate === null && Object.keys(taken).length === 2000,
    firstDuplicate ? 'duplicate: ' + firstDuplicate : Object.keys(taken).length + ' unique');
  t.check('id shape ORD-yyMMdd-HHmmss-XXXX', /^ORD-\d{6}-\d{6}-[A-Z0-9]{4}$/.test(makeOrderId_()), makeOrderId_());

  t.section('End-to-end: save an order with hostile input');
  initSheets();
  const res = saveOrder_({
    itemsJson: [{ name: 'Chicken Dum Biryani', unit: 'Pax', qty: 60, rate: 950 }],
    itemsSummary: 'Chicken Dum Biryani: 60 Pax',
    deliveryDate: '2026-09-09', deliveryTime: '13:00',
    customerName: 'Mohamed_Rizwan <VIP>',
    customerPhone: '077 123 4567',
    deliveryAddress: '45 Galle Road, Dehiwala',
    prepStatus: 'Confirmed', totalAmount: 57000, advancePaid: 20000,
    specialNotes: 'Medium spice & extra raita'
  });
  t.check('save returns success', res.status === 'success', JSON.stringify(res));
  const orderRow = SS.getSheetByName('Orders').rows[1];
  t.check('date stored as plain text', orderRow[COL.DATE] === '2026-09-09', String(orderRow[COL.DATE]));
  t.check('phone normalised on write', orderRow[COL.PHONE] === '94771234567', String(orderRow[COL.PHONE]));
  t.check('balance computed', orderRow[COL.BALANCE] === 37000, String(orderRow[COL.BALANCE]));
  t.check('payment status = Advance', orderRow[COL.PAYMENT] === 'Advance', String(orderRow[COL.PAYMENT]));
  t.check('customer upserted', SS.getSheetByName('Customers').rows.length === 2);

  const alert = SENT.find(s => s.method === 'sendMessage');
  t.check('telegram alert sent', !!alert);
  t.check('alert uses HTML parse mode', alert.payload.parse_mode === 'HTML');
  t.check('hostile name escaped in message', alert.payload.text.includes('Mohamed_Rizwan &lt;VIP&gt;'));
  t.check('WhatsApp button has digits-only number',
    JSON.stringify(alert.payload.reply_markup).includes('https://wa.me/94771234567'));
  t.check('Maps button present', JSON.stringify(alert.payload.reply_markup).includes('maps/search'));

  t.section('H8: aggregated prep digest');
  saveOrder_({
    itemsJson: [{ name: 'Chicken Dum Biryani', unit: 'Pax', qty: 100, rate: 950 },
                { name: 'Watalappam Party Pack', unit: 'Cups', qty: 100, rate: 250 }],
    itemsSummary: 'x', deliveryDate: '2026-09-09', deliveryTime: '19:00',
    customerName: 'Nimal', customerPhone: '0712223344',
    deliveryAddress: 'Mount Lavinia', totalAmount: 120000, advancePaid: 0
  });
  saveOrder_({
    itemsJson: [{ name: 'Chicken Dum Biryani', unit: 'Pax', qty: 60, rate: 950 }],
    itemsSummary: 'y', deliveryDate: '2026-09-10', deliveryTime: '12:00',
    customerName: 'Other Day', customerPhone: '0759998877', totalAmount: 1000, advancePaid: 0
  });
  const digest = buildPrepDigest_('2026-09-09');
  t.check('digest built', !!digest);
  t.check('covers only that date (2 orders)', digest.orderCount === 2, String(digest.orderCount));
  t.check('biryani totalled across orders (60+100=160)', digest.message.includes('160 Pax'), digest.message.match(/Biryani.*\n/));
  t.check('marks it came from 2 orders', digest.message.includes('(2 orders)'));
  t.check('sums money to collect', digest.message.includes('157,000'), digest.message.slice(-120));

  t.section('H9 / C2: dispatch alert actually fires');
  const soon = new Date(Date.now() + 90 * 60000);
  saveOrder_({
    itemsJson: [{ name: 'Mutton Mandhi Special', unit: 'Packs', qty: 4, rate: 2400 }],
    itemsSummary: 'Mutton Mandhi Special: 4 Packs',
    deliveryDate: Utilities.formatDate(soon, TZ, 'yyyy-MM-dd'),
    deliveryTime: Utilities.formatDate(soon, TZ, 'HH:mm'),
    customerName: 'Urgent Customer', customerPhone: '0771112233',
    totalAmount: 9600, advancePaid: 0
  });
  SENT.length = 0;
  const out = checkDispatchAlerts();
  t.check('one alert sent for the 90-minute order', out === '1 dispatch alert(s) sent', out);
  t.check('alert mentions dispatch', SENT.some(s => s.payload.text && s.payload.text.includes('COOK')));
  const again = checkDispatchAlerts();
  t.check('does not send twice', again === '0 dispatch alert(s) sent', again);

  t.section('Update & status changes');
  const upd = updateOrder_(res.orderId, { deliveryTime: '18:00' });
  t.check('update succeeds', upd.status === 'success');
  t.check('moving the time re-arms reminders', upd.remindersReset === true);
  t.check('dispatch flag reset', SS.getSheetByName('Orders').rows[1][COL.DISPATCH_SENT] === 'NO');
  const del = setOrderStatus_(res.orderId, 'Delivered');
  t.check('mark delivered', del.newStatus === 'Delivered');
  t.check('delivered timestamp written', !!SS.getSheetByName('Orders').rows[1][COL.DELIVERED_AT]);

  t.section('C6: authorisation');
  let threw = false;
  try { requireKey_('wrong'); } catch (e) { threw = true; }
  t.check('bad key rejected', threw);
  t.check('good key accepted', (() => { try { requireKey_('testkey'); return true; } catch (e) { return false; } })());
  const forbidden = JSON.parse(doPost({ parameter: { wh: 'nope' }, postData: { contents: '{}' } }).getContent());
  t.check('wrong webhook secret refused', forbidden.status === 'forbidden');

  t.section('Reads used by the app');
  t.check('menu reads from sheet', readMenu_().length === 16, String(readMenu_().length));
  t.check('menu skips inactive rows', readMenu_().every(m => m.name));
  const cust = findCustomer_('+94 77 123 4567');
  t.check('customer found by any phone format', cust && cust.name === 'Mohamed_Rizwan <VIP>', JSON.stringify(cust));
  // Asserted by identity rather than by count: other checks in this suite book
  // orders relative to the real clock, and near midnight one of those lands on
  // this date and would otherwise make the count flap.
  const onDate = readOrders_('2026-09-09', '2026-09-09');
  t.check('every order returned is inside the range',
    onDate.every(o => o.deliveryDate === '2026-09-09'), onDate.map(o => o.deliveryDate).join(','));
  t.check('the fixed-date orders are both present',
    onDate.some(o => o.customerName === 'Mohamed_Rizwan <VIP>') && onDate.some(o => o.customerName === 'Nimal'),
    onDate.map(o => o.customerName).join(','));
  t.check('orders outside the range are excluded',
    !onDate.some(o => o.customerName === 'Other Day'));
  t.check('orders sorted by delivery time',
    onDate.every((o, i) => i === 0 || onDate[i - 1].deliveryTime <= o.deliveryTime),
    onDate.map(o => o.deliveryTime).join(','));

};
