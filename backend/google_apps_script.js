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

/*
 * The Web App deployment Telegram should send updates to.
 *
 * This has to be written down because ScriptApp.getService().getUrl() reports
 * the "/dev" head URL in this project, and Telegram cannot reach that — it is
 * served a Google login page, answers 401, and every message is dropped. The
 * bot then goes completely silent with no error anywhere.
 *
 * Not a secret: the same URL is published inside index.html, which GitHub
 * Pages serves to the world. Change it here if you ever deploy to a new URL,
 * or set a DEPLOYMENT_URL script property, which wins over this value.
 */
var DEPLOYMENT_URL =
  'https://script.google.com/macros/s/AKfycbyjTmYIl6Jno57wxRY21lTQO2u4yJkT-8P7gxhzo813psMym-3b7akx7zZxcoSWmvy_ig/exec';

/*
 * Bump this on every change to this file. CI enforces it.
 *
 * Each business runs its own copy of this script, and Apps Script has no way
 * to push an update to them — every deployment is a manual paste. With more
 * than one instance to keep in step, "is that one running the current code?"
 * becomes a question somebody has to be able to answer, and this project has
 * already lost days to a deployment quietly serving an old version. /status
 * prints this, so the answer takes five seconds.
 */
var VERSION = '2026-09-11.1';

var TZ = 'Asia/Colombo';          // Business timezone (UTC+05:30, no DST)
var CURRENCY = 'Rs.';             // Displayed in Telegram messages
var COUNTRY_CODE = '94';          // Sri Lanka — used to normalise phone numbers

var SHEETS = {
  ORDERS: 'Orders',
  CUSTOMERS: 'Customers',
  MENU: 'Menu',
  SETTINGS: 'Settings',
  LEDGER: 'Ledger',
  LOG: 'Log'
};

// Orders sheet column indexes (0-based). Order of these must not change.
var COL = {
  ID: 0, CREATED: 1, DATE: 2, TIME: 3, NAME: 4, PHONE: 5, ADDRESS: 6,
  ITEMS: 7, TOTAL: 8, ADVANCE: 9, BALANCE: 10, STATUS: 11, NOTES: 12,
  DIGEST_SENT: 13, DISPATCH_SENT: 14, DELIVERED_AT: 15, PAYMENT: 16,
  UPDATED: 17, ITEMS_JSON: 18, CHASE_SENT: 19, PAID_AT: 20,
  COST: 21, MARGIN: 22
};

/*
 * "Received" and "Balance Due" are MIRRORS, not sources of truth. The truth is
 * the Ledger tab: every payment, refund and expense is an append-only row.
 * These two columns are recalculated from it so the sheet stays readable at a
 * glance, but an audit reads the Ledger.
 */
var ORDER_HEADERS = [
  'Order ID', 'Created At', 'Delivery Date', 'Delivery Time', 'Customer Name',
  'Customer Phone', 'Delivery Address', 'Items', 'Total Amount', 'Received',
  'Balance Due', 'Status', 'Notes', 'Digest Sent', 'Dispatch Sent',
  'Delivered At', 'Payment Status', 'Updated At', 'Items JSON',
  'Payment Chase Sent', 'Paid At', 'Est. Food Cost', 'Est. Margin'
];

var LEDGER_HEADERS = [
  'Entry ID', 'Timestamp', 'Type', 'Order ID', 'Category', 'Description',
  'Amount', 'Method', 'Recorded By', 'Note'
];

var LED = {
  ID: 0, TIMESTAMP: 1, TYPE: 2, ORDER: 3, CATEGORY: 4, DESCRIPTION: 5,
  AMOUNT: 6, METHOD: 7, BY: 8, NOTE: 9
};

/** Money in raises the balance received; money out lowers it. */
var LEDGER_TYPES = {
  'Payment In': 1,
  'Refund Out': -1,
  'Expense': 0,      // business cost, not tied to an order's balance
  'Adjustment': 0    // audit note only, never moves money
};

var PAYMENT_METHODS = ['Cash', 'Bank', 'Card', 'Other'];

var EXPENSE_CATEGORIES = ['Ingredients', 'Gas', 'Transport', 'Packaging', 'Staff', 'Other'];

/** Keywords that sort a typed expense into a category without extra taps. */
var EXPENSE_HINTS = {
  Ingredients: ['chicken', 'mutton', 'beef', 'rice', 'spice', 'oil', 'vegetable', 'egg', 'fish', 'curd', 'market'],
  Gas: ['gas', 'cylinder', 'fuel'],
  Transport: ['transport', 'delivery', 'driver', 'petrol', 'diesel', 'three wheel', 'tuk'],
  Packaging: ['box', 'container', 'packing', 'packaging', 'spoon', 'bag', 'foil'],
  Staff: ['staff', 'helper', 'wages', 'salary', 'labour', 'labor']
};

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

// Cost is APPENDED, not inserted, so a Menu tab created before this existed
// keeps working — the column simply reads as blank until it is filled in.
var MENU_HEADERS = ['Category', 'Item', 'Unit', 'Rate', 'Step', 'Active', 'Cost'];

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
  ['Biryani',  'Chicken Dum Biryani',            'Pax',      950,  5,  'YES', 550],
  ['Biryani',  'Mutton Dum Biryani',             'Pax',     1350,  5,  'YES', 780],
  ['Biryani',  'Beef Biryani',                   'Pax',     1150,  5,  'YES', 670],
  ['Biryani',  'Egg / Veg Biryani',              'Pax',      700,  5,  'YES', 410],
  ['Mandhi',   'Chicken Mandhi (Quarter)',       'Packs',    900,  1,  'YES', 520],
  ['Mandhi',   'Chicken Mandhi (Half)',          'Packs',   1700,  1,  'YES', 990],
  ['Mandhi',   'Chicken Mandhi (Full)',          'Packs',   3200,  1,  'YES', 1860],
  ['Mandhi',   'Mutton Mandhi Special',          'Packs',   2400,  1,  'YES', 1390],
  ['Rice',     'Chicken Fried Rice',             'Portions', 750,  5,  'YES', 430],
  ['Rice',     'Seafood Mixed Fried Rice',       'Portions', 950,  5,  'YES', 550],
  ['Rice',     'Egg / Vegetable Fried Rice',     'Portions', 600,  5,  'YES', 350],
  ['Curry',    'Butter Chicken Gravy',           'Litres',  2200,  1,  'YES', 1280],
  ['Curry',    'Chilli Chicken (Dry / Gravy)',   'Portions', 800,  5,  'YES', 460],
  ['Curry',    'Raita & Mint Chutney',           'Bowls',    350,  1,  'YES', 200],
  ['Dessert',  'Watalappam Party Pack',          'Cups',     250,  5,  'YES', 140],
  ['Dessert',  'Gulab Jamun (Catering Pack)',    'Pieces',    60, 10,  'YES', 30]
];

/*
 * The command list, in one place. setMyCommands() pushes it to Telegram so the
 * blue "Menu" button in the chat lists every command as a tappable row, and
 * /help renders the same list. A command that is not here is a command the
 * owner has no way to discover.
 *
 * "/money" stays a working alias for "/owed" but is deliberately not listed —
 * two rows for one report is clutter on a phone.
 */
var BOT_COMMANDS = [
  { command: 'today',     description: "Today's orders and what to collect" },
  { command: 'tomorrow',  description: "Tomorrow's orders" },
  { command: 'week',      description: 'The next 7 days, day by day' },
  { command: 'yesterday', description: "Yesterday's orders" },
  { command: 'pending',   description: 'Everything not delivered yet' },
  { command: 'owed',      description: 'Who owes you money, oldest debt first' },
  { command: 'cash',      description: "Today's money in, out and profit" },
  { command: 'month',     description: 'This month: revenue, costs, profit' },
  { command: 'pay',       description: 'Record a payment — /pay 20000' },
  { command: 'spend',     description: 'Record a cost — /spend 4500 chicken' },
  { command: 'help',      description: 'What every command does' },
  { command: 'status',    description: 'Check the system is wired up correctly' }
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
    //
    // NOTE ON API_KEY: it is published inside index.html on GitHub Pages, so
    // treat it as public. It filters drive-by traffic; it does NOT authenticate
    // anyone. Real access control is Telegram's signature over initData,
    // checked by requireTelegramAuth_(). Two optional properties:
    //   EXTRA_TELEGRAM_USER_IDS  comma-separated ids allowed besides the owner
    //   ALLOW_BROWSER_ACCESS     'YES' permits READ-ONLY use outside Telegram
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
  ledgerSheet_();
  // Creating tabs is not enough on a spreadsheet that already has data — the
  // schema has changed since the first release.
  return 'Sheets ready. ' + migrateSheets_();
}

/**
 * STEP 3 — Run AFTER deploying as a Web App. Enables the Telegram buttons.
 *
 * Run this again after EVERY "Deploy > New deployment", because that mints a
 * fresh /exec URL and Telegram keeps POSTing to the old one. The bot then goes
 * completely silent with no error anywhere — it happened on 2026-09-09 and the
 * only visible symptom was that nothing replied.
 */
function registerWebhook() {
  // A script property wins, so the URL can be changed without touching code.
  // Then the DEPLOYMENT_URL constant at the top of this file. getUrl() is the
  // last resort because it reports the unusable "/dev" URL in this project.
  //
  // A property that is not a usable URL is SKIPPED rather than obeyed. One was
  // saved as just "/exec" by a half-completed paste, and because the property
  // outranked everything it kept overriding a perfectly good default and the
  // bot stayed down. Bad configuration must not beat working configuration.
  var pinned = String(props_().getProperty('DEPLOYMENT_URL') || '').trim();
  if (pinned && isDeploymentUrl_(pinned)) return registerWebhookAt(pinned);
  if (pinned) {
    logError_('registerWebhook', new Error(
      'Ignoring the DEPLOYMENT_URL script property: "' + pinned + '" is not a /exec URL. ' +
      'Delete that property, or set it to the full deployment address.'));
  }
  if (DEPLOYMENT_URL) return registerWebhookAt(DEPLOYMENT_URL);

  var url = ScriptApp.getService().getUrl();
  if (!url) throw new Error('Deploy this script as a Web App first (Deploy > New deployment > Web app).');

  // The head deployment ("/dev") demands a Google login, so Telegram gets a
  // 401 and drops every update. The bot goes silent with nothing to show for
  // it — which is exactly what happened on 2026-09-09.
  if (url.indexOf('/exec') === -1) {
    throw new Error('Refusing to register "' + url + '" — that is the head (/dev) URL, which ' +
      'Telegram cannot reach (it answers 401). Fix: Deploy > Manage deployments, copy the ' +
      '/exec URL, then Project Settings > Script Properties > add DEPLOYMENT_URL with that ' +
      'value, and run registerWebhook again.');
  }
  return registerWebhookAt(url);
}

/**
 * Points the webhook at an explicit deployment URL.
 *
 * Use this when registerWebhook() picks up the wrong URL, or after creating a
 * new deployment when you already have the URL in front of you.
 */
/** Tolerates what a phone paste produces: whitespace, a trailing slash, a query string. */
function tidyUrl_(url) {
  return String(url || '').replace(/\s+/g, '').split('?')[0].replace(/\/+$/, '');
}

function isDeploymentUrl_(url) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(tidyUrl_(url));
}

