/**
 * Suite for the money ledger.
 *
 * Before this existed the app tracked price, not money: Total / Advance /
 * Balance were overwritten in place, so there was no record of when cash
 * arrived, how much came each time, or how it was paid. Worst of all,
 * markOrderPaid_ wrote `Advance = Total`, recording money collected on
 * delivery as though it had been paid upfront.
 *
 * The Ledger is append-only and is the source of truth; the order's money
 * columns are mirrors recomputed from it. These checks hold that line.
 */

const stub = require('./helpers/apps-script-stub.js');

module.exports = function (t) {
  const { SS, SENT, PROPS } = stub.install();
  eval(stub.backendSource());
  const owner = require('./helpers/telegram.js')
    .launchAs(PROPS.TELEGRAM_BOT_TOKEN, PROPS.TELEGRAM_OWNER_CHAT_ID);

  initSheets();

  function book(overrides) {
    return saveOrder_(Object.assign({
      itemsJson: [{ name: 'Chicken Dum Biryani', unit: 'Pax', qty: 60, rate: 950 }],
      itemsSummary: 'Chicken Dum Biryani: 60 Pax',
      deliveryDate: '2026-09-11', deliveryTime: '13:00',
      customerName: 'Rizwan', customerPhone: '0771234567',
      totalAmount: 57000, advancePaid: 0
    }, overrides || {})).orderId;
  }

  t.section('An advance is recorded as an event, not a number in a cell');
  const withAdvance = book({ advancePaid: 20000, customerName: 'Advance Payer' });
  const advanceRows = readLedger_().filter(r => r[LED.ORDER] === withAdvance);
  t.check('one ledger row was written', advanceRows.length === 1, String(advanceRows.length));
  t.check('categorised as an advance', advanceRows[0][LED.CATEGORY] === 'Advance');
  t.check('for the right amount', num_(advanceRows[0][LED.AMOUNT]) === 20000);
  t.check('received mirrors the ledger', orderReceived_(withAdvance) === 20000);
  t.check('balance is total minus received', num_(findOrderRow_(withAdvance)[COL.BALANCE]) === 37000);
  t.check('status says part paid', findOrderRow_(withAdvance)[COL.PAYMENT] === 'Part paid');

  t.section('Settling no longer invents an advance that was never paid');
  const onDelivery = book({ advancePaid: 0, customerName: 'Pays On Delivery' });
  t.check('nothing received yet', orderReceived_(onDelivery) === 0);
  const settled = markOrderPaid_(onDelivery, 'Cash', 'tester');
  t.check('collects exactly what was outstanding', settled.collected === 57000, String(settled.collected));

  const settleRows = readLedger_().filter(r => r[LED.ORDER] === onDelivery);
  t.check('recorded as a settlement, not an advance',
    settleRows.length === 1 && settleRows[0][LED.CATEGORY] === 'Settlement',
    settleRows.map(r => r[LED.CATEGORY]).join(','));
  t.check('the books no longer claim it was prepaid',
    !settleRows.some(r => r[LED.CATEGORY] === 'Advance'));
  t.check('settling twice collects nothing further', markOrderPaid_(onDelivery).collected === 0);

  t.section('Instalments — the real way catering gets paid');
  const staged = book({ advancePaid: 10000, customerName: 'Three Payments', totalAmount: 60000 });
  recordPayment_(staged, 30000, 'Bank', 'tester', 'On delivery');
  recordPayment_(staged, 20000, 'Cash', 'tester', 'Balance a week later');
  t.check('three separate payments are all kept',
    readLedger_().filter(r => r[LED.ORDER] === staged && r[LED.TYPE] === 'Payment In').length === 3);
  t.check('they add up to the total', orderReceived_(staged) === 60000, String(orderReceived_(staged)));
  t.check('the order reads as fully paid', findOrderRow_(staged)[COL.PAYMENT] === 'Paid');
  t.check('each payment kept its own method',
    readLedger_().filter(r => r[LED.ORDER] === staged).map(r => r[LED.METHOD]).join(',') === 'Cash,Bank,Cash');

  t.section('A part payment can be recorded through the API the app uses');
  // recordPayment_ was implemented, routed and tested, but nothing in the app
  // or the bot ever called it — only full settlement was reachable.
  const partial = book({ totalAmount: 40000, customerName: 'Pays In Parts' });
  const viaApi = JSON.parse(doPost({
    parameter: {},
    postData: { contents: JSON.stringify({
      action: 'recordPayment', key: PROPS.API_KEY, initData: owner,
      orderId: partial, amount: 15000, method: 'Bank'
    }) }
  }).getContent());
  t.check('the route accepts it', viaApi.status === 'success', JSON.stringify(viaApi).slice(0, 110));
  t.check('received is just that payment', viaApi.received === 15000, String(viaApi.received));
  t.check('the rest is still owed', viaApi.balance === 25000, String(viaApi.balance));
  t.check('marked as part paid', viaApi.paymentStatus === 'Part paid', viaApi.paymentStatus);
  t.check('the method was kept', readLedger_().filter(r => r[LED.ORDER] === partial)[0][LED.METHOD] === 'Bank');

  t.section('/pay records a payment from the chat');
  SENT.length = 0;
  handlePayCommand_('/pay ' + partial + ' 25000 cash', 'tester');
  t.check('it confirms the amount', SENT.some(m => /25,000/.test(m.payload.text || '')));
  t.check('and says it is now settled', SENT.some(m => /Paid in full/i.test(m.payload.text || '')));
  t.check('the order really is settled', orderReceived_(partial) === 40000, String(orderReceived_(partial)));
  SENT.length = 0;
  handlePayCommand_('/pay nonsense', 'tester');
  t.check('a malformed command explains itself', SENT.some(m => /How to record a payment/i.test(m.payload.text || '')));
  SENT.length = 0;
  handlePayCommand_('/pay ORD-DOES-NOT-EXIST 500', 'tester');
  t.check('an unknown order is reported, not silently dropped',
    SENT.some(m => /not found/i.test(m.payload.text || '')), JSON.stringify(SENT[0] && SENT[0].payload.text));

  t.section('Cancelling never quietly keeps the customer’s money');
  const cancelled = book({ advancePaid: 15000, customerName: 'Changed Mind' });
  SENT.length = 0;
  const cancelResult = cancelOrder_(cancelled);
  t.check('the money held is reported back', cancelResult.receivedHeld === 15000, String(cancelResult.receivedHeld));
  t.check('the owner is told about it', SENT.some(m => /still holds the customer/i.test(m.payload.text || '')));
  t.check('with a one-tap refund button',
    SENT.some(m => JSON.stringify(m.payload.reply_markup || {}).includes('refund_' + cancelled)));

  recordRefund_(cancelled, 15000, 'Cash', 'tester', 'Cancelled');
  t.check('after refunding, nothing is held', orderReceived_(cancelled) === 0);
  t.check('and both movements remain on record',
    readLedger_().filter(r => r[LED.ORDER] === cancelled).length === 2);

  t.section('Changing an agreed price leaves a trail');
  const discounted = book({ totalAmount: 50000, customerName: 'Haggler' });
  updateOrder_(discounted, { totalAmount: 45000, specialNotes: 'Agreed discount for a repeat customer' });
  const adjustments = readLedger_().filter(r => r[LED.ORDER] === discounted && r[LED.TYPE] === 'Adjustment');
  t.check('an adjustment is recorded', adjustments.length === 1);
  t.check('it keeps the old and new figures', /50,000.*45,000/.test(String(adjustments[0][LED.NOTE])), String(adjustments[0][LED.NOTE]));
  t.check('and the stated reason', /repeat customer/.test(String(adjustments[0][LED.NOTE])));
  t.check('an adjustment moves no money', orderReceived_(discounted) === 0);

  t.section('Food cost and margin, with no extra typing');
  const costed = book({ totalAmount: 57000, customerName: 'Margin Check' });
  const row = findOrderRow_(costed);
  t.check('cost is derived from the Menu tab', num_(row[COL.COST]) === 60 * 550, String(row[COL.COST]));
  t.check('margin is total minus cost', num_(row[COL.MARGIN]) === 57000 - 33000, String(row[COL.MARGIN]));
  t.check('an unpriced dish leaves cost blank rather than guessing zero',
    estimateFoodCost_([{ name: 'Something Not On The Menu', qty: 10 }]) === null);

  t.section('Expenses');
  recordExpense_(4500, 'chicken from the market', null, 'Cash', 'tester');
  recordExpense_(1200, 'gas cylinder', null, 'Cash', 'tester');
  recordExpense_(800, 'driver', null, 'Bank', 'tester');
  const expenses = readLedger_().filter(r => r[LED.TYPE] === 'Expense');
  t.check('all three are recorded', expenses.length === 3);
  t.check('chicken is categorised as ingredients', expenses[0][LED.CATEGORY] === 'Ingredients', expenses[0][LED.CATEGORY]);
  t.check('gas is categorised as gas', expenses[1][LED.CATEGORY] === 'Gas', expenses[1][LED.CATEGORY]);
  t.check('driver is categorised as transport', expenses[2][LED.CATEGORY] === 'Transport', expenses[2][LED.CATEGORY]);
  t.check('an unrecognisable description falls back to Other', categoriseExpense_('miscellaneous thing') === 'Other');

  t.section('The /spend shortcut');
  SENT.length = 0;
  handleSpendCommand_('/spend 2500 mutton', 'tester');
  t.check('confirms the amount', SENT.some(m => /2,500/.test(m.payload.text || '')));
  t.check('and the category it chose', SENT.some(m => /Ingredients/.test(m.payload.text || '')));

  handleSpendCommand_('/spend 900 packing boxes bank', 'tester');
  const banked = readLedger_().filter(r => r[LED.TYPE] === 'Expense').pop();
  t.check('a trailing "bank" sets the method', banked[LED.METHOD] === 'Bank', banked[LED.METHOD]);
  t.check('without swallowing the description', /packing boxes/.test(String(banked[LED.DESCRIPTION])), String(banked[LED.DESCRIPTION]));
  t.check('and still categorises it', banked[LED.CATEGORY] === 'Packaging', banked[LED.CATEGORY]);

  SENT.length = 0;
  handleSpendCommand_('/spend', 'tester');
  t.check('a bare /spend explains itself instead of failing', SENT.some(m => /How to record a cost/i.test(m.payload.text || '')));
  const beforeJunk = readLedger_().length;
  handleSpendCommand_('/spend abc', 'tester');
  t.check('junk records nothing', readLedger_().length === beforeJunk);

  t.section('Ledger integrity');
  t.throws('a negative amount is refused', () => addLedgerEntry_({ type: 'Payment In', amount: -50 }));
  t.throws('a zero payment is refused', () => addLedgerEntry_({ type: 'Payment In', amount: 0 }));
  t.throws('an unknown type is refused', () => addLedgerEntry_({ type: 'Fiddle', amount: 100 }));
  const before = readLedger_().length;
  try { addLedgerEntry_({ type: 'Payment In', amount: -1 }); } catch (e) {}
  t.check('a rejected entry writes nothing', readLedger_().length === before);
  t.check('every entry carries who recorded it',
    readLedger_().every(r => String(r[LED.BY]).length > 0));
  t.check('every entry is timestamped', readLedger_().every(r => /^\d{4}-\d{2}-\d{2}/.test(String(r[LED.TIMESTAMP]))));
  t.check('entry ids are unique',
    new Set(readLedger_().map(r => r[LED.ID])).size === readLedger_().length);

  t.section('Reports reconcile with the ledger');
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const m = summariseMoney_(today, today);
  const ledgerIn = readLedger_().filter(r => r[LED.TYPE] === 'Payment In')
    .reduce((sum, r) => sum + num_(r[LED.AMOUNT]), 0);
  const ledgerOut = readLedger_().filter(r => r[LED.TYPE] === 'Expense')
    .reduce((sum, r) => sum + num_(r[LED.AMOUNT]), 0);
  t.check('payments in match the ledger', m.paymentsIn === ledgerIn, m.paymentsIn + ' vs ' + ledgerIn);
  t.check('expenses match the ledger', m.expenses === ledgerOut, m.expenses + ' vs ' + ledgerOut);
  t.check('profit is money in less refunds less costs',
    m.profit === m.paymentsIn - m.refundsOut - m.expenses);
  t.check('cash in hand counts only cash movements',
    m.cashInHand === m.byMethod.Cash - 15000 - (4500 + 1200 + 2500),
    String(m.cashInHand));

  t.section('Receivables aging');
  const aging = receivablesAging_();
  t.check('cancelled orders are excluded', !JSON.stringify(aging).includes('Changed Mind'));
  t.check('fully paid orders are excluded', !JSON.stringify(aging).includes('Three Payments'));
  t.check('the total equals the sum of the buckets',
    aging.total === ['current', 'week', 'month', 'older']
      .reduce((sum, k) => sum + aging[k].reduce((s, x) => s + x.balance, 0), 0));

  SENT.length = 0;
  sendCashReport_();
  t.check('the cash report states what the box should hold',
    SENT.some(m2 => /Cash box should hold/i.test(m2.payload.text || '')));
  SENT.length = 0;
  sendMonthReport_();
  t.check('the month report shows a margin percentage',
    SENT.some(m2 => /Margin \d+%/.test(m2.payload.text || '')));

  t.section('Settling in full is atomic');
  // markOrderPaid_ read the outstanding balance BEFORE taking the lock, then
  // called a locked writer. Two taps on "Paid" — easy on a slow phone — both
  // saw the full balance and both recorded it, leaving the order Overpaid and
  // the books showing more money than the customer handed over.
  const twice = saveOrder_({
    itemsJson: [{ name: 'Chicken Dum Biryani', unit: 'Pax', qty: 20, rate: 950 }],
    itemsSummary: 'Chicken Dum Biryani: 20 Pax',
    deliveryDate: '2026-09-20', deliveryTime: '13:00',
    customerName: 'Double Tap', customerPhone: '0771230009',
    totalAmount: 19000, advancePaid: 4000
  }).orderId;

  t.check('starts owing 15,000', num_(findOrderRow_(twice)[COL.BALANCE]) === 15000, String(num_(findOrderRow_(twice)[COL.BALANCE])));
  const first = markOrderPaid_(twice, 'Cash', 'owner');
  const second = markOrderPaid_(twice, 'Cash', 'owner');

  t.check('the first tap collects the outstanding 15,000', first.collected === 15000, String(first.collected));
  t.check('the second tap collects nothing', second.collected === 0, String(second.collected));
  t.check('the order is settled, not overpaid',
    num_(findOrderRow_(twice)[COL.BALANCE]) === 0, String(num_(findOrderRow_(twice)[COL.BALANCE])));
  t.check('received equals the total, never more',
    orderReceived_(twice) === 19000, String(orderReceived_(twice)));
  t.check('exactly one settlement entry reached the Ledger',
    readLedger_().filter(r => r[LED.ORDER] === twice && r[LED.CATEGORY] === 'Settlement').length === 1,
    readLedger_().filter(r => r[LED.ORDER] === twice).map(r => r[LED.CATEGORY]).join(','));

  t.section('Refunding a cancellation is atomic too');
  const ref = saveOrder_({
    itemsJson: [{ name: 'Chicken Dum Biryani', unit: 'Pax', qty: 10, rate: 950 }],
    itemsSummary: 'Chicken Dum Biryani: 10 Pax',
    deliveryDate: '2026-09-21', deliveryTime: '13:00',
    customerName: 'Refund Twice', customerPhone: '0771230010',
    totalAmount: 9500, advancePaid: 3000
  }).orderId;

  t.check('holds the 3,000 advance', orderReceived_(ref) === 3000, String(orderReceived_(ref)));
  const r1 = refundAllHeld_(ref, 'Cash', 'owner');
  const r2 = refundAllHeld_(ref, 'Cash', 'owner');
  t.check('the first refund returns 3,000', r1.refunded === 3000, String(r1.refunded));
  t.check('the second finds nothing left to refund', r2.refunded === 0, String(r2.refunded));
  t.check('the order holds nothing afterwards', orderReceived_(ref) === 0, String(orderReceived_(ref)));
  t.check('and the money is not refunded into a negative',
    readLedger_().filter(r => r[LED.ORDER] === ref && r[LED.TYPE] === 'Refund Out').length === 1);

};
