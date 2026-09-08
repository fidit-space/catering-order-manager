# 📋 TASK QUEUE & WORKFLOW TRACKER

## Status Definitions
- `[TODO]` — Planned and specified; waiting for execution.
- `[IN_PROGRESS]` — Currently being worked on by Claude Code.
- `[READY_FOR_AUDIT]` — Claude Code has finished; waiting for Antigravity verification.
- `[DONE]` — Audited, verified, and merged.

---

## 🔴 CRITICAL — Task 7: Rotate exposed production credentials
- **Raised by:** Claude Code, 2026-09-09
- **Status:** `[TODO]` — **blocks the pilot**
- **Assignee:** Umair (needs Google Console access), verified by Antigravity
- **Runbook:** [`ROTATION_RUNBOOK.md`](ROTATION_RUNBOOK.md)

`9374d53` published the live Web App URL and `API_KEY = "fidit-royal-2026"` in
`index.html`. GitHub Pages serves that file publicly and the repo is public, so both are
world-readable and permanent in git history. At the time the key was the **only** guard on
11 endpoints, 7 of which mutate data — read all customer PII, cancel bookings, or mark
unpaid orders paid.

**Verified live from an unrelated machine** on 2026-09-09 01:22 Asia/Colombo using only the
published key: `{"totalOrders":4,"pendingOrders":3,...}`.

**CI caught this and was pushed past twice.** Runs `34262292682` and `34267180870` both
failed on the step *"Fail if a real secret was committed"*; tests and syntax checks passed.

**Fixed in code (this commit):** writes and reads now require a Telegram-signed launch,
verified by HMAC against the bot token, which never leaves Script Properties. A leaked key
opens nothing. 27 checks in `test/auth.test.js`, built against the published spec with
Node's crypto rather than against our own implementation.

**Still required from Umair — code alone does not close this:**
1. Redeploy the backend, then rotate to a **new deployment URL and key**, archiving the old
   deployment. The old URL still answers the old key with no Telegram check.
2. Re-run `registerWebhook()` (it points at the old URL until you do).
3. Decide repository visibility — see Task 8.
4. Install the three missing triggers — see Task 9.

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
