#!/bin/bash
# MotiShop 자동 배포 스크립트 — GitHub Webhook → server.js → 이 스크립트
# 위치: /home/ec2-user/motishop-api/deploy.sh
# 권한: chmod +x

set -e
LOG=/home/ec2-user/deploy.log
exec >>"$LOG" 2>&1

echo
echo "===== $(date '+%Y-%m-%d %H:%M:%S') deploy start ${COMMIT:+(commit=$COMMIT)} ====="

REPO_DIR=/var/www/motishop
APP_DIR=/home/ec2-user/motishop-api

PREV_HEAD=$(sudo git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "")

echo "[1/4] git pull"
sudo git -C "$REPO_DIR" pull origin main

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
