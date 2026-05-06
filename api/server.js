const cfg = require('./config');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { scheduleBilling, scheduleHealthCheck, scheduleAutoDelete, scheduleSolapiBalance } = require('./scheduler');
const { deleteBillKey, notifySlack, refundBillKey } = require('./innopay');
const { sendSMS } = require('./sms');

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
function maskBiz(b) {
  if (!b) return '';
  const s = String(b).replace(/[^0-9]/g, '');
  if (s.length !== 10) return '*'.repeat(s.length);
  return s.slice(0, 3) + '-**-*****';
}

const app = express();
app.set('trust proxy', 1);  // nginx 뒤 → req.ip가 실제 클라이언트 IP

// 보안 헤더 — webhook은 contentSecurityPolicy 영향 안 받음 (JSON 응답)
// HSTS: 1년 + includeSubDomains + preload (HTTPS 강제, MITM 방어)
// nginx에서 80→443 redirect 별도 필요 (운영 시 확인)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

// 본문 파싱 — webhook 서명 검증 위해 rawBody 캡처
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// CORS — CORS_ORIGIN 외 도메인 차단
// CSRF: 모든 인증이 커스텀 헤더(x-session-token / x-admin-pw) 기반 + CORS preflight 필수
//   → 외부 도메인 form/img submit으론 헤더 자동 첨부 안 됨 → CSRF 자연 보호
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
// 결제 발생·카드 등록 액션 — 가입과 동급 보호 (재구독·카드갱신 abuse 방지)
const paymentActionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, msg: '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.' },
});

