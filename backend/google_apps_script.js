/**
 * CATERING ORDER MANAGEMENT SYSTEM — GOOGLE APPS SCRIPT BACKEND
 * ============================================================
 * Serverless backend for the Telegram Mini App. Runs entirely inside
 * Google's cloud attached to one Google Sheet. No servers, no cost.
 *
 * Sheets managed automatically:
 *   Menu      — dishes, units and prices. EDIT THIS TAB TO CHANGE THE MENU.
 *   Orders    — every order, with reminder + delivery bookkeeping.
 *   Customers — phone-keyed customer directory built from orders.
 *   Log       — errors and Telegram delivery failures.
 *
 * FIRST-TIME SETUP: fill in setupProperties() below, run it once, then run
 * initSheets(), deploy as a Web App, and run registerWebhook().
 * Full instructions: SETUP_INSTRUCTIONS.md
 */

// ==================== CONSTANTS ====================

var TZ = 'Asia/Colombo';          // Business timezone (UTC+05:30, no DST)
var CURRENCY = 'Rs.';             // Displayed in Telegram messages
var COUNTRY_CODE = '94';          // Sri Lanka — used to normalise phone numbers

var SHEETS = {
  ORDERS: 'Orders',
  CUSTOMERS: 'Customers',
  MENU: 'Menu',
  SETTINGS: 'Settings',
  LOG: 'Log'
};

// Orders sheet column indexes (0-based). Order of these must not change.
var COL = {
  ID: 0, CREATED: 1, DATE: 2, TIME: 3, NAME: 4, PHONE: 5, ADDRESS: 6,
  ITEMS: 7, TOTAL: 8, ADVANCE: 9, BALANCE: 10, STATUS: 11, NOTES: 12,
  DIGEST_SENT: 13, DISPATCH_SENT: 14, DELIVERED_AT: 15, PAYMENT: 16,
  UPDATED: 17, ITEMS_JSON: 18, CHASE_SENT: 19, PAID_AT: 20
};

var ORDER_HEADERS = [
  'Order ID', 'Created At', 'Delivery Date', 'Delivery Time', 'Customer Name',
  'Customer Phone', 'Delivery Address', 'Items', 'Total Amount', 'Advance Paid',
  'Balance Due', 'Status', 'Notes', 'Digest Sent', 'Dispatch Sent',
  'Delivered At', 'Payment Status', 'Updated At', 'Items JSON',
  'Payment Chase Sent', 'Paid At'
];

/**
 * The kitchen pipeline, in order. An order advances one step at a time from a
 * single Telegram button, so the owner never has to pick from a list.
 * Tentative sits outside the flow: it must be confirmed before prep starts.
 */
var STATUS_FLOW = ['Confirmed', 'Cooking', 'Out for Delivery', 'Delivered'];
var STATUS_ICON = {
  'Tentative': '⏳', 'Confirmed': '✅', 'Cooking': '🍳',
  'Out for Delivery': '🚚', 'Delivered': '📦', 'Cancelled': '✕'
};
var STATUS_ACTION = {
  'Confirmed': '🍳 Start cooking',
  'Cooking': '🚚 Out for delivery',
  'Out for Delivery': '📦 Mark delivered'
};

var CUSTOMER_HEADERS = [
  'Phone', 'Customer Name', 'Last Address', 'Total Orders', 'First Seen', 'Last Order Date'
];

var MENU_HEADERS = ['Category', 'Item', 'Unit', 'Rate', 'Step', 'Active'];

var SETTINGS_HEADERS = ['Setting', 'Value', 'What it does'];

// Everything the owner might reasonably want to change, kept out of the code.
var DEFAULT_SETTINGS = [
  ['business_name', 'Catering Orders', 'Name shown on the backup emails'],
  ['dispatch_lead_minutes', 180, 'How long before delivery the urgent cook-and-dispatch alert is sent'],
  ['payment_chase_days', 3, 'Days after delivery before an unpaid balance is chased. 0 turns chasing off'],
  ['backup_email', '', 'Where the weekly backup is emailed. Blank = the Google account that owns this sheet'],
  ['backup_keep_weeks', 8, 'How many weekly backup files to keep in Drive before deleting the oldest']
];

// Dishes seeded into the Menu sheet on first run. After that the SHEET wins —
// edit the Menu tab from the Google Sheets phone app, no code change needed.
var DEFAULT_MENU = [
  ['Biryani',  'Chicken Dum Biryani',            'Pax',      950,  5,  'YES'],
  ['Biryani',  'Mutton Dum Biryani',             'Pax',     1350,  5,  'YES'],
  ['Biryani',  'Beef Biryani',                   'Pax',     1150,  5,  'YES'],
  ['Biryani',  'Egg / Veg Biryani',              'Pax',      700,  5,  'YES'],
  ['Mandhi',   'Chicken Mandhi (Quarter)',       'Packs',    900,  1,  'YES'],
  ['Mandhi',   'Chicken Mandhi (Half)',          'Packs',   1700,  1,  'YES'],
  ['Mandhi',   'Chicken Mandhi (Full)',          'Packs',   3200,  1,  'YES'],
  ['Mandhi',   'Mutton Mandhi Special',          'Packs',   2400,  1,  'YES'],
  ['Rice',     'Chicken Fried Rice',             'Portions', 750,  5,  'YES'],
  ['Rice',     'Seafood Mixed Fried Rice',       'Portions', 950,  5,  'YES'],
  ['Rice',     'Egg / Vegetable Fried Rice',     'Portions', 600,  5,  'YES'],
  ['Curry',    'Butter Chicken Gravy',           'Litres',  2200,  1,  'YES'],
  ['Curry',    'Chilli Chicken (Dry / Gravy)',   'Portions', 800,  5,  'YES'],
  ['Curry',    'Raita & Mint Chutney',           'Bowls',    350,  1,  'YES'],
  ['Dessert',  'Watalappam Party Pack',          'Cups',     250,  5,  'YES'],
  ['Dessert',  'Gulab Jamun (Catering Pack)',    'Pieces',    60, 10,  'YES']
];

// ==================== ONE-TIME SETUP ====================

/**
 * STEP 1 — Fill in the three values below, press Run once, then DELETE the
 * values again and save. They are stored in Script Properties, so nothing
 * secret ever lives in this file or gets pushed to GitHub.
 */
function setupProperties() {
  var values = {
    TELEGRAM_BOT_TOKEN: '',       // from @BotFather, e.g. 8123456789:AAF...
    TELEGRAM_OWNER_CHAT_ID: '',   // from @userinfobot, e.g. 987654321
    API_KEY: '',                  // any random word, e.g. mankada2026 (also goes in index.html)
    WEBHOOK_SECRET: '',           // any other random word, e.g. wh-7f3k9
    SPREADSHEET_ID: ''            // Optional: Google Sheet ID from URL if running as Standalone Script
  };

  var required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_CHAT_ID', 'API_KEY', 'WEBHOOK_SECRET'];
  var missing = [];
  required.forEach(function (k) {
    if (!values[k]) missing.push(k);
  });
  if (missing.length) {
    throw new Error('Fill in these values before running setupProperties(): ' + missing.join(', '));
  }

  PropertiesService.getScriptProperties().setProperties(values);
  initSheets();
  return 'Saved. Now clear the values above, save the file, deploy as a Web App, then run registerWebhook().';
}

