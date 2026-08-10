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
  if (billingType === 'monthly') {
    // 월말 롤오버 안전 처리 — 1/31 + 1month = 3/3 같은 자동 보정 방지
    // 31일 가입자는 2월에 마지막 날(28/29)로 clamp → 짝수 달 결제 누락 방지
    const targetDay = d.getDate();
    d.setDate(1);                           // 일 먼저 1로 → 월 증가 시 over-flow 방지
    d.setMonth(d.getMonth() + 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(targetDay, lastDay));
  } else {
    d.setFullYear(d.getFullYear() + 1);
  }
  return kstDateOnly(d);
}

function daysFromToday(dateStr) {
  const today = new Date(kstDateOnly() + 'T00:00:00+09:00');
  const target = new Date(dateStr + 'T00:00:00+09:00');
  return Math.round((target - today) / (24 * 60 * 60 * 1000));
}

async function chargeSubscriber(sub) {
  // 멱등성: 같은 가입자 + 같은 결제 사이클(next_billing_date)에 이미 성공한 결제가 있으면 스킵
  // 2026-06-23: cycle_date 컬럼 기반 멱등성 — 크래시·자정 경계에도 안전
  const cycleDate = sub.next_billing_date;
  const dup = db.prepare(`
    SELECT id FROM billing_logs
    WHERE subscriber_id = ? AND result_code IN ('0000','00')
      AND cycle_date = ?
    LIMIT 1
  `).get(sub.id, cycleDate);
  if (dup) {
    console.log(`[스킵] ${sub.company} — cycle ${cycleDate} 이미 성공 결제 존재 (log_id=${dup.id})`);
    return;
  }

  const moid = genMoid();
  // 쿠폰 카드 등록 회원(billing_type='coupon' + bill_key=진짜 + pending 값 있음) → pending 값으로 결제
  const isCouponPaidTransition = sub.billing_type === 'coupon' && sub.pending_charge_amount && sub.pending_billing_type;
  const chargeAmount = isCouponPaidTransition ? sub.pending_charge_amount : sub.charge_amount;

  const result = await chargeWithRetry({
    billKey: sub.bill_key,
    moid,
    amount: chargeAmount,
    goodsName: '모티샵 구독',
    buyerName: sub.name,
    userId: sub.phone,
  });

  const tid = (result.raw && (result.raw.tid || result.raw.pgTid || result.raw.transSeq || result.raw.tno)) || '';

  if (result.ok) {
    // 성공 — billing_logs INSERT + subscribers UPDATE를 원자적 트랜잭션으로 처리
    // 크래시 시 둘 다 rollback → 다음 cron에서 cycle_date 멱등성으로 재처리 안전
    // 쿠폰→유료 전환 시 pending 값을 실 컬럼으로 승격
    const effectiveBillingType = isCouponPaidTransition ? sub.pending_billing_type : sub.billing_type;
    const next = addPeriod(sub.next_billing_date, effectiveBillingType);
    const txResult = db.transaction(() => {
      db.prepare(`INSERT INTO billing_logs (subscriber_id, moid, amount, result_code, result_msg, trans_seq, cycle_date) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(sub.id, moid, chargeAmount, result.resultCode, result.resultMsg || '', tid, cycleDate);
      if (isCouponPaidTransition) {
        // 쿠폰 → 유료 전환: pending → 실 컬럼 승격 + pending 클리어
        const upd = db.prepare(`
          UPDATE subscribers SET
            billing_type=?, features=?, charge_amount=?,
            pending_billing_type=NULL, pending_features=NULL, pending_charge_amount=NULL,
            next_billing_date=?, status='active',
            notified_7d=0, notified_1d=0, failed_count=0, last_failed_at=NULL
          WHERE id=? AND status IN ('trial','active')
        `).run(sub.pending_billing_type, sub.pending_features, sub.pending_charge_amount, next, sub.id);
        return upd.changes;
      }
      // 낙관적 잠금: 결제 진행 중 사용자가 해지했다면 cancelled 상태 유지
      const upd = db.prepare(`
        UPDATE subscribers SET next_billing_date = ?, status = 'active', notified_7d = 0, notified_1d = 0, failed_count = 0, last_failed_at = NULL
        WHERE id = ? AND status IN ('trial','active')
      `).run(next, sub.id);
      return upd.changes;
    })();

    if (txResult === 0) {
      console.warn(`[⚠ 결제성공-해지race] ${sub.company} (id=${sub.id}) — 결제 후 해지 발견. 환불 검토 필요`);
      notifySlack(`⚠️ 결제·해지 race: ${sub.company} (id=${sub.id}) / ${sub.charge_amount.toLocaleString()}원 결제 직전에 해지됨. 환불 검토 필요 (moid=${moid})`);
    } else {
      console.log(`[✓ 결제성공] ${sub.company} / ${sub.charge_amount.toLocaleString()}원 → 다음: ${next}`);
      // 쿠폰 → 유료 전환 감지 (첫 결제 성공 + coupons 이력 있음)
      try {
        const wasCoupon = db.prepare(`SELECT code FROM coupons WHERE used_by_id=?`).get(sub.id);
        if (wasCoupon) {
          const prior = db.prepare(`SELECT change_type FROM subscriber_changes WHERE subscriber_id=? AND change_type='coupon_to_paid' LIMIT 1`).get(sub.id);
          if (!prior) {
            db.prepare(`
              INSERT INTO subscriber_changes
                (subscriber_id, change_type, before_features, after_features, before_billing_type, after_billing_type, before_amount, after_amount)
              VALUES (?, 'coupon_to_paid', ?, ?, 'coupon', ?, 0, ?)
            `).run(sub.id, sub.features, sub.features, sub.billing_type, sub.charge_amount);
            notifySlack(`💰 쿠폰→유료 전환: ${sub.company} (id=${sub.id}) / ${sub.charge_amount.toLocaleString()}원 · ${sub.billing_type==='annual'?'연':'월'}구독`);
          }
        }
      } catch (e) { console.error('[coupon_to_paid 기록 실패]', e.message); }
    }
  } else {
    // 실패 — billing_logs에 실패 로그 (cycle_date 포함, 향후 통계용)
    db.prepare(`INSERT INTO billing_logs (subscriber_id, moid, amount, result_code, result_msg, trans_seq, cycle_date) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sub.id, moid, sub.charge_amount, result.resultCode || 'ERR', result.resultMsg || '', tid, cycleDate);

    // failed_count atomic increment (메모리 값 race 방지) — RETURNING으로 갱신된 값 확인
    const fc = db.prepare(`UPDATE subscribers SET failed_count = COALESCE(failed_count,0) + 1, last_failed_at = datetime('now', '+9 hours') WHERE id = ? RETURNING failed_count`).get(sub.id);
    const newCount = fc?.failed_count || ((sub.failed_count || 0) + 1);

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

  // 결제 대상: 일반 회원 + 카드 등록된 쿠폰 회원 (bill_key 진짜 값)
  // 카드 미등록 쿠폰 회원(bill_key='COUPON_...')은 결제 대상 제외 → 만료 스케줄러가 별도 처리
  const due = db.prepare(`
    SELECT * FROM subscribers
    WHERE next_billing_date <= ?
      AND status IN ('trial', 'active')
      AND (billing_type != 'coupon'
           OR (billing_type = 'coupon' AND bill_key NOT LIKE 'COUPON\\_%' ESCAPE '\\'))
  `).all(today);

  console.log(`[스케줄러] ${today} — 결제 대상 ${due.length}건 / 전체 대상 ${targets.length}건`);
  return due;
}

async function processDueBillings() {
  // 시작 시 자기 pid의 stale lock 자체 정리 (이전 크래시로 남은 락)
  try {
    db.prepare(`DELETE FROM scheduler_locks WHERE name = 'billing' AND pid = ?`).run(process.pid);
  } catch (e) { /* ignore */ }

  // 동시 실행 방지 (multi-instance 환경 대비) — 5분 이상 묵은 lock은 stale로 간주
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  let lockResult;
  try {
    lockResult = db.prepare(`
      INSERT INTO scheduler_locks (name, locked_at, pid) VALUES ('billing', datetime('now'), ?)
      ON CONFLICT(name) DO UPDATE SET locked_at = datetime('now'), pid = excluded.pid
      WHERE locked_at < ?
    `).run(process.pid, fiveMinAgo);
  } catch (e) {
    // UNIQUE 충돌 또는 기타 DB 오류 — 다른 인스턴스가 잡고 있다고 보고 스킵
    console.warn(`[스케줄러] 락 획득 실패 — 스킵 (${e.message})`);
    return;
  }

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
    try {
      db.prepare(`DELETE FROM scheduler_locks WHERE name = 'billing' AND pid = ?`).run(process.pid);
    } catch (e) { console.error('[스케줄러] 락 해제 실패', e.message); }
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

// 자동 탈퇴 24시간 전 사전 안내 SMS — 개인정보보호법 22조 사전 통지 의무
// 매일 새벽 2시 KST 실행 (자동 탈퇴는 3시) — cancelled_at < now-29days AND >= now-30days
function scheduleAutoDeletePreNotice() {
  cron.schedule('0 2 * * *', async () => {
    try {
      const targets = db.prepare(`
        SELECT id, company, name, phone FROM subscribers
        WHERE status = 'cancelled'
          AND cancelled_at IS NOT NULL
          AND cancelled_at < datetime('now', '+9 hours', '-29 days')
          AND cancelled_at >= datetime('now', '+9 hours', '-30 days')
      `).all();

      if (!targets.length) return;

      for (const t of targets) {
        const smsText = `[Moti Shop] ${t.company}님, 해지하신 지 30일이 되어 내일 새벽 결제·구독 이력이 자동 삭제됩니다.\n다시 구독을 원하시면 오늘 안에 마이페이지에서 가능해요.\n삭제 후에는 신규 가입으로 새 계정이 만들어집니다.\nhttps://shop.motiphysio.com/mypage`;
        try {
          const r = await sendSMS({ to: t.phone, text: smsText, subject: '[Moti Shop] 데이터 자동 삭제 24시간 전 안내' });
          console.log(`[자동삭제 사전안내 SMS] ${t.company} → ok=${r.ok} ${r.resultCode || ''} ${r.resultMsg || ''}`);
          if (!r.ok) notifySlack(`⚠️ 자동삭제 사전안내 SMS 실패: ${t.company} (id=${t.id}) — ${r.resultCode} ${r.resultMsg}`);
        } catch (e) {
          console.error('[자동삭제 사전안내 SMS 예외]', e.message);
          notifySlack(`🔴 자동삭제 사전안내 SMS 예외: ${t.company} (id=${t.id}) — ${e.message}`);
        }
      }
      notifySlack(`📢 자동 삭제 24h 전 사전 안내 SMS ${targets.length}건 발송`);
    } catch (e) {
      console.error('[자동삭제 사전안내 cron 오류]', e);
      notifySlack(`🔴 자동삭제 사전안내 cron 예외: ${e.message}`);
    }
  }, { timezone: 'Asia/Seoul' });
  console.log('자동 삭제 사전 안내 cron 시작 (매일 02:00 KST · 30일 경과 직전 회원에게 SMS)');
}

// 자동 익명화 — 해지 후 30일 경과한 가입자의 개인정보만 마스킹 처리 (2026-07-14 정책 변경)
// 완전 삭제 → 마스킹으로 변경 이유:
//   1. 결제·환불·해지 이력·기능 해제 상태 등 운영 감사 데이터 보존 필요 (사장님 요청)
//   2. 개인정보보호법 22조는 "복원 불가능한 익명화"도 파기로 인정
// 마스킹 규칙:
//   - name: 첫 글자만 남기고 나머지 * (예: "김**")
//   - phone: 뒤 4자리만 (예: "010-****-1234")
//   - business_number·email·bill_key: NULL
//   - moid는 유지 (결제 추적용, 개인 식별 X)
// 유지 이력: billing_logs, subscriber_changes, refunds, terms_consents, activation_logs, subscriber_memos
// 삭제 이력: sessions (로그인 세션 무의미)
function scheduleAutoDelete() {
  cron.schedule('0 3 * * *', () => {
    try {
      const targets = db.prepare(`
        SELECT id, company, name, phone FROM subscribers
        WHERE status = 'cancelled'
          AND cancelled_at IS NOT NULL
          AND anonymized_at IS NULL
          AND cancelled_at < datetime('now', '+9 hours', '-30 days')
      `).all();

      if (!targets.length) return;

      const tx = db.transaction((rows) => {
        for (const r of rows) {
          // 개인정보 마스킹
          const nameMasked = r.name && r.name.length > 0
            ? r.name.charAt(0) + '*'.repeat(Math.max(1, r.name.length - 1))
            : '익명';
          const phoneDigits = String(r.phone || '').replace(/[^0-9]/g, '');
          const phoneMasked = phoneDigits.length >= 4
            ? '010-****-' + phoneDigits.slice(-4)
            : '010-****-****';

          db.prepare(`UPDATE subscribers SET
            name = ?,
            phone = ?,
            business_number = NULL,
            email = NULL,
            bill_key = 'ANONYMIZED',
            pw_hash = NULL,
            pw_salt = NULL,
            anonymized_at = datetime('now', '+9 hours')
            WHERE id = ?`).run(nameMasked, phoneMasked, r.id);

          // 세션만 삭제 (로그인 세션 무의미), 이력 테이블은 모두 유지
          try { db.prepare(`DELETE FROM sessions WHERE subscriber_id=?`).run(r.id); } catch (e) {}
        }
      });
      tx(targets);

      const summary = targets.map(t => `${t.company}(id=${t.id})`).join(', ');
      console.log(`[자동익명화] ${targets.length}건 마스킹 처리: ${summary}`);
      notifySlack(`🔒 자동 익명화 완료: 해지 후 30일 경과 ${targets.length}건 개인정보 마스킹\n${summary}`);
    } catch (e) {
      console.error('[자동익명화 오류]', e);
      notifySlack(`🔴 자동익명화 cron 예외: ${e.message}`);
    }
  }, { timezone: 'Asia/Seoul' });
  console.log('자동 익명화 cron 시작 (매일 03:00 KST · 해지 후 30일 경과 가입자 개인정보 마스킹)');
}

// ── 쿠폰 만료 처리 (2026-08-10) ──
// 00:00 KST: 만료일 도래한 카드 미등록 쿠폰 회원 → status='cancelled'
// 09:00 KST: 오늘 만료된 회원에게 안내 SMS 발송 (당일 1회)
function scheduleCouponExpiry() {
  // Step 1: 매일 00:00 KST — status 변경 (카드 미등록 쿠폰 회원만)
  cron.schedule('0 0 * * *', () => {
    try {
      const today = kstDateOnly();
      const targets = db.prepare(`
        SELECT id, company, name FROM subscribers
        WHERE billing_type = 'coupon' AND status = 'active'
          AND next_billing_date <= ?
          AND bill_key LIKE 'COUPON\\_%' ESCAPE '\\'
      `).all(today);
      if (targets.length === 0) return;
      const stmt = db.prepare(`UPDATE subscribers SET status='cancelled', cancelled_at=datetime('now', '+9 hours') WHERE id=? AND status='active'`);
      const tx = db.transaction(() => { targets.forEach(t => stmt.run(t.id)); });
      tx();
      const summary = targets.map(t => `${t.company}(id=${t.id})`).join(', ');
      console.log(`[쿠폰 만료] ${targets.length}건 status→cancelled: ${summary}`);
      notifySlack(`⏰ 쿠폰 만료 자동 처리: ${targets.length}건 · ${summary}`);
    } catch (e) {
      console.error('[쿠폰 만료 cron 오류]', e.message);
      notifySlack(`🔴 쿠폰 만료 cron 예외: ${e.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  // Step 2: 매일 09:00 KST — 오늘 만료된 회원에게 SMS
  cron.schedule('0 9 * * *', async () => {
    try {
      const today = kstDateOnly();
      // 오늘 만료 & 아직 미익명화 & 카드 미등록 쿠폰 회원
      const targets = db.prepare(`
        SELECT id, company, name, phone FROM subscribers
        WHERE billing_type = 'coupon'
          AND status = 'cancelled'
          AND anonymized_at IS NULL
          AND DATE(cancelled_at) = ?
          AND bill_key LIKE 'COUPON\\_%' ESCAPE '\\'
      `).all(today);
      for (const t of targets) {
        const smsText = `[Moti Shop] ${t.company} ${t.name}님, 90일 무료 쿠폰이 만료되었어요.\n\n기능이 마음에 드셨다면 마이페이지에서 카드 등록 후 계속 사용 가능해요!\nhttps://shop.motiphysio.com/mypage`;
        try {
          const r = await sendSMS({ to: t.phone, text: smsText, subject: '[Moti Shop] 쿠폰 만료 안내' });
          if (!r.ok) notifySlack(`⚠️ 쿠폰 만료 SMS 실패: ${t.company} (id=${t.id}) — ${r.resultCode} ${r.resultMsg}`);
        } catch (e) {
          console.error(`[쿠폰 만료 SMS 예외] id=${t.id} — ${e.message}`);
          notifySlack(`⚠️ 쿠폰 만료 SMS 예외: ${t.company} (id=${t.id}) — ${e.message}`);
        }
      }
      if (targets.length > 0) console.log(`[쿠폰 만료 SMS] ${targets.length}건 발송`);
    } catch (e) {
      console.error('[쿠폰 만료 SMS cron 오류]', e.message);
    }
  }, { timezone: 'Asia/Seoul' });

  console.log('쿠폰 만료 cron 시작 (매일 00:00 KST · status 변경 · 09:00 KST · 안내 SMS)');
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

// ── sitemap.xml lastmod 자동 갱신 — 2026-06-19 추가 (SEO) ──
function scheduleSitemapUpdate() {
  const fs = require('fs');
  const path = require('path');

  // 운영(/var/www/motishop) 우선, 없으면 로컬(repo 루트) fallback
  function findSitemapPath() {
    if (process.env.SITEMAP_PATH) return process.env.SITEMAP_PATH;
    const candidates = [
      '/var/www/motishop/sitemap.xml',
      path.join(__dirname, '..', 'sitemap.xml'),
    ];
    return candidates.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
  }

  const updateLastmod = () => {
    const SITEMAP_PATH = findSitemapPath();
    if (!SITEMAP_PATH) {
      console.warn('[sitemap] 파일 위치 못 찾음 — 후보 경로 모두 없음');
      return;
    }
    try {
      const today = kstDateOnly();
      const content = fs.readFileSync(SITEMAP_PATH, 'utf8');
      const updated = content.replace(/<lastmod>[\d-]+<\/lastmod>/g, `<lastmod>${today}</lastmod>`);
      if (updated !== content) {
        fs.writeFileSync(SITEMAP_PATH, updated, 'utf8');
        console.log(`[sitemap 갱신 ✓] ${SITEMAP_PATH} lastmod → ${today}`);
      } else {
        console.log(`[sitemap] 이미 최신: ${SITEMAP_PATH}`);
      }
    } catch (e) {
      console.error(`[sitemap 갱신 실패] ${SITEMAP_PATH}: ${e.message}`);
    }
  };

  cron.schedule('0 0 * * *', updateLastmod, { timezone: 'Asia/Seoul' });
  updateLastmod();
  console.log('sitemap 갱신 cron 시작 (매일 00:00 KST · 시작 시 1회 즉시 갱신)');
}

// ── Analytics 데이터 90일 retention 정리 — 2026-06-18 추가 ──
function scheduleAnalyticsCleanup() {
  cron.schedule('0 4 * * *', () => {
    try {
      const cutoff = `datetime('now', '+9 hours', '-90 days')`;
      const v = db.prepare(`DELETE FROM visits WHERE visited_at < ${cutoff}`).run();
      const e = db.prepare(`DELETE FROM events WHERE occurred_at < ${cutoff}`).run();
      if (v.changes > 0 || e.changes > 0) {
        console.log(`[Analytics 정리 ✓] visits ${v.changes}건 / events ${e.changes}건 삭제 (90일 retention)`);
      }
    } catch (err) {
      console.error('[Analytics 정리 실패]', err.message);
    }
  }, { timezone: 'Asia/Seoul' });
  console.log('Analytics 정리 cron 시작 (매일 04:00 KST · 90일 retention)');
}

module.exports = { scheduleBilling, scheduleHealthCheck, scheduleAutoDelete, scheduleAutoDeletePreNotice, scheduleSolapiBalance, scheduleDbBackup, scheduleAnalyticsCleanup, scheduleSitemapUpdate, scheduleCouponExpiry, chargeSubscriber, processDueBillings, addPeriod };
