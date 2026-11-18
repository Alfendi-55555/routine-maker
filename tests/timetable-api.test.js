'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../api/timetable.js');

// 진짜 오픈하사 대신 가짜를 끼운다. 키도 시험용 가짜 값이고, 사진도 아주 작은 가짜 데이터다.
const realFetch = global.fetch;
const realKey = process.env.HASA_API_KEY;
test.afterEach(() => {
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.HASA_API_KEY; else process.env.HASA_API_KEY = realKey;
});

const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/';
function call(handler, body, extra) {
  const res = { setHeader() {}, status(n) { this.code = n; return this; }, json(p) { this.body = p; return this; } };
  const req = Object.assign({ method: 'POST', body, headers: {}, socket: { remoteAddress: '1.1.1.1' } }, extra);
  return handler(req, res).then(() => res);
}
const reply = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });
const SAMPLE = JSON.stringify({ blocks: [
  { name: '수업 A', day: '월', start: '09:00', end: '10:50' },
  { name: '수업 A', day: '수', start: '09:00', end: '10:50' },
  { name: '수업 B', day: '화', start: '13:00', end: '15:50' },
  { name: '팀 모임', day: '금', start: '15:00', end: '17:00' }
] });

test('정상: 사진을 이미지 형식으로 보내고, 같은 수업은 요일을 합쳐 돌려준다', async () => {
  process.env.HASA_API_KEY = 'test-key-not-real';
  let seen;
  global.fetch = async (url, init) => { seen = { url, init }; return reply('```json\n' + SAMPLE + '\n```'); };
  const res = await call(api.createHandler(), { image: IMG });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.blocks, [
    { name: '수업 A', kind: '수업', days: [1, 3], start: '09:00', end: '10:50' },
    { name: '수업 B', kind: '수업', days: [2], start: '13:00', end: '15:50' },
    { name: '팀 모임', kind: '수업', days: [5], start: '15:00', end: '17:00' }
  ]);
  assert.equal(seen.url, 'https://open.hasa.re.kr/v1/chat/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer test-key-not-real');
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, 'gemma-4-31b');
  const parts = sent.messages[0].content;
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].type, 'image_url');
  assert.equal(parts[1].image_url.url, IMG);
  assert.equal(JSON.stringify(res.body).includes('test-key-not-real'), false);
  assert.equal(JSON.stringify(res.body).includes(IMG), false, '사진을 돌려주지 않음');
});

test('400·413: 사진이 아니거나 너무 크면 오픈하사를 부르지 않는다', async () => {
  process.env.HASA_API_KEY = 'test-key-not-real';
  let called = 0;
  global.fetch = async () => { called += 1; return reply(SAMPLE); };
  const h = api.createHandler();
  for (const b of [undefined, null, 'x', {}, { image: 5 }, { image: 'http://x/a.jpg' }, { image: 'data:text/html;base64,AAAA' }, { image: 'data:image/jpeg;base64,@@@' }]) {
    const res = await call(h, b); assert.equal(res.code, 400, JSON.stringify(b)); assert.ok(res.body.message);
  }
  const big = await call(h, { image: 'data:image/jpeg;base64,' + 'A'.repeat(3600000) });
  assert.equal(big.code, 413);
  assert.equal((await call(h, { image: IMG }, { method: 'GET' })).code, 405);
  assert.equal(called, 0);
});

test('500: 키가 없으면 오픈하사를 부르지 않고 안내만', async () => {
  delete process.env.HASA_API_KEY;
  let called = 0;
  global.fetch = async () => { called += 1; return reply(SAMPLE); };
  const res = await call(api.createHandler(), { image: IMG });
  assert.equal(res.code, 500);
  assert.match(res.body.message, /준비되지 않았어요/);
  assert.equal(called, 0);
});

test('429·504·502: 한도 초과, 시간 초과, 못 읽은 경우', async () => {
  process.env.HASA_API_KEY = 'test-key-not-real';
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const rate = await call(api.createHandler(), { image: IMG });
  assert.equal(rate.code, 429); assert.match(rate.body.message, /잠시 뒤에 다시/);

  global.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const slow = await call(api.createHandler({ timeoutMs: 50 }), { image: IMG });
  assert.equal(slow.code, 504); assert.match(slow.body.message, /너무 늦어요/);

  global.fetch = async () => reply('시간표를 읽을 수 없어요.');
  const none = await call(api.createHandler(), { image: IMG });
  assert.equal(none.code, 502); assert.match(none.body.message, /읽지 못했어요/);
  global.fetch = async () => ({ ok: false, status: 400, text: async () => 'bad request', json: async () => ({}) });
  assert.equal((await call(api.createHandler(), { image: IMG })).code, 502, '이미지를 못 받는 모델이면 502');
});

test('한 기기가 한 시간에 10번을 넘기면 429', async () => {
  process.env.HASA_API_KEY = 'test-key-not-real';
  global.fetch = async () => reply(SAMPLE);
  const h = api.createHandler();
  for (let i = 0; i < 10; i++) assert.equal((await call(h, { image: IMG })).code, 200);
  assert.equal((await call(h, { image: IMG })).code, 429);
  assert.equal((await call(h, { image: IMG }, { socket: { remoteAddress: '2.2.2.2' } })).code, 200);
});

test('읽은 결과 정리: 시각 형식·길이·요일을 검사하고 이름을 다듬는다', () => {
  const p = (arr) => api.parseBlocks(JSON.stringify({ blocks: arr }));
  // 시작이 끝보다 늦거나 너무 짧은 것, 시각 형식이 틀린 것, 요일을 모르는 것은 버린다
  assert.deepEqual(p([
    { name: '가', day: '월', start: '10:00', end: '09:00' },
    { name: '나', day: '월', start: '10:00', end: '10:10' },
    { name: '다', day: '월', start: '10시', end: '11:00' },
    { name: '라', day: '언제', start: '10:00', end: '11:00' },
    { name: '', day: '월', start: '10:00', end: '11:00' },
    { name: '마', day: '월', start: '9:00', end: '10:30' }
  ]), [{ name: '마', kind: '수업', days: [1], start: '09:00', end: '10:30' }], '9:00은 09:00으로');
  assert.deepEqual(p([{ name: '  사회과학과\n데이터  ', day: '월요일', start: '09:00', end: '10:00' }])[0].name, '사회과학과 데이터');
  assert.deepEqual(p([{ name: '카페 알바', day: '토', start: '10:00', end: '14:00' }, { name: '등교', day: '월', start: '08:00', end: '09:00' }]).map((b) => b.kind), ['통학', '알바'], '월요일이 먼저');
  assert.deepEqual(p([{ name: '합쳐진', days: ['금', '월'], start: '09:00', end: '10:00' }])[0].days, [1, 5], 'days 목록도 받음');
  assert.equal(api.parseBlocks(JSON.stringify({ blocks: Array.from({ length: 40 }, (_, i) => ({ name: '수업' + i, day: '월', start: '09:00', end: '10:00' })) })).length, 30);
  assert.deepEqual(api.parseBlocks('[{"name":"배열만","day":"화","start":"13:00","end":"14:00"}]').length, 1);
  assert.deepEqual(api.parseBlocks(null), []);
  assert.deepEqual(api.parseBlocks('읽을 수 없어요'), []);
});
