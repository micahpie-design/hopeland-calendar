# Changelog

All changes to this project are documented here.

---

## [2026-06-09] — Receipt attachment on manual expense entry

### Added
- `expenses.js` — Manual Add Expense modal now includes a drag-and-drop / click-to-select file zone for attaching a receipt (PDF or photo: jpg, jpeg, png, webp). File is uploaded to `uploads/receipts/` via the existing `/api/parse-pdf` endpoint (parse result is ignored; only the saved filename is used). The attached receipt shows as a "📄 View" link in the expense list, same as auto-parsed receipts. Added `.webp` to the static file server MIME map so phone photos open correctly.

---

## [2026-06-05] — Fix Walmart PDF detection and single-line format

### Fixed
- `expenses.js` — Walmart vendor detection now also triggers on `Order#` (no space), which is the identifier used in newer Walmart invoice PDFs that don't contain the string "walmart.com" in their text. Previously these fell through to "Unknown" and showed no line items.
- `expenses.js` — Walmart parser now handles two item-line formats: (1) original two-line format `DescriptionQty N` / `$price` on next line, and (2) single-line format `DescriptionQty N$price` all on one line. Some Walmart invoices (e.g. Walmart_8, Walmart_9) use the single-line format. Both formats now parse correctly.

---

## [2026-06-01] — Potential YTD Gross Profit tile on Bookings page

