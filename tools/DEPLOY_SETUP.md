# Setting up one-command deployment

Pushes `backend/google_apps_script.js` to every business and cuts a new version, so nobody
pastes 130KB into an editor again. About twenty minutes, once.

**What it costs.** A Google OAuth refresh token stored on your machine. That is the most
powerful credential this project's tooling touches — it can read and rewrite the Apps Script
projects it is scoped to. It lives in `tools/deploy.local.json`, which is gitignored, and
nothing prints it. Revoke it any time at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

If you would rather not hold that token, the manual paste still works and `node tools/instances.js`
still tells you who is stale. This is a convenience, not a requirement.

---

## 1. Turn the API on (1 min)

Open [script.google.com/home/usersettings](https://script.google.com/home/usersettings) and
switch **Google Apps Script API** on. Without this every call returns 403.

## 2. Create an OAuth client (10 min)

1. [console.cloud.google.com](https://console.cloud.google.com) → new project, e.g. `fidit-deploy`
2. **APIs & Services → Library** → search **Apps Script API** → **Enable**
3. **APIs & Services → OAuth consent screen** → External → fill the required fields →
   add yourself under **Test users**
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   Application type **Desktop app**
5. Copy the **client ID** and **client secret**

> Leave it as a Testing app. Publishing is for apps with real users; this has one.

## 3. Collect each business's script id (2 min)

Open each business's Apps Script editor → **⚙️ Project Settings** → copy the **Script ID**.

This is not the same as the `/exec` URL — that contains the *deployment* id. You want the one
labelled Script ID.

## 4. Write the config (2 min)

Create `tools/deploy.local.json`:

```json
{
  "clientId": "....apps.googleusercontent.com",
  "clientSecret": "....",
  "scriptIds": {
    "demo": "<FIDIT Demo script id>",
    "basith": "<Basith Foods script id>"
  }
}
```

The keys under `scriptIds` must match the ids in the `TENANTS` map in `index.html`.

## 5. Authorise (2 min)

```
node tools/deploy.js --auth
```

It prints a URL, you open it signed in as the account that owns the scripts, and it captures the
result on a local port. The refresh token is written back into the same file.

---

## Using it

```
node tools/deploy.js --dry-run      # say what it would do, change nothing
node tools/deploy.js --only demo    # one business
node tools/deploy.js                # all of them
```

It deploys **sequentially and on purpose**: if the first business breaks, the second is still
running the last known-good build while you look at it. Deploy `demo` first out of habit — that
is what it is for.

Afterwards it runs `tools/instances.js` automatically, so the last thing you see is whether every
business is actually serving the new version.

## What it refuses to do

- **Overwrite a project holding more than one script file.** `updateContent` replaces every file,
  so it fetches the existing content and swaps only the one server-side script — clobbering
  `appsscript.json` would take the timezone and OAuth scopes with it. More than one and it stops
  rather than guessing.
- **Move the `@HEAD` deployment.** That is the `/dev` URL, which Telegram cannot reach. Moving it
  would look like a successful deploy and change nothing that matters. If a project has more than
  one versioned deployment it stops and asks you to pick.

## When it fails

| Message | Cause |
|---|---|
| `403 … API has not been used` | Step 1 not done, or done on a different account |
| `Could not refresh the token` | Consent revoked or expired — re-run `--auth` |
| `expected exactly one script file` | The project has extra `.gs` files; deploy that one by hand |
| `expected exactly one versioned deployment` | Someone used *New deployment* at some point; archive the stale ones |
| `no scriptId` | The business is in `TENANTS` but not in `scriptIds` |
