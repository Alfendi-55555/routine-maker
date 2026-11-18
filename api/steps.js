'use strict';
/* 단계 이름 추천 (Vercel 서버 함수).
 * 브라우저 → 이 함수 → 오픈하사(OpenAI 호환) 순서로 부른다 (공통 부분은 lib/hasa.js).
 * 보내는 것은 할 일 이름과 카테고리뿐이고, 받는 것은 단계 이름뿐이다 (시간은 추천하지 않음). */
const hasa = require('../lib/hasa.js');

const TIMEOUT_MS = 20000;
const MAX_NAME = 50, MAX_CATEGORY = 20;
const MAX_STEPS = 8, MAX_STEP_LEN = 30;
// 로그인이 없어서 한 기기(IP)가 한 시간에 부를 수 있는 횟수를 제한한다
const LIMIT_PER_HOUR = 20;

const MSG = {
  input: '할 일 이름을 1~' + MAX_NAME + '자로 적어 주세요.',
  empty: '추천을 만들지 못했어요. 다시 눌러 주세요.'
};

function buildMessages(name, category) {
  // 일부 모델은 system 역할을 받지 않아서 지시와 입력을 한 메시지로 보낸다
  const content = [
    '할 일을 시작하기 전에 세우는 단계로 나눠 주세요.',
    '- 할 일: ' + name,
    '- 분류: ' + category,
    '규칙:',
    '- 한국어 명사구로, 단계 하나는 14자 이내',
    '- 3~6개, 시간(분)이나 번호는 쓰지 않기',
    '- 설명 없이 JSON만: {"steps":["단계1","단계2"]}'
  ].join('\n');
  return [{ role: 'user', content }];
}

/* 모델 답에서 단계 이름 목록만 뽑는다. JSON이 아니면 줄 단위로 읽는다 */
function parseSteps(text) {
  if (typeof text !== 'string') return [];
  const body = text.replace(/```[a-zA-Z]*/g, '');
  let list = null;
  const obj = body.match(/\{[\s\S]*\}/);
  if (obj) { try { const j = JSON.parse(obj[0]); if (Array.isArray(j.steps)) list = j.steps; } catch (e) { /* 아래에서 줄 단위로 */ } }
  if (!list) { const arr = body.match(/\[[\s\S]*\]/); if (arr) { try { const j = JSON.parse(arr[0]); if (Array.isArray(j)) list = j; } catch (e) { /* 아래에서 줄 단위로 */ } } }
  if (!list) list = body.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ''));
  const out = [], seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const s = raw.replace(/\(?\s*\d+\s*(?:분|시간)\s*\)?/g, '').replace(/[\s.,;:·]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_STEP_LEN);
    if (!s || seen.has(s)) continue;
    seen.add(s); out.push(s);
    if (out.length >= MAX_STEPS) break;
  }
  return out;
}

/* 요청 몸통 검사: { name, category } → 정리한 값, 잘못이면 null */
function readInput(body) {
  let b = body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { return null; } }
  if (!b || typeof b !== 'object') return null;
  if (typeof b.name !== 'string') return null;
  const name = b.name.replace(/[\r\n]+/g, ' ').trim();
  if (!name || name.length > MAX_NAME) return null;
  let category = '기타';
  if (b.category != null) {
    if (typeof b.category !== 'string') return null;
    category = b.category.replace(/[\r\n]+/g, ' ').trim() || '기타';
    if (category.length > MAX_CATEGORY) return null;
  }
  return { name, category };
}

function createHandler(opts) {
  const timeoutMs = (opts && opts.timeoutMs) || TIMEOUT_MS;
  const overLimit = hasa.makeLimiter(LIMIT_PER_HOUR);

  return async function handler(req, res) {
    const send = (status, payload) => { res.setHeader('Cache-Control', 'no-store'); res.status(status).json(payload); };
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(405, { message: hasa.MSG.method }); }

    const input = readInput(req.body);
    if (!input) return send(400, { message: MSG.input });

    if (!hasa.hasKey()) { console.error('HASA_API_KEY가 설정되지 않았어요'); return send(500, { message: hasa.MSG.nokey }); }
    if (overLimit(hasa.clientIp(req), Date.now())) return send(429, { message: hasa.MSG.mine });

    const r = await hasa.chat({ messages: buildMessages(input.name, input.category), temperature: 0.3, max_tokens: 300 }, timeoutMs);
    if (r.kind !== 'ok') { const f = hasa.failure(r.kind); return send(f.status, { message: f.message }); }
    const steps = parseSteps(r.text);
    if (steps.length < 2) return send(502, { message: MSG.empty });
    return send(200, { steps });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.parseSteps = parseSteps;
module.exports.readInput = readInput;
module.exports.buildMessages = buildMessages;
module.exports.UPSTREAM_URL = hasa.UPSTREAM_URL;
module.exports.MODEL = hasa.MODEL;