/** STEP 2 — Creates the Menu / Orders / Customers / Log tabs. Safe to re-run. */
function initSheets() {
  ordersSheet_();
  customersSheet_();
  menuSheet_();
  settingsSheet_();
  return 'Sheets ready.';
}

/** STEP 3 — Run AFTER deploying as a Web App. Enables the Telegram buttons. */
function registerWebhook() {
  var url = ScriptApp.getService().getUrl();
  if (!url) throw new Error('Deploy this script as a Web App first (Deploy > New deployment > Web app).');

  var hookUrl = url + '?wh=' + encodeURIComponent(cfg_('WEBHOOK_SECRET'));
  var res = telegramApi_('setWebhook', {
    url: hookUrl,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true
  });
  return res;
}

/** Diagnostics: shows what Telegram currently thinks the webhook is. */
function getWebhookInfo() {
  return telegramApi_('getWebhookInfo', {});
}

/** Removes the webhook (useful when re-deploying to a new URL). */
function deleteWebhook() {
  return telegramApi_('deleteWebhook', { drop_pending_updates: true });
}

/**
 * STEP 4 (optional but recommended) — end-to-end check. Writes a throwaway
 * order due in 20 minutes, verifies it parses, sends you a real Telegram
 * dispatch alert, then deletes the row again.
 */
function runSelfTest() {
  var results = [];
  var sheet = ordersSheet_();

  var due = new Date(Date.now() + 20 * 60 * 1000);
  var dateStr = Utilities.formatDate(due, TZ, 'yyyy-MM-dd');
  var timeStr = Utilities.formatDate(due, TZ, 'HH:mm');

  var res = saveOrder_({
    itemsJson: [{ name: 'SELF TEST Biryani', unit: 'Pax', qty: 40, rate: 950 }],
    itemsSummary: 'SELF TEST Biryani: 40 Pax',
    deliveryDate: dateStr,
    deliveryTime: timeStr,
    customerName: 'Self_Test *Customer*',   // deliberately contains Markdown-breaking characters
    customerPhone: '077 123 4567',          // deliberately in local format
    deliveryAddress: '45 Galle Road, Dehiwala',
    prepStatus: 'Confirmed',
    totalAmount: 38000,
    advancePaid: 10000,
    specialNotes: 'Automated self-test — this row is deleted automatically.'
  });
  results.push('1. Order saved with id ' + res.orderId);

  var instant = parseDeliveryInstant_(dateStr, timeStr);
  if (!instant) throw new Error('FAILED: delivery date/time could not be parsed back out of the sheet.');
  results.push('2. Delivery time parsed as ' + Utilities.formatDate(instant, TZ, 'yyyy-MM-dd HH:mm'));

  results.push('3. Phone normalised to +' + normalizePhone_('077 123 4567'));

  var sent = checkDispatchAlerts();
  results.push('4. Dispatch alert run: ' + sent);

  var digest = buildPrepDigest_(dateStr);
  results.push('5. Digest for today renders ' + (digest ? 'OK' : 'EMPTY'));

  // Clean up the test row.
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][COL.ID] === res.orderId) { sheet.deleteRow(i + 1); break; }
  }
  results.push('6. Test row removed.');

  var summary = results.join('\n');
  Logger.log(summary);
  return summary;
}

// ==================== HTTP: GET ====================

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var action = p.action || 'health';

    if (action !== 'health') requireKey_(p.key);

    switch (action) {
      case 'health':   return json_(health_(p.key));
      case 'menu':     return json_({ status: 'ok', menu: readMenu_(), statusFlow: STATUS_FLOW, statusIcons: STATUS_ICON });
      case 'unpaid':   return json_({ status: 'ok', orders: readUnpaid_() });
      case 'orders':   return json_({ status: 'ok', orders: readOrders_(p.from, p.to, p.limit) });
      case 'customer': return json_({ status: 'ok', customer: findCustomer_(p.phone) });
      default:         return json_({ status: 'error', message: 'Unknown action: ' + action });
    }
  } catch (err) {
    logError_('doGet', err);
    return json_({ status: 'error', message: String(err.message || err) });
  }
}

function health_(key) {
  var out = { status: 'ok', timestamp: nowStr_(), timezone: TZ };
  try {
    requireKey_(key);
  } catch (e) {
    // Health check without a key still confirms the deployment is reachable.
    out.detail = 'Deployment is live. Pass &key=... to see order counts.';
    return out;
  }
  var rows = ordersSheet_().getDataRange().getValues().slice(1);
  var pending = rows.filter(function (r) {
    return !isClosed_(r[COL.STATUS]);
  });
  out.totalOrders = rows.length;
  out.pendingOrders = pending.length;
  out.menuItems = readMenu_().length;
  out.webhookConfigured = !!props_().getProperty('WEBHOOK_SECRET');
  return out;
}

// ==================== HTTP: POST ====================

function doPost(e) {
  try {
    var p = (e && e.parameter) || {};

    // --- Telegram webhook path: identified by the secret in the URL, since
    // Apps Script cannot read request headers. ---
    if (p.wh) {
      if (p.wh !== props_().getProperty('WEBHOOK_SECRET')) {
        return json_({ status: 'forbidden' });
      }
      var update = JSON.parse(e.postData.contents);
      if (update.callback_query) handleCallbackQuery_(update.callback_query);
      else if (update.message) handleBotMessage_(update.message);
      return json_({ status: 'ok' });
    }

    // --- Mini App path ---
    if (!e || !e.postData || !e.postData.contents) {
      return json_({ status: 'error', message: 'No data received' });
    }

    var body = JSON.parse(e.postData.contents);
    requireKey_(body.key);

    var action = body.action || (body.order ? 'newOrder' : '');
    switch (action) {
      case 'newOrder':    return json_(saveOrder_(body.order));
      case 'updateOrder': return json_(updateOrder_(body.orderId, body.order));
      case 'cancelOrder': return json_(setOrderStatus_(body.orderId, 'Cancelled'));
      case 'markDelivered': return json_(setOrderStatus_(body.orderId, 'Delivered'));
      case 'advanceStatus': return json_(advanceOrderStatus_(body.orderId));
      case 'setStatus':     return json_(setOrderStatus_(body.orderId, body.newStatus));
      case 'markPaid':      return json_(markOrderPaid_(body.orderId));
      default: return json_({ status: 'error', message: 'Unknown action: ' + action });
    }
  } catch (err) {
    logError_('doPost', err);
    return json_({ status: 'error', message: String(err.message || err) });
  }
}

// ==================== ORDERS ====================

