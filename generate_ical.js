// generate_ical.js
// Run by GitHub Actions every 30 min.
// Reads iCal feed URLs from environment variables, merges them, writes merged.ics.

const https = require('https');
const fs    = require('fs');

const FEEDS = [
  { env: 'ICAL_RVSHARE',   label: 'RVshare'   },
  { env: 'ICAL_OUTDOORSY', label: 'Outdoorsy' },
  { env: 'ICAL_AIRBNB',    label: 'Airbnb'    },
];

// ─── Fetch ────────────────────────────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Parse ───────────────────────────────────────────────────────────────────

function unfold(text) {
  return text.replace(/\r?\n[ \t]/g, '');
}

function parseICal(text) {
  const events = [];
  let current  = null;
  for (const raw of unfold(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') {
      current = {};
    } else if (line === 'END:VEVENT' && current) {
      events.push(current);
      current = null;
    } else if (current && line.includes(':')) {
      const colon = line.indexOf(':');
      const key   = line.slice(0, colon).split(';')[0].toUpperCase();
      current[key] = line.slice(colon + 1).trim();
    }
  }
  return events;
}

function toICalDate(val) {
  // Returns compact YYYYMMDD string for VALUE=DATE iCal lines
  if (!val) return null;
  const v = val.replace('Z', '');
  if (v.length === 8)    return v;                        // already YYYYMMDD
  if (v.includes('T'))   return v.slice(0, 8);            // strip time
  return v.replace(/-/g, '').slice(0, 8);                 // ISO → compact
}

// ─── Build merged iCal ───────────────────────────────────────────────────────

function buildICal(events) {
  const now = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hopeland Calendar Sync//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Hopeland - Not Available',
    `X-WR-CALDESC:Auto-generated merged availability for Hopeland RV rental`,
  ];

  for (const ev of events) {
    const start = toICalDate(ev['DTSTART']);
    const end   = toICalDate(ev['DTEND']) || start;
    if (!start) continue;

    const uid = ev['UID']
      ? `${ev._platform.toLowerCase()}-${ev['UID']}@hopeland`
      : `${ev._platform.toLowerCase()}-${start}-${end}@hopeland`;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTART;VALUE=DATE:${start}`);
    lines.push(`DTEND;VALUE=DATE:${end}`);
    lines.push('SUMMARY:Not Available');
    lines.push(`DESCRIPTION:Booked via ${ev._platform}`);
    lines.push(`DTSTAMP:${now}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const allEvents = [];

  for (const feed of FEEDS) {
    const url = process.env[feed.env];
    if (!url) {
      console.warn(`Skipping ${feed.label}: env var ${feed.env} not set`);
      continue;
    }
    try {
      const raw    = await fetchUrl(url);
      const events = parseICal(raw);
      for (const ev of events) allEvents.push({ ...ev, _platform: feed.label });
      console.log(`${feed.label}: ${events.length} events`);
    } catch (err) {
      console.error(`${feed.label} error: ${err.message}`);
    }
  }

  const ical = buildICal(allEvents);
  fs.writeFileSync('merged.ics', ical, 'utf8');
  console.log(`Done — merged.ics written (${allEvents.length} total events)`);
}

main().catch(err => { console.error(err); process.exit(1); });
