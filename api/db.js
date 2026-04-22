const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'motishop.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    company           TEXT NOT NULL,
    name              TEXT NOT NULL,
    phone             TEXT NOT NULL,
    features          TEXT NOT NULL,
    billing_type      TEXT NOT NULL,
    bill_key          TEXT NOT NULL,
    moid              TEXT NOT NULL,
    charge_amount     INTEGER NOT NULL,
    trial_start       TEXT NOT NULL,
    next_billing_date TEXT NOT NULL,
    status            TEXT DEFAULT 'trial',
    created_at        TEXT DEFAULT (datetime('now', '+9 hours'))
  );

  CREATE TABLE IF NOT EXISTS billing_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id INTEGER,
    moid          TEXT,
    amount        INTEGER,
    result_code   TEXT,
    result_msg    TEXT,
    billed_at     TEXT DEFAULT (datetime('now', '+9 hours')),
    FOREIGN KEY(subscriber_id) REFERENCES subscribers(id)
  );
`);

module.exports = db;
