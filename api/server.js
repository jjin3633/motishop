const cfg = require('./config');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { scheduleBilling } = require('./scheduler');
const { deleteBillKey, notifySlack, refundBillKey } = require('./innopay');

// PII 마스킹 헬퍼 — 로그/Slack용 (전화 010-****-1234, 이름 양*진)
function maskPhone(p) {
  if (!p) return '';
  const s = String(p).replace(/[^0-9]/g, '');
  if (s.length < 7) return s.replace(/.(?=.{2})/g, '*');
  return s.slice(0, 3) + '-****-' + s.slice(-4);
}
function maskName(n) {
  if (!n) return '';
  const s = String(n);
  if (s.length <= 1) return s;
  if (s.length === 2) return s[0] + '*';
  return s[0] + '*'.repeat(s.length - 2) + s.slice(-1);
}

const app = express();
app.set('trust proxy', 1);  // nginx 뒤 → req.ip가 실제 클라이언트 IP

// 보안 헤더 — webhook은 contentSecurityPolicy 영향 안 받음 (JSON 응답)
app.use(helmet({
  contentSecurityPolicy: false,  // mypage/admin HTML이 inline script/style 사용 — 별도 CSP 정의 필요 시 활성화
  crossOriginEmbedderPolicy: false,
}));

// 본문 파싱 — webhook 서명 검증 위해 rawBody 캡처
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', cfg.CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-pw, x-session-token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Rate limiting — 민감 엔드포인트 보호
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15분
  max: 10,                    // IP당 15분에 10회 시도까지
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, msg: '너무 많은 시도입니다. 15분 후 다시 시도해주세요.' },
});
const subscribeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1시간
  max: 5,                     // IP당 1시간에 5회 가입까지 (봇 가입 방지)
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, msg: '가입 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.' },
});

// ── 기능 가격표 ──
const FEATURE_PRICES = {
  monthly: {
    '모아레': 23900,
    '3D 신경·림프·장기': 35900,
    '척추 세부 분석': 47900,
    '손실키 분석': 79900,
    '안면 여백/탄력': 29900,
    'ALL IN ONE': 107900,
  },
  annual: {
    '모아레': 17900,
    '3D 신경·림프·장기': 29900,
    '척추 세부 분석': 39900,
    '손실키 분석': 65900,
    '안면 여백/탄력': 23900,
    'ALL IN ONE': 89900,
  }
};

// ── 유틸 ──
// KST 기준 YYYY-MM-DD (toISOString은 항상 UTC라 사용 금지)
function kstDateOnly(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
}
// KST 기준 YYYY-MM
function kstYearMonth(d = new Date()) {
  return kstDateOnly(d).slice(0, 7);
}
// KST 기준 YYYY
function kstYear(d = new Date()) {
  return kstDateOnly(d).slice(0, 4);
}