// ── 기능 가격표 ──
const FEATURE_PRICES = {
  monthly: {
    '모아레': 23900,
    '3D 신경·림프·장기': 35900,
    '척추 세부 분석': 47900,
    '손실키 분석': 79900,
    '안면 비대칭·여백·탄력': 29900,
    'ALL IN ONE': 107900,
  },
  annual: {
    '모아레': 17900,
    '3D 신경·림프·장기': 29900,
    '척추 세부 분석': 39900,
    '손실키 분석': 65900,
    '안면 비대칭·여백·탄력': 23900,
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
  const { company, name, phone, businessNumber, features, billingType, billKey, moid, amount, termsAgreed } = req.body;
  if (!company || !name || !phone || !features || !billingType || !billKey || !amount)
    return res.status(400).json({ ok: false, msg: '필수 파라미터 누락' });
  if (!['monthly', 'annual'].includes(billingType))
    return res.status(400).json({ ok: false, msg: 'billingType은 monthly 또는 annual' });
  const cleanBizNum = (businessNumber && /^\d{10}$/.test(String(businessNumber))) ? String(businessNumber) : null;

  // 약관 동의 서버 검증 (정보통신망법·전자상거래법 — 분쟁 시 증거 보호)
  const REQUIRED_TERMS = ['모티샵서비스이용약관', '전자금융거래기본약관', '자동결제이용약관', '개인정보수집이용', '개인정보제3자제공'];
  if (!Array.isArray(termsAgreed) || REQUIRED_TERMS.some(k => !termsAgreed.includes(k))) {
    notifySlack(`🔴 약관 동의 누락 가입 시도: ${company} (${maskPhone(String(phone).replace(/[^0-9]/g, ''))}) — 차단됨`);
    return res.status(400).json({ ok: false, msg: '필수 약관 동의가 누락되었습니다.' });
  }

  // 보안: 클라이언트 amount 그대로 신뢰 X — 서버 가격표로 재계산 후 일치 검증
  const featList = String(features).split(',').map(f => f.trim()).filter(Boolean);
  const prices = FEATURE_PRICES[billingType];
  // 가격표 sync 검증 — 알 수 없는 키면 차단 (#15)
  const unknownFeats = featList.filter(f => f !== 'ALL IN ONE' && !(f in prices));
  if (unknownFeats.length > 0) {
    notifySlack(`🔴 알 수 없는 기능 키(가입): ${unknownFeats.join(', ')} (${maskPhone(String(phone).replace(/[^0-9]/g, ''))})`);
    return res.status(400).json({ ok: false, msg: `알 수 없는 기능: ${unknownFeats.join(', ')}` });
  }
  const monthlyAmount = featList.includes('ALL IN ONE')
    ? prices['ALL IN ONE']
    : featList.reduce((s, f) => s + prices[f], 0);
  if (monthlyAmount <= 0) {
    return res.status(400).json({ ok: false, msg: '유효하지 않은 기능 선택' });
  }
  if (Number(amount) !== monthlyAmount) {
    return res.status(400).json({ ok: false, msg: '결제 금액 불일치 (서버 검증 실패)' });
  }

  const cleanPhone = String(phone).replace(/[^0-9]/g, '');
  const trialStart = kstDateOnly();
  const firstBilling = new Date();
  firstBilling.setDate(firstBilling.getDate() + 30);
  const nextBillingDate = kstDateOnly(firstBilling);
  const chargeAmount = billingType === 'annual' ? monthlyAmount * 12 : monthlyAmount;

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
        company=?, name=?, business_number=?, features=?, billing_type=?, bill_key=?, moid=?, charge_amount=?,
        trial_start=?, next_billing_date=?, status='trial', billkey_deleted=0, notified_7d=0, notified_1d=0, cancelled_at=NULL
        WHERE id=?`)
        .run(company, name, cleanBizNum, features, billingType, billKey, moid, chargeAmount, trialStart, nextBillingDate, existing.id);

      saveTermsConsent(existing.id, termsAgreed, req);
      console.log(`[재가입 ✓] id=${existing.id} ${company} / ${maskName(name)} / ${billingType} / 첫 결제일: ${nextBillingDate}`);
      return res.json({ ok: true, trialStart, nextBillingDate, reactivated: true, subscriberId: existing.id });
    }

    // 신규 가입 — 임시 비밀번호 생성
    const tempPw = genTempPw();
    const salt = genSalt();
    const hash = hashPw(tempPw, salt);

    // INSERT OR IGNORE — 더블클릭 등 race로 동시 INSERT가 들어와도 phone UNIQUE 제약에 의해 한 건만 통과
    const r = db.prepare(`
      INSERT OR IGNORE INTO subscribers
        (company, name, phone, business_number, features, billing_type, bill_key, moid, charge_amount, trial_start, next_billing_date, pw_hash, pw_salt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(company, name, cleanPhone, cleanBizNum, features, billingType, billKey, moid, chargeAmount, trialStart, nextBillingDate, hash, salt);

    if (r.changes === 0) {
      // 동시 race로 다른 요청이 먼저 INSERT 함 — 그 row 반환 (멱등 응답)
      const dup = db.prepare(`SELECT id FROM subscribers WHERE phone = ?`).get(cleanPhone);
      console.log(`[가입 race 차단] phone=${maskPhone(cleanPhone)} → 기존 id=${dup?.id} 반환`);
      return res.json({ ok: true, trialStart, nextBillingDate, reactivated: false, subscriberId: dup?.id, raceBlocked: true });
    }

    saveTermsConsent(r.lastInsertRowid, termsAgreed, req);
    console.log(`[신규 가입] id=${r.lastInsertRowid} ${company} / ${maskName(name)} / ${billingType} / 첫 결제일: ${nextBillingDate}`);

    // 임시 비밀번호 SMS 발송 (솔라피)
    const smsText = `[Moti Shop] ${company} ${name}님, 가입을 환영해요.\n\n마이페이지 로그인 정보 안내드립니다.\n- 아이디: ${cleanPhone}\n- 임시 비밀번호: ${tempPw}\n\n로그인 후 비밀번호를 변경하고, 마이페이지에서 구독 중인 기능을 확인해보세요!\nhttps://shop.motiphysio.com/mypage`;
    sendSMS({ to: cleanPhone, text: smsText, subject: '[Moti Shop] 가입 환영 · 임시 비밀번호 안내' }).then(r => {
      if (!r.ok) notifySlack(`⚠️ 임시비번 SMS 실패: ${company} (${maskPhone(cleanPhone)}) — ${r.resultCode} ${r.resultMsg}`);
    }).catch(e => console.error('[SMS 발송 실패]', e.message));

    res.json({ ok: true, trialStart, nextBillingDate, reactivated: false, subscriberId: r.lastInsertRowid });
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
    SELECT id, company, name, phone, business_number, features, billing_type, charge_amount,
           trial_start, next_billing_date, status, created_at, cancelled_at,
           billkey_deleted, notified_7d, notified_1d, failed_count, last_failed_at
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
    `SELECT COALESCE(SUM(amount),0) as v FROM billing_logs WHERE result_code IN ('0000','00') AND strftime('%Y-%m',billed_at)=?`
  ).get(thisMonth)?.v || 0;
  const thisYearTotal = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as v FROM billing_logs WHERE result_code IN ('0000','00') AND strftime('%Y',billed_at)=?`
  ).get(thisYear)?.v || 0;
  const allTimeTotal = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as v FROM billing_logs WHERE result_code IN ('0000','00')`
  ).get()?.v || 0;

  const yearly = db.prepare(`
    SELECT strftime('%Y', billed_at) as year, SUM(amount) as total, COUNT(*) as count
    FROM billing_logs WHERE result_code IN ('0000','00') GROUP BY year ORDER BY year DESC
  `).all();
  const monthly = db.prepare(`
    SELECT strftime('%Y-%m', billed_at) as month, SUM(amount) as total, COUNT(*) as count
    FROM billing_logs WHERE result_code IN ('0000','00') GROUP BY month ORDER BY month ASC
  `).all();

  const year = req.query.year || thisYear;
  const monthlyByYear = db.prepare(`
    SELECT strftime('%Y-%m', billed_at) as month, SUM(amount) as total, COUNT(*) as count
    FROM billing_logs WHERE result_code IN ('0000','00') AND strftime('%Y', billed_at)=?
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

  db.prepare(`UPDATE subscribers SET status = 'cancelled', cancelled_at = datetime('now', '+9 hours') WHERE id = ?`).run(id);
  notifySlack(`👋 해지(관리자): ${sub.company} (id=${id}, ${maskName(sub.name)}) — ${(sub.charge_amount||0).toLocaleString()}원/${sub.billing_type}`);

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
  if (!['0000','00'].includes(log.result_code)) return res.status(400).json({ ok: false, msg: '성공한 결제만 환불 가능' });

  // 이미 환불된 금액 합계 (InnoPay 성공코드 '2001' 만 카운트)
  const alreadyRefunded = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as v FROM refunds WHERE moid = ? AND subscriber_id = ? AND result_code = '2001'`
  ).get(log.moid, id).v || 0;
  const remaining = Number(log.amount) - Number(alreadyRefunded);
  if (remaining <= 0) {
    return res.status(400).json({ ok: false, msg: '이미 전액 환불 완료된 결제입니다.' });
  }

  // PENDING 환불 차단 (#11) — 이전 환불 요청이 timeout/ERR로 응답 미확인 상태면 차단
  // (실제 PG에서 환불됐을 가능성 있어서 운영자가 명시적으로 InnoPay 콘솔 확인 후 처리해야 함)
  const pending = db.prepare(
    `SELECT id, refunded_at, result_msg FROM refunds WHERE moid = ? AND subscriber_id = ? AND result_code = 'PENDING' ORDER BY id DESC LIMIT 1`
  ).get(log.moid, id);
  if (pending) {
    return res.status(409).json({
      ok: false,
      msg: `이전 환불 요청 응답 미확인 상태입니다. InnoPay 콘솔에서 거래 상태(${(pending.refunded_at||'').slice(0,16)}) 확인 후 운영자에게 문의하세요.`,
      pendingRefundId: pending.id,
    });
  }

  // amount 가드 — 미지정·0·NaN·음수면 전액(잔여), 잔여 초과 시 차단
  let refundAmount = Number(amount);
  if (!Number.isFinite(refundAmount) || refundAmount <= 0) refundAmount = remaining;
  if (refundAmount > remaining) {
    return res.status(400).json({ ok: false, msg: `환불 가능 잔여액 초과 (잔여 ${remaining.toLocaleString()}원)` });
  }

  const refundReason = reason || '관리자 환불 처리';

  // InnoPay 통합취소 API 호출 (cancelApi)
  const { refundBillKey } = require('./innopay');
  const isPartial = refundAmount < Number(log.amount);
  const result = await refundBillKey({
    tid: log.trans_seq || '',
    amount: refundAmount,
    reason: refundReason,
    partial: isPartial,
  });

  if (result.ok) {
    db.prepare(`INSERT INTO refunds (subscriber_id, moid, amount, reason, result_code, result_msg, refunded_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, log.moid, refundAmount, refundReason, result.resultCode, result.resultMsg || '', 'admin');
    notifySlack(`💸 환불 처리: ${sub.company} (id=${id}) / ${refundAmount.toLocaleString()}원 — ${refundReason}`);
    // 회원에게 환불 통보 SMS
    const refundText = `[Moti Shop] ${sub.company}님, ${refundAmount.toLocaleString()}원 환불 처리되었어요.\n카드사 정책에 따라 영업일 기준 3~7일 후 입금됩니다.\n문의: 070-4365-7740`;
    sendSMS({ to: sub.phone, text: refundText, subject: '[Moti Shop] 환불 처리 완료' }).catch(e => console.error('[환불 SMS 실패]', e.message));
    return res.json({ ok: true, resultMsg: result.resultMsg, refundedAmount: refundAmount, totalRefunded: alreadyRefunded + refundAmount });
  }

  // 환불 timeout/네트워크 오류 (#11) — PG 측 실제 상태 알 수 없음 → PENDING 보존, 같은 결제 추가 환불 시도 차단
  const isUnknownState = !result.resultCode || result.resultCode === 'ERR' || String(result.resultCode).startsWith('HTTP_');
  if (isUnknownState) {
    db.prepare(`INSERT INTO refunds (subscriber_id, moid, amount, reason, result_code, result_msg, refunded_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, log.moid, refundAmount, refundReason, 'PENDING', `${result.resultCode || 'NO_CODE'}: ${result.resultMsg || 'timeout/network'}`, 'admin');
    notifySlack(`⚠️ 환불 응답 미확인 (PENDING): ${sub.company} (id=${id}) / ${refundAmount.toLocaleString()}원 — InnoPay 콘솔 확인 필요. ${result.resultCode || ''} ${result.resultMsg || ''}`);
    return res.status(202).json({
      ok: false, pending: true,
      msg: '환불 요청 응답을 받지 못했습니다. InnoPay 콘솔에서 실제 처리 여부 확인 후 운영자에게 문의해주세요.',
      resultCode: result.resultCode, resultMsg: result.resultMsg,
    });
  }

  // 명시적 실패 (PG가 reason 알려준 경우) — 재시도 가능
  notifySlack(`🔴 환불 실패: ${sub.company} (id=${id}) — ${result.resultCode} ${result.resultMsg}`);
  res.status(502).json({ ok: false, msg: '환불 실패', resultCode: result.resultCode, resultMsg: result.resultMsg });
});

