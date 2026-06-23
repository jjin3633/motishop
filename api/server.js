const cfg = require('./config');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { scheduleBilling, scheduleHealthCheck, scheduleAutoDelete, scheduleAutoDeletePreNotice, scheduleSolapiBalance, scheduleDbBackup, scheduleAnalyticsCleanup, scheduleSitemapUpdate, addPeriod } = require('./scheduler');
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

// 본문 파싱 — webhook 서명 검증 위해 rawBody 캡처 + 사이즈 제한 (대용량 페이로드 차단)
app.use(express.json({
  limit: '64kb',  // 정상 가입·결제·track 페이로드는 모두 < 8kb. 여유분 8배
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
  max: 30,                    // IP당 15분에 30회 (운영자·회원 친화적 완화)
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
// 일할 결제 in-flight 잠금 — 같은 가입자가 동시에 update-features 호출하면 중복 결제 차단
const updateFeaturesInFlight = new Set();

// 어드민 인증 brute-force 카운터 (IP별 실패 횟수)
const adminAuthFailures = new Map();  // ip → { count, firstAt }
const ADMIN_AUTH_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_AUTH_MAX_FAILURES = 20;

// Analytics(자체 추적) — 사용자 활동 수집. 운영 데이터와 격리됨. 실패해도 UX 영향 X.
const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,  // 분당 120건. 정상 사용자(체류·스크롤·클릭 합쳐 분당 20~30건) 여유분 포함
  standardHeaders: false,
  legacyHeaders: false,
  message: { ok: false },
  skip: () => false,
});

// ── 기능 가격표 ──
const FEATURE_PRICES = {
  monthly: {
    '모아레': 23900,
    '3D 신경·림프·장기': 35900,
    '척추 세부 분석': 47900,
    '손실키 분석': 79900,
    '안면 비대칭·여백·탄력': 29900,
    'ALL IN ONE LITE': 89900,
    'ALL IN ONE': 107900,
  },
  annual: {
    '모아레': 17900,
    '3D 신경·림프·장기': 29900,
    '척추 세부 분석': 39900,
    '손실키 분석': 65900,
    '안면 비대칭·여백·탄력': 23900,
    'ALL IN ONE LITE': 74900,
    'ALL IN ONE': 89900,
  }
};

// 번들 상품 (단독 선택 — 다른 기능과 동시 선택 불가)
// 우선순위: 풀 ALL IN ONE > LITE (둘 다 들어오면 풀로 통일)
const BUNDLE_FEATURES = ['ALL IN ONE', 'ALL IN ONE LITE'];
function getBundle(featureList) {
  for (const b of BUNDLE_FEATURES) if (featureList.includes(b)) return b;
  return null;
}

// 표시 명칭 매핑 — 내부 key는 그대로(DB 호환), 사용자에게 보여줄 때만 라벨 변환
// 'ALL IN ONE' → 'ALL IN ONE PLUS' (LITE는 동일)
// '안면 비대칭·여백·탄력' → '안면 여백·탄력' (비대칭은 기기 기본 내장이라 구독 표시명에서 제외)
// '3D 신경·림프·장기' → '3D 신경 · 림프 · 장기' (가독성 위해 점 사이 공백)
function featLabel(key) {
  if (key === 'ALL IN ONE') return 'ALL IN ONE PLUS';
  if (key === '안면 비대칭·여백·탄력') return '안면 여백 · 탄력';
  if (key === '3D 신경·림프·장기') return '3D 신경 · 림프 · 장기';
  return key;
}
function displayFeatures(featuresStr) {
  return (featuresStr || '').split(',').map(f => featLabel(f.trim())).filter(Boolean).join(', ');
}

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
// timing-safe 해시 비교 (단순 !==는 미세 시간 차이로 비밀번호 추측 가능)
function verifyPw(plainPw, salt, expectedHash) {
  if (!plainPw || !salt || !expectedHash) return false;
  const computed = hashPw(String(plainPw), salt);
  if (computed.length !== expectedHash.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expectedHash));
  } catch (e) {
    return false;
  }
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
// 인증: rate-limit + (선택) PG IP 화이트리스트 + moid 일치 검증
// 외부 임의 POST로 payment_notis 부풀림 방지 (2026-06-23 보강)
const innopayNotiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,  // 분당 30회 (정상 노티는 결제 1건당 1회. 30회면 봇 차단)
  standardHeaders: false,
  legacyHeaders: false,
  message: { ok: false },
});
app.post('/api/innopay/noti', innopayNotiLimiter, (req, res) => {
  const payload = req.body || {};

  // 1) IP 화이트리스트 (cfg.INNOPAY_NOTI_IPS 설정 시에만 검증 — 미설정이면 skip)
  const allowedIps = (cfg.INNOPAY_NOTI_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowedIps.length > 0 && !allowedIps.includes(req.ip)) {
    console.warn(`[노티 거부] 허용 안 된 IP: ${req.ip}`);
    notifySlack(`⚠️ /api/innopay/noti 허용 안 된 IP 시도: ${req.ip}`);
    return res.status(403).type('text/plain').send('FORBIDDEN');
  }

  // 2) moid 일치 검증 — billing_logs에 존재하는 moid만 허용 (임의 moid 부풀림 차단)
  const moid = String(payload.moid || '').slice(0, 64);
  if (!moid) {
    return res.status(400).type('text/plain').send('NO_MOID');
  }
  const matched = db.prepare(`SELECT id FROM billing_logs WHERE moid = ? LIMIT 1`).get(moid);
  if (!matched) {
    console.warn(`[노티 거부] 미매칭 moid: ${moid}`);
    return res.status(404).type('text/plain').send('NO_MATCH');
  }

  try {
    db.prepare(`INSERT INTO payment_notis (moid, trans_seq, result_code, result_msg, raw_payload) VALUES (?, ?, ?, ?, ?)`)
      .run(moid, String(payload.transSeq || payload.tno || '').slice(0, 64), String(payload.resultCode || '').slice(0, 16), String(payload.resultMsg || '').slice(0, 200), JSON.stringify(payload).slice(0, 4000));
    console.log(`[노티] moid=${moid} code=${payload.resultCode}`);
  } catch (e) {
    console.error('[노티 저장 실패]', e.message);
  }
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

// ── Analytics(자체 추적) 헬퍼 + 3개 라우트 — 2026-06-18 추가 ──
// 운영 데이터(subscribers, billing_logs)와 완전 격리. 실패해도 UX 영향 없음.
function hashIp(ip) {
  const salt = process.env.ANALYTICS_SALT || 'motishop-analytics-2026';
  return crypto.createHash('sha256').update(String(ip || '') + salt).digest('hex').slice(0, 16);
}
function isBot(ua) {
  if (!ua) return false;
  return /bot|crawler|spider|slurp|mediapartners|adsbot|googlebot|bingbot|yandex|duckduck/i.test(ua);
}

// 1) 페이지 진입 → visits 행 생성, visit_id 반환
app.post('/api/track/visit', trackLimiter, (req, res) => {
  try {
    const { session_id, page_path, referer, utm_source, utm_medium, utm_campaign } = req.body || {};
    if (!session_id || !page_path) return res.json({ ok: false });
    const ua = req.headers['user-agent'] || '';
    if (isBot(ua)) return res.json({ ok: true, skipped: 'bot' });
    const result = db.prepare(`
      INSERT INTO visits (session_id, page_path, referer, utm_source, utm_medium, utm_campaign, user_agent, ip_hash, visited_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+9 hours'))
    `).run(
      String(session_id).slice(0, 64),
      String(page_path).slice(0, 200),
      referer ? String(referer).slice(0, 500) : null,
      utm_source ? String(utm_source).slice(0, 100) : null,
      utm_medium ? String(utm_medium).slice(0, 100) : null,
      utm_campaign ? String(utm_campaign).slice(0, 100) : null,
      String(ua).slice(0, 500),
      hashIp(req.ip),
    );
    res.json({ ok: true, visit_id: result.lastInsertRowid });
  } catch (e) {
    console.error('[track/visit]', e.message);
    res.json({ ok: false });
  }
});

// 2) 스크롤·체류·이탈 업데이트 (10초마다 + beforeunload)
app.post('/api/track/update', trackLimiter, (req, res) => {
  try {
    const { visit_id, scroll_max, dwell_seconds, exited } = req.body || {};
    if (!visit_id) return res.json({ ok: false });
    const updates = [];
    const params = [];
    if (typeof scroll_max === 'number') {
      updates.push('scroll_max = MAX(scroll_max, ?)');
      params.push(Math.min(100, Math.max(0, Math.floor(scroll_max))));
    }
    if (typeof dwell_seconds === 'number') {
      updates.push('dwell_seconds = ?');
      params.push(Math.min(86400, Math.max(0, Math.floor(dwell_seconds))));
    }
    if (exited) updates.push(`exited_at = datetime('now', '+9 hours')`);
    if (!updates.length) return res.json({ ok: true });
    params.push(visit_id);
    db.prepare(`UPDATE visits SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ ok: true });
  } catch (e) {
    console.error('[track/update]', e.message);
    res.json({ ok: false });
  }
});

// 3) 이벤트 (클릭, 탭 전환, funnel 단계 등)
app.post('/api/track/event', trackLimiter, (req, res) => {
  try {
    const { session_id, event_name, event_props, page_path } = req.body || {};
    if (!session_id || !event_name) return res.json({ ok: false });
    const ua = req.headers['user-agent'] || '';
    if (isBot(ua)) return res.json({ ok: true, skipped: 'bot' });
    let propsStr = null;
    if (event_props) {
      try { propsStr = typeof event_props === 'string' ? event_props.slice(0, 1000) : JSON.stringify(event_props).slice(0, 1000); }
      catch { propsStr = null; }
    }
    db.prepare(`
      INSERT INTO events (session_id, event_name, event_props, page_path, occurred_at)
      VALUES (?, ?, ?, ?, datetime('now', '+9 hours'))
    `).run(
      String(session_id).slice(0, 64),
      String(event_name).slice(0, 100),
      propsStr,
      page_path ? String(page_path).slice(0, 200) : null,
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[track/event]', e.message);
    res.json({ ok: false });
  }
});

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

app.post('/api/subscribe', subscribeLimiter, async (req, res) => {
  let { company, name, phone, businessNumber, features, billingType, billKey, amount, termsAgreed } = req.body;
  if (!company || !name || !phone || !features || !billingType || !billKey || !amount)
    return res.status(400).json({ ok: false, msg: '필수 파라미터 누락' });
  if (!['monthly', 'annual'].includes(billingType))
    return res.status(400).json({ ok: false, msg: 'billingType은 monthly 또는 annual' });

  // 입력 정제 — 줄바꿈/제어문자 차단 (SMS 본문 위조·헤더 인젝션 방지) + 길이 제한
  company = String(company).replace(/[\r\n\t]/g, ' ').trim().slice(0, 100);
  name = String(name).replace(/[\r\n\t]/g, ' ').trim().slice(0, 50);
  if (!company || !name) return res.status(400).json({ ok: false, msg: '회사명·이름이 비어있습니다.' });

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
  const unknownFeats = featList.filter(f => !(f in prices));
  if (unknownFeats.length > 0) {
    notifySlack(`🔴 알 수 없는 기능 키(가입): ${unknownFeats.join(', ')} (${maskPhone(String(phone).replace(/[^0-9]/g, ''))})`);
    return res.status(400).json({ ok: false, msg: `알 수 없는 기능: ${unknownFeats.join(', ')}` });
  }
  // 번들 선택 시 다른 항목 무시하고 번들 단독 가격 적용
  const subBundle = getBundle(featList);
  const monthlyAmount = subBundle
    ? prices[subBundle]
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
      // 재활성화 — 약관 정책: 무료 체험 미적용 + 즉시 결제 (마이페이지 재구독과 동일 흐름)
      const { chargeWithRetry } = require('./innopay');
      // moid는 서버에서 항상 새로 생성 (클라이언트 신뢰 X — 재사용·충돌 방지)
      const newMoid = kstDateOnly().replace(/-/g, '') + Math.floor(1000 + Math.random() * 9000);

      // 1) 즉시 결제 시도
      const chargeResult = await chargeWithRetry({
        billKey,
        moid: newMoid,
        amount: chargeAmount,
        goodsName: '모티샵 구독',
        buyerName: name,
        userId: cleanPhone,
      });

      // 2) 결제 결과 billing_logs 기록 (성공·실패 모두)
      const tid = (chargeResult.raw && (chargeResult.raw.tid || chargeResult.raw.pgTid || chargeResult.raw.transSeq || chargeResult.raw.tno)) || '';
      db.prepare(`INSERT INTO billing_logs (subscriber_id, moid, amount, result_code, result_msg, trans_seq) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(existing.id, newMoid, chargeAmount, chargeResult.resultCode || 'ERR', chargeResult.resultMsg || '', tid);

      // 3) 결제 실패 시 — 가입 미완료 (status 변경 X, 502 반환)
      if (!chargeResult.ok) {
        console.error(`[재가입 결제 실패] id=${existing.id} ${company} / ${chargeResult.resultCode} ${chargeResult.resultMsg}`);
        notifySlack(`🔴 재가입 결제 실패(신청폼): ${company} (id=${existing.id}, ${maskName(name)}) — ${chargeResult.resultCode} ${chargeResult.resultMsg}`);
        return res.status(502).json({ ok: false, msg: '결제 실패: ' + (chargeResult.resultMsg || '카드 정보를 확인해주세요.'), resultCode: chargeResult.resultCode });
      }

      // 4) 결제 성공 — 다음 결제일 계산 (scheduler addPeriod 사용 — 월말 clamp + KST 일관)
      const nextBilling = addPeriod(kstDateOnly(), billingType);

      // 5) 변경 이력 + 가입자 정보 갱신 (status='active', 결제·체험 리셋)
      db.prepare(`INSERT INTO subscriber_changes
        (subscriber_id, change_type, before_features, after_features, before_billing_type, after_billing_type, before_amount, after_amount)
        VALUES (?, 'reactivate', ?, ?, ?, ?, ?, ?)`)
        .run(existing.id, existing.features, features, existing.billing_type, billingType, existing.charge_amount, chargeAmount);

      // trial_start 갱신 — 재가입은 새 가입 사이클 (어드민 상세 표시 정확성)
      db.prepare(`UPDATE subscribers SET
        company=?, name=?, business_number=?, features=?, billing_type=?, bill_key=?, moid=?, charge_amount=?,
        trial_start=?, next_billing_date=?, status='active', billkey_deleted=0, notified_7d=0, notified_1d=0, cancelled_at=NULL, failed_count=0, last_failed_at=NULL
        WHERE id=?`)
        .run(company, name, cleanBizNum, features, billingType, billKey, newMoid, chargeAmount, kstDateOnly(), nextBilling, existing.id);

      saveTermsConsent(existing.id, termsAgreed, req);
      console.log(`[재가입 ✓ 결제완료] id=${existing.id} ${company} / ${maskName(name)} / ${billingType} / ${chargeAmount.toLocaleString()}원 / 다음: ${nextBilling}`);
      notifySlack(`🔁 재가입(신청폼·결제완료): ${company} (id=${existing.id}, ${maskName(name)}) / ${billingType==='annual'?'연':'월'}구독 ${chargeAmount.toLocaleString()}원 / 기능: ${displayFeatures(features)} / 다음: ${nextBilling}`);
      return res.json({ ok: true, charge_amount: chargeAmount, next_billing_date: nextBilling, reactivated: true, subscriberId: existing.id });
    }

    // 신규 가입 — 임시 비밀번호 + moid 서버 재생성 (클라이언트 신뢰 X)
    const tempPw = genTempPw();
    const salt = genSalt();
    const hash = hashPw(tempPw, salt);
    const serverMoid = kstDateOnly().replace(/-/g, '') + Math.floor(1000 + Math.random() * 9000);

    // INSERT OR IGNORE — 더블클릭 등 race로 동시 INSERT가 들어와도 phone UNIQUE 제약에 의해 한 건만 통과
    const r = db.prepare(`
      INSERT OR IGNORE INTO subscribers
        (company, name, phone, business_number, features, billing_type, bill_key, moid, charge_amount, trial_start, next_billing_date, pw_hash, pw_salt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(company, name, cleanPhone, cleanBizNum, features, billingType, billKey, serverMoid, chargeAmount, trialStart, nextBillingDate, hash, salt);

    if (r.changes === 0) {
      // 동시 race로 다른 요청이 먼저 INSERT 함 — 그 row 반환 (멱등 응답)
      const dup = db.prepare(`SELECT id FROM subscribers WHERE phone = ?`).get(cleanPhone);
      console.log(`[가입 race 차단] phone=${maskPhone(cleanPhone)} → 기존 id=${dup?.id} 반환`);
      return res.json({ ok: true, trialStart, nextBillingDate, reactivated: false, subscriberId: dup?.id, raceBlocked: true });
    }

    saveTermsConsent(r.lastInsertRowid, termsAgreed, req);
    console.log(`[신규 가입] id=${r.lastInsertRowid} ${company} / ${maskName(name)} / ${billingType} / 첫 결제일: ${nextBillingDate}`);
    notifySlack(`🎉 신규 가입: ${company} (id=${r.lastInsertRowid}, ${maskName(name)}) / ${billingType==='annual'?'연':'월'}구독 ${chargeAmount.toLocaleString()}원 / 기능: ${displayFeatures(features)} / 첫 결제: ${nextBillingDate}`);

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

// adminAuth — brute-force 카운트 + timing-safe 비교 (단순 === 비교는 timing leak)
function adminAuth(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();

  // 윈도우 지난 항목 정리
  const rec = adminAuthFailures.get(ip);
  if (rec && now - rec.firstAt > ADMIN_AUTH_WINDOW_MS) {
    adminAuthFailures.delete(ip);
  }
  const cur = adminAuthFailures.get(ip);
  if (cur && cur.count >= ADMIN_AUTH_MAX_FAILURES) {
    return res.status(429).json({ ok: false, msg: '어드민 인증 시도가 너무 많습니다. 15분 후 다시 시도해주세요.' });
  }

  const sent = String(req.headers['x-admin-pw'] || '');
  const expected = String(cfg.ADMIN_PW || '');
  const recordFailure = () => {
    if (cur) cur.count++;
    else adminAuthFailures.set(ip, { count: 1, firstAt: now });
  };

  if (!expected || !sent || sent.length !== expected.length) {
    recordFailure();
    return res.status(403).json({ ok: false, msg: 'Forbidden' });
  }
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected)); } catch (e) { ok = false; }
  if (!ok) {
    recordFailure();
    return res.status(403).json({ ok: false, msg: 'Forbidden' });
  }
  // 성공 — 실패 카운트 리셋
  adminAuthFailures.delete(ip);
  next();
}

app.get('/api/subscribers', adminAuth, (req, res) => {
  // 가입 순서대로 가져와 joinNumber 부여 (가장 먼저 가입한 사람 = 1, 이후 +1)
  // 그 다음 화면 표시는 최신순(신순)으로 reverse
  const rows = db.prepare(`
    SELECT id, company, name, phone, features, billing_type,
           charge_amount, trial_start, next_billing_date, status, created_at,
           CASE WHEN pw_hash IS NOT NULL THEN 1 ELSE 0 END as has_password
    FROM subscribers ORDER BY created_at ASC
  `).all();
  rows.forEach((r, i) => { r.joinNumber = i + 1; });
  rows.reverse();
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

  // 환불 정보 LEFT JOIN — '2001'=완료 환불 합산, 'PENDING'=응답 미확인 표시
  const billingLogs = db.prepare(`
    SELECT l.id, l.moid, l.amount, l.result_code, l.result_msg, l.billed_at,
           COALESCE(SUM(CASE WHEN r.result_code='2001' THEN r.amount ELSE 0 END), 0) AS refunded_amount,
           MAX(CASE WHEN r.result_code='2001' THEN r.refunded_at ELSE NULL END) AS last_refunded_at,
           SUM(CASE WHEN r.result_code='PENDING' THEN 1 ELSE 0 END) AS pending_refund_count
    FROM billing_logs l
    LEFT JOIN refunds r ON r.moid = l.moid AND r.subscriber_id = l.subscriber_id
    WHERE l.subscriber_id = ?
    GROUP BY l.id
    ORDER BY l.billed_at DESC
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

  // 기능 활성화 SMS 이력
  const activationLogs = db.prepare(`
    SELECT id, operator_name, sent_at, sms_result_code, sms_result_msg
    FROM activation_logs WHERE subscriber_id = ?
    ORDER BY sent_at DESC
  `).all(id);

  // 운영자 메모 (삭제되지 않은 것만, 최신순)
  const memos = db.prepare(`
    SELECT id, operator_name, content, created_at
    FROM subscriber_memos
    WHERE subscriber_id = ? AND deleted_at IS NULL
    ORDER BY created_at DESC
  `).all(id);

  res.json({ ok: true, subscriber: sub, billingLogs, stats, related, changes, activationLogs, memos });
});

app.get('/api/revenue', adminAuth, (req, res) => {
  const thisMonth = kstYearMonth();
  const thisYear  = kstYear();

  // 매출 = 성공 결제(billing_logs) - 환불(refunds) — 라벨 "전체 결제 - 환불"과 일치하도록 수정
  // 환불은 refunded_at 기준 (해당 달에 빼기 — cash-flow 관점)
  const thisMonthGross = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as v FROM billing_logs WHERE result_code IN ('0000','00') AND strftime('%Y-%m',billed_at)=?`
  ).get(thisMonth)?.v || 0;
  const thisMonthRefunds = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as v FROM refunds WHERE result_code='2001' AND strftime('%Y-%m',refunded_at)=?`
  ).get(thisMonth)?.v || 0;
  const thisMonthTotal = Math.max(0, thisMonthGross - thisMonthRefunds);

  const thisYearGross = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as v FROM billing_logs WHERE result_code IN ('0000','00') AND strftime('%Y',billed_at)=?`
  ).get(thisYear)?.v || 0;
  const thisYearRefunds = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as v FROM refunds WHERE result_code='2001' AND strftime('%Y',refunded_at)=?`
  ).get(thisYear)?.v || 0;
  const thisYearTotal = Math.max(0, thisYearGross - thisYearRefunds);

  const allTimeGross = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as v FROM billing_logs WHERE result_code IN ('0000','00')`
  ).get()?.v || 0;
  const allTimeRefunds = db.prepare(
    `SELECT COALESCE(SUM(amount),0) as v FROM refunds WHERE result_code='2001'`
  ).get()?.v || 0;
  const allTimeTotal = Math.max(0, allTimeGross - allTimeRefunds);

  // 다음 달 예상 수익 — 해지/빌키삭제 제외, active + trial 중 다음달 결제 예정인 사람들의 charge_amount 합
  const nextMonthWhere = `
    status IN ('active','trial')
    AND cancelled_at IS NULL
    AND (billkey_deleted IS NULL OR billkey_deleted = 0)
    AND next_billing_date IS NOT NULL
    AND strftime('%Y-%m', next_billing_date) = strftime('%Y-%m', 'now', '+9 hours', '+1 months')
  `;
  const nextMonthEstimate = db.prepare(
    `SELECT COALESCE(SUM(charge_amount),0) as v FROM subscribers WHERE ${nextMonthWhere}`
  ).get()?.v || 0;
  const nextMonthCount = db.prepare(
    `SELECT COUNT(*) as v FROM subscribers WHERE ${nextMonthWhere}`
  ).get()?.v || 0;

  // 다음 달 결제 예정 breakdown — status별 / 누락 사유별 분석 (디버그용)
  const nextMonthBreakdown = {
    active: db.prepare(`SELECT COUNT(*) as v FROM subscribers WHERE status='active' AND cancelled_at IS NULL AND (billkey_deleted IS NULL OR billkey_deleted=0) AND next_billing_date IS NOT NULL AND strftime('%Y-%m', next_billing_date) = strftime('%Y-%m', 'now', '+9 hours', '+1 months')`).get()?.v || 0,
    trial:  db.prepare(`SELECT COUNT(*) as v FROM subscribers WHERE status='trial' AND cancelled_at IS NULL AND (billkey_deleted IS NULL OR billkey_deleted=0) AND next_billing_date IS NOT NULL AND strftime('%Y-%m', next_billing_date) = strftime('%Y-%m', 'now', '+9 hours', '+1 months')`).get()?.v || 0,
    // 제외 사유별 (active+trial 중에서)
    excludedCancelled:     db.prepare(`SELECT COUNT(*) as v FROM subscribers WHERE status IN ('active','trial') AND cancelled_at IS NOT NULL AND strftime('%Y-%m', next_billing_date) = strftime('%Y-%m', 'now', '+9 hours', '+1 months')`).get()?.v || 0,
    excludedBillkeyDeleted:db.prepare(`SELECT COUNT(*) as v FROM subscribers WHERE status IN ('active','trial') AND billkey_deleted=1 AND strftime('%Y-%m', next_billing_date) = strftime('%Y-%m', 'now', '+9 hours', '+1 months')`).get()?.v || 0,
    excludedNoNextDate:    db.prepare(`SELECT COUNT(*) as v FROM subscribers WHERE status IN ('active','trial') AND cancelled_at IS NULL AND (billkey_deleted IS NULL OR billkey_deleted=0) AND next_billing_date IS NULL`).get()?.v || 0,
    // 다른 월에 잡힌 active+trial (이번달/이후 다음달)
    inThisMonth: db.prepare(`SELECT COUNT(*) as v FROM subscribers WHERE status IN ('active','trial') AND cancelled_at IS NULL AND (billkey_deleted IS NULL OR billkey_deleted=0) AND next_billing_date IS NOT NULL AND strftime('%Y-%m', next_billing_date) = strftime('%Y-%m', 'now', '+9 hours')`).get()?.v || 0,
    inLaterMonth: db.prepare(`SELECT COUNT(*) as v FROM subscribers WHERE status IN ('active','trial') AND cancelled_at IS NULL AND (billkey_deleted IS NULL OR billkey_deleted=0) AND next_billing_date IS NOT NULL AND next_billing_date > strftime('%Y-%m-%d', 'now', '+9 hours', '+1 months', 'start of month', '+1 months', '-1 days')`).get()?.v || 0,
  };
  // 다음 달 결제 예정 가입자 명단 (확인용)
  const nextMonthList = db.prepare(
    `SELECT id, company, name, status, charge_amount, next_billing_date FROM subscribers WHERE ${nextMonthWhere} ORDER BY next_billing_date`
  ).all();

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

  res.json({ thisMonthTotal, thisYearTotal, allTimeTotal, nextMonthEstimate, nextMonthCount, nextMonthBreakdown, nextMonthList, yearly, monthly, monthlyByYear, selectedYear: year });
});

// ── 실시간 운영 모니터 — 자체 수집 데이터(visits/events) 기반 5개 KPI ──
// 2026-06-18 추가. days 파라미터로 기간 필터 (기본 7일).
app.get('/api/admin/stats/analytics', adminAuth, (req, res) => {
  const days = Math.max(1, Math.min(90, parseInt(req.query.days) || 7));
  // "오늘"(days=1)은 오늘 자정(KST) ~ 지금. 그 외는 지금 ~ N일 전.
  const since = days === 1
    ? `datetime('now', '+9 hours', 'start of day')`
    : `datetime('now', '+9 hours', '-${days} days')`;

  // KPI 1: 방문자 / 신규 가입자 / 페이지뷰 / 전환율
  const visitors = db.prepare(`SELECT COUNT(DISTINCT session_id) as v FROM visits WHERE visited_at >= ${since}`).get()?.v || 0;
  const pageviews = db.prepare(`SELECT COUNT(*) as v FROM visits WHERE visited_at >= ${since}`).get()?.v || 0;
  const signups = db.prepare(`SELECT COUNT(*) as v FROM subscribers WHERE created_at >= ${since}`).get()?.v || 0;
  const conversionRate = visitors > 0 ? Math.round(signups / visitors * 10000) / 100 : 0;

  // KPI 2: Funnel (카드 클릭 → 모달 탐색 → 가입)
  const cardClickSessions = db.prepare(`SELECT COUNT(DISTINCT session_id) as v FROM events WHERE event_name='feat_card_click' AND occurred_at >= ${since}`).get()?.v || 0;
  const tabSwitchSessions = db.prepare(`SELECT COUNT(DISTINCT session_id) as v FROM events WHERE event_name='feat_modal_tab_switch' AND occurred_at >= ${since}`).get()?.v || 0;

  // KPI 3: 페이지별 이탈률 + 체류 시간
  const pages = db.prepare(`
    SELECT page_path,
           COUNT(*) as visits,
           ROUND(AVG(dwell_seconds)) as avg_dwell,
           ROUND(SUM(CASE WHEN dwell_seconds < 10 THEN 1.0 ELSE 0.0 END) / COUNT(*) * 100, 1) as bounce_rate
    FROM visits
    WHERE visited_at >= ${since}
    GROUP BY page_path
    ORDER BY visits DESC
    LIMIT 10
  `).all();

  // KPI 4: 유입 채널 (UTM 우선, 없으면 referer 도메인 매칭)
  const channels = db.prepare(`
    SELECT
      CASE
        WHEN utm_source IS NOT NULL AND utm_source <> '' THEN utm_source
        WHEN referer IS NULL OR referer = '' THEN '직접 방문'
        WHEN referer LIKE '%naver.com%' OR referer LIKE '%naver.%' THEN '네이버'
        WHEN referer LIKE '%google.%' THEN '구글'
        WHEN referer LIKE '%daum.%' THEN '다음'
        WHEN referer LIKE '%kakao.%' THEN '카카오'
        WHEN referer LIKE '%instagram%' THEN '인스타그램'
        WHEN referer LIKE '%youtube%' THEN '유튜브'
        WHEN referer LIKE '%facebook%' THEN '페이스북'
        WHEN referer LIKE '%motiphysio%' THEN '모티피지오 사내'
        ELSE '기타'
      END as channel,
      COUNT(DISTINCT session_id) as sessions
    FROM visits
    WHERE visited_at >= ${since}
    GROUP BY channel
    ORDER BY sessions DESC
  `).all();

  // KPI 5-a: 기능별 관심도 (feat_card_click)
  const featClicks = db.prepare(`
    SELECT json_extract(event_props, '$.feat_key') as feat, COUNT(*) as clicks, COUNT(DISTINCT session_id) as sessions
    FROM events
    WHERE event_name = 'feat_card_click' AND occurred_at >= ${since} AND event_props IS NOT NULL
    GROUP BY feat
    ORDER BY clicks DESC
  `).all().filter(r => r.feat);
  const featExplores = db.prepare(`
    SELECT json_extract(event_props, '$.feat_key') as feat, COUNT(*) as switches
    FROM events
    WHERE event_name = 'feat_modal_tab_switch' AND occurred_at >= ${since} AND event_props IS NOT NULL
    GROUP BY feat
  `).all();
  const exploreMap = Object.fromEntries(featExplores.map(r => [r.feat, r.switches]));
  const features = featClicks.map(f => ({ ...f, exploreCount: exploreMap[f.feat] || 0 }));

  // KPI 5-b: 평균 체류·스크롤
  const avgDwell = db.prepare(`SELECT ROUND(AVG(dwell_seconds)) as v FROM visits WHERE visited_at >= ${since} AND dwell_seconds > 0`).get()?.v || 0;
  const avgScroll = db.prepare(`SELECT ROUND(AVG(scroll_max)) as v FROM visits WHERE visited_at >= ${since} AND scroll_max > 0`).get()?.v || 0;

  res.json({
    ok: true,
    days,
    kpi: { visitors, pageviews, signups, conversionRate },
    funnel: { cardClick: cardClickSessions, modalExplore: tabSwitchSessions, signups },
    pages,
    channels,
    features,
    engagement: { avgDwell, avgScroll },
  });
});

// 활성 사용자 개요 (일/월/년 단위 KPI + 추세 + 시간대별 가입)
app.get('/api/admin/active-overview', adminAuth, (req, res) => {
  // 현재 활성 (공통)
  const activeBreak = db.prepare(`
    SELECT status, COUNT(*) as count FROM subscribers WHERE status IN ('trial','active') GROUP BY status
  `).all();
  const activeNow = activeBreak.reduce((s, r) => s + r.count, 0);
  const trialCount = activeBreak.find(r => r.status === 'trial')?.count || 0;
  const activeCount = activeBreak.find(r => r.status === 'active')?.count || 0;

  // 기존 mau (결제·변경 발생자 기준 — '활성 계정'으로 라벨 변경)
  const activeAccounts30d = db.prepare(`
    SELECT COUNT(DISTINCT subscriber_id) as v FROM (
      SELECT subscriber_id FROM billing_logs WHERE billed_at >= datetime('now', '+9 hours', '-30 days')
      UNION
      SELECT subscriber_id FROM subscriber_changes WHERE changed_at >= datetime('now', '+9 hours', '-30 days')
    )
  `).get().v;

  // 진짜 MAU — 자체 분석 visits 테이블 기반 (최근 30일 unique session_id)
  // 회원 식별 X (방문자 익명). 실제 사용 활성도 지표.
  const mau = db.prepare(`
    SELECT COUNT(DISTINCT session_id) as v FROM visits
    WHERE visited_at >= datetime('now', '+9 hours', '-30 days')
  `).get()?.v || 0;

  // ── 헬퍼: 기간 KPI (signups, payments-success-count, payments-total, cancels, refunds-amount)
  const periodKpi = (whereClause) => ({
    signups: db.prepare(`SELECT COUNT(*) as v FROM subscribers WHERE ${whereClause.replace(/AT_FIELD/g, 'created_at')}`).get().v,
    payCount: db.prepare(`SELECT COUNT(*) as v FROM billing_logs WHERE result_code IN ('0000','00') AND ${whereClause.replace(/AT_FIELD/g, 'billed_at')}`).get().v,
    payTotal: db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM billing_logs WHERE result_code IN ('0000','00') AND ${whereClause.replace(/AT_FIELD/g, 'billed_at')}`).get().v,
    cancels: db.prepare(`SELECT COUNT(*) as v FROM subscribers WHERE cancelled_at IS NOT NULL AND ${whereClause.replace(/AT_FIELD/g, 'cancelled_at')}`).get().v,
    refundAmt: db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM refunds WHERE result_code='2001' AND ${whereClause.replace(/AT_FIELD/g, 'refunded_at')}`).get().v,
  });

  // ── 일별 (오늘·어제·7일 / 추세 14일)
  const daily = {
    today: periodKpi(`DATE(AT_FIELD) = DATE('now', '+9 hours')`),
    yesterday: periodKpi(`DATE(AT_FIELD) = DATE('now', '+9 hours', '-1 days')`),
    week: periodKpi(`AT_FIELD >= datetime('now', '+9 hours', '-7 days')`),
    prevWeek: periodKpi(`AT_FIELD >= datetime('now', '+9 hours', '-14 days') AND AT_FIELD < datetime('now', '+9 hours', '-7 days')`),
  };
  const dailyRange = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    dailyRange.push(kstDateOnly(d));
  }
  const dailyMap = Object.fromEntries(dailyRange.map(d => [d, { date: d, signups: 0, payments: 0, cancels: 0, refunds: 0 }]));
  const fillDay = (rows, field) => rows.forEach(r => { if (dailyMap[r.date]) dailyMap[r.date][field] = r.count; });
  fillDay(db.prepare(`SELECT DATE(created_at) as date, COUNT(*) as count FROM subscribers WHERE created_at >= datetime('now', '+9 hours', '-14 days') GROUP BY date`).all(), 'signups');
  fillDay(db.prepare(`SELECT DATE(billed_at) as date, COUNT(*) as count FROM billing_logs WHERE result_code IN ('0000','00') AND billed_at >= datetime('now', '+9 hours', '-14 days') GROUP BY date`).all(), 'payments');
  fillDay(db.prepare(`SELECT DATE(cancelled_at) as date, COUNT(*) as count FROM subscribers WHERE cancelled_at >= datetime('now', '+9 hours', '-14 days') GROUP BY date`).all(), 'cancels');
  fillDay(db.prepare(`SELECT DATE(refunded_at) as date, COUNT(*) as count FROM refunds WHERE result_code='2001' AND refunded_at >= datetime('now', '+9 hours', '-14 days') GROUP BY date`).all(), 'refunds');
  daily.trend = dailyRange.map(d => dailyMap[d]);

  // ── 월별 (이번 달·지난 달 / 추세 12개월)
  const monthly = {
    thisMonth: periodKpi(`strftime('%Y-%m', AT_FIELD) = strftime('%Y-%m', 'now', '+9 hours')`),
    prevMonth: periodKpi(`strftime('%Y-%m', AT_FIELD) = strftime('%Y-%m', 'now', '+9 hours', '-1 months')`),
  };
  const monthRange = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    monthRange.push(kstYearMonth(d));
  }
  const monthMap = Object.fromEntries(monthRange.map(m => [m, { month: m, signups: 0, payments: 0, cancels: 0, refunds: 0 }]));
  const fillMonth = (rows, field) => rows.forEach(r => { if (monthMap[r.month]) monthMap[r.month][field] = r.count; });
  fillMonth(db.prepare(`SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count FROM subscribers WHERE created_at >= datetime('now', '+9 hours', '-12 months') GROUP BY month`).all(), 'signups');
  fillMonth(db.prepare(`SELECT strftime('%Y-%m', billed_at) as month, COUNT(*) as count FROM billing_logs WHERE result_code IN ('0000','00') AND billed_at >= datetime('now', '+9 hours', '-12 months') GROUP BY month`).all(), 'payments');
  fillMonth(db.prepare(`SELECT strftime('%Y-%m', cancelled_at) as month, COUNT(*) as count FROM subscribers WHERE cancelled_at >= datetime('now', '+9 hours', '-12 months') GROUP BY month`).all(), 'cancels');
  fillMonth(db.prepare(`SELECT strftime('%Y-%m', refunded_at) as month, COUNT(*) as count FROM refunds WHERE result_code='2001' AND refunded_at >= datetime('now', '+9 hours', '-12 months') GROUP BY month`).all(), 'refunds');
  monthly.trend = monthRange.map(m => monthMap[m]);

  // ── 년별 (올해·작년 / 누적 / 추세 N년)
  const yearly = {
    thisYear: periodKpi(`strftime('%Y', AT_FIELD) = strftime('%Y', 'now', '+9 hours')`),
    prevYear: periodKpi(`strftime('%Y', AT_FIELD) = strftime('%Y', 'now', '+9 hours', '-1 years')`),
    allTime: {
      signups: db.prepare(`SELECT COUNT(*) as v FROM subscribers`).get().v,
      payCount: db.prepare(`SELECT COUNT(*) as v FROM billing_logs WHERE result_code IN ('0000','00')`).get().v,
      payTotal: db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM billing_logs WHERE result_code IN ('0000','00')`).get().v,
      cancels: db.prepare(`SELECT COUNT(*) as v FROM subscribers WHERE cancelled_at IS NOT NULL`).get().v,
      refundAmt: db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM refunds WHERE result_code='2001'`).get().v,
    },
  };
  const yearRowsRaw = {
    signups: db.prepare(`SELECT strftime('%Y', created_at) as year, COUNT(*) as count FROM subscribers GROUP BY year`).all(),
    payments: db.prepare(`SELECT strftime('%Y', billed_at) as year, COUNT(*) as count FROM billing_logs WHERE result_code IN ('0000','00') GROUP BY year`).all(),
    cancels: db.prepare(`SELECT strftime('%Y', cancelled_at) as year, COUNT(*) as count FROM subscribers WHERE cancelled_at IS NOT NULL GROUP BY year`).all(),
    refunds: db.prepare(`SELECT strftime('%Y', refunded_at) as year, COUNT(*) as count FROM refunds WHERE result_code='2001' GROUP BY year`).all(),
  };
  const allYears = new Set();
  Object.values(yearRowsRaw).forEach(rows => rows.forEach(r => r.year && allYears.add(r.year)));
  const thisYearStr = String(new Date().getFullYear());
  allYears.add(thisYearStr);
  const yearRange = [...allYears].filter(y => y).sort();
  const yearMap = Object.fromEntries(yearRange.map(y => [y, { year: y, signups: 0, payments: 0, cancels: 0, refunds: 0 }]));
  for (const [field, rows] of Object.entries(yearRowsRaw)) {
    rows.forEach(r => { if (r.year && yearMap[r.year]) yearMap[r.year][field === 'payments' ? 'payments' : field === 'cancels' ? 'cancels' : field === 'refunds' ? 'refunds' : 'signups'] = r.count; });
  }
  yearly.trend = yearRange.map(y => yearMap[y]);

  // 시간대별 가입 (24h, 30일)
  const hourlyRaw = db.prepare(`
    SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count
    FROM subscribers WHERE created_at >= datetime('now', '+9 hours', '-30 days') GROUP BY hour
  `).all();
  const hourly = Array.from({ length: 24 }, (_, h) => ({
    hour: h, count: hourlyRaw.find(r => r.hour === h)?.count || 0,
  }));

  // ── 비즈니스 메트릭 (MRR / ARR / 체험전환율 / 누적매출) ──
  // MRR — 현재 활성·체험 회원의 월 환산 정기 매출
  const mrrRow = db.prepare(`
    SELECT COALESCE(SUM(
      CASE WHEN billing_type='annual' THEN charge_amount / 12.0 ELSE charge_amount END
    ), 0) as mrr
    FROM subscribers WHERE status IN ('trial','active')
  `).get();
  const mrr = Math.round(mrrRow.mrr || 0);
  const arr = mrr * 12;

  // 체험 → 정식 전환율 — 30~60일 전 가입자 기준
  // 분모: 가입 후 30일 이상 경과한 회원 (= 첫 결제 시도 도달)
  // 분자: 그 중 결제 1회 이상 성공한 회원
  const trialConv = db.prepare(`
    SELECT
      COUNT(DISTINCT s.id) as denominator,
      COUNT(DISTINCT CASE WHEN b.id IS NOT NULL THEN s.id END) as numerator
    FROM subscribers s
    LEFT JOIN billing_logs b
      ON b.subscriber_id = s.id AND b.result_code IN ('0000','00')
    WHERE s.created_at < datetime('now', '+9 hours', '-30 days')
      AND s.created_at >= datetime('now', '+9 hours', '-60 days')
  `).get();
  const trialConversionRate = trialConv.denominator > 0
    ? Math.round(100 * trialConv.numerator / trialConv.denominator)
    : null;

  // 누적 매출 (모든 성공 결제 합 - 환불 합)
  const totalPaid = db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM billing_logs WHERE result_code IN ('0000','00')`).get().v;
  const totalRefunded = db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM refunds WHERE result_code='2001'`).get().v;
  const totalRevenue = totalPaid - totalRefunded;

  // ARPU — 활성 회원당 평균 월 매출 (MRR / 활성 회원 수)
  const arpu = activeNow > 0 ? Math.round(mrr / activeNow) : 0;

  // 요금제별 가입자 분포 + 개별 기능 가입자의 기능별 사용 카운트 (활성 회원 기준)
  const activeSubs = db.prepare(`
    SELECT features FROM subscribers WHERE status IN ('trial','active')
  `).all();
  let plusCount = 0, liteCount = 0, individualCount = 0;
  const FEATURE_KEYS = ['모아레', '3D 신경·림프·장기', '척추 세부 분석', '손실키 분석', '안면 비대칭·여백·탄력'];
  const featureCounts = FEATURE_KEYS.map(k => ({ key: k, count: 0 }));
  for (const s of activeSubs) {
    if (s.features === 'ALL IN ONE') plusCount++;
    else if (s.features === 'ALL IN ONE LITE') liteCount++;
    else {
      individualCount++;
      const feats = (s.features || '').split(',').map(f => f.trim()).filter(Boolean);
      for (const fc of featureCounts) if (feats.includes(fc.key)) fc.count++;
    }
  }
  const planBreak = {
    plus: plusCount,
    lite: liteCount,
    individual: individualCount,
    featureCounts,
  };

  res.json({
    now: {
      activeNow, trialCount, activeCount, mau, activeAccounts30d,
      mrr, arr, arpu,
      trialConversionRate,
      trialConvDenominator: trialConv.denominator,
      trialConvNumerator: trialConv.numerator,
      totalRevenue,
      planBreak,
    },
    daily, monthly, yearly,
    hourly,
  });
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
  const { id, notify } = req.body;
  if (!id) return res.status(400).json({ ok: false });
  const sub = db.prepare(`SELECT * FROM subscribers WHERE id = ?`).get(id);
  if (!sub) return res.status(404).json({ ok: false, msg: '가입자 없음' });

  db.prepare(`UPDATE subscribers SET status = 'cancelled', cancelled_at = datetime('now', '+9 hours') WHERE id = ?`).run(id);
  notifySlack(`👋 해지(관리자): ${sub.company} (id=${id}, ${maskName(sub.name)}) — ${(sub.charge_amount||0).toLocaleString()}원/${sub.billing_type}${notify ? ' · SMS 발송' : ' · SMS 미발송'}`);

  // 회원에게 해지 안내 SMS — 어드민이 명시적으로 요청한 경우만 (notify=true)
  if (notify) {
    const cancelText = `[Moti Shop] ${sub.company}님, 구독이 정상적으로 해지되었어요.\n\n이후 결제는 발생하지 않으며, 구독·결제 이력은 30일간 보관됩니다.\n30일 후에는 개인정보보호법에 따라 모든 데이터가 자동 삭제됩니다.\n그 전까지는 언제든 마이페이지에서 다시 구독하실 수 있어요.\nhttps://shop.motiphysio.com/mypage`;
    sendSMS({ to: sub.phone, text: cancelText, subject: '[Moti Shop] 구독 해지 완료' }).then(r => {
      console.log(`[해지 SMS(어드민)] ${sub.company} → ${maskPhone(sub.phone)} / ok=${r.ok} / ${r.resultCode || ''} ${r.resultMsg || ''}`);
      if (!r.ok) notifySlack(`⚠️ 해지 SMS 실패(어드민): ${sub.company} (id=${id}) — ${r.resultCode} ${r.resultMsg}`);
    }).catch(e => {
      console.error('[해지 SMS 예외(어드민)]', e.message);
      notifySlack(`🔴 해지 SMS 예외(어드민): ${sub.company} (id=${id}) — ${e.message}`);
    });
  }

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

  res.json({ ok: true, billkeyDeleted: billkeyResult.ok, smsSent: !!notify });
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
  // 누적 환불(이번 + 기존)이 원 결제액에 도달하면 전액으로 간주 → 자동 해지 트리거
  // 단일 환불액만 비교하면 부분환불 누적이 전액 도달해도 isPartial=true로 잡혀 자동 해지 누락
  const totalAfterThis = Number(alreadyRefunded) + Number(refundAmount);
  const isPartial = totalAfterThis < Number(log.amount);
  const result = await refundBillKey({
    tid: log.trans_seq || '',
    amount: refundAmount,
    reason: refundReason,
    partial: isPartial,
  });

  // 설정 미완료 케이스 명확한 안내 (운영자에게 .env 점검 요청)
  if (result.resultCode === 'NO_PWD') {
    notifySlack(`🔴 환불 차단: INNOPAY_CANCEL_PWD 미설정 — EC2 .env 점검 필요 (${sub.company} id=${id})`);
    return res.status(503).json({ ok: false, msg: '환불 비밀번호가 서버에 설정되지 않았습니다. 운영자에게 문의해주세요 (.env: INNOPAY_CANCEL_PWD)', resultCode: 'NO_PWD' });
  }
  if (result.resultCode === 'NO_TID') {
    return res.status(400).json({ ok: false, msg: '거래번호(TID)가 없어 자동 환불 불가. InnoPay 가맹점 페이지에서 직접 환불해주세요.', resultCode: 'NO_TID' });
  }

  if (result.ok) {
    db.prepare(`INSERT INTO refunds (subscriber_id, moid, amount, reason, result_code, result_msg, refunded_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, log.moid, refundAmount, refundReason, result.resultCode, result.resultMsg || '', 'admin');
    notifySlack(`💸 환불 처리: ${sub.company} (id=${id}) / ${refundAmount.toLocaleString()}원 — ${refundReason}`);

    // 전액 환불 시 자동 해지 + 즉시 기능 박탈 (2026-06-22 사장님 결정)
    // 부분 환불은 서비스 유지 (운영자 의도)
    let autoCancelled = false;
    if (!isPartial && sub.status !== 'cancelled') {
      const todayKst = kstDateOnly();
      db.prepare(`UPDATE subscribers SET
        status='cancelled',
        cancelled_at = datetime('now', '+9 hours'),
        next_billing_date = ?,
        billkey_deleted = 1,
        failed_count = 0,
        last_failed_at = NULL
        WHERE id = ?`).run(todayKst, id);
      // InnoPay 빌키 삭제 — await로 결과 확인 (best-effort 였던 거 보강)
      if (sub.bill_key) {
        try {
          const { deleteBillKey } = require('./innopay');
          const dr = await deleteBillKey({ billKey: sub.bill_key, userId: sub.phone });
          console.log(`[환불자동해지 빌키삭제 ${dr.ok ? '✓' : '✗'}] ${sub.company} ${dr.resultCode || ''} ${dr.resultMsg || ''}`);
          if (!dr.ok) notifySlack(`⚠️ 환불자동해지 빌키삭제 실패: ${sub.company} (id=${id}) — ${dr.resultCode} ${dr.resultMsg}`);
        } catch (e) {
          console.error('[환불자동해지 빌키삭제 예외]', e.message);
          notifySlack(`🔴 환불자동해지 빌키삭제 예외: ${sub.company} (id=${id}) — ${e.message}`);
        }
      }
      autoCancelled = true;
      notifySlack(`👋 환불 자동 해지: ${sub.company} (id=${id}) — 전액 환불로 즉시 종료`);
    }

    // 회원에게 환불 통보 SMS — 자동 해지 여부에 따라 문구 분기
    const refundText = autoCancelled
      ? `[Moti Shop] ${sub.company}님, ${refundAmount.toLocaleString()}원 환불 처리되었어요.\n전액 환불로 구독이 즉시 종료되었어요.\n카드사 정책에 따라 영업일 3~7일 후 입금됩니다.\n문의: 070-4365-7740`
      : `[Moti Shop] ${sub.company}님, ${refundAmount.toLocaleString()}원 환불 처리되었어요.\n카드사 정책에 따라 영업일 기준 3~7일 후 입금됩니다.\n문의: 070-4365-7740`;
    sendSMS({ to: sub.phone, text: refundText, subject: '[Moti Shop] 환불 처리 완료' }).catch(e => console.error('[환불 SMS 실패]', e.message));
    return res.json({ ok: true, resultMsg: result.resultMsg, refundedAmount: refundAmount, totalRefunded: alreadyRefunded + refundAmount, autoCancelled });
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

  // 임시비번은 SMS로만 전달 (응답·로그·어드민 화면에 평문 노출 금지)
  res.json({ ok: true, smsSent: true });
});

// 관리자 — 기능 활성화 안내 SMS (서버에서 셀프 활성화 처리 후 회원에게 통보)
// 사용자(운영자)가 어드민에서 명시적 클릭으로 발송. 자동 트리거 X.
// 발송 이력은 activation_logs 테이블에 별도 기록 (subscribers 무관)
app.post('/api/admin/notify-activated', adminAuth, (req, res) => {
  const { id, operatorName } = req.body;
  if (!id) return res.status(400).json({ ok: false, msg: '필수값 누락' });
  if (!operatorName || !String(operatorName).trim()) return res.status(400).json({ ok: false, msg: '운영자 이름 필수' });

  const sub = db.prepare(`SELECT id, company, name, phone, features, status FROM subscribers WHERE id=?`).get(id);
  if (!sub) return res.status(404).json({ ok: false, msg: '가입자 없음' });
  if (sub.status === 'cancelled') return res.status(400).json({ ok: false, msg: '해지된 가입자에게는 발송하지 않습니다' });

  const operator = String(operatorName).trim().slice(0, 50);

  // 이력 row 먼저 생성 — PENDING 상태 (SMS 결과는 비동기로 업데이트)
  const insertResult = db.prepare(`
    INSERT INTO activation_logs (subscriber_id, operator_name, sms_result_code, sms_result_msg)
    VALUES (?, ?, 'PENDING', '')
  `).run(id, operator);
  const logId = insertResult.lastInsertRowid;

  const smsText = `[Moti Shop] ${sub.company} ${sub.name}님, 신청하신 구독 기능이 정상 활성화되었어요.\n\n활성화된 기능: ${displayFeatures(sub.features)}\n\n새 기능을 사용하시려면 모티피지오 프로그램을 재부팅 부탁드려요.\n이용 문의: 070-4365-7740`;

  sendSMS({ to: sub.phone, text: smsText, subject: '[Moti Shop] 구독 기능 활성화 완료' }).then(r => {
    db.prepare(`UPDATE activation_logs SET sms_result_code=?, sms_result_msg=? WHERE id=?`)
      .run(r.resultCode || (r.ok ? 'OK' : 'ERR'), (r.resultMsg || '').slice(0, 200), logId);
    console.log(`[기능활성화 SMS] ${sub.company} → ${maskPhone(sub.phone)} by ${operator} / ok=${r.ok}`);
    if (!r.ok) notifySlack(`⚠️ 기능활성화 SMS 실패: ${sub.company} (id=${id}) by ${operator} — ${r.resultCode} ${r.resultMsg}`);
  }).catch(e => {
    db.prepare(`UPDATE activation_logs SET sms_result_code='ERR', sms_result_msg=? WHERE id=?`)
      .run((e.message || '').slice(0, 200), logId);
    console.error('[기능활성화 SMS 예외]', e.message);
    notifySlack(`🔴 기능활성화 SMS 예외: ${sub.company} (id=${id}) by ${operator} — ${e.message}`);
  });

  notifySlack(`✅ 기능 활성화 안내 SMS 발송: ${sub.company} (id=${id}, ${maskName(sub.name)}) by ${operator} — ${sub.features}`);
  res.json({ ok: true, smsSent: true, logId, operator });
});

// 운영자 메모 추가 (subscribers 무관, 신규 테이블만 INSERT)
app.post('/api/admin/memos', adminAuth, (req, res) => {
  const { subscriberId, operatorName, content } = req.body || {};
  if (!subscriberId) return res.status(400).json({ ok: false, msg: '필수값 누락 (subscriberId)' });
  if (!operatorName || !String(operatorName).trim()) return res.status(400).json({ ok: false, msg: '운영자 이름 필수' });
  if (!content || !String(content).trim()) return res.status(400).json({ ok: false, msg: '메모 내용 필수' });

  const sub = db.prepare(`SELECT id FROM subscribers WHERE id=?`).get(subscriberId);
  if (!sub) return res.status(404).json({ ok: false, msg: '가입자 없음' });

  const operator = String(operatorName).trim().slice(0, 50);
  const text = String(content).trim().slice(0, 2000);

  const r = db.prepare(`
    INSERT INTO subscriber_memos (subscriber_id, operator_name, content)
    VALUES (?, ?, ?)
  `).run(subscriberId, operator, text);

  res.json({ ok: true, id: r.lastInsertRowid });
});

// 운영자 메모 삭제 (soft delete — 신규 테이블만 UPDATE, subscribers 무관)
app.delete('/api/admin/memos/:id', adminAuth, (req, res) => {
  const id = Number(req.params.id);
  const { operatorName } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, msg: '필수값 누락' });
  if (!operatorName || !String(operatorName).trim()) return res.status(400).json({ ok: false, msg: '운영자 이름 필수' });

  const memo = db.prepare(`SELECT id, deleted_at FROM subscriber_memos WHERE id=?`).get(id);
  if (!memo) return res.status(404).json({ ok: false, msg: '메모 없음' });
  if (memo.deleted_at) return res.status(400).json({ ok: false, msg: '이미 삭제된 메모' });

  const operator = String(operatorName).trim().slice(0, 50);
  db.prepare(`
    UPDATE subscriber_memos
    SET deleted_at = datetime('now', '+9 hours'), deleted_by = ?
    WHERE id = ?
  `).run(operator, id);

  res.json({ ok: true });
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

  if (!verifyPw(password, sub.pw_salt, sub.pw_hash)) return res.status(401).json({ ok: false, msg: AUTH_FAIL_MSG });

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

  // 결제 내역 + 환불 합계
  const logs = db.prepare(`
    SELECT l.id, l.moid, l.amount, l.result_code, l.result_msg, l.billed_at,
           COALESCE(SUM(CASE WHEN r.result_code='2001' THEN r.amount ELSE 0 END), 0) as refunded_amount,
           MAX(CASE WHEN r.result_code='2001' THEN r.refunded_at ELSE NULL END) as last_refunded_at,
           SUM(CASE WHEN r.result_code='PENDING' THEN 1 ELSE 0 END) as pending_refund_count
    FROM billing_logs l
    LEFT JOIN refunds r ON r.moid = l.moid AND r.subscriber_id = l.subscriber_id
    WHERE l.subscriber_id = ?
    GROUP BY l.id
    ORDER BY l.billed_at DESC LIMIT 20
  `).all(req.subscriberId);

  // 환불 상세 (상세 모달용) — 같은 moid에 여러 환불 row 가능 (부분환불 N회)
  const refunds = db.prepare(`
    SELECT id, moid, amount, reason, result_code, result_msg, refunded_at
    FROM refunds WHERE subscriber_id = ?
    ORDER BY refunded_at DESC
  `).all(req.subscriberId);

  // 해지 예정 기능 — 현재 결제 주기 내 features에서 빠진 기능 추적
  // 약관 제3조의2 ③: 변경은 다음 결제일부터 반영 → 다음 결제일까지 이용 가능
  // 결제 주기 시작 = max(마지막 성공 결제일, trial_start, created_at, 마지막 reactivate)
  const lastPayment = db.prepare(`
    SELECT billed_at FROM billing_logs
    WHERE subscriber_id = ? AND result_code IN ('0000','00')
    ORDER BY billed_at DESC LIMIT 1
  `).get(req.subscriberId);
  const lastReactivate = db.prepare(`
    SELECT changed_at FROM subscriber_changes
    WHERE subscriber_id = ? AND change_type = 'reactivate'
    ORDER BY changed_at DESC LIMIT 1
  `).get(req.subscriberId);
  const cycleStart = lastPayment?.billed_at
    || lastReactivate?.changed_at
    || sub.trial_start
    || sub.created_at;
  // 결제 주기 시작 이후 첫 features 변경 이력 → 그 before_features가 결제 주기 시작 시점 기능
  const firstChangeInCycle = db.prepare(`
    SELECT before_features FROM subscriber_changes
    WHERE subscriber_id = ? AND change_type = 'features' AND changed_at >= ?
    ORDER BY changed_at ASC LIMIT 1
  `).get(req.subscriberId, cycleStart);
  let pendingExpiry = [];
  if (firstChangeInCycle) {
    const originalFeats = (firstChangeInCycle.before_features || '').split(',').map(f => f.trim()).filter(Boolean);
    const currentFeats = (sub.features || '').split(',').map(f => f.trim()).filter(Boolean);
    pendingExpiry = originalFeats.filter(f => !currentFeats.includes(f));
  }

  res.json({ ok: true, subscriber: sub, billingLogs: logs, refunds, pendingExpiry });
});

app.post('/api/mypage/change-password', mypageAuth, (req, res) => {
  const { currentPw, newPw } = req.body;
  if (!currentPw || !newPw) return res.status(400).json({ ok: false, msg: '필수값 누락' });
  if (newPw.length < 6) return res.status(400).json({ ok: false, msg: '비밀번호는 6자 이상이어야 합니다.' });

  const sub = db.prepare(`SELECT * FROM subscribers WHERE id=?`).get(req.subscriberId);
  if (!sub) return res.status(404).json({ ok: false, msg: '가입자 없음' });
  if (!verifyPw(currentPw, sub.pw_salt, sub.pw_hash))
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
  if (!sub) return res.status(404).json({ ok: false, msg: '가입자 없음' });
  db.prepare(`UPDATE subscribers SET status='cancelled', cancelled_at = datetime('now', '+9 hours') WHERE id=?`).run(req.subscriberId);
  // 해지 후에도 마이페이지 접근 유지 (조회·환불 신청·재구독 등 안전한 액션만 가능)
  // 강제 로그아웃 제거 — 회원 UX 개선 + 재구독 흐름 자연스러움 (2026-06-22 사장님 결정)
  if (sub) {
    notifySlack(`👋 해지(셀프): ${sub.company} (id=${sub.id}, ${maskName(sub.name)}) — ${(sub.charge_amount||0).toLocaleString()}원/${sub.billing_type}`);

    // 회원에게 해지 확인 SMS (분쟁 방지 + 개인정보보호법 22조 파기 사전 통지)
    const cancelText = `[Moti Shop] ${sub.company}님, 구독이 정상적으로 해지되었어요.\n\n이후 결제는 발생하지 않으며, 구독·결제 이력은 30일간 보관됩니다.\n30일 후에는 개인정보보호법에 따라 모든 데이터가 자동 삭제됩니다.\n그 전까지는 언제든 마이페이지에서 다시 구독하실 수 있어요.\nhttps://shop.motiphysio.com/mypage`;
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
  let { features, billingType, billKey, moid, amount, ownerType, businessNumber } = req.body;
  if (!features || !Array.isArray(features) || features.length === 0 || !billingType || !billKey || !amount) {
    return res.status(400).json({ ok: false, msg: '필수 파라미터 누락' });
  }
  // billingType allowlist 검증
  if (billingType !== 'monthly' && billingType !== 'annual') {
    return res.status(400).json({ ok: false, msg: '잘못된 구독 유형입니다.' });
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
  // 가격표 sync 검증 — 알 수 없는 키 차단
  const unknownFeats = features.filter(f => !(f in prices));
  if (unknownFeats.length > 0) {
    notifySlack(`🔴 재구독 알 수 없는 기능 키: ${unknownFeats.join(', ')} (subscriber_id=${req.subscriberId})`);
    return res.status(400).json({ ok: false, msg: `알 수 없는 기능: ${unknownFeats.join(', ')}` });
  }
  const reactBundle = getBundle(features);
  if (reactBundle) features = [reactBundle];  // 번들이면 단독으로 (let 선언이라 재할당 가능)
  const featStr = features.join(', ');
  const monthlyAmount = reactBundle ? prices[reactBundle] : features.reduce((s, f) => s + (prices[f] || 0), 0);
  const chargeAmount = billingType === 'annual' ? monthlyAmount * 12 : monthlyAmount;
  if (!Number.isFinite(chargeAmount) || chargeAmount < 100) {
    return res.status(400).json({ ok: false, msg: '결제 금액이 올바르지 않습니다.' });
  }
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
    goodsName: '모티샵 구독',
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

  // 다음 결제일 = today + 1개월/1년 (scheduler addPeriod 사용 — 월말 clamp + KST 일관)
  const nextBilling = addPeriod(kstDateOnly(), billingType);

  // 변경 이력 기록
  db.prepare(`INSERT INTO subscriber_changes
    (subscriber_id, change_type, before_features, after_features, before_billing_type, after_billing_type, before_amount, after_amount)
    VALUES (?, 'reactivate', ?, ?, ?, ?, ?, ?)`)
    .run(req.subscriberId, sub.features, featStr, sub.billing_type, billingType, sub.charge_amount, chargeAmount);

  // 가입자 정보 갱신 (재구독 시 명의 변경 가능 + trial_start 갱신 — 새 사이클 시작)
  db.prepare(`UPDATE subscribers SET
    features=?, billing_type=?, bill_key=?, moid=?, charge_amount=?, business_number=?,
    trial_start=?, next_billing_date=?, status='active', billkey_deleted=0, notified_7d=0, notified_1d=0, cancelled_at=NULL, failed_count=0, last_failed_at=NULL
    WHERE id=?`).run(featStr, billingType, billKey, newMoid, chargeAmount, nextBiz, kstDateOnly(), nextBilling, req.subscriberId);

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

// 기능 추가/해지 — 2026-06-22 변경: 기능 추가 시 일할 계산하여 즉시 결제
// 동시 호출 차단(in-flight) + 결제↔DB 트랜잭션 + daysRemaining 상한 + rate-limit
app.post('/api/mypage/update-features', paymentActionLimiter, mypageAuth, async (req, res) => {
  let { features } = req.body;
  if (!features || !Array.isArray(features) || features.length === 0)
    return res.status(400).json({ ok: false, msg: '기능을 하나 이상 선택해주세요.' });

  // 동시 호출 차단 (같은 가입자 이중 결제 방지)
  if (updateFeaturesInFlight.has(req.subscriberId)) {
    return res.status(409).json({ ok: false, msg: '이전 요청을 처리 중입니다. 잠시 후 다시 시도해주세요.' });
  }
  updateFeaturesInFlight.add(req.subscriberId);

  try {
    const sub = db.prepare(`SELECT * FROM subscribers WHERE id=?`).get(req.subscriberId);
    if (!sub) return res.status(404).json({ ok: false, msg: '가입자 없음' });
    if (sub.status === 'cancelled')
      return res.status(403).json({ ok: false, msg: '해지된 계정은 변경할 수 없습니다.' });
    const prices = FEATURE_PRICES[sub.billing_type] || FEATURE_PRICES.monthly;

    const unknownFeats = features.filter(f => !(f in prices));
    if (unknownFeats.length > 0) {
      notifySlack(`🔴 알 수 없는 기능 키: ${unknownFeats.join(', ')} (subscriber_id=${req.subscriberId}) — 가격표 동기화 점검 필요`);
      return res.status(400).json({ ok: false, msg: `알 수 없는 기능: ${unknownFeats.join(', ')}` });
    }

    const oldFeatures = (sub.features || '').split(',').map(f => f.trim()).filter(Boolean);
    const oldBundle = getBundle(oldFeatures);
    const newBundle = getBundle(features);
    if (oldBundle && oldBundle !== newBundle) {
      return res.status(403).json({
        ok: false,
        msg: '묶음 상품(ALL IN ONE PLUS · LITE) 변경은 자동 처리되지 않습니다.\n변경을 원하시면 현재 구독 해지 후 재가입해 주세요.\n자세한 안내는 고객센터(070-4365-7740 · 카카오톡)로 문의 부탁드립니다.'
      });
    }

    let newAmount;
    if (newBundle) {
      features = [newBundle];
      newAmount = prices[newBundle];
    } else {
      newAmount = features.reduce((sum, f) => sum + prices[f], 0);
    }
    if (!Number.isFinite(newAmount) || newAmount <= 0) {
      return res.status(400).json({ ok: false, msg: '결제액 계산 실패 — 운영자에게 문의해주세요.' });
    }

    // 추가된 기능 식별 (제거는 일할 환불 X — 정책: 다음 결제일까지 사용 가능)
    const oldSet = new Set(oldFeatures);
    const addedFeatures = features.filter(f => !oldSet.has(f));
    const shouldChargeNow = addedFeatures.length > 0 && sub.status === 'active';

    const featStr = features.join(', ');
    let prorateInfo = null;

    if (shouldChargeNow) {
      if (!sub.bill_key || sub.billkey_deleted) {
        return res.status(400).json({ ok: false, msg: '카드 정보가 없거나 만료되었습니다. 카드 정보 갱신 후 다시 시도해주세요.' });
      }
      const addedPrice = addedFeatures.reduce((sum, f) => sum + prices[f], 0);
      const todayKst = kstDateOnly();
      const nextDate = sub.next_billing_date;
      const cycleDays = sub.billing_type === 'annual' ? 365 : 30;
      // daysRemaining 상한·하한 가드: 1 ≤ x ≤ cycleDays (next_billing_date 비정상 시 안전)
      const rawDays = Math.ceil((new Date(nextDate + 'T00:00:00+09:00') - new Date(todayKst + 'T00:00:00+09:00')) / 86400000);
      const daysRemaining = Math.min(cycleDays, Math.max(1, rawDays));
      if (rawDays < 0 || rawDays > cycleDays) {
        notifySlack(`⚠️ daysRemaining 비정상: ${sub.company} (id=${sub.id}) raw=${rawDays} / 가드값=${daysRemaining} (next=${nextDate}, today=${todayKst})`);
      }
      const prorateAmount = Math.max(100, Math.round(addedPrice * daysRemaining / cycleDays));

      const { chargeWithRetry } = require('./innopay');
      const moid = todayKst.replace(/-/g, '') + Math.floor(1000 + Math.random() * 9000);
      const chargeResult = await chargeWithRetry({
        billKey: sub.bill_key,
        moid,
        amount: prorateAmount,
        goodsName: '모티샵 구독',
        buyerName: sub.name,
        userId: sub.phone,
      });
      const tid = (chargeResult.raw && (chargeResult.raw.tid || chargeResult.raw.pgTid || chargeResult.raw.transSeq)) || '';

      if (!chargeResult.ok) {
        // 결제 실패는 billing_logs에만 기록, DB UPDATE 안 함
        db.prepare(`INSERT INTO billing_logs (subscriber_id, moid, amount, result_code, result_msg, trans_seq) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(req.subscriberId, moid, prorateAmount, chargeResult.resultCode || 'ERR', chargeResult.resultMsg || '', tid);
        notifySlack(`🔴 기능 추가 결제 실패: ${sub.company} (id=${sub.id}) — ${addedFeatures.join(', ')} / ${prorateAmount.toLocaleString()}원 / ${chargeResult.resultCode} ${chargeResult.resultMsg}`);
        return res.status(502).json({
          ok: false,
          msg: '기능 추가를 위한 결제에 실패했습니다. 카드 정보를 확인하고 다시 시도해주세요.',
          resultCode: chargeResult.resultCode,
          resultMsg: chargeResult.resultMsg,
        });
      }

      // 결제 성공 — billing_logs + subscriber_changes(features + prorate_charge) + subscribers 원자적 처리
      const tx = db.transaction(() => {
        db.prepare(`INSERT INTO billing_logs (subscriber_id, moid, amount, result_code, result_msg, trans_seq) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(req.subscriberId, moid, prorateAmount, chargeResult.resultCode, chargeResult.resultMsg || '', tid);
        if (sub.features !== featStr || sub.charge_amount !== newAmount) {
          db.prepare(`INSERT INTO subscriber_changes
            (subscriber_id, change_type, before_features, after_features, before_amount, after_amount)
            VALUES (?, 'features', ?, ?, ?, ?)`).run(req.subscriberId, sub.features, featStr, sub.charge_amount, newAmount);
        }
        // 일할 결제 별도 이력 기록 (어드민 추적 + 회계 감사 용)
        db.prepare(`INSERT INTO subscriber_changes
          (subscriber_id, change_type, before_features, after_features, before_amount, after_amount)
          VALUES (?, 'prorate_charge', ?, ?, ?, ?)`).run(req.subscriberId, sub.features, addedFeatures.join(', '), 0, prorateAmount);
        db.prepare(`UPDATE subscribers SET features=?, charge_amount=? WHERE id=?`)
          .run(featStr, newAmount, req.subscriberId);
      });
      tx();

      notifySlack(`💳 기능 추가 일할 결제: ${sub.company} (id=${sub.id}) — ${addedFeatures.join(', ')} / ${prorateAmount.toLocaleString()}원 (${daysRemaining}일/${cycleDays}일)`);
      prorateInfo = { addedFeatures, addedPrice, daysRemaining, cycleDays, prorateAmount, nextBillingDate: nextDate };
    } else {
      // 결제 없는 경우 (제거만 / trial / 변경 없음) — 일반 UPDATE (트랜잭션)
      const tx = db.transaction(() => {
        if (sub.features !== featStr || sub.charge_amount !== newAmount) {
          db.prepare(`INSERT INTO subscriber_changes
            (subscriber_id, change_type, before_features, after_features, before_amount, after_amount)
            VALUES (?, 'features', ?, ?, ?, ?)`).run(req.subscriberId, sub.features, featStr, sub.charge_amount, newAmount);
        }
        db.prepare(`UPDATE subscribers SET features=?, charge_amount=? WHERE id=?`)
          .run(featStr, newAmount, req.subscriberId);
      });
      tx();
    }

    console.log(`[기능변경] ${sub.company} → ${featStr} / ${newAmount}원${prorateInfo ? ` (일할 ${prorateInfo.prorateAmount}원 결제)` : ''}`);
    res.json({ ok: true, features: featStr, charge_amount: newAmount, prorate: prorateInfo });
  } finally {
    updateFeaturesInFlight.delete(req.subscriberId);
  }
});

// 일할 계산 견적 — 모달에 상세 안내 표시용 (실제 결제 X)
app.post('/api/mypage/preview-feature-add', mypageAuth, (req, res) => {
  const { features } = req.body;
  if (!features || !Array.isArray(features) || features.length === 0) {
    return res.status(400).json({ ok: false, msg: '기능 선택 없음' });
  }
  const sub = db.prepare(`SELECT * FROM subscribers WHERE id=?`).get(req.subscriberId);
  if (!sub || sub.status === 'cancelled') return res.status(403).json({ ok: false, msg: '해지된 계정' });
  const prices = FEATURE_PRICES[sub.billing_type] || FEATURE_PRICES.monthly;
  const oldFeatures = (sub.features || '').split(',').map(f => f.trim()).filter(Boolean);
  const oldSet = new Set(oldFeatures);
  const addedFeatures = features.filter(f => !oldSet.has(f) && f in prices);

  if (addedFeatures.length === 0 || sub.status !== 'active') {
    // 추가가 없거나 trial이면 일할 결제 없음 — 다음 결제일에 새 금액
    const newAmount = features.reduce((sum, f) => sum + (prices[f] || 0), 0);
    return res.json({ ok: true, immediateCharge: false, newAmount, nextBillingDate: sub.next_billing_date });
  }

  const addedPrice = addedFeatures.reduce((sum, f) => sum + prices[f], 0);
  const todayKst = kstDateOnly();
  const daysRemaining = Math.max(1, Math.ceil((new Date(sub.next_billing_date + 'T00:00:00+09:00') - new Date(todayKst + 'T00:00:00+09:00')) / 86400000));
  const cycleDays = sub.billing_type === 'annual' ? 365 : 30;
  const prorateAmount = Math.max(100, Math.round(addedPrice * daysRemaining / cycleDays));
  const newAmount = features.reduce((sum, f) => sum + (prices[f] || 0), 0);

  res.json({
    ok: true,
    immediateCharge: true,
    addedFeatures,
    addedPrice,           // 추가된 기능 1개월 전체 금액
    daysRemaining,        // 다음 결제일까지 남은 일수
    cycleDays,            // 결제 주기 일수 (월=30, 연=365)
    prorateAmount,        // 즉시 결제될 일할 금액
    nextBillingDate: sub.next_billing_date,
    newAmount,            // 다음 결제일 청구액 (변경 후 전체)
  });
});

// 구독 유형 변경 (월↔연) — 정책: 다음 결제일은 유지, 다음 결제일부터 새 주기·금액 적용
// 2026-06-22 수정: 가격표 검증, 0원/음수 차단, 연→월 다운그레이드 매출 회피 방지
app.post('/api/mypage/change-billing-type', mypageAuth, (req, res) => {
  const { billingType } = req.body;
  if (billingType !== 'monthly' && billingType !== 'annual')
    return res.status(400).json({ ok: false, msg: '잘못된 구독 유형입니다.' });

  const sub = db.prepare(`SELECT * FROM subscribers WHERE id=?`).get(req.subscriberId);
  if (!sub) return res.status(404).json({ ok: false, msg: '가입자 없음' });
  if (sub.status === 'cancelled') return res.status(403).json({ ok: false, msg: '해지된 계정은 변경할 수 없습니다.' });
  if (sub.billing_type === billingType) {
    return res.json({ ok: true, billing_type: billingType, charge_amount: sub.charge_amount, changed: false });
  }

  const prices = FEATURE_PRICES[billingType];
  const features = (sub.features || '').split(',').map(f => f.trim()).filter(Boolean);

  // 가격표 sync 검증 — 알 수 없는 키 차단 (0원 청구 방지)
  const unknownFeats = features.filter(f => !(f in prices));
  if (unknownFeats.length > 0) {
    notifySlack(`🔴 구독유형변경 알 수 없는 기능 키: ${unknownFeats.join(', ')} (subscriber_id=${req.subscriberId})`);
    return res.status(400).json({ ok: false, msg: `가격표 불일치 기능: ${unknownFeats.join(', ')} — 운영자에게 문의해주세요.` });
  }

  const billingBundle = getBundle(features);
  const newAmount = billingBundle
    ? prices[billingBundle]
    : features.reduce((sum, f) => sum + prices[f], 0);

  if (!Number.isFinite(newAmount) || newAmount < 100) {
    return res.status(400).json({ ok: false, msg: '계산된 결제액이 올바르지 않습니다.' });
  }

  // 매출 회피 방지: 연→월 다운그레이드는 next_billing_date까지 유지 후 그날부터 새 주기 적용
  // 즉 현재 연간 사이클이 끝날 때까지는 변경 금액 청구 불가 (next_billing_date 그대로지만
  // billing_type/charge_amount 즉시 갱신하면 next 결제일에 1개월치만 청구되어 매출 누수)
  // 정책: billing_type 변경은 다음 결제일 이후부터 적용. 그때까지는 charge_amount/billing_type 유지.
  // → 변경 예약만 기록하고 next_billing_date 도래 시 적용 (subscriber_changes에 pending 표시)
  // 운영 단순화 위해: 다운그레이드(연→월)는 다음 결제일에 charge_amount만 갱신되도록 cron에 위임.
  // 여기서는 즉시 변경 금지하고 안내.
  if (sub.billing_type === 'annual' && billingType === 'monthly') {
    return res.status(403).json({
      ok: false,
      msg: '연구독에서 월구독으로의 즉시 전환은 자동 처리되지 않습니다.\n현재 연간 사이클이 끝난 후 변경하실 수 있어요. 자세한 안내는 070-4365-7740으로 문의해주세요.'
    });
  }

  // 월→연 업그레이드는 즉시 적용 가능 (사용자에게 유리·매출 보호)
  const tx = db.transaction(() => {
    if (sub.billing_type !== billingType || sub.charge_amount !== newAmount) {
      db.prepare(`INSERT INTO subscriber_changes
        (subscriber_id, change_type, before_billing_type, after_billing_type, before_amount, after_amount)
        VALUES (?, 'billing_type', ?, ?, ?, ?)`).run(req.subscriberId, sub.billing_type, billingType, sub.charge_amount, newAmount);
    }
    db.prepare(`UPDATE subscribers SET billing_type=?, charge_amount=? WHERE id=?`)
      .run(billingType, newAmount, req.subscriberId);
  });
  tx();

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

// Ruby 서브앱 자동 배포 — shop webhook과 동일 패턴(GitHub HMAC + 디바운스 + spawn detached)
// 디바운스 변수는 shop과 분리 (각 앱 독립 트리거)
let _lastRubyDeployAt = 0;
app.post('/api/ruby/deploy/webhook', (req, res) => {
  if (!cfg.RUBY_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'ruby webhook disabled' });
  }
  const sig = req.header('X-Hub-Signature-256') || '';
  const expected = 'sha256=' + crypto
    .createHmac('sha256', cfg.RUBY_WEBHOOK_SECRET)
    .update(req.rawBody || Buffer.alloc(0))
    .digest('hex');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    console.warn('[ruby-webhook] 서명 불일치');
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

  const now = Date.now();
  if (now - _lastRubyDeployAt < DEPLOY_DEBOUNCE_MS) {
    const skipMs = DEPLOY_DEBOUNCE_MS - (now - _lastRubyDeployAt);
    console.log(`[ruby-webhook] 디바운스 스킵 ${headCommit} (${skipMs}ms 남음)`);
    return res.json({ ok: true, debounced: true, commit: headCommit, retryAfterMs: skipMs });
  }
  _lastRubyDeployAt = now;
  console.log(`[ruby-webhook] 배포 트리거 ${headCommit}`);

  const { spawn } = require('child_process');
  let child;
  try {
    child = spawn(cfg.RUBY_DEPLOY_SCRIPT_PATH, [], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, COMMIT: headCommit },
    });
    child.on('error', (e) => {
      console.error('[ruby-webhook] spawn 에러:', e.message);
      notifySlack(`🔴 Ruby 배포 spawn 실패: ${headCommit} / ${e.message}`);
    });
    child.unref();
  } catch (e) {
    console.error('[ruby-webhook] spawn 동기 예외:', e.message);
    return res.status(500).json({ error: 'spawn failed', detail: e.message });
  }

  res.json({ ok: true, deploying: true, commit: headCommit, app: 'ruby' });
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
_safeStart('scheduleAutoDeletePreNotice', scheduleAutoDeletePreNotice);
_safeStart('scheduleAutoDelete', scheduleAutoDelete);
_safeStart('scheduleSolapiBalance', scheduleSolapiBalance);
_safeStart('scheduleDbBackup', scheduleDbBackup);
_safeStart('scheduleAnalyticsCleanup', scheduleAnalyticsCleanup);
_safeStart('scheduleSitemapUpdate', scheduleSitemapUpdate);

app.listen(3001, '127.0.0.1', () => {
  console.log(`MotiShop API listening on port 3001 (MID=${cfg.INNOPAY_MID}, CORS=${cfg.CORS_ORIGIN})`);
});
