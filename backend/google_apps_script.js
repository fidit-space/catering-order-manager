/**
 * CATERING ORDER MANAGEMENT SYSTEM - GOOGLE APPS SCRIPT
 * 
 * Free serverless backend:
 * 1. Receives orders from Telegram Mini App / Webhook.
 * 2. Maintains "Orders" and "Customers" databases in Google Sheets.
 * 3. Sends instant Telegram confirmation message to the business owner.
 * 4. Runs automated hourly checks to send Delivery Reminders (24 hours & 3 hours before).
 */

// ==================== CONFIGURATION ====================
// Set your Telegram Bot Token (from @BotFather) and Owner Chat ID
const CONFIG = {
  TELEGRAM_BOT_TOKEN: "YOUR_TELEGRAM_BOT_TOKEN_HERE", // e.g. "123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
  TELEGRAM_OWNER_CHAT_ID: "YOUR_TELEGRAM_CHAT_ID_HERE", // e.g. "987654321" (get from @userinfobot)
  SHEET_ORDERS: "Orders",
  SHEET_CUSTOMERS: "Customers"
};

/**
 * 1. Webhook endpoint: Handles incoming POST requests from the Telegram Mini App or Bot
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "No data received" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const data = JSON.parse(e.postData.contents);

    // Case A: Callback Query from Telegram inline button (e.g. "Mark as Delivered")
    if (data.callback_query) {
      handleCallbackQuery(data.callback_query);
      return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Case B: Order payload from Telegram Mini App
    if (data.order) {
      const order = data.order;
      const orderId = "ORD-" + Utilities.formatDate(new Date(), "GMT+05:30", "yyMMdd-HHmm");

      // 1. Save order to Orders Sheet
      saveOrderToSheet(orderId, order);

      // 2. Save/Update Customer in Customers Sheet
      upsertCustomer(order.customerName, order.customerPhone, order.deliveryAddress);

      // 3. Send Telegram Notification to the Owner
      sendNewOrderTelegramAlert(orderId, order);

      return ContentService.createTextOutput(JSON.stringify({ status: "success", orderId: orderId }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ status: "unknown_payload" }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log("Error in doPost: " + err.toString());
    return ContentService.createTextOutput(JSON.stringify({ status: "error", error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * 2. Save new order to the "Orders" sheet
 */
function saveOrderToSheet(orderId, order) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_ORDERS);

  // Initialize sheet headers if it doesn't exist
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_ORDERS);
    sheet.appendRow([
      "Order ID",
      "Timestamp",
      "Delivery Date",
      "Delivery Time",
      "Customer Name",
      "Customer Phone",
      "Delivery Address",
      "Menu Items Ordered",
      "Total Amount",
      "Advance Paid",
      "Balance Due",
      "Status",
      "Special Notes",
      "Reminder 24h Sent",
      "Reminder 3h Sent"
    ]);
    sheet.getRange("A1:O1").setFontWeight("bold").setBackground("#e2e8f0");
  }

  const nowStr = Utilities.formatDate(new Date(), "GMT+05:30", "yyyy-MM-dd HH:mm:ss");

  sheet.appendRow([
    orderId,
    nowStr,
    order.deliveryDate,
    order.deliveryTime,
    order.customerName,
    "'" + order.customerPhone,
    order.deliveryAddress,
    order.itemsSummary,
    order.totalAmount,
    order.advancePaid,
    order.balanceDue,
    order.prepStatus || "Confirmed",
    order.specialNotes,
    "NO", // 24h reminder status
    "NO"  // 3h reminder status
  ]);
}

/**
 * 3. Customer Database: Maintain customer history & contact records
 */
function upsertCustomer(name, phone, address) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_CUSTOMERS);

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_CUSTOMERS);
    sheet.appendRow(["Phone Number", "Customer Name", "Last Address", "Total Orders", "First Seen", "Last Order Date"]);
    sheet.getRange("A1:F1").setFontWeight("bold").setBackground("#e2e8f0");
  }

  const cleanPhone = String(phone).trim();
  const data = sheet.getDataRange().getValues();
  const todayStr = Utilities.formatDate(new Date(), "GMT+05:30", "yyyy-MM-dd");
  let customerFound = false;

  for (let i = 1; i < data.length; i++) {
    const rowPhone = String(data[i][0]).replace("'", "").trim();
    if (rowPhone === cleanPhone) {
      // Customer exists, increment orders count and update last seen
      customerFound = true;
      const currentOrders = Number(data[i][3]) || 1;
      sheet.getRange(i + 1, 4).setValue(currentOrders + 1);
      sheet.getRange(i + 1, 6).setValue(todayStr);
      if (address && address !== "Not specified") {
        sheet.getRange(i + 1, 3).setValue(address);
      }
      break;
    }
  }

  if (!customerFound) {
    // New customer entry
    sheet.appendRow(["'" + cleanPhone, name, address, 1, todayStr, todayStr]);
  }
}

/**
 * 4. Send rich Telegram Alert to Owner upon order placement
 */