// 관리자 — 회원 정보 수정 (사업자번호, 회원 유형 전환)
app.post('/api/admin/update-info', adminAuth, (req, res) => {
  const { id, businessNumber, ownerType } = req.body;
  if (!id || !ownerType) return res.status(400).json({ ok: false, msg: '필수값 누락 (id, ownerType)' });
  if (!['personal', 'business'].includes(ownerType)) return res.status(400).json({ ok: false, msg: 'ownerType은 personal 또는 business' });

  const sub = db.prepare(`SELECT id, business_number FROM subscribers WHERE id=?`).get(id);
  if (!sub) return res.status(404).json({ ok: false, msg: '가입자 없음' });

  let cleanBiz = null;

  if (ownerType === 'business') {
    if (!businessNumber || !/^\d{10}$/.test(String(businessNumber))) {
      return res.status(400).json({ ok: false, msg: '사업자번호는 10자리 숫자여야 합니다.' });
    }
    cleanBiz = String(businessNumber);
  }

  db.prepare(`UPDATE subscribers SET business_number=? WHERE id=?`)
    .run(cleanBiz, id);

  console.log(`[정보수정] id=${id} / ${ownerType} / biz=${cleanBiz ? maskBiz(cleanBiz) : '-'}`);
  res.json({ ok: true, business_number: cleanBiz, ownerType });
});

