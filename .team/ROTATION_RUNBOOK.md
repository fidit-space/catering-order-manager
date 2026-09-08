# 🔐 Credential Rotation Runbook

**Raised:** 2026-09-09 · **Severity:** Critical · **Owner:** Umair

---

## What happened

Commit `9374d53` put the live Web App URL and `API_KEY = "fidit-royal-2026"` into
`index.html`. GitHub Pages serves that file to anyone, and the repository is public, so
both values are readable by the world and are permanently in git history.

At that time the key was the **only** thing guarding 11 endpoints, 7 of which change data.
Anyone could read every customer's name, phone and address, cancel bookings, or mark
unpaid orders as paid.

CI caught it. The build went red on the step *"Fail if a real secret was committed"* and
was pushed past — twice.

**Verified live on 2026-09-09 01:22 Asia/Colombo**, from an unrelated machine using only
the published key:

```
{"status":"ok","totalOrders":4,"pendingOrders":3,"menuItems":16,"webhookConfigured":true}
```

## What has been fixed in code

Writes now require a Telegram-signed launch (`requireTelegramAuth_`), verified by HMAC
against the bot token, which never leaves Script Properties. A leaked API key no longer
opens anything. 27 checks cover this in `test/auth.test.js`.

**This does not undo the exposure.** The old deployment is still live and still accepts
the old key without any Telegram check. Rotation below is required.

---

## Do this in order

### 1. Deploy the new backend code (5 min)

1. Open the Apps Script project → paste the current `backend/google_apps_script.js`.
2. **Deploy → Manage deployments → edit → New version → Deploy.**
3. Confirm the version note mentions Telegram auth.

> Do **not** create a *new deployment* unless you intend to change the URL — see step 2.

### 2. Rotate the URL and key (5 min)

Because the old pair is public and permanent, both must change:

1. **Deploy → New deployment → Web app** (Execute as *Me*, Access *Anyone*) → copy the new URL.
2. **Deploy → Manage deployments →** archive the **old** deployment so the old URL stops answering.
3. Pick a new `API_KEY`, set it in **Project Settings → Script Properties**.
4. Update both values in `index.html`, commit, push.
5. Run `registerWebhook()` again — the webhook points at the old URL until you do.

### 3. Verify the exposure is closed (2 min)

```bash
# The OLD url must now be dead:
curl -sL "<OLD_URL>?action=health&key=fidit-royal-2026"

# The NEW url must refuse a read that carries only the key:
curl -sL "<NEW_URL>?action=orders&key=<NEW_KEY>"
# expected: {"status":"error","message":"No Telegram sign-in data was sent."}

# Health stays open by design, and must not show counts without auth:
curl -sL "<NEW_URL>?action=health"
```

### 4. Decide on repository visibility (2 min)

`TEAM_STATE.md` records the repo as *Private*. It is **public** — verified via
`gh repo view`. **ADR 002** exists to protect FIDIT's IP by keeping the backend out of the
client's reach; publishing it to the world defeats that.

Either make the repo private, or amend ADR 002 to say the code is open and the IP position
rests on something else. Both are defensible; the current mismatch is not.

### 5. Install the three missing triggers (3 min)

The deployment guide said to add **two** triggers. There are **five** scheduled jobs.
Missing ones: `checkUnpaidBalances`, `weeklyBackup`, `reportNewErrors` — so payment
chasing, backups and error alerts are **not running**. Full table in
`SETUP_INSTRUCTIONS.md` Step 5.

---

## After rotating

The new key is still published in `index.html`, and that is now **fine by design** — a
static page cannot hold a secret. What changed is that the key no longer grants anything:
every read and write requires a signature only Telegram can produce for your bot.

The one value that must never appear in git, chat, or any file is the **bot token**. CI
fails hard on it. If it ever leaks, revoke it through `@BotFather` immediately — it is the
HMAC key the whole authentication depends on.

## Practices worth keeping

- **A red build blocks the push.** The guard worked on 2026-09-08; it was overridden.
- **Never paste a token into a chat window**, including to an AI assistant. Bot ids and
  usernames are public and safe; tokens are not.
- **An audit that scores itself is not an audit.** The 98/100 post-deployment report gave
  Security 100/100 while this was live, and credited weekly backups as working when their
  trigger had never been installed.
