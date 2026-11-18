'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../api/steps.js');

// 진짜 오픈하사 대신 가짜를 끼운다. 키도 시험용 가짜 값이다.
const realFetch = global.fetch;
const realKey = process.env.HASA_API_KEY;
test.afterEach(() => {
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.HASA_API_KEY; else process.env.HASA_API_KEY = realKey;
});

function call(handler, body, extra) {
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, json(p) { this.body = p; return this; } };
  const req = Object.assign({ method: 'POST', body, headers: {}, socket: { remoteAddress: '1.1.1.1' } }, extra);
  return handler(req, res).then(() => res);
}
const okReply = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });

test('정상: 단계 이름만 돌려주고, 약속한 주소·모델·키로 부른다', async () => {
  process.env.HASA_API_KEY = 'test-key-not-real';
  let seen;
  global.fetch = async (url, init) => { seen = { url, init }; return okReply('```json\n{"steps":["자료 찾기","초안 쓰기 (40분)","검토","검토"]}\n```'); };
  const res = await call(api.createHandler(), { name: '자료구조 보고서 쓰기', category: '과제' });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { steps: ['자료 찾기', '초안 쓰기', '검토'] }, '시간 표현을 빼고 같은 이름은 한 번만');
  assert.equal(seen.url, 'https://open.hasa.re.kr/v1/chat/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer test-key-not-real');
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, 'gemma-4-31b');
  assert.match(sent.messages[0].content, /자료구조 보고서 쓰기/);
  assert.match(sent.messages[0].content, /과제/);
  assert.ok(seen.init.signal, '시간 제한용 신호를 붙임');
  assert.equal(JSON.stringify(res.body).includes('test-key-not-real'), false, '응답에 키가 없음');
});

test('400: 잘못된 입력은 오픈하사를 부르지 않는다', async () => {
  process.env.HASA_API_KEY = 'test-key-not-real';
  let called = 0;
  global.fetch = async () => { called += 1; return okReply('{"steps":["가","나"]}'); };
  const h = api.createHandler();
  const bad = [undefined, null, 'not json', {}, { name: '' }, { name: '   ' }, { name: 5 }, { name: '가'.repeat(51) },
    { name: '할 일', category: 3 }, { name: '할 일', category: '가'.repeat(21) }];
  for (const b of bad) { const res = await call(h, b); assert.equal(res.code, 400, JSON.stringify(b)); assert.ok(res.body.message); }
  assert.equal(called, 0);
  const get = await call(h, { name: '할 일' }, { method: 'GET' });
  assert.equal(get.code, 405);
});

test('500: 키가 없으면 오픈하사를 부르지 않고 안내만', async () => {
  delete process.env.HASA_API_KEY;
  let called = 0;
  global.fetch = async () => { called += 1; return okReply('{}'); };
  const res = await call(api.createHandler(), { name: '할 일' });
  assert.equal(res.code, 500);
  assert.match(res.body.message, /준비되지 않았어요/);
  assert.equal(called, 0);
});

test('429: 오픈하사가 한도 초과로 답하면 안내 문구', async () => {
  process.env.HASA_API_KEY = 'test-key-not-real';
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const res = await call(api.createHandler(), { name: '할 일' });
  assert.equal(res.code, 429);
  assert.match(res.body.message, /잠시 뒤에 다시/);
});

test('시간 초과: 응답이 안 오면 끊고 안내 문구 (504)', async () => {
  process.env.HASA_API_KEY = 'test-key-not-real';
  global.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const t0 = Date.now();
  const res = await call(api.createHandler({ timeoutMs: 50 }), { name: '할 일' });
  assert.equal(res.code, 504);
  assert.match(res.body.message, /너무 늦어요/);
  assert.ok(Date.now() - t0 < 2000);
});

test('그 밖: 오픈하사 오류·엉뚱한 답·키 거절은 안내하고 키를 드러내지 않는다', async () => {
  process.env.HASA_API_KEY = 'test-key-not-real';
  const h = () => api.createHandler();
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  assert.equal((await call(h(), { name: '할 일' })).code, 502);
  global.fetch = async () => okReply('죄송해요, 도와드릴 수 없어요.');
  const one = await call(h(), { name: '할 일' });
  assert.equal(one.code, 502, '단계를 둘 이상 못 얻으면 실패로');
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const denied = await call(h(), { name: '할 일' });
  assert.equal(denied.code, 500);
  assert.equal(JSON.stringify(denied.body).includes('test-key-not-real'), false);
  global.fetch = async () => { throw new TypeError('network'); };
  assert.equal((await call(h(), { name: '할 일' })).code, 502);
});

test('한 기기가 한 시간에 20번을 넘기면 429', async () => {
  process.env.HASA_API_KEY = 'test-key-not-real';
  global.fetch = async () => okReply('{"steps":["가","나"]}');
  const h = api.createHandler();
  for (let i = 0; i < 20; i++) assert.equal((await call(h, { name: '할 일' })).code, 200);
  const over = await call(h, { name: '할 일' });
  assert.equal(over.code, 429);
  assert.match(over.body.message, /한 시간 뒤/);
  const other = await call(h, { name: '할 일' }, { socket: { remoteAddress: '2.2.2.2' } });
  assert.equal(other.code, 200, '다른 기기는 영향 없음');
});

test('단계 뽑기: JSON·코드 블록·번호 줄 모두, 시간 표현은 빼고 8개까지', () => {
  assert.deepEqual(api.parseSteps('{"steps":["가","나"]}'), ['가', '나']);
  assert.deepEqual(api.parseSteps('설명입니다\n```json\n{"steps":["가","나","다"]}\n```'), ['가', '나', '다']);
  assert.deepEqual(api.parseSteps('["가","나"]'), ['가', '나']);
  assert.deepEqual(api.parseSteps('1. 자료 찾기 (20분)\n2) 초안 쓰기\n- 검토 1시간'), ['자료 찾기', '초안 쓰기', '검토']);
  assert.equal(api.parseSteps(JSON.stringify({ steps: Array.from({ length: 12 }, (_, i) => '단계' + i) })).length, 8);
  assert.deepEqual(api.parseSteps(null), []);
  assert.equal(api.parseSteps('{"steps":["' + '가'.repeat(60) + '"]}')[0].length, 30);
});
