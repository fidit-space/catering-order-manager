# 🛠 Setup Instructions — Catering Order Manager

Do this **once**, on a laptop or a phone in desktop-mode browser. About 15 minutes.
After it is done the cook only ever taps one button in Telegram.

You will need: a Google account, Telegram installed, and a GitHub account.

---

## Step 1 — Create the Telegram bot (3 min)

1. Open Telegram, search **@BotFather**, tap Start.
2. Send `/newbot`.
3. Give it a name (`Royal Catering Orders`) and a username ending in `bot`
   (`royal_catering_orders_bot`).
4. **Copy the HTTP API token.** It looks like `8123456789:AAF-xxxxxxxxxxxxxxxxxxxx`.
5. Search **@userinfobot**, tap Start, and **copy the numeric Id** — this is the
   chat the reminders will be sent to. If the cook will receive the alerts, he
   must be the one to do this step on *his* phone.

> ⚠️ The token is a password for the bot. Never paste it into a file that goes to GitHub.

---

## Step 2 — Create the Google Sheet and backend (5 min)

1. Go to [sheets.google.com](https://sheets.google.com) → blank sheet → name it **Catering Orders**.
2. **File → Settings → Time zone → `(GMT+05:30) Colombo`.** Save. *(Do not skip this.)*
3. **Extensions → Apps Script.**
4. Delete everything in the editor and paste the whole of `backend/google_apps_script.js`.
5. Near the top of the file find `function setupProperties()` and fill in the four values:

   ```js
   TELEGRAM_BOT_TOKEN:     '8123456789:AAF-...',   // from Step 1
   TELEGRAM_OWNER_CHAT_ID: '987654321',            // from Step 1
   API_KEY:                'pick-any-word-2026',   // you will paste this into index.html too
   WEBHOOK_SECRET:         'pick-another-word'     // never leaves Google/Telegram
   ```

6. Save (💾). In the function dropdown choose **setupProperties** and press **Run**.
   Authorise the permissions when asked (choose your account → Advanced → Go to project → Allow).
7. **Now delete those four values again** (leave the empty quotes) and save. They are
   stored safely in Script Properties; the file no longer contains any secret.
8. Check the spreadsheet — **Menu**, **Orders**, **Customers** and **Log** tabs now exist.

---

## Step 3 — Deploy the backend as a Web App (2 min)

1. In Apps Script click **Deploy → New deployment**.
2. Gear icon → **Web app**.
   - Description: `Catering backend`
   - Execute as: **Me**
   - Who has access: **Anyone**
3. **Deploy** → copy the **Web app URL** (`https://script.google.com/macros/s/..../exec`).
4. Paste that URL into your browser and add `?action=health` to the end. You should see:

   ```json
   {"status":"ok","timestamp":"...","timezone":"Asia/Colombo",...}
   ```

   If you see an error page instead, the deployment access is not set to *Anyone*.

> 🔁 **Every time you redeploy, use "Manage deployments → ✏️ edit → New version"**, not a
> brand-new deployment.
>
> **Why this matters.** *New deployment* mints a brand-new `/exec` URL. Two things keep
> pointing at the old one and neither says a word about it:
>
> | Consumer | How it learns the URL | Symptom when it is stale |
> |---|---|---|
> | Telegram webhook | `registerWebhook()` | **The bot goes completely silent.** No reply to any command, no error anywhere |
> | Mini App | `APPS_SCRIPT_WEBAPP_URL` in `index.html` | "Could not load orders", app shows offline |
>
> This happened on 2026-09-09. If you ever do create a new deployment, run
> `registerWebhook` again **and** update `index.html`.

---

## Step 4 — Turn on the Telegram buttons (1 min)

Back in the Apps Script editor, choose **registerWebhook** in the function dropdown and
press **Run**.

This is what makes the **✅ Mark as Delivered** buttons and the `/today` command work.
Without it the buttons do nothing. It also publishes the command list, so Telegram's blue
**Menu** button in the chat lists every command as a tappable row.

Read the summary it prints — it names the URL it registered. Then verify with
**getWebhookInfo**: the log should show that same `/exec` URL, `pending_update_count: 0` and
no `last_error_message`.

**If it refuses because it found a `/dev` URL** — which is what this project's editor reports —
name the real deployment once and it will never ask again:

The deployment URL is written down in **`DEPLOYMENT_URL`**, a constant at the very top of
`backend/google_apps_script.js`. `registerWebhook` uses it, so normally there is nothing to do.

If you deploy to a **new** URL, either update that constant and paste the whole file in again,
or add a `DEPLOYMENT_URL` script property with the new value — the property wins over the
constant, and `diagnose()` prints which one is in force.

> Editing one line inside a large file on a phone is unreliable: two live attempts left the
> file with a syntax error or stored the value as just `/exec`, and the bot stayed down both
> times. Replacing the **whole file** is the reliable operation, so the URL travels with it.

The `/dev` URL demands a Google login, so Telegram is served a login page, gets **401**, and
drops every update — the bot answers nothing at all and no error appears anywhere. This is why
the URL is checked rather than trusted.

---

## Step 4b — Run the migration (1 min, required on an existing sheet)

In the Apps Script editor choose **migrateSheets** and press **Run**.

The sheet helpers only write headers when they *create* a tab, so a spreadsheet that already
holds orders never picks up a schema change. This brings it up to date and, critically,
**gives money recorded before the Ledger existed a ledger entry to stand on** — without it,
the first payment taken on an older order would erase the advance already paid.

Read the summary it returns. Run it again and it should say *"Nothing to migrate"*.

---

## Step 4c — Check everything is wired up (30 seconds)

Choose **diagnose** in the function dropdown and press **Run**. The report arrives in your
Telegram chat and in the execution log, and covers the four things that have gone wrong
silently before:

- **Webhook** — is one registered, does it match this deployment, is there a delivery error
- **Properties** — which credentials are set (names only; values are never printed)
- **Triggers** — which of the five scheduled jobs are actually installed
- **Sheets** — the Orders column count, and whether the Menu has any costs (no costs means
  no margin figures will ever appear)
- **Recent errors** — the last five rows of the Log tab

Run this first whenever something looks wrong. It is faster than guessing.

### If the Mini App says "Sign-in data failed verification"

The launch signature is checked against `TELEGRAM_BOT_TOKEN`. A token can be perfectly valid —
every bot message still works — and yet belong to a **different bot** from the one the app was
opened from, in which case every sign-in fails and nothing else looks wrong.

1. Run **`debugAuthOn`**
2. Open the Mini App from the bot once (it will fail again — that is the point)
3. Run **`explainAuthFailure`**
4. Run **`debugAuthOff`** when you are done

It tests the captured launch against every valid form of the check and tells you whether the
algorithm or the token is at fault. It prints field names, the bot id and your user id —
never a token.

---

## Step 5 — Set up the five automatic jobs (3 min)

Click the ⏰ **Triggers** icon in the left sidebar, then **Add Trigger**, five times:

| Function | Event source | Type | When | What it does |
|---|---|---|---|---|
| `checkDispatchAlerts` | Time-driven | Minutes timer | Every **15 minutes** | Urgent cook-and-dispatch alert ~3 hours before each delivery |
| `sendDailyPrepDigest` | Time-driven | Day timer | **8pm–9pm** | One prep list for tomorrow, with each dish totalled across all orders |
| `checkUnpaidBalances` | Time-driven | Day timer | **9am–10am** | Chases delivered orders that still owe money |
| `weeklyBackup` | Time-driven | Week timer, Monday | **6am–7am** | Emails a full CSV copy of every sheet |
| `reportNewErrors` | Time-driven | Day timer | **7am–8am** | Pushes anything new in the Log tab to Telegram |

Each order is only ever chased for payment **once**, so this cannot become a daily nag.
The backup also lands in a Google Drive folder called *Catering Backups*.

`reportNewErrors` matters more than it looks: the Log tab records every failure, but
nobody reads a spreadsheet tab. This is what stops a problem from being silent.

You do **not** need to install a trigger for `onEdit` — Apps Script runs it automatically.
It repairs the delivery date, time and phone columns whenever someone edits them by hand,
which is what keeps the reminders working after the sheet has been touched. If the sheet
was edited before this existed, run `repairAllOrderRows()` once from the editor.

---

## Step 6 — Put the app online (3 min)

1. Open `index.html` and edit the two lines near the top of the `<script>` block
   (around line 470):

   ```js
   var APPS_SCRIPT_WEBAPP_URL = "https://script.google.com/macros/s/..../exec";
   var API_KEY = "pick-any-word-2026";   // must match Step 2 exactly
   ```

2. Push the repository to GitHub.
3. Repository → **Settings → Pages** → Branch `main`, folder `/ (root)` → **Save**.
4. After ~60 seconds the app is live at `https://<username>.github.io/<repo>/`.
   Open it in a normal browser first — you should see the order form with a dark
   "Catering Management Console" banner across the top.

---

## Step 7 — Link the app to the bot (1 min)

1. **@BotFather** → `/mybots` → your bot → **Bot Settings → Menu Button → Configure menu button**.
2. Send your GitHub Pages URL.
3. Send the button title: `📋 New Order`.

Open the bot in Telegram. A **📋 New Order** button now sits at the bottom of the chat.

---

## Step 8 — Prove it works (2 min)

In Apps Script, run **runSelfTest**. It books a throwaway order due in 20 minutes,
checks the date parsing, sends you a real Telegram alert, then deletes the test row.
Read the execution log — every line should say what it did.

Then do a real end-to-end check on the phone:

1. Tap **📋 New Order** in Telegram.
2. Add 60 pax of Chicken Dum Biryani, set tomorrow 1pm, enter a name and `077 123 4567`.
3. Tap **SAVE ORDER**.
4. You should immediately get a Telegram message with **Call / WhatsApp / Map / Mark
   Delivered** buttons — and the WhatsApp button must open the correct chat.
5. Tap **Mark as Delivered** — the message should get a `✅ DELIVERED` line appended and
   the Orders sheet should say `Delivered`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Not connected to the server yet" banner | Step 6 not done | Paste the real Web App URL and API key into `index.html` |
| App saves but nothing appears in Telegram | Wrong chat id, or the owner never pressed Start on the bot | Send `/start` to the bot, re-check `TELEGRAM_OWNER_CHAT_ID` |
| "Unauthorised: bad or missing key" | `API_KEY` differs between `index.html` and Script Properties | Make them identical |
| Buttons in Telegram do nothing | Step 4 skipped, or you redeployed to a new URL | Run `registerWebhook` again |
| **The bot replies to nothing at all** | You used *New deployment*, so Telegram is posting to a URL that no longer answers | Run `diagnose` — it names the mismatch. Then `registerWebhook`, and update `index.html` |
| The same report arrives over and over | Telegram is retrying because the webhook answered too slowly | Fixed in the current backend; redeploy, then `registerWebhook` to drop the backlog |
| No commands in the blue Menu button | `setMyCommands` never ran | Run `registerWebhook` — it publishes the list |
| No reminders arrive | Triggers missing, or Sheet timezone wrong | Redo Step 5; check Step 2.2 |
| Reminders arrive at odd hours | Sheet timezone is not Colombo | File → Settings → Time zone |
| Something failed silently | — | Open the **Log** tab in the spreadsheet; every error is recorded there |

---

## Security model — read this before deploying

`index.html` is served publicly by GitHub Pages, so **anything inside it is public**,
including `API_KEY` and the Web App URL. A static page cannot keep a secret.

| Value | Secret? | Where it lives |
|---|---|---|
| **Bot token** | 🔴 **Yes — the only real secret** | Script Properties, nowhere else |
| Order counts on `/health` | ⚪ Shown only to a verified Telegram launch | — |
| Webhook secret | 🔴 Yes | Script Properties |
| `API_KEY` | ⚪ No — public by design | `index.html`; a spam filter only |
| Web App URL | ⚪ No — public by design | `index.html` |

Access control is **Telegram's signature**, not the key. Every request must carry
`initData`, which Telegram signs with your bot token; the backend verifies it and checks
the user id against the owner. A stranger with the URL and key can reach nothing.

Two optional Script Properties:

- `EXTRA_TELEGRAM_USER_IDS` — comma-separated ids allowed besides the owner.
- `ALLOW_BROWSER_ACCESS` — set to `YES` to permit **read-only** use outside Telegram while
  debugging. Writes stay blocked regardless. Leave it unset in normal operation.

If the bot token is ever exposed, revoke it through `@BotFather` immediately — the whole
authentication depends on it. For a leaked URL or key, follow
[`.team/ROTATION_RUNBOOK.md`](.team/ROTATION_RUNBOOK.md).

---

## The money record

Every payment, refund and cost is one row in the **Ledger** tab, appended and never edited.
An order's `Received` and `Balance Due` are recalculated from it — if the two ever disagree,
the Ledger is right.

**Do not edit the Ledger by hand.** It is the audit trail; correcting a mistake means adding
a new entry, not changing an old one. Consider protecting the range: *Data → Protect sheets
and ranges*.

Money commands on the bot:

| Command | What it shows |
|---|---|
| `/cash` | Today's takings by method, costs, profit, and what the cash box should physically hold |
| `/owed` | Who owes you, grouped by how overdue they are |
| `/month` | Revenue, costs, profit and margin for the month |
| `/spend 4500 chicken` | Records a cost — the category is worked out from the words |
| `/pay <order id> 20000` | Records a part payment; add `bank` or `card` if it was not cash |

`/spend` accepts a trailing `bank` or `card` when it was not cash, e.g. `/spend 800 driver bank`.

---

## Adjusting how it behaves

The **Settings** tab in the spreadsheet controls the timings, with no code change:

| Setting | Default | What it does |
|---|---|---|
| `business_name` | Catering Orders | Name on the backup emails |
| `dispatch_lead_minutes` | 180 | How far ahead of delivery the urgent alert fires |
| `payment_chase_days` | 3 | Days after delivery before an unpaid balance is chased. **0 turns chasing off** |
| `backup_email` | *(blank)* | Where backups are sent. Blank = the account owning the sheet |
| `backup_keep_weeks` | 8 | How many weekly backups to keep before deleting the oldest |
| `auth_max_age_hours` | 24 | How long a Telegram launch stays valid before the app must be reopened |

---

## What is stored where

| Thing | Location | Who can change it |
|---|---|---|
| Dishes, units, prices, costs | **Menu** tab of the spreadsheet | Anyone with the Sheet — see `MENU_GUIDE.md` |
| Every rupee in or out | **Ledger** tab — append-only | The app only. Do not edit by hand |
| Timings and backup target | **Settings** tab | Anyone with the Sheet |
| Orders | **Orders** tab | The app, or by hand |
| Customer directory | **Customers** tab | Built automatically from orders |
| Errors | **Log** tab | Read only |
| Bot token, chat id, keys | Apps Script → Project Settings → Script Properties | Setup helper only |

Nothing is stored on any third-party server. Total running cost: **Rs. 0**.
