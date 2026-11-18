'use strict';
/* 시간표 사진 읽기 (Vercel 서버 함수).
 * 브라우저가 줄여 보낸 사진 한 장을 오픈하사(이미지를 읽는 모델)에 보내 수업 칸을 읽고, 고정 일정 후보 목록을 돌려준다.
 * 사진은 저장하지 않고 이 요청 안에서만 쓴다. 후보는 화면에서 사용자가 확인·고친 뒤에 넣는다 (끝 시각은 칸 높이로 짐작한 값이라 틀릴 수 있다). */
const hasa = require('../lib/hasa.js');

const TIMEOUT_MS = 28000; // 이미지를 읽는 호출은 글보다 느리다 (vercel.json에서 함수 실행 시간도 늘려 둠)
const LIMIT_PER_HOUR = 10;
const MAX_IMAGE_CHARS = 3500000; // data URL 글자 수. Vercel의 요청 크기 제한(4.5MB)보다 작게
const MAX_BLOCKS = 30, MAX_NAME = 30;
const DAYS = { 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 0 };

const MSG = {
  input: '시간표 사진을 다시 골라 주세요.',
  big: '사진이 너무 커요. 더 작은 사진으로 해 주세요.',
  empty: '시간표를 읽지 못했어요. 시간표 칸이 또렷하게 보이는 사진으로 다시 해 보세요.'
};

function buildMessages(dataUrl) {
  const text = [
    '이 이미지는 대학생의 주간 시간표 화면입니다. 색칠된 칸 하나가 수업(또는 일정) 하나입니다.',
    '각 칸을 읽어서 JSON만 출력하세요. 설명은 쓰지 마세요.',
    '{"blocks":[{"name":"수업 이름","day":"월","start":"09:00","end":"11:50"}]}',
    '규칙:',
    '- name: 칸에 적힌 수업 이름. 줄이 바뀌어 나뉜 글자는 이어 붙이고, 강의실·건물·교수 이름은 넣지 않기',
    '- day: 칸이 있는 열의 요일 (월 화 수 목 금 토 일 중 하나)',
    '- start: 칸 안에 시각이 적혀 있으면 그 시각, 없으면 칸 위쪽 가장자리의 시각 (24시간제 HH:MM)',
    '- end: 칸 아래쪽 가장자리의 시각 (24시간제 HH:MM). 왼쪽 시간 눈금은 12시간제 숫자입니다 (1은 13시, 3은 15시). 눈금 한 칸이 1시간이니 칸의 높이로 끝나는 시각을 가늠해 5분 단위로 쓰기',
    '- 같은 수업이 여러 요일에 있으면 요일마다 항목을 따로 쓰기',
    '- 비어 있는 칸, 광고, 메뉴, 학점 계산기처럼 시간표 밖에 있는 것은 넣지 않기'
  ].join('\n');
  return [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: dataUrl } }] }];
}

/* 요청 몸통 검사: { image: 'data:image/jpeg;base64,...' } → data URL, 잘못이면 null, 너무 크면 'big' */
function readInput(body) {
  let b = body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { return null; } }
  if (!b || typeof b !== 'object' || typeof b.image !== 'string') return null;
  if (b.image.length > MAX_IMAGE_CHARS) return 'big';
  if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(b.image)) return null;
  return b.image;
}

function normTime(v) {
  const m = typeof v === 'string' ? v.trim().match(/^(\d{1,2}):(\d{2})$/) : null;
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

function dayOf(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6) return v;
  if (typeof v !== 'string') return null;
  const c = v.trim().charAt(0);
  return Object.prototype.hasOwnProperty.call(DAYS, c) ? DAYS[c] : null;
}

function kindOf(name) {
  if (/알바|아르바이트/.test(name)) return '알바';
  if (/통학|등교|하교|이동/.test(name)) return '통학';
  return '수업';
}

/* 모델 답에서 고정 일정 후보를 뽑는다. 같은 이름·시각이 여러 요일에 있으면 한 항목의 요일 목록으로 합친다 */
function parseBlocks(text) {
  if (typeof text !== 'string') return [];
  const body = text.replace(/```[a-zA-Z]*/g, '');
  let list = null;
  const obj = body.match(/\{[\s\S]*\}/);
  if (obj) { try { const j = JSON.parse(obj[0]); if (Array.isArray(j.blocks)) list = j.blocks; } catch (e) { /* 아래에서 배열로 */ } }
  if (!list) { const arr = body.match(/\[[\s\S]*\]/); if (arr) { try { const j = JSON.parse(arr[0]); if (Array.isArray(j)) list = j; } catch (e) { return []; } } }
  if (!list) return [];
  const merged = new Map();
  for (const it of list) {
    if (!it || typeof it !== 'object' || typeof it.name !== 'string') continue;
    const name = it.name.replace(/\s+/g, ' ').replace(/^[\s.,;:·-]+|[\s.,;:·-]+$/g, '').slice(0, MAX_NAME);
    const start = normTime(it.start), end = normTime(it.end);
    if (!name || !start || !end) continue;
    const span = toMin(end) - toMin(start);
    if (span < 15 || span > 14 * 60) continue;
    const days = (Array.isArray(it.days) ? it.days : [it.day]).map(dayOf).filter((d) => d !== null);
    if (!days.length) continue;
    const key = name + '|' + start + '|' + end;
    const cur = merged.get(key) || { name, kind: kindOf(name), days: [], start, end };
    days.forEach((d) => { if (!cur.days.includes(d)) cur.days.push(d); });
    merged.set(key, cur);
  }
  const monFirst = (d) => (d + 6) % 7; // 월요일이 먼저 오게
  return [...merged.values()]
    .map((b) => Object.assign(b, { days: b.days.sort((x, y) => monFirst(x) - monFirst(y)) }))
    .sort((a, b) => monFirst(a.days[0]) - monFirst(b.days[0]) || toMin(a.start) - toMin(b.start))
    .slice(0, MAX_BLOCKS);
}

function createHandler(opts) {
  const timeoutMs = (opts && opts.timeoutMs) || TIMEOUT_MS;
  const overLimit = hasa.makeLimiter(LIMIT_PER_HOUR);

  return async function handler(req, res) {
    const send = (status, payload) => { res.setHeader('Cache-Control', 'no-store'); res.status(status).json(payload); };
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(405, { message: hasa.MSG.method }); }

    const image = readInput(req.body);
    if (image === 'big') return send(413, { message: MSG.big });
    if (!image) return send(400, { message: MSG.input });

    if (!hasa.hasKey()) { console.error('HASA_API_KEY가 설정되지 않았어요'); return send(500, { message: hasa.MSG.nokey }); }
    if (overLimit(hasa.clientIp(req), Date.now())) return send(429, { message: hasa.MSG.mine });

    const r = await hasa.chat({ messages: buildMessages(image), temperature: 0.1, max_tokens: 2000 }, timeoutMs);
    if (r.kind !== 'ok') { const f = hasa.failure(r.kind); return send(f.status, { message: f.message }); }
    const blocks = parseBlocks(r.text);
    if (!blocks.length) return send(502, { message: MSG.empty });
    return send(200, { blocks });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.parseBlocks = parseBlocks;
module.exports.readInput = readInput;
module.exports.buildMessages = buildMessages;
