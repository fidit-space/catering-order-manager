# 📋 TASK QUEUE & WORKFLOW TRACKER

## Status Definitions
- `[TODO]` — Planned and specified; waiting for execution.
- `[IN_PROGRESS]` — Currently being worked on by Claude Code.
- `[READY_FOR_AUDIT]` — Claude Code has finished; waiting for Antigravity verification.
- `[DONE]` — Audited, verified, and merged.

---

## 🟢 Task 7: Rotate exposed production credentials
- **Raised by:** Claude Code, 2026-09-09
- **Status:** `[DONE]` — **Resolved and verified live on 2026-09-09**
- **Resolution:** 
  1. Old deployment (`AKfycbyVJ4a...`) archived in Google Apps Script; verified dead via curl.
  2. Fresh deployment (`AKfycbyjTmY...`) created with `requireTelegramAuth_` cryptographic HMAC gating.
  3. API key rotated to `fidit-royal-v2`.
  4. Webhook re-registered and verified active on `@royal_catering_orders_bot`.
  5. `index.html` updated and pushed to GitHub Pages.
  6. All 3 verification checks from `ROTATION_RUNBOOK.md` executed and passed live. Key-only requests successfully rejected.

---

## 🟠 Task 8: Reconcile ADR 002 with actual repository visibility
- **Assignee:** Antigravity
- **Status:** `[TODO]`

`TEAM_STATE.md` records the repo as *(Private)*. `gh repo view` reports
`"visibility":"PUBLIC"`. ADR 002 justifies the standalone-script pattern as protecting
FIDIT's IP from clients — but the backend source is on public GitHub, so that protection
does not exist. Either make the repo private, or amend ADR 002 to state the code is open
and say where the IP position actually rests. The mismatch is the problem, not the choice.

---

## 🟠 Task 9: Install the three missing triggers
- **Assignee:** Umair
- **Status:** `[TODO]`

The deployment instructions said to add **two** triggers. There are **five** scheduled jobs.
Not installed: `checkUnpaidBalances`, `weeklyBackup`, `reportNewErrors`. So payment chasing
is off, error alerts are off, and **backups are not running** — which the 98/100 audit
credited as a passing feature (*"Automatic Weekly Disaster Recovery"*). Table in
`SETUP_INSTRUCTIONS.md` Step 5.

---

## Task 10: Financial ledger, costing and reports
- **Assignee:** Claude Code
- **Status:** `[READY_FOR_AUDIT]`

**The problem.** The app tracked *price*, not *money*. Total / Advance / Balance were
overwritten in place, so there was no record of when cash arrived, how much came each time,
or how it was paid. Three concrete defects followed:

1. `markOrderPaid_` wrote `Advance = Total`, recording money collected **on delivery** as if
   it had been paid **upfront**. Every advance-versus-on-delivery figure was wrong after one tap.
2. Only one payment was representable. Real catering is instalments.
3. Cancelling an order left the customer's money invisible — status flipped, money columns
   untouched, and `readUnpaid_` skips cancelled orders. A refund owed vanished from every view.

**The fix.** A new append-only **Ledger** tab is now the source of truth for money. `Received`
and `Balance Due` on an order are mirrors recomputed from it. Also added:

- Instalment payments, each keeping its own amount, method and timestamp.
- `cancelOrder_` reports money held and offers a one-tap refund.
- Price changes write an `Adjustment` row with old → new and the stated reason.
- A `Cost` column on the Menu tab → estimated food cost and margin per order, with **no extra
  typing from the kitchen**. Margin under 20% shows red on the order card.
- `/cash` (takings, costs, profit, and what the cash box should physically hold), `/owed`
  (aged receivables), `/month` (revenue, costs, profit, margin), `/spend 4500 chicken`.
- A **💰 Money** screen in the app with the same figures plus one-line cost entry.

**Also fixed:** commit `31feeac` removed the platform guard (correctly — it blocked the real
webview), but that left `tg` truthy in a plain browser, so the in-page Save button was hidden
in favour of Telegram's inert MainButton and there was **no way to submit an order outside
Telegram**. Now gated on `tg.platform !== 'unknown'` instead.

**Tests:** 227 total, 55 new in `test/finance.test.js`. Reports are asserted to reconcile
against the ledger rather than against themselves.

**For the auditor**
- 🟠 The Ledger is append-only *by convention*. Google Sheets rows remain hand-editable, so
  this is a reviewable trail, not cryptographic immutability. Recommend protecting the range
  (*Data → Protect sheets and ranges*); the weekly emailed backup makes tampering evident by
  comparison. Stated plainly rather than implying a guarantee that does not exist.
