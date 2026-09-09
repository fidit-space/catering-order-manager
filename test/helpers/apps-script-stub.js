/**
 * A stand-in for the Google Apps Script runtime.
 *
 * The backend only ever runs inside Google's cloud, so testing it locally
 * means providing the services it calls: Sheets, Properties, Lock, Drive,
 * Mail and UrlFetch. Each suite calls install() to get a clean world.
 *
 * install() returns handles the tests assert against:
 *   SENT   — every Telegram API call made
 *   SS     — the fake spreadsheet
 *   MAILS  — every email sent
 *   DRIVE  — every file written
 */
function install() {
  const SENT = [];
const PROPS = {
  TELEGRAM_BOT_TOKEN: 'test:token',
  TELEGRAM_OWNER_CHAT_ID: '111',
  API_KEY: 'testkey',
  WEBHOOK_SECRET: 'whsecret'
};

function pad(n, w) { return String(n).padStart(w || 2, '0'); }

function partsIn(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short'
  });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';
  return o;
}

function tzOffsetMinutes(date, tz) {
  const p = partsIn(date, tz);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

const crypto = require('crypto');

  global.Utilities = {
    /** Real HMAC-SHA256, so the initData check is tested against the actual
     *  algorithm rather than a stand-in. Apps Script returns SIGNED bytes. */
    computeHmacSha256Signature(value, key) {
      const v = Buffer.isBuffer(value) ? value
        : Array.isArray(value) ? Buffer.from(value.map(b => b & 0xff))
        : Buffer.from(String(value), 'utf8');
      const k = Buffer.isBuffer(key) ? key
        : Array.isArray(key) ? Buffer.from(key.map(b => b & 0xff))
        : Buffer.from(String(key), 'utf8');
      const digest = crypto.createHmac('sha256', k).update(v).digest();
      return Array.from(digest).map(b => (b > 127 ? b - 256 : b));
    },
    newBlob(text) {
      return { getBytes: () => Array.from(Buffer.from(String(text), 'utf8')).map(b => (b > 127 ? b - 256 : b)) };
    },
  formatDate(date, tz, pattern) {
    const p = partsIn(date, tz);
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (pattern === 'Z') {
      const off = tzOffsetMinutes(date, tz);
      const sign = off < 0 ? '-' : '+';
      const a = Math.abs(off);
      return sign + pad(Math.floor(a / 60)) + pad(a % 60);
    }
    return pattern
      .replace('yyyy', p.year)
      .replace('yyMMdd', String(p.year).slice(2) + p.month + p.day)
      .replace('EEE', p.weekday)
      .replace('MMM', MON[+p.month - 1])
      .replace('MM', p.month)
      .replace('dd', p.day)
      .replace('HHmmss', p.hour + p.minute + p.second)
      .replace('HH', p.hour)
      .replace('mm', p.minute)
      .replace('ss', p.second);
  }
};

global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: k => (k in PROPS ? PROPS[k] : null),
    setProperty: (k, v) => { PROPS[k] = String(v); },
    deleteProperty: k => { delete PROPS[k]; },
    setProperties: o => Object.assign(PROPS, o)
  })
};

const CACHE = {};
  global.CacheService = {
    getScriptCache: () => ({
      get: k => (k in CACHE ? CACHE[k] : null),
      put: (k, v) => { CACHE[k] = String(v); },
      remove: k => { delete CACHE[k]; }
    })
  };

  global.LockService = {
  getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} })
};

global.ContentService = {
  MimeType: { JSON: 'json' },
  createTextOutput: t => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } })
};

// Lets a test put the webhook into a known bad state (a /dev URL) without
// reaching into the backend.
global.WEBHOOK_URL_OVERRIDE = null;
global.UrlFetchApp = {
  fetch(url, opts) {
    const method = url.split('/').pop();
    SENT.push({ method, payload: JSON.parse(opts.payload) });
    let result = {};
    if (method === 'getMe') result = { id: 8856703286, username: 'test_bot' };
    if (method === 'getWebhookInfo') {
      result = { url: global.WEBHOOK_URL_OVERRIDE ||
        'https://script.google.com/macros/s/TEST/exec?wh=whsecret', pending_update_count: 0 };
    }
    return { getContentText: () => JSON.stringify({ ok: true, result }) };
  }
};

