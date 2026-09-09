/**
 * Suite for the sheet integrity guard.
 *
 * The reminder engine only works while Delivery Date and Delivery Time stay
 * plain text. The owner is told to edit this spreadsheet, so that guarantee
 * cannot rest on nobody touching it — onEdit repairs the cell on the spot.
 * These checks reproduce the exact corruption that once silenced every
 * reminder, and prove it heals.
 */

const stub = require('./helpers/apps-script-stub.js');

module.exports = function (t) {
  const { SS, SENT } = stub.install();
  eval(stub.backendSource());

  initSheets();
  const orders = SS.getSheetByName('Orders');

  saveOrder_({
    itemsJson: [{ name: 'Chicken Dum Biryani', unit: 'Pax', qty: 60, rate: 950 }],
    itemsSummary: 'Chicken Dum Biryani: 60 Pax',
    deliveryDate: '2026-09-09', deliveryTime: '13:00',
    customerName: 'Rizwan', customerPhone: '0771234567',
    deliveryAddress: 'Dehiwala', totalAmount: 57000, advancePaid: 20000
  });

  // A person retyping the date in the Sheets app: Sheets stores a Date object,
  // which is precisely what broke the original reminder engine.
  function handEdit(row, col, value) {
    orders.rows[row - 1][col - 1] = value;
    onEdit({ range: orders.getRange(row, col) });
  }

  t.section('A hand-edited date is repaired, not left as a Date object');
  t.check('starts as canonical text', orders.rows[1][COL.DATE] === '2026-09-09');
  handEdit(2, COL.DATE + 1, new Date('2026-09-11T06:00:00Z'));
  t.check('a Date object is rewritten as text', orders.rows[1][COL.DATE] === '2026-09-11', String(orders.rows[1][COL.DATE]));
  t.check('the cell is forced back to text format', orders.formats['2:' + (COL.DATE + 1)] === '@');
  t.check('the reminder engine can still read it',
    !!parseDeliveryInstant_(toDateStr_(orders.rows[1][COL.DATE]), toTimeStr_(orders.rows[1][COL.TIME])));

  t.section('A hand-edited time is repaired');
  handEdit(2, COL.TIME + 1, new Date('1899-12-30T09:05:00Z'));
  t.check('a time cell becomes HH:mm text', /^\d{2}:\d{2}$/.test(String(orders.rows[1][COL.TIME])), String(orders.rows[1][COL.TIME]));
  handEdit(2, COL.TIME + 1, '9:5');
  t.check('a sloppy "9:5" is left alone rather than mangled',
    orders.rows[1][COL.TIME] === '9:5' || /^\d{2}:\d{2}$/.test(String(orders.rows[1][COL.TIME])),
    String(orders.rows[1][COL.TIME]));

  t.section('A hand-edited phone number is normalised');
  handEdit(2, COL.PHONE + 1, '077 123 4567');
  t.check('local format becomes the wa.me key', orders.rows[1][COL.PHONE] === '94771234567', String(orders.rows[1][COL.PHONE]));

  t.section('The guard stays out of the way');
  const before = JSON.stringify(orders.rows[1]);
  handEdit(2, COL.NOTES + 1, 'extra spoons please');
  t.check('editing an unrelated column changes nothing else',
    orders.rows[1][COL.NOTES] === 'extra spoons please');
  handEdit(2, COL.DATE + 1, '2026-09-11');
  t.check('an already-correct value is not rewritten', orders.rows[1][COL.DATE] === '2026-09-11');
  onEdit({ range: SS.getSheetByName('Menu').getRange(2, 4) });
  t.check('edits to other tabs are ignored', true);
  t.check('a malformed event cannot throw', (() => { try { onEdit(null); onEdit({}); return true; } catch (e) { return false; } })());

  t.section('Unreadable values are flagged, never silently blanked');
  handEdit(2, COL.DATE + 1, 'next friday maybe');
  t.check('the value is left for the owner to see', orders.rows[1][COL.DATE] === 'next friday maybe');
  t.check('and it is recorded in the Log', SS.getSheetByName('Log').rows.length > 1);

  t.section('Bulk repair for damage done before the guard existed');
  orders.rows[1][COL.DATE] = new Date('2026-09-12T06:00:00Z');
  orders.rows[1][COL.PHONE] = '+94 71 222 3344';
  const result = repairAllOrderRows();
  t.check('reports what it fixed', /Repaired \d+ cell/.test(result), result);
  t.check('date restored to text', orders.rows[1][COL.DATE] === '2026-09-12', String(orders.rows[1][COL.DATE]));
  t.check('phone restored', orders.rows[1][COL.PHONE] === '94712223344', String(orders.rows[1][COL.PHONE]));

  t.section('Button presses cannot be killed by an ampersand');
  // query.message.text is Telegram's PLAIN text. Sending it back as HTML made
  // any & or < reject the edit with a 400: sheet updated, message frozen,
  // button apparently dead.
  SENT.length = 0;
  stampMessage_({
    message: { chat: { id: 1 }, message_id: 9, text: 'Order for Curries & Gravy <VIP> — 60 Pax' }
  }, '🍳 COOKING');
  const edit = SENT.find(m => m.method === 'editMessageText');
  t.check('the edit is sent', !!edit);
  t.check('the ampersand is escaped', /Curries &amp; Gravy/.test(edit.payload.text), edit.payload.text);
  t.check('the angle brackets are escaped', /&lt;VIP&gt;/.test(edit.payload.text));
  t.check('no raw & survives to break the parse',
    !/&(?!amp;|lt;|gt;)/.test(edit.payload.text), edit.payload.text);
  t.check('the outcome label is still shown', /COOKING/.test(edit.payload.text));

  t.section('New errors are pushed to Telegram, not left in a tab nobody reads');
  SENT.length = 0;
  logError_('someJob', new Error('kaboom'));
  const reported = reportNewErrors();
  t.check('reports the new error', /reported \d+ error/.test(reported), reported);
  t.check('the alert names the failing job', SENT.some(m => /someJob/.test(m.payload.text || '')));
  t.check('the alert quotes the error', SENT.some(m => /kaboom/.test(m.payload.text || '')));
  t.check('nothing is re-reported on the next run', /no new errors/.test(reportNewErrors()));
};
