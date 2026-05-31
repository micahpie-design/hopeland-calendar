// expenses.js — Hopeland expense tracker: bookings, expenses, electricity, reports
'use strict';

const fs       = require('fs');
const path     = require('path');
const multer   = require('multer');
const pdfParse = require('pdf-parse');
const db       = require('./db');

// ─── Upload storage ───────────────────────────────────────────────────────────

const UPLOAD_DIR = path.join(__dirname, 'uploads');
['receipts', 'electricity'].forEach(d => {
  const p = path.join(UPLOAD_DIR, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

function makeStorage(subdir) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_DIR, subdir)),
    filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`),
  });
}
const receiptUpload     = multer({ storage: makeStorage('receipts'),     limits: { fileSize: 15 * 1024 * 1024 } });
const electricityUpload = multer({ storage: makeStorage('electricity'),  limits: { fileSize: 15 * 1024 * 1024 } });
const csvUpload         = multer({ storage: multer.memoryStorage(),      limits: { fileSize: 5  * 1024 * 1024 } });

function runMw(req, res, mw) {
  return new Promise((resolve, reject) => mw(req, res, err => err ? reject(err) : resolve()));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function getSetting(key, def = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : def;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function fmt$(n) { return n == null ? '—' : '$' + Number(n).toFixed(2); }
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function isoToday() { return new Date().toISOString().slice(0, 10); }

// ─── PDF parsers ──────────────────────────────────────────────────────────────

function parseWalmart(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const result = { vendor: 'Walmart', orderNumber: '', date: '', items: [], subtotal: 0, tax: 0, total: 0 };
  for (const line of lines) {
    const dm = line.match(/^([A-Z][a-z]+ \d+, \d{4}) order/);
    if (dm) result.date = dm[1];
    const om = line.match(/Order#\s*(\S+)/);
    if (om && !result.orderNumber) result.orderNumber = om[1];
    const im = line.match(/^(.+?)\s+Qty\s+(\d+)\s+\$([0-9.]+)$/);
    if (im) {
      const qty = parseInt(im[2]), price = parseFloat(im[3]);
      result.items.push({ description: im[1].trim(), quantity: qty, unit_price: price, total: +(price * qty).toFixed(2), is_rental: 1 });
    }
    if (/^Subtotal\s+\$/.test(line)) result.subtotal = parseFloat(line.match(/\$([0-9.]+)/)[1]);
    if (/^Tax\s+\$/.test(line))      result.tax      = parseFloat(line.match(/\$([0-9.]+)/)[1]);
    if (/^Total\s+\$/.test(line))    result.total    = parseFloat(line.match(/\$([0-9.]+)/)[1]);
  }
  return result;
}

function parseAmazon(text) {
  const result = { vendor: 'Amazon', orderNumber: '', date: '', items: [], subtotal: 0, tax: 0, total: 0 };
  const om = text.match(/Order\s*#\s*([\d-]+)/);           if (om) result.orderNumber = om[1];
  const dm = text.match(/Order placed\s+([A-Z][a-z]+ \d+, \d{4})/); if (dm) result.date = dm[1];
  const tm = text.match(/Grand Total:\s*\$([0-9.]+)/);     if (tm) result.total    = parseFloat(tm[1]);
  const sm = text.match(/Item\(s\) Subtotal:\s*\$([0-9.]+)/); if (sm) result.subtotal = parseFloat(sm[1]);
  const xm = text.match(/Estimated tax[^$\n]*\n?\s*collected:\s*\n?\s*\$([0-9.]+)/s);
  if (xm) result.tax = parseFloat(xm[1]);

  // Items appear after "Arriving" headings: standalone number → description → "Sold by:" → "$price"
  const sections = text.split(/Arriving[^\n]*\n/);
  for (let s = 1; s < sections.length; s++) {
    const slines = sections[s].split('\n').map(l => l.trim()).filter(l => l && l !== 'Back to top');
    let i = 0;
    while (i < slines.length) {
      if (/^\d+$/.test(slines[i])) {
        const qty = parseInt(slines[i++]);
        const desc = [];
        while (i < slines.length && !slines[i].startsWith('Sold by:') && !/^\$[0-9.]+$/.test(slines[i])) desc.push(slines[i++]);
        while (i < slines.length && (slines[i].startsWith('Sold by:') || slines[i].startsWith('Supplied by:'))) i++;
        let price = 0;
        if (i < slines.length && /^\$[0-9.]+$/.test(slines[i])) price = parseFloat(slines[i++].slice(1));
        if (desc.length) result.items.push({ description: desc.join(' '), quantity: qty, unit_price: price, total: +(price * qty).toFixed(2), is_rental: 1 });
      } else { i++; }
    }
  }
  return result;
}

async function parsePDF(filePath) {
  const data = await pdfParse(fs.readFileSync(filePath));
  const text = data.text;
  if (text.toLowerCase().includes('walmart.com')) return parseWalmart(text);
  if (text.toLowerCase().includes('amazon.com') || text.includes('Grand Total:')) return parseAmazon(text);
  // Generic fallback — return raw text for manual entry
  return { vendor: 'Unknown', orderNumber: '', date: '', items: [], subtotal: 0, tax: 0, total: 0, rawText: text.slice(0, 2000) };
}

// ─── Airbnb CSV import ────────────────────────────────────────────────────────

function parseCSVRow(line) {
  const fields = [];
  let field = '', inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) { fields.push(field); field = ''; }
    else field += ch;
  }
  fields.push(field);
  return fields;
}

function parseAirbnbDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

function importAirbnbCSV(buffer) {
  const lines = buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n').filter(l => l.trim());
  if (lines.length < 2) return { imported: 0, updated: 0 };

  const headers = parseCSVRow(lines[0]).map(h => h.trim());
  const col     = name => headers.indexOf(name);
  const rows    = lines.slice(1).map(line => {
    const v = parseCSVRow(line).map(f => f.trim());
    return name => v[col(name)] || '';
  });

  // First pass: collect Payout rows — keyed by date, value is the exact paid-out amount.
  // The fast_pay_fee only appears on Payout rows, not Reservation rows, so the only
  // reliable payout figure is the "Paid out" column on those rows.
  const payoutByDate = {};
  for (const get of rows) {
    if (get('Type') !== 'Payout') continue;
    const paid = parseFloat(get('Paid out')) || 0;
    if (get('Date') && paid > 0) payoutByDate[get('Date')] = paid;
  }

  const insertStmt = db.prepare(`INSERT OR IGNORE INTO bookings
    (platform,guest_name,confirmation,check_in,check_out,nights,rate_per_night,cleaning_fee,service_fee,gross_revenue,payout,notes)
    VALUES (@platform,@guest_name,@confirmation,@check_in,@check_out,@nights,@rate_per_night,@cleaning_fee,@service_fee,@gross_revenue,@payout,@notes)`);
  const updateStmt = db.prepare(
    `UPDATE bookings SET payout=?, gross_revenue=?, cleaning_fee=?, service_fee=?, nights=?
     WHERE confirmation=? AND payout=0`);
  const existsStmt = db.prepare('SELECT id, payout FROM bookings WHERE confirmation=?');

  let imported = 0, updated = 0;
  for (const get of rows) {
    if (get('Type') !== 'Reservation') continue;
    const confirmation = get('Confirmation code');
    if (!confirmation) continue;

    const nights       = parseInt(get('Nights'))           || 0;
    const grossRevenue = parseFloat(get('Gross earnings')) || 0;
    const cleaningFee  = parseFloat(get('Cleaning fee'))   || 0;
    const serviceFee   = parseFloat(get('Service fee'))    || 0;
    // Payout row date matches Reservation Date field (= check-out date on past CSV)
    const payout       = payoutByDate[get('Date')]         || 0;
    const ratePerNight = nights > 0 ? +((grossRevenue - cleaningFee) / nights).toFixed(2) : 0;

    const existing = existsStmt.get(confirmation);
    if (!existing) {
      insertStmt.run({
        platform: 'airbnb', guest_name: get('Guest'), confirmation,
        check_in: parseAirbnbDate(get('Start date')), check_out: parseAirbnbDate(get('End date')),
        nights, rate_per_night: ratePerNight, cleaning_fee: cleaningFee,
        service_fee: serviceFee, gross_revenue: grossRevenue, payout,
        notes: get('Booking date') ? `Booked: ${get('Booking date')}` : '',
      });
      imported++;
    } else if (payout > 0 && (existing.payout || 0) === 0) {
      updateStmt.run(payout, grossRevenue, cleaningFee, serviceFee, nights, confirmation);
      updated++;
    }
  }
  return { imported, updated };
}

// ─── Shared styles & nav ──────────────────────────────────────────────────────

const SHARED_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f0f4f8; color: #2d3748; }
  a { color: inherit; text-decoration: none; }

  .site-header { background: linear-gradient(135deg, #1a202c 0%, #2d3748 100%); color: white; padding: 16px 28px; display: flex; align-items: center; justify-content: space-between; }
  .site-header h1 { font-size: 1.3rem; font-weight: 700; }
  .site-header p  { font-size: 0.75rem; opacity: 0.6; margin-top: 2px; }

  nav { background: #2d3748; display: flex; gap: 2px; padding: 0 24px; }
  nav a { display: inline-block; padding: 10px 16px; color: #a0aec0; font-size: 0.82rem; font-weight: 500; border-bottom: 3px solid transparent; white-space: nowrap; }
  nav a:hover { color: white; }
  nav a.active { color: white; border-bottom-color: #63b3ed; }

  .content { padding: 24px 28px 40px; max-width: 1100px; }
  .page-title { font-size: 1.15rem; font-weight: 700; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }

  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .stat-card { background: white; border-radius: 8px; padding: 14px 18px; box-shadow: 0 1px 4px rgba(0,0,0,.07); }
  .stat-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: .06em; color: #a0aec0; font-weight: 700; margin-bottom: 5px; }
  .stat-value { font-size: 1.35rem; font-weight: 700; }
  .stat-value.pos { color: #276749; } .stat-value.neg { color: #c53030; }

  .card { background: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,.07); margin-bottom: 20px; }
  .card-title { font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #a0aec0; margin-bottom: 14px; }

  table { width: 100%; border-collapse: collapse; font-size: 0.83rem; }
  th { text-align: left; font-weight: 600; color: #718096; padding: 6px 10px 8px 0; border-bottom: 2px solid #e2e8f0; font-size: 0.72rem; text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; }
  td { padding: 9px 10px 9px 0; border-bottom: 1px solid #f7fafc; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #f7fafc; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }

  .btn { display: inline-block; padding: 8px 16px; border-radius: 6px; font-size: 0.82rem; font-weight: 600; cursor: pointer; border: none; font-family: inherit; }
  .btn-primary   { background: #4299e1; color: white; }   .btn-primary:hover   { background: #3182ce; }
  .btn-success   { background: #48bb78; color: white; }   .btn-success:hover   { background: #38a169; }
  .btn-secondary { background: #edf2f7; color: #4a5568; } .btn-secondary:hover { background: #e2e8f0; }
  .btn-danger    { background: #fff5f5; color: #c53030; border: 1px solid #feb2b2; } .btn-danger:hover { background: #fed7d7; }
  .btn-sm { padding: 4px 10px; font-size: 0.73rem; }

  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
  .badge-airbnb    { background: #fff7ed; color: #c05621; }
  .badge-rvshare   { background: #fff5f5; color: #c53030; }
  .badge-outdoorsy { background: #f0fff4; color: #276749; }
  .badge-general   { background: #ebf8ff; color: #2b6cb0; }
  .badge-ok        { background: #c6f6d5; color: #276749; }
  .badge-warn      { background: #fefcbf; color: #744210; }

  .form-grid   { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .form-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .field { margin-bottom: 0; }
  .field label { display: block; font-size: 0.78rem; font-weight: 600; color: #4a5568; margin-bottom: 4px; }
  .field input, .field select, .field textarea { width: 100%; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.83rem; color: #2d3748; background: white; font-family: inherit; }
  .field input:focus, .field select:focus, .field textarea:focus { outline: none; border-color: #63b3ed; box-shadow: 0 0 0 3px rgba(99,179,237,.15); }
  .field textarea { resize: vertical; min-height: 60px; }

  .upload-zone { border: 2px dashed #cbd5e0; border-radius: 8px; padding: 28px; text-align: center; cursor: pointer; color: #718096; transition: all .2s; }
  .upload-zone:hover, .upload-zone.over { border-color: #4299e1; background: #ebf8ff; color: #2b6cb0; }
  .upload-zone input[type=file] { display: none; }
  .upload-zone .icon { font-size: 2rem; margin-bottom: 8px; }
  .upload-zone p { font-size: 0.83rem; margin-top: 4px; }

  .item-check-row { display: grid; grid-template-columns: 28px 1fr 90px 130px; gap: 8px; align-items: center; padding: 7px 0; border-bottom: 1px solid #f7fafc; font-size: 0.82rem; }
  .item-check-row:last-child { border-bottom: none; }
  .item-check-row input[type=checkbox] { width: 16px; height: 16px; cursor: pointer; }
  .item-check-row select { padding: 3px 6px; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 0.75rem; }

  .modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 200; align-items: center; justify-content: center; padding: 20px; }
  .modal-bg.open { display: flex; }
  .modal { background: white; border-radius: 10px; padding: 28px; width: 100%; max-width: 580px; max-height: 90vh; overflow-y: auto; }
  .modal-title { font-size: 1.05rem; font-weight: 700; margin-bottom: 20px; display: flex; justify-content: space-between; }
  .modal-title button { background: none; border: none; font-size: 1.2rem; cursor: pointer; color: #a0aec0; }
  .modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; padding-top: 16px; border-top: 1px solid #e2e8f0; }

  .img-preview { max-width: 100%; border-radius: 6px; margin-top: 10px; border: 1px solid #e2e8f0; }
  .notice { background: #ebf8ff; border-left: 3px solid #4299e1; padding: 10px 14px; border-radius: 4px; font-size: 0.82rem; color: #2b6cb0; margin-bottom: 16px; }
  .error-notice { background: #fff5f5; border-left: 3px solid #e53e3e; color: #c53030; }
  .success-notice { background: #f0fff4; border-left: 3px solid #38a169; color: #276749; }
  .empty-state { text-align: center; padding: 48px 20px; color: #a0aec0; font-size: 0.9rem; }
  .empty-state .icon { font-size: 2.5rem; margin-bottom: 10px; }
`;

function navHtml(active) {
  const links = [
    ['/', '📅 Calendar'],
    ['/bookings', '📋 Bookings'],
    ['/expenses', '🧾 Expenses'],
    ['/electricity', '⚡ Electricity'],
    ['/reports', '📊 Reports'],
  ];
  return `<nav>${links.map(([href, label]) => `<a href="${href}"${active === href ? ' class="active"' : ''}>${label}</a>`).join('')}</nav>`;
}

function pageShell(active, title, body, extraScript = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Hopeland</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<div class="site-header">
  <div><h1>Hopeland &mdash; Between the Stars &amp; Shore</h1><p>RV Rental Manager</p></div>
</div>
${navHtml(active)}
<div class="content">
${body}
</div>
<script>
async function api(method, url, data) {
  const opts = { method, headers: {} };
  if (data && !(data instanceof FormData)) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(data); }
  else if (data) opts.body = data;
  const r = await fetch(url, opts);
  return r.json().catch(() => ({}));
}
function showMsg(msg, type = 'ok') {
  const el = document.getElementById('msg');
  if (!el) return;
  el.textContent = msg;
  el.className = 'notice ' + (type === 'ok' ? 'success-notice' : 'error-notice');
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}
${extraScript}
</script>
</body>
</html>`;
}

// ─── Bookings page ────────────────────────────────────────────────────────────

function bookingsPage() {
  const bookings = db.prepare(`SELECT b.*,
    (SELECT COALESCE(SUM(ei.total),0) FROM expense_items ei JOIN expenses e ON e.id=ei.expense_id WHERE e.booking_id=b.id AND ei.is_rental=1) as expense_total,
    (SELECT COALESCE(kwh,0) FROM electricity WHERE booking_id=b.id LIMIT 1) as kwh
    FROM bookings b ORDER BY check_in DESC`).all();

  const totals = bookings.reduce((a, b) => ({ rev: a.rev + (b.payout||0), exp: a.exp + (b.expense_total||0) }), { rev: 0, exp: 0 });
  const bookingOptions = bookings.map(b => `<option value="${b.id}">${b.guest_name} (${b.check_in})</option>`).join('');

  const rows = bookings.length ? bookings.map(b => `
    <tr>
      <td><strong>${b.guest_name}</strong></td>
      <td><span class="badge badge-${b.platform}">${b.platform}</span></td>
      <td>${fmtDate(b.check_in)} &ndash; ${fmtDate(b.check_out)}</td>
      <td class="num">${b.nights}</td>
      <td class="num">${fmt$(b.gross_revenue)}</td>
      <td class="num">${fmt$(b.payout)}</td>
      <td class="num">${b.expense_total > 0 ? fmt$(b.expense_total) : '—'}</td>
      <td class="num">${b.kwh ? b.kwh + ' kWh' : '—'}</td>
      <td class="num"><strong>${fmt$(b.payout - b.expense_total)}</strong></td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteBooking(${b.id})">✕</button></td>
    </tr>`).join('') : `<tr><td colspan="10"><div class="empty-state"><div class="icon">📋</div>No bookings yet — add your first one.</div></td></tr>`;

  return pageShell('/bookings', 'Bookings', `
<div id="msg" style="display:none" class="notice"></div>
<div class="page-title">
  Bookings
  <div style="display:flex;gap:8px">
    <button class="btn btn-secondary" onclick="document.getElementById('csv-input').click()">&#8679; Import Airbnb CSV</button>
    <input type="file" id="csv-input" accept=".csv" style="display:none" onchange="importCSV(this.files[0])">
    <button class="btn btn-primary" onclick="document.getElementById('add-modal').classList.add('open')">+ Add Booking</button>
  </div>
</div>

<div class="stats-grid">
  <div class="stat-card"><div class="stat-label">Total Bookings</div><div class="stat-value">${bookings.length}</div></div>
  <div class="stat-card"><div class="stat-label">Total Payout</div><div class="stat-value pos">${fmt$(totals.rev)}</div></div>
  <div class="stat-card"><div class="stat-label">Rental Expenses</div><div class="stat-value neg">${fmt$(totals.exp)}</div></div>
  <div class="stat-card"><div class="stat-label">Net Profit</div><div class="stat-value ${totals.rev - totals.exp >= 0 ? 'pos' : 'neg'}">${fmt$(totals.rev - totals.exp)}</div></div>
</div>

<div class="card">
  <table>
    <thead><tr>
      <th>Guest</th><th>Platform</th><th>Dates</th><th class="num">Nights</th>
      <th class="num">Gross</th><th class="num">Payout</th><th class="num">Expenses</th>
      <th class="num">Electricity</th><th class="num">Net</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>

<!-- Add Booking Modal -->
<div class="modal-bg" id="add-modal">
  <div class="modal">
    <div class="modal-title">Add Booking <button onclick="document.getElementById('add-modal').classList.remove('open')">✕</button></div>
    <div class="form-grid" style="gap:14px">
      <div class="field"><label>Platform</label>
        <select id="f-platform"><option value="airbnb">Airbnb</option><option value="rvshare">RVshare</option><option value="outdoorsy">Outdoorsy</option></select></div>
      <div class="field"><label>Guest Name</label><input id="f-guest" placeholder="Full name" /></div>
      <div class="field"><label>Check-in</label><input id="f-checkin" type="date" /></div>
      <div class="field"><label>Check-out</label><input id="f-checkout" type="date" /></div>
      <div class="field"><label>Nights</label><input id="f-nights" type="number" min="1" placeholder="Auto-calculated" /></div>
      <div class="field"><label>Rate / Night ($)</label><input id="f-rate" type="number" step="0.01" placeholder="0.00" /></div>
      <div class="field"><label>Cleaning Fee ($)</label><input id="f-cleaning" type="number" step="0.01" placeholder="0.00" /></div>
      <div class="field"><label>Service Fee ($, negative)</label><input id="f-service" type="number" step="0.01" placeholder="-0.00" /></div>
      <div class="field"><label>Gross Revenue ($)</label><input id="f-gross" type="number" step="0.01" placeholder="0.00" /></div>
      <div class="field"><label>Payout Received ($)</label><input id="f-payout" type="number" step="0.01" placeholder="0.00" /></div>
      <div class="field"><label>Payout Date</label><input id="f-paydate" type="date" /></div>
      <div class="field"><label>Confirmation Code</label><input id="f-confirm" placeholder="e.g. HMW8PTTWCZ" /></div>
    </div>
    <div class="field" style="margin-top:12px"><label>Notes</label><textarea id="f-notes" rows="2"></textarea></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="document.getElementById('add-modal').classList.remove('open')">Cancel</button>
      <button class="btn btn-primary" onclick="saveBooking()">Save Booking</button>
    </div>
  </div>
</div>
`, `
// Auto-calc nights from dates
['f-checkin','f-checkout'].forEach(id => document.getElementById(id).addEventListener('change', () => {
  const ci = document.getElementById('f-checkin').value;
  const co = document.getElementById('f-checkout').value;
  if (ci && co) {
    const n = Math.round((new Date(co) - new Date(ci)) / 86400000);
    document.getElementById('f-nights').value = n > 0 ? n : '';
  }
}));

async function saveBooking() {
  const data = {
    platform:      document.getElementById('f-platform').value,
    guest_name:    document.getElementById('f-guest').value.trim(),
    check_in:      document.getElementById('f-checkin').value,
    check_out:     document.getElementById('f-checkout').value,
    nights:        parseInt(document.getElementById('f-nights').value) || 0,
    rate_per_night:parseFloat(document.getElementById('f-rate').value) || 0,
    cleaning_fee:  parseFloat(document.getElementById('f-cleaning').value) || 0,
    service_fee:   parseFloat(document.getElementById('f-service').value) || 0,
    gross_revenue: parseFloat(document.getElementById('f-gross').value) || 0,
    payout:        parseFloat(document.getElementById('f-payout').value) || 0,
    payout_date:   document.getElementById('f-paydate').value,
    confirmation:  document.getElementById('f-confirm').value.trim(),
    notes:         document.getElementById('f-notes').value.trim(),
  };
  if (!data.guest_name || !data.check_in || !data.check_out) return alert('Guest name and dates are required.');
  const r = await api('POST', '/api/bookings', data);
  if (r.id) { location.reload(); } else { showMsg(r.error || 'Error saving booking.', 'err'); }
}

async function deleteBooking(id) {
  if (!confirm('Delete this booking? Associated expenses and electricity records will remain.')) return;
  const r = await api('DELETE', '/api/bookings/' + id);
  if (r.ok) location.reload(); else showMsg(r.error || 'Error.', 'err');
}

async function importCSV(file) {
  if (!file) return;
  const btn = document.querySelector('[onclick*="csv-input"]');
  if (btn) btn.textContent = 'Importing…';
  const fd = new FormData();
  fd.append('csv', file);
  document.getElementById('csv-input').value = '';
  try {
    const r    = await fetch('/api/import-csv', { method: 'POST', body: fd });
    const data = await r.json();
    if (data.error) { showMsg('Import error: ' + data.error, 'err'); }
    else {
      const parts = [];
      if (data.imported) parts.push(data.imported + ' new booking(s) added');
      if (data.updated)  parts.push(data.updated  + ' payout(s) updated');
      if (!parts.length) parts.push('No changes — all bookings already up to date');
      showMsg(parts.join(', ') + '.', 'ok');
      if (data.imported || data.updated) setTimeout(() => location.reload(), 1500);
    }
  } catch (e) { showMsg('Import failed: ' + e.message, 'err'); }
  if (btn) btn.textContent = '⬆ Import Airbnb CSV';
}
`);
}

// ─── Expenses page ────────────────────────────────────────────────────────────

function expensesPage() {
  const expenses = db.prepare(`
    SELECT e.*, b.guest_name, b.check_in,
      (SELECT COALESCE(SUM(total),0) FROM expense_items WHERE expense_id=e.id AND is_rental=1) as rental_total,
      (SELECT COALESCE(SUM(total),0) FROM expense_items WHERE expense_id=e.id) as item_total,
      (SELECT COUNT(*) FROM expense_items WHERE expense_id=e.id) as item_count
    FROM expenses e LEFT JOIN bookings b ON b.id=e.booking_id
    ORDER BY e.date DESC`).all();

  const bookings = db.prepare('SELECT id, guest_name, check_in, check_out FROM bookings ORDER BY check_in DESC').all();
  const bookingOptions = `<option value="">— General / Not booking-specific —</option>` +
    bookings.map(b => `<option value="${b.id}">${b.guest_name} (${b.check_in})</option>`).join('');

  const totalRental = expenses.reduce((a, e) => a + (e.rental_total || 0), 0);

  const rows = expenses.length ? expenses.map(e => {
    const items = db.prepare('SELECT * FROM expense_items WHERE expense_id=? ORDER BY id').all(e.id);
    const itemRows = items.map(i => `
      <tr style="background:#f7fafc;font-size:0.78rem">
        <td style="padding-left:24px;color:#718096">${i.description}</td>
        <td class="num" style="color:#718096">×${i.quantity}</td>
        <td class="num" style="color:#718096">${fmt$(i.unit_price)}</td>
        <td class="num" style="color:#718096">${fmt$(i.total)}</td>
        <td class="num"><span class="badge ${i.is_rental ? 'badge-ok' : 'badge-warn'}">${i.is_rental ? 'Rental' : 'Personal'}</span></td>
        <td></td>
      </tr>`).join('');
    return `
      <tr>
        <td>${fmtDate(e.date)}</td>
        <td><strong>${e.vendor || '—'}</strong>${e.order_number ? `<br><span style="font-size:.72rem;color:#a0aec0">#${e.order_number}</span>` : ''}</td>
        <td>${e.guest_name ? `${e.guest_name}<br><span style="font-size:.72rem;color:#a0aec0">${e.check_in}</span>` : '<span class="badge badge-general">General</span>'}</td>
        <td class="num">${e.item_count} item(s)</td>
        <td class="num">${fmt$(e.item_total)}</td>
        <td class="num"><strong>${fmt$(e.rental_total)}</strong></td>
        <td>${e.receipt_file ? `<a href="/uploads/receipts/${e.receipt_file}" target="_blank" style="color:#4299e1;font-size:.75rem">📄 View</a>` : '—'}</td>
        <td><button class="btn btn-danger btn-sm" onclick="deleteExpense(${e.id})">✕</button></td>
      </tr>${itemRows}`;
  }).join('') : `<tr><td colspan="8"><div class="empty-state"><div class="icon">🧾</div>No expenses yet — upload a receipt to get started.</div></td></tr>`;

  return pageShell('/expenses', 'Expenses', `
<div id="msg" style="display:none" class="notice"></div>
<div class="page-title">
  Expenses
  <div style="display:flex;gap:8px">
    <button class="btn btn-primary" onclick="document.getElementById('upload-modal').classList.add('open')">📄 Upload Receipt (PDF)</button>
    <button class="btn btn-secondary" onclick="document.getElementById('manual-modal').classList.add('open')">+ Add Manually</button>
  </div>
</div>

<div class="stats-grid">
  <div class="stat-card"><div class="stat-label">Total Expenses</div><div class="stat-value">${expenses.length}</div></div>
  <div class="stat-card"><div class="stat-label">Total Rental Expenses</div><div class="stat-value neg">${fmt$(totalRental)}</div></div>
</div>

<div class="card">
  <table>
    <thead><tr>
      <th>Date</th><th>Vendor / Order</th><th>Booking</th><th class="num">Items</th>
      <th class="num">Order Total</th><th class="num">Rental $</th><th>Receipt</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>

<!-- Upload Receipt Modal -->
<div class="modal-bg" id="upload-modal">
  <div class="modal" style="max-width:640px">
    <div class="modal-title">Upload Receipt (PDF) <button onclick="closeUpload()">✕</button></div>
    <div id="upload-step-1">
      <div class="upload-zone" id="drop-zone" onclick="document.getElementById('pdf-input').click()"
           ondragover="event.preventDefault();this.classList.add('over')"
           ondragleave="this.classList.remove('over')"
           ondrop="handleDrop(event)">
        <input type="file" id="pdf-input" accept=".pdf" onchange="uploadPDF(this.files[0])">
        <div class="icon">📄</div>
        <strong>Click to select a PDF</strong>
        <p>or drag and drop — Amazon or Walmart order receipts</p>
      </div>
      <div id="upload-status" style="margin-top:10px;font-size:.83rem;color:#718096"></div>
    </div>

    <div id="upload-step-2" style="display:none">
      <div id="parsed-header" class="notice" style="margin-bottom:14px"></div>
      <div class="field" style="margin-bottom:12px"><label>Assign to Booking</label>
        <select id="p-booking">${bookingOptions}</select></div>
      <div class="field" style="margin-bottom:12px"><label>Expense Date</label>
        <input id="p-date" type="date" value="${isoToday()}" /></div>
      <div style="margin-bottom:8px;font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#a0aec0">
        Line Items — check which are rental expenses</div>
      <div id="parsed-items"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeUpload()">Cancel</button>
        <button class="btn btn-primary" onclick="saveExpense()">Save Expense</button>
      </div>
    </div>
  </div>
</div>

<!-- Manual Expense Modal -->
<div class="modal-bg" id="manual-modal">
  <div class="modal">
    <div class="modal-title">Add Expense Manually <button onclick="document.getElementById('manual-modal').classList.remove('open')">✕</button></div>
    <div class="form-grid" style="gap:12px">
      <div class="field"><label>Date</label><input id="m-date" type="date" value="${isoToday()}" /></div>
      <div class="field"><label>Assign to Booking</label><select id="m-booking">${bookingOptions}</select></div>
      <div class="field"><label>Vendor</label><input id="m-vendor" placeholder="Amazon, Walmart, etc." /></div>
      <div class="field"><label>Order # (optional)</label><input id="m-order" /></div>
      <div class="field"><label>Description</label><input id="m-desc" placeholder="What was purchased" /></div>
      <div class="field"><label>Category</label>
        <select id="m-cat">
          <option value="supplies">Supplies / Consumables</option>
          <option value="equipment">Equipment / Capital</option>
          <option value="cleaning">Cleaning</option>
          <option value="maintenance">Maintenance / Repair</option>
          <option value="other">Other</option>
        </select></div>
      <div class="field"><label>Amount ($)</label><input id="m-amount" type="number" step="0.01" placeholder="0.00" /></div>
      <div class="field"><label>Tax ($)</label><input id="m-tax" type="number" step="0.01" placeholder="0.00" /></div>
    </div>
    <div class="field" style="margin-top:12px"><label>Notes</label><textarea id="m-notes" rows="2"></textarea></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="document.getElementById('manual-modal').classList.remove('open')">Cancel</button>
      <button class="btn btn-primary" onclick="saveManualExpense()">Save</button>
    </div>
  </div>
</div>
`, `
let parsedData = null;

function closeUpload() {
  document.getElementById('upload-modal').classList.remove('open');
  document.getElementById('upload-step-1').style.display = 'block';
  document.getElementById('upload-step-2').style.display = 'none';
  document.getElementById('upload-status').textContent = '';
  document.getElementById('pdf-input').value = '';
  parsedData = null;
}

function handleDrop(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('over');
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') uploadPDF(file);
}

async function uploadPDF(file) {
  if (!file) return;
  document.getElementById('upload-status').textContent = 'Parsing PDF...';
  const fd = new FormData();
  fd.append('receipt', file);
  const r = await fetch('/api/parse-pdf', { method: 'POST', body: fd });
  const data = await r.json();
  if (data.error) { document.getElementById('upload-status').textContent = 'Error: ' + data.error; return; }
  parsedData = data;
  document.getElementById('parsed-header').innerHTML =
    \`<strong>\${data.vendor}</strong>\${data.orderNumber ? ' &bull; Order #' + data.orderNumber : ''}\${data.date ? ' &bull; ' + data.date : ''} &bull; Total: <strong>\${data.total ? '$' + data.total.toFixed(2) : '?'}</strong>\`;
  if (data.date) {
    const d = new Date(data.date); if (!isNaN(d)) document.getElementById('p-date').value = d.toISOString().slice(0,10);
  }
  const cats = ['supplies','equipment','cleaning','maintenance','other'];
  const catOpts = cats.map(c => \`<option value="\${c}">\${c.charAt(0).toUpperCase()+c.slice(1)}</option>\`).join('');
  if (data.items && data.items.length) {
    document.getElementById('parsed-items').innerHTML = data.items.map((it, i) => \`
      <div class="item-check-row">
        <input type="checkbox" id="item-\${i}" \${it.is_rental ? 'checked' : ''} />
        <label for="item-\${i}" style="cursor:pointer">\${it.description}\${it.quantity > 1 ? ' ×'+it.quantity : ''}</label>
        <span style="text-align:right;font-weight:600">$\${it.total.toFixed(2)}</span>
        <select id="cat-\${i}">\${catOpts}</select>
      </div>\`).join('');
  } else {
    document.getElementById('parsed-items').innerHTML = \`<div class="notice">No line items detected. Expense will be saved as a lump sum of $\${data.total || 0}.</div>\`;
  }
  document.getElementById('upload-step-1').style.display = 'none';
  document.getElementById('upload-step-2').style.display = 'block';
}

async function saveExpense() {
  const items = (parsedData.items || []).map((it, i) => ({
    description: it.description, quantity: it.quantity, unit_price: it.unit_price, total: it.total,
    is_rental: document.getElementById('item-'+i) ? (document.getElementById('item-'+i).checked ? 1 : 0) : 1,
    category: document.getElementById('cat-'+i) ? document.getElementById('cat-'+i).value : 'supplies',
  }));
  const body = {
    booking_id:   document.getElementById('p-booking').value || null,
    date:         document.getElementById('p-date').value,
    vendor:       parsedData.vendor,
    order_number: parsedData.orderNumber,
    subtotal:     parsedData.subtotal,
    tax:          parsedData.tax,
    total:        parsedData.total,
    receipt_file: parsedData.filename,
    items,
  };
  const r = await api('POST', '/api/expenses', body);
  if (r.id) { location.reload(); } else { showMsg(r.error || 'Error saving.', 'err'); }
}

async function saveManualExpense() {
  const amount = parseFloat(document.getElementById('m-amount').value) || 0;
  const tax    = parseFloat(document.getElementById('m-tax').value) || 0;
  const body = {
    booking_id:   document.getElementById('m-booking').value || null,
    date:         document.getElementById('m-date').value,
    vendor:       document.getElementById('m-vendor').value.trim(),
    order_number: document.getElementById('m-order').value.trim(),
    description:  document.getElementById('m-desc').value.trim(),
    category:     document.getElementById('m-cat').value,
    subtotal:     amount,
    tax,
    total:        +(amount + tax).toFixed(2),
    items: [{ description: document.getElementById('m-desc').value.trim() || 'Expense', quantity: 1, unit_price: amount, total: amount, is_rental: 1 }],
  };
  const r = await api('POST', '/api/expenses', body);
  if (r.id) { location.reload(); } else { showMsg(r.error || 'Error saving.', 'err'); }
}

async function deleteExpense(id) {
  if (!confirm('Delete this expense and all its line items?')) return;
  const r = await api('DELETE', '/api/expenses/' + id);
  if (r.ok) location.reload(); else showMsg(r.error || 'Error.', 'err');
}
`);
}