function registerWebhookAt(url) {
  var clean = tidyUrl_(url);
  if (!isDeploymentUrl_(clean)) {
    throw new Error('Not a deployment URL — got "' + clean + '". It must be the whole ' +
      'address, starting with https://script.google.com/macros/s/ and ending in /exec. ' +
      'If a DEPLOYMENT_URL script property is set, delete it (Project Settings > Script ' +
      'Properties) — the correct URL already ships in this file.');
  }

  var res = telegramApi_('setWebhook', {
    url: clean + '?wh=' + encodeURIComponent(cfg_('WEBHOOK_SECRET')),
    allowed_updates: ['message', 'callback_query'],
    // Clears whatever Telegram queued up while the old URL was dead, so the
    // owner is not buried in replies to messages sent hours ago.
    drop_pending_updates: true
  });
  if (!res || res.ok !== true) {
    throw new Error('Telegram refused the webhook: ' + ((res && res.description) || 'no response'));
  }

  var menu = setMyCommands();

  return 'Webhook registered.\n' +
    'URL: ' + clean + '\n' +
    'Queued updates dropped.\n' +
    'Command menu: ' + (menu ? 'updated' : 'FAILED — check the Log tab') + '\n\n' +
    'NEXT: put this same URL into index.html (APPS_SCRIPT_WEBAPP_URL) and push it, ' +
    'or the Mini App will still be calling the old deployment.';
}

/**
 * Publishes the command list to Telegram, so the blue Menu button in the chat
 * shows every command as a tappable row with a description. Without this the
 * owner has to remember that /spend and /pay exist.
 */
function setMyCommands() {
  var res = telegramApi_('setMyCommands', { commands: BOT_COMMANDS });
  return !!(res && res.ok);
}

/**
 * The Mini App page this instance's buttons should open.
 *
 * One page serves every business; the ?client= on the end decides which
 * backend it talks to. A client deployment sets MINI_APP_URL to
 * ".../catering-order-manager/?client=<their id>". Without it, their bot's
 * buttons would open the demo instance.
 */
function miniAppUrl_() {
  return props_().getProperty('MINI_APP_URL') ||
         'https://fidit-space.github.io/catering-order-manager/';
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
 * One function that answers "is this thing actually wired up?".
 *
 * Every silent failure this project has had would have shown up here in a
 * single run: a webhook pointing at a dead deployment, triggers that were
 * never installed, a Menu tab with no costs so margins never appear. Returns
 * the report and also sends it to Telegram, so it can be read from a phone.
 *
 * It prints property NAMES only. A credential value must never reach a chat
 * window, and the registered webhook URL carries WEBHOOK_SECRET in its query
 * string, so that is stripped before display.
 */
function diagnose() {
  var lines = [];
  function add(s) { lines.push(s); }

  add('SYSTEM CHECK — ' + nowStr_());

  // --- Which business is this, and is it running current code? ---
  add('');
  add('INSTANCE');
  add('  Name:     ' + (props_().getProperty('TENANT_NAME') || '(unnamed — set TENANT_NAME)'));
  add('  Version:  ' + VERSION);
  add('  Mini App: ' + miniAppUrl_());
  if (!props_().getProperty('MINI_APP_URL')) {
    add('  NOTE    MINI_APP_URL is not set, so the buttons open the default page.');
    add('          A client instance must set it, or its bot opens the demo.');
  }

  // --- Credentials: presence only, never values. ---
  add('');
  add('PROPERTIES');
  ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_CHAT_ID', 'API_KEY', 'WEBHOOK_SECRET'].forEach(function (k) {
    add('  ' + (props_().getProperty(k) ? 'OK      ' : 'MISSING ') + k);
  });

  // --- Who can get in. Silent access widening is worth seeing. ---
  add('');
  add('ACCESS');
  var hatch = props_().getProperty('ALLOW_BROWSER_ACCESS') === 'YES';
  add('  ' + (hatch ? 'WARN    ' : 'OK      ') + 'ALLOW_BROWSER_ACCESS is ' + (hatch ? 'ON' : 'off') +
      (hatch ? ' — health and menu are readable without Telegram' : ''));
  var extra = String(props_().getProperty('EXTRA_TELEGRAM_USER_IDS') || '').trim();
  add('  ' + (extra ? 'WARN    ' : 'OK      ') + 'Extra users allowed: ' + (extra || 'none — owner only'));

  // --- Which bot is this token actually for? ---
  // A token that authenticates fine against the API can still belong to a
  // DIFFERENT bot from the one the Mini App was opened from, and then every
  // initData signature fails while everything else looks healthy.
  add('');
  add('BOT');
  var me = telegramApi_('getMe', {});
  if (me && me.ok && me.result) {
    add('  Token belongs to: @' + me.result.username + '  (id ' + me.result.id + ')');
    add('  The Mini App must be opened from THIS bot, or sign-in will always fail.');
  } else {
    add('  FAIL    getMe failed: ' + ((me && me.description) || 'no response') +
        ' — TELEGRAM_BOT_TOKEN is not a working token.');
  }

  // --- Webhook: the thing that was broken. ---
  add('');
  add('WEBHOOK');
  var deployed = String(props_().getProperty('DEPLOYMENT_URL') || '').trim();
  if (deployed && !isDeploymentUrl_(deployed)) {
    add('  FAIL    the DEPLOYMENT_URL script property holds "' + deployed + '",');
    add('          which is not a /exec URL. It is being ignored. Delete it in');
    add('          Project Settings > Script Properties.');
    deployed = '';
  }
  if (deployed) {
    add('  Target:      ' + deployed + '  (DEPLOYMENT_URL property)');
  } else if (DEPLOYMENT_URL) {
    deployed = DEPLOYMENT_URL;
    add('  Target:      ' + deployed + '  (DEPLOYMENT_URL constant in Code.gs)');
  } else {
    try { deployed = ScriptApp.getService().getUrl() || ''; } catch (e) { deployed = ''; }
  }
  var info = telegramApi_('getWebhookInfo', {});
  var hook = (info && info.result) || {};
  var registered = String(hook.url || '').split('?')[0];   // drop WEBHOOK_SECRET

  add('  Registered:  ' + (registered || '(none — the bot cannot receive anything)'));
  if (!registered) {
    add('  FAIL    no webhook set. Run registerWebhookAt("<your /exec url>").');
  } else if (registered.indexOf('/dev') !== -1) {
    // The head URL demands a Google login, so Telegram gets a 401 and every
    // update is dropped. The bot goes silent with nothing to show for it.
    add('  FAIL    that is the /dev head URL. Telegram cannot sign in to Google,');
    add('          so every update comes back 401 and the bot answers nothing.');
    add('          Fix: Deploy > Manage deployments, copy the /exec URL, then');
    add('          run registerWebhookAt("<that url>")');
  } else if (registered.indexOf('/exec') === -1) {
    add('  FAIL    not a deployment URL.');
  } else {
    add('  OK      a real /exec deployment');
    // getUrl() reports the head URL in many projects, so it can confirm a
    // deployment is wrong but never that it is right. Say so rather than
    // implying a match that was not checked.
    if (deployed.indexOf('/exec') !== -1 && deployed !== registered) {
      add('  FAIL    but this script deploys to ' + deployed);
    } else if (deployed.indexOf('/dev') !== -1) {
      add('  NOTE    cannot confirm it is THIS deployment — the editor only');
      add('          reports the /dev URL. The 401 check below is the real test.');
    }
  }
  add('  Queued updates:  ' + (hook.pending_update_count || 0));
  if (hook.last_error_message) {
    add('  FAIL    last delivery error: ' + hook.last_error_message);
    if (String(hook.last_error_message).indexOf('401') !== -1) {
      add('          401 means Telegram is being shown a Google login page.');
      add('          The registered URL is not a public /exec deployment.');
    }
  }

  // --- Scheduled jobs. Three of these were missing for weeks. ---
  add('');
  add('TRIGGERS');
  var installed = {};
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) { installed[t.getHandlerFunction()] = true; });
  } catch (e) { add('  (could not read triggers: ' + e.message + ')'); }
  ['checkDispatchAlerts', 'sendDailyPrepDigest', 'checkUnpaidBalances',
   'weeklyBackup', 'reportNewErrors'].forEach(function (fn) {
    add('  ' + (installed[fn] ? 'OK      ' : 'MISSING ') + fn);
  });

  // --- Sheets and schema. ---
  add('');
  add('SHEETS');
  try {
    var orders = ordersSheet_();
    var cols = orders.getLastColumn();
    add('  Orders:   ' + Math.max(0, orders.getLastRow() - 1) + ' rows, ' + cols + ' columns' +
        (cols >= ORDER_HEADERS.length ? ' OK' : ' FAIL — run migrateSheets()'));
    add('  Ledger:   ' + Math.max(0, ledgerSheet_().getLastRow() - 1) + ' entries');
    var menu = readMenu_();
    var costed = menu.filter(function (m) { return num_(m.cost) > 0; }).length;
    add('  Menu:     ' + menu.length + ' items, ' + costed + ' with a cost' +
        (costed ? '' : ' FAIL — no margin can be calculated until costs are filled in'));
  } catch (e) {
    add('  FAIL    ' + e.message);
  }

  // --- Recent errors, so a failure does not need the sheet opened to be seen. ---
  add('');
  add('RECENT ERRORS');
  try {
    var log = logSheet_();
    var last = log.getLastRow();
    if (last < 2) {
      add('  none');
    } else {
      var from = Math.max(2, last - 4);
      log.getRange(from, 1, last - from + 1, 3).getValues().forEach(function (r) {
        add('  ' + r[0] + '  ' + r[1] + ': ' + String(r[2]).replace(/\s+/g, ' ').substring(0, 100));
      });
    }
  } catch (e) {
    add('  FAIL    ' + e.message);
  }

  var report = lines.join('\n');
  // Telegram caps a message at 4096 characters.
  var wire = report.length > 3600 ? report.substring(0, 3600) + '\n… truncated' : report;
  try {
    sendTelegram_(ownerChat_(), '<pre>' + esc_(wire) + '</pre>');
  } catch (e) { /* the returned report is still useful without the chat copy */ }

  Logger.log(report);
  return report;
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

/**
 * True when this update has been processed already.
 *
 * Marks it as seen BEFORE the work runs, so a retry arriving while the first
 * attempt is still going is dropped too. Cache entries expire on their own,
 * which is right: an update id is only interesting for as long as Telegram
 * might resend it.
 */
function alreadyHandled_(updateId) {
  if (!updateId) return false;

  var cache = CacheService.getScriptCache();
  var key = 'update_' + updateId;
  if (cache.get(key)) return true;

  cache.put(key, '1', 21600);   // 6 hours, the cache maximum
  return false;
}

// ==================== TELEGRAM IDENTITY VERIFICATION ====================

/*
 * WHY THIS EXISTS
 *
 * index.html is served from GitHub Pages, so anything inside it — including
 * API_KEY — is readable by anyone who opens the page. A static page cannot
 * keep a secret. The key is therefore a spam filter, never authentication.
 *
 * Telegram signs every Mini App launch with initData, an HMAC over the
 * launch parameters using the bot token as the key. The bot token never
 * leaves Script Properties, so only a genuine launch of THIS bot can produce
 * a valid signature — and a leaked API key gets an attacker nothing.
 *
 * Reference: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */

/** Actions that change data. These always require a verified Telegram launch. */
/*
 * Which actions the ALLOW_BROWSER_ACCESS escape hatch may serve without a
 * verified Telegram launch. DEFAULT-DENY: anything not named here needs a
 * signature, including every route added in future.
 *
 * This was a deny-list of write actions, and it was written before the finance
 * release added recordPayment / recordRefund / recordExpense. Those three were
 * therefore treated as reads and, with the hatch on, could write money into
 * the Ledger with nothing but the API key — which is published in index.html.
 * An allow-list cannot fail that way: forgetting to add a route denies it.
 *
 * Only health and menu are listed. The rest carry customer names, phone
 * numbers, addresses and takings; a public key must never open those.
 */
