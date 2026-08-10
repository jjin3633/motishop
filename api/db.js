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
// cycle_date: 정기 결제 사이클 식별자 (sub.next_billing_date 시점) — 멱등성 키
// scheduler.chargeSubscriber만 채움. 재가입·일할 결제 등은 NULL (cycle 아님)
try { db.exec(`ALTER TABLE billing_logs ADD COLUMN cycle_date TEXT`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_billing_cycle ON billing_logs(subscriber_id, cycle_date)`); } catch(e) {}
try { db.exec(`ALTER TABLE subscribers ADD COLUMN email TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE subscribers ADD COLUMN business_number TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE subscribers ADD COLUMN cancelled_at TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE subscribers ADD COLUMN failed_count INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE subscribers ADD COLUMN last_failed_at TEXT`); } catch(e) {}
// 익명화 시각 — 해지 30일 후 개인정보 마스킹 처리된 시점 (2026-07-13 정책 변경)
// 완전 삭제 대신 마스킹으로 이력·감사 데이터 보존 + 개인정보보호법 준수
try { db.exec(`ALTER TABLE subscribers ADD COLUMN anonymized_at TEXT`); } catch(e) {}
// phone HMAC-SHA256 (2026-08-05 정책 — 익명화 후 재가입 판별용, 무료체험 loophole 방어)
try { db.exec(`ALTER TABLE subscribers ADD COLUMN phone_hash TEXT`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sub_phone_hash ON subscribers(phone_hash)`); } catch(e) {}

// 쿠폰 테이블 (2026-08-10 — From The Ground 01~100 사전 발급)
db.exec(`
  CREATE TABLE IF NOT EXISTS coupons (
    code       TEXT PRIMARY KEY,
    used       INTEGER DEFAULT 0,
    used_at    TEXT,
    used_by_id INTEGER,
    created_at TEXT DEFAULT (datetime('now', '+9 hours'))
  );
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_coupons_used ON coupons(used)`); } catch(e) {}

// 서버 시작 시 100개 코드 자동 등록 (idempotent · INSERT OR IGNORE)
try {
  const { COUPON_CODES } = require('./coupons');
  const stmt = db.prepare(`INSERT OR IGNORE INTO coupons (code) VALUES (?)`);
  const tx = db.transaction(() => {
    COUPON_CODES.forEach(c => stmt.run(c));
  });
  tx();
} catch (e) {
  console.warn('[db] 쿠폰 초기화 실패:', e.message);
}

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

// 기능 활성화 SMS 이력 (운영자 누가 언제 어떤 회원에게 보냈는지 — subscribers 무관, 신규 테이블만 INSERT)
db.exec(`
  CREATE TABLE IF NOT EXISTS activation_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id   INTEGER NOT NULL,
    operator_name   TEXT NOT NULL,
    sent_at         TEXT DEFAULT (datetime('now', '+9 hours')),
    sms_result_code TEXT,
    sms_result_msg  TEXT,
    FOREIGN KEY(subscriber_id) REFERENCES subscribers(id)
  );
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_activation_sub ON activation_logs(subscriber_id)`); } catch(e) {}

// 운영자 메모 (어드민 모달에서 가입자별 자유 메모 — subscribers 무관, 신규 테이블만 INSERT/SELECT)
db.exec(`
  CREATE TABLE IF NOT EXISTS subscriber_memos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id INTEGER NOT NULL,
    operator_name TEXT NOT NULL,
    content       TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now', '+9 hours')),
    deleted_at    TEXT,
    deleted_by    TEXT,
    FOREIGN KEY(subscriber_id) REFERENCES subscribers(id)
  );
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_memo_sub ON subscriber_memos(subscriber_id)`); } catch(e) {}

// 스케줄러 단독 실행 lock (동시 실행 방지)
db.exec(`
  CREATE TABLE IF NOT EXISTS scheduler_locks (
    name       TEXT PRIMARY KEY,
    locked_at  TEXT,
    pid        INTEGER
  );
`);

