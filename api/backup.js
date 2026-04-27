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

  // S3 외부 백업 (선택) — 환경변수 BACKUP_S3_BUCKET 설정 시 aws cli로 업로드
  // EC2에 IAM role 또는 ~/.aws/credentials 필요. aws cli 미설치 시 자동 스킵.
  const s3Bucket = process.env.BACKUP_S3_BUCKET;
  if (s3Bucket) {
    const { execSync } = require('child_process');
    try {
      const s3Path = `s3://${s3Bucket}/motishop/${path.basename(dest)}`;
      execSync(`aws s3 cp "${dest}" "${s3Path}" --only-show-errors`, { stdio: 'inherit' });
      console.log(`[backup → S3] ${s3Path}`);
    } catch (e) {
      console.error('[backup → S3] 실패 (로컬 백업은 정상):', e.message);
    }
  }

  // 30일 이상된 로컬 백업 자동 정리
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
