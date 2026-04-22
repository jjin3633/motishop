const express = require('express');
const db = require('./db');
const { scheduleBilling } = require('./scheduler');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://shop.motiphysio.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// 구독 등록 — 카드 등록 성공 후 프론트에서 호출
app.post('/api/subscribe', (req, res) => {
  const { company, name, phone, features, billingType, billKey, moid, amount } = req.body;

  if (!company || !name || !phone || !features || !billingType || !billKey || !amount) {
    return res.status(400).json({ ok: false, msg: '필수 파라미터 누락' });
  }

  // 체험 시작일 + 30일 후 첫 결제
  const trialStart = new Date().toISOString().slice(0, 10);
  const firstBilling = new Date();
  firstBilling.setDate(firstBilling.getDate() + 30);
  const nextBillingDate = firstBilling.toISOString().slice(0, 10);

  // 실제 청구액: 월구독=amount, 연구독=amount*12
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

// 관리자용 API — localhost에서만 접근 가능
function localOnly(req, res, next) {
  if (req.ip === '127.0.0.1' || req.ip === '::1') return next();
  res.status(403).json({ ok: false, msg: 'Forbidden' });
}

app.get('/api/subscribers', localOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT id, company, name, phone, features, billing_type,
           charge_amount, trial_start, next_billing_date, status, created_at
    FROM subscribers ORDER BY created_at DESC
  `).all();
  res.json(rows);
});

app.get('/api/logs', localOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT l.*, s.company, s.name
    FROM billing_logs l
    JOIN subscribers s ON l.subscriber_id = s.id
    ORDER BY l.billed_at DESC LIMIT 100
  `).all();
  res.json(rows);
});

app.post('/api/cancel', localOnly, (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ ok: false });
  db.prepare(`UPDATE subscribers SET status = 'cancelled' WHERE id = ?`).run(id);
  res.json({ ok: true });
});

scheduleBilling();

app.listen(3001, '127.0.0.1', () => {
  console.log('MotiShop API listening on port 3001');
});
