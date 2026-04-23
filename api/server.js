const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { scheduleBilling } = require('./scheduler');

const app = express();
app.use(express.json());

const ADMIN_PW = 'tmdwls12!@';

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://shop.motiphysio.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-pw, x-session-token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── 유틸 ──
function hashPw(pw, salt) {
  return crypto.createHmac('sha256', salt).update(pw).digest('hex');
}
function genSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── 구독 등록 ──
app.post('/api/subscribe', (req, res) => {
  const { company, name, phone, features, billingType, billKey, moid, amount } = req.body;
  if (!company || !name || !phone || !features || !billingType || !billKey || !amount)
    return res.status(400).json({ ok: false, msg: '필수 파라미터 누락' });

  const trialStart = new Date().toISOString().slice(0, 10);
  const firstBilling = new Date();
  firstBilling.setDate(firstBilling.getDate() + 30);
  const nextBillingDate = firstBilling.toISOString().slice(0, 10);
  const chargeAmount = billingType === 'annual' ? amount * 12 : amount;

  try {
    db.prepare(`
      INSERT INTO subscribers
        (company, name, phone, features, billing_type, bill_key, moid, charge_amount, trial_start, next_billing_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(company, name, phone, features, billingType, billKey, moid, chargeAmount, trialStart, nextBillingDate);
    console.log(`[신규 가입] ${company} / ${name} / ${billingType} / 첫 결제일: ${nextBillingDate}`);
    res.json({ ok: true, trialStart, nextBillingDate });
  } catch (e) {
    console.error('[DB 오류]', e.message);
    res.status(500).json({ ok: false, msg: 'DB 저장 실패' });
  }
});

// ── 관리자 페이지 ──
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

function adminAuth(req, res, next) {
  if (req.headers['x-admin-pw'] === ADMIN_PW) return next();
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

app.get('/api/revenue', adminAuth, (req, res) => {
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const thisYear  = now.getFullYear().toString();

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

app.post('/api/cancel', adminAuth, (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ ok: false });
  db.prepare(`UPDATE subscribers SET status = 'cancelled' WHERE id = ?`).run(id);
  res.json({ ok: true });
});

// 관리자 — 구독자 비밀번호 설정
app.post('/api/admin/set-password', adminAuth, (req, res) => {
  const { id, password } = req.body;
  if (!id || !password) return res.status(400).json({ ok: false, msg: '필수값 누락' });
  const salt = genSalt();
  const hash = hashPw(password, salt);
  db.prepare(`UPDATE subscribers SET pw_hash=?, pw_salt=? WHERE id=?`).run(hash, salt, id);
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

app.post('/api/mypage/login', (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ ok: false, msg: '전화번호와 비밀번호를 입력해주세요.' });

  const sub = db.prepare(`SELECT * FROM subscribers WHERE phone=?`).get(phone.replace(/[^0-9]/g, ''));
  if (!sub) return res.status(401).json({ ok: false, msg: '등록되지 않은 전화번호입니다.' });
  if (!sub.pw_hash) return res.status(401).json({ ok: false, msg: '비밀번호가 설정되지 않았습니다. 담당자에게 문의해주세요.' });

  const hash = hashPw(password, sub.pw_salt);
  if (hash !== sub.pw_hash) return res.status(401).json({ ok: false, msg: '비밀번호가 올바르지 않습니다.' });

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

app.post('/api/mypage/cancel', mypageAuth, (req, res) => {
  db.prepare(`UPDATE subscribers SET status='cancelled' WHERE id=?`).run(req.subscriberId);
  db.prepare(`DELETE FROM sessions WHERE subscriber_id=?`).run(req.subscriberId);
  res.json({ ok: true });
});

scheduleBilling();

app.listen(3001, '127.0.0.1', () => {
  console.log('MotiShop API listening on port 3001');
});
