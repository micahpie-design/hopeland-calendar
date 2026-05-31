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
| Electricity | `/electricity` | kWh readings with screenshot upload |
| Reports | `/reports` | Summary stats + CSV export for taxes |

**PDF auto-parsing** supports Amazon and Walmart order receipts. After upload, each line item gets a rental/personal checkbox — only rental-flagged items count toward tax-deductible expenses.

---

### Tech stack

- **Node.js** (stdlib http/https + npm packages below)
- **better-sqlite3** — SQLite database for expense tracker data
- **multer** — multipart file upload handling
- **pdf-parse** — PDF text extraction for receipt parsing
- **FullCalendar v6** (loaded from CDN in the browser)
- **GitHub Actions** (free for public repos, unlimited minutes)
- **GitHub Pages** (free static file hosting)