// ─── Electricity page ─────────────────────────────────────────────────────────

// ANEC default rates (energy delivery + supply, no demand/access charge)
const ANEC_SUMMER = 0.12725; // Jun–Sep: $0.02220 + $0.10505
const ANEC_WINTER = 0.10725; // Oct–May: $0.02220 + $0.08505

function elecRateForDate(dateStr) {
  const month = new Date((dateStr || isoToday()) + 'T00:00:00').getMonth() + 1;
  return (month >= 6 && month <= 9)
    ? parseFloat(getSetting('electric_rate_summer')) || 0
    : parseFloat(getSetting('electric_rate_winter')) || 0;
}

function electricityPage() {
  const readings = db.prepare(`
    SELECT e.*, b.guest_name, b.check_in, b.check_out, b.nights
    FROM electricity e LEFT JOIN bookings b ON b.id=e.booking_id
    ORDER BY e.reading_date DESC`).all();
  const bookings = db.prepare('SELECT id, guest_name, check_in, check_out FROM bookings ORDER BY check_in DESC').all();
  const bookingOptions = `<option value="">— Between stays / Maintenance —</option>` +
    bookings.map(b => `<option value="${b.id}">${b.guest_name} (${b.check_in} to ${b.check_out})</option>`).join('');

  const summerRate = parseFloat(getSetting('electric_rate_summer')) || 0;
  const winterRate = parseFloat(getSetting('electric_rate_winter')) || 0;
  const ratesSet   = summerRate > 0 && winterRate > 0;
  const rateUpdated = getSetting('electric_rate_updated');

  const totalKwh  = readings.reduce((a, r) => a + (r.kwh || 0), 0);
  const totalCost = ratesSet
    ? readings.reduce((a, r) => a + r.kwh * elecRateForDate(r.reading_date), 0)
    : null;

  const rateLabel = ratesSet
    ? `Summer $${summerRate.toFixed(4)} &bull; Winter $${winterRate.toFixed(4)}${rateUpdated ? ` &nbsp;<span style="font-size:.72rem;color:#a0aec0">(set ${fmtDate(rateUpdated)})</span>` : ''}`
    : `<span style="color:#e53e3e">Not set — click Set Rates</span>`;

  const rows = readings.length ? readings.map(r => {
    const rate = elecRateForDate(r.reading_date);
    const cost = rate > 0 ? `<strong>${fmt$(r.kwh * rate)}</strong>` : '<span style="color:#cbd5e0">—</span>';
    return `
    <tr>
      <td>${fmtDate(r.reading_date)}</td>
      <td>${r.guest_name ? `<strong>${r.guest_name}</strong><br><span style="font-size:.72rem;color:#a0aec0">${r.check_in} – ${r.check_out}</span>` : '<span style="color:#a0aec0">Between stays</span>'}</td>
      <td class="num"><strong>${r.kwh}</strong> kWh</td>
      <td class="num">${cost}</td>
      <td>${r.notes || '—'}</td>
      <td>${r.screenshot_file ? `<a href="/uploads/electricity/${r.screenshot_file}" target="_blank" style="color:#4299e1;font-size:.75rem">📷 View</a>` : '—'}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteReading(${r.id})">✕</button></td>
    </tr>`;
  }).join('') : `<tr><td colspan="7"><div class="empty-state"><div class="icon">⚡</div>No electricity readings yet.</div></td></tr>`;

  return pageShell('/electricity', 'Electricity', `
<div id="msg" style="display:none" class="notice"></div>
<div class="page-title">
  Electricity Usage
  <div style="display:flex;gap:8px">
    <button class="btn btn-secondary" onclick="document.getElementById('rate-modal').classList.add('open')">⚙ Set Rate</button>
    <button class="btn btn-primary" onclick="document.getElementById('elec-modal').classList.add('open')">+ Add Reading</button>
  </div>
</div>

<div class="stats-grid">
  <div class="stat-card"><div class="stat-label">Total Readings</div><div class="stat-value">${readings.length}</div></div>
  <div class="stat-card"><div class="stat-label">Total kWh Tracked</div><div class="stat-value">${totalKwh.toFixed(1)} kWh</div></div>
  <div class="stat-card" style="grid-column:span 2"><div class="stat-label">Rates (ANEC) &mdash; auto-applied by month</div><div class="stat-value" style="font-size:1rem">${rateLabel}</div></div>
  <div class="stat-card"><div class="stat-label">Est. Total Cost</div><div class="stat-value neg">${totalCost != null ? fmt$(totalCost) : '—'}</div></div>
</div>

<div class="card">
  <table>
    <thead><tr><th>Date</th><th>Guest / Booking</th><th class="num">Usage</th><th class="num">Est. Cost</th><th>Notes</th><th>Screenshot</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>

<!-- Set Rates Modal -->
<div class="modal-bg" id="rate-modal">
  <div class="modal">
    <div class="modal-title">Set Electric Rates (ANEC) <button onclick="document.getElementById('rate-modal').classList.remove('open')">✕</button></div>
    <p style="font-size:.85rem;color:#4a5568;margin-bottom:16px">
      Rates are from the ANEC Schedule A-1 (energy delivery + supply charges only — base charge excluded since you pay it regardless).
      Update if ANEC publishes new rates.
    </p>
    <div class="form-grid" style="gap:12px">
      <div class="field">
        <label>Summer Rate — Jun through Sep ($/kWh)</label>
        <input id="r-summer" type="number" step="0.00001" placeholder="${ANEC_SUMMER}" value="${summerRate > 0 ? summerRate : ANEC_SUMMER}" />
        <span style="font-size:.75rem;color:#a0aec0">ANEC default: $${ANEC_SUMMER.toFixed(5)} ($0.02220 delivery + $0.10505 supply)</span>
      </div>
      <div class="field">
        <label>Winter Rate — Oct through May ($/kWh)</label>
        <input id="r-winter" type="number" step="0.00001" placeholder="${ANEC_WINTER}" value="${winterRate > 0 ? winterRate : ANEC_WINTER}" />
        <span style="font-size:.75rem;color:#a0aec0">ANEC default: $${ANEC_WINTER.toFixed(5)} ($0.02220 delivery + $0.08505 supply)</span>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="document.getElementById('rate-modal').classList.remove('open')">Cancel</button>
      <button class="btn btn-primary" onclick="saveRates()">Save Rates</button>
    </div>
  </div>
</div>

<!-- Add Reading Modal -->
<div class="modal-bg" id="elec-modal">
  <div class="modal">
    <div class="modal-title">Add Electricity Reading <button onclick="document.getElementById('elec-modal').classList.remove('open')">✕</button></div>
    <div class="field" style="margin-bottom:14px"><label>Assign to Booking (or leave blank for between-stay usage)</label>
      <select id="e-booking">${bookingOptions}</select></div>
    <div class="form-grid" style="gap:12px;margin-bottom:14px">
      <div class="field"><label>Reading Date</label><input id="e-date" type="date" value="${isoToday()}" /></div>
      <div class="field"><label>Energy Used (kWh)</label><input id="e-kwh" type="number" step="0.1" placeholder="e.g. 70.0" /></div>
    </div>
    <div class="field" style="margin-bottom:14px"><label>Upload Screenshot (optional)</label>
      <div class="upload-zone" onclick="document.getElementById('elec-file').click()" style="padding:16px">
        <input type="file" id="elec-file" accept="image/*,.jpg,.jpeg,.png" onchange="previewElec(this)" />
        <div class="icon" style="font-size:1.4rem">📷</div>
        <p>Click to upload Power Watchdog screenshot</p>
      </div>
      <img id="elec-preview" class="img-preview" style="display:none;max-height:200px" />
    </div>
    <div class="field" style="margin-bottom:14px"><label>Notes</label>
      <textarea id="e-notes" rows="2" placeholder="e.g. Reading taken at checkout"></textarea></div>
    <div class="notice" style="margin-bottom:0">
      💡 Tip: Take the screenshot right before a new guest checks in so the kWh counter shows usage for the stay. Hit the Energy Reset button after recording it.
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="document.getElementById('elec-modal').classList.remove('open')">Cancel</button>
      <button class="btn btn-primary" onclick="saveReading()">Save Reading</button>
    </div>
  </div>
</div>
`, `
async function saveRates() {
  const summer = parseFloat(document.getElementById('r-summer').value);
  const winter = parseFloat(document.getElementById('r-winter').value);
  if (!summer || !winter || summer <= 0 || winter <= 0) return alert('Please enter valid rates for both seasons.');
  await api('POST', '/api/settings', { key: 'electric_rate_summer', value: summer });
  await api('POST', '/api/settings', { key: 'electric_rate_winter', value: winter });
  await api('POST', '/api/settings', { key: 'electric_rate_updated', value: new Date().toISOString().slice(0,10) });
  location.reload();
}

function previewElec(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => { const img = document.getElementById('elec-preview'); img.src = e.target.result; img.style.display = 'block'; };
  reader.readAsDataURL(file);
}

async function saveReading() {
  const kwh = parseFloat(document.getElementById('e-kwh').value);
  if (!kwh) return alert('Please enter the kWh value.');
  const fd = new FormData();
  fd.append('booking_id', document.getElementById('e-booking').value || '');
  fd.append('reading_date', document.getElementById('e-date').value);
  fd.append('kwh', kwh);
  fd.append('notes', document.getElementById('e-notes').value.trim());
  const file = document.getElementById('elec-file').files[0];
  if (file) fd.append('electricity', file);
  const r = await fetch('/api/electricity', { method: 'POST', body: fd });
  const data = await r.json();
  if (data.id) location.reload(); else showMsg(data.error || 'Error.', 'err');
}

async function deleteReading(id) {
  if (!confirm('Delete this electricity reading?')) return;
  const r = await api('DELETE', '/api/electricity/' + id);
  if (r.ok) location.reload(); else showMsg(r.error || 'Error.', 'err');
}
`);
}