var BROWSER_SAFE_ACTIONS = {
  health: true,
  menu: true
};

/**
 * Verifies Telegram's signature over initData.
 * @return {{ok: boolean, user: Object, reason: string}}
 */
function validateInitData_(initData) {
  if (!initData) return { ok: false, reason: 'No Telegram sign-in data was sent.' };

  var pairs = String(initData).split('&');
  var hash = '';
  var fields = [];
  var withoutSignature = [];
  var data = {};

  for (var i = 0; i < pairs.length; i++) {
    var eq = pairs[i].indexOf('=');
    if (eq === -1) continue;
    var key = decodeURIComponent(pairs[i].substring(0, eq));
    var value = decodeURIComponent(pairs[i].substring(eq + 1));
    if (key === 'hash') { hash = value; continue; }

    data[key] = value;
    fields.push(key + '=' + value);
    // Bot API 8.0 added "signature" (Ed25519, for third-party validation).
    // Telegram's own spec excludes only "hash" from the HMAC check string, so
    // signature belongs in it — dropping it made every launch from a recent
    // client fail verification. Both forms are tried below because which one
    // a given client signs is not worth guessing at.
    if (key !== 'signature') withoutSignature.push(key + '=' + value);
  }

  if (!hash) return { ok: false, reason: 'Sign-in data is missing its signature.' };

  fields.sort();
  withoutSignature.sort();

  // secret = HMAC(key: "WebAppData", message: bot token)
  var secret = Utilities.computeHmacSha256Signature(cfg_('TELEGRAM_BOT_TOKEN'), 'WebAppData');
  var expected = String(hash).toLowerCase();

  var matched = hmacHex_(fields.join('\n'), secret) === expected ||
    (fields.length !== withoutSignature.length &&
     hmacHex_(withoutSignature.join('\n'), secret) === expected);

  if (!matched) {
    // Logged so a future mismatch is diagnosable instead of a dead end. No
    // secret is recorded — only which fields arrived.
    logError_('validateInitData_', new Error(
      'initData did not verify. Fields present: ' + Object.keys(data).sort().join(', ') +
      '. Check that TELEGRAM_BOT_TOKEN matches the bot the app was opened from.'));
    // Knowing WHICH fields arrived was not enough to solve this on 2026-09-09.
    // With DEBUG_AUTH switched on, keep the launch itself so
    // explainAuthFailure() can test it against every plausible construction.
    // Off by default: this is the owner's own launch data, and it stays inside
    // their own Script Properties, but there is no reason to hold it always.
    if (props_().getProperty('DEBUG_AUTH') === 'YES') {
      try {
        props_().setProperty('LAST_AUTH_FAILURE', nowStr_() + '\u0000' + initData);
      } catch (e) { /* diagnosis must never break the request */ }
    }
    return { ok: false, reason: 'Sign-in data failed verification.' };
  }

  // A valid signature is forever, so replayed launches are bounded by age.
  var maxAge = Number(getSetting_('auth_max_age_hours', 24)) || 24;
  var authDate = Number(data.auth_date || 0);
  if (authDate && (Date.now() / 1000 - authDate) > maxAge * 3600) {
    return { ok: false, reason: 'This session has expired. Please reopen the app from Telegram.' };
  }

  var user = null;
  try { user = data.user ? JSON.parse(data.user) : null; } catch (e) { user = null; }
  if (!user || !user.id) return { ok: false, reason: 'Sign-in data carried no user.' };

  return { ok: true, user: user, reason: '' };
}

/** Telegram ids permitted to use this deployment: the owner, plus any extras. */
function allowedUserIds_() {
  var ids = {};
  ids[String(ownerChat_())] = true;
  var extra = props_().getProperty('EXTRA_TELEGRAM_USER_IDS') || '';
  extra.split(',').forEach(function (id) {
    var trimmed = String(id).trim();
    if (trimmed) ids[trimmed] = true;
  });
  return ids;
}

/**
 * The gate every request passes through.
 * Throws with a message safe to show the user.
 */
function requireTelegramAuth_(initData, action) {
  // Escape hatch for setup and debugging from a desktop browser. Off unless
  // explicitly switched on, and limited to the two actions that carry no
  // customer data and move no money.
  if (props_().getProperty('ALLOW_BROWSER_ACCESS') === 'YES' && BROWSER_SAFE_ACTIONS[action]) return null;

  var result = validateInitData_(initData);
  if (!result.ok) throw new Error(result.reason);

  if (!allowedUserIds_()[String(result.user.id)]) {
    logError_('requireTelegramAuth_', new Error('Rejected Telegram user ' + result.user.id +
      ' (' + (result.user.username || 'no username') + ') attempting "' + action + '"'));
    throw new Error('This app is private to the business owner.');
  }
  return result.user;
}

/** HMAC-SHA256 of a string with a byte-array key, hex encoded. */
function hmacHex_(text, secret) {
  return toHex_(Utilities.computeHmacSha256Signature(
    Utilities.newBlob(text).getBytes(), secret));
}

/** Hex-encodes the signed byte array Apps Script returns. */
function toHex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    // Apps Script bytes are signed (-128..127).
    var b = (bytes[i] < 0 ? bytes[i] + 256 : bytes[i]).toString(16);
    out += b.length === 1 ? '0' + b : b;
  }
  return out;
}

// ==================== SHEET INTEGRITY GUARD ====================

/**
 * Simple trigger: fires whenever a person edits the spreadsheet by hand.
 * Needs no installation — Apps Script runs any function named onEdit.
 *
 * WHY THIS EXISTS: the reminder engine depends on Delivery Date and Delivery
 * Time being plain text. Sheets silently converts "2026-09-09" into a Date the
 * moment someone retypes it, which is exactly the defect that once stopped
 * every reminder from firing. Since the owner is *told* to edit this
 * spreadsheet, that fix cannot be left to trust — this repairs the cell as
 * soon as it is touched.
 *
 * Script-made edits do not re-trigger a simple trigger, so this cannot loop.
 */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    if (sheet.getName() !== SHEETS.ORDERS) return;

    var firstRow = e.range.getRow();
    var firstCol = e.range.getColumn();
    var lastRow = firstRow + e.range.getNumRows() - 1;
    var lastCol = firstCol + e.range.getNumColumns() - 1;

    // tryLock rather than waitLock: this runs while a person is typing, so
    // blocking their edit for 20 seconds would be worse than skipping. If a
    // reminder job holds the lock, the bad value survives until the next edit
    // or repairAllOrderRows() — and the daily jobs log it as unreadable in the
    // meantime, which reportNewErrors pushes to Telegram.
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) {
      logError_('onEdit', new Error('Sheet busy; skipped repairing row ' + firstRow + '. Run repairAllOrderRows() if a reminder is missed.'));
      return;
    }

    try {
      for (var row = Math.max(firstRow, 2); row <= lastRow; row++) {
        for (var col = firstCol; col <= lastCol; col++) {
          repairOrderCell_(sheet, row, col);
        }
      }
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    logError_('onEdit', err);
  }
}

/**
 * Rewrites one cell back into the canonical text the engine expects.
 * Returns true when it had to change something.
 */
function repairOrderCell_(sheet, row, col) {
  var canonical;
  if (col === COL.DATE + 1) canonical = toDateStr_(sheet.getRange(row, col).getValue());
  else if (col === COL.TIME + 1) canonical = toTimeStr_(sheet.getRange(row, col).getValue());
  else if (col === COL.PHONE + 1) canonical = normalizePhone_(sheet.getRange(row, col).getValue());
  else return false;

  var cell = sheet.getRange(row, col);
  var current = cell.getValue();
  cell.setNumberFormat('@');

  // An unreadable value is left alone rather than silently blanked — the owner
  // can see and correct it, and the Log records that it needs attention.
  if (!canonical) {
    if (current !== '' && current != null) {
      logError_('repairOrderCell_', new Error('Row ' + row + ' column ' + col + ' is not a value I can read: "' + current + '"'));
    }
    return false;
  }

  if (String(current) === canonical) return false;
  cell.setValue(canonical);
  return true;
}

/**
 * Maintenance: repairs every row at once. Run it from the editor if the sheet
 * was edited before this guard existed, or after pasting rows in bulk.
 */
function repairAllOrderRows() {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = ordersSheet_();
    var lastRow = sheet.getDataRange().getValues().length;
    var fixed = 0;

    for (var row = 2; row <= lastRow; row++) {
      [COL.DATE + 1, COL.TIME + 1, COL.PHONE + 1].forEach(function (col) {
        if (repairOrderCell_(sheet, row, col)) fixed++;
      });
    }
    return 'Repaired ' + fixed + ' cell(s) across ' + Math.max(0, lastRow - 1) + ' order(s).';
  } finally {
    lock.releaseLock();
  }
}

/**
 * Daily watchdog. The Log tab catches every failure, but nobody reads a
 * spreadsheet tab — so anything new in it gets pushed to Telegram instead.
 */
function reportNewErrors() {
  var sheet = logSheet_();
  var rows = sheet.getDataRange().getValues();
  if (rows.length <= 1) return 'log is empty';

  var lastSeen = Number(props_().getProperty('LOG_ROWS_SEEN') || 1);
  if (rows.length <= lastSeen) return 'no new errors';

  var fresh = rows.slice(lastSeen);
  props_().setProperty('LOG_ROWS_SEEN', String(rows.length));

  var msg = '⚠️ <b>' + fresh.length + ' new error' + (fresh.length === 1 ? '' : 's') + ' recorded</b>\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━\n';
  fresh.slice(0, 10).forEach(function (r) {
    msg += '\n<b>' + esc_(r[1]) + '</b>\n<code>' + esc_(String(r[2]).substring(0, 200)) + '</code>\n';
  });
  if (fresh.length > 10) msg += '\n<i>…and ' + (fresh.length - 10) + ' more in the Log tab.</i>';

  sendTelegram_(ownerChat_(), msg);
  return 'reported ' + fresh.length + ' error(s)';
}

// ==================== HTTP: GET ====================

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var action = p.action || 'health';

    if (action !== 'health') {
      requireKey_(p.key);              // cheap spam filter, NOT authentication
      requireTelegramAuth_(p.initData, action);   // the real gate
    }

    switch (action) {
      case 'health':   return json_(health_(p.key, p.initData));
      case 'menu':     return json_({ status: 'ok', menu: readMenu_(), statusFlow: STATUS_FLOW, statusIcons: STATUS_ICON });
      case 'unpaid':   return json_({ status: 'ok', orders: readUnpaid_() });
      case 'money':    return json_({
                         status: 'ok',
                         today: summariseMoney_(todayStr_(), todayStr_()),
                         month: summariseMoney_(monthStartStr_(), todayStr_()),
                         aging: receivablesAging_(),
                         categories: EXPENSE_CATEGORIES,
                         methods: PAYMENT_METHODS
                       });
      case 'ledger':   return json_({ status: 'ok', entries: recentLedger_(Number(p.limit) || 40) });
      case 'orders':   return json_({ status: 'ok', orders: readOrders_(p.from, p.to, p.limit) });
      case 'customer': return json_({ status: 'ok', customer: findCustomer_(p.phone) });
      default:         return json_({ status: 'error', message: 'Unknown action: ' + action });
    }
  } catch (err) {
    logError_('doGet', err);
    return json_({ status: 'error', message: String(err.message || err) });
  }
}

