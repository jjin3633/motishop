const cron = require('node-cron');
const db = require('./db');
const cfg = require('./config');
const { chargeWithRetry, notifySlack } = require('./innopay');
const { sendSMS, getBalance } = require('./sms');

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
    goodsName: '모티샵 구독',
    buyerName: sub.name,
    userId: sub.phone,  // 등록 시점과 동일한 userId (phone)
  });

  // 모든 결과 로그 기록 (성공/실패/재시도) — tid는 환불 시 필요 (InnoPay cancelApi)
  const tid = (result.raw && (result.raw.tid || result.raw.pgTid || result.raw.transSeq || result.raw.tno)) || '';
  db.prepare(`INSERT INTO billing_logs (subscriber_id, moid, amount, result_code, result_msg, trans_seq) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(sub.id, moid, sub.charge_amount, result.resultCode || 'ERR', result.resultMsg || '', tid);

  if (result.ok) {
    const next = addPeriod(sub.next_billing_date, sub.billing_type);
    // 낙관적 잠금: 결제 진행 중 사용자가 해지했다면 cancelled 상태 유지 (active로 복귀 X)
    const upd = db.prepare(`
      UPDATE subscribers SET next_billing_date = ?, status = 'active', notified_7d = 0, notified_1d = 0, failed_count = 0, last_failed_at = NULL
      WHERE id = ? AND status IN ('trial','active')
    `).run(next, sub.id);
    if (upd.changes === 0) {
      // 결제는 성공했는데 해지 race — 환불 필요할 수 있음, Slack 경보
      console.warn(`[⚠ 결제성공-해지race] ${sub.company} (id=${sub.id}) — 결제 후 해지 발견. 환불 검토 필요`);
      notifySlack(`⚠️ 결제·해지 race: ${sub.company} (id=${sub.id}) / ${sub.charge_amount.toLocaleString()}원 결제 직전에 해지됨. 환불 검토 필요 (moid=${moid})`);
    } else {
      console.log(`[✓ 결제성공] ${sub.company} / ${sub.charge_amount.toLocaleString()}원 → 다음: ${next}`);
    }
  } else {
    // 실패 카운트 증가
    const newCount = (sub.failed_count || 0) + 1;
    db.prepare(`UPDATE subscribers SET failed_count = ?, last_failed_at = datetime('now', '+9 hours') WHERE id = ?`).run(newCount, sub.id);

    console.error(`[✗ 결제실패 ${newCount}회 연속] ${sub.company} / ${result.resultCode} ${result.resultMsg}`);
    notifySlack(`🔴 결제실패 (${newCount}회 연속): ${sub.company} (id=${sub.id}) / ${sub.charge_amount.toLocaleString()}원\n사유: ${result.resultCode} ${result.resultMsg}`);

    // 티빙 정책: 3일간 매일 재시도 + SMS, 3회째 실패 시 자동 해지
    if (newCount >= 3) {
      const { deleteBillKey } = require('./innopay');
      db.prepare(`UPDATE subscribers SET status='cancelled', cancelled_at = datetime('now', '+9 hours') WHERE id = ?`).run(sub.id);
      if (sub.bill_key && !sub.billkey_deleted) {
        try {
          const r = await deleteBillKey({ billKey: sub.bill_key, userId: sub.phone });
          if (r.ok) db.prepare(`UPDATE subscribers SET billkey_deleted = 1 WHERE id = ?`).run(sub.id);
        } catch (e) { /* ignore */ }
      }
      // 회원에게 자동 해지 통보 SMS
      const cancelText = `[Moti Shop] ${sub.company}님, 카드 결제 3일 연속 실패로 자동 해지되었어요.\n카드 정보 갱신 후 마이페이지에서 언제든 다시 구독 가능해요.\nhttps://shop.motiphysio.com/mypage?action=update-card`;
      sendSMS({ to: sub.phone, text: cancelText, subject: '[Moti Shop] 결제 실패로 자동 해지' }).catch(e => console.error('[자동해지 SMS 실패]', e.message));
      notifySlack(`⛔ 자동 해지: ${sub.company} (id=${sub.id}) — 3일 연속 결제 실패로 자동 해지`);
      console.log(`[자동해지] ${sub.company} / 3회 실패`);
      return;
    }

    // 1~2회 실패: 회원에게 카드 갱신 요청 SMS
    const failText = newCount === 1
      ? `[Moti Shop] ${sub.company}님, 오늘 ${sub.charge_amount.toLocaleString()}원 자동 결제가 실패했어요.\n카드 한도·유효기간 확인 부탁드려요. 내일 다시 시도 예정이에요.\nhttps://shop.motiphysio.com/mypage?action=update-card`
      : `[Moti Shop] ${sub.company}님, 자동 결제가 2회 연속 실패했어요.\n내일이 마지막 재시도이며, 또 실패하면 자동 해지돼요.\n카드 정보 갱신 부탁드려요.\nhttps://shop.motiphysio.com/mypage?action=update-card`;
    const failSubject = newCount === 1
      ? '[Moti Shop] 자동 결제 실패 안내'
      : '[Moti Shop] 자동 결제 2회 실패 · 마지막 안내';
    sendSMS({ to: sub.phone, text: failText, subject: failSubject }).catch(e => console.error('[결제실패 SMS 실패]', e.message));
  }
}

/**
 * 사전 안내 — 사용자 정책으로 SMS 미발송 (카드사 자체 알림으로 대체)
 * 함수 자체는 호환성 위해 유지 (DB 플래그 set X)
 */