// 관리자 — 임시 비밀번호 재발급 (시스템이 생성, 관리자는 받아서 고객에게 전달)
app.post('/api/admin/reset-password', adminAuth, (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ ok: false, msg: '필수값 누락' });
  const sub = db.prepare(`SELECT id, company, name, phone FROM subscribers WHERE id=?`).get(id);
  if (!sub) return res.status(404).json({ ok: false, msg: '가입자 없음' });

  const tempPw = genTempPw();
  const salt = genSalt();
  const hash = hashPw(tempPw, salt);
  db.prepare(`UPDATE subscribers SET pw_hash=?, pw_salt=? WHERE id=?`).run(hash, salt, id);
  // 보안: 비번 재발급 시 기존 모든 세션 무효화 (이전 로그인 세션 사용 불가)
  db.prepare(`DELETE FROM sessions WHERE subscriber_id=?`).run(id);
  console.log(`[비번재발급] subscriber_id=${id} / ${sub.company}`);

  // SMS 발송
  const smsText = `[Moti Shop] ${sub.company} ${sub.name}님, 마이페이지 임시 비밀번호가 재발급되었어요.\n\n- 새 임시 비밀번호: ${tempPw}\n\n마이페이지에서 로그인 후 비밀번호 변경 부탁드려요.\nhttps://shop.motiphysio.com/mypage`;
  sendSMS({ to: sub.phone, text: smsText, subject: '[Moti Shop] 임시 비밀번호 재발급' }).then(r => {
    if (!r.ok) notifySlack(`⚠️ 비번재발급 SMS 실패: ${sub.company} (id=${id}) — ${r.resultCode} ${r.resultMsg}`);
  }).catch(e => console.error('[SMS 발송 실패]', e.message));

  res.json({ ok: true, tempPassword: tempPw, smsSent: true });
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

  // 보안: 계정 enumeration 방지 — 전화번호/비번 어느쪽이 틀렸는지 노출 X
  const AUTH_FAIL_MSG = '전화번호 또는 비밀번호가 올바르지 않습니다.';
  if (!sub) return res.status(401).json({ ok: false, msg: AUTH_FAIL_MSG });
  if (!sub.pw_hash) return res.status(401).json({ ok: false, msg: '비밀번호가 설정되지 않았습니다. 고객센터(070-4365-7740)로 문의해주세요.' });

  const hash = hashPw(password, sub.pw_salt);
  if (hash !== sub.pw_hash) return res.status(401).json({ ok: false, msg: AUTH_FAIL_MSG });

  // 해지 상태도 로그인 허용 — 마이페이지에서 이력 확인 + 재구독 가능
  const token = genToken();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();  // B2B: 30일 (의사가 매주 안 봐도 OK)
  db.prepare(`INSERT INTO sessions (subscriber_id, token, expires_at) VALUES (?, ?, ?)`).run(sub.id, token, expires);

  res.json({ ok: true, token });
});

