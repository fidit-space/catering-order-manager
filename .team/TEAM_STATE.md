# 🧠 TEAM WORKSPACE STATE & SHARED MEMORY

> **Project:** Mobile Catering Order Management System (Telegram Mini App + Google Apps Script + Sheets)  
> **Client:** Client #1 (Pilot: Friend's Catering Business) → FIDIT White-label SaaS  
> **Repository:** `fidit-space/catering-order-manager` — ⚠️ **PUBLIC** (verified 2026-09-09; see TASK_QUEUE Task 8)  
> **Last Synchronized:** 2026-09-08  

---

## 👥 The Team Roles & Protocols

| Role | Entity | Primary Responsibility |
|---|---|---|
| **Product Owner** | **Umair (FIDIT)** | Business goals, client relations, credential management, approving merges |
| **Lead Architect & Auditor** | **Antigravity** | Security audits, architectural boundaries, edge-case detection, verification |
| **Full-Stack Implementer** | **Claude Code** | Heavy coding, file refactoring, UI styling, test scripting |

---

## 🔄 Dual-Agent Collaboration Protocol

```mermaid
sequenceDiagram
    autonumber
    actor PO as Umair (Product Owner)
    participant AG as Antigravity (Architect & Auditor)
    participant TM as .team/ Shared Memory
    participant CC as Claude Code (Builder)
    participant GH as GitHub Repository

    PO->>AG: "What's our next objective?"
    AG->>TM: Updates TASK_QUEUE.md with specs & constraints
    PO->>CC: "Run task from .team/TASK_QUEUE.md"
    CC->>TM: Reads TASK_QUEUE.md & TEAM_STATE.md
    CC->>CC: Implements code changes
    CC->>TM: Marks task "Ready for Audit" & logs work
    PO->>AG: "Audit Claude's work"
    AG->>CC: Inspects diffs, checks edge-cases & security
    AG->>TM: Logs verdict in AUDIT_LOG.md
    AG->>GH: Approves & pushes commit
```

---

## 📌 Active Architecture Baseline

1. **Frontend:** `index.html` — Vanilla JS + CSS, Telegram WebApp SDK, runs on GitHub Pages (`$0/month`).
2. **Backend:** `backend/google_apps_script.js` — Standalone Google Apps Script on FIDIT's Drive, connects to client Sheet via `SPREADSHEET_ID`.
3. **Database:** Google Sheets (`Menu`, `Orders`, `Customers`, `Settings`, `Log` tabs).
   `Menu` and `Settings` are owner-editable from the Sheets phone app — dishes, prices, step sizes,
   alert timings and the backup target — so a price change never needs a deploy.
4. **Tests:** `test/` — 142 checks, `node test/run.js`, no packages, CI on every push.
   Ships nothing to the client; see the ADR 001 question raised in TASK_QUEUE Task 5.
5. **Notifications:** Telegram Bot API — `@royal_catering_orders_bot` (id `8856703286`).
   Instant order alerts with Call / WhatsApp / Map / pipeline buttons, plus five triggers:
   dispatch alerts (15 min), evening prep digest, payment chasing, weekly backup, and `onEdit`
   sheet repair (no installation needed).

---

## 🔑 Security & IP Policy (Strictly Enforced)

1. **The bot token is the only real secret.** It is the HMAC key Telegram signs `initData`
   with, so leaking it defeats authentication entirely. Script Properties only — never in a
   file, a commit, or a chat message. CI fails hard on it.
2. **`API_KEY` and the Web App URL are public by design.** They ship inside `index.html`,
   which GitHub Pages serves to anyone. They are spam filters, never authentication.
   Treat any claim that they are "secret" as a defect in the claim.
3. **Real access control is `requireTelegramAuth_()`** — every read and write requires a
   Telegram-signed launch from an allowed user id. Verified by HMAC against the bot token.
   CI asserts this gate is still wired into both `doGet` and `doPost`.
4. **Standalone Backend:** The Apps Script must NEVER be container-bound to the client's Google Sheet. It connects via `SpreadsheetApp.openById()` so the client can never view the backend code under `Extensions > Apps Script`.
5. **Concurrency Locks:** Any write to the Sheet must acquire `LockService.getScriptLock()` with a 20s timeout.
   **Exception, by design:** `upsertCustomer_`, `logError_` and `pruneBackups_` are only ever called
   from inside already-locked functions. Apps Script script locks are **not reentrant**, so adding a
   lock to these would deadlock. They carry comments saying so — do not "fix" them. If you call one
   from a new place, take the lock at that call site.
   `onEdit` uses a short `tryLock` instead of `waitLock`, because it fires while a person is typing
   and must never block their edit.
6. **Secrets never in chat:** bot tokens are pasted only into Script Properties — not into files,
   commit messages, or messages to either agent. Bot **ids** and usernames are public and fine to record.
   CI fails the build if a token-shaped string is ever committed.
