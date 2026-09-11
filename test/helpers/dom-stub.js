/**
 * Just enough browser to boot the Mini App headlessly.
 *
 * The app is a single vanilla HTML file with no framework, so a real DOM is
 * overkill — it needs getElementById, a click/change listener, localStorage
 * and fetch. Adding jsdom would break the project's zero-dependency rule.
 */

const fs = require('fs');
const path = require('path');

function install() {
  const els = {};
  const alerts = [];
  const store = {};
  let fetchImpl = () => Promise.reject(new Error('no fetch configured for this test'));

  class El {
    constructor(id) {
      this.id = id;
      this.value = '';
      this.dataset = {};
      this._html = '';
      this.textContent = '';
      this.hidden = false;
      this.disabled = false;
      this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
    }
    set innerHTML(v) { this._html = String(v); }
    get innerHTML() { return this._html; }
    addEventListener() {}
    closest() { return null; }
  }

  const el = id => els[id] || (els[id] = new El(id));

  // location.search decides which business a launch belongs to, so a test has
  // to be able to set it.
  global.window = {
    Telegram: undefined,
    location: { search: '', href: 'https://fidit-space.github.io/catering-order-manager/' },
    addEventListener() {}, scrollTo() {}, open() {}
  };
  global.document = {
    getElementById: el,
    querySelectorAll: () => [],
    addEventListener() {},
    body: new El('body')
  };
  global.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };
  global.alert = msg => { alerts.push(String(msg)); };
  global.fetch = (...a) => fetchImpl(...a);

  return {
    el,
    alerts,
    store,
    /** Point the app at a canned server response. */
    serve(impl) { fetchImpl = impl; },
    /** Everything the app has shown the user, as one string. */
    saidToUser() { return alerts.join(' '); },
    clearAlerts() { alerts.length = 0; }
  };
}

/** The Mini App's inline script, lifted out of index.html. */
function appSource() {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  return html.split('<script>').pop().split('</script>')[0];
}

module.exports = { install, appSource };