global.Logger = { log: () => {} };
global.MimeType = { CSV: 'text/csv' };
global.Session = { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) };

const MAILS = [];
global.MailApp = { sendEmail: o => { MAILS.push(o); } };

const DRIVE = { files: [] };
function fakeFolder(name) {
  return {
    getName: () => name,
    createFile(fn, content) {
      const f = { name: fn, content, created: new Date(), trashed: false,
        getName: () => fn, getDateCreated: () => f.created,
        setTrashed(v) { f.trashed = v; } };
      DRIVE.files.push(f);
      return f;
    },
    getFiles() {
      const live = DRIVE.files.filter(f => !f.trashed);
      let i = 0;
      return { hasNext: () => i < live.length, next: () => live[i++] };
    }
  };
}
const FOLDER = fakeFolder('Catering Backups');
global.DriveApp = {
  getFoldersByName: () => ({ hasNext: () => true, next: () => FOLDER }),
  createFolder: n => fakeFolder(n)
};
// Overridable so a test can simulate the "/dev" head URL, and the missing
// triggers that went unnoticed for weeks in production.
global.SCRIPT_URL = 'https://script.google.com/macros/s/TEST/exec';
global.INSTALLED_TRIGGERS = [
  'checkDispatchAlerts', 'sendDailyPrepDigest', 'checkUnpaidBalances',
  'weeklyBackup', 'reportNewErrors'
];
global.ScriptApp = {
  getService: () => ({ getUrl: () => global.SCRIPT_URL }),
  getProjectTriggers: () => global.INSTALLED_TRIGGERS.map(fn => ({ getHandlerFunction: () => fn }))
};

// ---- Fake Spreadsheet ----
class FakeSheet {
  constructor(name) { this.name = name; this.rows = []; this.formats = {}; }
  getName() { return this.name; }
  appendRow(r) { this.rows.push(r.slice()); }
  getDataRange() { return this.getRange(1, 1, Math.max(this.rows.length, 1), 40); }
  getMaxRows() { return Math.max(this.rows.length, 100); }
  getLastColumn() { return this.rows.reduce((w, r) => Math.max(w, r.length), 0); }
  getLastRow() { return this.rows.length; }
  getRange(row, col, numRows = 1, numCols = 1) {
    const sheet = this;
    return {
      getSheet: () => sheet,
      getRow: () => row,
      getColumn: () => col,
      getNumRows: () => numRows,
      getNumColumns: () => numCols,
      getValue() {
        const src = sheet.rows[row - 1] || [];
        const v = src[col - 1];
        return v === undefined ? '' : v;
      },
      getNumberFormat() { return sheet.formats[row + ':' + col] || ''; },
      getValues() {
        const out = [];
        for (let i = 0; i < numRows; i++) {
          const src = sheet.rows[row - 1 + i] || [];
          out.push(src.slice(col - 1, col - 1 + numCols));
        }
        return out;
      },
      setValues(vals) {
        vals.forEach((v, i) => {
          const target = row - 1 + i;
          while (sheet.rows.length <= target) sheet.rows.push([]);
          v.forEach((cell, j) => { sheet.rows[target][col - 1 + j] = cell; });
        });
        return this;
      },
      setValue(v) { return this.setValues([[v]]); },
      setFontWeight() { return this; },
      setBackground() { return this; },
      setNumberFormat(fmt) {
        for (let i = 0; i < numRows; i++) {
          for (let j = 0; j < numCols; j++) sheet.formats[(row + i) + ':' + (col + j)] = fmt;
        }
        return this;
      }
    };
  }
  setFrozenRows() {} setColumnWidth() {}
  deleteRow(n) { this.rows.splice(n - 1, 1); }
}

class FakeSpreadsheet {
  constructor() { this.sheets = {}; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { return (this.sheets[n] = new FakeSheet(n)); }
  getSpreadsheetTimeZone() { return 'Asia/Colombo'; }
}

const SS = new FakeSpreadsheet();
global.SpreadsheetApp = { getActiveSpreadsheet: () => SS };

  return { SENT, SS, MAILS, DRIVE, PROPS };
}

/** Loads the real backend file into the caller's scope via eval. */
function backendSource() {
  const fs = require('fs');
  const path = require('path');
  return fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'google_apps_script.js'), 'utf8');
}

module.exports = { install, backendSource };