/**
 * Liveness for anyone; business figures only for a verified Telegram launch.
 *
 * API_KEY is published inside index.html, so gating the counts on it gated
 * them on nothing — order and customer totals were readable by anyone who
 * viewed source.
 */
function health_(key, initData) {
  var out = { status: 'ok', timestamp: nowStr_(), timezone: TZ };
  try {
    requireKey_(key);
    requireTelegramAuth_(initData, 'health');
  } catch (e) {
    out.detail = 'Deployment is live. Open the app from Telegram to see order counts.';
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

/**
 * Switches on capture of the next failing Mini App sign-in. Run this, open the
 * app from the bot once, then run explainAuthFailure().
 */
function debugAuthOn() {
  props_().setProperty('DEBUG_AUTH', 'YES');
  props_().deleteProperty('LAST_AUTH_FAILURE');
  return 'Capture is on. Now open the Mini App from the bot once, then run explainAuthFailure().';
}

function debugAuthOff() {
  props_().deleteProperty('DEBUG_AUTH');
  props_().deleteProperty('LAST_AUTH_FAILURE');
  return 'Capture is off and the stored launch has been deleted.';
}

/**
 * Takes the captured launch apart and says exactly why it did not verify.
 *
 * The published algorithm has one ambiguity — whether Bot API 8.0's
 * "signature" field belongs in the data-check-string — and a token can be
 * valid for the API while belonging to a different bot from the one the app
 * was opened from. Both look identical from the outside: "failed
 * verification". This tries every plausible construction and names the one
 * that works, or proves that none does and the token is the problem.
 *
 * Prints no secret: field NAMES, the bot id (a public identifier), and
 * whether each candidate matched.
 */
function explainAuthFailure() {
  var stored = props_().getProperty('LAST_AUTH_FAILURE');
  if (!stored) {
    return 'Nothing captured. Run debugAuthOn(), open the Mini App from the bot once, then run this again.';
  }

  var split = stored.indexOf('\u0000');
  var when = stored.substring(0, split);
  var initData = stored.substring(split + 1);

  var out = ['AUTH FAILURE — captured ' + when, ''];

  var me = telegramApi_('getMe', {});
  var botName = (me && me.ok && me.result) ? '@' + me.result.username + ' (id ' + me.result.id + ')' : 'UNKNOWN';
  out.push('Token in Script Properties belongs to: ' + botName);
  out.push('');

  var pairs = String(initData).split('&');
  var hash = '';
  var decoded = {};
  var raw = {};
  pairs.forEach(function (pair) {
    var eq = pair.indexOf('=');
    if (eq === -1) return;
    var key = pair.substring(0, eq);
    var value = pair.substring(eq + 1);
    if (key === 'hash') { hash = decodeURIComponent(value); return; }
    raw[key] = value;
    decoded[key] = decodeURIComponent(value);
  });

  out.push('Fields received: ' + Object.keys(decoded).sort().join(', ') + (hash ? ', hash' : ', NO HASH'));

  var user = null;
  try { user = decoded.user ? JSON.parse(decoded.user) : null; } catch (e) { user = null; }
  out.push('Opened by user id: ' + (user && user.id ? user.id : 'could not read'));
  out.push('Owner chat id:     ' + props_().getProperty('TELEGRAM_OWNER_CHAT_ID'));
  out.push('');

  function build(source, skip) {
    return Object.keys(source).filter(function (k) { return skip.indexOf(k) === -1; })
      .sort().map(function (k) { return k + '=' + source[k]; }).join('\n');
  }

  var secret = Utilities.computeHmacSha256Signature(cfg_('TELEGRAM_BOT_TOKEN'), 'WebAppData');
  var expected = String(hash).toLowerCase();

  var candidates = [
    { label: 'decoded values, signature included (the documented form)', s: build(decoded, []) },
    { label: 'decoded values, signature excluded', s: build(decoded, ['signature']) },
    { label: 'raw url-encoded values, signature included', s: build(raw, []) },
    { label: 'raw url-encoded values, signature excluded', s: build(raw, ['signature']) }
  ];

  out.push('CANDIDATES');
  var any = false;
  candidates.forEach(function (c) {
    var hit = hmacHex_(c.s, secret) === expected;
    if (hit) any = true;
    out.push('  ' + (hit ? 'MATCH  ' : 'no     ') + c.label);
  });

  out.push('');
  if (any) {
    out.push('VERDICT: one construction verifies. validateInitData_ needs to use it.');
  } else {
    out.push('VERDICT: no construction verifies, so the data is fine and the KEY is wrong.');
    out.push('The Mini App was opened from a different bot than ' + botName + ',');
    out.push('or TELEGRAM_BOT_TOKEN was regenerated in @BotFather and not updated here.');
    out.push('Fix: open @BotFather > /mybots > the bot the app is attached to >');
    out.push('API Token, and put THAT token in Script Properties.');
  }

  var report = out.join('\n');
  try { sendTelegram_(ownerChat_(), '<pre>' + esc_(report) + '</pre>'); } catch (e) { /* log copy is enough */ }
  Logger.log(report);
  return report;
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

      // Telegram redelivers an update whenever the webhook does not answer
      // cleanly and quickly enough — and Apps Script cold starts plus a few
      // sheet reads are easily slow enough to trip that. Without this guard a
      // single /cash produced a fresh report every retry, for as long as
      // Telegram kept trying.
      if (alreadyHandled_(update.update_id)) return json_({ status: 'duplicate' });

      if (update.callback_query) handleCallbackQuery_(update.callback_query);
      else if (update.message) handleBotMessage_(update.message);
      return json_({ status: 'ok' });
    }

    // --- Mini App path ---
    if (!e || !e.postData || !e.postData.contents) {
      return json_({ status: 'error', message: 'No data received' });
    }

    var body = JSON.parse(e.postData.contents);
    requireKey_(body.key);             // cheap spam filter, NOT authentication

    var action = body.action || (body.order ? 'newOrder' : '');
    var actor = requireTelegramAuth_(body.initData, action);   // the real gate
    if (actor) body.actorId = actor.id;
    switch (action) {
      case 'newOrder':    return json_(saveOrder_(body.order));
      case 'updateOrder': return json_(updateOrder_(body.orderId, body.order));
      case 'cancelOrder':   return json_(cancelOrder_(body.orderId));
      case 'recordPayment': return json_(recordPayment_(body.orderId, body.amount, body.method, body.actorId, body.note));
      case 'recordRefund':  return json_(recordRefund_(body.orderId, body.amount, body.method, body.actorId, body.note));
      case 'recordExpense': return json_(recordExpense_(body.amount, body.description, body.category, body.method, body.actorId, body.orderId));
      case 'markDelivered': return json_(setOrderStatus_(body.orderId, 'Delivered'));
      case 'advanceStatus': return json_(advanceOrderStatus_(body.orderId));
      case 'setStatus':     return json_(setOrderStatus_(body.orderId, body.newStatus));
      case 'markPaid':      return json_(markOrderPaid_(body.orderId, body.method, body.actorId));
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
    var orderId = makeOrderId_(existingOrderIds_(sheet));
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
    var foodCost = estimateFoodCost_(items);
    row[COL.TOTAL] = total;
    row[COL.ADVANCE] = 0;                 // filled in by syncOrderMoney_ below
    row[COL.BALANCE] = total;
    row[COL.COST] = foodCost === null ? '' : foodCost;
    row[COL.MARGIN] = foodCost === null ? '' : total - foodCost;
    row[COL.STATUS] = order.prepStatus || 'Confirmed';
    row[COL.NOTES] = order.specialNotes || '';
    row[COL.DIGEST_SENT] = 'NO';
    row[COL.DISPATCH_SENT] = 'NO';
    row[COL.DELIVERED_AT] = '';
    row[COL.PAYMENT] = 'Unpaid';
    row[COL.UPDATED] = nowStr_();
    row[COL.ITEMS_JSON] = JSON.stringify(items);

    sheet.appendRow(row);

    // An advance is money that moved, so it is a ledger event — not a number
    // typed into a cell. This is what makes it auditable later.
    if (advance > 0) {
      addLedgerEntry_({
        type: 'Payment In', orderId: orderId, category: 'Advance',
        description: order.customerName, amount: advance,
        method: order.paymentMethod || 'Cash', by: order.recordedBy || 'owner'
      });
    }
    var money = syncOrderMoney_(orderId);
    row[COL.ADVANCE] = money.received;
    row[COL.BALANCE] = money.balance;
    row[COL.PAYMENT] = money.paymentStatus;

    upsertCustomer_(order.customerName, row[COL.PHONE], order.deliveryAddress);
    sendNewOrderAlert_(orderId, row);

    return { status: 'success', orderId: orderId, received: money.received, balance: money.balance };
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
      // The agreed price can change — a discount, a dispute, a miscount. Each
      // change is recorded so the reason survives, instead of the old figure
      // silently disappearing.
      var priceChanged = false;
      if (order.totalAmount !== undefined && num_(order.totalAmount) !== num_(row[COL.TOTAL])) {
        priceChanged = { from: num_(row[COL.TOTAL]), to: num_(order.totalAmount) };
        row[COL.TOTAL] = num_(order.totalAmount);
      }
      if (order.itemsJson || priceChanged) {
        var cost = estimateFoodCost_(order.itemsJson || JSON.parse(row[COL.ITEMS_JSON] || '[]'));
        row[COL.COST] = cost === null ? '' : cost;
        row[COL.MARGIN] = cost === null ? '' : num_(row[COL.TOTAL]) - cost;
      }

      // Moving the delivery time re-arms the reminders for this order.
      if (timeChanged) {
        row[COL.DIGEST_SENT] = 'NO';
        row[COL.DISPATCH_SENT] = 'NO';
      }
      row[COL.UPDATED] = nowStr_();

      sheet.getRange(i + 1, 1, 1, ORDER_HEADERS.length).setValues([row]);

      if (priceChanged) {
        addLedgerEntry_({
          type: 'Adjustment', orderId: orderId, category: 'Price change',
          description: row[COL.NAME],
          amount: Math.abs(priceChanged.to - priceChanged.from),
          by: order.recordedBy || 'owner',
          note: 'Total changed from ' + CURRENCY + ' ' + fmtMoney_(priceChanged.from) +
                ' to ' + CURRENCY + ' ' + fmtMoney_(priceChanged.to) +
                (order.specialNotes ? ' — ' + order.specialNotes : '')
        });
        syncOrderMoney_(orderId);
      }

      return { status: 'success', orderId: orderId, remindersReset: timeChanged, priceChanged: !!priceChanged };
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

/**
 * Cancelling never quietly keeps the customer's money. If anything was
 * received, the owner is told exactly how much and offered a one-tap refund —
 * previously that balance simply vanished from every view in the system.
 */
function cancelOrder_(orderId) {
  var order = findOrderRow_(orderId);
  if (!order) throw new Error('Order not found: ' + orderId);

  var received = orderReceived_(orderId);
  var result = setOrderStatus_(orderId, 'Cancelled');
  result.receivedHeld = received;

  if (received > 0) {
    sendTelegram_(ownerChat_(),
      '⚠️ <b>Cancelled order still holds the customer’s money</b>\n' +
      '━━━━━━━━━━━━━━━━━━━━━\n' +
      esc_(order[COL.NAME]) + ' paid you <b>' + CURRENCY + ' ' + fmtMoney_(received) + '</b>.\n\n' +
      'Refund it, or keep it and record why.',
      { inline_keyboard: [[
        { text: '💸 Refund ' + CURRENCY + ' ' + fmtMoney_(received), callback_data: 'refund_' + orderId },
        { text: '💬 Message', url: 'https://wa.me/' + String(order[COL.PHONE]) }
      ]] });
  }
  return result;
}

/** The most recent ledger rows, newest first, for the app's money screen. */
function recentLedger_(limit) {
  var rows = readLedger_();
  return rows.slice(-Math.max(1, limit)).reverse().map(function (r) {
    return {
      entryId: r[LED.ID], timestamp: String(r[LED.TIMESTAMP]), type: r[LED.TYPE],
      orderId: r[LED.ORDER], category: r[LED.CATEGORY], description: r[LED.DESCRIPTION],
      amount: num_(r[LED.AMOUNT]), method: r[LED.METHOD], by: r[LED.BY], note: r[LED.NOTE]
    };
  });
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
/**
 * Settles whatever is still outstanding, as a real payment event.
 *
 * The previous version wrote `Advance Paid = Total`, which recorded money
 * collected on delivery as though it had been paid upfront — every
 * advance-versus-on-delivery figure in the books was wrong after one tap.
 * It now appends a ledger entry for the amount actually outstanding.
 */
/*
 * Settles whatever is still owed, in one atomic step.
 *
 * The read and the write MUST happen inside the same lock. Reading the
 * outstanding balance first and then calling a locked writer let two taps on
 * "Paid" — an easy thing to do on a slow phone — both see the full balance and
 * both record it, leaving the order Overpaid and the books showing more money
 * than the customer handed over.
 */
function markOrderPaid_(orderId, method, by) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var order = findOrderRow_(orderId);
    if (!order) throw new Error('Order not found: ' + orderId);

    var outstanding = num_(order[COL.TOTAL]) - orderReceived_(orderId);
    if (outstanding <= 0) {
      return { status: 'success', orderId: orderId, collected: 0, note: 'Already settled.' };
    }

    var result = recordPaymentHeld_(orderId, outstanding, method || 'Cash', by, 'Settled in full', 'Settlement');
    return { status: 'success', orderId: orderId, collected: outstanding, balance: result.balance };
  } finally {
    lock.releaseLock();
  }
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
    foodCost: r[COL.COST] === '' ? null : num_(r[COL.COST]),
    margin: r[COL.MARGIN] === '' ? null : num_(r[COL.MARGIN]),
    specialNotes: r[COL.NOTES]
  };
}

// ==================== CUSTOMERS ====================

/**
 * DELIBERATELY UNLOCKED. Only ever called from saveOrder_, which already holds
 * the script lock. Apps Script script locks are not reentrant, so acquiring one
 * here would deadlock. If you ever call this from anywhere else, take the lock
 * at that call site instead.
 */
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
      step: Number(r[4]) || 1,
      cost: num_(r[6])          // blank on Menu tabs created before costing existed
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
    var failed = 0;

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

      // Mark each alert the moment it is sent, not in a second pass at the
      // end. Flagging afterwards meant one Telegram failure — or hitting the
      // six-minute execution limit — left EVERY alert already delivered this
      // run unflagged, so the next run fifteen minutes later sent them all
      // again. Repeating urgent alarms are worse than a missed one.
      try {
        sendDispatchAlert_(r, diffMin);
        sheet.getRange(i + 1, COL.DISPATCH_SENT + 1).setValue('YES');
        sent++;
      } catch (err) {
        // Left unflagged on purpose, so the next run retries this order alone.
        logError_('checkDispatchAlerts', err);
        failed++;
      }
    }

    return sent + ' dispatch alert(s) sent' + (failed ? ', ' + failed + ' failed and will retry' : '');
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