function hashPw(pw, salt) {
  return crypto.createHmac('sha256', salt).update(pw).digest('hex');
}
function genSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── 헬스체크 (UptimeRobot 등 외부 모니터링용) ──
app.get('/api/health', (_req, res) => {
  try {
    const r = db.prepare(`SELECT 1 as ok`).get();
    res.json({ ok: true, db: r && r.ok === 1, uptime: process.uptime(), timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// ── InnoPay 결제 노티 콜백 (이중 통지 — payAutoCardBill 응답과 cross-check용) ──
// InnoPay 운영 환경에서 별도 등록 시 활성화. 보안: PG_IP 화이트리스트 + moid 매칭으로 검증
app.post('/api/innopay/noti', (req, res) => {
  const payload = req.body || {};
  try {
    db.prepare(`INSERT INTO payment_notis (moid, trans_seq, result_code, result_msg, raw_payload) VALUES (?, ?, ?, ?, ?)`)
      .run(payload.moid || '', payload.transSeq || payload.tno || '', payload.resultCode || '', payload.resultMsg || '', JSON.stringify(payload).slice(0, 4000));
    console.log(`[노티] moid=${payload.moid} code=${payload.resultCode}`);
  } catch (e) {
    console.error('[노티 저장 실패]', e.message);
  }
  // InnoPay 명세에 따라 보통 "OK" 문자열로 200 응답
  res.status(200).type('text/plain').send('OK');
});

// ── 공개 설정 (프론트가 InnoPay 호출 시 참조) ──
app.get('/api/config', (_req, res) => {
  res.json({ innopayMid: cfg.INNOPAY_MID });
});

// ── 구독 등록 ──
function genTempPw() {
  // 기억하기 쉬운 형식: 영문2자 + 숫자4자 (예: AZ8823)
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const l1 = letters[Math.floor(Math.random() * letters.length)];
  const l2 = letters[Math.floor(Math.random() * letters.length)];
  const nums = String(Math.floor(1000 + Math.random() * 9000));
  return l1 + l2 + nums;
}

// 약관 동의 기록 — 법적 분쟁 시 증거로 활용
const TERMS_VERSION = '2026-04-27';  // 약관 텍스트 변경 시 갱신
function saveTermsConsent(subscriberId, agreedKeys, req) {
  if (!subscriberId || !agreedKeys) return;
  const ip = (req.ip || req.connection?.remoteAddress || '').toString().slice(0, 64);
  const ua = (req.get('User-Agent') || '').slice(0, 256);
  const keys = Array.isArray(agreedKeys) ? agreedKeys : ['all'];
  const stmt = db.prepare(`INSERT INTO terms_consents (subscriber_id, terms_key, terms_version, ip, user_agent) VALUES (?, ?, ?, ?, ?)`);
  for (const k of keys) {
    try { stmt.run(subscriberId, String(k).slice(0, 64), TERMS_VERSION, ip, ua); } catch (e) { console.error('[약관저장 실패]', e.message); }
  }
}

app.post('/api/subscribe', subscribeLimiter, (req, res) => {
  const { company, name, phone, features, billingType, billKey, moid, amount, termsAgreed } = req.body;
  if (!company || !name || !phone || !features || !billingType || !billKey || !amount)
    return res.status(400).json({ ok: false, msg: '필수 파라미터 누락' });

  const cleanPhone = String(phone).replace(/[^0-9]/g, '');
  const trialStart = kstDateOnly();
  const firstBilling = new Date();
  firstBilling.setDate(firstBilling.getDate() + 30);
  const nextBillingDate = kstDateOnly(firstBilling);
  const chargeAmount = billingType === 'annual' ? amount * 12 : amount;

  // 동일 phone 기존 가입자 검색 → 있으면 재활성화, 없으면 신규
  const existing = db.prepare(`SELECT * FROM subscribers WHERE phone = ? ORDER BY id DESC LIMIT 1`).get(cleanPhone);

  try {
    if (existing) {
      // 재활성화 — 기존 row UPDATE, pw_hash 유지
      db.prepare(`INSERT INTO subscriber_changes
        (subscriber_id, change_type, before_features, after_features, before_billing_type, after_billing_type, before_amount, after_amount)
        VALUES (?, 'reactivate', ?, ?, ?, ?, ?, ?)`)
        .run(existing.id, existing.features, features, existing.billing_type, billingType, existing.charge_amount, chargeAmount);

      db.prepare(`UPDATE subscribers SET
        company=?, name=?, features=?, billing_type=?, bill_key=?, moid=?, charge_amount=?,
        trial_start=?, next_billing_date=?, status='trial', billkey_deleted=0, notified_7d=0, notified_1d=0
        WHERE id=?`)
        .run(company, name, features, billingType, billKey, moid, chargeAmount, trialStart, nextBillingDate, existing.id);

      saveTermsConsent(existing.id, termsAgreed, req);
      console.log(`[재가입 ✓] id=${existing.id} ${company} / ${maskName(name)} / ${billingType} / 첫 결제일: ${nextBillingDate}`);
      return res.json({ ok: true, trialStart, nextBillingDate, reactivated: true, subscriberId: existing.id });
    }

    // 신규 가입 — 임시 비밀번호 생성
    const tempPw = genTempPw();
    const salt = genSalt();
    const hash = hashPw(tempPw, salt);

    const r = db.prepare(`
      INSERT INTO subscribers
        (company, name, phone, features, billing_type, bill_key, moid, charge_amount, trial_start, next_billing_date, pw_hash, pw_salt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(company, name, cleanPhone, features, billingType, billKey, moid, chargeAmount, trialStart, nextBillingDate, hash, salt);
    saveTermsConsent(r.lastInsertRowid, termsAgreed, req);
    // ⚠️ tempPw는 임시로 응답 페이로드 + 서버 로그에 남김 (SMS 미연동 상태)
    // SMS 연동 후 제거 예정 — 운영 시 사용자가 비밀번호를 받을 수단이 SMS 외 없어짐
    console.log(`[신규 가입] id=${r.lastInsertRowid} ${company} / ${maskName(name)} / ${billingType} / 첫 결제일: ${nextBillingDate} / 임시PW: ${tempPw}`);
    res.json({ ok: true, trialStart, nextBillingDate, tempPassword: tempPw, reactivated: false, subscriberId: r.lastInsertRowid });
  } catch (e) {
    console.error('[DB 오류]', e.message);
    res.status(500).json({ ok: false, msg: 'DB 저장 실패' });
  }
});

// ── 관리자 페이지 ──
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

function adminAuth(req, res, next) {
  if (req.headers['x-admin-pw'] === cfg.ADMIN_PW) return next();
  res.status(403).json({ ok: false, msg: 'Forbidden' });
}

app.get('/api/subscribers', adminAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, company, name, phone, features, billing_type,
           charge_amount, trial_start, next_billing_date, status, created_at,
           CASE WHEN pw_hash IS NOT NULL THEN 1 ELSE 0 END as has_password
    FROM subscribers ORDER BY created_at DESC
  `).all();
  res.json(rows);
});

// 가입자 상세 — 본인 + 결제 통계 + 결제 이력 + 동일 phone 재가입 이력
app.get('/api/subscribers/:id', adminAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const sub = db.prepare(`
    SELECT id, company, name, phone, features, billing_type, charge_amount,
           trial_start, next_billing_date, status, created_at,
           billkey_deleted, notified_7d, notified_1d
    FROM subscribers WHERE id = ?
  `).get(id);
  if (!sub) return res.status(404).json({ ok: false, msg: '가입자 없음' });

  const billingLogs = db.prepare(`
    SELECT id, moid, amount, result_code, result_msg, billed_at
    FROM billing_logs WHERE subscriber_id = ?
    ORDER BY billed_at DESC
  `).all(id);

  const stats = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN result_code IN ('0000','00') THEN amount ELSE 0 END), 0) AS totalPaid,
      COUNT(CASE WHEN result_code IN ('0000','00') THEN 1 END) AS successCount,
      COUNT(CASE WHEN result_code NOT IN ('0000','00') THEN 1 END) AS failCount
    FROM billing_logs WHERE subscriber_id = ?
  `).get(id);

  const related = db.prepare(`
    SELECT id, status, billing_type, charge_amount, features, created_at, trial_start, next_billing_date
    FROM subscribers WHERE phone = ? AND id != ?
    ORDER BY id DESC
  `).all(sub.phone, id);

  // 기능/구독유형 변경 이력 (최신순)
  const changes = db.prepare(`
    SELECT id, change_type, before_features, after_features, before_billing_type, after_billing_type,
           before_amount, after_amount, changed_at
    FROM subscriber_changes WHERE subscriber_id = ?
    ORDER BY changed_at DESC
  `).all(id);

  res.json({ ok: true, subscriber: sub, billingLogs, stats, related, changes });
});

app.get('/api/revenue', adminAuth, (req, res) => {
  const thisMonth = kstYearMonth();
  const thisYear  = kstYear();

  const thisMonthTotal = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as v FROM billing_logs WHERE result_code='00' AND strftime('%Y-%m',billed_at)=?`
  ).get(thisMonth)?.v || 0;
  const thisYearTotal = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as v FROM billing_logs WHERE result_code='00' AND strftime('%Y',billed_at)=?`
  ).get(thisYear)?.v || 0;
  const allTimeTotal = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as v FROM billing_logs WHERE result_code='00'`
  ).get()?.v || 0;

  const yearly = db.prepare(`
    SELECT strftime('%Y', billed_at) as year, SUM(amount) as total, COUNT(*) as count
    FROM billing_logs WHERE result_code='00' GROUP BY year ORDER BY year DESC
  `).all();
  const monthly = db.prepare(`
    SELECT strftime('%Y-%m', billed_at) as month, SUM(amount) as total, COUNT(*) as count
    FROM billing_logs WHERE result_code='00' GROUP BY month ORDER BY month ASC
  `).all();

  const year = req.query.year || thisYear;
  const monthlyByYear = db.prepare(`
    SELECT strftime('%Y-%m', billed_at) as month, SUM(amount) as total, COUNT(*) as count
    FROM billing_logs WHERE result_code='00' AND strftime('%Y', billed_at)=?
    GROUP BY month ORDER BY month ASC
  `).all(year);

  res.json({ thisMonthTotal, thisYearTotal, allTimeTotal, yearly, monthly, monthlyByYear, selectedYear: year });
});

app.get('/api/logs', adminAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT l.*, s.company, s.name FROM billing_logs l
    JOIN subscribers s ON l.subscriber_id = s.id
    ORDER BY l.billed_at DESC LIMIT 100
  `).all();
  res.json(rows);
});

app.post('/api/cancel', adminAuth, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ ok: false });
  const sub = db.prepare(`SELECT * FROM subscribers WHERE id = ?`).get(id);
  if (!sub) return res.status(404).json({ ok: false, msg: '가입자 없음' });

  db.prepare(`UPDATE subscribers SET status = 'cancelled' WHERE id = ?`).run(id);

  // 빌키 삭제 (InnoPay) — 실패해도 해지는 유지
  let billkeyResult = { ok: false, resultMsg: 'skipped' };
  if (sub.bill_key && !sub.billkey_deleted) {
    billkeyResult = await deleteBillKey({ billKey: sub.bill_key, userId: sub.phone });
    if (billkeyResult.ok) {
      db.prepare(`UPDATE subscribers SET billkey_deleted = 1 WHERE id = ?`).run(id);
      console.log(`[빌키삭제 ✓] subscriber_id=${id} / ${sub.company}`);
    } else {
      console.error(`[빌키삭제 ✗] subscriber_id=${id} / ${billkeyResult.resultCode} ${billkeyResult.resultMsg}`);
      notifySlack(`⚠️ 빌키 삭제 실패: ${sub.company} (id=${id}, ${maskName(sub.name)}) — ${billkeyResult.resultMsg}`);
    }
  }

  res.json({ ok: true, billkeyDeleted: billkeyResult.ok });
});

// 관리자 — 환불 처리 (전자상거래법: 단순 변심 7일, 서비스 결함은 즉시)
app.post('/api/admin/refund', adminAuth, async (req, res) => {
  const { id, billingLogId, amount, reason } = req.body;
  if (!id || !billingLogId) return res.status(400).json({ ok: false, msg: '필수값 누락 (id, billingLogId)' });
  const sub = db.prepare(`SELECT * FROM subscribers WHERE id = ?`).get(id);
  if (!sub) return res.status(404).json({ ok: false, msg: '가입자 없음' });
  const log = db.prepare(`SELECT * FROM billing_logs WHERE id = ? AND subscriber_id = ?`).get(billingLogId, id);
  if (!log) return res.status(404).json({ ok: false, msg: '결제 로그 없음' });
  if (log.result_code !== '0000') return res.status(400).json({ ok: false, msg: '성공한 결제만 환불 가능' });

  const refundAmount = Number(amount) || log.amount;
  const refundReason = reason || '관리자 환불 처리';

  // InnoPay 취소 API 호출
  const { refundBillKey } = require('./innopay');
  const result = await refundBillKey({
    moid: log.moid,
    transSeq: log.trans_seq || '',
    amount: refundAmount,
    reason: refundReason,
  });

  db.prepare(`INSERT INTO refunds (subscriber_id, moid, amount, reason, result_code, result_msg, refunded_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, log.moid, refundAmount, refundReason, result.resultCode || 'ERR', result.resultMsg || '', 'admin');

  if (result.ok) {
    notifySlack(`💸 환불 처리: ${sub.company} (id=${id}) / ${refundAmount.toLocaleString()}원 — ${refundReason}`);
    return res.json({ ok: true, resultMsg: result.resultMsg });
  }
  notifySlack(`🔴 환불 실패: ${sub.company} (id=${id}) — ${result.resultCode} ${result.resultMsg}`);
  res.status(502).json({ ok: false, msg: '환불 실패', resultCode: result.resultCode, resultMsg: result.resultMsg });
});