### Added
- `expenses.js` — New stat card on the Bookings page showing Potential YTD Gross Profit for the current calendar year. Filters bookings by `check_in` year and sums `gross_revenue` (the platform's listed gross before fees). "Potential" because it includes upcoming bookings not yet completed. Tile has a blue left border to distinguish it from the all-time totals.

---

## [2026-05-31] — Folder shortcuts on Reports page; temp file cleanup

### Added
- `expenses.js` — "View Receipt PDFs" and "View Electricity Screenshots" buttons on Reports page header. Clicking either opens Windows Explorer directly to `uploads/receipts/` or `uploads/electricity/`. Server-side `POST /api/open-folder/:name` route uses `child_process.exec('explorer.exe ...')`. Route registered in `calendar_dashboard.js` EXPENSE_APIS list.

### Fixed
- Deleted 23 VS Code editor temp files (`*.tmp.*`) from project root. Already excluded from git via `.gitignore` but cluttered the working directory.

---

## [2026-05-31] — Per-item category in expenses

### Changed
- `db.js` — added `category TEXT DEFAULT 'supplies'` column to `expense_items` via `ALTER TABLE` migration (safe to run on existing DB).
- `expenses.js` — category is now tracked per line item, not just per expense header. Both the upload flow and the edit modal show a category dropdown for each item (`Supplies / Consumables`, `Equipment / Capital`, `Cleaning`, `Maintenance`, `Other`). Edit modal items now show the previously-saved category pre-selected. Expense list sub-rows show a grey category badge alongside the Rental/Personal badge. Server-side INSERT and PUT handlers updated to save and restore `category` per item.

---

## [2026-05-31] — Fix Walmart PDF parser

### Changed
- `expenses.js` — rewrote `parseWalmart()` to match actual Walmart invoice PDF format: item lines are `Description textQty N` (no space before Qty) with the price `$X.XX` on the following line; Subtotal/Total are `Subtotal$X.XX` with no space; Tax appears as a standalone label with amount on the next line. Previous parser expected a single-line `Description Qty N $price` format that Walmart does not produce. Verified against 7 real Walmart order PDFs.

---

## [2026-05-31] — Add Airbnb CSV import to bookings

### Changed
- `expenses.js` — added `importAirbnbCSV()` parser (handles both the completed-payouts and pending-reservations CSV formats Airbnb exports). Filters `Type=Reservation` rows, maps guest name, dates, nights, gross earnings, cleaning fee, service fee, and calculates payout as `gross - service_fee - fast_pay_fee`. Deduplicates on `Confirmation code` — re-importing the same CSV skips existing records silently. Added `POST /api/import-csv` route (multer memory storage — CSV is parsed and discarded, not saved to disk). Added "Import Airbnb CSV" button to Bookings page header.
- `db.js` — added `CREATE UNIQUE INDEX IF NOT EXISTS` on `bookings.confirmation` to enable `INSERT OR IGNORE` deduplication.
- `calendar_dashboard.js` — added `/api/import-csv` to expense route delegation list.

---

## [2026-05-31] — Add expense tracker (bookings, expenses, electricity, reports)

### Added
- `db.js` — SQLite database (via better-sqlite3) with four tables: `bookings`, `expenses`, `expense_items`, `electricity`. Stored in `data/hopeland.db` (excluded from git).
- `expenses.js` — Full expense tracker module. Exports `handleRequest`, `navHtml`, and `SHARED_CSS`. Handles all expense-tracker routes and renders server-side HTML pages.
  - **Bookings tab** (`/bookings`): Add and delete booking records (guest name, platform, dates, payout). Stats grid shows totals. Each row links to per-booking expense and kWh totals. Add Booking modal auto-calculates nights.
  - **Expenses tab** (`/expenses`): Drag-and-drop PDF receipt upload with auto-parse for Amazon and Walmart order formats. Parsed items shown with per-item rental/personal checkbox and category selector. Manual add fallback for other vendors. Expandable rows show item detail with rental/personal badges.
  - **Electricity tab** (`/electricity`): Upload screenshot + manual kWh entry. Assign reading to a booking. Image preview in modal.
  - **Reports tab** (`/reports`): Six summary stat cards (total payout, rental expenses, electricity cost, net profit, bookings, nights). Per-booking breakdown table. CSV export downloads multi-section file (bookings, rental-only expense items, electricity readings, summary row).
  - PDF parsers: Walmart (`Item Qty N $price` format) and Amazon (standalone qty → multi-line description → Sold by → price) with Grand Total / Item Subtotal / Estimated tax extraction.
- `uploads/receipts/` and `uploads/electricity/` — Created at startup for file storage (excluded from git).

### Changed
- `calendar_dashboard.js` — Added `require('./expenses')` module. Calendar page now includes shared nav bar (Calendar · Bookings · Expenses · Electricity · Reports). HTTP handler delegates all expense/upload routes to the expenses module before handling calendar routes.
- `package.json` — Added dependencies: `better-sqlite3`, `multer`, `pdf-parse`.

---

## [2026-05-23] — Add GitHub Actions run history to sync log

### Changed
- `calendar_dashboard.js` — added `/api/github-runs` endpoint that pulls the last 20 workflow runs from the GitHub API (cached server-side for 5 min to respect rate limits). Sync Log now merges local fetch history and GitHub workflow runs into one chronological timeline. LOCAL entries (blue badge) show per-platform event counts; GITHUB entries (dark badge) show run number, conclusion, duration, and a direct link to the run on GitHub.

---

## [2026-05-23] — Document actual live sync configuration

### Changed
- `OVERVIEW.md` — updated sync configuration table to reflect actual deployment: Airbnb and RVshare import merged.ics from GitHub Pages; Outdoorsy (which does not support external iCal import) is pointed directly at Airbnb and RVshare iCal feeds. Full cross-platform coverage confirmed.

---

## [2026-05-23] — Add Windows startup task

### Added
- `run_silent.vbs` — VBScript launcher that starts `calendar_dashboard.js` silently (no console window) via `wscript.exe`
- Windows Task Scheduler task "Hopeland Calendar Sync" registered to run at login for current user; restarts up to 3 times if it crashes (2-min interval)

---

## [2026-05-23] — Add feed status panel and sync log to dashboard

### Changed
- `calendar_dashboard.js` — added Feed Status panel (per-platform event count, fetch time in ms, ok/error badge) and persistent Sync Log (last 50 entries stored in browser localStorage, survives page reload). API response now includes `stats` object with per-feed timing and `fetchedAt` timestamp.

---

## [2026-05-23] — Fix Node.js version in workflow

### Changed
- `sync.yml` — updated Node.js from 20 to 24 to clear GitHub Actions deprecation warning (Node.js 20 removed from runners Sept 16, 2026)

---

## [2026-05-23] — Initial build

### Added
- `calendar_dashboard.js` — Local Node.js web server (port 3031). Fetches all three iCal feeds, serves a FullCalendar dashboard with color-coded bookings, detects date conflicts, auto-refreshes every 5 minutes.
- `Start Dashboard.bat` — Windows double-click launcher; starts the Node.js server and opens the browser automatically.
- `generate_ical.js` — GitHub Actions script. Reads iCal feed URLs from environment variables (`ICAL_RVSHARE`, `ICAL_OUTDOORSY`, `ICAL_AIRBNB`), fetches and merges all three feeds, writes `merged.ics`.
- `.github/workflows/sync.yml` — GitHub Actions workflow that runs `generate_ical.js` every 30 minutes and commits the updated `merged.ics` back to the repo.
- `merged.ics` — Auto-generated merged iCal file served publicly via GitHub Pages. Imported by each platform to keep availability in sync.
- `index.html` — GitHub Pages landing page that displays the public `merged.ics` URL.
- `OVERVIEW.md` — Full project documentation, file structure, setup instructions, and maintenance guide.
- `CHANGELOG.md` — This file.

### Platforms connected
- RVshare
- Outdoorsy
- Airbnb

### Tested
- Local dashboard: all 3 feeds fetch successfully, HTML served at `/`, API at `/api/events`
- `generate_ical.js`: 3 Airbnb events written to `merged.ics`; RVshare and Outdoorsy returned 0 events (no current bookings)