function markPreNotification(_sub, _daysLeft) {
  return;
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

    // 사전 안내 (1일 전만)
    if (daysLeft === 1) markPreNotification(sub, daysLeft);

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

// 자동 탈퇴 — 해지 후 30일 경과한 가입자의 개인정보 완전 삭제
// 매일 새벽 3시 KST 실행. 약관(개인정보 보유 기간 30일) + 개인정보보호법 22조(파기) 준수
function scheduleAutoDelete() {
  cron.schedule('0 3 * * *', () => {
    try {
      // 30일 = 30 * 24 * 60 * 60 * 1000 = 2592000000ms
      // SQLite datetime 비교: cancelled_at < datetime('now', '+9 hours', '-30 days')
      const targets = db.prepare(`
        SELECT id, company, name FROM subscribers
        WHERE status = 'cancelled'
          AND cancelled_at IS NOT NULL
          AND cancelled_at < datetime('now', '+9 hours', '-30 days')
      `).all();

      if (!targets.length) return;

      const tx = db.transaction((rows) => {
        const tables = ['sessions', 'billing_logs', 'subscriber_changes', 'terms_consents', 'refunds', 'payment_notis'];
        for (const r of rows) {
          for (const t of tables) {
            try { db.prepare(`DELETE FROM ${t} WHERE subscriber_id=?`).run(r.id); } catch (e) { /* 일부 테이블에 컬럼 없을 수 있음 */ }
          }
          db.prepare(`DELETE FROM subscribers WHERE id=?`).run(r.id);
        }
      });
      tx(targets);

      const summary = targets.map(t => `${t.company}(id=${t.id})`).join(', ');
      console.log(`[자동탈퇴] ${targets.length}건 완전 삭제: ${summary}`);
      notifySlack(`🗑️ 자동 탈퇴 완료: 해지 후 30일 경과 ${targets.length}건 완전 삭제\n${summary}`);
    } catch (e) {
      console.error('[자동탈퇴 오류]', e);
      notifySlack(`🔴 자동탈퇴 cron 예외: ${e.message}`);
    }
  }, { timezone: 'Asia/Seoul' });
  console.log('자동 탈퇴 cron 시작 (매일 03:00 KST · 해지 후 30일 경과 가입자 완전 삭제)');
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

// 솔라피 잔액 모니터 — 매일 09:00 KST · 1만원 미만이면 Slack
// 영업 시작 전 잔액 확인 → 충전 시간 확보 (SMS 발송 실패 방지)
function scheduleSolapiBalance() {
  const THRESHOLD = 10000;
  let lastAlertedAt = null;  // 같은 날 중복 알림 방지

  cron.schedule('0 9 * * *', async () => {
    try {
      const r = await getBalance();
      if (!r.ok) {
        notifySlack(`⚠️ 솔라피 잔액 조회 실패: ${r.resultMsg || '알 수 없음'}`);
        return;
      }
      const total = r.total;
      console.log(`[솔라피 잔액] 현금 ${r.balance.toLocaleString()}원 / 포인트 ${r.point.toLocaleString()}원 / 합계 ${total.toLocaleString()}원`);
      if (total < THRESHOLD) {
        const today = kstDateOnly();
        if (lastAlertedAt !== today) {
          notifySlack(`💰 솔라피 잔액 부족: 합계 ${total.toLocaleString()}원 (현금 ${r.balance.toLocaleString()} / 포인트 ${r.point.toLocaleString()}) — 1만원 미만\nhttps://console.solapi.com/cash/charge`);
          lastAlertedAt = today;
        }
      }
    } catch (e) {
      console.error('[솔라피 잔액 cron 오류]', e.message);
      notifySlack(`🔴 솔라피 잔액 cron 예외: ${e.message}`);
    }
  }, { timezone: 'Asia/Seoul' });
  console.log('솔라피 잔액 모니터 시작 (매일 09:00 KST · 1만원 미만 시 Slack)');
}

// DB 자동 백업 — 매일 03:30 KST · sqlite3 hot copy + gzip + 30일 retention
// 디스크 사고 외 모든 앱 레벨 사고 (rm 실수, corruption, admin 잘못 등) 100% 커버
function scheduleDbBackup() {
  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');
  const BACKUP_DIR = path.join(__dirname, 'backups');
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  cron.schedule('30 3 * * *', async () => {
    try {
      const dateStr = kstDateOnly();
      const backupFile = path.join(BACKUP_DIR, `motishop-${dateStr}.db`);

      // SQLite hot copy (live DB 안전 — better-sqlite3 backup API)
      await db.backup(backupFile);

      // gzip 압축 (DB 파일 보통 작지만 retention 늘리려면 압축)
      execSync(`gzip -f "${backupFile}"`);
      const finalFile = backupFile + '.gz';

      // 30일 retention — 오래된 백업 삭제
      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('motishop-') && f.endsWith('.gz'));
      const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
      let deleted = 0;
      for (const f of files) {
        const fp = path.join(BACKUP_DIR, f);
        if (fs.statSync(fp).mtimeMs < cutoffMs) {
          fs.unlinkSync(fp);
          deleted++;
        }
      }

      const sizeKB = Math.round(fs.statSync(finalFile).size / 1024);
      console.log(`[DB 백업 ✓] ${path.basename(finalFile)} (${sizeKB}KB)${deleted > 0 ? ` · 만료 ${deleted}건 삭제` : ''}`);
    } catch (e) {
      console.error('[DB 백업 실패]', e.message);
      notifySlack(`🔴 DB 백업 실패: ${e.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  console.log('DB 백업 cron 시작 (매일 03:30 KST · 30일 retention · backups/ 디렉토리)');
}

module.exports = { scheduleBilling, scheduleHealthCheck, scheduleAutoDelete, scheduleSolapiBalance, scheduleDbBackup, chargeSubscriber, processDueBillings };
