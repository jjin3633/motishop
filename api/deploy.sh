#!/bin/bash
# MotiShop 자동 배포 스크립트 — GitHub Webhook → server.js → 이 스크립트
# 위치: /home/ec2-user/motishop-api/deploy.sh
# 권한: chmod +x

set -e
LOG=/home/ec2-user/deploy.log
exec >>"$LOG" 2>&1

# 동시 실행 방지 — webhook 빠르게 연속 트리거 시 stale ref 충돌 방지
exec 9>/tmp/motishop-deploy.lock
if ! flock -n 9; then
  echo
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') deploy SKIP ${COMMIT:+(commit=$COMMIT)} — 다른 deploy 실행 중 ====="
  exit 0
fi

echo
echo "===== $(date '+%Y-%m-%d %H:%M:%S') deploy start ${COMMIT:+(commit=$COMMIT)} ====="

REPO_DIR=/var/www/motishop
APP_DIR=/home/ec2-user/motishop-api

PREV_HEAD=$(sudo git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "")

echo "[1/4] git sync (3단 retry)"
# stale lock 즉시 정리
sudo find "$REPO_DIR/.git" -name "*.lock" -exec rm -f {} \; 2>/dev/null || true

# 시도 1: 일반 fetch
FETCH_OK=0
if sudo git -C "$REPO_DIR" fetch origin main --force --prune 2>&1; then
  FETCH_OK=1
else
  echo "[deploy] 1차 fetch 실패 — ref 강제 정리 후 재시도"
  sudo find "$REPO_DIR/.git" -name "*.lock" -exec rm -f {} \; 2>/dev/null || true
  sudo git -C "$REPO_DIR" update-ref -d refs/remotes/origin/main 2>/dev/null || true
  # 시도 2: ref 삭제 후 fetch
  if sudo git -C "$REPO_DIR" fetch origin main --force --prune 2>&1; then
    FETCH_OK=1
  else
    echo "[deploy] 2차 fetch 실패 — fresh clone으로 재초기화"
    sudo rm -rf "$REPO_DIR.bak" 2>/dev/null || true
    sudo cp -a "$REPO_DIR" "$REPO_DIR.bak" 2>/dev/null || true
    sudo rm -rf "$REPO_DIR/.git"
    sudo git clone --bare https://github.com/jjin3633/motishop.git /tmp/motishop-fresh.git
    sudo mv /tmp/motishop-fresh.git "$REPO_DIR/.git"
    sudo git -C "$REPO_DIR" config core.bare false
    sudo git -C "$REPO_DIR" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
    sudo git -C "$REPO_DIR" fetch origin main --force --prune
    FETCH_OK=1
    echo "[deploy] fresh clone 복구 완료 (백업: $REPO_DIR.bak)"
  fi
fi
sudo git -C "$REPO_DIR" reset --hard origin/main

NEW_HEAD=$(sudo git -C "$REPO_DIR" rev-parse HEAD)
echo "      $PREV_HEAD → $NEW_HEAD"

echo "[2/4] rsync api/ → $APP_DIR/"
sudo rsync -a \
  --exclude='.env' \
  --exclude='motishop.db' \
  --exclude='motishop.db-*' \
  --exclude='backup/' \
  --exclude='node_modules/' \
  "$REPO_DIR/api/" "$APP_DIR/"
# rsync -a는 source 권한·소유자(root) 보존 → SQLite write/journal 위해 ec2-user로 통일
sudo chown -R ec2-user:ec2-user "$APP_DIR"

if [ -n "$PREV_HEAD" ] && sudo git -C "$REPO_DIR" diff --name-only "$PREV_HEAD" "$NEW_HEAD" | grep -q '^api/package.*\.json$'; then
  echo "[3/4] package.json 변경 감지 → npm install --omit=dev"
  cd "$APP_DIR"
  sudo -u ec2-user npm install --omit=dev
else
  echo "[3/4] package.json 변경 없음 — npm install 생략"
fi

echo "[4/4] systemctl restart motishop-api"
sudo systemctl restart motishop-api
sleep 2

# Slack 알림 helper — .env에서 SLACK_WEBHOOK_URL 읽어 직접 호출
slack_send() {
  local webhook
  webhook=$(grep '^SLACK_WEBHOOK_URL=' "$APP_DIR/.env" 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  [ -z "$webhook" ] && return 0
  curl -s -X POST "$webhook" -H 'Content-Type: application/json' \
    -d "{\"text\":\"$1\"}" > /dev/null 2>&1 || true
}

if sudo systemctl is-active --quiet motishop-api; then
  echo "===== deploy OK ====="
else
  echo "===== deploy FAILED ====="
  slack_send "🔴 자동 배포 실패: \`${NEW_HEAD:0:7}\` — motishop-api 시작 안 됨. journalctl 확인 필요"
  exit 1
fi
