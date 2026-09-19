#!/usr/bin/env node
/**
 * Push the backend to every business, without pasting it anywhere.
 *
 *   node tools/deploy.js --auth          one-time: authorise this machine
 *   node tools/deploy.js --only demo     deploy one business
 *   node tools/deploy.js                 deploy all of them
 *   node tools/deploy.js --dry-run       say what it would do, change nothing
 *
 * WHY THIS EXISTS
 *
 * Nearly every incident this project has had traces to a human pasting 130KB
 * into an editor and clicking Deploy: a /dev URL registered silently, a "New
 * deployment" orphaning the webhook, a property saved as "/exec", a half paste
 * that left the file unparseable, two instances drifting out of step. At two
 * businesses that is tolerable. It is the thing that breaks at five.
 *
 * Uses the Apps Script REST API over plain fetch and node's own crypto — no
 * npm package, so ADR 001 holds. clasp would do this too and is forbidden for
 * exactly that reason.
 *
 * WHAT IT COSTS
 *
 * A Google OAuth refresh token stored on this machine. That is a more powerful
 * credential than anything else this project keeps locally: it can read and
 * rewrite the Apps Script projects it is scoped to. It lives in
 * tools/deploy.local.json, which is gitignored, and nothing here ever prints
 * it. Revoke it at myaccount.google.com/permissions.
 *
 * SETUP (once — see tools/DEPLOY_SETUP.md)
 *   1. Enable the Apps Script API at script.google.com/home/usersettings
 *   2. Create an OAuth client (Desktop app) in a Google Cloud project
 *   3. Put clientId, clientSecret and each business's scriptId in
 *      tools/deploy.local.json, then run --auth
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { readTenants, readExpectedVersion } = require('./instances.js');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(__dirname, 'deploy.local.json');
const BACKEND = path.join(ROOT, 'backend', 'google_apps_script.js');

const SCOPES = [
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments'
].join(' ');

const ESC = '\x1b[';
const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColour ? ESC + code + 'm' + s + ESC + '0m' : s);
const green = s => c('32', s);
const red = s => c('31', s);
const yellow = s => c('33', s);
const dim = s => c('2', s);
const bold = s => c('1', s);

// ---------------------------------------------------------------- config

function loadConfig() {
  if (!fs.existsSync(CONFIG)) {
    throw new Error('No ' + path.relative(ROOT, CONFIG) + '. See tools/DEPLOY_SETUP.md.');
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error('clientId and clientSecret missing from ' + path.relative(ROOT, CONFIG) + '.');
  }
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

// ---------------------------------------------------------------- oauth

/**
 * One-time authorisation, via a loopback redirect.
 *
 * Google removed the copy-a-code-from-the-browser flow in 2022, so this opens
 * a short-lived local server for the redirect. Nothing is listening after the
 * code arrives.
 */
async function authorise(cfg) {
  const server = http.createServer();
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const redirect = 'http://127.0.0.1:' + port;
  const state = crypto.randomBytes(16).toString('hex');

  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',           // force a refresh token even on re-auth
    state: state
  });

  console.log('\n  Open this in a browser signed in as the account that owns the scripts:\n');
  console.log('  ' + bold(url) + '\n');

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the browser')), 300000);
    server.on('request', (req, res) => {
      const q = new URL(req.url, redirect).searchParams;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      if (q.get('state') !== state) {
        res.end('State mismatch. Nothing was saved. Close this and try again.');
        clearTimeout(timer);
        return reject(new Error('state mismatch — the redirect did not come from this run'));
      }
      if (q.get('error')) {
        res.end('Refused: ' + q.get('error'));
        clearTimeout(timer);
        return reject(new Error('authorisation refused: ' + q.get('error')));
      }
      res.end('Authorised. You can close this tab and return to the terminal.');
      clearTimeout(timer);
      resolve(q.get('code'));
    });
  }).finally(() => server.close());

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: cfg.clientId, client_secret: cfg.clientSecret,
      redirect_uri: redirect, grant_type: 'authorization_code'
    })
  });
  const body = await res.json();
  if (!body.refresh_token) {
    throw new Error('Google returned no refresh token: ' + (body.error_description || body.error || 'unknown'));
  }

  cfg.refreshToken = body.refresh_token;
  saveConfig(cfg);
  console.log('  ' + green('Authorised.') + dim(' Token saved to ' + path.relative(ROOT, CONFIG) + ' (gitignored).\n'));
}

async function accessToken(cfg) {
  if (!cfg.refreshToken) throw new Error('Not authorised yet — run: node tools/deploy.js --auth');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId, client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken, grant_type: 'refresh_token'
    })
  });
  const body = await res.json();
  if (!body.access_token) {
    throw new Error('Could not refresh the token: ' + (body.error_description || body.error) +
      '. Re-run with --auth.');
  }
  return body.access_token;
}

