// 쿠폰 코드 목록 — "From The Ground 01" ~ "From The Ground 100"
// 저장은 정규화 형태(공백 제거·소문자)로 통일 → 입력 시 대소문자·공백 오타 관용
// 서버 시작 시 coupons 테이블에 INSERT OR IGNORE로 자동 등록 (idempotent)
// 새 코드 추가 시 이 배열에 push 후 재배포하면 자동 반영

// 표시 문구: "From The Ground {01~100}"
// 저장 코드: "fromtheground{01~100}"

const COUPON_CODES = Array.from({ length: 100 }, (_, i) => {
  const num = String(i + 1).padStart(2, '0'); // 01, 02, ..., 99, 100
  return `fromtheground${num}`;
});

// 입력값 정규화 — 대소문자·공백 관용
function normalizeCouponCode(input) {
  if (!input) return '';
  return String(input).trim().toLowerCase().replace(/\s+/g, '');
}

// 표시 문구 복원 (저장 → 원장님 배포 표기)
function displayCouponCode(stored) {
  if (!stored) return '';
  const m = /^fromtheground(\d+)$/.exec(stored);
  if (!m) return stored;
  return `From The Ground ${m[1]}`;
}

module.exports = {
  COUPON_CODES,
  normalizeCouponCode,
  displayCouponCode,
};