function saveOrder_(order) {
  if (!order) throw new Error('Order payload missing.');
  if (!order.customerName || !order.customerPhone) throw new Error('Customer name and phone are required.');
  if (!order.deliveryDate || !order.deliveryTime) throw new Error('Delivery date and time are required.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = ordersSheet_();
    var orderId = makeOrderId_();
    var items = order.itemsJson || [];
    var total = num_(order.totalAmount);
    var advance = num_(order.advancePaid);

    var row = new Array(ORDER_HEADERS.length).fill('');
    row[COL.ID] = orderId;
    row[COL.CREATED] = nowStr_();
    row[COL.DATE] = String(order.deliveryDate);
    row[COL.TIME] = String(order.deliveryTime);
    row[COL.NAME] = order.customerName;
    row[COL.PHONE] = normalizePhone_(order.customerPhone);
    row[COL.ADDRESS] = order.deliveryAddress || '';
    row[COL.ITEMS] = order.itemsSummary || summariseItems_(items);
    row[COL.TOTAL] = total;
    row[COL.ADVANCE] = advance;
    row[COL.BALANCE] = total - advance;
    row[COL.STATUS] = order.prepStatus || 'Confirmed';
    row[COL.NOTES] = order.specialNotes || '';
    row[COL.DIGEST_SENT] = 'NO';
    row[COL.DISPATCH_SENT] = 'NO';
    row[COL.DELIVERED_AT] = '';
    row[COL.PAYMENT] = advance >= total && total > 0 ? 'Paid' : (advance > 0 ? 'Advance' : 'Unpaid');
    row[COL.UPDATED] = nowStr_();
    row[COL.ITEMS_JSON] = JSON.stringify(items);

    sheet.appendRow(row);

    upsertCustomer_(order.customerName, row[COL.PHONE], order.deliveryAddress);
    sendNewOrderAlert_(orderId, row);

    return { status: 'success', orderId: orderId };
  } finally {
    lock.releaseLock();
  }
}

function updateOrder_(orderId, order) {
  if (!orderId) throw new Error('orderId is required.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = ordersSheet_();
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][COL.ID] !== orderId) continue;

      var row = data[i];
      var timeChanged = false;

      if (order.deliveryDate && String(order.deliveryDate) !== toDateStr_(row[COL.DATE])) timeChanged = true;
      if (order.deliveryTime && String(order.deliveryTime) !== toTimeStr_(row[COL.TIME])) timeChanged = true;

      if (order.deliveryDate) row[COL.DATE] = String(order.deliveryDate);
      if (order.deliveryTime) row[COL.TIME] = String(order.deliveryTime);
      if (order.customerName) row[COL.NAME] = order.customerName;
      if (order.customerPhone) row[COL.PHONE] = normalizePhone_(order.customerPhone);
      if (order.deliveryAddress !== undefined) row[COL.ADDRESS] = order.deliveryAddress;
      if (order.specialNotes !== undefined) row[COL.NOTES] = order.specialNotes;
      if (order.prepStatus) row[COL.STATUS] = order.prepStatus;

      if (order.itemsJson) {
        row[COL.ITEMS_JSON] = JSON.stringify(order.itemsJson);
        row[COL.ITEMS] = order.itemsSummary || summariseItems_(order.itemsJson);
      }
      if (order.totalAmount !== undefined || order.advancePaid !== undefined) {
        var total = order.totalAmount !== undefined ? num_(order.totalAmount) : num_(row[COL.TOTAL]);
        var advance = order.advancePaid !== undefined ? num_(order.advancePaid) : num_(row[COL.ADVANCE]);
        row[COL.TOTAL] = total;
        row[COL.ADVANCE] = advance;
        row[COL.BALANCE] = total - advance;
        row[COL.PAYMENT] = advance >= total && total > 0 ? 'Paid' : (advance > 0 ? 'Advance' : 'Unpaid');
      }

      // Moving the delivery time re-arms the reminders for this order.
      if (timeChanged) {
        row[COL.DIGEST_SENT] = 'NO';
        row[COL.DISPATCH_SENT] = 'NO';
      }
      row[COL.UPDATED] = nowStr_();

      sheet.getRange(i + 1, 1, 1, ORDER_HEADERS.length).setValues([row]);
      return { status: 'success', orderId: orderId, remindersReset: timeChanged };
    }
    throw new Error('Order not found: ' + orderId);
  } finally {
    lock.releaseLock();
  }
}

function setOrderStatus_(orderId, status) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = ordersSheet_();
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][COL.ID] !== orderId) continue;
      sheet.getRange(i + 1, COL.STATUS + 1).setValue(status);
      sheet.getRange(i + 1, COL.UPDATED + 1).setValue(nowStr_());
      if (status === 'Delivered' && !data[i][COL.DELIVERED_AT]) {
        sheet.getRange(i + 1, COL.DELIVERED_AT + 1).setValue(nowStr_());
      }
      return { status: 'success', orderId: orderId, newStatus: status };
    }
    throw new Error('Order not found: ' + orderId);
  } finally {
    lock.releaseLock();
  }
}

/** Moves an order one step along the kitchen pipeline. */
function advanceOrderStatus_(orderId) {
  var current = orderStatus_(orderId);
  var next = nextStatus_(current);
  if (!next) throw new Error('Order is already ' + current + '.');
  var res = setOrderStatus_(orderId, next);
  res.previousStatus = current;
  return res;
}

function nextStatus_(current) {
  // A tentative enquiry has to be confirmed before it can enter the flow.
  if (current === 'Tentative') return 'Confirmed';
  var i = STATUS_FLOW.indexOf(current);
  return (i === -1 || i === STATUS_FLOW.length - 1) ? null : STATUS_FLOW[i + 1];
}

function isClosed_(status) {
  return status === 'Delivered' || status === 'Cancelled';
}

function orderStatus_(orderId) {
  var data = ordersSheet_().getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][COL.ID] === orderId) return data[i][COL.STATUS];
  }
  throw new Error('Order not found: ' + orderId);
}

/** Records the balance as settled. Used from the app and from Telegram. */
function markOrderPaid_(orderId) {
  var sheet = ordersSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][COL.ID] !== orderId) continue;
    var total = num_(data[i][COL.TOTAL]);
    sheet.getRange(i + 1, COL.ADVANCE + 1).setValue(total);
    sheet.getRange(i + 1, COL.BALANCE + 1).setValue(0);
    sheet.getRange(i + 1, COL.PAYMENT + 1).setValue('Paid');
    sheet.getRange(i + 1, COL.PAID_AT + 1).setValue(nowStr_());
    sheet.getRange(i + 1, COL.UPDATED + 1).setValue(nowStr_());
    return { status: 'success', orderId: orderId, collected: total - num_(data[i][COL.ADVANCE]) };
  }
  throw new Error('Order not found: ' + orderId);
}

