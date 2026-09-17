#!/usr/bin/env node
/**
 * Is every business running the current backend?
 *
 *   node tools/instances.js
 *
 * Each business is a separate Google Apps Script deployment, and Apps Script
 * has no way to push an update to one — every deployment is a manual paste.
 * With two tenants that is already easy to lose track of, and the only other
 * way to ask is /status, which answers over Telegram and is therefore silent
 * in exactly the situation you most need it.
 *
 * Reads the TENANTS map out of index.html so a business cannot be onboarded
 * and then forgotten by this check, and the expected version out of the
 * backend. No dependencies and no build step, matching test/run.js.
 *
 * Exits non-zero if any instance is stale or unreachable, so it can gate a
 * release if anyone wants it to.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TIMEOUT_MS = 20000;

const ESC = '\x1b[';
const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColour ? ESC + code + 'm' + s + ESC + '0m' : s);
const green = s => c('32', s);
const red = s => c('31', s);
const yellow = s => c('33', s);
const dim = s => c('2', s);
const bold = s => c('1', s);

/**
 * The TENANTS object literal, read from index.html.
 *
 * Deliberately evaluates only that one literal rather than booting the app:
 * the rest of the file expects a browser, and a config check should not
 * depend on a DOM.
 */
function readTenants() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const start = html.indexOf('var TENANTS = {');
  if (start === -1) throw new Error('No TENANTS map found in index.html.');

  // Walk the braces so a nested object or a comment cannot end it early.
  const open = html.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error('TENANTS map in index.html is not closed.');

  // eslint-disable-next-line no-new-func
  return new Function('return ' + html.slice(open, end + 1) + ';')();
}

function readExpectedVersion() {
  const src = fs.readFileSync(path.join(ROOT, 'backend', 'google_apps_script.js'), 'utf8');
  const m = /^var VERSION = '([^']+)'/m.exec(src);
  if (!m) throw new Error('No VERSION constant found in the backend.');
  return m[1];
}

async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url + '?action=health', { redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) return { error: 'HTTP ' + res.status };
    const body = await res.json();
    if (body.status !== 'ok') return { error: body.message || 'not ok' };
    return { version: body.version || null, timezone: body.timezone };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const tenants = readTenants();
  const expected = readExpectedVersion();
  const ids = Object.keys(tenants);

  console.log('\n  Repo expects ' + bold(expected) + dim('  (VERSION in backend/google_apps_script.js)\n'));

  const results = await Promise.all(ids.map(async id => {
    return { id, name: tenants[id].name, ...(await probe(tenants[id].url)) };
  }));

  const width = Math.max(8, ...results.map(r => String(r.name).length));
  let problems = 0;

  for (const r of results) {
    const name = String(r.name).padEnd(width);
    if (r.error) {
      problems++;
      console.log('  ' + name + '  ' + '—'.padEnd(14) + red('UNREACHABLE') + dim(' — ' + r.error));
    } else if (!r.version) {
      problems++;
      console.log('  ' + name + '  ' + '—'.padEnd(14) + yellow('NO VERSION') +
        dim(' — predates this check; redeploy to report one'));
    } else if (r.version !== expected) {
      problems++;
      console.log('  ' + name + '  ' + r.version.padEnd(14) + red('STALE') +
        dim(' — redeploy: paste, then Manage deployments > edit > New version'));
    } else {
      console.log('  ' + name + '  ' + r.version.padEnd(14) + green('current'));
    }
  }

  console.log('');
  if (problems) {
    console.log('  ' + red(bold(problems + ' of ' + results.length + ' instance(s) need attention')) + '\n');
    process.exit(1);
  }
  console.log('  ' + green(bold('All ' + results.length + ' instance(s) current')) + '\n');
}

// Only probe the network when run directly. The parsers are exported so the
// test suite can check them against the real files without making requests.
if (require.main === module) {
  main().catch(err => {
    console.error('\n  ' + red('Could not run the check: ' + err.message) + '\n');
    process.exit(1);
  });
}

module.exports = { readTenants, readExpectedVersion };
