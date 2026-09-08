# 🍲 Mobile Catering Order Management & Reminder System

A 100% free, phone-friendly order management and customer database solution designed specifically for small catering business owners who do not use laptops or computers.

---

## 🎯 The Core Problem & Solution

| The Problem | How This Solution Solves It |
| :--- | :--- |
| **No computer or laptop** | Operates 100% on a smartphone inside **Telegram** (already on his phone). |
| **Orders mixed in WhatsApp chats** | Clean touch-friendly interface to log orders in 30 seconds. |
| **Menu categorization** | Categorized tabs for **Biryani, Mandi, Fried Rice, Curries, Desserts, and Custom Orders**. |
| **Customer database** | Automatically saves & updates customer phone numbers, addresses, and order counts. |
| **Missed delivery dates/times** | Automated Telegram push notifications **24 hours** and **3 hours** before delivery with sound & vibration. |
| **Hosting & Running costs** | **$0.00 / Free forever**. Hosted on **GitHub Pages** + **Google Sheets / Apps Script**. |

---

## 🏗️ How The Architecture Works

```mermaid
flowchart TD
    A["Customer messages on WhatsApp"] --> B["Catering Owner opens Telegram on Phone"]
    B --> C["Taps '📋 New Order' Button"]
    C --> D["Telegram Mini App opens inside Telegram (Hosted on GitHub Pages)"]
    D --> E["Selects Biryani/Mandi/Rice + Customer + Delivery Date & Time"]
    E --> F["Taps 'Save Order'"]
    F --> G["Google Apps Script Backend (Serverless)"]
    G --> H[("Google Sheets Database\n(Orders & Customers)")]
    G --> I["Telegram Push Notification: Order Confirmed!"]
    
    subgraph Automated Reminders (Hourly Cron)
        J["Google Apps Script Trigger"] -->|Checks Delivery Times| H
        J -->|24h Before Delivery| K["🔔 Telegram Alert: Prepare Ingredients!"]
        J -->|3h Before Delivery| L["🚨 Telegram Urgent Alert: Cooking & Dispatch!"]
        K --> M["[Call Customer] [WhatsApp] Buttons"]
        L --> M
    end
```

---

## 📂 Research & Curated GitHub Repositories

If you want to compare or extend this architecture, here are the top open-source projects researched for this specific use case:

