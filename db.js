// db.js — SQLite database for Hopeland expense tracker
'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const db = new Database(path.join(DATA_DIR, 'hopeland.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    platform       TEXT    NOT NULL DEFAULT 'airbnb',
    guest_name     TEXT    NOT NULL,
    confirmation   TEXT,
    check_in       TEXT    NOT NULL,
    check_out      TEXT    NOT NULL,
    nights         INTEGER DEFAULT 0,
    rate_per_night REAL    DEFAULT 0,
    cleaning_fee   REAL    DEFAULT 0,
    service_fee    REAL    DEFAULT 0,
    gross_revenue  REAL    DEFAULT 0,
    payout         REAL    DEFAULT 0,
    payout_date    TEXT,
    notes          TEXT,
    created_at     TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id   INTEGER REFERENCES bookings(id),
    date         TEXT    NOT NULL,
    vendor       TEXT,
    order_number TEXT,
    category     TEXT    DEFAULT 'supplies',
    description  TEXT,
    subtotal     REAL    DEFAULT 0,
    tax          REAL    DEFAULT 0,
    total        REAL    DEFAULT 0,
    receipt_file TEXT,
    notes        TEXT,
    created_at   TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS expense_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    expense_id  INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    description TEXT    NOT NULL,
    quantity    INTEGER DEFAULT 1,
    unit_price  REAL    DEFAULT 0,
    total       REAL    NOT NULL,
    is_rental   INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS electricity (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id      INTEGER REFERENCES bookings(id),
    reading_date    TEXT    NOT NULL,
    kwh             REAL    NOT NULL,
    screenshot_file TEXT,
    notes           TEXT,
    created_at      TEXT    DEFAULT (datetime('now'))
  );
`);

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_confirmation
  ON bookings(confirmation) WHERE confirmation IS NOT NULL AND confirmation != '';`);

module.exports = db;