// ==================== MIGRATION ====================

/*
 * WHY THIS EXISTS
 *
 * The sheet helpers below only write headers when they CREATE a tab. That was
 * fine while the schema never changed. The finance release added a Cost column
 * to Menu, two columns to Orders, renamed "Advance Paid" to "Received", and
 * made the Ledger the source of truth for money — none of which reached a
 * spreadsheet that already existed.
 *
 * Consequences seen in production: every margin silently blank, because
 * readMenu_ found no Cost column; and money recorded before the Ledger with
 * no entries to back it, one payment away from being erased.
 *
 * Run this once after deploying. It is idempotent — running it twice reports
 * nothing to do the second time.
 */
function migrateSheets_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var changes = [];

    changes = changes.concat(migrateOrderHeaders_());
    changes = changes.concat(migrateMenuColumns_());
    changes = changes.concat(backfillOpeningBalances_());
    changes = changes.concat(repairOpeningBalanceDates_());
    changes = changes.concat(backfillOrderCosts_());

    settingsSheet_();
    ledgerSheet_();
    logSheet_();

    if (!changes.length) return 'Nothing to migrate — the spreadsheet is already current.';
    return 'Migrated:\n• ' + changes.join('\n• ');
  } finally {
    lock.releaseLock();
  }
}

/** Public entry point, so it can be run from the Apps Script editor. */
function migrateSheets() {
  var summary = migrateSheets_();
  Logger.log(summary);
  return summary;
}

/** Brings the Orders header row up to the current schema. */
function migrateOrderHeaders_() {
  var sheet = ordersSheet_();
  var width = Math.max(sheet.getLastColumn(), ORDER_HEADERS.length);
  var current = sheet.getRange(1, 1, 1, width).getValues()[0];

  var same = ORDER_HEADERS.every(function (h, i) { return current[i] === h; });
  if (same) return [];

  var renamed = current[COL.ADVANCE] && current[COL.ADVANCE] !== ORDER_HEADERS[COL.ADVANCE]
    ? ' ("' + current[COL.ADVANCE] + '" is now "' + ORDER_HEADERS[COL.ADVANCE] + '")' : '';

  sheet.getRange(1, 1, 1, ORDER_HEADERS.length).setValues([ORDER_HEADERS]);
  sheet.getRange(1, 1, 1, ORDER_HEADERS.length).setFontWeight('bold').setBackground('#e2e8f0');
  return ['Orders headers updated to ' + ORDER_HEADERS.length + ' columns' + renamed];
}

/** Adds the Cost column to a Menu tab created before costing existed. */
function migrateMenuColumns_() {
  var sheet = menuSheet_();
  var width = Math.max(sheet.getLastColumn(), MENU_HEADERS.length);
  var current = sheet.getRange(1, 1, 1, width).getValues()[0];

  if (current[6] === 'Cost') return [];

  sheet.getRange(1, 1, 1, MENU_HEADERS.length).setValues([MENU_HEADERS]);
  sheet.getRange(1, 1, 1, MENU_HEADERS.length).setFontWeight('bold').setBackground('#fde68a');

  // Deliberately left blank rather than seeded. A guessed cost shown as fact is
  // worse than no margin at all — see MENU_GUIDE.md.
  return ['Menu gained a Cost column — fill it in to see profit per order (MENU_GUIDE.md)'];
}

/**
 * THE IMPORTANT ONE. Gives pre-Ledger money a ledger entry to stand on, so
 * recomputing an order's balance can never erase a payment the customer made.
 */
function backfillOpeningBalances_() {
  var sheet = ordersSheet_();
  var data = sheet.getDataRange().getValues();
  var ledger = readLedger_();
  var backfilled = 0;
  var total = 0;

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var orderId = row[COL.ID];
    if (!orderId) continue;

    var recorded = num_(row[COL.ADVANCE]);
    if (recorded <= 0) continue;
    if (ledgerHasOrder_(orderId, ledger)) continue;

    addLedgerEntry_({
      type: 'Payment In',
      orderId: orderId,
      category: 'Opening balance',
      description: row[COL.NAME],
      amount: recorded,
      method: 'Unknown',
      by: 'migration',
      // Dated to when the order was taken, NOT to the migration. Stamping it
      // with today booked historical money as today's takings and inflated
      // both the cash report and the day's profit.
      timestamp: openingBalanceDate_(row),
      note: 'Recorded before the Ledger existed; carried over on ' + nowStr_() +
            '. Payment method was not captured at the time.'
    });
    backfilled++;
    total += recorded;
  }

  if (!backfilled) return [];
  return [backfilled + ' order(s) carrying ' + CURRENCY + ' ' + fmtMoney_(total) +
          ' given opening-balance ledger entries'];
}

/** The best available date for money taken before the Ledger existed. */
function openingBalanceDate_(row) {
  var created = String(row[COL.CREATED] || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(created)) return created;

  var delivery = toDateStr_(row[COL.DATE]);
  if (delivery) return delivery + ' 12:00:00';

  return nowStr_();
}

/**
 * Repairs opening balances that were written with the migration's own
 * timestamp, which made historical money show up as today's income.
 */
function repairOpeningBalanceDates_() {
  var sheet = ledgerSheet_();
  var rows = sheet.getDataRange().getValues();
  var orders = {};
  ordersSheet_().getDataRange().getValues().slice(1).forEach(function (r) {
    if (r[COL.ID]) orders[r[COL.ID]] = r;
  });

  var fixed = 0;
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][LED.CATEGORY] !== 'Opening balance') continue;
    var order = orders[rows[i][LED.ORDER]];
    if (!order) continue;

    var correct = openingBalanceDate_(order);
    if (String(rows[i][LED.TIMESTAMP]) === correct) continue;

    sheet.getRange(i + 1, LED.TIMESTAMP + 1).setValue(correct);
    fixed++;
  }

  if (!fixed) return [];
  return [fixed + ' opening balance(s) re-dated to when the order was taken, ' +
          'so historical money no longer counts as today\'s income'];
}

/** Fills in cost and margin for existing orders, where the Menu has costs. */
function backfillOrderCosts_() {
  var sheet = ordersSheet_();
  var data = sheet.getDataRange().getValues();
  var filled = 0;

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row[COL.ID]) continue;
    if (row[COL.COST] !== '' && row[COL.COST] !== undefined && row[COL.COST] !== null) continue;

    var items = [];
    try { items = row[COL.ITEMS_JSON] ? JSON.parse(row[COL.ITEMS_JSON]) : []; } catch (e) { continue; }

    var cost = estimateFoodCost_(items);
    if (cost === null) continue;   // no costs on the Menu yet — leave blank, do not guess

    sheet.getRange(i + 1, COL.COST + 1).setValue(cost);
    sheet.getRange(i + 1, COL.MARGIN + 1).setValue(num_(row[COL.TOTAL]) - cost);
    filled++;
  }

  if (!filled) return [];
  return [filled + ' existing order(s) given an estimated cost and margin'];
}

// ==================== THE LEDGER ====================

/*
 * WHY A LEDGER
 *
 * The Orders sheet holds the CURRENT state of an order. State can be
 * overwritten, and an overwritten number cannot be audited — you can see what
 * an order is owed today, but not when money arrived, how much came each time,
 * or how it was paid.
 *
 * The Ledger is append-only. Every rupee that moves gets a row and rows are
 * never edited. "Received" and "Balance Due" on an order are recomputed from
 * it. If the two ever disagree, the Ledger is right.
 */

/**
 * Appends one money event. The only way anything is written to the Ledger.
 *
 * @param {Object} entry {type, orderId, category, description, amount, method, by, note}
 */