// 관리자 — 임시 비밀번호 재발급 (시스템이 생성, 관리자는 받아서 고객에게 전달)
app.post('/api/admin/reset-password', adminAuth, (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ ok: false, msg: '필수값 누락' });
  const tempPw = genTempPw();
  const salt = genSalt();
  const hash = hashPw(tempPw, salt);
  db.prepare(`UPDATE subscribers SET pw_hash=?, pw_salt=? WHERE id=?`).run(hash, salt, id);
  console.log(`[비번재발급] subscriber_id=${id} / 임시PW: ${tempPw}`);
  res.json({ ok: true, tempPassword: tempPw });
});

// ── 마이페이지 ──
app.get('/mypage', (req, res) => res.sendFile(path.join(__dirname, 'mypage.html')));

function mypageAuth(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!token) return res.status(401).json({ ok: false, msg: '로그인 필요' });
  const now = new Date().toISOString();
  const session = db.prepare(`SELECT * FROM sessions WHERE token=? AND expires_at>?`).get(token, now);
  if (!session) return res.status(401).json({ ok: false, msg: '세션 만료' });
  req.subscriberId = session.subscriber_id;
  next();
}

app.post('/api/mypage/login', loginLimiter, (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ ok: false, msg: '전화번호와 비밀번호를 입력해주세요.' });

  // 같은 phone에 여러 row가 있을 수 있음 — 활성(trial/active) 우선, 그 다음 최신 id
  // 활성 row가 있으면 그것만으로 인증, 없으면 가장 최근 cancelled row로 시도 (재가입 유도용)
  const sub = db.prepare(`
    SELECT * FROM subscribers WHERE phone = ?
    ORDER BY
      CASE status WHEN 'trial' THEN 0 WHEN 'active' THEN 0 WHEN 'cancelled' THEN 1 ELSE 2 END,
      id DESC
    LIMIT 1
  `).get(phone.replace(/[^0-9]/g, ''));

  if (!sub) return res.status(401).json({ ok: false, msg: '등록되지 않은 전화번호입니다.' });
  if (!sub.pw_hash) return res.status(401).json({ ok: false, msg: '비밀번호가 설정되지 않았습니다. 담당자에게 문의해주세요.' });

  const hash = hashPw(password, sub.pw_salt);
  if (hash !== sub.pw_hash) return res.status(401).json({ ok: false, msg: '비밀번호가 올바르지 않습니다.' });

  // 해지 상태도 로그인 허용 — 마이페이지에서 이력 확인 + 재구독 가능
  const token = genToken();
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO sessions (subscriber_id, token, expires_at) VALUES (?, ?, ?)`).run(sub.id, token, expires);

  res.json({ ok: true, token });
});

app.get('/api/mypage/me', mypageAuth, (req, res) => {
  const sub = db.prepare(`
    SELECT id, company, name, phone, features, billing_type, charge_amount,
           trial_start, next_billing_date, status, created_at
    FROM subscribers WHERE id=?
  `).get(req.subscriberId);

  const logs = db.prepare(`
    SELECT amount, result_code, result_msg, billed_at
    FROM billing_logs WHERE subscriber_id=? ORDER BY billed_at DESC LIMIT 10
  `).all(req.subscriberId);

  res.json({ ok: true, subscriber: sub, billingLogs: logs });
});

app.post('/api/mypage/change-password', mypageAuth, (req, res) => {
  const { currentPw, newPw } = req.body;
  if (!currentPw || !newPw) return res.status(400).json({ ok: false, msg: '필수값 누락' });
  if (newPw.length < 6) return res.status(400).json({ ok: false, msg: '비밀번호는 6자 이상이어야 합니다.' });

  const sub = db.prepare(`SELECT * FROM subscribers WHERE id=?`).get(req.subscriberId);
  if (hashPw(currentPw, sub.pw_salt) !== sub.pw_hash)
    return res.status(401).json({ ok: false, msg: '현재 비밀번호가 올바르지 않습니다.' });

  const salt = genSalt();
  const hash = hashPw(newPw, salt);
  db.prepare(`UPDATE subscribers SET pw_hash=?, pw_salt=? WHERE id=?`).run(hash, salt, req.subscriberId);
  res.json({ ok: true });
});

app.post('/api/mypage/cancel', mypageAuth, async (req, res) => {
  const sub = db.prepare(`SELECT * FROM subscribers WHERE id = ?`).get(req.subscriberId);
  db.prepare(`UPDATE subscribers SET status='cancelled' WHERE id=?`).run(req.subscriberId);
  db.prepare(`DELETE FROM sessions WHERE subscriber_id=?`).run(req.subscriberId);

  // 빌키 삭제 (InnoPay)
  if (sub && sub.bill_key && !sub.billkey_deleted) {
    const r = await deleteBillKey({ billKey: sub.bill_key, userId: sub.phone });
    if (r.ok) {
      db.prepare(`UPDATE subscribers SET billkey_deleted = 1 WHERE id = ?`).run(req.subscriberId);
      console.log(`[빌키삭제 ✓ mypage] ${sub.company}`);
    } else {
      console.error(`[빌키삭제 ✗ mypage] ${sub.company} / ${r.resultMsg}`);
      notifySlack(`⚠️ 빌키 삭제 실패(셀프 해지): ${sub.company} — ${r.resultMsg}`);
    }
  }

  res.json({ ok: true });
});

// 마이페이지 재구독 — 해지된 계정이 카드 재등록 후 호출
// 정책: 무료 체험 없이 즉시 결제 (정기 결제 사이클 신규 시작)
app.post('/api/mypage/resubscribe', mypageAuth, async (req, res) => {
  const { features, billingType, billKey, moid, amount } = req.body;
  if (!features || !Array.isArray(features) || features.length === 0 || !billingType || !billKey || !amount) {
    return res.status(400).json({ ok: false, msg: '필수 파라미터 누락' });
  }
  const sub = db.prepare(`SELECT * FROM subscribers WHERE id=?`).get(req.subscriberId);
  if (!sub) return res.status(404).json({ ok: false, msg: '가입자 없음' });

  const prices = FEATURE_PRICES[billingType] || FEATURE_PRICES.monthly;
  const featStr = features.join(', ');
  const monthlyAmount = features.includes('ALL IN ONE') ? prices['ALL IN ONE'] : features.reduce((s, f) => s + (prices[f] || 0), 0);
  const chargeAmount = billingType === 'annual' ? monthlyAmount * 12 : monthlyAmount;
  if (chargeAmount !== Number(amount)) {
    return res.status(400).json({ ok: false, msg: '결제 금액 불일치' });
  }

  // 즉시 결제 시도 (재구독은 무료 체험 없음)
  const { chargeWithRetry } = require('./innopay');
  const newMoid = moid || (kstDateOnly().replace(/-/g, '') + Math.floor(1000 + Math.random() * 9000));
  const result = await chargeWithRetry({
    billKey,
    moid: newMoid,
    amount: chargeAmount,
    goodsName: '모티피지오 구독 (재구독)',
    buyerName: sub.name,
    userId: sub.phone,
  });

  const transSeq = (result.raw && (result.raw.transSeq || result.raw.tno)) || '';
  db.prepare(`INSERT INTO billing_logs (subscriber_id, moid, amount, result_code, result_msg, trans_seq) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.subscriberId, newMoid, chargeAmount, result.resultCode || 'ERR', result.resultMsg || '', transSeq);

  if (!result.ok) {
    notifySlack(`🔴 재구독 결제 실패: ${sub.company} (id=${sub.id}) — ${result.resultCode} ${result.resultMsg}`);
    return res.status(502).json({ ok: false, msg: '결제 실패: ' + (result.resultMsg || '카드 정보를 확인해주세요.'), resultCode: result.resultCode });
  }

  // 다음 결제일 = today + 1개월/1년
  const next = new Date();
  if (billingType === 'monthly') next.setMonth(next.getMonth() + 1);
  else next.setFullYear(next.getFullYear() + 1);
  const nextBilling = kstDateOnly(next);

  // 변경 이력 기록
  db.prepare(`INSERT INTO subscriber_changes
    (subscriber_id, change_type, before_features, after_features, before_billing_type, after_billing_type, before_amount, after_amount)
    VALUES (?, 'reactivate', ?, ?, ?, ?, ?, ?)`)
    .run(req.subscriberId, sub.features, featStr, sub.billing_type, billingType, sub.charge_amount, chargeAmount);

  // 가입자 정보 갱신
  db.prepare(`UPDATE subscribers SET
    features=?, billing_type=?, bill_key=?, moid=?, charge_amount=?,
    next_billing_date=?, status='active', billkey_deleted=0, notified_7d=0, notified_1d=0
    WHERE id=?`).run(featStr, billingType, billKey, newMoid, chargeAmount, nextBilling, req.subscriberId);

  console.log(`[재구독 ✓] ${sub.company} / ${featStr} / ${chargeAmount}원 / 다음: ${nextBilling}`);
  notifySlack(`🔁 재구독: ${sub.company} (id=${sub.id}) / ${chargeAmount.toLocaleString()}원 / 다음: ${nextBilling}`);
  res.json({ ok: true, charge_amount: chargeAmount, next_billing_date: nextBilling });
});

