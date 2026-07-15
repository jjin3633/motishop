#!/bin/bash
# ============================================================
# 이미 자동 삭제된 회원 복원 스크립트 (개인정보 마스킹 처리)
# 2026-07-14 사장님 요청 — 백업에서 삭제된 회원 복원해서 이력 유지
# ============================================================
# 사용법: bash ~/motishop-api/restore_anonymized.sh
# 실행 전 반드시 현재 DB 백업할 것 (안전장치)
# ============================================================

set -e

DB="$HOME/motishop-api/motishop.db"
BACKUP_DB="/tmp/back607.db"
SNAPSHOT="$HOME/motishop-api/motishop.db.pre-restore-$(date +%Y%m%d-%H%M%S).bak"

echo "═══════════════════════════════════════════════════"
echo "  자동 삭제된 회원 복원 (개인정보 마스킹 처리)"
echo "═══════════════════════════════════════════════════"

# 1) 안전장치 — 현재 DB 백업
echo ""
echo "[1/5] 현재 DB 안전 백업 → $SNAPSHOT"
cp "$DB" "$SNAPSHOT"
echo "    ✓ 백업 완료 ($(du -h "$SNAPSHOT" | cut -f1))"

# 2) 가장 오래된 백업 파일 자동 감지 후 압축 해제
OLDEST_BACKUP=$(ls -t ~/motishop-api/backups/motishop-*.db.gz 2>/dev/null | tail -1)
if [ -z "$OLDEST_BACKUP" ]; then
  echo "❌ 백업 파일이 없습니다. ~/motishop-api/backups/ 확인 필요"
  exit 1
fi
echo ""
echo "[2/5] 가장 오래된 백업 압축 해제"
echo "    소스: $OLDEST_BACKUP"
gunzip -c "$OLDEST_BACKUP" > "$BACKUP_DB"
echo "    ✓ 압축 해제 완료 (→ $BACKUP_DB)"

# 3) 삭제된 회원 개수 미리 확인
DELETED_COUNT=$(sqlite3 "$DB" "ATTACH '$BACKUP_DB' AS bkp; SELECT COUNT(*) FROM bkp.subscribers WHERE id NOT IN (SELECT id FROM main.subscribers);")
echo ""
echo "[3/5] 복원 대상: ${DELETED_COUNT}명"

if [ "$DELETED_COUNT" -eq "0" ]; then
  echo "    ⓘ 복원할 회원 없음. 종료."
  rm "$BACKUP_DB"
  exit 0
fi

# 4) 복원 실행 (트랜잭션 안)
echo ""
echo "[4/5] 복원 실행..."
sqlite3 "$DB" <<SQL
ATTACH '$BACKUP_DB' AS bkp;

BEGIN TRANSACTION;

-- subscribers 복원 (개인정보 마스킹 + status='cancelled' + anonymized_at)
INSERT INTO main.subscribers (
  id, company, name, phone, features, billing_type, bill_key, moid, charge_amount,
  trial_start, next_billing_date, status, created_at,
  pw_hash, pw_salt, notified_7d, notified_1d, billkey_deleted, email,
  business_number, cancelled_at, failed_count, last_failed_at, anonymized_at
)
SELECT
  b.id,
  b.company,
  CASE WHEN LENGTH(COALESCE(b.name,'')) > 1
    THEN SUBSTR(b.name, 1, 1) || '**'
    ELSE '익명' END,
  '010-****-' || SUBSTR(REPLACE(COALESCE(b.phone,''), '-', ''), -4),
  b.features,
  b.billing_type,
  'ANONYMIZED',
  b.moid,
  b.charge_amount,
  b.trial_start,
  b.next_billing_date,
  'cancelled',
  b.created_at,
  NULL, NULL, b.notified_7d, b.notified_1d, 1, NULL, NULL,
  b.cancelled_at, b.failed_count, b.last_failed_at,
  datetime('now', '+9 hours')
FROM bkp.subscribers b
WHERE b.id NOT IN (SELECT id FROM main.subscribers);

-- billing_logs 복원 (매출·환불 이력)
INSERT OR IGNORE INTO main.billing_logs (subscriber_id, moid, amount, result_code, result_msg, trans_seq, billed_at)
SELECT b.subscriber_id, b.moid, b.amount, b.result_code, b.result_msg, b.trans_seq, b.billed_at
FROM bkp.billing_logs b
WHERE b.subscriber_id IN (
  SELECT id FROM main.subscribers WHERE anonymized_at IS NOT NULL AND DATE(anonymized_at) = DATE('now', '+9 hours')
);

-- subscriber_changes 복원 (변경 이력)
INSERT INTO main.subscriber_changes (subscriber_id, change_type, before_features, after_features, before_billing_type, after_billing_type, before_amount, after_amount, changed_at)
SELECT subscriber_id, change_type, before_features, after_features, before_billing_type, after_billing_type, before_amount, after_amount, changed_at
FROM bkp.subscriber_changes
WHERE subscriber_id IN (
  SELECT id FROM main.subscribers WHERE anonymized_at IS NOT NULL AND DATE(anonymized_at) = DATE('now', '+9 hours')
);

-- refunds 복원 (환불 이력)
INSERT INTO main.refunds (subscriber_id, moid, amount, reason, result_code, result_msg, refunded_at, refunded_by)
SELECT subscriber_id, moid, amount, reason, result_code, result_msg, refunded_at, refunded_by
FROM bkp.refunds
WHERE subscriber_id IN (
  SELECT id FROM main.subscribers WHERE anonymized_at IS NOT NULL AND DATE(anonymized_at) = DATE('now', '+9 hours')
);

-- terms_consents 복원 (약관 동의)
INSERT INTO main.terms_consents (subscriber_id, terms_key, terms_version, ip, user_agent, agreed_at)
SELECT subscriber_id, terms_key, terms_version, ip, user_agent, agreed_at
FROM bkp.terms_consents
WHERE subscriber_id IN (
  SELECT id FROM main.subscribers WHERE anonymized_at IS NOT NULL AND DATE(anonymized_at) = DATE('now', '+9 hours')
);

COMMIT;

DETACH bkp;
SQL

# 5) 검증
echo ""
echo "[5/5] 복원 결과 검증"
RESTORED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM subscribers WHERE anonymized_at IS NOT NULL AND DATE(anonymized_at) = DATE('now', '+9 hours');")
echo "    ✓ 익명화 상태로 복원된 회원: ${RESTORED}명"

echo ""
echo "복원 완료. 어드민 → 가입자 목록에서 확인 (해지·익명화 상태)"
echo "문제 있으면 원본 복구: cp $SNAPSHOT $DB && sudo systemctl restart motishop-api"

rm -f "$BACKUP_DB"