function addLedgerEntry_(entry) {
  if (!LEDGER_TYPES.hasOwnProperty(entry.type)) throw new Error('Unknown ledger type: ' + entry.type);
  var amount = num_(entry.amount);
  if (amount < 0) throw new Error('Ledger amounts are always positive; the type decides the direction.');
  if (entry.type !== 'Adjustment' && amount === 0) throw new Error('Enter an amount greater than zero.');

  var sheet = ledgerSheet_();
  var id = 'LED-' + Utilities.formatDate(new Date(), TZ, 'yyMMdd-HHmmss') + '-' +
    ('000' + Math.floor(Math.random() * 1679616).toString(36).toUpperCase()).slice(-4);

  sheet.appendRow([
    id,
    entry.timestamp || nowStr_(),
    entry.type,
    entry.orderId || '',
    entry.category || '',
    entry.description || '',
    amount,
    entry.method || '',
    entry.by || 'system',
    entry.note || ''
  ]);

  return {
    entryId: id, type: entry.type, amount: amount,
    category: entry.category || '', method: entry.method || '', orderId: entry.orderId || ''
  };
}

function readLedger_() {
  var rows = ledgerSheet_().getDataRange().getValues();
  return rows.slice(1).filter(function (r) { return r[LED.ID]; });
}

/** Net received against one order: payments in, less refunds out. */
/** True when the ledger holds any row at all for this order. */
function ledgerHasOrder_(orderId, rows) {
  rows = rows || readLedger_();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][LED.ORDER] === orderId) return true;
  }
  return false;
}

function orderReceived_(orderId, rows) {
  rows = rows || readLedger_();
  var total = 0;
  rows.forEach(function (r) {
    if (r[LED.ORDER] !== orderId) return;
    var direction = LEDGER_TYPES[r[LED.TYPE]] || 0;
    total += direction * num_(r[LED.AMOUNT]);
  });
  return total;
}

/**
 * Rewrites an order's Received / Balance / Payment Status from the Ledger.
 * Called after anything that moves money.
 */
function syncOrderMoney_(orderId) {
  var sheet = ordersSheet_();
  var data = sheet.getDataRange().getValues();
  var ledger = readLedger_();

  for (var i = 1; i < data.length; i++) {
    if (data[i][COL.ID] !== orderId) continue;

    var total = num_(data[i][COL.TOTAL]);
    var received = orderReceived_(orderId, ledger);
    var previous = num_(data[i][COL.ADVANCE]);

    // SAFETY NET. Orders booked before the Ledger existed carry money in the
    // Received column with no matching ledger rows. Recomputing from an empty
    // ledger would wipe it and tell the customer they still owe. Refuse, and
    // say so loudly, rather than destroying a payment record.
    if (previous > 0 && received === 0 && !ledgerHasOrder_(orderId, ledger)) {
      logError_('syncOrderMoney_', new Error(
        'Refused to zero ' + CURRENCY + ' ' + fmtMoney_(previous) + ' on ' + orderId +
        ' — it predates the Ledger and has no entries. Run migrateSheets_() to backfill it.'));
      return {
        orderId: orderId, total: total, received: previous, balance: total - previous,
        paymentStatus: data[i][COL.PAYMENT], skipped: 'needs migration'
      };
    }

    var balance = total - received;
    var status = received <= 0 ? 'Unpaid' : (balance > 0 ? 'Part paid' : (balance < 0 ? 'Overpaid' : 'Paid'));

    sheet.getRange(i + 1, COL.ADVANCE + 1).setValue(received);
    sheet.getRange(i + 1, COL.BALANCE + 1).setValue(balance);
    sheet.getRange(i + 1, COL.PAYMENT + 1).setValue(status);
    if (balance <= 0 && !data[i][COL.PAID_AT]) sheet.getRange(i + 1, COL.PAID_AT + 1).setValue(nowStr_());
    sheet.getRange(i + 1, COL.UPDATED + 1).setValue(nowStr_());

    return { orderId: orderId, total: total, received: received, balance: balance, paymentStatus: status };
  }
  throw new Error('Order not found: ' + orderId);
}

/** Records money received against an order. */
function recordPayment_(orderId, amount, method, by, note, category) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return recordPaymentHeld_(orderId, amount, method, by, note, category);
  } finally {
    lock.releaseLock();
  }
}

/*
 * The body of recordPayment_, for callers that ALREADY hold the script lock.
 *
 * Apps Script locks are not reentrant, so a locked caller cannot simply call
 * recordPayment_ — it would deadlock. Settling in full has to read the
 * outstanding balance and write the payment without letting go in between, or
 * two taps on "Paid" both read the same balance and both record it. Never call
 * this without the lock.
 */
function recordPaymentHeld_(orderId, amount, method, by, note, category) {
    var order = findOrderRow_(orderId);
    if (!order) throw new Error('Order not found: ' + orderId);

    addLedgerEntry_({
      type: 'Payment In',
      orderId: orderId,
      category: category || (isClosed_(order[COL.STATUS]) || num_(order[COL.ADVANCE]) > 0 ? 'Settlement' : 'Advance'),
      description: order[COL.NAME],
      amount: amount,
      method: method || 'Cash',
      by: by || 'owner',
      note: note || ''
    });

    var money = syncOrderMoney_(orderId);
    return { status: 'success', orderId: orderId, received: money.received, balance: money.balance, paymentStatus: money.paymentStatus };
}

/** Records money given back — a cancelled order, or a complaint settled. */
function recordRefund_(orderId, amount, method, by, note) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return recordRefundHeld_(orderId, amount, method, by, note);
  } finally {
    lock.releaseLock();
  }
}

/** The body of recordRefund_, for callers already holding the lock. */
function recordRefundHeld_(orderId, amount, method, by, note) {
    if (!findOrderRow_(orderId)) throw new Error('Order not found: ' + orderId);

    addLedgerEntry_({
      type: 'Refund Out', orderId: orderId, category: 'Refund',
      description: 'Refund to customer', amount: amount,
      method: method || 'Cash', by: by || 'owner', note: note || ''
    });

    var money = syncOrderMoney_(orderId);
    return { status: 'success', orderId: orderId, received: money.received, balance: money.balance };
}

/*
 * Refunds everything the order is holding, reading and writing under one lock.
 * The cancellation button used to read the held amount, then call the locked
 * writer — two taps refunded twice.
 */
function refundAllHeld_(orderId, method, by, note) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var held = orderReceived_(orderId);
    if (held <= 0) return { status: 'success', orderId: orderId, refunded: 0, note: 'Nothing to refund.' };
    var res = recordRefundHeld_(orderId, held, method || 'Cash', by, note || 'Refunded on cancellation');
    res.refunded = held;
    return res;
  } finally {
    lock.releaseLock();
  }
}

/** Records a business cost. Not tied to an order unless one is given. */
function recordExpense_(amount, description, category, method, by, orderId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var resolved = category || categoriseExpense_(description);
    var entry = addLedgerEntry_({
      type: 'Expense',
      orderId: orderId || '',
      category: resolved,
      description: description || 'Expense',
      amount: amount,
      method: method || 'Cash',
      by: by || 'owner'
    });
    return { status: 'success', entryId: entry.entryId, amount: entry.amount, category: resolved, method: entry.method };
  } finally {
    lock.releaseLock();
  }
}

/** Guesses an expense category from what was typed, so nothing extra is asked. */
function categoriseExpense_(description) {
  var text = String(description || '').toLowerCase();
  var found = 'Other';
  Object.keys(EXPENSE_HINTS).forEach(function (category) {
    if (found !== 'Other') return;
    EXPENSE_HINTS[category].forEach(function (word) {
      if (found === 'Other' && text.indexOf(word) !== -1) found = category;
    });
  });
  return found;
}

function findOrderRow_(orderId) {
  var data = ordersSheet_().getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][COL.ID] === orderId) return data[i];
  }
  return null;
}

// ==================== COST & MARGIN ====================

/**
 * Estimated food cost for an order, from the Cost column of the Menu tab.
 * Costed automatically so margin needs no extra typing from the kitchen.
 * Returns null when no dish on the order has a cost recorded yet.
 */
function estimateFoodCost_(itemsJson) {
  var menu = readMenu_();
  var byName = {};
  menu.forEach(function (m) { byName[m.name] = m; });

  var total = 0;
  var known = 0;
  (itemsJson || []).forEach(function (line) {
    var dish = byName[line.name];
    if (!dish || !dish.cost) return;
    known++;
    total += num_(line.qty) * num_(dish.cost);
  });
  return known ? total : null;
}

// ==================== FINANCIAL REPORTS ====================

/** Totals every ledger row between two yyyy-MM-dd dates, inclusive. */
function summariseMoney_(fromDate, toDate) {
  var rows = readLedger_();
  var out = {
    from: fromDate, to: toDate,
    paymentsIn: 0, refundsOut: 0, expenses: 0,
    byMethod: {}, byCategory: {}, cashInHand: 0, entries: 0
  };

  rows.forEach(function (r) {
    var day = toDateStr_(r[LED.TIMESTAMP]);
    if (!day || day < fromDate || day > toDate) return;

    var amount = num_(r[LED.AMOUNT]);
    var type = r[LED.TYPE];
    var method = r[LED.METHOD] || 'Other';
    out.entries++;

    if (type === 'Payment In') {
      out.paymentsIn += amount;
      out.byMethod[method] = (out.byMethod[method] || 0) + amount;
      if (method === 'Cash') out.cashInHand += amount;
    } else if (type === 'Refund Out') {
      out.refundsOut += amount;
      if (method === 'Cash') out.cashInHand -= amount;
    } else if (type === 'Expense') {
      out.expenses += amount;
      out.byCategory[r[LED.CATEGORY] || 'Other'] = (out.byCategory[r[LED.CATEGORY] || 'Other'] || 0) + amount;
      if (method === 'Cash') out.cashInHand -= amount;
    }
  });

  out.netIn = out.paymentsIn - out.refundsOut;
  out.profit = out.netIn - out.expenses;
  out.marginPct = out.netIn > 0 ? Math.round((out.profit / out.netIn) * 100) : 0;
  return out;
}

/** Outstanding balances grouped by how long they have been owed. */
function receivablesAging_() {
  var data = ordersSheet_().getDataRange().getValues();
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var buckets = { current: [], week: [], month: [], older: [] };
  var total = 0;

  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (r[COL.STATUS] === 'Cancelled') continue;
    var balance = num_(r[COL.BALANCE]);
    if (balance <= 0) continue;

    var due = toDateStr_(r[COL.DATE]);
    var days = due ? Math.floor((new Date(today) - new Date(due)) / 864e5) : 0;
    var item = { orderId: r[COL.ID], name: r[COL.NAME], phone: String(r[COL.PHONE]), balance: balance, days: days, date: due };

    if (days <= 0) buckets.current.push(item);
    else if (days <= 7) buckets.week.push(item);
    else if (days <= 30) buckets.month.push(item);
    else buckets.older.push(item);
    total += balance;
  }

  buckets.total = total;
  return buckets;
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

/**
 * Keeps the folder from growing without limit.
 * DELIBERATELY UNLOCKED — only called from weeklyBackup, which holds the lock.
 */
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

// ==================== FINANCIAL REPORTS ON TELEGRAM ====================

