/**
 * 솔라피 SMS 발송
 * 공식 문서: https://docs.solapi.com/api-reference/messages
 *
 * 인증: HMAC-SHA256
 *   Authorization: HMAC-SHA256 ApiKey=<key>, Date=<ISO8601>, Salt=<random>, Signature=<HMAC(secret, date+salt)>
 *
 * 발신번호: 솔라피 콘솔에 사전 등록된 번호만 사용 가능 (한국 SMS 정책)
 *   현재: 070-4365-7740 (SOLAPI_FROM)
 */
const axios = require('axios');
const crypto = require('crypto');
const cfg = require('./config');

const SOLAPI_ENDPOINT = 'https://api.solapi.com/messages/v4/send';

function buildAuthHeader() {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString('hex');
  const signature = crypto
    .createHmac('sha256', cfg.SOLAPI_API_SECRET)
    .update(date + salt)
    .digest('hex');
  return `HMAC-SHA256 ApiKey=${cfg.SOLAPI_API_KEY}, Date=${date}, Salt=${salt}, Signature=${signature}`;
}

/**
 * SMS 발송 (90바이트 이하면 SMS, 초과 시 자동 LMS)
 * @param {object} params
 * @param {string} params.to    - 수신번호 (010xxxxxxxx 형식, 하이픈 제거됨)
 * @param {string} params.text  - 본문
 * @param {string} [params.from] - 발신번호 (기본: SOLAPI_FROM)
 * @returns {Promise<{ok, resultCode, resultMsg, raw?}>}
 */
async function sendSMS({ to, text, from }) {
  if (!cfg.SOLAPI_API_KEY || !cfg.SOLAPI_API_SECRET) {
    console.warn('[SMS] SOLAPI 미설정 — 발송 스킵');
    return { ok: false, resultCode: 'NO_CONFIG', resultMsg: 'SOLAPI 키 미설정' };
  }
  const fromNum = (from || cfg.SOLAPI_FROM || '').replace(/[^0-9]/g, '');
  const toNum = String(to || '').replace(/[^0-9]/g, '');
  if (!fromNum || !toNum) {
    return { ok: false, resultCode: 'BAD_NUMBER', resultMsg: '발신/수신번호 누락' };
  }

  try {
    const { data } = await axios.post(SOLAPI_ENDPOINT, {
      message: {
        to: toNum,
        from: fromNum,
        text: String(text || '').slice(0, 2000),
      },
    }, {
      headers: { 'Authorization': buildAuthHeader(), 'Content-Type': 'application/json' },
      timeout: 10000,
    });

    // 솔라피 응답: 성공 시 messageId 등 포함, statusCode '2000' (성공) / '4000'대 (정책)
    const ok = data && data.messageId && (!data.statusCode || /^2/.test(String(data.statusCode)));
    return {
      ok: !!ok,
      resultCode: data?.statusCode || (ok ? 'OK' : 'ERR'),
      resultMsg: data?.statusMessage || (ok ? '발송 요청 완료' : '발송 실패'),
      raw: data,
    };
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
    console.error('[SMS] 발송 실패:', detail);
    return {
      ok: false,
      resultCode: e.response?.status ? 'HTTP_' + e.response.status : 'ERR',
      resultMsg: detail,
    };
  }
}

module.exports = { sendSMS };