1. **[yuzefovichalex/tma-cafe](https://github.com/yuzefovichalex/tma-cafe)**
   - *Description:* A complete Telegram Mini App for cafe and restaurant menus.
   - *Strengths:* Educational, clean UI, easy to adapt for food cataloging.
2. **[ZiyovuddinTolipov/lotos-telegeram-mini-app](https://github.com/ZiyovuddinTolipov/lotos-telegeram-mini-app)**
   - *Description:* Food ordering Telegram Mini App with categorized menus and cart checkout.
   - *Strengths:* Good inspiration for food category tab designs.
3. **[kiran-venugopal/tgcart-mini-app](https://github.com/kiran-venugopal/tgcart-mini-app)**
   - *Description:* E-commerce cart Telegram Mini App (Telegram contest winner).
   - *Strengths:* Production-grade React architecture.
4. **[Guf-Hub/TGBot](https://github.com/Guf-Hub/TGBot)**
   - *Description:* Google Apps Script library to connect Telegram Bot API directly with Google Sheets.
   - *Strengths:* Zero server hosting; runs entirely on Google's cloud.

---

## 🚀 10-Minute Setup Guide (Step-by-Step)

You only need to do this setup **once** (you can do it for him, and he just uses it on his phone):

### Step 1: Create the Telegram Bot (2 minutes)
1. Open Telegram and search for `@BotFather`.
2. Send `/newbot`.
3. Give it a name (e.g. `My Catering Order Bot`) and a username (e.g. `royal_catering_order_bot`).
4. Copy the **HTTP API Token** provided by BotFather.
5. Also, find the friend's Telegram Chat ID: Open Telegram, search `@userinfobot`, press start, and copy the numeric ID (e.g. `123456789`).

---

### Step 2: Set Up Google Sheet & Backend (4 minutes)
1. Go to [Google Sheets](https://sheets.google.com) and create a blank sheet named **"Catering Orders"**.
2. Click **Extensions** > **Apps Script**.
3. Delete any code in the editor, and paste the entire content of [`backend/google_apps_script.js`](file:///media/umair/DataDrive/workspace/products/hotel/backend/google_apps_script.js).
4. In lines 15-16, replace:
   - `TELEGRAM_BOT_TOKEN`: Paste your token from BotFather.
   - `TELEGRAM_OWNER_CHAT_ID`: Paste the numeric Chat ID.
5. Click **Save** (💾 icon).
6. Click **Deploy** > **New deployment**:
   - Select type: **Web app**
   - Description: `Catering Backend`
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Click **Deploy**, authorize permissions, and copy the **Web app URL** (starts with `https://script.google.com/macros/s/.../exec`).

#### Set up the Automated Delivery Reminder Trigger:
1. In the Apps Script window, click the **Triggers** icon (alarm clock on the left menu).
2. Click **Add Trigger** (bottom right):
   - Function to run: `checkAndSendReminders`
   - Event source: **Time-driven**
   - Type of time based trigger: **Hour timer**
   - Hour interval: **Every hour**
3. Click **Save**. Now Google will automatically check upcoming delivery dates every hour and ping his Telegram with audio alerts!

---

### Step 3: Deploy Frontend on GitHub Pages (3 minutes)
1. Open [`index.html`](file:///media/umair/DataDrive/workspace/products/hotel/index.html) in this project.
2. In line 273, replace `APPS_SCRIPT_WEBAPP_URL` with your Google Apps Script Web App URL from Step 2.
3. Push this repository to GitHub (or upload `index.html` to a GitHub repository).
4. In your GitHub repository:
   - Go to **Settings** > **Pages**.
   - Under **Branch**, select `main` (or `master`) and `/root`, then click **Save**.
5. Wait 30 seconds. Your app is now live at `https://<your-username>.github.io/<repo-name>/`.

---

### Step 4: Link the Mini App to Telegram Bot (1 minute)
1. Open `@BotFather` on Telegram.
2. Send `/mybots` > select your catering bot.
3. Click **Bot Settings** > **Menu Button** > **Configure menu button**.
4. Send your GitHub Pages URL (e.g. `https://<username>.github.io/<repo-name>/`).
5. Set the button title to: `📋 New Catering Order`.

---

## 📱 How Your Friend Uses It Daily on His Phone

1. **When a customer messages on WhatsApp:**
   - He discusses food, quantity, and date.
2. **Logging the order:**
   - He opens his Telegram bot.
   - Taps the persistent bottom button **"📋 New Catering Order"**.
   - The order screen slides up smoothly on his phone screen.
   - He taps the categories (**Biryani 🍛**, **Mandhi 🍗**, **Fried Rice 🍚**, etc.) and taps `+` to add portions/pax (e.g. 50 Pax Chicken Biryani).
   - Enters customer name, phone number, and delivery date/time.
   - Taps **"💾 Save Order & Set Reminder"**.
3. **Instant Telegram Confirmation:**
   - He immediately gets a formatted receipt in Telegram with one-tap buttons to call the customer or open WhatsApp.
4. **Automated Reminders:**
   - **24 Hours Before:** His phone rings with an alert reminder so he can purchase chicken, rice, spices, and supplies.
   - **3 Hours Before:** An urgent alert rings to start packing, dispatching, and contacting the driver.
   - When delivered, he taps **"✅ Mark as Delivered"** directly inside Telegram!

---

## 💡 Bonus Alternative: Google AppSheet (Zero-Code Option)
If you prefer not to use Telegram at all:
- In Google Sheets, click **Extensions > AppSheet > Create an app**.
- AppSheet automatically generates a native mobile app from the `Orders` and `Customers` tabs with zero code.
- He can install it on his Android or iPhone directly from Google Play / App Store.
- Provides built-in call buttons, Google Maps navigation to customer addresses, and order status boards.
