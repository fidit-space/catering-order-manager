# Tests

```bash
node test/run.js              # everything
node test/run.js integrity    # one suite
node test/run.js --quiet      # failures and summary only
```

No dependencies, no build step, no `npm install` — the same constraint the rest
of the project works under. Any Node 18+ will do. CI runs exactly this command.

## Why these exist

Every check traces back to a defect found in the pre-launch audit of `c808775`.
The audit's defining feature was **silence**: orders reported as saved but never
written, reminders that could never fire, a Telegram alert dropped because a
customer's name contained an underscore. None of it produced an error anyone
would see.

A test that fails loudly is the only defence against that class of bug, which is
why the suite runs on every push.

| Suite | Covers |
| :--- | :--- |
| `backend` | Order storage, date parsing, phone normalisation, id uniqueness, prep digest aggregation, dispatch alerts, authorisation |
| `frontend` | Order payloads, validation, local-date handling, and that a rejected save is reported as an error and kept on the device |
| `integrity` | The `onEdit` guard that repairs hand-edited cells, and the watchdog that pushes new Log entries to Telegram |
| `operations` | Status pipeline, chasing unpaid balances, weekly backup, Settings tab |
| `auth` | Telegram signature verification — forged, tampered, expired and stranger launches |
| `migration` | Repairing a pre-finance spreadsheet, and proving money recorded before the Ledger cannot be erased |
| `finance` | The money ledger: instalments, refunds, price-change audit trail, cost/margin, reports reconciling against the ledger |

## How it works

The backend only ever runs inside Google's cloud, and the app only inside
Telegram, so both are loaded into stand-ins:

- `helpers/apps-script-stub.js` — fake Sheets, Properties, Lock, Drive, Mail and
  UrlFetch. `install()` returns a clean world plus handles (`SENT`, `SS`,
  `MAILS`, `DRIVE`) to assert against.
- `helpers/dom-stub.js` — the minimum browser needed to boot the Mini App, and
  `serve()` to hand it a canned server response.
- `helpers/harness.js` — `section()` and `check()`, in about forty lines.

Each suite exports a function. Declare a second parameter to make it
asynchronous, and call it when finished:

```js
module.exports = function (t) {
  const { SS } = require('./helpers/apps-script-stub.js').install();
  eval(require('./helpers/apps-script-stub.js').backendSource());

  t.section('What this group is about');
  t.check('a plain statement of what should be true', actual === expected, actual);
};
```

## Two rules learned the hard way

**Do not assert on counts that other checks can change.** One test counted the
orders on a fixed date. Other checks in the same suite book orders relative to
the real clock, so after about 22:30 an order spilled onto that date and the
count changed. It passed all day and failed only at night. Assert on identity.

**Do not assert on probabilities.** Order ids were once random enough to *rarely*
collide, and the test allowed a few duplicates in 400. Both were wrong: ids are
now checked against those already issued, so uniqueness is a guarantee and the
test can demand it absolutely.
