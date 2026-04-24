const axios = require('axios');
const cfg = require('./config');

/**
 * Slack 알림 (webhook 설정 시에만)
 */
async function notifySlack(text) {
  if (!cfg.SLACK_WEBHOOK_URL) return;
  try {
    await axios.post(cfg.SLACK_WEBHOOK_URL, { text }, { timeout: 5000 });
  } catch (e) {
    console.error('[Slack 알림 실패]', e.message);
  }
}

/**
 * 빌키 자동결제 실행
 * @returns {Promise<{ok: boolean, resultCode: string, resultMsg: string, raw?: object}>}
 */
async function chargeBillKey({ billKey, moid, amount, buyerName, buyerTel, goodsName }) {
  try {
    const { data } = await axios.post(cfg.INNOPAY_CHARGE_URL, {
      mid: cfg.INNOPAY_MID,
      billKey,
      moid,
      amount,
      goodsName: goodsName || '모티피지오 구독',
      buyerName,
      buyerTel,
    }, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      timeout: 15000,
    });
    return {
      ok: data.resultCode === '00',
      resultCode: data.resultCode,
      resultMsg: data.resultMsg || '',
      raw: data,
    };
  } catch (e) {
    return {
      ok: false,
      resultCode: 'ERR',
      resultMsg: e.message || 'unknown network error',
    };
  }
}

/**
 * 빌키 삭제 (해지 시 호출)
 * @returns {Promise<{ok: boolean, resultCode: string, resultMsg: string}>}
 */
async function deleteBillKey({ billKey, userId }) {
  try {
    const { data } = await axios.post(cfg.INNOPAY_DELETE_BILLKEY_URL, {
      mid: cfg.INNOPAY_MID,
      billKey,
      userId: String(userId || ''),
    }, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      timeout: 10000,
    });
    return {
      ok: data.resultCode === '0000',
      resultCode: data.resultCode,
      resultMsg: data.resultMsg || '',
    };
  } catch (e) {
    return {
      ok: false,
      resultCode: 'ERR',
      resultMsg: e.message || 'unknown network error',
    };
  }
}

/**
 * 재시도 래퍼 (일시적 오류 대응)
 */
async function chargeWithRetry(params, { maxAttempts = 2, delayMs = 2000 } = {}) {
  let last;
  for (let i = 0; i < maxAttempts; i++) {
    last = await chargeBillKey(params);
    if (last.ok) return last;
    // 네트워크 오류만 재시도. 이노페이의 승인 거절(잔액부족 등)은 재시도 금지.
    if (last.resultCode !== 'ERR') return last;
    if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  return last;
}

module.exports = { chargeBillKey, chargeWithRetry, deleteBillKey, notifySlack };
