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

## Architecture Decision Records (ADRs)

### ADR 001: Pure Vanilla Stack (No npm, No Node)
- **Decision:** Keep `index.html` as a single zero-dependency file hosted on GitHub Pages.
- **Rationale:** The client is a non-technical cook with no laptop. A build pipeline (Vite/React/Docker) creates ongoing maintenance friction. Vanilla HTML/JS is indestructible and free forever.

### ADR 002: Standalone Google Apps Script
- **Decision:** Host the Apps Script in FIDIT's Google Drive, not inside the client's Sheet.
- **Rationale:** Protects FIDIT's software IP when licensing to clients. Client only sees rows in Google Sheets.