/** Orders between two yyyy-MM-dd dates (inclusive). Defaults to today .. +30 days. */
function readOrders_(from, to, limit) {
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  from = from || today;
  to = to || Utilities.formatDate(new Date(Date.now() + 30 * 864e5), TZ, 'yyyy-MM-dd');

  var data = ordersSheet_().getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    var d = toDateStr_(r[COL.DATE]);
    if (!d || d < from || d > to) continue;
    out.push(rowToOrder_(r));
  }
  out.sort(function (a, b) {
    return (a.deliveryDate + a.deliveryTime).localeCompare(b.deliveryDate + b.deliveryTime);
  });
  if (limit) out = out.slice(0, Number(limit));
  return out;
}

/** Every order with money still outstanding, biggest debt first. */
function readUnpaid_() {
  var data = ordersSheet_().getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (r[COL.STATUS] === 'Cancelled') continue;
    if (num_(r[COL.BALANCE]) <= 0) continue;
    out.push(rowToOrder_(r));
  }
  out.sort(function (a, b) { return b.balanceDue - a.balanceDue; });
  return out;
}

function rowToOrder_(r) {
  var items = [];
  try { items = r[COL.ITEMS_JSON] ? JSON.parse(r[COL.ITEMS_JSON]) : []; } catch (e) { items = []; }
  return {
    orderId: r[COL.ID],
    deliveryDate: toDateStr_(r[COL.DATE]),
    deliveryTime: toTimeStr_(r[COL.TIME]),
    customerName: r[COL.NAME],
    customerPhone: String(r[COL.PHONE]).replace(/^'/, ''),
    deliveryAddress: r[COL.ADDRESS],
    itemsSummary: r[COL.ITEMS],
    itemsJson: items,
    totalAmount: num_(r[COL.TOTAL]),
    advancePaid: num_(r[COL.ADVANCE]),
    balanceDue: num_(r[COL.BALANCE]),
    status: r[COL.STATUS],
    paymentStatus: r[COL.PAYMENT],
    specialNotes: r[COL.NOTES]
  };
}

// ==================== CUSTOMERS ====================

function upsertCustomer_(name, phone, address) {
  var sheet = customersSheet_();
  var key = normalizePhone_(phone);
  var data = sheet.getDataRange().getValues();
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');

  for (var i = 1; i < data.length; i++) {
    if (normalizePhone_(data[i][0]) !== key) continue;
    sheet.getRange(i + 1, 4).setValue((Number(data[i][3]) || 0) + 1);
    sheet.getRange(i + 1, 6).setValue(today);
    if (address) sheet.getRange(i + 1, 3).setValue(address);
    if (name) sheet.getRange(i + 1, 2).setValue(name);
    return;
  }
  sheet.appendRow([key, name, address || '', 1, today, today]);
}

function findCustomer_(phone) {
  if (!phone) return null;
  var key = normalizePhone_(phone);
  if (key.length < 6) return null;
  var data = customersSheet_().getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (normalizePhone_(data[i][0]) === key) {
      return {
        phone: String(data[i][0]),
        name: data[i][1],
        address: data[i][2],
        totalOrders: Number(data[i][3]) || 0,
        lastOrderDate: toDateStr_(data[i][5])
      };
    }
  }
  return null;
}

// ==================== MENU ====================

function readMenu_() {
  var data = menuSheet_().getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[1]) continue;
    if (String(r[5]).toUpperCase() === 'NO') continue;
    out.push({
      id: 'm' + i,
      category: String(r[0] || 'Other'),
      name: String(r[1]),
      unit: String(r[2] || 'Portions'),
      rate: num_(r[3]),
      step: Number(r[4]) || 1
    });
  }
  return out;
}

// ==================== REMINDERS ====================

/**
 * Runs every 15 minutes. Sends ONE urgent alert per order roughly 3 hours
 * before delivery — the cooking / packing / dispatch window.
 */
function checkDispatchAlerts() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return 'skipped (another run in progress)';

  try {
    var sheet = ordersSheet_();
    var data = sheet.getDataRange().getValues();
    var now = Date.now();
    var lead = Number(getSetting_('dispatch_lead_minutes', 180)) || 180;
    var sent = 0;
    var flags = [];

    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      if (isClosed_(r[COL.STATUS])) continue;
      if (String(r[COL.DISPATCH_SENT]).toUpperCase() === 'YES') continue;

      var instant = parseDeliveryInstant_(toDateStr_(r[COL.DATE]), toTimeStr_(r[COL.TIME]));
      if (!instant) {
        logError_('checkDispatchAlerts', new Error('Unparseable delivery time on row ' + (i + 1)));
        continue;
      }

      var diffMin = (instant.getTime() - now) / 60000;
      // Fire inside the configured lead window; the lower bound also catches
      // orders booked at short notice, which otherwise get no alert at all.
      if (diffMin > lead + 5 || diffMin < -120) continue;

      sendDispatchAlert_(r, diffMin);
      flags.push(i + 1);
      sent++;
    }

    flags.forEach(function (rowNum) {
      sheet.getRange(rowNum, COL.DISPATCH_SENT + 1).setValue('YES');
    });

    return sent + ' dispatch alert(s) sent';
  } finally {
    lock.releaseLock();
  }
}

/**
 * Runs once daily (evening). Sends ONE message covering everything due
 * tomorrow, with quantities added up across orders so the shopping list is
 * a single number per dish.
 */
function sendDailyPrepDigest() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return 'skipped';

  try {
    var tomorrow = Utilities.formatDate(new Date(Date.now() + 864e5), TZ, 'yyyy-MM-dd');
    var digest = buildPrepDigest_(tomorrow);

    if (!digest) {
      sendTelegram_(ownerChat_(), '😴 <b>No orders scheduled for tomorrow</b> (' + esc_(prettyDate_(tomorrow)) + ').\n\nRest well — the reminder system is running normally.');
      return 'no orders';
    }

    sendTelegram_(ownerChat_(), digest.message, {
      inline_keyboard: [[{ text: '📋 Re-send this list', callback_data: 'list_tomorrow' }]]
    });

    var sheet = ordersSheet_();
    digest.rowNumbers.forEach(function (rowNum) {
      sheet.getRange(rowNum, COL.DIGEST_SENT + 1).setValue('YES');
    });

    return 'digest sent for ' + digest.rowNumbers.length + ' order(s)';
  } finally {
    lock.releaseLock();
  }
}

