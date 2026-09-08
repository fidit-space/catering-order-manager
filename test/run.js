#!/usr/bin/env node
/**
 * Test runner for the Catering Order Manager.
 *
 *   node test/run.js            run everything
 *   node test/run.js backend    run only suites whose name matches
 *   node test/run.js --quiet    show failures and the summary only
 *
 * No dependencies and no build step, matching the rest of the project.
 * Exits non-zero if anything fails, so CI can gate on it.
 */

const fs = require('fs');
const path = require('path');
const { createSuite } = require('./helpers/harness.js');

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const filter = args.find(a => !a.startsWith('--'));

const ESC = '\x1b[';
const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColour ? ESC + code + 'm' + s + ESC + '0m' : s);
const green = s => c('32', s);
const red = s => c('31', s);
const dim = s => c('2', s);
const bold = s => c('1', s);

const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js'))
  .filter(f => !filter || f.includes(filter))
  .sort();

if (!files.length) {
  console.error('No test suites matched' + (filter ? ' "' + filter + '"' : '') + '.');
  process.exit(1);
}

function runSuite(file) {
  return new Promise(resolve => {
    const name = path.basename(file, '.test.js');
    const suite = createSuite(name);
    const fn = require(path.join(__dirname, file));

    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(suite.results); } };

    try {
      // A suite declaring a second parameter is asynchronous and calls done().
      if (fn.length > 1) {
        const guard = setTimeout(() => {
          suite.check('suite finished within 10 seconds', false, 'timed out');
          done();
        }, 10000);
        fn(suite, () => { clearTimeout(guard); done(); });
      } else {
        fn(suite);
        done();
      }
    } catch (err) {
      suite.check('suite ran without throwing', false,
        err && err.stack ? err.stack.split('\n')[0] : String(err));
      console.error(red('\n  ' + name + ' threw:'));
      console.error(err);
      done();
    }
  });
}

(async function main() {
  const started = Date.now();
  const all = [];

  for (const file of files) {
    const r = await runSuite(file);
    all.push(r);

    console.log('\n' + bold(r.name.toUpperCase()));
    for (const line of r.lines) {
      if (line.type === 'section') {
        if (!quiet) console.log(dim('\n  ' + line.text));
      } else if (line.type === 'pass') {
        if (!quiet) console.log('    ' + green('ok') + '   ' + dim(line.text));
      } else {
        console.log('    ' + red('FAIL ' + line.text) + (line.got ? red('  -> ' + line.got) : ''));
      }
    }
  }

  const passed = all.reduce((n, r) => n + r.passed, 0);
  const failed = all.reduce((n, r) => n + r.failed, 0);
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log('\n' + '-'.repeat(52));
  for (const r of all) {
    const status = r.failed ? red(r.failed + ' failed') : green('all passed');
    console.log('  ' + r.name.padEnd(14) + String(r.passed).padStart(3) + ' checks   ' + status);
  }
  console.log('-'.repeat(52));

  if (failed) {
    console.log(red(bold('\n  ' + failed + ' of ' + (passed + failed) + ' checks failed')) + dim('  (' + secs + 's)\n'));
    for (const r of all) {
      for (const f of r.failures) {
        console.log(red('  FAIL ' + r.name + ' > ' + f.section));
        console.log('       ' + f.label + (f.got ? dim('  -> ' + f.got) : ''));
      }
    }
    console.log('');
    process.exit(1);
  }

  console.log(green(bold('\n  ' + passed + ' checks passed')) + dim('  (' + secs + 's)\n'));
})();
