# Changelog

All changes to this project are documented here.

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
