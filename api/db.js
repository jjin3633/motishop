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
try { db.exec(`ALTER TABLE billing_logs ADD COLUMN trans_seq TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE subscribers ADD COLUMN email TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE subscribers ADD COLUMN business_number TEXT`); } catch(e) {}

// 변경 이력 테이블 (기능/구독유형 변경 추적)
db.exec(`
  CREATE TABLE IF NOT EXISTS subscriber_changes (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id       INTEGER NOT NULL,
    change_type         TEXT NOT NULL,
    before_features     TEXT,
    after_features      TEXT,
    before_billing_type TEXT,
    after_billing_type  TEXT,
    before_amount       INTEGER,
    after_amount        INTEGER,
    changed_at          TEXT DEFAULT (datetime('now', '+9 hours')),
    FOREIGN KEY(subscriber_id) REFERENCES subscribers(id)
  );
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_change_sub ON subscriber_changes(subscriber_id)`); } catch(e) {}

// 약관 동의 기록 — 법적 분쟁 시 증거 (정보통신망법 + 전자상거래법)
db.exec(`
  CREATE TABLE IF NOT EXISTS terms_consents (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id INTEGER NOT NULL,
    terms_key     TEXT NOT NULL,
    terms_version TEXT NOT NULL,
    ip            TEXT,
    user_agent    TEXT,
    agreed_at     TEXT DEFAULT (datetime('now', '+9 hours')),
    FOREIGN KEY(subscriber_id) REFERENCES subscribers(id)
  );
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_consent_sub ON terms_consents(subscriber_id)`); } catch(e) {}

// InnoPay 결제 노티 콜백 기록 (이중 통지 받을 시 cross-check용)
db.exec(`
  CREATE TABLE IF NOT EXISTS payment_notis (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    moid          TEXT,
    trans_seq     TEXT,
    result_code   TEXT,
    result_msg    TEXT,
    raw_payload   TEXT,
    received_at   TEXT DEFAULT (datetime('now', '+9 hours'))
  );
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_noti_moid ON payment_notis(moid)`); } catch(e) {}

// 환불 기록
db.exec(`
  CREATE TABLE IF NOT EXISTS refunds (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id INTEGER,
    moid          TEXT,
    amount        INTEGER,
    reason        TEXT,
    result_code   TEXT,
    result_msg    TEXT,
    refunded_at   TEXT DEFAULT (datetime('now', '+9 hours')),
    refunded_by   TEXT,
    FOREIGN KEY(subscriber_id) REFERENCES subscribers(id)
  );
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_refund_sub ON refunds(subscriber_id)`); } catch(e) {}

// 스케줄러 단독 실행 lock (동시 실행 방지)
db.exec(`
  CREATE TABLE IF NOT EXISTS scheduler_locks (
    name       TEXT PRIMARY KEY,
    locked_at  TEXT,
    pid        INTEGER
  );
`);

// 인덱스
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sub_phone ON subscribers(phone)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sub_status_date ON subscribers(status, next_billing_date)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_log_subscriber ON billing_logs(subscriber_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_log_moid ON billing_logs(moid)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_session_token ON sessions(token)`); } catch(e) {}

module.exports = db;