// 기능 추가/해지
app.post('/api/mypage/update-features', mypageAuth, (req, res) => {
  const { features } = req.body;
  if (!features || !Array.isArray(features) || features.length === 0)
    return res.status(400).json({ ok: false, msg: '기능을 하나 이상 선택해주세요.' });

  const sub = db.prepare(`SELECT * FROM subscribers WHERE id=?`).get(req.subscriberId);
  const prices = FEATURE_PRICES[sub.billing_type] || FEATURE_PRICES.monthly;

  let newAmount;
  if (features.includes('ALL IN ONE')) {
    newAmount = prices['ALL IN ONE'];
  } else {
    newAmount = features.reduce((sum, f) => sum + (prices[f] || 0), 0);
  }

  const featStr = features.join(', ');
  // 변경 이력 기록 (실제 변경된 경우에만)
  if (sub.features !== featStr || sub.charge_amount !== newAmount) {
    db.prepare(`INSERT INTO subscriber_changes
      (subscriber_id, change_type, before_features, after_features, before_amount, after_amount)
      VALUES (?, 'features', ?, ?, ?, ?)`).run(req.subscriberId, sub.features, featStr, sub.charge_amount, newAmount);
  }

  db.prepare(`UPDATE subscribers SET features=?, charge_amount=? WHERE id=?`)
    .run(featStr, newAmount, req.subscriberId);

  console.log(`[기능변경] ${sub.company} → ${featStr} / ${newAmount}원`);
  res.json({ ok: true, features: featStr, charge_amount: newAmount });
});

