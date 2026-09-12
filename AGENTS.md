# AGENTS.md — catering-order-manager

> **Single source of truth for every agent working in this repo.** Claude Code reads
> this natively; Antigravity/Gemini reads it through `GEMINI.md`, a symlink to this file.
> It is deliberately short: the live coordination state already has a home in `.team/`,
> and duplicating it here would be the drift vector. This file says *where things live
> and what the hard rules are*, nothing more.

## What this is

Zero-cost mobile catering order manager and reminder system, run entirely from a
smartphone: a **Telegram Mini App** on **GitHub Pages**, backed by **Google Sheets** and
a **Google Apps Script** serverless engine. Pilot client is a friend's catering business;
the target is a FIDIT white-label SaaS. Hosting cost is **Rs. 0** and must stay there.

| Path | What it is |
|---|---|
| `backend/google_apps_script.js` | The whole serverless backend |
| `index.html` | The Mini App served from GitHub Pages |
| `test/` | Dependency-free Node suite (`auth`, `backend`, `finance`, `frontend`, `integrity`, `migration`, `operations`, `tenancy`) |
| `.team/` | **Live coordination state — see below** |
| `PROJECT.md` | Canonical PM state (`00-Conventions.md` §4) |

Setup and usage docs: `SETUP_INSTRUCTIONS.md`, `MENU_GUIDE.md`, `CLIENT_ONBOARDING.md`,
`CLAUDE_CODE_SPEC.md`.

## Coordination lives in `.team/` — read it, don't restate it

This repo already runs a dual-agent protocol. **Read these before acting; they are the
authority, not this file:**

| File | Holds |
|---|---|
| `.team/TEAM_STATE.md` | Current status, live deployment, roles, the collaboration sequence |
| `.team/TASK_QUEUE.md` | What to work on next, with specs and constraints |
| `.team/AUDIT_LOG.md` | Audit verdicts |
| `.team/ROTATION_RUNBOOK.md` | Credential rotation procedure |

**Roles** (from `.team/TEAM_STATE.md`): Umair is Product Owner (business goals, client
relations, credentials, approving merges). **Antigravity** is Lead Architect & Auditor
(security audits, architectural boundaries, edge cases, verification). **Claude Code** is
Full-Stack Implementer (coding, refactoring, UI, test scripting). Claude marks work
"Ready for Audit" in the queue; Antigravity logs the verdict and approves the push.

Note this is the **inverse** of the `Homelab-Memory` vault, where Antigravity is PM and
Claude executes. Check which repo you are in before assuming a role.

## 🚨 The hard rules

1. **No secret ever reaches a served file.** `index.html` is public on GitHub Pages and
   the repository is public. Commit `9374d53` put the live Web App URL and an API key
   there; both are permanently in git history and the data was provably readable by
   anyone. See `.team/ROTATION_RUNBOOK.md`.
2. **Never push past a red CI credential scan.** The `Credential scan` step in
   `.github/workflows/tests.yml` caught that leak and was pushed past **twice**. A red
   build is the control working. Stop and fix it.
3. **Writes require a verified Telegram launch** (`requireTelegramAuth_()`, HMAC against
   the bot token, which never leaves Script Properties). A leaked API key must open
   nothing. CI asserts this; `test/auth.test.js` covers it.
4. **No dependencies, no build step, no `npm install`** — anywhere, including tests. Any
   Node 18+ must run the suite as-is.
5. **Silence is the enemy.** Every test traces to a defect from the `c808775` pre-launch
   audit whose defining feature was silence — orders reported saved but never written,
   reminders that could never fire. Fail loudly; never swallow an error.

## Before calling anything done

```bash
node test/run.js          # the full suite; CI runs exactly this
```

Anything touching **production, money, credentials, or the live deployment** is drafted
by an agent and needs Umair's explicit confirmation.

## Working together

- Claude works on `claude/<topic>` branches, Antigravity on `ag/<topic>`. Neither commits
  to `main` unless Umair asks.
- State and status → `PROJECT.md` (bump `updated`). Task flow → `.team/TASK_QUEUE.md`.
  Audit verdicts → `.team/AUDIT_LOG.md`. One fact, one home — never two.
- If `PROJECT.md` is older than the repo's last commit, **trust the repo** and refresh it.
