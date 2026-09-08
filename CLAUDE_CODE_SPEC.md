# 📋 Claude Code Execution Specification: Mobile Catering Order Manager

> **Objective:** Build a zero-cost, phone-only Catering Order Management & Reminder System for a non-technical food caterer who operates exclusively on a mobile smartphone.
> **Supervisor / Overseer:** Antigravity AI Engine.

---

## 🚫 Hard Constraints (MUST NOT BE VIOLATED)
1. **NO Node.js/Python server runtimes** — No Express, FastAPI, Flask, Docker, VPS, or Heroku. The backend must be 100% serverless on **Google Apps Script** (0 cost, zero maintenance).
2. **NO npm/Vite/Webpack build pipelines** — The frontend must be pure, single-file vanilla HTML/CSS/JavaScript. It must run instantly on **GitHub Pages** without any compilation or CI/CD step.
3. **Mobile-First UX** — Target device is a smartphone screen (iOS Safari / Android Chrome / Telegram WebApp WebView). All buttons/inputs must have minimum 48px touch targets, sticky bottom action bar, and no horizontal scroll.
4. **Zero Channel Friction for Customers** — Customers remain on WhatsApp. The owner uses Telegram as his private operational assistant.

---

## 🏗️ Architecture Blueprint

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (GitHub Pages)                       │
│  index.html (Telegram Mini App: Menu categories, quantities, customer)  │
│  - Supports Biryani, Mandi, Fried Rice, Curries, Desserts, Custom       │
│  - Direct touch steppers: ±1 tap, ±10 long-press                        │
│  - If opened outside Telegram: Shows clean business landing card        │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ HTTP POST (CORS friendly text/plain)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       BACKEND (Google Apps Script)                      │
│  backend/google_apps_script.js                                          │
│  - doPost(e): Accepts both Mini App orders and Telegram Webhook callbacks│
│  - doGet(e): Health check endpoint returning status & total order count │
│  - Sheets: Auto-manages "Orders" and "Customers" tabs                   │
│  - Reminders: checkAndSendReminders() hourly time-driven cron trigger    │
│  - Webhook: registerWebhook() helper to bind Telegram API to the WebApp │
└──────────────────────┬───────────────────────────┬──────────────────────┘
                       │ Alerts & Buttons          │ Updates Sheet
                       ▼                           ▼
            Telegram Bot Chat (Owner)     Google Sheets Database
            - Instant Order Receipt       - Orders History
            - 24h & 3h Audio Reminders    - Customer CRM (Name, Phone, Visits)
            - [📞 Call] [💬 WA] [✅ Deliver]
```

---

## 🛠️ Required Tasks for Claude Code

### Task 1: Complete Backend (`backend/google_apps_script.js`)
- [ ] **Fix Webhook Binding:** Add `registerWebhook()` function calling `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WEBAPP_URL>`.
- [ ] **Fix Order ID Collisions:** Format as `ORD-yyMMdd-HHmmss-XXXX` (where XXXX is 4 random alphanumeric characters).
- [ ] **Implement `doGet(e)`:** Return JSON `{ status: "ok", timestamp: "...", totalOrders: N, pendingOrders: M }` so setup can be health-checked in any browser.
- [ ] **Timezone Enforcement:** Explicitly parse all dates and times using `GMT+05:30` (or configurable timezone constant) to eliminate server time drift.
- [ ] **Telegram Inline Keyboard Callback:** In `handleCallbackQuery()`, parse `deliver_<orderId>`, update Google Sheet status to `Delivered`, and call `answerCallbackQuery` + edit message caption with `✅ DELIVERED`.
- [ ] **Customer Upsert Logic:** When saving an order, match phone number in `Customers` sheet. If exists, increment `Total Orders` and update `Last Order Date`. If new, append a new row.
- [ ] **Reminder Engine (`checkAndSendReminders`):**
  - Alert 1 (24h before): "Prep Alert: Buy meat/rice, verify spices".
  - Alert 2 (3h before): "Dispatch Alert: Cooking window, call driver".
  - Inline buttons: `[📞 Call Customer]` (`tel:...`), `[💬 WhatsApp]` (`https://wa.me/...`), `[✅ Mark Delivered]`.

### Task 2: Complete Frontend (`index.html`)
- [ ] **CORS Fix for Google Apps Script:** Send payload as `Content-Type: text/plain` with `redirect: 'follow'` to handle Google Apps Script 302 redirects seamlessly and display real server response errors.
- [ ] **Category & Menu Structure:**
  - Biryani (Chicken Dum, Mutton Dum, Beef, Egg/Veg)
  - Mandhi (Chicken Quarter/Half/Full, Mutton Mandhi)
  - Fried Rice (Chicken, Seafood, Egg, Veg)
  - Curries & Gravy (Butter Chicken, Chilli Chicken, Raita)
  - Desserts (Watalappam, Gulab Jamun, Pudding)
  - Custom Item entry (with delete ❌ button on custom additions).
- [ ] **Flexible Stepper:** Single tap for `+1` / `-1`, and quick buttons for `+5` / `+25` for large party orders.
- [ ] **Telegram Environment Detection:**
  - If inside Telegram: Run `tg.expand()`, `tg.ready()`, and use native theme colors and popups.
  - If outside Telegram (standard browser): Display order form with clean standalone styling and a top banner: *"Catering Management Console"*.
- [ ] **Payment Math:** Auto-calculate `Balance Due = Total Amount - Advance Paid` in real-time.

### Task 3: Comprehensive Deployment Documentation (`SETUP_INSTRUCTIONS.md`)
- [ ] Detailed step-by-step guide with exact copy-paste values for:
  1. Telegram `@BotFather` bot generation & Chat ID lookup.
  2. Google Sheet creation & Apps Script deployment as Web App.
  3. Running `registerWebhook()` to enable interactive buttons.
  4. Setting up the Google Apps Script hourly trigger.
  5. Deploying to GitHub Pages.
  6. Configuring `@BotFather` menu button to open the Mini App.

---

## 🔍 Validation Checklist (Overseer Audit Criteria)
Before completion, Antigravity will audit:
1. Syntax check on all JavaScript and Apps Script code.
2. Simulated HTTP POST & GET requests to verify JSON schema compatibility.
3. Verification that no external npm packages or build steps were introduced.
4. Mobile responsiveness verification on 375px width (iPhone standard).
