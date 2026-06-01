# Hopeland — Between the Stars & Shore
## RV Rental Calendar Sync — Project Overview

---

### What this project does

Prevents double bookings across three short-term RV rental platforms by:
1. **Local dashboard** — fetches all three iCal feeds and shows a unified color-coded calendar with conflict detection, running on your computer
2. **GitHub-hosted merged feed** — automatically merges all three feeds into one public `.ics` file that each platform can import, keeping availability in sync every 30 minutes

---

### Platforms

| Platform   | Color  | iCal Feed Secret Name |
|------------|--------|-----------------------|
| RVshare    | Red    | `ICAL_RVSHARE`        |
| Outdoorsy  | Green  | `ICAL_OUTDOORSY`      |
| Airbnb     | Orange | `ICAL_AIRBNB`         |

---

### File Structure

```
RV_iCAL_Syncs/
├── calendar_dashboard.js      Local web dashboard server (port 3031) — calendar + nav
├── expenses.js                Expense tracker module (bookings, expenses, electricity, reports)
├── db.js                      SQLite database setup (better-sqlite3)
├── Start Dashboard.bat        Double-click launcher for the local dashboard
├── run_silent.vbs             Silent launcher (no console window) used by Task Scheduler
├── generate_ical.js           GitHub Actions script — merges 3 feeds into merged.ics
├── merged.ics                 Auto-generated merged calendar (committed by GitHub Actions)
├── index.html                 GitHub Pages landing page showing the merged feed URL
├── package.json               Node.js dependencies (better-sqlite3, multer, pdf-parse)
├── OVERVIEW.md                This file
├── CHANGELOG.md               History of all changes
├── data/                      SQLite DB — NOT committed (contains financial data)
│   └── hopeland.db
├── uploads/                   Uploaded files — NOT committed (personal/financial data)
│   ├── receipts/              PDF expense receipts
│   └── electricity/           Electricity screenshot images
└── .github/
    └── workflows/
        └── sync.yml           GitHub Actions workflow — runs every 30 minutes
```

---

### How to run the local dashboard

1. Double-click `Start Dashboard.bat`
2. Browser opens automatically at `http://localhost:3031/`
3. Dashboard auto-refreshes every 5 minutes
4. Press `Ctrl+C` in the terminal window to stop

**Requires:** Node.js installed on the computer

---

### GitHub setup (one-time)

This gives you a public URL that the three platforms can import.

**Step 1 — Create a GitHub repository**
- Go to github.com/micahpie-design → "+" → "New repository"
- Name: `hopeland-calendar`
- Visibility: **Public** (required for free GitHub Pages)
- Do NOT add README, .gitignore, or license
- Click "Create repository"

**Step 2 — Push these files to GitHub**
Open a terminal in this folder and run:
```
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/micahpie-design/hopeland-calendar.git
git push -u origin main
```

**Step 3 — Add the three iCal URLs as GitHub Secrets**
- Go to: github.com/micahpie-design/hopeland-calendar → Settings → Secrets and variables → Actions
- Click "New repository secret" and add these three:
  - Name: `ICAL_RVSHARE`     Value: *(your RVshare iCal URL)*
  - Name: `ICAL_OUTDOORSY`   Value: *(your Outdoorsy iCal URL)*
  - Name: `ICAL_AIRBNB`      Value: *(your Airbnb iCal URL)*

**Step 4 — Enable GitHub Pages**
- Go to: Settings → Pages
- Source: "Deploy from a branch"
- Branch: `main`, Folder: `/ (root)`
- Click Save

**Step 5 — Trigger the first sync**
- Go to: Actions → "Sync Calendar Feeds" → "Run workflow" → "Run workflow"
- Wait about 60 seconds for it to finish

**Step 6 — Get your public merged feed URL**
```
https://micahpie-design.github.io/hopeland-calendar/merged.ics
```

---

### Live sync configuration (as deployed)

| Platform  | Imports                                      | Notes |
|-----------|----------------------------------------------|-------|
| Airbnb    | `merged.ics` (GitHub Pages)                  | Blocks dates from all 3 platforms |
| RVshare   | `merged.ics` (GitHub Pages)                  | Blocks dates from all 3 platforms |
| Outdoorsy | Airbnb iCal + RVshare iCal (direct)          | Outdoorsy does not support iCal import of external URLs the same way; pointed directly at the other two platform feeds as a workaround |

