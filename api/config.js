require('dotenv').config();

function required(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) {
      console.warn(`[config] ${key} 미설정 — 기본값 사용: ${fallback}`);
      return fallback;
    }
    throw new Error(`[config] 필수 환경변수 ${key} 누락 — .env 파일 확인`);
  }
  return v;
}

module.exports = {
  ADMIN_PW: required('ADMIN_PW'),
  INNOPAY_MID: required('INNOPAY_MID'),
  INNOPAY_CHARGE_URL: required('INNOPAY_CHARGE_URL', 'https://api.innopay.co.kr/api/payAutoCardBill'),
  INNOPAY_DELETE_BILLKEY_URL: required('INNOPAY_DELETE_BILLKEY_URL', 'https://api.innopay.co.kr/api/delAutoCardBill'),
  CORS_ORIGIN: required('CORS_ORIGIN', 'https://shop.motiphysio.com'),
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || '',
  DB_PATH: required('DB_PATH', './motishop.db'),
  NOTIFY_ENABLED: (process.env.NOTIFY_ENABLED || 'false').toLowerCase() === 'true',
};
