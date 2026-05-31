// Hopeland — Between the Stars & Shore
// RV Rental Calendar Sync Dashboard
// Run:  node calendar_dashboard.js
// Open: http://localhost:3031/

const http     = require('http');
const https    = require('https');
const expenses = require('./expenses');

const PORT = 3031;
const GH_OWNER = 'micahpie-design';
const GH_REPO  = 'hopeland-calendar';

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

// ─── HTTP fetch ───────────────────────────────────────────────────────────────

function fetchUrl(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false,
      headers: { 'User-Agent': 'Hopeland-Calendar-Sync/1.0', ...extraHeaders },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── iCal parse ───────────────────────────────────────────────────────────────

function unfold(text) { return text.replace(/\r?\n[ \t]/g, ''); }

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

// ─── Calendar payload ─────────────────────────────────────────────────────────

async function buildPayload() {
  const fcEvents  = [];
  const bookings  = [];
  const errors    = [];
  const stats     = {};
  const fetchedAt = new Date().toISOString();

  await Promise.all(Object.entries(FEEDS).map(async ([key, feed]) => {
    const t0 = Date.now();
    let parsed = [], status = 'ok', errMsg = null;
    try {
      parsed = parseICal(await fetchUrl(feed.url));
    } catch (err) {
      status = 'error'; errMsg = err.message;
      errors.push(`${feed.label}: ${err.message}`);
    }
    stats[key] = { label: feed.label, color: feed.color, count: parsed.length, fetchMs: Date.now() - t0, status, error: errMsg };

    for (const ev of parsed) {
      const start = toDateStr(ev['DTSTART']);
      const end   = toDateStr(ev['DTEND']) || start;
      if (!start) continue;
      const summary = (ev['SUMMARY'] || '').toLowerCase();
      const label   = ['not available','blocked','unavailable','reserved'].includes(summary)
        ? feed.label : `${feed.label} — Booked`;
      fcEvents.push({ title: label, start, end, backgroundColor: feed.color, borderColor: feed.color, extendedProps: { tooltip: `${feed.label}: ${start} to ${end}` } });
      bookings.push({ platform: feed.label, start, end });
    }
  }));

  const conflicts = findConflicts(bookings);
  for (const c of conflicts) {
    fcEvents.push({ title: `CONFLICT: ${c.platform_a} & ${c.platform_b}`, start: c.start, end: c.end, backgroundColor: 'rgba(142,68,173,0.45)', borderColor: '#8e44ad', extendedProps: { tooltip: `Conflict: ${c.platform_a} & ${c.platform_b}` } });
  }

  return { events: fcEvents, conflicts, errors, stats, fetchedAt };
}

// ─── GitHub Actions run history ───────────────────────────────────────────────

let ghCache = { data: null, ts: 0 };

async function fetchGithubRuns() {
  if (ghCache.data && Date.now() - ghCache.ts < 5 * 60 * 1000) return ghCache.data;
  try {
    const url  = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/runs?per_page=20`;
    const raw  = await fetchUrl(url, { Accept: 'application/vnd.github.v3+json' });
    const json = JSON.parse(raw);
    const runs = (json.workflow_runs || []).map(r => ({
      run_number:  r.run_number,
      conclusion:  r.conclusion,
      status:      r.status,
      started_at:  r.created_at,
      finished_at: r.updated_at,
      duration_s:  Math.round((new Date(r.updated_at) - new Date(r.created_at)) / 1000),
      url:         r.html_url,
    }));
    ghCache = { data: runs, ts: Date.now() };
    return runs;
  } catch (err) {
    console.error('GitHub API error:', err.message);
    return ghCache.data || [];
  }
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

  #conflict-banner { display: none; background: #fff5f5; border-left: 4px solid #e53e3e; color: #c53030; padding: 14px 28px; font-weight: 600; font-size: 0.9rem; }
  #conflict-banner ul { margin-top: 6px; padding-left: 20px; font-weight: 400; font-size: 0.85rem; }

  .legend { display: flex; gap: 20px; padding: 12px 28px; background: white; border-bottom: 1px solid #e2e8f0; flex-wrap: wrap; }
  .leg { display: flex; align-items: center; gap: 7px; font-size: 0.85rem; font-weight: 500; }
  .legdot { width: 12px; height: 12px; border-radius: 3px; }

  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 16px 28px 0; }
  @media (max-width: 860px) { .panels { grid-template-columns: 1fr; } }

  .panel { background: white; border-radius: 8px; padding: 16px; box-shadow: 0 1px 4px rgba(0,0,0,.07); }
  .panel-title { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #a0aec0; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
  .panel-title button { font-size: 0.68rem; background: none; border: 1px solid #e2e8f0; border-radius: 4px; padding: 2px 7px; color: #718096; cursor: pointer; }
  .panel-title button:hover { background: #f7fafc; }

  #feed-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  #feed-table th { text-align: left; font-weight: 600; color: #718096; padding: 4px 8px 8px 0; border-bottom: 1px solid #e2e8f0; font-size: 0.75rem; }
  #feed-table td { padding: 7px 8px 7px 0; border-bottom: 1px solid #f7fafc; vertical-align: middle; }
  #feed-table tr:last-child td { border-bottom: none; }
  .feed-dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 0.72rem; font-weight: 600; }
  .badge-ok    { background: #c6f6d5; color: #276749; }
  .badge-error { background: #fed7d7; color: #9b2c2c; }
  .ms { color: #a0aec0; font-size: 0.75rem; }

  /* Sync log */
  #sync-log { max-height: 220px; overflow-y: auto; font-size: 0.78rem; }
  .log-entry { display: grid; grid-template-columns: 52px 1fr; gap: 8px; padding: 5px 0; border-bottom: 1px solid #f7fafc; align-items: start; }
  .log-entry:last-child { border-bottom: none; }

  .src-badge { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.04em; padding: 2px 5px; border-radius: 4px; text-align: center; white-space: nowrap; }
  .src-local  { background: #ebf8ff; color: #2b6cb0; }
  .src-github { background: #1a202c; color: #e2e8f0; }

  .log-body { color: #4a5568; line-height: 1.5; }
  .log-time { color: #a0aec0; font-size: 0.72rem; display: block; margin-bottom: 1px; font-family: monospace; }
  .log-detail { }
  .ok   { color: #276749; font-weight: 600; }
  .warn { color: #c05621; font-weight: 600; }
  .fail { color: #9b2c2c; font-weight: 600; }
  .log-link { color: #4299e1; text-decoration: none; font-size: 0.72rem; }
  .log-link:hover { text-decoration: underline; }
  .log-empty { color: #cbd5e0; font-style: italic; font-size: 0.8rem; padding: 8px 0; }

  #cal-wrap { padding: 16px 28px 30px; }
  #calendar { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 1px 6px rgba(0,0,0,.08); }
  .fc-event { cursor: default; border: none !important; }
  .fc-event-title { font-size: 0.78rem; font-weight: 600; padding: 1px 3px; }
  .fc-daygrid-event-dot { display: none !important; }

  footer { text-align: center; padding: 14px; font-size: 0.75rem; color: #a0aec0; background: white; border-top: 1px solid #e2e8f0; }
</style>
<style>${expenses.SHARED_CSS}</style>
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

${expenses.navHtml('/')}

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

<div class="panels">
  <div class="panel">
    <div class="panel-title">Feed Status</div>
    <table id="feed-table">
      <thead><tr><th>Platform</th><th>Events</th><th>Fetch</th><th>Status</th></tr></thead>
      <tbody id="feed-tbody"><tr><td colspan="4" style="color:#cbd5e0;font-style:italic;padding:8px 0">Loading&hellip;</td></tr></tbody>
    </table>
  </div>

  <div class="panel">
    <div class="panel-title">
      Sync Log
      <button onclick="clearLocalLog()">Clear local</button>
    </div>
    <div id="sync-log"><div class="log-empty">Loading&hellip;</div></div>
  </div>
</div>

<div id="cal-wrap"><div id="calendar"></div></div>

<footer>
  Local dashboard refreshes every 5 min &nbsp;&middot;&nbsp;
  GitHub sync runs every 30 min &nbsp;&middot;&nbsp;
  <a href="https://github.com/${GH_OWNER}/${GH_REPO}/actions" target="_blank" style="color:#a0aec0">View GitHub Actions &rarr;</a>
</footer>

<script>
let cal;
const LOG_KEY = 'hopeland_sync_log';
const LOG_MAX = 50;

function fmtDate(d)   { return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
function fmtTime(iso) { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }); }

// ── Local log (localStorage) ──────────────────────────────────────────────────
function getLocalLog() { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; } }

function appendLocalLog(entry) {
  const log = getLocalLog();
  log.unshift(entry);
  if (log.length > LOG_MAX) log.length = LOG_MAX;
  localStorage.setItem(LOG_KEY, JSON.stringify(log));
}

function clearLocalLog() { localStorage.removeItem(LOG_KEY); renderLog(window._lastGhRuns || []); }

// ── Render merged log ─────────────────────────────────────────────────────────
function renderLog(ghRuns) {
  const localEntries = getLocalLog().map(e => ({ ...e, _src: 'local',  _time: e.time }));
  const ghEntries    = (ghRuns || []).map(r => ({ ...r,  _src: 'github', _time: r.started_at }));

  const merged = [...localEntries, ...ghEntries]
    .sort((a, b) => new Date(b._time) - new Date(a._time))
    .slice(0, 60);

  const el = document.getElementById('sync-log');
  if (!merged.length) { el.innerHTML = '<div class="log-empty">No activity recorded yet.</div>'; return; }

  el.innerHTML = merged.map(e => {
    if (e._src === 'local') {
      const counts = Object.entries(e.counts || {}).map(([k,v]) => \`\${k}: \${v}\`).join(' &middot; ');
      const state  = e.conflicts > 0
        ? \`<span class="warn">\${e.conflicts} conflict(s)</span>\`
        : \`<span class="ok">&#10003; OK</span>\`;
      const err = e.error ? ' <span class="fail">&bull; feed error</span>' : '';
      return \`<div class="log-entry">
        <span class="src-badge src-local">LOCAL</span>
        <div class="log-body">
          <span class="log-time">\${fmtTime(e.time)}</span>
          <span class="log-detail">\${counts} &middot; \${state}\${err}</span>
        </div>
      </div>\`;
    } else {
      const done = e.status === 'completed';
      const icon = !done ? '<span style="color:#d69e2e">&#9679; running</span>'
        : e.conclusion === 'success' ? '<span class="ok">&#10003; success</span>'
        : \`<span class="fail">&#10007; \${e.conclusion}</span>\`;
      const dur  = done ? \` &middot; \${e.duration_s}s\` : '';
      return \`<div class="log-entry">
        <span class="src-badge src-github">GITHUB</span>
        <div class="log-body">
          <span class="log-time">\${fmtTime(e.started_at)}</span>
          <span class="log-detail">Run #\${e.run_number} &middot; \${icon}\${dur} &middot; <a class="log-link" href="\${e.url}" target="_blank">view &rarr;</a></span>
        </div>
      </div>\`;
    }
  }).join('');
}

// ── Feed status table ─────────────────────────────────────────────────────────
function renderFeedStatus(stats) {
  document.getElementById('feed-tbody').innerHTML = Object.entries(stats).map(([, s]) => \`
    <tr>
      <td><span class="feed-dot" style="background:\${s.color}"></span>\${s.label}</td>
      <td><strong>\${s.count}</strong></td>
      <td class="ms">\${s.fetchMs}ms</td>
      <td><span class="badge badge-\${s.status}">\${s.status === 'ok' ? 'OK' : 'Error'}</span></td>
    </tr>
  \`).join('');
}

// ── Main load ─────────────────────────────────────────────────────────────────
async function load() {
  const dot    = document.getElementById('dot');
  const status = document.getElementById('status');
  const banner = document.getElementById('conflict-banner');
  const list   = document.getElementById('conflict-list');

  try {
    const [calData, ghRuns] = await Promise.all([
      fetch('/api/events').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      fetch('/api/github-runs').then(r => r.json()).catch(() => []),
    ]);

    window._lastGhRuns = ghRuns;

    cal.removeAllEvents();
    cal.addEventSource(calData.events);

    if (calData.stats) renderFeedStatus(calData.stats);

    const counts = {};
    if (calData.stats) { for (const [, s] of Object.entries(calData.stats)) counts[s.label] = s.count; }
    appendLocalLog({ time: calData.fetchedAt || new Date().toISOString(), counts, conflicts: calData.conflicts ? calData.conflicts.length : 0, error: calData.errors && calData.errors.length > 0 });

    renderLog(ghRuns);

    if (calData.conflicts && calData.conflicts.length > 0) {
      banner.style.display = 'block';
      list.innerHTML = calData.conflicts.map(c => \`<li>\${c.platform_a} &amp; \${c.platform_b}: \${fmtDate(c.start)} &ndash; \${fmtDate(c.end)}</li>\`).join('');
      dot.className = 'err';
      status.textContent = \`\${calData.conflicts.length} conflict(s) detected — \${new Date().toLocaleTimeString()}\`;
    } else {
      banner.style.display = 'none';
      dot.className = '';
      status.textContent = \`All clear — updated \${new Date().toLocaleTimeString()}\`;
    }
  } catch (e) {
    dot.className = 'err';
    status.textContent = 'Error loading feeds — retrying in 5 min';
    console.error(e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderLog([]);

  cal = new FullCalendar.Calendar(document.getElementById('calendar'), {
    initialView: 'dayGridMonth',
    headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,dayGridWeek' },
    height: 'auto', eventDisplay: 'block', displayEventTime: false,
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

const EXPENSE_PAGES = ['/bookings', '/expenses', '/electricity', '/reports', '/export', '/uploads'];
const EXPENSE_APIS  = ['/api/bookings', '/api/expenses', '/api/electricity', '/api/parse-pdf', '/api/import-csv'];

const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];

  if (
    EXPENSE_PAGES.some(p => path === p || path.startsWith(p + '/')) ||
    EXPENSE_APIS.some(p  => path === p || path.startsWith(p + '/'))
  ) {
    return expenses(req, res);
  }

  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }

  if (path === '/api/events') {
    try {
      const body = JSON.stringify(await buildPayload());
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (path === '/api/github-runs') {
    try {
      const body = JSON.stringify(await fetchGithubRuns());
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
