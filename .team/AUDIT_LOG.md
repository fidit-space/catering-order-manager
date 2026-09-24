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

---

## Audit 5: Multi-Tenant Onboarding (Basith Foods) & Cloudflare Edge Deployment (2026-09-17)
- **Auditor:** Antigravity
- **Scope:** Onboarding second live tenant (`basith`), Cloudflare edge deployment (`https://basith-foods.fiditspace.workers.dev/`), HMAC auth verification, and Menu Button automation.
- **Key Milestones & Verification:**
  1. **Second Tenant Onboarded:** Stood up `@basith_foods_orders_bot` for **Basith Foods** with dedicated Google Apps Script backend and isolated Google Sheet database.
  2. **Multi-Tenant Routing:** Added `basith` to `TENANTS` in `index.html`. Zero data overlap with pilot tenant (`royal` / `demo`).
  3. **Cloudflare Edge Deployment:** Deployed with strict `_headers` (cache busting + Telegram framing CSP) served from Colombo edge (`CMB`).
  4. **Cryptographic Validation:** Verified end-to-end HMAC SHA-256 validation; orders successfully save to Basith Foods' Google Sheet.
  5. **Automated Tests:** 450 / 450 checks passed (`node test/run.js`). Credential scan 100% clean.
- **Verdict:** Multi-tenant architecture verified live in production with zero data leakage.

### ADR 005: Cloudflare Edge Multi-Tenant Routing
- **Status:** ✅ **RATIFIED BY ANTIGRAVITY (2026-09-17)**
- **Decision:** Single shared frontend deployment on Cloudflare Edge with `?client=<id>` routing to isolated Google Apps Script backends.
- **Rationale:** Delivers sub-50ms latency across South Asia from Cloudflare's Colombo edge node (`CMB`), enforces strict cache-control preventing stale order forms, and maintains zero monthly hosting cost (Rs. 0 / $0.00).

---

## Audit 6: Automated Multi-Tenant Deployment Engine & Hardened Batching (2026-09-23)
- **Auditor:** Antigravity AI Engine
- **Scope:** Review and verification of Task 20 (F-07 status lock discipline, F-08 batch money writes, F-09 HMAC key-sorted verification) and Task 21 (`tools/deploy.js` one-command deployment).
- **Verification Highlights:**
  1. **Deployment Automation (`tools/deploy.js`):**
     - Complies strictly with ADR 001: Written in native Node (HTTP loopback server, crypto, fetch), zero npm dependencies.
     - Strict safety invariants: Refuses projects with >1 script file (protects `appsscript.json`), refuses moving `@HEAD` deployments, validates single versioned deployments, and deploys sequentially to prevent cascading fleet failures.
     - OAuth refresh tokens stored in gitignored `tools/deploy.local.json` and never logged or committed.
  2. **Security & Financial Integrity (Task 20):**
     - F-07: Status updates (`setOrderStatusHeld_`) and cancellation money calculation occur under strict script lock, with release prior to external network requests.
     - F-08: Batch cell updates in `syncOrderMoney_` reduce Apps Script round trips while covered by adjacency regression tests in `test/integrity.test.js`.
     - F-09: Telegram `initData` verification sorts parsed parameters strictly by key name, eliminating auth failure vulnerabilities on prefixed field keys.
  3. **Automated Test Coverage:**
     - 507 of 507 checks passing across 8 suites (`node test/run.js`). Credential scans 100% clean.
- **Verdict:** Tasks 20 and 21 are **APPROVED**. Multi-tenant fleet can be deployed using `tools/deploy.js` once local OAuth credentials are configured.

### ADR 006: Local OAuth for Multi-Tenant Fleet Deployment Tooling
- **Status:** ✅ **RATIFIED BY ANTIGRAVITY (2026-09-23)**
- **Decision:** Use Google Apps Script REST API via native Node (`tools/deploy.js`) for one-command deployment across all client instances.
- **Rationale:** Replaces error-prone manual 130KB copy-pasting across Google Apps Script editors without introducing external dependencies (no `clasp`, no `npm`). Local OAuth tokens are isolated in gitignored configuration and strictly prohibited from git or CI.

---

## Audit 7: Idempotent Trigger Automation & Tenant-Isolated Caching (2026-09-24)
- **Auditor:** Antigravity AI Engine
- **Scope:** Verification of Phase 1 (Trigger Automation, Task 9 closure) and Phase 2 (Tenant cache isolation & DEPLOY_SETUP permanent token guidance).
- **Verification Highlights:**
  1. **Programmatic Trigger Automation (Task 9):**
     - Implemented `installAllTriggers_()` and public `installAllTriggers()` in `backend/google_apps_script.js`.
     - Automatically scans `ScriptApp.getProjectTriggers()`, purges duplicate registrations, and provisions all 5 background jobs (`checkDispatchAlerts`, `sendDailyPrepDigest`, `checkUnpaidBalances`, `weeklyBackup`, `reportNewErrors`).
     - Integrated directly into `migrateSheets_()` so running schema migration automatically arms background triggers.
     - 6 unit regression tests added in `test/operations.test.js`; total test suite passes at **513/513 checks**.
  2. **Tenant Cache Isolation (`index.html`):**
     - `LS.MENU` dynamically keyed with `tenantId()` (`cat_menu_<tenant>_v1`), completely eliminating cross-tenant cache bleed between `demo` and `basith`.
  3. **Permanent GCP OAuth Deployment Guidance (`tools/DEPLOY_SETUP.md`):**
     - Updated documentation with instructions to transition Google Cloud OAuth consent status from "Testing" to "In production", preventing the 7-day refresh token expiration limit.
- **Verdict:** Code and architectural changes **APPROVED**. Ready for fleet deployment.
