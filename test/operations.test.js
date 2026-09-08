/**
 * Suite for the operations features: the kitchen status pipeline, chasing
 * unpaid balances, the weekly backup, and the owner-editable Settings tab.
 */

const stub = require('./helpers/apps-script-stub.js');
const telegram = require('./helpers/telegram.js');

module.exports = function (t) {
  const { SENT, SS, MAILS, DRIVE, PROPS } = stub.install();
  eval(stub.backendSource());

  initSheets();

  t.section('Settings tab');
  t.check('Settings sheet seeded', SS.getSheetByName('Settings').rows.length === 6);
  t.check('reads a default value', Number(getSetting_('payment_chase_days', 99)) === 3, String(getSetting_('payment_chase_days')));
  t.check('falls back when key missing', getSetting_('nope', 'fb') === 'fb');
  t.check('blank value falls back', getSetting_('backup_email', 'owner@x') === 'owner@x');

  t.section('Status pipeline');
  t.check('Confirmed -> Cooking', nextStatus_('Confirmed') === 'Cooking');
  t.check('Cooking -> Out for Delivery', nextStatus_('Cooking') === 'Out for Delivery');
  t.check('Out for Delivery -> Delivered', nextStatus_('Out for Delivery') === 'Delivered');
  t.check('Delivered is the end', nextStatus_('Delivered') === null);
  t.check('Tentative must be confirmed first', nextStatus_('Tentative') === 'Confirmed');
  t.check('Delivered counts as closed', isClosed_('Delivered') && isClosed_('Cancelled'));
  t.check('Cooking is NOT closed', !isClosed_('Cooking'));

  const o1 = saveOrder_({
    itemsJson: [{ name: 'Chicken Dum Biryani', unit: 'Pax', qty: 60, rate: 950 }],
    itemsSummary: 'Chicken Dum Biryani: 60 Pax',
    deliveryDate: '2026-09-09', deliveryTime: '13:00',
    customerName: 'Rizwan', customerPhone: '0771234567',
    deliveryAddress: 'Dehiwala', totalAmount: 57000, advancePaid: 20000
  });
  t.check('order starts Confirmed', orderStatus_(o1.orderId) === 'Confirmed');
  advanceOrderStatus_(o1.orderId);
  t.check('advances to Cooking', orderStatus_(o1.orderId) === 'Cooking');
  advanceOrderStatus_(o1.orderId);
  advanceOrderStatus_(o1.orderId);
  t.check('reaches Delivered', orderStatus_(o1.orderId) === 'Delivered');
  t.check('Delivered At stamped', !!SS.getSheetByName('Orders').rows[1][COL.DELIVERED_AT]);
  let threw = false;
  try { advanceOrderStatus_(o1.orderId); } catch (e) { threw = true; }
  t.check('cannot advance past Delivered', threw);

  t.section('Marking payment received');
  t.check('balance still outstanding', num_(SS.getSheetByName('Orders').rows[1][COL.BALANCE]) === 37000);
  const paid = markOrderPaid_(o1.orderId);
  t.check('reports the amount collected', paid.collected === 37000, String(paid.collected));
  t.check('balance cleared', num_(SS.getSheetByName('Orders').rows[1][COL.BALANCE]) === 0);
  t.check('payment status Paid', SS.getSheetByName('Orders').rows[1][COL.PAYMENT] === 'Paid');
  t.check('Paid At stamped', !!SS.getSheetByName('Orders').rows[1][COL.PAID_AT]);

  t.check('marking paid twice is harmless', markOrderPaid_(o1.orderId).collected === 0,
    String(markOrderPaid_(o1.orderId).collected));

  t.section('Chasing unpaid balances');
  // An order delivered 5 days ago, still owing.
  const old = saveOrder_({
    itemsJson: [{ name: 'Mutton Mandhi Special', unit: 'Packs', qty: 4, rate: 2400 }],
    itemsSummary: 'Mutton Mandhi Special: 4 Packs',
    deliveryDate: Utilities.formatDate(new Date(Date.now() - 5 * 864e5), TZ, 'yyyy-MM-dd'),
    deliveryTime: '12:00',
    customerName: 'Slow Payer', customerPhone: '0759998877',
    totalAmount: 9600, advancePaid: 0
  });
  setOrderStatus_(old.orderId, 'Delivered');
  // And one delivered today, which must NOT be chased yet.
  const fresh = saveOrder_({
    itemsJson: [{ name: 'Chicken Fried Rice', unit: 'Portions', qty: 10, rate: 750 }],
    itemsSummary: 'Chicken Fried Rice: 10 Portions',
    deliveryDate: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), deliveryTime: '12:00',
    customerName: 'Just Delivered', customerPhone: '0711112222',
    totalAmount: 7500, advancePaid: 0
  });
  setOrderStatus_(fresh.orderId, 'Delivered');

  SENT.length = 0;
  const chased = checkUnpaidBalances();
  t.check('chases only the overdue one', /chased 1 order/.test(chased), chased);
  const chaseMsg = SENT.find(x => x.payload.text && /MONEY STILL OWED/.test(x.payload.text));
  t.check('message sent', !!chaseMsg);
  t.check('names the debtor', chaseMsg.payload.text.includes('Slow Payer'));
  t.check('excludes the same-day delivery', !chaseMsg.payload.text.includes('Just Delivered'));
  t.check('states the amount', chaseMsg.payload.text.includes('9,600'));
  t.check('offers WhatsApp + Paid buttons',
    JSON.stringify(chaseMsg.payload.reply_markup).includes('wa.me/94759998877') &&
    JSON.stringify(chaseMsg.payload.reply_markup).includes('paid_' + old.orderId));
  t.check('does not chase the same order twice', /nothing to chase/.test(checkUnpaidBalances()));

  t.section('/owed shows everything outstanding, aged');
  SENT.length = 0;
  sendAgingReport_();
  const moneyMsg = SENT[0].payload.text;
  t.check('lists both debtors', moneyMsg.includes('Slow Payer') && moneyMsg.includes('Just Delivered'));
  t.check('totals them', moneyMsg.includes('17,100'), moneyMsg.slice(0, 90));
  t.check('excludes the settled order', !moneyMsg.includes('Rizwan'));
  t.check('groups the older debt separately', /More than a month|1–4 weeks|This week/.test(moneyMsg));

  t.section('Weekly backup');
  const result = weeklyBackup();
  t.check('backup ran', /backup emailed/.test(result), result);
  t.check('email sent to the owner', MAILS.length === 1 && MAILS[0].to === 'owner@example.com', JSON.stringify(MAILS[0] && MAILS[0].to));
  t.check('attaches Orders, Customers and Menu', MAILS[0].attachments.length === 3,
    MAILS[0].attachments.map(a => a.fileName).join(','));
  const ordersCsv = MAILS[0].attachments.find(a => /^Orders/.test(a.fileName)).content;
  t.check('CSV has the header row', ordersCsv.split('\n')[0].startsWith('Order ID,Created At'));
  t.check('CSV contains real order data', ordersCsv.includes('Slow Payer'));
  t.check('CSV quotes fields containing commas', /"[^"]*,[^"]*"/.test(ordersCsv));
  t.check('files written to Drive', DRIVE.files.filter(f => !f.trashed).length === 3);

  // Prove old backups get pruned.
  for (let w = 0; w < 12; w++) {
    const f = DRIVE.files[0];
    weeklyBackup();
  }
  t.check('prunes to the configured 8 weeks per tab',
    DRIVE.files.filter(f => !f.trashed && /^Orders/.test(f.name)).length <= 8,
    String(DRIVE.files.filter(f => !f.trashed && /^Orders/.test(f.name)).length));

  t.section('Telegram keyboard follows the pipeline');
  const kb = contactKeyboard_('ORD-X', '94771234567', 'Dehiwala', 'Cooking', 5000);
  const kbs = JSON.stringify(kb);
  t.check('offers the next step only', kbs.includes('Out for delivery') && !kbs.includes('Start cooking'));
  t.check('offers to record payment', kbs.includes('paid_ORD-X') && kbs.includes('5,000'));
  const kbDone = JSON.stringify(contactKeyboard_('ORD-Y', '94771234567', '', 'Delivered', 0));
  t.check('no pipeline button once delivered', !kbDone.includes('adv_'));
  t.check('no payment button when nothing owed', !kbDone.includes('paid_'));

  t.section('New API routes');
  t.check('unpaid route returns outstanding orders', readUnpaid_().length === 2, String(readUnpaid_().length));
  t.check('sorted biggest debt first', readUnpaid_()[0].balanceDue >= readUnpaid_()[1].balanceDue);
  // Routes now require a signed Telegram launch, not just the (public) key.
  const owner = telegram.launchAs(PROPS.TELEGRAM_BOT_TOKEN, PROPS.TELEGRAM_OWNER_CHAT_ID);
  const menuRes = JSON.parse(doGet({ parameter: { action: 'menu', key: 'testkey', initData: owner } }).getContent());
  t.check('menu route publishes the status flow', menuRes.statusFlow.length === 4, JSON.stringify(menuRes.statusFlow));
  const unauthed = JSON.parse(doGet({ parameter: { action: 'menu', key: 'testkey' } }).getContent());
  t.check('and refuses an unsigned request', unauthed.status === 'error', JSON.stringify(unauthed).slice(0, 80));

};
