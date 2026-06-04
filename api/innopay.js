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
 * 빌키 자동결제 실행 (즉시결제 모드 — InnoPay 공식 샘플 기준)
 * 필수: mid, moid, buyerName, goodsName, amt, billKey, userId
 * @returns {Promise<{ok: boolean, resultCode: string, resultMsg: string, raw?: object}>}
 */
async function chargeBillKey({ billKey, moid, amount, buyerName, userId, goodsName }) {
  try {
    const { data } = await axios.post(cfg.INNOPAY_CHARGE_URL, {
      mid: cfg.INNOPAY_MID,
      moid: String(moid),
      buyerName: String(buyerName || ''),
      goodsName: String(goodsName || '모티샵 구독'),
      amt: String(amount),  // 문자열 숫자 (N 타입, 최대 12자리)
      billKey: String(billKey),
      userId: String(userId || ''),
    }, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      timeout: 15000,
    });
    return {
      ok: data.resultCode === '0000',  // InnoPay 성공 코드 (4자리)
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
 * 필수: mid, billKey, userId
 */
async function deleteBillKey({ billKey, userId }) {
  try {
    const { data } = await axios.post(cfg.INNOPAY_DELETE_BILLKEY_URL, {
      mid: cfg.INNOPAY_MID,
      billKey: String(billKey),
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
 * 결제 취소·환불 — InnoPay 통합취소 API (cancelApi)
 * 공식 spec: 통합취소요청샘플.html 기준
 *
 * 필수: mid, tid, svcCd, partialCancelCode, cancelAmt, cancelMsg, cancelPwd
 * 카드(svcCd=01) 환불은 refundBank/AcctNo/AcctNm 불필요 (원 결제 카드로 환원)
 * 성공 응답: resultCode === '2001'
 *
 * @param {object} params
 * @param {string} params.tid          - InnoPay 거래일련번호 (결제 응답의 tid)
 * @param {number} params.amount       - 취소 금액
 * @param {string} params.reason       - 취소 사유
 * @param {boolean} [params.partial]   - true=부분취소, false=전체취소(기본)
 * @param {string} [params.svcCd]      - '01'=카드(기본), '02'=계좌이체, '04'=가상계좌, '07'=핸드폰
 */
async function refundBillKey({ tid, amount, reason, partial = false, svcCd = '01' }) {
  if (!tid) {
    return { ok: false, resultCode: 'NO_TID', resultMsg: '거래번호(tid)가 없어 환불 요청을 보낼 수 없습니다. InnoPay 가맹점 페이지에서 직접 환불해 주세요.' };
  }
  if (!cfg.INNOPAY_CANCEL_PWD) {
    return { ok: false, resultCode: 'NO_PWD', resultMsg: '환불 비밀번호(INNOPAY_CANCEL_PWD)가 .env에 설정되지 않았습니다.' };
  }
  try {
    const url = cfg.INNOPAY_CANCEL_URL || 'https://api.innopay.co.kr/api/cancelApi';
    const { data } = await axios.post(url, {
      mid: cfg.INNOPAY_MID,
      tid: String(tid),
      svcCd: String(svcCd),
      partialCancelCode: partial ? '1' : '0',
      cancelAmt: String(amount),
      cancelMsg: String(reason || '구독 환불').slice(0, 100),
      cancelPwd: String(cfg.INNOPAY_CANCEL_PWD),
    }, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      timeout: 15000,
    });
    return {
      ok: data.resultCode === '2001',
      resultCode: data.resultCode,
      resultMsg: data.resultMsg || '',
      raw: data,
    };
  } catch (e) {
    const status = e.response?.status;
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
    return {
      ok: false,
      resultCode: status ? 'HTTP_' + status : 'ERR',
      resultMsg: detail || 'unknown network error',
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

/**
 * 거래 조회 API — TID 기준 단일 거래 상태 조회
 * 환불·결제 timeout 후 PG 측 실제 처리 상태 확인 시 사용 (#5, #11 화해)
 * @param {string} tid - InnoPay 거래 일련번호
 * @returns {Promise<{ok, status, data?, error?}>}
 */
async function queryTransactionByTid(tid) {
  if (!cfg.INNOPAY_MERCHANT_KEY) {
    return { ok: false, error: 'NO_MERCHANT_KEY', message: 'INNOPAY_MERCHANT_KEY 미설정 (.env 확인)' };
  }
  try {
    const { data, status } = await axios.get(`${cfg.INNOPAY_TXN_QUERY_URL}/${encodeURIComponent(tid)}`, {
      headers: { 'MID': cfg.INNOPAY_MID, 'Merchant-Key': cfg.INNOPAY_MERCHANT_KEY },
      timeout: 10000,
    });
    return { ok: !!data?.success, status, data: data?.data || data, raw: data };
  } catch (e) {
    return {
      ok: false,
      status: e.response?.status,
      error: e.response?.data?.error || e.code || 'ERR',
      message: e.response?.data?.message || e.message,
    };
  }
}

/**
 * 거래 조회 API — MOID(가맹점 주문번호) 기준 조회
 */
async function queryTransactionByMoid(moid) {
  if (!cfg.INNOPAY_MERCHANT_KEY) {
    return { ok: false, error: 'NO_MERCHANT_KEY' };
  }
  try {
    const { data, status } = await axios.get(`${cfg.INNOPAY_TXN_QUERY_URL}/orders/${encodeURIComponent(moid)}`, {
      headers: { 'MID': cfg.INNOPAY_MID, 'Merchant-Key': cfg.INNOPAY_MERCHANT_KEY },
      timeout: 10000,
    });
    return { ok: !!data?.success, status, data: data?.data || data, raw: data };
  } catch (e) {
    return {
      ok: false,
      status: e.response?.status,
      error: e.response?.data?.error || e.code || 'ERR',
      message: e.response?.data?.message || e.message,
    };
  }
}

/**
 * 거래 조회 API — MID + 날짜 기준 일괄 조회 (일일 정합성 화해 cron용)
 * @param {string} startDate YYYYMMDD
 */
async function queryTransactionsByDate(startDate) {
  if (!cfg.INNOPAY_MERCHANT_KEY) {
    return { ok: false, error: 'NO_MERCHANT_KEY' };
  }
  try {
    const { data, status } = await axios.get(`${cfg.INNOPAY_TXN_QUERY_URL}/merchants/${cfg.INNOPAY_MID}?startDate=${startDate}`, {
      headers: { 'MID': cfg.INNOPAY_MID, 'Merchant-Key': cfg.INNOPAY_MERCHANT_KEY },
      timeout: 15000,
    });
    return { ok: !!data?.success, status, data: data?.data || data, raw: data };
  } catch (e) {
    return {
      ok: false,
      status: e.response?.status,
      error: e.response?.data?.error || e.code || 'ERR',
      message: e.response?.data?.message || e.message,
    };
  }
}

module.exports = { chargeBillKey, chargeWithRetry, deleteBillKey, refundBillKey, queryTransactionByTid, queryTransactionByMoid, queryTransactionsByDate, notifySlack };
