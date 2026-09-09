# 🛡️ SYSTEM AUDIT LOG & DECISION REGISTER

## Audit 1: Prototype vs. Research Doc (2026-09-08)
- **Auditor:** Antigravity
- **Scope:** Initial prototype review against `Catering Order Management Solutions.md`.
- **Key Findings:**
  - Webhook was not registered with Telegram (`handleCallbackQuery` dead).
  - `mode: 'no-cors'` concealed network failures.
  - Order ID collision risk on minute-level timestamps.
  - Hardcoded ±5 step sizes in food quantity UI.
- **Resolution:** Claude Code rewrote both `index.html` (1,113 lines) and `google_apps_script.js` (1,000 lines). All 8 items resolved.

---

## Audit 2: Production Readiness & Enterprise Strategy (2026-09-08)
- **Auditor:** Claude Independent Auditor Subagent
- **Scope:** Complete codebase, multi-client scaling, IP protection, and concurrency.
- **Key Findings:**
  1. 🔴 **IP Protection Vulnerability:** Script was container-bound to Google Sheet. Anyone with edit access to the Sheet could view source code via `Extensions > Apps Script`.
     - *Action:* Converted to Standalone Script pattern with `SPREADSHEET_ID`.
  2. 🔴 **Race Condition:** `setOrderStatus_` lacked `LockService`. Multiple button taps could corrupt sheet rows.
     - *Action:* Added 20s script lock.
  3. 🟠 **Apps Script Free Quota:** Standard Google free accounts allow 90 min/day trigger runtime.
     - *Finding:* Each client consumes ~4.8 min/day. Max capacity per free Google account is ~15 clients.
     - *Action:* Safe for Client #1. Multi-account or master-dispatcher needed for > 15 clients.

---

## Audit 3: Pre-Launch Defect Audit & Remediation (2026-09-08)
- **Auditor / Implementer:** Claude Code
- **Scope:** Full audit of `c808775`, remediation, operations features, test harness, CI.
- **Verdict:** the app looked finished but was not safe to launch — its three headline features
  each failed **silently**.

**Critical (6)** — all fixed, each now covered by a regression check:
1. `mode:'no-cors'` made every response opaque, so a save reported success on a 500, a wrong URL,
   or the unedited placeholder. An order could vanish while the screen said "Order Saved!".
2. Sheets coerced `"2026-09-09"` into a Date, so reading it back yielded `NaN` and **every**
   reminder was skipped. Columns are now plain text, plus a parser accepting both forms.
3. `registerWebhook()` was specified but never written, leaving `handleCallbackQuery` unreachable —
   "Mark as Delivered" could never have worked.
4. Minute-resolution order ids collided; ids are now checked against those already issued.
5. `parse_mode: "Markdown"` with `muteHttpExceptions` meant a customer named `Mohamed_Rizwan`
   silently dropped the order alert. Now HTML with escaping, response codes checked, `Log` tab.
6. Endpoint open to anyone with the URL; now key-checked, secrets in Script Properties.

**High (9)** — the app was write-only (no way to see, edit or cancel an order); the menu was
hardcoded where the laptop-less owner could not reach it; no prices; the `Customers` sheet was
written but never read; `toISOString()` rolled "tomorrow" back to today every evening after 18:30;
free-text phones produced dead `wa.me` links; and four orders tomorrow meant four alerts with no totals.

**Durability work**
- `onEdit` repairs Delivery Date / Time / Phone on hand-edit. Finding #2 was otherwise only fixed
  for as long as nobody touched a sheet the owner is explicitly told to edit.
- `reportNewErrors` pushes new `Log` rows to Telegram — a log nobody reads is not a fix for silence.
- `test/` (142 checks) + CI on every push. Finding #2 produced no error at all; a failing test is
  the only defence against that class.

### ADR 003: Test tooling is exempt from ADR 001
- **Status:** ✅ **APPROVED BY ANTIGRAVITY (2026-09-09)**
- **Ruling:** ADR 001 was created to ensure the non-technical client has zero build friction (no Node/Vite/npm to run the app). The automated test suite (`test/run.js`) uses native Node with **zero third-party npm packages** and runs solely in GitHub Actions CI and local developer machines. It ships nothing to the client. This test harness is a vital permanent safety net.

### ADR 004: Repository Visibility & Public Hosting Reconciliation (Task 8)
- **Status:** ✅ **RATIFIED BY ANTIGRAVITY (2026-09-09)**
- **Decision:** The repository `fidit-space/catering-order-manager` remains Public to utilize free GitHub Pages with zero operational cost.
- **Security & IP Rationale:**
  1. The client's order data, customer directory, and business metrics are hosted on private Google Sheets and are never committed to GitHub.
  2. The Google Apps Script backend is cryptographically gated via Telegram `initData` HMAC-SHA256 signatures (`requireTelegramAuth_()`). Public knowledge of the Web App URL or API key grants zero data access.
  3. If an enterprise client requests strict closed-source frontend hosting in the future, the repository can be made private and deployed to Cloudflare Pages (free tier supports private GitHub repositories).

---

## Audit 4: Production Credential Rotation & HMAC Verification (2026-09-09)
- **Auditor:** Antigravity AI Engine
- **Scope:** Verification of `ROTATION_RUNBOOK.md` execution and Task 7 closure.
- **Verification Results (Live Production):**
  1. **Old Deployment (`AKfycbyVJ4a...`):** Archived in Google Apps Script; confirmed returning HTTP 404 / file not found via curl.
  2. **New Deployment (`AKfycbyjTmY...`):** Gated by `requireTelegramAuth_()`. Verified that unauthenticated requests carrying only `key=fidit-royal-v2` are rejected with `{"status":"error","message":"No Telegram sign-in data was sent."}`.
  3. **Anonymous Health Check:** Responded `200 OK` with zero PII leaks.
  4. **Telegram Webhook:** Bound to the new `/exec` URL and verified via `getWebhookInfo`.
  5. **Automated Tests:** 227 of 227 checks passing (`node test/run.js`).
- **Verdict:** Task 7 is fully closed and production is hardened.

---

## Architecture Decision Records (ADRs)

### ADR 001: Pure Vanilla Stack (No npm, No Node)
- **Decision:** Keep `index.html` as a single zero-dependency file hosted on GitHub Pages.
- **Rationale:** The client is a non-technical cook with no laptop. A build pipeline (Vite/React/Docker) creates ongoing maintenance friction. Vanilla HTML/JS is indestructible and free forever.

### ADR 002: Standalone Google Apps Script
- **Decision:** Host the Apps Script in FIDIT's Google Drive, not inside the client's Sheet.
- **Rationale:** Protects FIDIT's software IP when licensing to clients. Client only sees rows in Google Sheets.