// ─── Reports page ─────────────────────────────────────────────────────────────

function reportsPage() {
  const bookings = db.prepare(`SELECT b.*,
    (SELECT COALESCE(SUM(ei.total),0) FROM expense_items ei JOIN expenses e ON e.id=ei.expense_id WHERE e.booking_id=b.id AND ei.is_rental=1) as rental_exp,
    (SELECT COALESCE(kwh,0) FROM electricity WHERE booking_id=b.id ORDER BY id LIMIT 1) as kwh
    FROM bookings b ORDER BY check_in DESC`).all();
  const generalExp = db.prepare(`SELECT COALESCE(SUM(ei.total),0) as total FROM expense_items ei JOIN expenses e ON e.id=ei.expense_id WHERE e.booking_id IS NULL AND ei.is_rental=1`).get().total;
  const totalPayout  = bookings.reduce((a, b) => a + (b.payout || 0), 0);
  const totalRentalExp = bookings.reduce((a, b) => a + (b.rental_exp || 0), 0) + generalExp;
  const totalKwh = db.prepare('SELECT COALESCE(SUM(kwh),0) as t FROM electricity').get().t;
  const net = totalPayout - totalRentalExp;

  const bookingRows = bookings.map(b => `
    <tr>
      <td>${b.guest_name}</td>
      <td><span class="badge badge-${b.platform}">${b.platform}</span></td>
      <td>${fmtDate(b.check_in)} – ${fmtDate(b.check_out)}</td>
      <td class="num">${b.nights}</td>
      <td class="num">${fmt$(b.payout)}</td>
      <td class="num">${b.rental_exp > 0 ? fmt$(b.rental_exp) : '—'}</td>
      <td class="num">${b.kwh ? b.kwh + ' kWh' : '—'}</td>
      <td class="num"><strong>${fmt$(b.payout - b.rental_exp)}</strong></td>
    </tr>`).join('');

  return pageShell('/reports', 'Reports', `
<div class="page-title">
  Reports &amp; Export
  <a href="/export/csv" class="btn btn-success">⬇ Export CSV for Taxes</a>
</div>

<div class="stats-grid">
  <div class="stat-card"><div class="stat-label">Total Payout</div><div class="stat-value pos">${fmt$(totalPayout)}</div></div>
  <div class="stat-card"><div class="stat-label">Rental Expenses</div><div class="stat-value neg">${fmt$(totalRentalExp)}</div></div>
  <div class="stat-card"><div class="stat-label">Net Profit</div><div class="stat-value ${net >= 0 ? 'pos' : 'neg'}">${fmt$(net)}</div></div>
  <div class="stat-card"><div class="stat-label">Total kWh Used</div><div class="stat-value">${Number(totalKwh).toFixed(1)}</div></div>
  <div class="stat-card"><div class="stat-label">General Expenses</div><div class="stat-value neg">${fmt$(generalExp)}</div></div>
  <div class="stat-card"><div class="stat-label">Bookings</div><div class="stat-value">${bookings.length}</div></div>
</div>

<div class="card">
  <div class="card-title">Per-Booking Breakdown</div>
  <table>
    <thead><tr>
      <th>Guest</th><th>Platform</th><th>Dates</th><th class="num">Nights</th>
      <th class="num">Payout</th><th class="num">Rental Exp</th><th class="num">kWh</th><th class="num">Net</th>
    </tr></thead>
    <tbody>${bookingRows || `<tr><td colspan="8"><div class="empty-state">No bookings yet.</div></td></tr>`}</tbody>
    ${bookings.length ? `<tfoot><tr style="font-weight:700;border-top:2px solid #e2e8f0">
      <td colspan="4">Totals</td>
      <td class="num">${fmt$(totalPayout)}</td>
      <td class="num">${fmt$(totalRentalExp - generalExp)}</td>
      <td class="num">${Number(totalKwh).toFixed(1)} kWh</td>
      <td class="num">${fmt$(net)}</td>
    </tr></tfoot>` : ''}
  </table>
</div>

${generalExp > 0 ? `<div class="card"><div class="card-title">General Expenses (not booking-specific)</div>
  <p style="font-size:.85rem;color:#718096">Total: <strong>${fmt$(generalExp)}</strong> in rental expenses not linked to a specific booking (equipment, supplies, etc.)</p></div>` : ''}
`);
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function buildCSV() {
  const lines = [];
  const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;

  lines.push('HOPELAND RV RENTAL — TAX EXPORT');
  lines.push(`Generated: ${new Date().toLocaleString()}`);
  lines.push('');

  lines.push('BOOKINGS');
  lines.push(['Guest','Platform','Check-in','Check-out','Nights','Gross Revenue','Cleaning Fee','Service Fee','Payout','Payout Date','Confirmation','Notes'].map(q).join(','));
  const bookings = db.prepare('SELECT * FROM bookings ORDER BY check_in').all();
  for (const b of bookings) lines.push([b.guest_name,b.platform,b.check_in,b.check_out,b.nights,b.gross_revenue,b.cleaning_fee,b.service_fee,b.payout,b.payout_date||'',b.confirmation||'',b.notes||''].map(q).join(','));
  lines.push('');

  lines.push('EXPENSES (RENTAL ITEMS ONLY)');
  lines.push(['Date','Vendor','Order #','Booking Guest','Item Description','Quantity','Unit Price','Total','Category','Is Rental'].map(q).join(','));
  const items = db.prepare(`SELECT ei.*, e.date, e.vendor, e.order_number, b.guest_name
    FROM expense_items ei JOIN expenses e ON e.id=ei.expense_id LEFT JOIN bookings b ON b.id=e.booking_id
    WHERE ei.is_rental=1 ORDER BY e.date, e.id`).all();
  for (const i of items) lines.push([i.date,i.vendor||'',i.order_number||'',i.guest_name||'General',i.description,i.quantity,i.unit_price,i.total,'rental','yes'].map(q).join(','));
  lines.push('');

  lines.push('ELECTRICITY');
  lines.push(['Date','Guest','kWh','Notes'].map(q).join(','));
  const elec = db.prepare('SELECT e.*, b.guest_name FROM electricity e LEFT JOIN bookings b ON b.id=e.booking_id ORDER BY reading_date').all();
  for (const e of elec) lines.push([e.reading_date, e.guest_name||'', e.kwh, e.notes||''].map(q).join(','));
  lines.push('');

  lines.push('SUMMARY');
  const totalPayout  = bookings.reduce((a, b) => a + (b.payout || 0), 0);
  const totalExp     = db.prepare('SELECT COALESCE(SUM(total),0) t FROM expense_items WHERE is_rental=1').get().t;
  lines.push([q('Total Payout'), q(totalPayout.toFixed(2))].join(','));
  lines.push([q('Total Rental Expenses'), q(totalExp.toFixed(2))].join(','));
  lines.push([q('Net Profit'), q((totalPayout - totalExp).toFixed(2))].join(','));

  return lines.join('\r\n');
}

// ─── Request handler (exported) ───────────────────────────────────────────────

module.exports = async function handleRequest(req, res) {
  const method = req.method;
  const p = req.url.split('?')[0];

  // ── Static file serving (uploads) ─────────────────────────────────────────
  if (p.startsWith('/uploads/')) {
    const filePath = path.join(__dirname, p);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.pdf': 'application/pdf' };
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } else { res.writeHead(404); res.end(); }
    return;
  }

  // ── HTML pages ─────────────────────────────────────────────────────────────
  if (method === 'GET') {
    if (p === '/bookings')    { sendHtml(res, bookingsPage()); return; }
    if (p === '/expenses')    { sendHtml(res, expensesPage()); return; }
    if (p === '/electricity') { sendHtml(res, electricityPage()); return; }
    if (p === '/reports')     { sendHtml(res, reportsPage()); return; }

    if (p === '/export/csv') {
      const csv = buildCSV();
      const date = new Date().toISOString().slice(0, 10);
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="hopeland-export-${date}.csv"` });
      res.end(csv); return;
    }
  }

  // ── Booking API ────────────────────────────────────────────────────────────
  if (p === '/api/bookings' && method === 'POST') {
    try {
      const d = JSON.parse(await readBody(req));
      const r = db.prepare(`INSERT INTO bookings (platform,guest_name,confirmation,check_in,check_out,nights,rate_per_night,cleaning_fee,service_fee,gross_revenue,payout,payout_date,notes)
        VALUES (@platform,@guest_name,@confirmation,@check_in,@check_out,@nights,@rate_per_night,@cleaning_fee,@service_fee,@gross_revenue,@payout,@payout_date,@notes)`).run(d);
      sendJson(res, { id: r.lastInsertRowid });
    } catch (e) { sendJson(res, { error: e.message }, 400); }
    return;
  }
  const bDel = p.match(/^\/api\/bookings\/(\d+)$/);
  if (bDel && method === 'DELETE') {
    db.prepare('DELETE FROM bookings WHERE id=?').run(parseInt(bDel[1]));
    sendJson(res, { ok: true }); return;
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  if (p === '/api/settings' && method === 'POST') {
    try {
      const d = JSON.parse(await readBody(req));
      if (!d.key) { sendJson(res, { error: 'Missing key' }, 400); return; }
      setSetting(d.key, d.value);
      sendJson(res, { ok: true });
    } catch (e) { sendJson(res, { error: e.message }, 400); }
    return;
  }

  // ── Import Airbnb CSV ──────────────────────────────────────────────────────
  if (p === '/api/import-csv' && method === 'POST') {
    try {
      await runMw(req, res, csvUpload.single('csv'));
      if (!req.file) { sendJson(res, { error: 'No file received' }, 400); return; }
      const result = importAirbnbCSV(req.file.buffer);
      sendJson(res, result);
    } catch (e) { sendJson(res, { error: e.message }, 500); }
    return;
  }

  // ── Parse PDF ──────────────────────────────────────────────────────────────
  if (p === '/api/parse-pdf' && method === 'POST') {
    try {
      await runMw(req, res, receiptUpload.single('receipt'));
      if (!req.file) { sendJson(res, { error: 'No file received' }, 400); return; }
      const parsed = await parsePDF(req.file.path);
      parsed.filename = req.file.filename;
      sendJson(res, parsed);
    } catch (e) { sendJson(res, { error: e.message }, 500); }
    return;
  }

  // ── Expense API ────────────────────────────────────────────────────────────
  if (p === '/api/expenses' && method === 'POST') {
    try {
      const d = JSON.parse(await readBody(req));
      const exp = db.prepare(`INSERT INTO expenses (booking_id,date,vendor,order_number,category,description,subtotal,tax,total,receipt_file,notes)
        VALUES (@booking_id,@date,@vendor,@order_number,@category,@description,@subtotal,@tax,@total,@receipt_file,@notes)`).run({
        booking_id: d.booking_id || null, date: d.date, vendor: d.vendor || '', order_number: d.order_number || '',
        category: d.category || 'supplies', description: d.description || '', subtotal: d.subtotal || 0,
        tax: d.tax || 0, total: d.total || 0, receipt_file: d.receipt_file || null, notes: d.notes || '',
      });
      const insertItem = db.prepare(`INSERT INTO expense_items (expense_id,description,quantity,unit_price,total,is_rental) VALUES (?,?,?,?,?,?)`);
      for (const it of (d.items || [])) insertItem.run(exp.lastInsertRowid, it.description, it.quantity || 1, it.unit_price || 0, it.total || 0, it.is_rental ?? 1);
      sendJson(res, { id: exp.lastInsertRowid });
    } catch (e) { sendJson(res, { error: e.message }, 400); }
    return;
  }
  const eDel = p.match(/^\/api\/expenses\/(\d+)$/);
  if (eDel && method === 'DELETE') {
    db.prepare('DELETE FROM expenses WHERE id=?').run(parseInt(eDel[1]));
    sendJson(res, { ok: true }); return;
  }

  // ── Electricity API ────────────────────────────────────────────────────────
  if (p === '/api/electricity' && method === 'POST') {
    try {
      await runMw(req, res, electricityUpload.single('electricity'));
      const body = req.body || {};
      const r = db.prepare(`INSERT INTO electricity (booking_id,reading_date,kwh,screenshot_file,notes) VALUES (?,?,?,?,?)`).run(
        body.booking_id || null, body.reading_date, parseFloat(body.kwh), req.file ? req.file.filename : null, body.notes || '');
      sendJson(res, { id: r.lastInsertRowid });
    } catch (e) { sendJson(res, { error: e.message }, 400); }
    return;
  }
  const lDel = p.match(/^\/api\/electricity\/(\d+)$/);
  if (lDel && method === 'DELETE') {
    db.prepare('DELETE FROM electricity WHERE id=?').run(parseInt(lDel[1]));
    sendJson(res, { ok: true }); return;
  }

  res.writeHead(404); res.end();
};

module.exports.navHtml  = navHtml;
module.exports.SHARED_CSS = SHARED_CSS;
