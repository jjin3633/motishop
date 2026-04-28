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

echo "[1/4] git fetch + reset --hard origin/main"
# stale lock 즉시 정리 (이전 git 작업이 비정상 종료됐을 경우)
sudo find "$REPO_DIR/.git" -name "*.lock" -exec rm -f {} \; 2>/dev/null || true
# fetch 실패 시 ref 강제 정리 후 재시도 (stale ref 대응)
if ! sudo git -C "$REPO_DIR" fetch origin main --force --prune 2>&1; then
  echo "[deploy] fetch 1차 실패 — ref 강제 정리 후 재시도"
  sudo find "$REPO_DIR/.git/refs" -name "*.lock" -exec rm -f {} \; 2>/dev/null || true
  sudo git -C "$REPO_DIR" update-ref -d refs/remotes/origin/main 2>/dev/null || true
  sudo git -C "$REPO_DIR" fetch origin main --force --prune
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
if sudo systemctl is-active --quiet motishop-api; then
  echo "===== deploy OK ====="
else
  echo "===== deploy FAILED ====="
  exit 1
fi