// 인덱스 — phone은 race 방지 위해 UNIQUE
// 중복 phone row가 이미 있으면 UNIQUE 인덱스 생성 실패 → 마이그레이션에서 정리 후 재시도
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_phone ON subscribers(phone)`); } catch (e) {
  console.warn('[migration] phone UNIQUE 생성 실패 — 중복 phone 정리 후 재시도:', e.message);
  // 중복 phone이 있으면 active 우선, 없으면 최신 id 보존, 나머지는 cancelled로 표시
  try {
    const dups = db.prepare(`
      SELECT phone FROM subscribers GROUP BY phone HAVING COUNT(*) > 1
    `).all();
    for (const { phone } of dups) {
      const rows = db.prepare(`
        SELECT id, status FROM subscribers WHERE phone = ?
        ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'trial' THEN 1 WHEN 'cancelled' THEN 2 ELSE 3 END, id DESC
      `).all(phone);
      const keep = rows[0].id;
      const drop = rows.slice(1).map(r => r.id);
      // 중복 row의 종속 테이블도 정리
      const tables = ['sessions', 'billing_logs', 'subscriber_changes', 'terms_consents', 'refunds'];
      for (const id of drop) {
        for (const t of tables) {
          try { db.prepare(`DELETE FROM ${t} WHERE subscriber_id = ?`).run(id); } catch (_) {}
        }
        db.prepare(`DELETE FROM subscribers WHERE id = ?`).run(id);
      }
      console.log(`[migration] phone=${phone.slice(0,3)}-****-${phone.slice(-4)} 중복 정리: keep id=${keep}, removed ${drop.length}건`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_phone ON subscribers(phone)`);
    console.log('[migration] phone UNIQUE 인덱스 재생성 성공');
  } catch (e2) {
    console.error('[migration] phone UNIQUE 마이그레이션 실패:', e2.message);
  }
}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sub_status_date ON subscribers(status, next_billing_date)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_log_subscriber ON billing_logs(subscriber_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_log_moid ON billing_logs(moid)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_session_token ON sessions(token)`); } catch(e) {}

// 데이터 마이그레이션 — 안면 기능 명칭 통일 (2026-04-30)
// LIKE 매칭 안 되면 0건 처리 → idempotent (다음 재시작 시 NoOp)
try {
  const r = db.prepare(
    `UPDATE subscribers SET features = REPLACE(features, '안면 여백/탄력', '안면 비대칭·여백·탄력')
     WHERE features LIKE '%안면 여백/탄력%'`
  ).run();
  if (r.changes > 0) console.log(`[migration] 안면 기능 명칭 통일: ${r.changes}건 업데이트`);
} catch (e) { console.error('[migration 안면키] 실패:', e.message); }

// cancelled_at 백필 (2026-05-06) — 컬럼 추가 전에 해지된 row의 cancelled_at NULL을 NOW로 채움
// 효과: admin "해지일시 / 자동탈퇴 예정" 행 정상 표시 + 30일 자동탈퇴 cron 정상 작동
try {
  const r = db.prepare(
    `UPDATE subscribers SET cancelled_at = datetime('now', '+9 hours')
     WHERE status = 'cancelled' AND cancelled_at IS NULL`
  ).run();
  if (r.changes > 0) console.log(`[migration] cancelled_at 백필: ${r.changes}건`);
} catch (e) { console.error('[migration cancelled_at 백필] 실패:', e.message); }

// 테스트 가입자 정리 (2026-05-06) — 사용자 지정
// 종속 테이블(billing_logs / sessions / 등)까지 cascade 삭제. 0건이면 NoOp (idempotent)
try {
  const TEST_COMPANIES = [
    '모티 필라테스 강남점',
    '바디밸런스 체형교정센터',
    '필라테스 하우스 홍대',
    '코어핏 재활센터',
  ];
  const placeholders = TEST_COMPANIES.map(() => '?').join(',');
  const targets = db.prepare(
    `SELECT id, company FROM subscribers WHERE company IN (${placeholders})`
  ).all(...TEST_COMPANIES);

  if (targets.length > 0) {
    const childTables = ['sessions', 'billing_logs', 'subscriber_changes', 'terms_consents', 'refunds', 'payment_notis'];
    const tx = db.transaction((rows) => {
      for (const r of rows) {
        for (const t of childTables) {
          try { db.prepare(`DELETE FROM ${t} WHERE subscriber_id=?`).run(r.id); } catch (e) { /* 컬럼 없을 수 있음 */ }
        }
        db.prepare(`DELETE FROM subscribers WHERE id=?`).run(r.id);
      }
    });
    tx(targets);
    const summary = targets.map(t => `${t.company}(id=${t.id})`).join(', ');
    console.log(`[migration] 테스트 가입자 ${targets.length}건 삭제: ${summary}`);
  }
} catch (e) { console.error('[migration 테스트가입자 삭제] 실패:', e.message); }

// 운영 오픈 정리 마이그레이션은 2026-05-06 1회 실행 후 영구 제거 (실수로 재발 방지)
// 결과: 1건 삭제 (풀림스킨앤바디 id=9). 이후 가입자는 절대 삭제하지 않음.

// ── 자체 분석(Analytics) 테이블 — 2026-06-18 추가 ──
// 운영 데이터(subscribers, billing_logs 등) 와 격리됨. FK 없음. 안전.
db.exec(`
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    page_path TEXT NOT NULL,
    referer TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    user_agent TEXT,
    ip_hash TEXT,
    visited_at TEXT NOT NULL,
    scroll_max INTEGER DEFAULT 0,
    dwell_seconds INTEGER DEFAULT 0,
    exited_at TEXT
  );
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_visits_session ON visits(session_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_visits_path ON visits(page_path)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_visits_at ON visits(visited_at)`); } catch(e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    event_name TEXT NOT NULL,
    event_props TEXT,
    page_path TEXT,
    occurred_at TEXT NOT NULL
  );
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_events_name ON events(event_name)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_events_at ON events(occurred_at)`); } catch(e) {}

module.exports = db;