**Coverage is complete** — every booking on any platform eventually blocks the other two:
- Airbnb booking → merged.ics → RVshare blocks it; Outdoorsy reads Airbnb directly → blocks it
- RVshare booking → merged.ics → Airbnb blocks it; Outdoorsy reads RVshare directly → blocks it
- Outdoorsy booking → merged.ics → Airbnb blocks it; merged.ics → RVshare blocks it

---

### Updating iCal feed URLs

If a platform regenerates your iCal URL:
1. Go to github.com/micahpie-design/hopeland-calendar → Settings → Secrets and variables → Actions
2. Click the secret name → "Update" → paste the new URL
3. The next scheduled run will use the new URL automatically

For the **local dashboard**, update the URL directly in `calendar_dashboard.js` (lines 9–19).

---

### Expense tracker tabs

The local dashboard includes five tabs accessible from the nav bar:

| Tab | URL | Purpose |
|-----|-----|---------|
| Calendar | `/` | iCal feed viewer with conflict detection |
| Bookings | `/bookings` | Permanent booking records (survive iCal expiry) |
| Expenses | `/expenses` | Per-booking expense tracking with PDF auto-parse |
| Electricity | `/electricity` | kWh readings with drag-and-drop screenshot upload |
| Reports | `/reports` | Summary stats, folder shortcuts, CSV export for taxes |

**Bookings tab**
- Import bookings directly from Airbnb CSV export (completed payouts + pending reservations formats both supported). Deduplicates on confirmation code — re-importing the same CSV is safe and updates payout amounts if they've been released since last import.
- Add, edit, and delete booking records manually.
- Five stat cards: Total Bookings, Total Payout, Rental Expenses, Net Profit, and **Potential YTD Gross Profit** — sums gross revenue for all bookings in the current calendar year (including future ones), giving a full-year earnings forecast at a glance.

**Expenses tab**
- Drag-and-drop PDF receipt upload with auto-parsing for **Amazon** and **Walmart** order formats.
- Each parsed line item gets: rental/personal checkbox, and a per-item category (Supplies / Consumables, Equipment / Capital, Cleaning, Maintenance, Other). Only rental-flagged items count toward tax-deductible expenses.
- Expandable rows in the list show item detail with Rental/Personal and category badges.
- Manual add fallback for receipts that don't parse automatically.
- Edit any expense or its line items after saving.

**Electricity tab**
- Drag-and-drop or click-to-select screenshot upload (Power Watchdog or similar surge suppressor display).
- Enter kWh used per stay. Cost is auto-calculated using ANEC Schedule A-1 seasonal rates: summer $0.12725/kWh (Jun–Sep), winter $0.10725/kWh (Oct–May). Rates are configurable in the Settings section.
- Assign reading to a booking, or leave blank for between-stay maintenance usage.
- Edit readings after saving (screenshot is immutable once uploaded; other fields are editable).

**Reports tab**
- Six summary stat cards: Total Payout, Rental Expenses, Net Profit, Total kWh, General Expenses, Bookings.
- Per-booking breakdown table with payout, rental expenses, kWh, and net per stay.
- **"View Receipt PDFs"** and **"View Electricity Screenshots"** buttons open Windows Explorer directly to the uploads folders.
- **Export CSV for Taxes** downloads a multi-section file (bookings, itemized rental expenses, electricity readings, summary row) suitable for Schedule E filing.

---

### Tech stack

- **Node.js** (stdlib http/https + npm packages below)
- **better-sqlite3** — SQLite database for expense tracker data
- **multer** — multipart file upload handling (disk storage for receipts/electricity, memory storage for CSV import)
- **pdf-parse v1.1.1** — PDF text extraction for receipt parsing (pinned — newer versions changed the export API)
- **FullCalendar v6** (loaded from CDN in the browser)
- **GitHub Actions** (free for public repos, unlimited minutes)
- **GitHub Pages** (free static file hosting)

### Data storage & backup

| Data | Location | Backed up? |
|------|----------|-----------|
| Code | `d:\Dropbox\...\RV_iCAL_Syncs\` + GitHub | Dropbox + GitHub history |
| Database (`hopeland.db`) | `data/` — NOT in git | Dropbox auto-sync + version history |
| PDF receipts | `uploads/receipts/` — NOT in git | Dropbox auto-sync |
| Electricity screenshots | `uploads/electricity/` — NOT in git | Dropbox auto-sync |

`data/` and `uploads/` are intentionally excluded from git because the repo is public. Dropbox handles backup automatically since the whole project lives inside the Dropbox folder. For accounting safety, export the CSV from Reports at the end of each month.