function sendNewOrderTelegramAlert(orderId, order) {
  const cleanPhone = order.customerPhone.replace(/[^0-9+]/g, '');
  const waUrl = "https://wa.me/" + cleanPhone.replace("+", "");
  const telUrl = "tel:" + cleanPhone;

  let message = `🎉 *NEW CATERING ORDER BOOKED*\n`;
  message += `━━━━━━━━━━━━━━━━━━━━━\n`;
  message += `🆔 *Order ID:* \`${orderId}\`\n`;
  message += `📅 *Delivery Date:* *${order.deliveryDate}*\n`;
  message += `⏰ *Delivery Time:* *${order.deliveryTime}*\n`;
  message += `━━━━━━━━━━━━━━━━━━━━━\n`;
  message += `👤 *Customer:* ${order.customerName}\n`;
  message += `📞 *Phone:* ${order.customerPhone}\n`;
  message += `📍 *Address:* ${order.deliveryAddress}\n`;
  message += `━━━━━━━━━━━━━━━━━━━━━\n`;
  message += `🍛 *ORDER ITEMS:*\n${order.itemsSummary.split("; ").map(item => "• " + item).join("\n")}\n`;
  message += `━━━━━━━━━━━━━━━━━━━━━\n`;
  message += `💵 *Total:* ${order.totalAmount} | *Advance:* ${order.advancePaid}\n`;
  message += `⚠️ *Balance Due:* ${order.balanceDue}\n`;
  if (order.specialNotes && order.specialNotes !== "-") {
    message += `📝 *Notes:* _${order.specialNotes}_\n`;
  }

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: "📞 Call Customer", url: telUrl },
        { text: "💬 Open WhatsApp", url: waUrl }
      ],
      [
        { text: "✅ Mark as Delivered", callback_data: `deliver_${orderId}` }
      ]
    ]
  };

  sendTelegramMessage(CONFIG.TELEGRAM_OWNER_CHAT_ID, message, inlineKeyboard);
}

/**
 * 5. AUTOMATED REMINDERS: Set to run every hour via Apps Script Trigger
 * - Checks for deliveries in next 24 Hours (Ingredient prep alert)
 * - Checks for deliveries in next 3 Hours (Cooking & dispatch alert)
 */
function checkAndSendReminders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEET_ORDERS);
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return;

  const now = new Date();

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const orderId = row[0];
    const deliveryDateStr = row[2]; // e.g. 2026-09-09
    const deliveryTimeStr = row[3]; // e.g. 13:00
    const customerName = row[4];
    const customerPhone = String(row[5]).replace("'", "");
    const address = row[6];
    const items = row[7];
    const status = row[11];
    const rem24Sent = row[13];
    const rem3Sent = row[14];

    // Only process pending or confirmed orders
    if (status === "Delivered" || status === "Cancelled") continue;

    // Parse delivery date and time
    const deliveryDateTime = new Date(`${deliveryDateStr}T${deliveryTimeStr}:00`);
    if (isNaN(deliveryDateTime.getTime())) continue;

    const diffHours = (deliveryDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);

    const cleanPhone = customerPhone.replace(/[^0-9+]/g, '');
    const waUrl = "https://wa.me/" + cleanPhone.replace("+", "");

    // A. 24 Hours Before Reminder (Between 20h and 26h before)
    if (diffHours > 3 && diffHours <= 26 && rem24Sent !== "YES") {
      let msg = `🔔 *REMINDER: ORDER TOMORROW*\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `Order *${orderId}* is scheduled for *Tomorrow at ${deliveryTimeStr}*.\n\n`;
      msg += `👤 *Customer:* ${customerName} (${customerPhone})\n`;
      msg += `🍛 *Items:* ${items}\n`;
      msg += `📍 *Delivery Address:* ${address}\n\n`;
      msg += `💡 _Time to prep ingredients and arrange delivery transport!_`;

      const keyboard = {
        inline_keyboard: [
          [{ text: "💬 WhatsApp Customer", url: waUrl }]
        ]
      };

      sendTelegramMessage(CONFIG.TELEGRAM_OWNER_CHAT_ID, msg, keyboard);
      sheet.getRange(i + 1, 14).setValue("YES"); // Mark 24h reminder sent
    }

    // B. 3 Hours Before Reminder (Dispatch / Cooking reminder)
    if (diffHours > 0 && diffHours <= 3.5 && rem3Sent !== "YES") {
      let msg = `🚨 *URGENT: DELIVERY IN A FEW HOURS!*\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `Order *${orderId}* is due *TODAY at ${deliveryTimeStr}* (${Math.round(diffHours * 60)} mins remaining)!\n\n`;
      msg += `👤 *Customer:* ${customerName} (${customerPhone})\n`;
      msg += `🍛 *Items:* ${items}\n`;
      msg += `📍 *Address:* ${address}\n`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "📞 Call Now", url: "tel:" + cleanPhone },
            { text: "💬 WhatsApp", url: waUrl }
          ],
          [
            { text: "✅ Mark Delivered", callback_data: `deliver_${orderId}` }
          ]
        ]
      };

      sendTelegramMessage(CONFIG.TELEGRAM_OWNER_CHAT_ID, msg, keyboard);
      sheet.getRange(i + 1, 15).setValue("YES"); // Mark 3h reminder sent
    }
  }
}

/**
 * 6. Handle Telegram inline button callbacks (e.g. Mark as Delivered)
 */
function handleCallbackQuery(query) {
  const data = query.data;
  const callbackQueryId = query.id;

  if (data && data.startsWith("deliver_")) {
    const orderId = data.replace("deliver_", "");
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEET_ORDERS);

    if (sheet) {
      const rows = sheet.getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] === orderId) {
          sheet.getRange(i + 1, 12).setValue("Delivered");
          break;
        }
      }
    }

    // Answer callback query in Telegram
    const url = "https://api.telegram.org/bot" + CONFIG.TELEGRAM_BOT_TOKEN + "/answerCallbackQuery";
    UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: `Order ${orderId} marked as Delivered! 🎉`
      })
    });
  }
}

/**
 * Helper: Send Telegram Message
 */
function sendTelegramMessage(chatId, text, replyMarkup) {
  const url = "https://api.telegram.org/bot" + CONFIG.TELEGRAM_BOT_TOKEN + "/sendMessage";
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown"
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}