- 🟠 `Est. Food Cost` uses Menu costs at the time the order is saved. If a price is edited
  later, historic orders keep the old estimate — correct for accounting, worth knowing.
- ⚪ Seeded costs in `DEFAULT_MENU` are placeholders at ~58% of rate. Umair should replace
  them with real figures before reading any margin as truth.
- ⚪ Existing `Menu` tabs gain `Cost` as an appended column, so nothing breaks; it simply
  reads blank until filled. Orders sheets gain three columns and a renamed header
  (`Advance Paid` → `Received`); run `initSheets()` after deploying.

---

## 🔴 Task 11: A-to-Z audit — 13 defects found and fixed
- **Assignee:** Claude Code
- **Status:** `[READY_FOR_AUDIT]`
- **Trigger:** Umair reported four live symptoms; all four traced to real defects, plus nine more.

### 🔴 Requires action in Google before it is closed
**F13 — pre-Ledger orders could lose recorded money.** `syncOrderMoney_` recomputes `Received`
from the Ledger alone. The live orders predate the Ledger, so their advances had no entries
behind them: the first payment, settlement or price edit on such an order would have
overwritten the advance and told the customer they still owed it.

Two-part fix: a **guard** in `syncOrderMoney_` that refuses to zero a pre-Ledger balance and
logs it instead, and **`migrateSheets()`** which backfills an `Opening balance` ledger entry for
every such order. **Umair must run `migrateSheets` once** (SETUP_INSTRUCTIONS Step 4b) — the code
alone does not repair the spreadsheet.

### Fixed in code
| # | Was |
|---|---|
| **F2** | No migration path. The live Menu tab has no `Cost` column, so `readMenu_` read blank and **every margin silently never appeared** — the reported "no profit figures". `migrateSheets()` now adds it, backfills costs where available, and repairs the Orders header. |
| **F8** | `stampMessage_` fed Telegram's *plain* `message.text` back with `parse_mode: HTML`. Any `&`/`<` (e.g. "Curries & Gravy") rejected the edit with a 400 — sheet updated, message frozen, **button looked dead**. Now escaped. |
| **F1** | `?action=health&key=` returned order counts to anyone, since the key is public in `index.html`. Counts now require a verified Telegram launch. Verified live before the fix. |
| **F3** | Editing an order's Advance was a **silent no-op** — `updateOrder_` stopped reading the field in `ec6debb`. The edit form now shows read-only *Received* plus a real payment action. |
| **F4** | **Instalments were unreachable.** `recordPayment_` was built, routed and tested but never called. Added a payment sheet (amount + method) on order cards and aging rows, plus `/pay`. |
| **F9** | Advancing a status replaced the whole keyboard with one button, losing Call/WhatsApp/Map/Paid. Now rebuilt via `contactKeyboard_`. |
| **F10** | **Telegram dark mode failed contrast** — chips and the cash-box figure at 2.29–3.24:1 against `#17212b`. Moved to theme tokens; now **8.46–9.16:1**, measured. |
| **F11** | Category pills hid **365px** behind an invisible scroll — Curries, Desserts and Custom unreachable. Rows now wrap. |
| **F5 / F6 / F7 / F12** | "Advance" mislabelled once payments exist; no payment method on new orders; failed expenses lost rather than queued; the sample menu shown silently as if it were the real one. |

### Tests
289 checks (was 227). New `test/migration.test.js` (35) proves an unmigrated sheet **cannot** lose
a payment, that migration carries the money over, and that re-running changes nothing. Two brittle
assertions found and fixed while working — a hardcoded unpaid count that other tests perturbed.

### For the auditor
- ⚠️ **Not closed until `migrateSheets` is run on production**, and the summary it returns should
  be pasted into AUDIT_LOG as evidence.
- 🟠 Migration marks carried-over payments as method **`Unknown`** rather than guessing Cash —
  correct for the books, but it means today's `/cash` reconciliation excludes them.
- ⚪ `DEFAULT_MENU` costs remain placeholders; migration deliberately does **not** seed costs into
  an existing Menu tab. Real figures must be entered before any margin is read as truth.

---

## 🚀 Active Sprint: Security Hardening & Internal Pilot

### Task 1: Fix IP Protection (Standalone Script Mode)
- **Assignee:** Antigravity
- **Status:** `[DONE]`
- **Resolution:** Added `SPREADSHEET_ID` property and updated `ss_()` to call `SpreadsheetApp.openById()`. Code can now run as a standalone script in FIDIT's Drive, completely hidden from clients.

