const cron = require('node-cron');
const db = require('./db');
const cfg = require('./config');
const { chargeWithRetry, notifySlack } = require('./innopay');

function pad(n) { return String(n).padStart(2, '0'); }

// KST 기준 YYYY-MM-DD
function kstDateOnly(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
}

function genMoid() {
  const ymd = kstDateOnly().replace(/-/g, ''); // YYYYMMDD (KST)
  return `${ymd}${Math.floor(1000 + Math.random() * 9000)}`;
}

function addPeriod(dateStr, billingType) {
  const d = new Date(dateStr);
  if (billingType === 'monthly') d.setMonth(d.getMonth() + 1);
  else d.setFullYear(d.getFullYear() + 1);
  return kstDateOnly(d);
}

function daysFromToday(dateStr) {
  const today = new Date(kstDateOnly() + 'T00:00:00+09:00');
  const target = new Date(dateStr + 'T00:00:00+09:00');
  return Math.round((target - today) / (24 * 60 * 60 * 1000));
}

async function chargeSubscriber(sub) {
  // 멱등성: 같은 가입자 + 결제예정일 조합으로 이미 성공한 결제가 있으면 스킵
  const today = kstDateOnly();
  const dup = db.prepare(`
    SELECT id FROM billing_logs
    WHERE subscriber_id = ? AND result_code = '0000'
      AND DATE(billed_at) = DATE(?)
    LIMIT 1
  `).get(sub.id, today + ' 00:00:00');
  if (dup) {
    console.log(`[스킵] ${sub.company} — 오늘 이미 성공 결제 존재 (log_id=${dup.id})`);
    return;
  }

  const moid = genMoid();

  const result = await chargeWithRetry({
    billKey: sub.bill_key,
    moid,
    amount: sub.charge_amount,
    goodsName: '모티피지오 구독',
    buyerName: sub.name,
    userId: sub.phone,  // 등록 시점과 동일한 userId (phone)
  });

  // 모든 결과 로그 기록 (성공/실패/재시도) — tid는 환불 시 필요 (InnoPay cancelApi)
  const tid = (result.raw && (result.raw.tid || result.raw.pgTid || result.raw.transSeq || result.raw.tno)) || '';
  db.prepare(`INSERT INTO billing_logs (subscriber_id, moid, amount, result_code, result_msg, trans_seq) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(sub.id, moid, sub.charge_amount, result.resultCode || 'ERR', result.resultMsg || '', tid);

  if (result.ok) {
    const next = addPeriod(sub.next_billing_date, sub.billing_type);
    db.prepare(`UPDATE subscribers SET next_billing_date = ?, status = 'active', notified_7d = 0, notified_1d = 0 WHERE id = ?`)
      .run(next, sub.id);
    console.log(`[✓ 결제성공] ${sub.company} / ${sub.charge_amount.toLocaleString()}원 → 다음: ${next}`);
  } else {
    console.error(`[✗ 결제실패] ${sub.company} / ${result.resultCode} ${result.resultMsg}`);
    notifySlack(`🔴 결제실패: ${sub.company} (id=${sub.id}) / ${sub.charge_amount.toLocaleString()}원\n사유: ${result.resultCode} ${result.resultMsg}`);

    // B. 결제실패 임계치 — 최근 1시간 내 3건 이상 실패 시 추가 알림
    try {
      const recent = db.prepare(`
        SELECT COUNT(*) AS n FROM billing_logs
        WHERE result_code NOT IN ('0000', '00')
          AND billed_at > datetime('now', '+9 hours', '-1 hour')
      `).get();
      if (recent && recent.n >= 3) {
        notifySlack(`⚠️ 결제실패 임계치 초과: 최근 1시간 내 ${recent.n}건 실패 — 시스템 점검 권장`);
      }
    } catch (e) { /* ignore */ }
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
  const today = kstDateOnly();

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
  // 동시 실행 방지 (multi-instance 환경 대비) — 5분 이상 묵은 lock은 stale로 간주
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const lockResult = db.prepare(`
    INSERT INTO scheduler_locks (name, locked_at, pid) VALUES ('billing', datetime('now'), ?)
    ON CONFLICT(name) DO UPDATE SET locked_at = datetime('now'), pid = excluded.pid
    WHERE locked_at < ?
  `).run(process.pid, fiveMinAgo);

  if (lockResult.changes === 0) {
    console.warn('[스케줄러] 다른 인스턴스가 이미 실행 중 — 스킵');
    return;
  }

  try {
    const due = runBillingPass();
    for (const sub of due) {
      await chargeSubscriber(sub);
    }
  } finally {
    db.prepare(`DELETE FROM scheduler_locks WHERE name = 'billing' AND pid = ?`).run(process.pid);
  }
}

// C. 헬스체크 자가 모니터 — 5분 간격 DB 쿼리 실패 시 Slack
function scheduleHealthCheck() {
  let consecutiveFails = 0;
  cron.schedule('*/5 * * * *', () => {
    try {
      db.prepare('SELECT 1 AS ok').get();
      if (consecutiveFails >= 1) {
        notifySlack(`✅ 헬스체크 복구: DB 정상 응답`);
      }
      consecutiveFails = 0;
    } catch (e) {
      consecutiveFails++;
      // 첫 실패 또는 5회 연속 실패마다 알림 (스팸 방지)
      if (consecutiveFails === 1 || consecutiveFails % 5 === 0) {
        notifySlack(`🚨 헬스체크 실패 (${consecutiveFails}회 연속): DB 응답 없음 — ${e.message}`);
      }
    }
  }, { timezone: 'Asia/Seoul' });
  console.log('헬스체크 자가 모니터 시작 (5분 간격)');
}

function scheduleBilling() {
  // 매일 KST 10:00 실행
  cron.schedule('0 10 * * *', async () => {
    try {
      await processDueBillings();
    } catch (e) {
      console.error('[스케줄러 오류]', e);
      notifySlack(`🔴 스케줄러 예외: ${e.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  console.log('결제 스케줄러 시작 (매일 10:00 KST · 사전안내 7일/1일 전 · 재시도 2회)');
}

module.exports = { scheduleBilling, scheduleHealthCheck, chargeSubscriber, processDueBillings };
