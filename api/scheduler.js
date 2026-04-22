const cron = require('node-cron');
const axios = require('axios');
const db = require('./db');

const MID = 'pgmotiph1m';
const CHARGE_URL = 'https://api.innopay.co.kr/api/payAutoCardBill';

function pad(n) { return String(n).padStart(2, '0'); }

function genMoid() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}${Math.floor(1000 + Math.random() * 9000)}`;
}

function addPeriod(dateStr, billingType) {
  const d = new Date(dateStr);
  if (billingType === 'monthly') d.setMonth(d.getMonth() + 1);
  else d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

async function chargeSubscriber(sub) {
  const moid = genMoid();

  try {
    const { data } = await axios.post(CHARGE_URL, {
      mid: MID,
      billKey: sub.bill_key,
      moid,
      amount: sub.charge_amount,
      goodsName: `모티피지오 구독`,
      buyerName: sub.name,
      buyerTel: sub.phone,
    }, { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 15000 });

    const success = data.resultCode === '00';

    db.prepare(`INSERT INTO billing_logs (subscriber_id, moid, amount, result_code, result_msg) VALUES (?, ?, ?, ?, ?)`)
      .run(sub.id, moid, sub.charge_amount, data.resultCode, data.resultMsg || '');

    if (success) {
      const next = addPeriod(sub.next_billing_date, sub.billing_type);
      db.prepare(`UPDATE subscribers SET next_billing_date = ?, status = 'active' WHERE id = ?`)
        .run(next, sub.id);
      console.log(`[✓ 결제성공] ${sub.company} / ${sub.charge_amount.toLocaleString()}원 → 다음: ${next}`);
    } else {
      console.error(`[✗ 결제실패] ${sub.company} / ${data.resultMsg}`);
    }
  } catch (e) {
    console.error(`[✗ 결제오류] ${sub.company}:`, e.message);
    db.prepare(`INSERT INTO billing_logs (subscriber_id, moid, amount, result_code, result_msg) VALUES (?, ?, ?, ?, ?)`)
      .run(sub.id, moid, sub.charge_amount, 'ERR', e.message);
  }
}

function scheduleBilling() {
  // 매일 KST 09:00 실행
  cron.schedule('0 9 * * *', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const due = db.prepare(
      `SELECT * FROM subscribers WHERE next_billing_date <= ? AND status IN ('trial', 'active')`
    ).all(today);

    console.log(`[스케줄러] ${today} — 결제 대상 ${due.length}건`);
    for (const sub of due) {
      await chargeSubscriber(sub);
    }
  }, { timezone: 'Asia/Seoul' });

  console.log('결제 스케줄러 시작 (매일 09:00 KST)');
}

module.exports = { scheduleBilling };