### Task 2: Fix Race Conditions on Telegram Callback Actions
- **Assignee:** Antigravity
- **Status:** `[DONE]`
- **Resolution:** Wrapped `setOrderStatus_()` with `LockService.getScriptLock()` with a 20-second timeout. `advanceOrderStatus_` is also protected.

### Task 3: Commit & Push Full Codebase to GitHub
- **Assignee:** Antigravity
- **Status:** `[TODO]` — committed locally, **not pushed**. Push remains Antigravity's call per protocol.
- **Note from Claude Code:** commits `b09bbfa`, `32f9329`, `2bd763b` and `<this one>` are on `main`
  locally. See Task 5 for the protocol deviation this represents.

### Task 5: Audit Remediation, Test Harness & CI
- **Assignee:** Claude Code
- **Status:** `[READY_FOR_AUDIT]`
- **Commits:** `b09bbfa`, `32f9329`, `2bd763b`, plus the lock-coverage commit below.

**Delivered**
1. **Six critical defects fixed** (see AUDIT_LOG Audit 3): silent save failures, reminders that
   could never fire, dead `handleCallbackQuery`, order-id collisions, Telegram alerts dropped on
   Markdown-breaking names, and an unauthenticated endpoint.
2. **Operations features:** kitchen status pipeline (Confirmed → Cooking → Out for Delivery →
   Delivered), automatic chasing of unpaid balances, weekly CSV backup to Drive + email, and a
   `Settings` tab so timings are owner-editable.
3. **Test harness in `test/`** — 142 checks, `node test/run.js`, zero packages, plus CI on every
   push via `.github/workflows/tests.yml`.
4. **`onEdit` integrity guard** — repairs Delivery Date / Time / Phone when edited by hand, which
   is what keeps the reminder engine working after a human touches the sheet.
5. **`reportNewErrors`** — pushes new `Log` rows to Telegram, so failures stop being silent.

**Points for the auditor's attention**
- ⚠️ **Protocol deviation:** commits `32f9329` and `2bd763b` went to `main` directly rather than a
  branch. My earlier branch had already been folded into `main` between sessions and I did not
  re-check before committing. Nothing is pushed. Rebase onto a branch if you want them isolated.
- ⚠️ **`ADR 001` needs a ruling.** The suite adds no npm packages and ships nothing to the client,
  but running it requires Node. If "no Node" is meant to cover tooling as well as runtime, say so
  and the harness comes out.
- 🔴 **`markOrderPaid_` was unlocked** while `setOrderStatus_` was locked in `d97bdab`, despite the
  identical read-then-write-five-cells shape. Fixed in `2bd763b`.
- 🟠 **Lock-coverage audit against the TEAM_STATE rule.** Every sheet writer was checked. One real
  gap: `onEdit` → `repairOrderCell_` ran outside any lock and has no locked caller — now takes a
  short `tryLock`, deliberately non-blocking because it fires while a person is typing.
  `upsertCustomer_`, `logError_` and `pruneBackups_` are **intentionally** unlocked: they are only
  called from inside locked functions, and Apps Script script locks are not reentrant, so locking
  them would deadlock. Each now carries a comment saying so.
- 🟠 **Two test defects found and fixed while writing the suite:** an assertion that depended on the
  wall clock (passed by day, failed after ~22:30), and order ids that were only *probabilistically*
  unique. Ids are now checked against those already issued.

### Task 6: Verify the live bot end-to-end
- **Assignee:** Umair (Product Owner)
- **Status:** `[TODO]`
- **Bot:** `@royal_catering_orders_bot` (id `8856703286`)
- **Spec:**
  - Run `setupProperties()` then `registerWebhook()`, then `runSelfTest()`.
  - Confirm the alert rings, and that **Mark as Delivered** both updates the sheet and edits the message.
  - Install all five triggers from `SETUP_INSTRUCTIONS.md` Step 5 (four timed; `onEdit` needs none).
  - ⚠️ Never paste the bot **token** into chat or into any file — Script Properties only.
    The bot id and username above are public identifiers and safe to record here.

### Task 4: Internal Staging Setup on FIDIT Accounts
- **Assignee:** Umair (Product Owner)
- **Status:** `[TODO]`
- **Spec:**
  - Follow `SETUP_INSTRUCTIONS.md` using your own personal Telegram & FIDIT Google account.
  - Run `runSelfTest()` in Apps Script and verify the test message rings your Telegram.

---

## 🔮 Backlog (Sprint 2: Multi-Tenant Scale)
- [ ] Support `?client=royal` in `index.html` for dynamic config resolution.
- [ ] Auto-archive closed orders older than 60 days to an `Archive` tab.
- [ ] Add branded WhatsApp Canvas image receipt generation.