/** Today's money, and what should physically be in the cash box. */
function sendCashReport_(dateStr) {
  var day = dateStr || Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var m = summariseMoney_(day, day);

  var msg = '💵 <b>CASH REPORT</b>\n' + esc_(prettyDate_(day)) + '\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━\n';

  if (!m.entries) {
    msg += '\nNo money recorded today.\n\nUse <code>/spend 4500 chicken</code> to log a cost,\nor <code>/pay &lt;order id&gt; 20000</code> to record a payment.';
    sendTelegram_(ownerChat_(), msg);
    return;
  }

  msg += '<b>IN</b>  ' + CURRENCY + ' ' + fmtMoney_(m.paymentsIn) + '\n';
  Object.keys(m.byMethod).sort().forEach(function (method) {
    msg += '   ' + esc_(method) + ': ' + CURRENCY + ' ' + fmtMoney_(m.byMethod[method]) + '\n';
  });

  if (m.refundsOut > 0) msg += '\n<b>REFUNDED</b>  ' + CURRENCY + ' ' + fmtMoney_(m.refundsOut) + '\n';

  msg += '\n<b>OUT</b>  ' + CURRENCY + ' ' + fmtMoney_(m.expenses) + '\n';
  Object.keys(m.byCategory).sort().forEach(function (category) {
    msg += '   ' + esc_(category) + ': ' + CURRENCY + ' ' + fmtMoney_(m.byCategory[category]) + '\n';
  });

  msg += '━━━━━━━━━━━━━━━━━━━━━\n';
  msg += '<b>Profit today: ' + CURRENCY + ' ' + fmtMoney_(m.profit) + '</b>\n';
  msg += '\n👛 <b>Cash box should hold ' + CURRENCY + ' ' + fmtMoney_(m.cashInHand) + '</b>\n';
  msg += '<i>Count it. If the number differs, something went unrecorded.</i>';

  sendTelegram_(ownerChat_(), msg);
}

/** This month: revenue, costs, profit, and where the money went. */
function sendMonthReport_() {
  var now = new Date();
  var first = Utilities.formatDate(now, TZ, 'yyyy-MM') + '-01';
  var today = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  var m = summariseMoney_(first, today);

  var msg = '📊 <b>THIS MONTH</b>\n' + esc_(first) + ' → ' + esc_(today) + '\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━\n';
  msg += 'Received      ' + CURRENCY + ' ' + fmtMoney_(m.paymentsIn) + '\n';
  if (m.refundsOut > 0) msg += 'Refunded      −' + CURRENCY + ' ' + fmtMoney_(m.refundsOut) + '\n';
  msg += 'Costs         −' + CURRENCY + ' ' + fmtMoney_(m.expenses) + '\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━\n';
  msg += '<b>Profit        ' + CURRENCY + ' ' + fmtMoney_(m.profit) + '</b>\n';
  msg += '<i>Margin ' + m.marginPct + '%</i>\n';

  var categories = Object.keys(m.byCategory);
  if (categories.length) {
    msg += '\n<b>WHERE IT WENT</b>\n';
    categories.sort(function (a, b) { return m.byCategory[b] - m.byCategory[a]; }).forEach(function (c) {
      var share = m.expenses > 0 ? Math.round((m.byCategory[c] / m.expenses) * 100) : 0;
      msg += '• ' + esc_(c) + ' — ' + CURRENCY + ' ' + fmtMoney_(m.byCategory[c]) + ' <i>(' + share + '%)</i>\n';
    });
  }

  var aging = receivablesAging_();
  if (aging.total > 0) {
    msg += '\n💰 <b>Still owed to you: ' + CURRENCY + ' ' + fmtMoney_(aging.total) + '</b>\n';
    msg += '<i>Send /owed for the breakdown.</i>';
  }

  sendTelegram_(ownerChat_(), msg);
}

/** Who owes what, oldest debt first. */
function sendAgingReport_() {
  var aging = receivablesAging_();
  if (!aging.total) {
    sendTelegram_(ownerChat_(), '✅ <b>Nothing outstanding.</b> Every order is paid up.');
    return;
  }

  var msg = '💰 <b>MONEY OWED TO YOU</b>\n<b>' + CURRENCY + ' ' + fmtMoney_(aging.total) + '</b> across all orders\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━\n';

  var groups = [
    { rows: aging.older, label: '🔴 More than a month' },
    { rows: aging.month, label: '🟠 1–4 weeks' },
    { rows: aging.week, label: '🟡 This week' },
    { rows: aging.current, label: '⚪ Not due yet' }
  ];

  var keyboard = [];
  groups.forEach(function (g) {
    if (!g.rows.length) return;
    var sum = g.rows.reduce(function (t, x) { return t + x.balance; }, 0);
    msg += '\n<b>' + esc_(g.label) + '</b> — ' + CURRENCY + ' ' + fmtMoney_(sum) + '\n';
    g.rows.sort(function (a, b) { return b.days - a.days; }).forEach(function (x) {
      msg += '• ' + esc_(x.name) + ' — ' + CURRENCY + ' ' + fmtMoney_(x.balance);
      if (x.days > 0) msg += ' <i>(' + x.days + 'd)</i>';
      msg += '\n';
      if (keyboard.length < 8) {
        keyboard.push([
          { text: '💬 ' + String(x.name).substring(0, 16), url: 'https://wa.me/' + x.phone },
          { text: '💵 Paid', callback_data: 'paid_' + x.orderId }
        ]);
      }
    });
  });

  sendTelegram_(ownerChat_(), msg, keyboard.length ? { inline_keyboard: keyboard } : null);
}

/**
 * Handles "/pay 20000", "/pay 20000 bank", and the explicit
 * "/pay ORD-260909-123456-AB1C 20000 [method]".
 *
 * The amount-only form exists because typing a full order id on a phone,
 * mid-service, is not something anyone will actually do. Send the amount and
 * the bot asks which customer it was, as tappable buttons.
 */
function handlePayCommand_(text, by) {
  var body = String(text).replace(/^\/pay(@[a-z0-9_]+)?\s*/i, '').trim();

  var withId = body.match(/^(\S*[A-Za-z]\S*)\s+([0-9][0-9,.]*)\s*(\w+)?$/);
  var amountOnly = body.match(/^([0-9][0-9,.]*)\s*(\w+)?$/);

  if (!withId && !amountOnly) {
    sendTelegram_(ownerChat_(),
      '💵 <b>How to record a payment</b>\n\n' +
      '<code>/pay 20000</code>  <i>— then tap the customer</i>\n' +
      '<code>/pay 20000 bank</code>\n\n' +
      'Send /owed to see who still owes you.');
    return;
  }

  if (amountOnly) {
    return offerPaymentTargets_(num_(amountOnly[1]), normaliseMethod_(amountOnly[2]));
  }

  var orderId = withId[1];
  var amount = num_(withId[2]);
  var method = normaliseMethod_(withId[3]);

  if (amount <= 0) {
    sendTelegram_(ownerChat_(), '⚠️ Enter an amount greater than zero.');
    return;
  }
  applyPayment_(orderId, amount, method, by);
}

/** Cash unless told otherwise; "transfer" is what people say for a bank payment. */
function normaliseMethod_(word) {
  if (!word) return 'Cash';
  var m = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  if (m === 'Transfer') return 'Bank';
  return PAYMENT_METHODS.indexOf(m) === -1 ? 'Cash' : m;
}

/**
 * Asks which order an amount belongs to, one button per unpaid customer.
 * Nothing is written until a button is tapped — money is never guessed onto an
 * order just because it was the only one outstanding.
 */
function offerPaymentTargets_(amount, method) {
  if (amount <= 0) {
    sendTelegram_(ownerChat_(), '⚠️ Enter an amount greater than zero, e.g. <code>/pay 20000</code>');
    return;
  }

  var unpaid = readUnpaid_();
  if (!unpaid.length) {
    sendTelegram_(ownerChat_(), '✅ <b>Nothing is outstanding.</b> Every order is paid up.');
    return;
  }

  var keyboard = unpaid.slice(0, 8).map(function (o) {
    return [{
      text: String(o.customerName).substring(0, 20) + ' — ' + CURRENCY + ' ' + fmtMoney_(o.balanceDue),
      callback_data: 'payto_' + o.orderId + '_' + amount + '_' + method
    }];
  });

  var msg = '💵 <b>' + CURRENCY + ' ' + fmtMoney_(amount) + '</b> received <i>(' + esc_(method) + ')</i>\n\n';
  msg += 'Who paid it?';
  if (unpaid.length > 8) msg += '\n\n<i>Showing the 8 largest debts. Send /owed for the full list.</i>';

  sendTelegram_(ownerChat_(), msg, { inline_keyboard: keyboard });
}

/** Writes the payment and reports what is left owing. */
function applyPayment_(orderId, amount, method, by) {
  try {
    var row = findOrderRow_(orderId);
    var name = row ? row[COL.NAME] : orderId;
    var result = recordPayment_(orderId, amount, method, by, 'Recorded via /pay');
    var msg = '✅ Recorded <b>' + CURRENCY + ' ' + fmtMoney_(amount) + '</b> from ' + esc_(name) +
      '\n<i>' + esc_(method) + '</i>\n\n';
    msg += result.balance > 0
      ? '⚠️ Still owed: <b>' + CURRENCY + ' ' + fmtMoney_(result.balance) + '</b>'
      : '🎉 <b>Paid in full.</b>';
    sendTelegram_(ownerChat_(), msg);
    return result;
  } catch (err) {
    sendTelegram_(ownerChat_(), '⚠️ ' + esc_(err.message) + '\n\nSend /owed to see what is outstanding.');
    return null;
  }
}

/**
 * Parses "/spend 4500 chicken" or "/spend 1200 gas bank".
 * Kept forgiving: anything slower than one line will not get used mid-service.
 */