// 구독 유형 변경 (월↔연)
app.post('/api/mypage/change-billing-type', mypageAuth, (req, res) => {
  const { billingType } = req.body;
  if (billingType !== 'monthly' && billingType !== 'annual')
    return res.status(400).json({ ok: false, msg: '잘못된 구독 유형입니다.' });

  const sub = db.prepare(`SELECT * FROM subscribers WHERE id=?`).get(req.subscriberId);
  const prices = FEATURE_PRICES[billingType];
  const features = (sub.features || '').split(',').map(f => f.trim()).filter(Boolean);

  let newAmount;
  if (features.includes('ALL IN ONE')) {
    newAmount = prices['ALL IN ONE'];
  } else {
    newAmount = features.reduce((sum, f) => sum + (prices[f] || 0), 0);
  }

  // 변경 이력 기록
  if (sub.billing_type !== billingType || sub.charge_amount !== newAmount) {
    db.prepare(`INSERT INTO subscriber_changes
      (subscriber_id, change_type, before_billing_type, after_billing_type, before_amount, after_amount)
      VALUES (?, 'billing_type', ?, ?, ?, ?)`).run(req.subscriberId, sub.billing_type, billingType, sub.charge_amount, newAmount);
  }

  db.prepare(`UPDATE subscribers SET billing_type=?, charge_amount=? WHERE id=?`)
    .run(billingType, newAmount, req.subscriberId);

  console.log(`[구독유형변경] ${sub.company} → ${billingType} / ${newAmount}원`);
  res.json({ ok: true, billing_type: billingType, charge_amount: newAmount });
});