/** Builds the aggregated prep message for one date. Returns null when empty. */
function buildPrepDigest_(dateStr) {
  var data = ordersSheet_().getDataRange().getValues();
  var orders = [];
  var rowNumbers = [];

  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (isClosed_(r[COL.STATUS])) continue;
    if (toDateStr_(r[COL.DATE]) !== dateStr) continue;
    orders.push(r);
    rowNumbers.push(i + 1);
  }
  if (!orders.length) return null;

  orders.sort(function (a, b) { return toTimeStr_(a[COL.TIME]).localeCompare(toTimeStr_(b[COL.TIME])); });

  // Aggregate identical dishes across every order for the shopping list.
  var totals = {};
  var moneyDue = 0;
  orders.forEach(function (r) {
    moneyDue += num_(r[COL.BALANCE]);
    var items = [];
    try { items = r[COL.ITEMS_JSON] ? JSON.parse(r[COL.ITEMS_JSON]) : []; } catch (e) { items = []; }
    items.forEach(function (it) {
      var key = it.name + '||' + (it.unit || '');
      if (!totals[key]) totals[key] = { name: it.name, unit: it.unit || '', qty: 0, orders: 0 };
      totals[key].qty += Number(it.qty) || 0;
      totals[key].orders++;
    });
  });

  var msg = '🧾 <b>PREP LIST FOR TOMORROW</b>\n';
  msg += esc_(prettyDate_(dateStr)) + ' — ' + orders.length + ' order' + (orders.length === 1 ? '' : 's') + '\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━\n';

  var keys = Object.keys(totals);
  if (keys.length) {
    msg += '<b>🛒 TOTAL TO COOK</b>\n';
    keys.sort().forEach(function (k) {
      var t = totals[k];
      msg += '• <b>' + esc_(t.name) + '</b> — ' + t.qty + ' ' + esc_(t.unit);
      if (t.orders > 1) msg += ' <i>(' + t.orders + ' orders)</i>';
      msg += '\n';
    });
    msg += '━━━━━━━━━━━━━━━━━━━━━\n';
  }

  msg += '<b>📦 DELIVERIES</b>\n';
  orders.forEach(function (r) {
    msg += '\n<b>' + esc_(toTimeStr_(r[COL.TIME])) + '</b> — ' + esc_(r[COL.NAME]) + '\n';
    msg += '   ' + esc_(r[COL.ITEMS]) + '\n';
    if (r[COL.ADDRESS]) msg += '   📍 ' + esc_(r[COL.ADDRESS]) + '\n';
    if (num_(r[COL.BALANCE]) > 0) msg += '   💰 Balance ' + CURRENCY + ' ' + fmtMoney_(r[COL.BALANCE]) + '\n';
    if (r[COL.NOTES]) msg += '   📝 <i>' + esc_(r[COL.NOTES]) + '</i>\n';
  });

  if (moneyDue > 0) {
    msg += '━━━━━━━━━━━━━━━━━━━━━\n';
    msg += '💰 <b>Total to collect tomorrow: ' + CURRENCY + ' ' + fmtMoney_(moneyDue) + '</b>';
  }

  return { message: msg, rowNumbers: rowNumbers, orderCount: orders.length };
}

// ==================== MONEY: CHASING UNPAID BALANCES ====================

/**
 * Runs once daily. Finds orders delivered at least `payment_chase_days` ago
 * that still have money outstanding, and sends ONE message listing them with a
 * WhatsApp button per customer. Each order is only ever chased once, so this
 * cannot turn into a daily nag.
 */
function checkUnpaidBalances() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return 'skipped';

  try {
    var chaseDays = Number(getSetting_('payment_chase_days', 3));
    if (!chaseDays) return 'payment chasing is switched off';

    var sheet = ordersSheet_();
    var data = sheet.getDataRange().getValues();
    var cutoff = Date.now() - chaseDays * 864e5;
    var owing = [];
    var rowNumbers = [];
    var total = 0;

    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      if (r[COL.STATUS] !== 'Delivered') continue;
      if (num_(r[COL.BALANCE]) <= 0) continue;
      if (String(r[COL.CHASE_SENT]).toUpperCase() === 'YES') continue;

      // The debt is counted from the delivery slot, not from when he tapped
      // "Delivered" — tapping late should not delay the chase.
      var when = parseDeliveryInstant_(toDateStr_(r[COL.DATE]), toTimeStr_(r[COL.TIME]) || '12:00');
      if (!when || when.getTime() > cutoff) continue;

      owing.push(r);
      rowNumbers.push(i + 1);
      total += num_(r[COL.BALANCE]);
    }

    if (!owing.length) return 'nothing to chase';

    var msg = '💰 <b>MONEY STILL OWED</b>\n';
    msg += owing.length + ' delivered order' + (owing.length === 1 ? '' : 's') +
           ' unpaid after ' + chaseDays + ' day' + (chaseDays === 1 ? '' : 's') + '\n';
    msg += '━━━━━━━━━━━━━━━━━━━━━\n';

    var keyboard = [];
    owing.forEach(function (r) {
      msg += '\n<b>' + CURRENCY + ' ' + fmtMoney_(r[COL.BALANCE]) + '</b> — ' + esc_(r[COL.NAME]) + '\n';
      msg += '   ' + esc_(prettyDate_(r[COL.DATE])) + ' · ' + esc_(r[COL.ITEMS]) + '\n';
      keyboard.push([
        { text: '💬 ' + String(r[COL.NAME]).substring(0, 18), url: 'https://wa.me/' + r[COL.PHONE] },
        { text: '💵 Paid', callback_data: 'paid_' + r[COL.ID] }
      ]);
    });

    msg += '━━━━━━━━━━━━━━━━━━━━━\n';
    msg += '<b>Total outstanding: ' + CURRENCY + ' ' + fmtMoney_(total) + '</b>';

    sendTelegram_(ownerChat_(), msg, { inline_keyboard: keyboard });

    rowNumbers.forEach(function (rowNum) {
      sheet.getRange(rowNum, COL.CHASE_SENT + 1).setValue('YES');
    });

    return 'chased ' + owing.length + ' order(s), ' + CURRENCY + ' ' + fmtMoney_(total);
  } finally {
    lock.releaseLock();
  }
}

/** Everything currently owed, whether or not it has been chased yet. */
function sendMoneyList_() {
  var data = ordersSheet_().getDataRange().getValues();
  var owing = [];
  var total = 0;

  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (r[COL.STATUS] === 'Cancelled') continue;
    if (num_(r[COL.BALANCE]) <= 0) continue;
    owing.push(r);
    total += num_(r[COL.BALANCE]);
  }

  if (!owing.length) {
    sendTelegram_(ownerChat_(), '✅ <b>Nothing outstanding.</b> Every order is paid up.');
    return;
  }

  owing.sort(function (a, b) { return num_(b[COL.BALANCE]) - num_(a[COL.BALANCE]); });

  var msg = '💰 <b>OUTSTANDING BALANCES</b>\n━━━━━━━━━━━━━━━━━━━━━\n';
  var keyboard = [];
  owing.forEach(function (r) {
    msg += '\n<b>' + CURRENCY + ' ' + fmtMoney_(r[COL.BALANCE]) + '</b> — ' + esc_(r[COL.NAME]);
    msg += '  <i>' + esc_(r[COL.STATUS]) + '</i>\n';
    msg += '   ' + esc_(prettyDate_(r[COL.DATE])) + '\n';
    keyboard.push([
      { text: '💬 ' + String(r[COL.NAME]).substring(0, 18), url: 'https://wa.me/' + r[COL.PHONE] },
      { text: '💵 Paid', callback_data: 'paid_' + r[COL.ID] }
    ]);
  });
  msg += '━━━━━━━━━━━━━━━━━━━━━\n<b>Total: ' + CURRENCY + ' ' + fmtMoney_(total) + '</b>';

  sendTelegram_(ownerChat_(), msg, { inline_keyboard: keyboard.slice(0, 20) });
}