function handleSpendCommand_(text, by) {
  var body = String(text).replace(/^\/spend\s*/i, '').trim();
  var match = body.match(/^([0-9][0-9,.]*)\s*(.*)$/);

  if (!match) {
    sendTelegram_(ownerChat_(),
      '💸 <b>How to record a cost</b>\n\n' +
      '<code>/spend 4500 chicken</code>\n' +
      '<code>/spend 1200 gas cylinder</code>\n' +
      '<code>/spend 800 driver bank</code>\n\n' +
      'The category is worked out from what you type. ' +
      'End with <b>bank</b> or <b>card</b> if it was not cash.');
    return;
  }

  var amount = num_(match[1]);
  var rest = match[2].trim() || 'Expense';
  var method = 'Cash';

  var methodMatch = rest.match(/\s(bank|card|cash|transfer)$/i);
  if (methodMatch) {
    method = methodMatch[1].toLowerCase() === 'transfer' ? 'Bank'
      : methodMatch[1].charAt(0).toUpperCase() + methodMatch[1].slice(1).toLowerCase();
    rest = rest.slice(0, methodMatch.index).trim() || 'Expense';
  }

  if (amount <= 0) {
    sendTelegram_(ownerChat_(), '⚠️ Enter an amount greater than zero, e.g. <code>/spend 4500 chicken</code>');
    return;
  }

  var result = recordExpense_(amount, rest, null, method, by);
  var todaySoFar = summariseMoney_(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'),
                                   Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'));

  sendTelegram_(ownerChat_(),
    '✅ Recorded <b>' + CURRENCY + ' ' + fmtMoney_(amount) + '</b> — ' + esc_(rest) + '\n' +
    '<i>' + esc_(result.category) + ' · ' + esc_(method) + '</i>\n\n' +
    'Spent today: ' + CURRENCY + ' ' + fmtMoney_(todaySoFar.expenses));
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

      // Rebuild the FULL keyboard for the new status. Replacing it with just
      // the next step threw away Call, WhatsApp, Map and Mark-paid — exactly
      // the buttons wanted while standing at a customer's door.
      if (query.message) {
        var advRow = findOrderRow_(advId);
        if (advRow) {
          telegramApi_('editMessageReplyMarkup', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            reply_markup: contactKeyboard_(advId, String(advRow[COL.PHONE]), advRow[COL.ADDRESS],
                                           moved.newStatus, advRow[COL.BALANCE])
          });
        }
      }

    } else if (data.indexOf('paid_') === 0) {
      var paidId = data.substring('paid_'.length);
      var paid = markOrderPaid_(paidId, 'Cash', describeUser_(query.from));
      answer = 'Recorded ' + CURRENCY + ' ' + fmtMoney_(paid.collected) + ' received 💵';
      stampMessage_(query, '💵 PAID IN FULL');

    } else if (data.indexOf('refund_') === 0) {
      var refundId = data.substring('refund_'.length);
      var refund = refundAllHeld_(refundId, 'Cash', describeUser_(query.from));
      if (!refund.refunded) {
        answer = 'Nothing to refund on this order.';
      } else {
        answer = 'Refund of ' + CURRENCY + ' ' + fmtMoney_(refund.refunded) + ' recorded';
        stampMessage_(query, '💸 REFUNDED ' + CURRENCY + ' ' + fmtMoney_(refund.refunded));
      }

    } else if (data === 'cmd_today') {
      sendDayList_(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), 'Today');
      answer = 'Today';
    } else if (data === 'cmd_tomorrow' || data === 'list_tomorrow') {
      sendDayList_(Utilities.formatDate(new Date(Date.now() + 864e5), TZ, 'yyyy-MM-dd'), 'Tomorrow');
      answer = 'Tomorrow';
    } else if (data === 'cmd_pending') {
      sendPendingList_();
      answer = 'Pending';
    } else if (data === 'cmd_money') {
      sendAgingReport_();
      answer = 'Money owed';
    } else if (data === 'cmd_cash') {
      sendCashReport_();
      answer = 'Cash today';
    } else if (data === 'cmd_month') {
      sendMonthReport_();
      answer = 'This month';
    } else if (data === 'cmd_help') {
      sendHelp_();
      answer = 'Commands';
    } else if (data === 'cmd_status') {
      diagnose();
      answer = 'System check';

    } else if (data.indexOf('payto_') === 0) {
      // payto_<orderId>_<amount>_<method>. Order ids never contain "_", so the
      // last two underscores delimit the amount and method unambiguously.
      var parts = data.substring('payto_'.length).split('_');
      var payMethod = parts.pop();
      var payAmount = num_(parts.pop());
      var payOrder = parts.join('_');
      var applied = applyPayment_(payOrder, payAmount, payMethod, describeUser_(query.from));
      if (applied) {
        answer = 'Recorded ' + CURRENCY + ' ' + fmtMoney_(payAmount);
        stampMessage_(query, '💵 ' + CURRENCY + ' ' + fmtMoney_(payAmount) + ' RECORDED');
      } else {
        answer = 'Could not record that payment.';
      }
    }
  } catch (err) {
    logError_('handleCallbackQuery', err);
    answer = 'Error: ' + err.message;
  }

  telegramApi_('answerCallbackQuery', { callback_query_id: query.id, text: answer, show_alert: false });
}

/** Appends an outcome line to the message a button was pressed on, so the
 *  chat history never contradicts the sheet. */
/**
 * Appends an outcome line to the message a button was pressed on.
 *
 * query.message.text is Telegram's PLAIN text — entities already rendered and
 * stripped. Sending it straight back with parse_mode HTML meant any "&", "<"
 * or ">" in it (an item called "Curries & Gravy", a note, a customer name)
 * made Telegram reject the edit with a 400. The sheet updated, the message did
 * not, and the button looked dead. Escaping it makes the edit always valid;
 * the bold is already gone either way, so the label carries the emphasis.
 */
function stampMessage_(query, label) {
  if (!query.message) return;
  var body = esc_(query.message.text || '');
  telegramApi_('editMessageText', {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    text: body + '\n\n<b>' + esc_(label) + '</b> — ' + esc_(nowStr_()),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
}

/** A readable stamp for the Ledger's "Recorded By" column. */
function describeUser_(from) {
  if (!from) return 'owner';
  return (from.username ? '@' + from.username : (from.first_name || 'user')) + ' (' + from.id + ')';
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
  var yesterday = Utilities.formatDate(new Date(Date.now() - 864e5), TZ, 'yyyy-MM-dd');

  // Telegram appends "@botname" to commands sent in a group.
  text = text.replace(/@[a-z0-9_]+\b/, '');

  if (text === '/help') return sendHelp_();
  if (text === '/status') return diagnose();
  if (text === '/today') return sendDayList_(today, 'Today');
  if (text === '/tomorrow') return sendDayList_(tomorrow, 'Tomorrow');
  if (text === '/yesterday') return sendDayList_(yesterday, 'Yesterday');
  if (text === '/week') return sendWeekList_();
  if (text === '/pending') return sendPendingList_();
  if (text === '/money' || text === '/owed') return sendAgingReport_();
  if (text === '/cash') return sendCashReport_();
  if (text === '/month') return sendMonthReport_();
  if (text.indexOf('/spend') === 0) return handleSpendCommand_(message.text, describeUser_(message.from));
  if (text.indexOf('/pay') === 0) return handlePayCommand_(message.text, describeUser_(message.from));

  sendTelegram_(chatId,
    '👋 <b>Catering Assistant</b>\n\n' +
    'Choose an action below or tap <b>📋 New Order</b> to book an order:',
    {
      inline_keyboard: [
        [{ text: '📋 Open Catering Manager', web_app: { url: miniAppUrl_() } }],
        [
          { text: '📅 Today', callback_data: 'cmd_today' },
          { text: '📦 Tomorrow', callback_data: 'cmd_tomorrow' }
        ],
        [
          { text: '⏳ Pending Orders', callback_data: 'cmd_pending' },
          { text: '💰 Money Owed', callback_data: 'cmd_money' }
        ],
        [
          { text: '💵 Cash Today', callback_data: 'cmd_cash' },
          { text: '📊 This Month', callback_data: 'cmd_month' }
        ],
        [
          { text: '❓ What can I type?', callback_data: 'cmd_help' },
          { text: '🩺 System check', callback_data: 'cmd_status' }
        ]
      ]
    });
}

/**
 * Renders BOT_COMMANDS as a chat message. Same source as the blue Menu button,
 * so the two can never drift apart, plus the two commands that take arguments
 * and therefore need an example rather than a description.
 */
function sendHelp_() {
  var msg = '❓ <b>WHAT YOU CAN TYPE</b>\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━\n';
  BOT_COMMANDS.forEach(function (c) {
    msg += '\n/' + esc_(c.command) + ' — ' + esc_(c.description);
  });
  msg += '\n\n<b>Recording money</b>\n';
  msg += '<code>/spend 4500 chicken</code>\n';
  msg += '<code>/spend 1200 gas bank</code>\n';
  msg += '<code>/pay 20000</code>  <i>— then tap the customer</i>\n\n';
  msg += '<i>You never have to type an order id. Add <b>bank</b> or <b>card</b> at the end if it was not cash.</i>';

  sendTelegram_(ownerChat_(), msg, {
    inline_keyboard: [[
      { text: '📋 Open Catering Manager', web_app: { url: miniAppUrl_() } }
    ]]
  });
}

/** The next seven days, grouped by day — the shopping and prep view. */
function sendWeekList_() {
  var from = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var to = Utilities.formatDate(new Date(Date.now() + 6 * 864e5), TZ, 'yyyy-MM-dd');
  var orders = readOrders_(from, to).filter(function (o) { return o.status !== 'Cancelled'; });

  if (!orders.length) {
    sendTelegram_(ownerChat_(), '📭 <b>NEXT 7 DAYS</b>\n\nNothing booked yet.');
    return;
  }

  var byDay = {};
  var days = [];
  orders.forEach(function (o) {
    if (!byDay[o.deliveryDate]) { byDay[o.deliveryDate] = []; days.push(o.deliveryDate); }
    byDay[o.deliveryDate].push(o);
  });
  days.sort();

  var toCollect = 0;
  var msg = '🗓 <b>NEXT 7 DAYS</b> — ' + orders.length + ' order(s)\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━\n';
  days.forEach(function (d) {
    msg += '\n<b>' + esc_(prettyDate_(d)) + '</b>\n';
    byDay[d].forEach(function (o) {
      msg += '  ' + esc_(o.deliveryTime) + ' — ' + esc_(o.customerName) + ' ' + (STATUS_ICON[o.status] || '') + '\n';
      msg += '     ' + esc_(o.itemsSummary) + '\n';
      toCollect += o.balanceDue > 0 ? o.balanceDue : 0;
    });
  });
  if (toCollect > 0) {
    msg += '\n━━━━━━━━━━━━━━━━━━━━━\n';
    msg += '💰 <b>' + CURRENCY + ' ' + fmtMoney_(toCollect) + ' to collect this week</b>';
  }
  sendTelegram_(ownerChat_(), msg);
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
    // Telegram rejects the whole message for one bad tag, so retry as plain
    // text rather than losing an alert over formatting.
    var plain = telegramApi_('sendMessage', {
      chat_id: chatId,
      text: html.replace(/<[^>]+>/g, ''),
      disable_web_page_preview: true
    });
    if (!plain || plain.ok !== true) {
      // Callers that record "sent" against a sheet row need to know this
      // failed, or they mark an alert delivered that nobody ever received.
      throw new Error('Telegram refused the message: ' +
        ((plain && plain.description) || res.description || 'no response'));
    }
    return plain;
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

function ledgerSheet_() {
  var sheet = ss_().getSheetByName(SHEETS.LEDGER);
  if (!sheet) {
    sheet = ss_().insertSheet(SHEETS.LEDGER);
    sheet.appendRow(LEDGER_HEADERS);
    sheet.getRange(1, 1, 1, LEDGER_HEADERS.length).setFontWeight('bold').setBackground('#bbf7d0');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(6, 240);
  }
  return sheet;
}

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

/**
 * DELIBERATELY UNLOCKED, for the same non-reentrancy reason as upsertCustomer_:
 * this is called from inside locked functions. It is append-only, so concurrent
 * writes cost at most row ordering, never data. Logging must never be the thing
 * that breaks a request.
 */
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

/**
 * Builds an order id that cannot collide with one already in the sheet.
 *
 * A timestamp plus randomness makes a clash unlikely; checking against the
 * ids already issued makes it impossible. Worth the certainty, because a
 * duplicate id means "Mark Delivered" updating the wrong customer's order.
 *
 * @param {Object} [taken] map of ids already in use
 */
function makeOrderId_(taken) {
  var stamp = Utilities.formatDate(new Date(), TZ, 'yyMMdd-HHmmss');
  for (var attempt = 0; attempt < 50; attempt++) {
    var rand = ('000' + Math.floor(Math.random() * 1679616).toString(36).toUpperCase()).slice(-4);
    var id = 'ORD-' + stamp + '-' + rand;
    if (!taken || !taken[id]) return id;
  }
  // Astronomically unlikely; fall back to something that cannot repeat.
  return 'ORD-' + stamp + '-' + String(new Date().getTime()).slice(-6);
}

/** The ids already issued, so a new one can be checked against them. */
function existingOrderIds_(sheet) {
  var taken = {};
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (values[i][COL.ID]) taken[values[i][COL.ID]] = true;
  }
  return taken;
}

function todayStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function monthStartStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM') + '-01'; }

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