app.get('/api/mypage/me', mypageAuth, (req, res) => {
  const sub = db.prepare(`
    SELECT id, company, name, phone, business_number, features, billing_type, charge_amount,
           trial_start, next_billing_date, status, created_at, cancelled_at
    FROM subscribers WHERE id=?
  `).get(req.subscriberId);

  // 결제 내역 + 환불 정보 LEFT JOIN (InnoPay 환불 성공 코드 = '2001')
  const logs = db.prepare(`
    SELECT l.id, l.moid, l.amount, l.result_code, l.result_msg, l.billed_at,
           COALESCE(SUM(CASE WHEN r.result_code='2001' THEN r.amount ELSE 0 END), 0) as refunded_amount,
           MAX(CASE WHEN r.result_code='2001' THEN r.refunded_at ELSE NULL END) as last_refunded_at
    FROM billing_logs l
    LEFT JOIN refunds r ON r.moid = l.moid
    WHERE l.subscriber_id = ?
    GROUP BY l.id
    ORDER BY l.billed_at DESC LIMIT 10
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
  const newToken = req.headers['x-session-token'];
  db.prepare(`UPDATE subscribers SET pw_hash=?, pw_salt=? WHERE id=?`).run(hash, salt, req.subscriberId);
  // 보안: 비밀번호 변경 시 현 세션 외 모든 세션 무효화 (다른 디바이스 강제 로그아웃)
  db.prepare(`DELETE FROM sessions WHERE subscriber_id=? AND token != ?`).run(req.subscriberId, newToken);
  res.json({ ok: true });
});

app.post('/api/mypage/cancel', mypageAuth, async (req, res) => {
  const sub = db.prepare(`SELECT * FROM subscribers WHERE id = ?`).get(req.subscriberId);
  db.prepare(`UPDATE subscribers SET status='cancelled', cancelled_at = datetime('now', '+9 hours') WHERE id=?`).run(req.subscriberId);
  db.prepare(`DELETE FROM sessions WHERE subscriber_id=?`).run(req.subscriberId);
  if (sub) {
    notifySlack(`👋 해지(셀프): ${sub.company} (id=${sub.id}, ${maskName(sub.name)}) — ${(sub.charge_amount||0).toLocaleString()}원/${sub.billing_type}`);

    // 회원에게 해지 확인 SMS (분쟁 방지 + 안심)
    const cancelText = `[Moti Shop] ${sub.company}님, 구독이 정상적으로 해지되었어요.\n\n이후 결제는 발생하지 않으며, 구독·결제 이력은 30일간 보관됩니다.\n언제든 마이페이지에서 다시 구독하실 수 있어요.\nhttps://shop.motiphysio.com/mypage`;
    sendSMS({ to: sub.phone, text: cancelText, subject: '[Moti Shop] 구독 해지 완료' }).then(r => {
      console.log(`[해지 SMS] ${sub.company} → ${maskPhone(sub.phone)} / ok=${r.ok} / ${r.resultCode || ''} ${r.resultMsg || ''}`);
      if (!r.ok) notifySlack(`⚠️ 해지 SMS 실패: ${sub.company} (id=${sub.id}) — ${r.resultCode} ${r.resultMsg}`);
    }).catch(e => {
      console.error('[해지 SMS 예외]', e.message);
      notifySlack(`🔴 해지 SMS 예외: ${sub.company} (id=${sub.id}) — ${e.message}`);
    });
  }

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
app.post('/api/mypage/resubscribe', paymentActionLimiter, mypageAuth, async (req, res) => {
  const { features, billingType, billKey, moid, amount, ownerType, businessNumber } = req.body;
  if (!features || !Array.isArray(features) || features.length === 0 || !billingType || !billKey || !amount) {
    return res.status(400).json({ ok: false, msg: '필수 파라미터 누락' });
  }
  const sub = db.prepare(`SELECT * FROM subscribers WHERE id=?`).get(req.subscriberId);
  if (!sub) return res.status(404).json({ ok: false, msg: '가입자 없음' });

  // 명의 변경 처리 (재구독 시 가능)
  let nextBiz = sub.business_number;
  if (ownerType === 'business') {
    if (!businessNumber || !/^\d{10}$/.test(String(businessNumber))) {
      return res.status(400).json({ ok: false, msg: '법인은 사업자번호 10자리 필수' });
    }
    nextBiz = String(businessNumber);
  } else if (ownerType === 'personal') {
    nextBiz = null;
  }

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

  const tid = (result.raw && (result.raw.tid || result.raw.pgTid || result.raw.transSeq || result.raw.tno)) || '';
  db.prepare(`INSERT INTO billing_logs (subscriber_id, moid, amount, result_code, result_msg, trans_seq) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.subscriberId, newMoid, chargeAmount, result.resultCode || 'ERR', result.resultMsg || '', tid);

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

  // 가입자 정보 갱신 (재구독 시 명의 변경 가능)
  db.prepare(`UPDATE subscribers SET
    features=?, billing_type=?, bill_key=?, moid=?, charge_amount=?, business_number=?,
    next_billing_date=?, status='active', billkey_deleted=0, notified_7d=0, notified_1d=0, cancelled_at=NULL
    WHERE id=?`).run(featStr, billingType, billKey, newMoid, chargeAmount, nextBiz, nextBilling, req.subscriberId);

  console.log(`[재구독 ✓] ${sub.company} / ${featStr} / ${chargeAmount}원 / 다음: ${nextBilling}`);
  notifySlack(`🔁 재구독: ${sub.company} (id=${sub.id}) / ${chargeAmount.toLocaleString()}원 / 다음: ${nextBilling}`);

  // 회원에게 재구독 완료 SMS
  const resubText = `[Moti Shop] ${sub.company}님, 다시 구독해주셔서 감사해요.\n\n- 결제 금액: ${chargeAmount.toLocaleString()}원\n- 다음 결제일: ${nextBilling}\n\n마이페이지에서 구독 정보를 확인하실 수 있어요.\nhttps://shop.motiphysio.com/mypage`;
  sendSMS({ to: sub.phone, text: resubText, subject: '[Moti Shop] 재구독 완료' }).then(r => {
    console.log(`[재구독 SMS] ${sub.company} → ${maskPhone(sub.phone)} / ok=${r.ok} / ${r.resultCode || ''} ${r.resultMsg || ''}`);
    if (!r.ok) notifySlack(`⚠️ 재구독 SMS 실패: ${sub.company} (id=${sub.id}) — ${r.resultCode} ${r.resultMsg}`);
  }).catch(e => {
    console.error('[재구독 SMS 예외]', e.message);
    notifySlack(`🔴 재구독 SMS 예외: ${sub.company} (id=${sub.id}) — ${e.message}`);
  });

  res.json({ ok: true, charge_amount: chargeAmount, next_billing_date: nextBilling });
});

// 카드 정보 갱신 — 결제 실패·카드 변경 시 사용 (해지·재구독 불필요)
// 흐름: 클라이언트가 새 카드로 InnoPay 빌키 발급 → 서버에 새 billKey 전송 → 기존 빌키 삭제 + DB 갱신
app.post('/api/mypage/update-card', paymentActionLimiter, mypageAuth, async (req, res) => {
  const { billKey, moid } = req.body;
  if (!billKey) return res.status(400).json({ ok: false, msg: '빌키 누락' });

  const sub = db.prepare(`SELECT * FROM subscribers WHERE id=?`).get(req.subscriberId);
  if (!sub) return res.status(404).json({ ok: false, msg: '가입자 없음' });
  if (sub.status === 'cancelled') {
    return res.status(400).json({ ok: false, msg: '해지된 구독입니다. 다시 구독하기를 이용해주세요.' });
  }

  const oldBillKey = sub.bill_key;
  const newMoid = moid || (kstDateOnly().replace(/-/g, '') + Math.floor(1000 + Math.random() * 9000));

  // 새 빌키로 갱신 + 결제 실패 카운트 초기화
  db.prepare(`UPDATE subscribers SET
    bill_key=?, moid=?, billkey_deleted=0, failed_count=0, last_failed_at=NULL
    WHERE id=?`).run(billKey, newMoid, req.subscriberId);

  // 기존 빌키 삭제 (best-effort, 실패해도 무시)
  if (oldBillKey && oldBillKey !== billKey) {
    deleteBillKey({ billKey: oldBillKey, userId: sub.phone })
      .then(r => console.log(`[빌키 삭제 ${r.ok ? '✓' : '✗'}] old=${String(oldBillKey).slice(0, 8)}... ${r.resultCode || ''}`))
      .catch(e => console.error('[빌키 삭제 오류]', e.message));
  }

  console.log(`[카드 갱신] ${sub.company} (id=${sub.id}) / 다음 결제일: ${sub.next_billing_date}`);
  notifySlack(`💳 카드 정보 갱신: ${sub.company} (id=${sub.id}) / 다음 결제일: ${sub.next_billing_date}`);

  // 회원에게 갱신 완료 SMS
  const smsText = `[Moti Shop] ${sub.company}님, 카드 정보가 정상적으로 갱신되었어요.\n다음 결제일: ${sub.next_billing_date}\nhttps://shop.motiphysio.com/mypage`;
  sendSMS({ to: sub.phone, text: smsText, subject: '[Moti Shop] 카드 정보 갱신 완료' }).catch(e => console.error('[카드갱신 SMS 실패]', e.message));

  res.json({ ok: true, next_billing_date: sub.next_billing_date });
});

// 기능 추가/해지
app.post('/api/mypage/update-features', mypageAuth, (req, res) => {
  let { features } = req.body;
  if (!features || !Array.isArray(features) || features.length === 0)
    return res.status(400).json({ ok: false, msg: '기능을 하나 이상 선택해주세요.' });

  const sub = db.prepare(`SELECT * FROM subscribers WHERE id=?`).get(req.subscriberId);
  if (sub.status === 'cancelled')
    return res.status(403).json({ ok: false, msg: '해지된 계정은 변경할 수 없습니다.' });
  const prices = FEATURE_PRICES[sub.billing_type] || FEATURE_PRICES.monthly;

  // 가격표 sync 검증 — features 키와 가격표 일치 안 하면 0원 결제 양산 위험 → 차단
  const unknownFeats = features.filter(f => f !== 'ALL IN ONE' && !(f in prices));
  if (unknownFeats.length > 0) {
    notifySlack(`🔴 알 수 없는 기능 키: ${unknownFeats.join(', ')} (subscriber_id=${req.subscriberId}) — 가격표 동기화 점검 필요`);
    return res.status(400).json({ ok: false, msg: `알 수 없는 기능: ${unknownFeats.join(', ')}` });
  }

  let newAmount;
  if (features.includes('ALL IN ONE')) {
    features = ['ALL IN ONE'];  // 다른 항목 강제 제거 (#17 일관성)
    newAmount = prices['ALL IN ONE'];
  } else {
    newAmount = features.reduce((sum, f) => sum + prices[f], 0);
  }
  if (!Number.isFinite(newAmount) || newAmount <= 0) {
    return res.status(400).json({ ok: false, msg: '결제액 계산 실패 — 운영자에게 문의해주세요.' });
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
// 디바운스: 마지막 deploy 트리거 후 N초 내 추가 요청은 무시 (빠른 연속 push 보호)
let _lastDeployAt = 0;
const DEPLOY_DEBOUNCE_MS = 12000;
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

  // 디바운스 — 빠른 연속 push 시 stale ref 충돌 방지
  const now = Date.now();
  if (now - _lastDeployAt < DEPLOY_DEBOUNCE_MS) {
    const skipMs = DEPLOY_DEBOUNCE_MS - (now - _lastDeployAt);
    console.log(`[webhook] 디바운스 스킵 ${headCommit} (${skipMs}ms 남음)`);
    return res.json({ ok: true, debounced: true, commit: headCommit, retryAfterMs: skipMs });
  }
  _lastDeployAt = now;
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

  res.json({ ok: true, deploying: true, commit: headCommit });
});

// 5xx 에러 핸들러 — 처리되지 않은 예외를 Slack으로 보고
// 같은 에러가 5분 내 반복되면 알림 1번만 (스팸 방지)
const _errorAlertCache = new Map();  // key: errSig → lastNotifiedAt
const ERR_DEDUP_MS = 5 * 60 * 1000;

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  const stack = (err.stack || err.message || String(err)).slice(0, 800);
  console.error(`[5xx] ${req.method} ${req.path} →`, stack);

  if (status >= 500) {
    const sig = `${req.method} ${req.path} ${(err.message || '').slice(0, 100)}`;
    const now = Date.now();
    const last = _errorAlertCache.get(sig) || 0;
    if (now - last > ERR_DEDUP_MS) {
      _errorAlertCache.set(sig, now);
      // 캐시 크기 제한 (메모리 누수 방지)
      if (_errorAlertCache.size > 200) {
        const oldest = [..._errorAlertCache.entries()].sort((a, b) => a[1] - b[1])[0];
        if (oldest) _errorAlertCache.delete(oldest[0]);
      }
      notifySlack(`🚨 5xx 에러: ${req.method} ${req.path}\n\`\`\`${stack}\`\`\``);
    }
  }

  if (!res.headersSent) {
    res.status(status).json({ ok: false, msg: status >= 500 ? '서버 오류' : (err.message || 'Bad Request') });
  }
});

// 처리되지 않은 Promise rejection도 Slack
process.on('unhandledRejection', (reason) => {
  const msg = (reason?.stack || reason?.message || String(reason)).slice(0, 800);
  console.error('[unhandledRejection]', msg);
  notifySlack(`🚨 unhandledRejection:\n\`\`\`${msg}\`\`\``);
});
process.on('uncaughtException', (err) => {
  const msg = (err?.stack || err?.message || String(err)).slice(0, 800);
  console.error('[uncaughtException]', msg);
  notifySlack(`🚨 uncaughtException:\n\`\`\`${msg}\`\`\``);
});

// 배포 race(rsync 도중 systemd auto-restart)로 scheduler.js가 옛 버전이면
// 함수가 undefined일 수 있음 — typeof 가드로 크래시 대신 경고만 남김
const _safeStart = (name, fn) => {
  if (typeof fn === 'function') fn();
  else {
    console.warn(`[startup] ${name} 미정의 — 스킵 (다음 재시작 시 정상화 예정)`);
    notifySlack(`⚠️ 시작 시점에 ${name} 미정의 (배포 race 추정). 다음 재시작에서 정상화됩니다.`);
  }
};
_safeStart('scheduleBilling', scheduleBilling);
_safeStart('scheduleHealthCheck', scheduleHealthCheck);
_safeStart('scheduleAutoDelete', scheduleAutoDelete);
_safeStart('scheduleSolapiBalance', scheduleSolapiBalance);

app.listen(3001, '127.0.0.1', () => {
  console.log(`MotiShop API listening on port 3001 (MID=${cfg.INNOPAY_MID}, CORS=${cfg.CORS_ORIGIN})`);
});
