const Database = require('better-sqlite3');
const path = require('path');
const cfg = require('./config');

const db = new Database(path.isAbsolute(cfg.DB_PATH) ? cfg.DB_PATH : path.join(__dirname, cfg.DB_PATH));

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

  CREATE TABLE IF NOT EXISTS sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id INTEGER NOT NULL,
    token         TEXT NOT NULL UNIQUE,
    expires_at    TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now', '+9 hours'))
  );
`);

// 컬럼 마이그레이션 (이미 존재하면 무시)
try { db.exec(`ALTER TABLE subscribers ADD COLUMN pw_hash TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE subscribers ADD COLUMN pw_salt TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE subscribers ADD COLUMN notified_7d INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE subscribers ADD COLUMN notified_1d INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE subscribers ADD COLUMN billkey_deleted INTEGER DEFAULT 0`); } catch(e) {}

// 인덱스
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sub_phone ON subscribers(phone)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sub_status_date ON subscribers(status, next_billing_date)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_log_subscriber ON billing_logs(subscriber_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_session_token ON sessions(token)`); } catch(e) {}

module.exports = db;
