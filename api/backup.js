/**
 * SQLite DB 백업 스크립트
 * 실행: node backup.js
 * cron 예: 0 3 * * * cd /home/ec2-user/motishop-api && node backup.js >> /home/ec2-user/backup.log 2>&1
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const src = path.resolve(__dirname, cfg.DB_PATH);
const backupDir = path.resolve(__dirname, 'backup');
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = path.join(backupDir, `motishop-${ts}.db`);

try {
  fs.copyFileSync(src, dest);
  console.log(`[backup] ${dest} (${fs.statSync(dest).size} bytes)`);

  // 30일 이상된 백업 자동 정리
  const keepDays = 30;
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(backupDir)) {
    const p = path.join(backupDir, f);
    if (fs.statSync(p).mtimeMs < cutoff) {
      fs.unlinkSync(p);
      console.log(`[backup] 삭제 (오래됨): ${f}`);
    }
  }
} catch (e) {
  console.error('[backup] 실패:', e.message);
  process.exit(1);
}