// ==================== WEEKLY BACKUP ====================

/**
 * Runs once a week. Writes every sheet out as CSV into a Drive folder and
 * emails the lot as attachments, so the business is not one lost Google
 * account away from losing its entire order history.
 */
function weeklyBackup() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return 'skipped';

  try {
    var name = getSetting_('business_name', 'Catering Orders');
    var stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
    var folder = backupFolder_();
    var attachments = [];

    [SHEETS.ORDERS, SHEETS.CUSTOMERS, SHEETS.MENU].forEach(function (tab) {
      var sheet = ss_().getSheetByName(tab);
      if (!sheet) return;
      var csv = toCsv_(sheet.getDataRange().getValues());
      var file = folder.createFile(tab + '-' + stamp + '.csv', csv, MimeType.CSV);
      attachments.push({ fileName: tab + '-' + stamp + '.csv', content: csv, mimeType: 'text/csv' });
    });

    if (!attachments.length) return 'nothing to back up';

    var rows = Math.max(0, ordersSheet_().getDataRange().getValues().length - 1);
    var to = getSetting_('backup_email', '') || Session.getEffectiveUser().getEmail();

    MailApp.sendEmail({
      to: to,
      subject: name + ' — backup ' + stamp,
      body: 'Weekly backup of ' + name + '.\n\n' +
            rows + ' orders on record.\n\n' +
            'The same files are in your Google Drive under "' + folder.getName() + '".\n' +
            'Keep this email — it is a complete copy you can open in any spreadsheet app.',
      attachments: attachments
    });

    pruneBackups_(folder);
    return 'backup emailed to ' + to + ' (' + rows + ' orders)';
  } catch (err) {
    logError_('weeklyBackup', err);
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function backupFolder_() {
  var name = 'Catering Backups';
  var found = DriveApp.getFoldersByName(name);
  return found.hasNext() ? found.next() : DriveApp.createFolder(name);
}

/** Keeps the folder from growing without limit. */
function pruneBackups_(folder) {
  var keepWeeks = Number(getSetting_('backup_keep_weeks', 8)) || 8;
  var byTab = {};

  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    var tab = f.getName().split('-')[0];
    (byTab[tab] = byTab[tab] || []).push(f);
  }

  Object.keys(byTab).forEach(function (tab) {
    var list = byTab[tab];
    list.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
    list.slice(keepWeeks).forEach(function (f) { f.setTrashed(true); });
  });
}

function toCsv_(rows) {
  return rows.map(function (row) {
    return row.map(function (cell) {
      var v = cell instanceof Date ? Utilities.formatDate(cell, TZ, 'yyyy-MM-dd HH:mm:ss') : String(cell == null ? '' : cell);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(',');
  }).join('\n');
}

// ==================== TELEGRAM MESSAGES ====================

function sendNewOrderAlert_(orderId, row) {
  var phone = String(row[COL.PHONE]);
  var msg = '🎉 <b>NEW ORDER BOOKED</b>\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━\n';
  msg += '🆔 <code>' + esc_(orderId) + '</code>\n';
  msg += '📅 <b>' + esc_(prettyDate_(row[COL.DATE])) + '</b> at <b>' + esc_(row[COL.TIME]) + '</b>\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━\n';
  msg += '👤 ' + esc_(row[COL.NAME]) + '\n';
  msg += '📞 +' + esc_(phone) + '\n';
  if (row[COL.ADDRESS]) msg += '📍 ' + esc_(row[COL.ADDRESS]) + '\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━\n';
  msg += '<b>🍛 ITEMS</b>\n' + itemLines_(row) + '\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━\n';
  msg += '💵 Total ' + CURRENCY + ' ' + fmtMoney_(row[COL.TOTAL]) + '  |  Advance ' + CURRENCY + ' ' + fmtMoney_(row[COL.ADVANCE]) + '\n';
  msg += '⚠️ <b>Balance due ' + CURRENCY + ' ' + fmtMoney_(row[COL.BALANCE]) + '</b>\n';
  if (row[COL.NOTES]) msg += '📝 <i>' + esc_(row[COL.NOTES]) + '</i>\n';

  sendTelegram_(ownerChat_(), msg, contactKeyboard_(orderId, phone, row[COL.ADDRESS], row[COL.STATUS], row[COL.BALANCE]));
}

function sendDispatchAlert_(row, diffMin) {
  var phone = String(row[COL.PHONE]);
  var mins = Math.round(diffMin);
  var when = mins <= 0
    ? 'due <b>NOW</b>'
    : 'due in <b>' + (mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + ' minutes') + '</b>';

  var msg = '🚨 <b>COOK &amp; DISPATCH NOW</b>\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━\n';
  msg += 'Order <code>' + esc_(row[COL.ID]) + '</code> is ' + when + ' (' + esc_(toTimeStr_(row[COL.TIME])) + ').\n\n';
  msg += '👤 ' + esc_(row[COL.NAME]) + ' — +' + esc_(phone) + '\n';
  msg += '<b>🍛 ITEMS</b>\n' + itemLines_(row) + '\n';
  if (row[COL.ADDRESS]) msg += '📍 ' + esc_(row[COL.ADDRESS]) + '\n';
  if (num_(row[COL.BALANCE]) > 0) msg += '\n💰 <b>Collect ' + CURRENCY + ' ' + fmtMoney_(row[COL.BALANCE]) + ' on delivery</b>\n';
  if (row[COL.NOTES]) msg += '📝 <i>' + esc_(row[COL.NOTES]) + '</i>\n';

  sendTelegram_(ownerChat_(), msg, contactKeyboard_(row[COL.ID], phone, row[COL.ADDRESS], row[COL.STATUS], row[COL.BALANCE]));
}

function contactKeyboard_(orderId, phone, address, status, balance) {
  var rows = [[
    { text: '📞 Call', url: 'tel:+' + phone },
    { text: '💬 WhatsApp', url: 'https://wa.me/' + phone }
  ]];
  if (address) {
    rows.push([{ text: '🗺 Open in Maps', url: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address) }]);
  }

  // One button that moves the order to whatever comes next, so there is never
  // a list to choose from mid-service.
  var action = STATUS_ACTION[status];
  if (action) rows.push([{ text: action, callback_data: 'adv_' + orderId }]);
  else if (!status || !isClosed_(status)) rows.push([{ text: '📦 Mark delivered', callback_data: 'deliver_' + orderId }]);

  if (num_(balance) > 0) {
    rows.push([{ text: '💵 Balance ' + CURRENCY + ' ' + fmtMoney_(balance) + ' received', callback_data: 'paid_' + orderId }]);
  }
  return { inline_keyboard: rows };
}

function itemLines_(row) {
  var items = [];
  try { items = row[COL.ITEMS_JSON] ? JSON.parse(row[COL.ITEMS_JSON]) : []; } catch (e) { items = []; }
  if (items.length) {
    return items.map(function (it) {
      return '• ' + esc_(it.name) + ' — <b>' + (Number(it.qty) || 0) + ' ' + esc_(it.unit || '') + '</b>';
    }).join('\n');
  }
  return String(row[COL.ITEMS] || '').split(';').map(function (s) {
    return '• ' + esc_(s.trim());
  }).join('\n');
}

// ==================== TELEGRAM CALLBACKS & COMMANDS ====================

function handleCallbackQuery_(query) {
  var data = query.data || '';
  var answer = 'Done';

  try {
    if (data.indexOf('deliver_') === 0) {
      var orderId = data.substring('deliver_'.length);
      setOrderStatus_(orderId, 'Delivered');
      answer = 'Order ' + orderId + ' marked delivered 🎉';
      stampMessage_(query, '📦 DELIVERED');

    } else if (data.indexOf('adv_') === 0) {
      var advId = data.substring('adv_'.length);
      var moved = advanceOrderStatus_(advId);
      answer = (STATUS_ICON[moved.newStatus] || '') + ' Now: ' + moved.newStatus;
      stampMessage_(query, (STATUS_ICON[moved.newStatus] || '') + ' ' + moved.newStatus.toUpperCase());

      // Keep the pipeline moving without making him reopen the app.
      var nextLabel = STATUS_ACTION[moved.newStatus];
      if (nextLabel && query.message) {
        telegramApi_('editMessageReplyMarkup', {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard: [[{ text: nextLabel, callback_data: 'adv_' + advId }]] }
        });
      }

    } else if (data.indexOf('paid_') === 0) {
      var paidId = data.substring('paid_'.length);
      var paid = markOrderPaid_(paidId);
      answer = 'Recorded ' + CURRENCY + ' ' + fmtMoney_(paid.collected) + ' received 💵';
      stampMessage_(query, '💵 PAID IN FULL');

    } else if (data === 'list_tomorrow') {
      sendDayList_(Utilities.formatDate(new Date(Date.now() + 864e5), TZ, 'yyyy-MM-dd'), 'Tomorrow');
      answer = 'Sent';
    }
  } catch (err) {
    logError_('handleCallbackQuery', err);
    answer = 'Error: ' + err.message;
  }

  telegramApi_('answerCallbackQuery', { callback_query_id: query.id, text: answer, show_alert: false });
}

