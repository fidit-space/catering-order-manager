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

  t.section('A redelivered update is handled once, not every retry');
  // Telegram resends an update when the webhook does not answer cleanly and
  // fast enough. Without a guard, one /cash produced a fresh report on every
  // retry, for as long as Telegram kept trying.
  const wh = PROPS.WEBHOOK_SECRET;
  const cashUpdate = JSON.stringify({
    update_id: 90001,
    message: { message_id: 1, chat: { id: Number(PROPS.TELEGRAM_OWNER_CHAT_ID) },
               from: { id: Number(PROPS.TELEGRAM_OWNER_CHAT_ID), username: 'owner' }, text: '/cash' }
  });
  SENT.length = 0;
  const first = JSON.parse(doPost({ parameter: { wh: wh }, postData: { contents: cashUpdate } }).getContent());
  const afterFirst = SENT.length;
  const second = JSON.parse(doPost({ parameter: { wh: wh }, postData: { contents: cashUpdate } }).getContent());
  const third = JSON.parse(doPost({ parameter: { wh: wh }, postData: { contents: cashUpdate } }).getContent());

  t.check('the first delivery is processed', first.status === 'ok', JSON.stringify(first));
  t.check('it sent exactly one report', afterFirst === 1, String(afterFirst));
  t.check('retries are recognised as duplicates',
    second.status === 'duplicate' && third.status === 'duplicate',
    second.status + ',' + third.status);
  t.check('and send nothing further', SENT.length === afterFirst, String(SENT.length));

  const other = JSON.parse(doPost({ parameter: { wh: wh }, postData: { contents:
    cashUpdate.replace('90001', '90002') } }).getContent());
  t.check('a genuinely new update still gets through', other.status === 'ok');
  t.check('and produces its own report', SENT.length === afterFirst + 1, String(SENT.length));

  t.section('Advancing a status keeps the whole keyboard');
  // Replacing it with just the next-step button threw away Call, WhatsApp,
  // Map and Mark-paid — the buttons wanted at a customer's door.
  const kbOrder = saveOrder_({
    itemsJson: [{ name: 'Chicken Dum Biryani', unit: 'Pax', qty: 20, rate: 950 }],
    itemsSummary: 'Chicken Dum Biryani: 20 Pax',
    deliveryDate: '2026-09-12', deliveryTime: '13:00',
    customerName: 'Keyboard Test', customerPhone: '0771239999',
    deliveryAddress: 'Dehiwala', totalAmount: 19000, advancePaid: 0
  }).orderId;
  SENT.length = 0;
  handleCallbackQuery_({
    id: 'cb1', data: 'adv_' + kbOrder, from: { id: 111, username: 'owner' },
    message: { chat: { id: 111 }, message_id: 5, text: 'Order for Curries & Gravy' }
  });
  const markup = SENT.find(m => m.method === 'editMessageReplyMarkup');
  t.check('the keyboard is rebuilt', !!markup);
  const kbText = JSON.stringify(markup.payload.reply_markup);
  t.check('Call survives', /tel:/.test(kbText), kbText.slice(0, 120));
  t.check('WhatsApp survives', /wa\.me/.test(kbText));
  t.check('Maps survives', /maps\/search/.test(kbText));
  t.check('the next step is offered', /adv_/.test(kbText));
  const stamped = SENT.find(m => m.method === 'editMessageText');
  t.check('and the ampersand did not break the stamp', /&amp;/.test(stamped.payload.text), stamped.payload.text);

  t.section('New API routes');
  // Asserted by identity, not by count: other checks in this suite book orders
  // of their own, so a hardcoded number goes stale the moment one is added.
  const unpaid = readUnpaid_();
  t.check('every order returned actually owes money', unpaid.every(o => o.balanceDue > 0),
    unpaid.map(o => o.balanceDue).join(','));
  t.check('the known debtors are present',
    unpaid.some(o => o.customerName === 'Slow Payer') && unpaid.some(o => o.customerName === 'Just Delivered'),
    unpaid.map(o => o.customerName).join(','));
  t.check('settled orders are excluded', !unpaid.some(o => o.customerName === 'Rizwan'));
  t.check('sorted biggest debt first',
    unpaid.every((o, i) => i === 0 || unpaid[i - 1].balanceDue >= o.balanceDue),
    unpaid.map(o => o.balanceDue).join(','));
  // Routes now require a signed Telegram launch, not just the (public) key.
  const owner = telegram.launchAs(PROPS.TELEGRAM_BOT_TOKEN, PROPS.TELEGRAM_OWNER_CHAT_ID);
  const menuRes = JSON.parse(doGet({ parameter: { action: 'menu', key: 'testkey', initData: owner } }).getContent());
  t.check('menu route publishes the status flow', menuRes.statusFlow.length === 4, JSON.stringify(menuRes.statusFlow));
  const unauthed = JSON.parse(doGet({ parameter: { action: 'menu', key: 'testkey' } }).getContent());
  t.check('and refuses an unsigned request', unauthed.status === 'error', JSON.stringify(unauthed).slice(0, 80));

  // ------------------------------------------------------------------
  // Commands the owner can actually find and type.
  // ------------------------------------------------------------------
  let uid = 95000;
  function say(text) {
    SENT.length = 0;
    doPost({ parameter: { wh: PROPS.WEBHOOK_SECRET }, postData: { contents: JSON.stringify({
      update_id: ++uid,
      message: { message_id: uid, chat: { id: Number(PROPS.TELEGRAM_OWNER_CHAT_ID) },
                 from: { id: Number(PROPS.TELEGRAM_OWNER_CHAT_ID), username: 'owner' }, text }
    }) } });
    return SENT.filter(m => m.method === 'sendMessage');
  }
  function tap(data) {
    SENT.length = 0;
    handleCallbackQuery_({
      id: 'cb' + (++uid), data, from: { id: 111, username: 'owner' },
      message: { chat: { id: 111 }, message_id: 9, text: 'Pick a customer' }
    });
    return SENT.filter(m => m.method === 'sendMessage');
  }

  t.section('The command list is discoverable');
  // Every command existed but nothing published them: Telegram's blue Menu
  // button was empty and there was no /help, so the owner had to be told.
  t.check('every listed command is routable', BOT_COMMANDS.every(c =>
    ['today', 'tomorrow', 'yesterday', 'week', 'pending', 'owed',
     'cash', 'month', 'pay', 'spend', 'help'].includes(c.command)),
    BOT_COMMANDS.map(c => c.command).join(','));
  t.check('each carries a description Telegram will accept',
    BOT_COMMANDS.every(c => c.description.length > 0 && c.description.length <= 256));
  t.check('commands are lowercase, as Telegram requires',
    BOT_COMMANDS.every(c => /^[a-z_]{1,32}$/.test(c.command)));

  SENT.length = 0;
  t.check('setMyCommands reaches Telegram', setMyCommands() === true);
  const pushed = SENT.find(m => m.method === 'setMyCommands');
  t.check('and pushes the whole list', pushed && pushed.payload.commands.length === BOT_COMMANDS.length,
    pushed ? String(pushed.payload.commands.length) : 'not sent');

  const help = say('/help');
  t.check('/help replies', help.length === 1, String(help.length));
  t.check('it names every command',
    BOT_COMMANDS.every(c => help[0].payload.text.includes('/' + c.command)));
  t.check('and shows the money examples, which need more than a description',
    help[0].payload.text.includes('/spend 4500 chicken') && help[0].payload.text.includes('/pay 20000'));
  t.check('the fallback menu offers help too', say('hello')[0].payload.reply_markup
    && JSON.stringify(say('hello')[0].payload.reply_markup).includes('cmd_help'));
  t.check('the help button works', tap('cmd_help').length === 1);

  t.section('New day-range commands');
  const weekOrder = saveOrder_({
    itemsJson: [{ name: 'Chicken Dum Biryani', unit: 'Pax', qty: 30, rate: 950 }],
    itemsSummary: 'Chicken Dum Biryani: 30 Pax',
    deliveryDate: todayStr(3), deliveryTime: '12:30',
    customerName: 'Week View', customerPhone: '0771230003',
    deliveryAddress: 'Kollupitiya', totalAmount: 28500, advancePaid: 0
  }).orderId;
  function todayStr(offsetDays) {
    return Utilities.formatDate(new Date(Date.now() + (offsetDays || 0) * 864e5), TZ, 'yyyy-MM-dd');
  }
  const week = say('/week');
  t.check('/week replies', week.length === 1, String(week.length));
  t.check('it includes an order three days out', week[0].payload.text.includes('Week View'));
  t.check('and totals what is still to collect', week[0].payload.text.includes('to collect this week'));
  t.check('/yesterday replies', say('/yesterday').length === 1);
  t.check('a group-style /cash@bot still routes',
    say('/cash@royal_catering_orders_bot')[0].payload.text.includes('CASH REPORT'));

  t.section('/pay without typing an order id');
  // A full ORD-260909-143000-A1B is not something anyone types on a phone
  // mid-service, so the amount alone must be enough.
  const payOrder = saveOrder_({
    itemsJson: [{ name: 'Chicken Dum Biryani', unit: 'Pax', qty: 10, rate: 950 }],
    itemsSummary: 'Chicken Dum Biryani: 10 Pax',
    deliveryDate: todayStr(2), deliveryTime: '19:00',
    customerName: 'Pay By Tap', customerPhone: '0771230004',
    deliveryAddress: 'Wellawatte', totalAmount: 9500, advancePaid: 0
  }).orderId;

  const offer = say('/pay 4000');
  t.check('it asks who paid', offer.length === 1 && offer[0].payload.text.includes('Who paid it?'),
    offer.length ? offer[0].payload.text.slice(0, 60) : 'nothing sent');
  const buttons = JSON.stringify(offer[0].payload.reply_markup || {});
  t.check('and offers the unpaid order as a button', buttons.includes('payto_' + payOrder + '_4000_Cash'), buttons.slice(0, 160));
  t.check('nothing is written until a button is tapped',
    orderReceived_(payOrder) === 0, String(orderReceived_(payOrder)));

  const applied = tap('payto_' + payOrder + '_4000_Cash');
  t.check('tapping records the payment', orderReceived_(payOrder) === 4000, String(orderReceived_(payOrder)));
  t.check('and reports what is still owed',
    applied.some(m => m.payload.text.includes('5,500')),
    applied.map(m => m.payload.text).join(' | ').slice(0, 120));
  t.check('the Ledger holds the entry, not just the mirror column',
    readLedger_().some(r => r[LED.ORDER] === payOrder && num_(r[LED.AMOUNT]) === 4000 &&
                            r[LED.TYPE] === 'Payment In' && r[LED.METHOD] === 'Cash'));

  t.check('a stated method is carried through',
    JSON.stringify(say('/pay 1000 bank')[0].payload.reply_markup).includes('_1000_Bank'));
  t.check('an unknown method falls back to cash',
    JSON.stringify(say('/pay 1000 cheque')[0].payload.reply_markup).includes('_1000_Cash'));

  // The explicit form must keep working — it is what the older messages show.
  say('/pay ' + payOrder + ' 1500 bank');
  t.check('the explicit "/pay <id> <amount>" form still works',
    orderReceived_(payOrder) === 5500, String(orderReceived_(payOrder)));

  t.check('a zero amount is refused',
    say('/pay 0')[0].payload.text.includes('greater than zero'));
  t.check('nonsense gets the how-to, not a crash',
    say('/pay')[0].payload.text.includes('How to record a payment'));

  t.section('Webhook registration cannot silently target a dead URL');
  // Deploy > New deployment mints a fresh /exec URL. Telegram kept posting to
  // the old one and the bot went completely silent, with no error anywhere.
  //
  // The shipped constant is blanked for these checks so the fallback chain
  // below (property -> constant -> getUrl) is exercised link by link.
  const shippedUrl = DEPLOYMENT_URL;
  DEPLOYMENT_URL = '';
  SENT.length = 0;
  const summary = registerWebhook();
  const setHook = SENT.find(m => m.method === 'setWebhook');
  t.check('it registers the deployment URL',
    setHook && setHook.payload.url.indexOf('https://script.google.com/macros/s/TEST/exec') === 0,
    setHook ? setHook.payload.url : 'not sent');
  t.check('it drops the retry backlog from the dead URL', setHook.payload.drop_pending_updates === true);
  t.check('it publishes the command menu in the same step',
    SENT.some(m => m.method === 'setMyCommands'));
  t.check('the summary names the URL it used', summary.includes('/macros/s/TEST/exec'));
  t.check('and tells the owner index.html needs the same URL', summary.includes('index.html'));

  const realUrl = global.SCRIPT_URL;
  global.SCRIPT_URL = 'https://script.google.com/macros/s/TEST/dev';
  let devError = '';
  try { registerWebhook(); } catch (e) { devError = e.message; }
  t.check('it refuses the /dev head URL, which Telegram can never reach',
    devError.includes('/dev'), devError || 'no error thrown');
  t.check('and the error explains the 401, not just the refusal',
    devError.includes('401') && devError.includes('DEPLOYMENT_URL'), devError);

  // The Run button cannot pass an argument, so the real deployment is named
  // once in Script Properties. This is the live project's only usable path:
  // getUrl() there reports /dev no matter what is deployed.
  PROPS.DEPLOYMENT_URL = 'https://script.google.com/macros/s/PINNED/exec';
  SENT.length = 0;
  registerWebhook();
  const pinnedHook = SENT.find(m => m.method === 'setWebhook');
  t.check('DEPLOYMENT_URL overrides the /dev URL the editor reports',
    pinnedHook.payload.url.indexOf('https://script.google.com/macros/s/PINNED/exec') === 0,
    pinnedHook.payload.url);
  t.check('diagnose says which source the target came from',
    diagnose().includes('(DEPLOYMENT_URL property)'));
  delete PROPS.DEPLOYMENT_URL;
  global.SCRIPT_URL = realUrl;
  DEPLOYMENT_URL = shippedUrl;

  let badError = '';
  try { registerWebhookAt('https://evil.example.com/exec'); } catch (e) { badError = e.message; }
  t.check('registerWebhookAt refuses a non-Apps-Script URL',
    badError.includes('Not a deployment URL'), badError || 'no error thrown');

  // A half-pasted URL stored the value "/exec" and the error did not say what
  // to do about it. Now it quotes what it got and names the way out.
  let partial = '';
  try { registerWebhookAt('/exec'); } catch (e) { partial = e.message; }
  t.check('a half-pasted URL is quoted back',
    partial.includes('got "/exec"'), partial);
  t.check('and the error names the fix',
    partial.includes('Script Properties') && partial.includes('ships in this file'), partial);

  const good = 'https://script.google.com/macros/s/PASTED/exec';
  SENT.length = 0;
  registerWebhookAt('  ' + good + '/  ');
  t.check('whitespace and a trailing slash from a phone paste are tolerated',
    SENT.find(m => m.method === 'setWebhook').payload.url.indexOf(good) === 0,
    SENT.find(m => m.method === 'setWebhook').payload.url);
  SENT.length = 0;
  registerWebhookAt(good + '?action=health');
  t.check('a copied query string is stripped',
    SENT.find(m => m.method === 'setWebhook').payload.url.indexOf(good + '?wh=') === 0,
    SENT.find(m => m.method === 'setWebhook').payload.url);

  // Asking the owner to paste a URL between two quote marks broke the file
  // twice on a phone. The URL now lives in a constant that ships with the
  // file, so pasting the whole file is the only step.
  t.check('the shipped DEPLOYMENT_URL constant is a real /exec deployment',
    /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(DEPLOYMENT_URL),
    DEPLOYMENT_URL);
  t.check('and it is the same URL index.html calls',
    require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8')
      .includes(DEPLOYMENT_URL),
    'index.html points somewhere else — the Mini App and the bot would disagree');

  SENT.length = 0;
  registerWebhook();
  t.check('with no property set, registerWebhook uses the constant',
    SENT.find(m => m.method === 'setWebhook').payload.url.indexOf(DEPLOYMENT_URL) === 0,
    SENT.find(m => m.method === 'setWebhook').payload.url);

  // A half-completed paste left DEPLOYMENT_URL holding "/exec". Because the
  // property outranked everything, it kept overriding a perfectly good default
  // and the bot stayed down through two more attempts to fix it.
  PROPS.DEPLOYMENT_URL = '/exec';
  SENT.length = 0;
  registerWebhook();
  t.check('a malformed property is ignored, not obeyed',
    SENT.find(m => m.method === 'setWebhook').payload.url.indexOf(DEPLOYMENT_URL) === 0,
    SENT.find(m => m.method === 'setWebhook').payload.url);
  t.check('and the reason is written to the Log tab',
    SS.getSheetByName('Log').rows.some(r => String(r[2]).includes('Ignoring the DEPLOYMENT_URL')));
  t.check('diagnose calls the bad property out',
    /FAIL\s+the DEPLOYMENT_URL script property holds "\/exec"/.test(diagnose()));
  delete PROPS.DEPLOYMENT_URL;

  t.section('diagnose() answers "is it wired up?"');
  SENT.length = 0;
  const report = diagnose();
  t.check('it reports every required property by name',
    ['TELEGRAM_BOT_TOKEN', 'API_KEY', 'WEBHOOK_SECRET'].every(k => report.includes(k)));
  t.check('but never a property VALUE',
    !report.includes(PROPS.TELEGRAM_BOT_TOKEN) && !report.includes(PROPS.WEBHOOK_SECRET) &&
    !report.includes(PROPS.API_KEY),
    'a credential leaked into the report');
  t.check('it lists the five scheduled jobs',
    ['checkDispatchAlerts', 'sendDailyPrepDigest', 'checkUnpaidBalances',
     'weeklyBackup', 'reportNewErrors'].every(fn => report.includes(fn)));
  t.check('it sends itself to the owner so it can be read on a phone',
    SENT.some(m => m.method === 'sendMessage' && m.payload.chat_id === PROPS.TELEGRAM_OWNER_CHAT_ID));

  t.check('it names the bot the token belongs to, so a token for the WRONG bot shows up',
    /Token belongs to:/.test(report), report.split('BOT')[1] ? report.split('BOT')[1].slice(0, 80) : '');

  // The first version of this reported "OK matches this deployment" while the
  // registered URL was a /dev head URL returning 401 to Telegram. A check that
  // passes on the broken state is worse than no check.
  SENT.length = 0;
  global.WEBHOOK_URL_OVERRIDE = 'https://script.google.com/macros/s/TEST/dev?wh=x';
  const devReport = diagnose();
  t.check('a /dev webhook is a failure, never an "OK"',
    /FAIL\s+that is the \/dev head URL/.test(devReport),
    devReport.split('WEBHOOK')[1] ? devReport.split('WEBHOOK')[1].slice(0, 200) : '');
  t.check('and the WEBHOOK_SECRET is stripped before display', !devReport.includes('wh=x'));
  global.WEBHOOK_URL_OVERRIDE = null;

  t.section('explainAuthFailure() names the cause');
  t.check('it says nothing was captured until it is switched on',
    explainAuthFailure().includes('Nothing captured'));
  t.check('debugAuthOn arms the capture', debugAuthOn().includes('open the Mini App'));

  // A launch signed by a DIFFERENT bot: the exact live symptom — every other
  // check healthy, sign-in failing, and no way to tell why.
  const wrongBot = telegram.launchAs('999999:otherbot', PROPS.TELEGRAM_OWNER_CHAT_ID,
    { signature: 'AbCdEf_test-signature' });
  t.check('a foreign launch is rejected', validateInitData_(wrongBot).ok === false);
  const verdict = explainAuthFailure();
  t.check('the failing launch was captured', !verdict.includes('Nothing captured'));
  t.check('every construction is tried', (verdict.match(/\n  (MATCH|no)/g) || []).length === 4,
    String((verdict.match(/\n  (MATCH|no)/g) || []).length));
  t.check('none of them match, because the key is wrong', !verdict.includes('MATCH  '));
  t.check('and it says so in plain words',
    verdict.includes('the KEY is wrong') && verdict.includes('@BotFather'));
  t.check('it never prints the token',
    !verdict.includes(PROPS.TELEGRAM_BOT_TOKEN) && !verdict.includes('999999:otherbot'));

  // The same launch signed by the RIGHT bot must be identified as verifiable,
  // so a genuine algorithm bug is not misreported as a wrong token.
  const rightBot = telegram.launchAs(PROPS.TELEGRAM_BOT_TOKEN, PROPS.TELEGRAM_OWNER_CHAT_ID,
    { signature: 'AbCdEf_test-signature' });
  t.check('a correctly signed launch with a signature field verifies',
    validateInitData_(rightBot).ok === true, JSON.stringify(validateInitData_(rightBot)).slice(0, 90));
  t.check('debugAuthOff clears the stored launch',
    debugAuthOff().includes('deleted') && explainAuthFailure().includes('Nothing captured'));

  const allTriggers = global.INSTALLED_TRIGGERS;
  global.INSTALLED_TRIGGERS = ['checkDispatchAlerts'];
  const gappy = diagnose();
  t.check('a missing trigger is called out',
    /MISSING weeklyBackup/.test(gappy) && /MISSING reportNewErrors/.test(gappy),
    gappy.split('TRIGGERS')[1] ? gappy.split('TRIGGERS')[1].slice(0, 160) : gappy.slice(0, 120));
  t.check('and an installed one is not', /OK\s+checkDispatchAlerts/.test(gappy));
  global.INSTALLED_TRIGGERS = allTriggers;

};
