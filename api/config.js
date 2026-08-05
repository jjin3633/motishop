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
  INNOPAY_CANCEL_URL: required('INNOPAY_CANCEL_URL', 'https://api.innopay.co.kr/api/cancelApi'),
  INNOPAY_CANCEL_PWD: process.env.INNOPAY_CANCEL_PWD || '',
  // 거래 조회 API (v1/transactions) 인증용 Merchant-Key — InnoPay에서 발급
  INNOPAY_MERCHANT_KEY: process.env.INNOPAY_MERCHANT_KEY || '',
  INNOPAY_TXN_QUERY_URL: process.env.INNOPAY_TXN_QUERY_URL || 'https://api.innopay.co.kr/v1/transactions',
  CORS_ORIGIN: required('CORS_ORIGIN', 'https://shop.motiphysio.com'),
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || '',
  DB_PATH: required('DB_PATH', './motishop.db'),
  NOTIFY_ENABLED: (process.env.NOTIFY_ENABLED || 'false').toLowerCase() === 'true',
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET || '',
  DEPLOY_SCRIPT_PATH: process.env.DEPLOY_SCRIPT_PATH || '/home/ec2-user/motishop-api/deploy.sh',
  // Ruby 서브앱 (Acti Physio - Ruby 마케팅 랜딩) — webhook 시크릿 비어있으면 라우트 503 반환
  RUBY_WEBHOOK_SECRET: process.env.RUBY_WEBHOOK_SECRET || '',
  RUBY_DEPLOY_SCRIPT_PATH: process.env.RUBY_DEPLOY_SCRIPT_PATH || '/home/ec2-user/ruby-deploy/deploy.sh',
  // 솔라피 (SMS / 카카오 알림톡)
  SOLAPI_API_KEY: process.env.SOLAPI_API_KEY || '',
  SOLAPI_API_SECRET: process.env.SOLAPI_API_SECRET || '',
  SOLAPI_FROM: process.env.SOLAPI_FROM || '',  // 사전 등록된 발신번호
  // phone HMAC-SHA256 시크릿 (익명화 후 재가입 판별용 · 원본 phone 재식별 방지)
  PHONE_HASH_SECRET: required('PHONE_HASH_SECRET'),
};
