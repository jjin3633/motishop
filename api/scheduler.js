const cron = require('node-cron');
const db = require('./db');
const cfg = require('./config');
const { chargeWithRetry, notifySlack } = require('./innopay');

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

function daysFromToday(dateStr) {
  const today = new Date(new Date().toISOString().slice(0, 10));
  const target = new Date(dateStr);
  return Math.round((target - today) / (24 * 60 * 60 * 1000));
}

async function chargeSubscriber(sub) {
  const moid = genMoid();

  const result = await chargeWithRetry({
    billKey: sub.bill_key,
    moid,
    amount: sub.charge_amount,
    goodsName: '모티피지오 구독',
    buyerName: sub.name,
    buyerTel: sub.phone,
  });

  // 모든 결과 로그 기록 (성공/실패/재시도)
  db.prepare(`INSERT INTO billing_logs (subscriber_id, moid, amount, result_code, result_msg) VALUES (?, ?, ?, ?, ?)`)
    .run(sub.id, moid, sub.charge_amount, result.resultCode || 'ERR', result.resultMsg || '');

  if (result.ok) {
    const next = addPeriod(sub.next_billing_date, sub.billing_type);
    db.prepare(`UPDATE subscribers SET next_billing_date = ?, status = 'active', notified_7d = 0, notified_1d = 0 WHERE id = ?`)
      .run(next, sub.id);
    console.log(`[✓ 결제성공] ${sub.company} / ${sub.charge_amount.toLocaleString()}원 → 다음: ${next}`);
  } else {
    console.error(`[✗ 결제실패] ${sub.company} / ${result.resultCode} ${result.resultMsg}`);
    notifySlack(`🔴 결제실패: ${sub.company} (id=${sub.id}) / ${sub.charge_amount.toLocaleString()}원\n사유: ${result.resultCode} ${result.resultMsg}`);
  }
}

/**
 * 사전 안내 발송 플래그 처리 (실제 SMS/이메일 발송은 미구현 — 로그만)
 */
function markPreNotification(sub, daysLeft) {
  if (daysLeft === 7 && !sub.notified_7d) {
    console.log(`[사전안내 7일전] ${sub.company} / 다음 결제일: ${sub.next_billing_date}`);
    db.prepare(`UPDATE subscribers SET notified_7d = 1 WHERE id = ?`).run(sub.id);
    if (cfg.NOTIFY_ENABLED) {
      // TODO: SMS/이메일 발송 연동
      notifySlack(`📨 사전안내(7일전): ${sub.company} / ${sub.next_billing_date} / ${sub.charge_amount.toLocaleString()}원`);
    }
  }
  if (daysLeft === 1 && !sub.notified_1d) {
    console.log(`[사전안내 1일전] ${sub.company} / 내일 결제: ${sub.next_billing_date}`);
    db.prepare(`UPDATE subscribers SET notified_1d = 1 WHERE id = ?`).run(sub.id);
    if (cfg.NOTIFY_ENABLED) {
      notifySlack(`📨 사전안내(1일전): ${sub.company} / ${sub.next_billing_date} / ${sub.charge_amount.toLocaleString()}원`);
    }
  }
}

function runBillingPass() {
  const today = new Date().toISOString().slice(0, 10);

  // 활성/체험 가입자 중 결제 임박한 건들
  const targets = db.prepare(
    `SELECT * FROM subscribers WHERE status IN ('trial', 'active')`
  ).all();

  let dueCount = 0;
  for (const sub of targets) {
    const daysLeft = daysFromToday(sub.next_billing_date);

    // 사전 안내
    if (daysLeft === 7 || daysLeft === 1) markPreNotification(sub, daysLeft);

    // 결제일 도래
    if (daysLeft <= 0) dueCount++;
  }

  const due = db.prepare(
    `SELECT * FROM subscribers WHERE next_billing_date <= ? AND status IN ('trial', 'active')`
  ).all(today);

  console.log(`[스케줄러] ${today} — 결제 대상 ${due.length}건 / 전체 대상 ${targets.length}건`);
  return due;
}

async function processDueBillings() {
  const due = runBillingPass();
  for (const sub of due) {
    await chargeSubscriber(sub);
  }
}

function scheduleBilling() {
  // 매일 KST 09:00 실행
  cron.schedule('0 9 * * *', async () => {
    try {
      await processDueBillings();
    } catch (e) {
      console.error('[스케줄러 오류]', e);
      notifySlack(`🔴 스케줄러 예외: ${e.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  console.log('결제 스케줄러 시작 (매일 09:00 KST · 사전안내 7일/1일 전 · 재시도 2회)');
}

module.exports = { scheduleBilling, chargeSubscriber, processDueBillings };
