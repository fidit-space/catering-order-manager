# 🍛 How to change the menu and the prices

**You do not need a computer, and you do not need any help with code.**
Everything about the menu lives in one tab of the Google Sheet. Change it there and
the app updates the next time it is opened.

---

## Once, on the phone

Install the **Google Sheets** app (Play Store / App Store) and open the
**Catering Orders** sheet. Tap the tab named **Menu** at the bottom.

---

## What the columns mean

| Column | What to put | Example |
|---|---|---|
| **Category** | Which group the dish appears under | `Biryani` |
| **Item** | The dish name as it should appear in the app | `Chicken Dum Biryani` |
| **Unit** | What you count it in | `Pax`, `Packs`, `Litres`, `Cups` |
| **Rate** | Price for **one** unit, in rupees, numbers only | `950` |
| **Step** | How much one tap of ➕ adds | `5` |
| **Active** | `YES` to show it, `NO` to hide it | `YES` |
| **Cost** | What **one** unit costs you to make, in rupees | `550` |

---

## ⚠️ If you see no profit figures

The Cost column is what produces them. A Menu tab created before costing existed does not have
that column at all — ask your setup helper to run **migrateSheets** once, then fill in Cost for
each dish. Until Cost has a number in it, the app shows no margin rather than guessing one.

---

## About the Cost column

`Rate` is what the customer pays. `Cost` is what that portion costs **you** — the chicken,
rice, spices, gas and packaging for one plate.

Fill it in and the app works out your profit on every order automatically, with nothing
extra to type. Leave it blank and everything still works; you just will not see a profit
figure for that dish.

You do not need to be exact. A close estimate is enough to tell a good order from a bad one.

**Why it matters:** ingredient prices move. If chicken goes up and your Rate does not, a
Rs. 950 biryani can quietly start losing money. With Cost filled in, the order screen shows
the margin and turns it **red below 20%** — so you see it on the day, not at the end of the
month.

Update Cost whenever market prices shift noticeably. Once a month is usually plenty.

---

## The three things you will actually do

### Change a price
Find the dish, tap the **Rate** cell, type the new number. Done.
The app picks it up the next time it is opened.

### Add a new dish
Go to the first empty row and fill in all six columns. Use a Category that already
exists to put it in an existing tab, or type a new word to create a new group.

```
Curry | Fish Curry (Ambul Thiyal) | Litres | 2600 | 1 | YES | 1500
```

### Stop offering something
Do **not** delete the row — past orders refer to it. Change **Active** to `NO`.
It disappears from the app but the history stays correct. Change it back to `YES`
whenever you want it again.

---

## Choosing a good "Step"

The ➕ button adds one Step at a time, so pick the number you usually sell in:

- Biryani sold by the head → Step `5` (tap 12 times for 60 pax… or just tap the
  number in the middle and **type** `60` directly)
- Full mandhi trays → Step `1`
- Gulab jamun by the piece → Step `10` or `25`

You can always tap the quantity number itself and type an exact figure.

---

## Rules that matter

1. **Never change the header row** (row 1). The app looks for those exact names.
2. **Rate must be a plain number** — `950`, not `Rs. 950` or `950.00/-`.
3. **Never rename the Menu tab.**
4. Category names are grouped exactly as typed, so `Biryani` and `biryani` would
   make two separate tabs. Keep the spelling consistent.

---

## If a change does not show up

The app remembers the last menu it saw so it still works without signal. To force a
refresh: close the Mini App completely and open it again. If it still looks old,
check your internet connection — the app is showing you the saved copy.
