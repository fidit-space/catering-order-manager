/**
 * Suite for multi-business routing.
 *
 * One page, one GitHub Pages URL, one codebase — but each business has its own
 * Google Sheet, its own bot and its own Apps Script deployment. Which backend a
 * launch talks to is decided entirely by ?client= on the URL the bot opens.
 *
 * The failure this suite exists to prevent is a quiet one: a bot whose Menu
 * Button lost its ?client= opens SOMEBODY ELSE'S backend, and real orders get
 * written into the wrong business's books with nothing on screen to say so.
 */

const dom = require('./helpers/dom-stub.js');
const stub = require('./helpers/apps-script-stub.js');
const fs = require('fs');
const path = require('path');

module.exports = function (t) {
  const page = dom.install();
  const el = page.el;
  const source = dom.appSource();

  // Booting the app fires a menu fetch. Answer it so the suite does not print
  // a warning for every launch; this suite is about routing, not the menu.
  page.serve(() => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ status: 'ok', menu: [], statusFlow: [], statusIcons: {} })
  }));

  /** Boots the app as if opened at this URL, and returns what it resolved to. */
  function launchAt(search, startParam) {
    global.window.location = { search: search };
    global.window.Telegram = startParam
      ? { WebApp: { initDataUnsafe: { start_param: startParam }, ready() {}, expand() {} } }
      : undefined;
    const ctx = {};
    (function () { eval(source); ctx.tenant = TENANT; ctx.id = tenantId();
      ctx.url = APPS_SCRIPT_WEBAPP_URL; ctx.key = API_KEY;
      ctx.tenants = TENANTS; ctx.fallback = DEFAULT_TENANT; }).call(ctx);
    return ctx;
  }

  t.section('Resolving which business a launch belongs to');
  const bare = launchAt('');
  t.check('a bare URL resolves to the default', bare.id === bare.fallback, bare.id);
  t.check('and the default is never a live client',
    bare.fallback === 'demo', bare.fallback);

  const ids = Object.keys(bare.tenants);
  const other = ids.find(id => id !== bare.fallback);
  if (other) {
    t.check('?client=<id> reaches that business', launchAt('?client=' + other).id === other);
    t.check('it is case-insensitive',
      launchAt('?client=' + other.toUpperCase()).id === other);
    t.check('it works when it is not the first parameter',
      launchAt('?foo=1&client=' + other).id === other);
    t.check('start_param reaches it too, for a t.me deep link',
      launchAt('', other).id === other);
  } else {
    t.check('only one business is configured so far — routing still resolves',
      bare.id === bare.fallback);
  }

  t.section('An unrecognised business never reaches live books');
  // Every one of these must land on the default rather than guess, and the
  // default must be a demo. Guessing here means money in the wrong Sheet.
  ['?client=', '?client=nope', '?client=../../etc', '?client=demo%20', '?client=' + 'x'.repeat(64),
   '?client=__proto__', '?client=constructor', '?client=toString', '?notclient=demo']
    .forEach(function (search) {
      const got = launchAt(search);
      t.check('"' + search + '" falls back to ' + got.fallback,
        got.id === got.fallback, got.id);
    });

  t.section('Every configured business is usable and distinct');
  const entries = Object.keys(bare.tenants).map(id => ({ id, v: bare.tenants[id] }));
  entries.forEach(function (e) {
    t.check(e.id + ' has a name', typeof e.v.name === 'string' && e.v.name.length > 0);
    t.check(e.id + ' points at a real deployment',
      /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(e.v.url), e.v.url);
    t.check(e.id + ' has a key that was actually filled in',
      typeof e.v.key === 'string' && e.v.key.length > 0 && e.v.key.indexOf('PASTE_') !== 0, e.v.key);
  });

  // A copy-pasted entry is the easy mistake, and it would point two businesses
  // at one Sheet — the exact thing this whole design exists to prevent.
  const urls = entries.map(e => e.v.url);
  const keys = entries.map(e => e.v.key);
  t.check('no two businesses share a deployment URL',
    new Set(urls).size === urls.length, urls.join(' | '));
  t.check('no two businesses share an API key',
    new Set(keys).size === keys.length, keys.join(' | '));

  t.section('The business is named on screen');
  launchAt('');
  t.check('the label is filled in', el('instanceLabel').textContent.length > 0,
    el('instanceLabel').textContent);
  t.check('it is visible, not hidden', el('instanceLabel').hidden === false);
  t.check('it names the resolved business',
    el('instanceLabel').textContent === bare.tenant.name, el('instanceLabel').textContent);

  t.section('Each backend points its buttons at its own instance');
  const { PROPS } = stub.install();
  eval(stub.backendSource());

  t.check('with nothing set, it falls back to the shared page',
    miniAppUrl_() === 'https://fidit-space.github.io/catering-order-manager/', miniAppUrl_());

  PROPS.MINI_APP_URL = 'https://fidit-space.github.io/catering-order-manager/?client=royal';
  t.check('a client instance opens its own', miniAppUrl_() === PROPS.MINI_APP_URL, miniAppUrl_());

  const keyboard = JSON.stringify(sendHelp_.toString());
  t.check('the help keyboard asks for the URL rather than hard-coding one',
    keyboard.includes('miniAppUrl_()'), 'sendHelp_ still hard-codes a URL');

  PROPS.TENANT_NAME = 'Royal Catering';
  const report = diagnose();
  t.check('/status names the business', report.includes('Royal Catering'), report.slice(0, 200));
  t.check('/status states the running version', report.includes(VERSION), VERSION);
  t.check('/status states which page the buttons open', report.includes(PROPS.MINI_APP_URL));

  delete PROPS.MINI_APP_URL;
  t.check('an unset MINI_APP_URL is called out, since it opens the wrong app',
    /MINI_APP_URL is not set/.test(diagnose()));

  t.section('VERSION is a real marker, not a placeholder');
  t.check('it is set', typeof VERSION === 'string' && VERSION.length > 0, String(VERSION));
  t.check('it appears exactly once in the backend, as its definition',
    (fs.readFileSync(path.join(__dirname, '..', 'backend', 'google_apps_script.js'), 'utf8')
      .match(/var VERSION = /g) || []).length === 1);
};
