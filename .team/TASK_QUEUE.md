# 📋 TASK QUEUE & WORKFLOW TRACKER

## Status Definitions
- `[TODO]` — Planned and specified; waiting for execution.
- `[IN_PROGRESS]` — Currently being worked on by Claude Code.
- `[READY_FOR_AUDIT]` — Claude Code has finished; waiting for Antigravity verification.
- `[DONE]` — Audited, verified, and merged.

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
- **Status:** `[TODO]`
- **Spec:**
  - Stage all files (`index.html`, `backend/google_apps_script.js`, docs, `.team/`).
  - Commit: `feat(core): complete production-ready catering manager with team memory and IP protection`.
  - Push to `fidit-space/catering-order-manager`.

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