// ── GitHub Webhook (자동 배포) ──
app.post('/api/deploy/webhook', (req, res) => {
  if (!cfg.GITHUB_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'webhook disabled' });
  }
  const sig = req.header('X-Hub-Signature-256') || '';
  const expected = 'sha256=' + crypto
    .createHmac('sha256', cfg.GITHUB_WEBHOOK_SECRET)
    .update(req.rawBody || Buffer.alloc(0))
    .digest('hex');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    console.warn('[webhook] 서명 불일치');
    return res.status(401).json({ error: 'invalid signature' });
  }

  const event = req.header('X-GitHub-Event');
  if (event === 'ping') return res.json({ ok: true, pong: true });
  if (event !== 'push') return res.json({ skipped: `event: ${event}` });

  const ref = req.body && req.body.ref;
  if (ref !== 'refs/heads/main') {
    return res.json({ skipped: `ref: ${ref}` });
  }

  const headCommit = ((req.body.head_commit && req.body.head_commit.id) || '').slice(0, 7);
  console.log(`[webhook] 배포 트리거 ${headCommit}`);

  const { spawn } = require('child_process');
  let child;
  try {
    child = spawn(cfg.DEPLOY_SCRIPT_PATH, [], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, COMMIT: headCommit },
    });
    child.on('error', (e) => {
      console.error('[webhook] spawn 에러:', e.message);
      notifySlack(`🔴 배포 spawn 실패: ${headCommit} / ${e.message}`);
    });
    child.unref();
  } catch (e) {
    console.error('[webhook] spawn 동기 예외:', e.message);
    return res.status(500).json({ error: 'spawn failed', detail: e.message });
  }

  notifySlack(`🚀 자동 배포 시작: ${headCommit}`);
  res.json({ ok: true, deploying: true, commit: headCommit });
});

scheduleBilling();

app.listen(3001, '127.0.0.1', () => {
  console.log(`MotiShop API listening on port 3001 (MID=${cfg.INNOPAY_MID}, CORS=${cfg.CORS_ORIGIN})`);
});
