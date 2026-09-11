# 🏢 Standing Up a New Business

How to give a client a working app without giving away the app.

**What the client gets:** their own bot, their own Google Sheet, their own orders and money,
and read-only sight of their own books.

**What FIDIT keeps:** the code, both bot tokens, the Google account that owns everything, and
the ability to fix a problem once and have it reach every business.

---

## How this works

One page serves every business. `index.html` on GitHub Pages holds a `TENANTS` map, and the
`?client=` on the URL the bot's Menu Button opens decides which backend that launch talks to.

```
                    ┌───────────────────────────────────────────┐
  FIDIT's bot ─────▶│  fidit-space.github.io/…/                 │──▶ FIDIT's Sheet
                    │  (one page, one codebase, one push)       │
  Client's bot ────▶│  fidit-space.github.io/…/?client=royal    │──▶ Client's Sheet
                    └───────────────────────────────────────────┘
```

Each backend verifies Telegram's signature against **its own bot token**. A launch signed by one
bot cannot verify against another's deployment — not by a rule that could be misconfigured, but
because the HMAC simply will not match. Businesses cannot see each other's data.

---

## Before you start

Do all of this from **FIDIT's** Telegram account and **FIDIT's** Google account. If the client
creates the bot or owns the Sheet, you cannot fix anything without their login.

You will need the client's:
- **Telegram user id** — have them message `@userinfobot`; it replies with a number
- **Google account email** — for read-only access to their own Sheet

---

## 1. Create their bot (2 min)

1. **@BotFather** → `/newbot` → name and username
2. Copy the token. **It goes into Script Properties in step 3 and nowhere else** — never into a
   file, a commit, or a chat message. CI fails hard on a committed token.
3. `/setuserpic`, `/setdescription` if you want it to look finished

## 2. Create their Sheet and script (3 min)

1. New Google Sheet, named for the business
2. **Extensions → Apps Script**
3. Delete `Code.gs`'s contents, paste `backend/google_apps_script.js`, **Ctrl+S**

## 3. Set their properties (2 min)

Fill in `setupProperties()` and run it **once**:

| Property | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | their new bot's token |
| `TELEGRAM_OWNER_CHAT_ID` | **the client's** Telegram user id |
| `API_KEY` | a new random word, different from every other business |
| `WEBHOOK_SECRET` | another new random word |

Then add two more in **⚙️ Project Settings → Script Properties**:

| Property | Value |
|---|---|
| `TENANT_NAME` | e.g. `Royal Catering` — `/status` prints it so you know which instance you are looking at |
| `MINI_APP_URL` | `https://fidit-space.github.io/catering-order-manager/?client=royal` |

> `MINI_APP_URL` is not optional. Without it their bot's buttons open the **demo** instance, and
> their orders go into the wrong Sheet. `/status` warns when it is missing.

## 4. Deploy (2 min)

**Deploy → New deployment → Web app** · Execute as **Me** · Access **Anyone** → copy the `/exec`
URL.

## 5. Add them to the page (2 min)

In `index.html`, add an entry to `TENANTS`:

```js
royal: {
  name: 'Royal Catering',
  url: 'https://script.google.com/macros/s/<their exec url>/exec',
  key: '<their API_KEY>'
}
```

Commit and push. GitHub Pages updates in about a minute.

> The tests refuse two businesses sharing a URL or a key — the copy-paste mistake that would
> point two businesses at one Sheet.

## 6. Wire it up (3 min)

In their Apps Script editor, in order:

1. `registerWebhook` — expect `Command menu: updated`
2. Install the **five triggers** (`SETUP_INSTRUCTIONS.md` Step 5)
3. `migrateSheets`
4. Send `/status` to their bot and read it end to end

## 7. Point their Menu Button at their instance (1 min)

**@BotFather → /mybots →** their bot **→ Bot Settings → Menu Button → Configure**:

```
https://fidit-space.github.io/catering-order-manager/?client=royal
```

Open it and check the app shows **their** business name under the title. If it says *FIDIT Demo*,
the `?client=` did not survive — fix it before anyone books anything.

## 8. Give them sight of their books (1 min)

Share their Google Sheet with the client's Google account as **Viewer**.

They can then inspect every order and every Ledger row themselves — a real audit trail — without
being able to change anything. The Ledger is append-only by design; hand-editing it destroys the
one record that can settle a dispute, which is why Viewer and not Editor.

## 9. Hand over (1 min)

Client sends `/start` to their bot, then `/help`.

Fill in the **Menu** tab's `Cost` column with their real figures — margins stay blank until
somebody does, deliberately, because a guessed cost read as truth is worse than no figure.

---

## Fixing something after handover

| What changed | Reaches every business |
|---|---|
| `index.html` — screens, wording, money display, offline queue | **Automatically.** One push → GitHub Pages → everyone, within a minute. |
| `backend/google_apps_script.js` — commands, reports, reminders, money logic | **No.** Paste and redeploy in each business's Apps Script project. About two minutes each. |

Apps Script has no way to push an update to a deployment, and the tool that automates it
(`clasp`) is npm, which **ADR 001** forbids. So the answer is visibility rather than automation:

1. Bump `VERSION` at the top of `backend/google_apps_script.js` — **CI fails the push if you
   forget**
2. Redeploy each business: paste, **Deploy → Manage deployments → ✏️ → New version**
3. Send `/status` to each bot and check the `Version` line matches

A business whose `/status` shows an older `Version` is running old code. That is the whole point
of the line.

> Never use **Deploy → New deployment** for an update. It mints a new URL, the webhook keeps
> posting to the old one, and the bot goes completely silent with no error anywhere. Use
> **Manage deployments → ✏️ edit → New version**, which keeps the URL.

---

## What is deliberately not built

**Roles inside one business** — a chef who sees the cooking list but no money. That is a separate
design and a separate change to the authentication path. Tenancy and roles are not being put
through that path at the same time.

**Client-editable anything.** The client reads their Sheet and uses the app. Menu, prices and
settings are edited in the Sheet by whoever maintains the business — which is FIDIT until the
owner is trained.
