// Hopeland — Between the Stars & Shore
// RV Rental Calendar Sync Dashboard
// Run:  node calendar_dashboard.js
// Open: http://localhost:3031/

const http  = require('http');
const https = require('https');

const PORT = 3031;

const FEEDS = {
  rvshare: {
    url:   'https://api.rvshare.com/v1/ical/MWYa9PO0QyOJ60R37j5E1g6D',
    color: '#e74c3c',
    label: 'RVshare',
  },
  outdoorsy: {
    url:   'https://api.outdoorsy.com/v0/ics-export.ics?rental_id=526772&t=0e92f503-aeaa-40dc-96e8-068c4f7e322b',
    color: '#27ae60',
    label: 'Outdoorsy',
  },
  airbnb: {
    url:   'https://www.airbnb.com/calendar/ical/1687888260712526347.ics?t=c0074c26da424ea4ac47d3111a832d75',
    color: '#e67e22',
    label: 'Airbnb',
  },
};

// ─── iCal fetch & parse ───────────────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      // Follow one redirect (Airbnb does this)
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

function unfold(text) {
  // iCal line-folding: continuation lines start with a space or tab
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

function toDateStr(val) {
  if (!val) return null;
  const v = val.replace('Z', '');
  if (v.length === 8) return `${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`;
  if (v.includes('T')) { const d = v.slice(0,8); return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`; }
  return val;
}

// ─── Conflict detection ───────────────────────────────────────────────────────

function overlaps(s1, e1, s2, e2) {
  return new Date(s1) < new Date(e2) && new Date(s2) < new Date(e1);
}

function findConflicts(bookings) {
  const conflicts = [];
  for (let i = 0; i < bookings.length; i++) {
    for (let j = i + 1; j < bookings.length; j++) {
      const a = bookings[i], b = bookings[j];
      if (a.platform === b.platform) continue;
      if (overlaps(a.start, a.end, b.start, b.end)) {
        conflicts.push({
          platform_a: a.platform,
          platform_b: b.platform,
          start: a.start > b.start ? b.start : a.start,
          end:   a.end   < b.end   ? a.end   : b.end,
        });
      }
    }
  }
  return conflicts;
}

// ─── Build payload ────────────────────────────────────────────────────────────

async function buildPayload() {
  const fcEvents  = [];
  const bookings  = [];
  const errors    = [];

  await Promise.all(Object.entries(FEEDS).map(async ([key, feed]) => {
    let parsed = [];
    try {
      const raw = await fetchUrl(feed.url);
      parsed = parseICal(raw);
    } catch (err) {
      errors.push(`${feed.label}: ${err.message}`);
    }

    for (const ev of parsed) {
      const start = toDateStr(ev['DTSTART']);
      let   end   = toDateStr(ev['DTEND']) || start;
      if (!start) continue;

      const summary = (ev['SUMMARY'] || '').toLowerCase();
      const label   = ['not available','blocked','unavailable','reserved'].includes(summary)
        ? feed.label
        : `${feed.label} — Booked`;

      fcEvents.push({
        title:           label,
        start,
        end,
        backgroundColor: feed.color,
        borderColor:     feed.color,
        extendedProps:   { tooltip: `${feed.label}: ${start} to ${end}` },
      });

      bookings.push({ platform: feed.label, start, end });
    }
  }));

  const conflicts = findConflicts(bookings);

  for (const c of conflicts) {
    fcEvents.push({
      title:           `CONFLICT: ${c.platform_a} & ${c.platform_b}`,
      start:           c.start,
      end:             c.end,
      backgroundColor: 'rgba(142,68,173,0.45)',
      borderColor:     '#8e44ad',
      extendedProps:   { tooltip: `Conflict: ${c.platform_a} & ${c.platform_b}` },
    });
  }

  return { events: fcEvents, conflicts, errors };
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hopeland Calendar Sync</title>
<link href="https://cdn.jsdelivr.net/npm/fullcalendar@6.1.11/index.global.min.css" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/fullcalendar@6.1.11/index.global.min.js"><\/script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f0f4f8; color: #2d3748; }

  header {
    background: linear-gradient(135deg, #1a202c 0%, #2d3748 100%);
    color: white; padding: 20px 28px;
    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;
  }
  header h1 { font-size: 1.4rem; font-weight: 700; }
  header p  { font-size: 0.78rem; opacity: 0.65; margin-top: 3px; }

  #status-bar { display: flex; align-items: center; gap: 8px; font-size: 0.78rem; opacity: 0.85; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #48bb78; flex-shrink: 0; }
  #dot.err { background: #fc8181; }

  #conflict-banner {
    display: none;
    background: #fff5f5; border-left: 4px solid #e53e3e;
    color: #c53030; padding: 14px 28px; font-weight: 600; font-size: 0.9rem;
  }
  #conflict-banner ul { margin-top: 6px; padding-left: 20px; font-weight: 400; font-size: 0.85rem; }

  .legend { display: flex; gap: 20px; padding: 12px 28px; background: white; border-bottom: 1px solid #e2e8f0; flex-wrap: wrap; }
  .leg { display: flex; align-items: center; gap: 7px; font-size: 0.85rem; font-weight: 500; }
  .legdot { width: 12px; height: 12px; border-radius: 3px; }

  #cal-wrap { padding: 20px 28px 30px; }
  #calendar { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 1px 6px rgba(0,0,0,.08); }

  .fc-event { cursor: default; border: none !important; }
  .fc-event-title { font-size: 0.78rem; font-weight: 600; padding: 1px 3px; }
  .fc-daygrid-event-dot { display: none !important; }

  footer { text-align: center; padding: 14px; font-size: 0.75rem; color: #a0aec0; background: white; border-top: 1px solid #e2e8f0; }
</style>
</head>
<body>

<header>
  <div>
    <h1>Hopeland &mdash; Between the Stars &amp; Shore</h1>
    <p>RV Rental Calendar Sync Dashboard</p>
  </div>
  <div id="status-bar">
    <div id="dot"></div>
    <span id="status">Loading&hellip;</span>
  </div>
</header>

<div id="conflict-banner">
  <strong>&#9888; Booking Conflicts Detected</strong>
  <ul id="conflict-list"></ul>
</div>

<div class="legend">
  <div class="leg"><div class="legdot" style="background:#e74c3c"></div> RVshare</div>
  <div class="leg"><div class="legdot" style="background:#27ae60"></div> Outdoorsy</div>
  <div class="leg"><div class="legdot" style="background:#e67e22"></div> Airbnb</div>
  <div class="leg"><div class="legdot" style="background:#8e44ad;opacity:.55"></div> Conflict</div>
</div>

<div id="cal-wrap"><div id="calendar"></div></div>

<footer>Auto-refreshes every 5 minutes &nbsp;&middot;&nbsp; Hopeland Calendar Sync</footer>

<script>
let cal;

function fmtDate(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function load() {
  const dot    = document.getElementById('dot');
  const status = document.getElementById('status');
  const banner = document.getElementById('conflict-banner');
  const list   = document.getElementById('conflict-list');
  try {
    const r    = await fetch('/api/events');
    if (!r.ok) throw new Error('Server error ' + r.status);
    const data = await r.json();

    cal.removeAllEvents();
    cal.addEventSource(data.events);

    if (data.conflicts && data.conflicts.length > 0) {
      banner.style.display = 'block';
      list.innerHTML = data.conflicts.map(c =>
        \`<li>\${c.platform_a} &amp; \${c.platform_b}: \${fmtDate(c.start)} &ndash; \${fmtDate(c.end)}</li>\`
      ).join('');
      dot.className = 'err';
      status.textContent = \`\${data.conflicts.length} conflict(s) detected — \${new Date().toLocaleTimeString()}\`;
    } else {
      banner.style.display = 'none';
      dot.className = '';
      status.textContent = \`All clear — updated \${new Date().toLocaleTimeString()}\`;
    }

    if (data.errors && data.errors.length) console.warn('Feed errors:', data.errors);
  } catch (e) {
    dot.className = 'err';
    status.textContent = 'Error loading feeds — retrying in 5 min';
    console.error(e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  cal = new FullCalendar.Calendar(document.getElementById('calendar'), {
    initialView: 'dayGridMonth',
    headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,dayGridWeek' },
    height: 'auto',
    eventDisplay: 'block',
    displayEventTime: false,
    eventDidMount(info) { info.el.title = info.event.extendedProps.tooltip || ''; },
  });
  cal.render();
  load();
  setInterval(load, 5 * 60 * 1000);
});
<\/script>
</body>
</html>`;

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];

  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }

  if (path === '/api/events') {
    try {
      const payload = await buildPayload();
      const body    = JSON.stringify(payload);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, 'localhost', () => {
  console.log('\n  Hopeland Calendar Sync Dashboard');
  console.log(`  Open: http://localhost:${PORT}/`);
  console.log('\n  Press Ctrl+C to stop.\n');
});