/** Appends an outcome line to the message a button was pressed on, so the
 *  chat history never contradicts the sheet. */
function stampMessage_(query, label) {
  if (!query.message) return;
  telegramApi_('editMessageText', {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    text: (query.message.text || '') + '\n\n' + label + ' — ' + nowStr_(),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
}

function handleBotMessage_(message) {
  var text = String(message.text || '').trim().toLowerCase();
  var chatId = message.chat.id;

  // Only the owner may drive the bot.
  if (String(chatId) !== String(ownerChat_())) {
    sendTelegram_(chatId, 'This bot is private.');
    return;
  }

  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var tomorrow = Utilities.formatDate(new Date(Date.now() + 864e5), TZ, 'yyyy-MM-dd');

  if (text === '/today') return sendDayList_(today, 'Today');
  if (text === '/tomorrow') return sendDayList_(tomorrow, 'Tomorrow');
  if (text === '/pending') return sendPendingList_();
  if (text === '/money') return sendMoneyList_();

  sendTelegram_(chatId,
    '👋 <b>Catering assistant</b>\n\n' +
    'Tap the <b>📋 New Order</b> button below to book an order.\n\n' +
    'Or send:\n' +
    '/today — today’s deliveries\n' +
    '/tomorrow — tomorrow’s deliveries\n' +
    '/pending — everything still to deliver\n' +
    '/money — who still owes you');
}

function sendDayList_(dateStr, label) {
  var orders = readOrders_(dateStr, dateStr).filter(function (o) { return o.status !== 'Cancelled'; });
  if (!orders.length) {
    sendTelegram_(ownerChat_(), '📭 No orders for ' + esc_(label.toLowerCase()) + ' (' + esc_(prettyDate_(dateStr)) + ').');
    return;
  }
  var msg = '📅 <b>' + esc_(label.toUpperCase()) + '</b> — ' + esc_(prettyDate_(dateStr)) + '\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━\n';
  orders.forEach(function (o) {
    msg += '\n<b>' + esc_(o.deliveryTime) + '</b> — ' + esc_(o.customerName);
    msg += ' ' + (STATUS_ICON[o.status] || '');
    msg += '\n   ' + esc_(o.itemsSummary) + '\n';
    if (o.balanceDue > 0) msg += '   💰 ' + CURRENCY + ' ' + fmtMoney_(o.balanceDue) + ' to collect\n';
  });
  sendTelegram_(ownerChat_(), msg);
}

function sendPendingList_() {
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var orders = readOrders_(today, null).filter(function (o) {
    return !isClosed_(o.status);
  });
  if (!orders.length) {
    sendTelegram_(ownerChat_(), '✅ Nothing pending. All caught up!');
    return;
  }
  var msg = '⏳ <b>PENDING ORDERS</b> (' + orders.length + ')\n━━━━━━━━━━━━━━━━━━━━━\n';
  orders.forEach(function (o) {
    msg += '\n<b>' + esc_(prettyDate_(o.deliveryDate)) + ' ' + esc_(o.deliveryTime) + '</b>\n';
    msg += '   ' + esc_(o.customerName) + ' — ' + esc_(o.itemsSummary) + '\n';
  });
  sendTelegram_(ownerChat_(), msg);
}

// ==================== TELEGRAM TRANSPORT ====================

/**
 * Sends an HTML message. Every interpolated value must already be escaped by
 * esc_(). If Telegram still rejects the HTML we retry once as plain text so a
 * formatting problem can never swallow an order notification.
 */
function sendTelegram_(chatId, html, replyMarkup) {
  var payload = {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  var res = telegramApi_('sendMessage', payload);
  if (res && res.ok === false) {
    logError_('sendTelegram', new Error('HTML send failed: ' + (res.description || '')));
    telegramApi_('sendMessage', {
      chat_id: chatId,
      text: html.replace(/<[^>]+>/g, ''),
      disable_web_page_preview: true
    });
  }
  return res;
}

function telegramApi_(method, payload) {
  var url = 'https://api.telegram.org/bot' + cfg_('TELEGRAM_BOT_TOKEN') + '/' + method;
  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var body = response.getContentText();
    var parsed = JSON.parse(body);
    if (!parsed.ok) logError_('telegram:' + method, new Error(body));
    return parsed;
  } catch (err) {
    logError_('telegram:' + method, err);
    return { ok: false, description: String(err) };
  }
}

// ==================== SHEET ACCESS ====================

function ss_() {
  var id = props_().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function ordersSheet_() {
  var sheet = ss_().getSheetByName(SHEETS.ORDERS);
  if (!sheet) {
    sheet = ss_().insertSheet(SHEETS.ORDERS);
    sheet.appendRow(ORDER_HEADERS);
    sheet.getRange(1, 1, 1, ORDER_HEADERS.length).setFontWeight('bold').setBackground('#e2e8f0');
    sheet.setFrozenRows(1);
  }
  // Date and time are kept as PLAIN TEXT. Letting Sheets coerce them into date
  // values is what silently broke every reminder in the first version.
  sheet.getRange(1, COL.DATE + 1, sheet.getMaxRows(), 2).setNumberFormat('@');
  sheet.getRange(1, COL.PHONE + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  return sheet;
}

function customersSheet_() {
  var sheet = ss_().getSheetByName(SHEETS.CUSTOMERS);
  if (!sheet) {
    sheet = ss_().insertSheet(SHEETS.CUSTOMERS);
    sheet.appendRow(CUSTOMER_HEADERS);
    sheet.getRange(1, 1, 1, CUSTOMER_HEADERS.length).setFontWeight('bold').setBackground('#e2e8f0');
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  }
  return sheet;
}

function menuSheet_() {
  var sheet = ss_().getSheetByName(SHEETS.MENU);
  if (!sheet) {
    sheet = ss_().insertSheet(SHEETS.MENU, 0);
    sheet.appendRow(MENU_HEADERS);
    sheet.getRange(1, 1, 1, MENU_HEADERS.length).setFontWeight('bold').setBackground('#fde68a');
    sheet.getRange(2, 1, DEFAULT_MENU.length, MENU_HEADERS.length).setValues(DEFAULT_MENU);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(2, 260);
  }
  return sheet;
}

function settingsSheet_() {
  var sheet = ss_().getSheetByName(SHEETS.SETTINGS);
  if (!sheet) {
    sheet = ss_().insertSheet(SHEETS.SETTINGS);
    sheet.appendRow(SETTINGS_HEADERS);
    sheet.getRange(1, 1, 1, SETTINGS_HEADERS.length).setFontWeight('bold').setBackground('#bfdbfe');
    sheet.getRange(2, 1, DEFAULT_SETTINGS.length, SETTINGS_HEADERS.length).setValues(DEFAULT_SETTINGS);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 200);
    sheet.setColumnWidth(3, 420);
  }
  return sheet;
}

/**
 * Reads one row from the Settings tab. Cached for a few minutes so a busy
 * reminder run does not re-read the sheet for every order.
 */
function getSetting_(key, fallback) {
  if (!SETTINGS_CACHE) {
    SETTINGS_CACHE = {};
    try {
      var data = settingsSheet_().getDataRange().getValues();
      for (var i = 1; i < data.length; i++) {
        if (data[i][0]) SETTINGS_CACHE[String(data[i][0]).trim()] = data[i][1];
      }
    } catch (e) {
      logError_('getSetting_', e);
    }
  }
  var v = SETTINGS_CACHE[key];
  return (v === undefined || v === '') ? fallback : v;
}

var SETTINGS_CACHE = null;

function logSheet_() {
  var sheet = ss_().getSheetByName(SHEETS.LOG);
  if (!sheet) {
    sheet = ss_().insertSheet(SHEETS.LOG);
    sheet.appendRow(['Time', 'Where', 'Error']);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#fecaca');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function logError_(where, err) {
  Logger.log(where + ': ' + err);
  try {
    logSheet_().appendRow([nowStr_(), where, String(err && err.stack ? err.stack : err)]);
  } catch (e) { /* logging must never break the request */ }
}

// ==================== HELPERS ====================

function props_() { return PropertiesService.getScriptProperties(); }

function cfg_(key) {
  var v = props_().getProperty(key);
  if (!v) throw new Error('Missing script property "' + key + '". Run setupProperties() first.');
  return v;
}

function ownerChat_() { return cfg_('TELEGRAM_OWNER_CHAT_ID'); }

function requireKey_(key) {
  if (String(key || '') !== cfg_('API_KEY')) throw new Error('Unauthorised: bad or missing key.');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function makeOrderId_() {
  var stamp = Utilities.formatDate(new Date(), TZ, 'yyMMdd-HHmmss');
  var rand = Math.random().toString(36).substring(2, 5).toUpperCase();
  return 'ORD-' + stamp + '-' + rand;
}

function nowStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }

/** Accepts a Date cell or a string and always returns yyyy-MM-dd. */
function toDateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, ss_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  var s = String(v == null ? '' : v).trim();
  var m = s.match(/^\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  if (!s) return '';
  var d = new Date(s);
  return isNaN(d.getTime()) ? '' : Utilities.formatDate(d, ss_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

/** Accepts a Date cell or a string and always returns HH:mm. */
function toTimeStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, ss_().getSpreadsheetTimeZone(), 'HH:mm');
  var s = String(v == null ? '' : v).trim();
  var m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : '';
}

/** Builds the true UTC instant for a local yyyy-MM-dd + HH:mm in TZ. */
function parseDeliveryInstant_(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  var asUtc = new Date(dateStr + 'T' + timeStr + ':00Z').getTime();
  if (isNaN(asUtc)) return null;
  var offset = Utilities.formatDate(new Date(asUtc), TZ, 'Z'); // e.g. +0530
  var sign = offset.charAt(0) === '-' ? -1 : 1;
  var minutes = sign * (parseInt(offset.substr(1, 2), 10) * 60 + parseInt(offset.substr(3, 2), 10));
  return new Date(asUtc - minutes * 60000);
}

function prettyDate_(v) {
  var s = toDateStr_(v);
  if (!s) return String(v);
  var d = new Date(s + 'T12:00:00Z');
  return Utilities.formatDate(d, 'UTC', 'EEE, dd MMM yyyy');
}

/**
 * Strips punctuation, drops a local leading 0, and adds the country code so
 * "077 123 4567", "+94771234567" and "94771234567" all become one key —
 * which is also what wa.me/ requires.
 */
function normalizePhone_(raw) {
  var digits = String(raw == null ? '' : raw).replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.indexOf('00') === 0) digits = digits.substring(2);
  if (digits.charAt(0) === '0') digits = COUNTRY_CODE + digits.substring(1);
  else if (digits.indexOf(COUNTRY_CODE) !== 0 && digits.length <= 9) digits = COUNTRY_CODE + digits;
  return digits;
}

function summariseItems_(items) {
  return (items || []).map(function (it) {
    return it.name + ': ' + it.qty + ' ' + (it.unit || '');
  }).join('; ');
}

function num_(v) {
  var n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function fmtMoney_(v) {
  var n = num_(v);
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Escapes the five characters that can break Telegram HTML parse mode. */
function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