// ---------------------------------------------------------------- api

async function api(token, method, url, payload) {
  const res = await fetch('https://script.googleapis.com/v1/' + url, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(payload ? { 'Content-Type': 'application/json' } : {})
    },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body.error && body.error.message) || ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return body;
}

// ---------------------------------------------------------------- deploy

/**
 * Replaces the script's source, cuts a version, and moves the live deployment
 * onto it.
 *
 * updateContent replaces EVERY file in the project, so the existing content is
 * fetched first and only the one server-side script is swapped — clobbering
 * appsscript.json would take the timezone and OAuth scopes with it. If the
 * project holds anything other than exactly one script file, this refuses
 * rather than guessing which to overwrite.
 */
async function deployTenant(token, id, name, scriptId, source, version, dryRun) {
  const label = '  ' + name.padEnd(16);

  const content = await api(token, 'GET', 'projects/' + scriptId + '/content');
  const files = content.files || [];
  const scripts = files.filter(f => f.type === 'SERVER_JS');

  if (scripts.length !== 1) {
    throw new Error('expected exactly one script file, found ' + scripts.length +
      ' (' + scripts.map(f => f.name).join(', ') + ') — deploy this one by hand');
  }
  if (scripts[0].source === source) {
    console.log(label + dim('source already identical — nothing to push'));
  }

  if (dryRun) {
    console.log(label + yellow('would push') + dim(' to ' + scripts[0].name + '.gs and cut a version'));
    return { skipped: true };
  }

  scripts[0].source = source;
  await api(token, 'PUT', 'projects/' + scriptId + '/content', { files });

  const created = await api(token, 'POST', 'projects/' + scriptId + '/versions', {
    description: 'Automated deploy — ' + version
  });

  // The web app deployment is the one that is not @HEAD. @HEAD is the /dev URL,
  // which Telegram cannot reach — moving that one would look like success and
  // change nothing.
  const list = await api(token, 'GET', 'projects/' + scriptId + '/deployments');
  const live = (list.deployments || []).filter(d =>
    d.deploymentConfig && d.deploymentConfig.versionNumber !== undefined);

  if (live.length !== 1) {
    throw new Error('expected exactly one versioned deployment, found ' + live.length +
      ' — pick the right one by hand, then re-run');
  }

  await api(token, 'PUT', 'projects/' + scriptId + '/deployments/' + live[0].deploymentId, {
    deploymentConfig: {
      scriptId: scriptId,
      versionNumber: created.versionNumber,
      manifestFileName: 'appsscript',
      description: 'Automated deploy — ' + version
    }
  });

  console.log(label + green('deployed') + dim(' version ' + created.versionNumber));
  return { versionNumber: created.versionNumber };
}

// ---------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

  const cfg = loadConfig();
  if (args.includes('--auth')) return authorise(cfg);

  const tenants = readTenants();
  const version = readExpectedVersion();
  const source = fs.readFileSync(BACKEND, 'utf8');

  const ids = Object.keys(tenants).filter(id => !only || id === only);
  if (only && !ids.length) {
    throw new Error('No business called "' + only + '". Known: ' + Object.keys(tenants).join(', '));
  }

  console.log('\n  Pushing ' + bold(version) + dim(' to ' + ids.length + ' business(es)') +
    (dryRun ? yellow('  [dry run]') : '') + '\n');

  const token = await accessToken(cfg);
  let failed = 0;

  // Deliberately sequential. If the first business breaks, the second should
  // still be running the last known-good build while it is investigated.
  for (const id of ids) {
    const scriptId = (cfg.scriptIds || {})[id];
    if (!scriptId) {
      console.log('  ' + tenants[id].name.padEnd(16) + red('no scriptId') +
        dim(' — add it to ' + path.relative(ROOT, CONFIG)));
      failed++;
      continue;
    }
    try {
      await deployTenant(token, id, tenants[id].name, scriptId, source, version, dryRun);
    } catch (err) {
      console.log('  ' + tenants[id].name.padEnd(16) + red('FAILED') + dim(' — ' + err.message));
      failed++;
    }
  }

  console.log('');
  if (failed) {
    console.log('  ' + red(bold(failed + ' business(es) not deployed')) + '\n');
    process.exit(1);
  }
  if (dryRun) {
    console.log('  ' + yellow('Dry run — nothing changed.') + '\n');
    return;
  }

  console.log(dim('  Verifying against the live health endpoints…'));
  await new Promise(r => setTimeout(r, 3000));   // the new version takes a moment to serve
  require('child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'instances.js')], { stdio: 'inherit' });
}

if (require.main === module) {
  main().catch(err => {
    console.error('\n  ' + red(err.message) + '\n');
    process.exit(1);
  });
}
