/**
 * Suite for schema migration.
 *
 * The sheet helpers only write headers when they CREATE a tab, so the finance
 * release reached a spreadsheet that already held live data and changed
 * nothing in it. Two things followed in production: every margin was silently
 * blank because readMenu_ found no Cost column, and money recorded before the
 * Ledger existed had no entries behind it — one payment away from being
 * erased and the customer told they still owed it.
 *
 * These checks hold both lines: the migration repairs an old sheet, and a
 * spreadsheet that was never migrated still cannot lose a payment.
 */

const stub = require('./helpers/apps-script-stub.js');

module.exports = function (t) {
  const { SS } = stub.install();
  eval(stub.backendSource());

  // Build a spreadsheet exactly as the pre-finance release left it:
  // 21 Orders columns, "Advance Paid" not "Received", no Cost on Menu,
  // no Ledger tab, and real money sitting in the Advance column.
  const OLD_ORDER_HEADERS = [
    'Order ID', 'Created At', 'Delivery Date', 'Delivery Time', 'Customer Name',
    'Customer Phone', 'Delivery Address', 'Items', 'Total Amount', 'Advance Paid',
    'Balance Due', 'Status', 'Notes', 'Digest Sent', 'Dispatch Sent',
    'Delivered At', 'Payment Status', 'Updated At', 'Items JSON',
    'Payment Chase Sent', 'Paid At'
  ];
  const OLD_MENU_HEADERS = ['Category', 'Item', 'Unit', 'Rate', 'Step', 'Active'];

  const orders = SS.insertSheet('Orders');
  orders.appendRow(OLD_ORDER_HEADERS);
  const legacyItems = JSON.stringify([{ name: 'Chicken Dum Biryani', unit: 'Pax', qty: 60, rate: 950 }]);
  // Rizwan paid a 20,000 advance before the Ledger existed.
  orders.appendRow(['ORD-OLD-1', '2026-09-01 10:00:00', '2026-09-05', '13:00', 'Rizwan',
    '94771234567', 'Dehiwala', 'Chicken Dum Biryani: 60 Pax', 57000, 20000, 37000,
    'Confirmed', '', 'NO', 'NO', '', 'Advance', '2026-09-01 10:00:00', legacyItems, 'NO', '']);
  // And one that genuinely owes everything.
  orders.appendRow(['ORD-OLD-2', '2026-09-02 10:00:00', '2026-09-06', '19:00', 'Nimal',
    '94712223344', 'Mount Lavinia', 'Mutton Mandhi Special: 4 Packs', 9600, 0, 9600,
    'Confirmed', '', 'NO', 'NO', '', 'Unpaid', '2026-09-02 10:00:00',
    JSON.stringify([{ name: 'Mutton Mandhi Special', unit: 'Packs', qty: 4, rate: 2400 }]), 'NO', '']);

  const menuTab = SS.insertSheet('Menu');
  menuTab.appendRow(OLD_MENU_HEADERS);
  menuTab.appendRow(['Biryani', 'Chicken Dum Biryani', 'Pax', 950, 5, 'YES']);
  menuTab.appendRow(['Mandhi', 'Mutton Mandhi Special', 'Packs', 2400, 1, 'YES']);

  t.section('Before migrating: the defects are reproducible');
  t.check('the Menu has no Cost column', menuTab.rows[0].length === 6, String(menuTab.rows[0].length));
  t.check('so every dish costs nothing', readMenu_().every(m => !m.cost));
  t.check('and no margin can be worked out',
    estimateFoodCost_([{ name: 'Chicken Dum Biryani', qty: 60 }]) === null);
  t.check('the Orders header still says "Advance Paid"', orders.rows[0][COL.ADVANCE] === 'Advance Paid');
  t.check('money is recorded with nothing in the ledger behind it',
    num_(orders.rows[1][COL.ADVANCE]) === 20000 && readLedger_().length === 0);

  t.section('An unmigrated sheet still cannot lose a payment');
  const guarded = syncOrderMoney_('ORD-OLD-1');
  t.check('the sync refuses to run', guarded.skipped === 'needs migration', JSON.stringify(guarded));
  t.check('the 20,000 is left untouched', num_(orders.rows[1][COL.ADVANCE]) === 20000,
    String(orders.rows[1][COL.ADVANCE]));
  t.check('the customer is not told they owe it again', guarded.balance === 37000, String(guarded.balance));
  t.check('and it is recorded in the Log for someone to act on',
    SS.getSheetByName('Log').rows.some(r => /Refused to zero/.test(String(r[2]))));

  t.section('Migrating repairs the schema');
  const summary = migrateSheets_();
  t.check('it reports what it did', /Migrated:/.test(summary), summary);
  t.check('Orders headers are current', orders.rows[0][COL.ADVANCE] === 'Received');
  t.check('the two new columns are labelled',
    orders.rows[0][COL.COST] === 'Est. Food Cost' && orders.rows[0][COL.MARGIN] === 'Est. Margin');
  t.check('the Menu gained a Cost column', menuTab.rows[0][6] === 'Cost');
  t.check('the Ledger tab now exists', !!SS.getSheetByName('Ledger'));
  t.check('the Settings tab now exists', !!SS.getSheetByName('Settings'));

  t.section('Money that predates the Ledger is carried over, not lost');
  const carried = readLedger_().filter(r => r[LED.ORDER] === 'ORD-OLD-1');
  t.check('an opening-balance entry was written', carried.length === 1, String(carried.length));
  t.check('for the exact amount recorded', num_(carried[0][LED.AMOUNT]) === 20000);
  t.check('categorised so it is obvious where it came from', carried[0][LED.CATEGORY] === 'Opening balance');
  t.check('and attributed to the migration', carried[0][LED.BY] === 'migration');
  t.check('the method is honestly marked unknown, not guessed as Cash',
    carried[0][LED.METHOD] === 'Unknown', String(carried[0][LED.METHOD]));
  t.check('an order that owed everything gets no entry',
    !readLedger_().some(r => r[LED.ORDER] === 'ORD-OLD-2'));

  t.section('After migrating, the balance survives a real recalculation');
  const synced = syncOrderMoney_('ORD-OLD-1');
  t.check('the sync now runs', synced.skipped === undefined, JSON.stringify(synced));
  t.check('the 20,000 is still there', synced.received === 20000, String(synced.received));
  t.check('the balance is unchanged', synced.balance === 37000, String(synced.balance));
  t.check('status reflects a part payment', synced.paymentStatus === 'Part paid', synced.paymentStatus);

  t.section('And a further payment now behaves correctly');
  const settled = markOrderPaid_('ORD-OLD-1', 'Cash', 'tester');
  t.check('only the outstanding 37,000 is collected', settled.collected === 37000, String(settled.collected));
  t.check('total received is the full 57,000', orderReceived_('ORD-OLD-1') === 57000,
    String(orderReceived_('ORD-OLD-1')));
  t.check('the earlier advance is still on record',
    readLedger_().filter(r => r[LED.ORDER] === 'ORD-OLD-1').length === 2);

  t.section('Carried-over money is dated to the order, not to the migration');
  // Stamping it with the migration's own timestamp booked historical money as
  // today's takings — the cash report showed Rs. 80,000 of old advances as
  // income earned today, and inflated the day's profit to match.
  const opening = readLedger_().filter(r => r[LED.CATEGORY] === 'Opening balance')[0];
  t.check('it carries the order\'s creation date', String(opening[LED.TIMESTAMP]).indexOf('2026-09-01') === 0,
    String(opening[LED.TIMESTAMP]));
  const todayStr = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  // Today should contain the 37,000 genuinely settled earlier in this suite,
  // and NOT the 20,000 advance carried over from an order taken on 1 Sep.
  t.check('today shows only money actually taken today',
    summariseMoney_(todayStr, todayStr).paymentsIn === 37000,
    String(summariseMoney_(todayStr, todayStr).paymentsIn));
  t.check('but it still counts in the period it belongs to',
    summariseMoney_('2026-09-01', '2026-09-01').paymentsIn === 20000,
    String(summariseMoney_('2026-09-01', '2026-09-01').paymentsIn));
  t.check('and the order balance is unaffected', orderReceived_('ORD-OLD-1') === 57000);

  t.section('Wrongly dated opening balances are repaired');
  const led = SS.getSheetByName('Ledger');
  const row = led.rows.findIndex(r => r[LED.CATEGORY] === 'Opening balance');
  led.rows[row][LED.TIMESTAMP] = nowStr_();          // simulate the bad stamp
  t.check('the historical 20,000 now pollutes today',
    summariseMoney_(todayStr, todayStr).paymentsIn === 57000,
    String(summariseMoney_(todayStr, todayStr).paymentsIn));
  const repaired = migrateSheets_();
  t.check('the repair reports itself', /re-dated/.test(repaired), repaired);
  t.check('and today is back to only today\'s money',
    summariseMoney_(todayStr, todayStr).paymentsIn === 37000,
    String(summariseMoney_(todayStr, todayStr).paymentsIn));
  t.check('the carried-over money is back where it belongs',
    summariseMoney_('2026-09-01', '2026-09-01').paymentsIn === 20000);

  t.section('Costs backfill once the Menu has them');
  menuTab.rows[1][6] = 550;
  const second = migrateSheets_();
  t.check('the newly costable order is filled in', num_(orders.rows[1][COL.COST]) === 60 * 550,
    String(orders.rows[1][COL.COST]));
  t.check('with the matching margin', num_(orders.rows[1][COL.MARGIN]) === 57000 - 33000,
    String(orders.rows[1][COL.MARGIN]));
  t.check('a dish with no cost is left blank rather than guessed at',
    orders.rows[2][COL.COST] === '' || orders.rows[2][COL.COST] === undefined,
    String(orders.rows[2][COL.COST]));
  t.check('and it reported the backfill', /cost and margin/.test(second), second);

  t.section('Running it again changes nothing');
  const ledgerBefore = readLedger_().length;
  const third = migrateSheets_();
  t.check('it reports nothing to do', /Nothing to migrate/.test(third), third);
  t.check('no duplicate opening balances were written', readLedger_().length === ledgerBefore);
  t.check('received is unchanged', orderReceived_('ORD-OLD-1') === 57000);
};
