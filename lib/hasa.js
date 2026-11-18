'use strict';
/* 오픈하사(OpenAI 호환) 호출에 같이 쓰는 부분. api/steps.js(글)와 api/timetable.js(사진)가 불러 쓴다.
 * 키는 환경변수 HASA_API_KEY에서만 읽고, 코드·응답·로그 어디에도 쓰지 않는다. */

const UPSTREAM_URL = 'https://open.hasa.re.kr/v1/chat/completions';
const MODEL = 'gemma-4-31b';

const MSG = {
  method: 'POST로 요청해 주세요.',
  nokey: 'AI 추천이 아직 준비되지 않았어요. 직접 입력해 주세요.',
  rate: '지금 AI 요청이 많아요. 잠시 뒤에 다시 눌러 주세요.',
  mine: '너무 많이 요청했어요. 한 시간 뒤에 다시 해 주세요.',
  timeout: 'AI 응답이 너무 늦어요. 잠시 뒤에 다시 눌러 주세요. 직접 입력해도 돼요.',
  fail: 'AI 응답을 받지 못했어요. 잠시 뒤에 다시 눌러 주세요.'
};

function hasKey() { return !!process.env.HASA_API_KEY; }

function clientIp(req) {
  const fwd = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* 한 기기(IP)가 한 시간에 부를 수 있는 횟수 제한. 서버 함수 한 개 안에서만 세는 간단한 제한이라 손님이 많으면 느슨해진다 */
function makeLimiter(perHour) {
  const hits = new Map();
  return function overLimit(ip, now) {
    const recent = (hits.get(ip) || []).filter((t) => now - t < 3600000);
    if (recent.length >= perHour) { hits.set(ip, recent); return true; }
    recent.push(now); hits.set(ip, recent);
    if (hits.size > 1000) for (const [k, v] of hits) if (!v.some((t) => now - t < 3600000)) hits.delete(k);
    return false;
  };
}

/* 오픈하사에 채팅 요청 하나. body에는 messages 등을 넣고, 모델 이름은 여기서 붙인다.
 * 돌려주는 값: { kind: 'ok', text } 또는 { kind: 'rate' | 'denied' | 'timeout' | 'upstream' | 'network' } */
async function chat(body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.HASA_API_KEY },
      body: JSON.stringify(Object.assign({ model: MODEL }, body)),
      signal: ctl.signal
    });
    if (r.status === 429) return { kind: 'rate' };
    if (r.status === 401 || r.status === 403) { console.error('오픈하사가 키를 받아 주지 않았어요 (' + r.status + ')'); return { kind: 'denied' }; }
    if (!r.ok) {
      let snippet = '';
      try { snippet = String(await r.text()).slice(0, 200); } catch (e) { /* 본문이 없어도 상태만 남긴다 */ }
      console.error('오픈하사 응답 오류 ' + r.status + ' ' + snippet);
      return { kind: 'upstream' };
    }
    const data = await r.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return { kind: 'ok', text };
  } catch (e) {
    if (e && e.name === 'AbortError') return { kind: 'timeout' };
    console.error('오픈하사 호출 실패: ' + (e && e.name));
    return { kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/* chat()이 실패했을 때 사용자에게 줄 상태 코드와 안내 */
function failure(kind) {
  if (kind === 'rate') return { status: 429, message: MSG.rate };
  if (kind === 'denied') return { status: 500, message: MSG.nokey };
  if (kind === 'timeout') return { status: 504, message: MSG.timeout };
  return { status: 502, message: MSG.fail };
}

module.exports = { UPSTREAM_URL, MODEL, MSG, hasKey, clientIp, makeLimiter, chat, failure };
