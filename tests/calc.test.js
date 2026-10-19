// 실행: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const Calc = require('../js/calc.js');
const Store = require('../js/store.js');

const settings = { dayStart: '08:00', dayEnd: '23:00', bufferMin: 10 };
const iso = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

function rec(over) {
  return Object.assign({
    id: 't_' + Math.random(), kind: 'routine', routineId: 'r1', name: 'x', category: '공부', version: 'base',
    estimateMin: 30, actualMin: 30, amount: null, plannedStartAt: null,
    startedAt: iso(2026, 10, 14), endedAt: iso(2026, 10, 14, 13), source: 'timer'
  }, over);
}

// ---------- 빈 시간 ----------
test('빈 시간: 고정 일정 앞뒤로 전환 시간을 빼고 계산한다', () => {
  const blocks = [{ id: 'b1', name: '자료구조', kind: '수업', days: [1, 3], start: '10:30', end: '11:45' }];
  const gaps = Calc.computeGaps(blocks, 1, settings);
  assert.deepEqual(gaps.map(g => [Calc.fmtHM(g.start), Calc.fmtHM(g.end)]), [['08:00', '10:20'], ['11:55', '23:00']]);
});

test('빈 시간: 다른 요일의 일정은 무시한다', () => {
  const blocks = [{ id: 'b1', name: 'a', kind: '수업', days: [1], start: '10:00', end: '11:00' }];
  assert.equal(Calc.computeGaps(blocks, 2, settings).length, 1);
});

test('빈 시간: 겹치는 일정은 합치고 15분 미만은 버린다', () => {
  const blocks = [
    { id: 'a', name: 'a', kind: '수업', days: [1], start: '09:00', end: '10:00' },
    { id: 'b', name: 'b', kind: '수업', days: [1], start: '09:30', end: '11:00' },
    { id: 'c', name: 'c', kind: '수업', days: [1], start: '11:30', end: '12:00' } // 11:10~11:20 = 10분 → 버림
  ];
  const gaps = Calc.computeGaps(blocks, 1, settings);
  assert.deepEqual(gaps.map(g => [Calc.fmtHM(g.start), Calc.fmtHM(g.end)]), [['08:00', '08:50'], ['12:10', '23:00']]);
});

test('빈 시간: 정확히 15분은 남긴다', () => {
  const s = { dayStart: '08:00', dayEnd: '23:00', bufferMin: 0 };
  const blocks = [{ id: 'a', name: 'a', kind: '수업', days: [1], start: '08:15', end: '22:45' }];
  assert.deepEqual(Calc.computeGaps(blocks, 1, s).map(g => g.len), [15, 15]);
});

test('빈 시간: 하루 활동 시간 밖으로 나간 일정은 잘라서 계산한다', () => {
  const blocks = [{ id: 'a', name: '통학', kind: '통학', days: [1], start: '07:00', end: '08:30' }];
  const gaps = Calc.computeGaps(blocks, 1, settings);
  assert.equal(Calc.fmtHM(gaps[0].start), '08:40');
});

test('빈 시간: 지금 시각 기준으로 지난/진행 중/남은 빈 시간을 나눈다', () => {
  const blocks = [{ id: 'b1', name: 'a', kind: '수업', days: [1], start: '12:00', end: '13:00' }];
  const gaps = Calc.computeGaps(blocks, 1, settings, Calc.toMin('15:00'));
  assert.equal(gaps[0].state, 'past');
  assert.equal(gaps[1].state, 'now');
  assert.equal(gaps[1].remaining, 8 * 60);
});

test('겹치는 고정 일정 찾기', () => {
  const blocks = [{ id: 'a', name: 'a', kind: '수업', days: [1, 3], start: '10:00', end: '11:00' }];
  const hit = Calc.findOverlaps(blocks, { days: [3, 5], start: '10:30', end: '12:00' });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].day, 3);
  assert.equal(Calc.findOverlaps(blocks, { days: [1], start: '11:00', end: '12:00' }).length, 0);
  assert.equal(Calc.findOverlaps(blocks, { days: [1], start: '10:00', end: '11:00' }, 'a').length, 0);
});

// ---------- 배율과 보정 ----------
test('배율: 실제 합 ÷ 예상 합, 소수 첫째 자리', () => {
  const r = Calc.ratioOf([rec({ estimateMin: 60, actualMin: 95 }), rec({ estimateMin: 45, actualMin: 70 }), rec({ estimateMin: 90, actualMin: 140 })]);
  assert.equal(r.ratio, 1.6);
});

test('보정: 기록 2개면 없음, 3개면 루틴 배율', () => {
  const two = [rec({ actualMin: 45 }), rec({ actualMin: 45 })];
  assert.equal(Calc.calibration(two, { routineId: 'r1', category: '공부' }), null);
  const three = two.concat(rec({ actualMin: 45 }));
  const cal = Calc.calibration(three, { routineId: 'r1', category: '공부' });
  assert.equal(cal.source, 'routine');
  assert.equal(cal.ratio, 1.5);
  assert.equal(Calc.predict(45, cal), 70); // 67.5 → 5분 단위
});

test('보정: 루틴 기록이 모자라면 카테고리 기록으로', () => {
  const rs = [rec({ routineId: 'r2' }), rec({ routineId: null, kind: 'task' }), rec({ routineId: 'r3', actualMin: 60 })];
  const cal = Calc.calibration(rs, { routineId: 'r1', category: '공부' });
  assert.equal(cal.source, 'category');
  assert.equal(cal.n, 3);
});

test('보정이 없으면 계획 시간을 그대로 쓴다', () => {
  assert.equal(Calc.predict(45, null), 45);
});

test('들어가는지 판단', () => {
  assert.equal(Calc.fit(70, 15, 80), 'fits');
  assert.equal(Calc.fit(70, 15, 30), 'min');
  assert.equal(Calc.fit(70, 15, 10), 'tight');
});

// ---------- 앵커와 빈 시간 고르기 ----------
test('사건 앵커: 그 일정이 있는 날만 계획 시각이 생긴다', () => {
  const blocks = [{ id: 'b1', name: '자료구조', kind: '수업', days: [1, 3], start: '10:30', end: '11:45' }];
  const r = { anchor: { type: 'block', blockId: 'b1' } };
  assert.equal(Calc.anchorToday(r, blocks, 1).plannedMin, Calc.toMin('11:45'));
  assert.equal(Calc.anchorToday(r, blocks, 2).today, false);
  assert.equal(Calc.anchorToday({ anchor: { type: 'block', blockId: 'gone' } }, blocks, 1).type, 'none');
});

test('빈 시간 고르기: 앵커 직후 빈 시간, 없으면 가장 큰 빈 시간', () => {
  const blocks = [{ id: 'b1', name: 'a', kind: '수업', days: [1], start: '10:30', end: '11:45' }];
  const gaps = Calc.computeGaps(blocks, 1, settings, Calc.toMin('09:00'));
  const after = Calc.pickGap(gaps, Calc.toMin('11:45'), Calc.toMin('09:00'), 10);
  assert.equal(after.anchored, true);
  assert.equal(Calc.fmtHM(after.gap.start), '11:55');
  const timeAnchor = Calc.pickGap(gaps, Calc.toMin('22:00'), Calc.toMin('09:00'), 10);
  assert.equal(timeAnchor.avail, 60); // 22:00~23:00
  const none = Calc.pickGap(gaps, null, Calc.toMin('09:00'), 10);
  assert.equal(none.anchored, false);
  assert.equal(Calc.fmtHM(none.gap.start), '11:55');
});

test('빈 시간 고르기: 진행 중인 빈 시간은 지금부터 남은 만큼', () => {
  const gaps = Calc.computeGaps([], 1, settings, Calc.toMin('22:30'));
  const p = Calc.pickGap(gaps, null, Calc.toMin('22:30'), 10);
  assert.equal(p.avail, 30);
});

// ---------- 달성과 놓침 ----------
test('이번 주 달성: 같은 날 두 번은 한 번으로 센다', () => {
  const now = new Date(2026, 9, 16, 20); // 2026-10-16 금
  const rs = [
    rec({ startedAt: iso(2026, 10, 12, 9) }), rec({ startedAt: iso(2026, 10, 12, 20) }),
    rec({ startedAt: iso(2026, 10, 14, 9) }), rec({ startedAt: iso(2026, 10, 11, 9) }) // 지난주 일요일
  ];
  assert.equal(Calc.weekDone(rs, 'r1', now), 2);
});

test('지난 4주: 만들기 전 주는 none', () => {
  const now = new Date(2026, 9, 16, 20);
  const routine = { id: 'r1', perWeek: 1, createdAt: iso(2026, 10, 1) };
  const rs = [rec({ startedAt: iso(2026, 10, 8) })];
  const weeks = Calc.lastWeeks(rs, routine, now);
  assert.deepEqual(weeks.map(w => w.state), ['none', 'none', 'miss', 'done']);
});

test('매일 루틴을 어제 놓쳤는지', () => {
  const now = new Date(2026, 9, 16, 9);
  const routine = { id: 'r1', perWeek: 7, createdAt: iso(2026, 10, 1) };
  assert.equal(Calc.missedYesterday([], routine, now), true);
  assert.equal(Calc.missedYesterday([rec({ startedAt: iso(2026, 10, 15, 22) })], routine, now), false);
  assert.equal(Calc.missedYesterday([], Object.assign({}, routine, { createdAt: iso(2026, 10, 15, 8) }), now), false);
  assert.equal(Calc.missedYesterday([], Object.assign({}, routine, { perWeek: 3 }), now), false);
});

test('주 N회: 남은 횟수가 남은 날보다 많으면 빠듯', () => {
  const sat = new Date(2026, 9, 17, 9); // 토요일: 오늘 포함 2일 남음
  assert.deepEqual(Calc.weekTight({ perWeek: 3 }, 0, false, sat), { left: 3, daysLeft: 2 });
  assert.equal(Calc.weekTight({ perWeek: 3 }, 1, false, sat), null);
  assert.equal(Calc.weekTight({ perWeek: 7 }, 0, false, sat), null);
});

// ---------- 측정 ----------
test('실제 시간: 분 반올림, 최소 1분', () => {
  assert.equal(Calc.actualMinutes(iso(2026, 10, 14, 12, 0), iso(2026, 10, 14, 12, 0)), 1);
  assert.equal(Calc.actualMinutes(iso(2026, 10, 14, 12, 0), iso(2026, 10, 14, 12, 48)), 48);
});

test('시작 지연: 0~180분 안에서만', () => {
  assert.equal(Calc.delayMinutes(iso(2026, 10, 14, 11, 45), iso(2026, 10, 14, 12, 20)), 35);
  assert.equal(Calc.delayMinutes(iso(2026, 10, 14, 11, 45), iso(2026, 10, 14, 11, 40)), null);
  assert.equal(Calc.delayMinutes(iso(2026, 10, 14, 8, 0), iso(2026, 10, 14, 12, 0)), null);
  assert.equal(Calc.delayMinutes(null, iso(2026, 10, 14, 12, 0)), null);
});

test('변화 비교: 9개면 준비 안 됨, 10개면 처음 5개와 최근 5개 중앙값', () => {
  assert.equal(Calc.compareHalves([1, 2, 3, 4, 5, 6, 7, 8, 9]).ready, false);
  const o = Calc.compareHalves([42, 40, 45, 41, 39, 30, 29, 28, 27, 31]);
  assert.equal(o.ready, true);
  assert.equal(o.first, 41);
  assert.equal(o.recent, 29);
  assert.equal(o.dir, 'down');
  assert.equal(Calc.compareHalves([30, 31, 32, 30, 31, 32, 31, 30, 33, 31]).dir, 'same');
});

test('관찰: 분량 고정은 최소 버전을 빼고, 분량 변동은 단위당 시간', () => {
  const fixed = { id: 'r1', measure: { type: 'fixed', amount: 100, unit: '개' } };
  const rs = [];
  for (let i = 0; i < 10; i++) rs.push(rec({ startedAt: iso(2026, 9, 1 + i), actualMin: 40 - i }));
  rs.push(rec({ startedAt: iso(2026, 9, 20), actualMin: 5, version: 'min' }));
  const o = Calc.observeDuration(rs, fixed);
  assert.equal(o.n, 10);
  assert.equal(o.recent, 33);
  const count = { id: 'r1', measure: { type: 'count', unit: '장' } };
  const cs = rs.map(r => Object.assign({}, r, { amount: 20 }));
  cs.push(rec({ amount: null }));
  assert.equal(Calc.observeDuration(cs, count).n, 11);
});

test('관찰 문장에는 판단하는 말을 쓰지 않는다', () => {
  const routine = { id: 'r1', measure: { type: 'fixed', amount: 100, unit: '개' } };
  const sentences = [
    Calc.durationSentence({ ready: true, kind: 'fixed', first: 42, recent: 28, dir: 'down', lo: 26, hi: 30 }, routine),
    Calc.durationSentence({ ready: true, kind: 'fixed', first: 28, recent: 42, dir: 'up', lo: 40, hi: 45 }, routine),
    Calc.durationSentence({ ready: false, n: 6, need: 10 }, routine)
  ];
  sentences.forEach(s => assert.doesNotMatch(s, /잘했|훌륭|아쉽|더 줄여|분발|빨라지세요/));
  sentences.forEach(s => assert.doesNotMatch(s, /다음 계획|잡아도 돼요/));
  assert.match(sentences[0], /최근 5번은 28분/);
  assert.match(sentences[2], /6\/10/);
});

// ---------- 입력 검사 ----------
test('입력 검사 메시지', () => {
  assert.equal(Calc.checkName(''), '이름을 적어 주세요');
  assert.equal(Calc.checkName('가'.repeat(51)), '50자 이내로 적어 주세요');
  assert.equal(Calc.checkMinutes('abc'), '분 단위 숫자로 적어 주세요');
  assert.equal(Calc.checkMinutes(''), '분 단위 숫자로 적어 주세요');
  assert.equal(Calc.checkMinutes('0'), '1분 이상으로 적어 주세요');
  assert.equal(Calc.checkMinutes('-5'), '1분 이상으로 적어 주세요');
  assert.equal(Calc.checkMinutes('721'), '12시간을 넘는 일은 나눠서 적어 보세요');
  assert.equal(Calc.checkMinutes('720'), '');
  assert.equal(Calc.checkAmount('0'), '1 이상의 정수로 적어 주세요');
  assert.equal(Calc.checkAmount('34'), '');
  assert.equal(Calc.checkUnit(''), '단위를 적어 주세요 (예: 장, 문제, 쪽)');
  assert.deepEqual(Calc.checkTimeRange('11:00', '10:00'), { field: 'end', msg: '끝 시각은 시작보다 늦어야 해요' });
  assert.equal(Calc.checkTimeRange('10:00', '11:00'), null);
});

// ---------- 저장소 구조 검사 ----------
test('가져오기: 빈 데이터와 정상 데이터는 통과', () => {
  assert.equal(Store.parseImport(JSON.stringify(Store.empty())).ok, true);
  const d = Store.empty();
  d.blocks.push({ id: 'b1', name: '자료구조', kind: '수업', days: [1, 3], start: '10:30', end: '11:45' });
  d.routines.push({ id: 'r1', name: '복습', category: '복습', perWeek: 3, baseMin: 45, minMin: 10,
    anchor: { type: 'block', blockId: 'b1' }, measure: { type: 'count', unit: '장' }, createdAt: iso(2026, 10, 1) });
  d.records.push(rec({ amount: 34 }));
  assert.equal(Store.parseImport(JSON.stringify(d)).ok, true);
});

test('가져오기: JSON이 아니거나 구조가 다르면 거부', () => {
  assert.equal(Store.parseImport('hello').ok, false);
  assert.equal(Store.parseImport('{"version":2}').ok, false);
  const old = { version: 1, active: null, records: [] }; // 예전 기획서 구조
  assert.equal(Store.parseImport(JSON.stringify(old)).ok, false);
  const d = Store.empty();
  d.records.push(rec({ actualMin: 0 }));
  assert.equal(Store.parseImport(JSON.stringify(d)).ok, false);
  const e = Store.empty();
  e.routines.push({ id: 'r1', name: 'a', category: 'b', perWeek: 3, baseMin: 10, minMin: 10, anchor: null, measure: { type: 'none' }, createdAt: iso(2026, 10, 1) });
  assert.equal(Store.parseImport(JSON.stringify(e)).ok, false, '최소가 기본보다 짧지 않음');
});

// ---------- 예시 데이터 ----------
test('예시 데이터는 저장소 구조 검사를 통과하고, 관찰 문장이 나올 만큼 기록이 있다', () => {
  const Sample = require('../js/sample.js');
  const d = Sample.build(new Date(2026, 9, 16, 21));
  assert.equal(Store.validate(d), true);
  const words = d.routines.find(r => r.id === 'r_s2');
  assert.equal(Calc.observeDuration(d.records, words).ready, true);
  assert.equal(Calc.observeDelay(d.records, words).ready, true);
  const review = d.routines.find(r => r.id === 'r_s1');
  assert.equal(Calc.observeDuration(d.records, review).ready, true);
  assert.equal(JSON.stringify(Sample.build(new Date(2026, 9, 16, 21))), JSON.stringify(d), '매번 같은 결과');
});

// ---------- v2: 앱 안의 하루 ----------
test('v2 하루 끝이 자정을 넘기면 그 전까지는 전날로 본다', () => {
  const s = { dayStart: '08:00', dayEnd: '02:00', bufferMin: 10 };
  assert.equal(Calc.dayEndMin(s), 26 * 60);
  assert.equal(Calc.rolloverMin(s), 120);
  const L = Calc.logical(new Date(2026, 9, 17, 1, 30), s); // 토 01:30 → 금요일 25:30
  assert.equal(L.weekday, 5);
  assert.equal(L.nowMin, 25 * 60 + 30);
  const gaps = Calc.computeGaps([], 5, s, L.nowMin);
  assert.equal(gaps[0].state, 'now');
  assert.equal(gaps[0].remaining, 30);
});

test('v2 자정 넘어 한 기록은 전날 달성으로 센다', () => {
  const routine = { id: 'r1', perWeek: 7, createdAt: iso(2026, 10, 1) };
  const rs = [rec({ startedAt: iso(2026, 10, 16, 0, 40) })]; // 금 00:40 = 목요일의 늦은 밤
  const fri = new Date(2026, 9, 16, 20);
  assert.equal(Calc.missedYesterday(rs, routine, fri, 120), false);
  assert.equal(Calc.missedYesterday(rs, routine, fri, 0), true);
  assert.equal(Calc.doneOn(rs, 'r1', new Date(2026, 9, 15), 120), true);
});

test('v2 시각 앵커가 자정 뒤면 하루 끝 쪽으로', () => {
  const r = { anchor: { type: 'time', time: '00:30' } };
  assert.equal(Calc.anchorToday(r, [], 1, 120).plannedMin, 24 * 60 + 30);
  assert.equal(Calc.anchorToday(r, [], 1, 0).plannedMin, 30);
});

test('v2 하루 설정 검사', () => {
  assert.equal(Calc.checkSettings('08:00', '23:00'), null);
  assert.equal(Calc.checkSettings('08:00', '02:00'), null);
  assert.equal(Calc.checkSettings('08:00', '05:00').msg, '자정을 넘긴다면 하루 끝은 새벽 4시 전이어야 해요');
  assert.equal(Calc.checkSettings('08:00', '08:00').field, 'end');
  const d = Store.empty();
  d.settings.dayEnd = '02:00';
  assert.equal(Store.validate(d), true);
  d.settings.dayEnd = '06:00';
  assert.equal(Store.validate(d), false);
});

// ---------- v2: 기록 정직하게 ----------
test('v2 타이머를 늦게 끈 것 같은지', () => {
  assert.equal(Calc.looksTooLong(30, 59), false);
  assert.equal(Calc.looksTooLong(30, 61), true);
  assert.equal(Calc.looksTooLong(10, 25), false, '2배를 넘어도 30분 미만 차이는 그대로');
  assert.equal(Calc.looksTooLong(600, 721), true);
});

// ---------- v2: 규칙 다듬기 제안 ----------
test('v2 2주 연속 못 채우면 횟수를 낮추자고 제안한다', () => {
  const now = new Date(2026, 9, 19, 9); // 월
  const r = { id: 'r1', perWeek: 3, baseMin: 45, minMin: 10, createdAt: iso(2026, 9, 1) };
  const rs = [rec({ startedAt: iso(2026, 10, 6) }), rec({ startedAt: iso(2026, 10, 14) })]; // 지난 2주 각 1회
  const s = Calc.suggestions(rs, [r], now, 0);
  const p = s.find((x) => x.kind === 'perWeek');
  assert.equal(p.to, 1);
  assert.deepEqual(p.counts, [1, 1]);
  assert.match(p.key, /^2026-10-19\|r1\|perWeek$/);
});

test('v2 최근 기본 시간이 계획과 20% 넘게 다르면 기본 시간을 바꾸자고 제안한다', () => {
  const now = new Date(2026, 9, 19, 9);
  const r = { id: 'r1', perWeek: 1, baseMin: 30, minMin: 10, createdAt: iso(2026, 10, 1) };
  const rs = [38, 41, 40, 39, 44].map((m, i) => rec({ startedAt: iso(2026, 10, 10 + i), actualMin: m }));
  const b = Calc.suggestions(rs, [r], now, 0).find((x) => x.kind === 'baseMin');
  assert.equal(b.to, 40);
  const close = [31, 33, 30, 32, 34].map((m, i) => rec({ startedAt: iso(2026, 10, 10 + i), actualMin: m }));
  assert.equal(Calc.suggestions(close, [r], now, 0).find((x) => x.kind === 'baseMin'), undefined);
});

test('v2 4주 내내 채우면 사실만 알리고 횟수를 올리자고 하지 않는다', () => {
  const now = new Date(2026, 9, 19, 9);
  const r = { id: 'r1', perWeek: 1, baseMin: 30, minMin: 10, createdAt: iso(2026, 9, 1) };
  const rs = [iso(2026, 9, 22), iso(2026, 9, 29), iso(2026, 10, 6), iso(2026, 10, 13)].map((t) => rec({ startedAt: t }));
  const kinds = Calc.suggestions(rs, [r], now, 0).map((x) => x.kind);
  assert.deepEqual(kinds, ['steady']);
});

// ---------- 공휴일 ----------
test('공휴일: 그날 이름, 쉬는 종류 빼기, 다가오는 공휴일', () => {
  const list = [{ date: '2026-10-05', name: '대체공휴일' }, { date: '2026-10-09', name: '한글날' }];
  assert.equal(Calc.holidayName(list, new Date(2026, 9, 9)), '한글날');
  assert.equal(Calc.holidayName(list, new Date(2026, 9, 8)), null);
  const blocks = [{ kind: '수업' }, { kind: '통학' }, { kind: '알바' }];
  assert.deepEqual(Calc.blocksForDay(blocks, true, ['수업', '통학']).map((b) => b.kind), ['알바']);
  assert.equal(Calc.blocksForDay(blocks, false, ['수업']).length, 3);
  assert.deepEqual(Calc.holidayOff({}), ['수업', '통학']);
  assert.deepEqual(Calc.holidayOff({ holidayOff: [] }), []);
  assert.deepEqual(Calc.upcomingHolidays(list, new Date(2026, 9, 6), 30).map((h) => h.name), ['한글날']);
  assert.equal(Calc.validHolidays({ holidays: list }), true);
  assert.equal(Calc.validHolidays({ holidays: [{ date: '2026-1-1', name: 'x' }] }), false);
  const d = Store.empty();
  d.settings.holidayOff = ['수업'];
  assert.equal(Store.validate(d), true);
  d.settings.holidayOff = '수업';
  assert.equal(Store.validate(d), false);
});

test('공휴일 API 응답 정리: 0건·1건·여러 건, 같은 날은 이름 합치기', () => {
  const { normalize, merge } = require('../scripts/fetch-holidays.js');
  const wrap = (items) => ({ response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' }, body: { items } } });
  assert.deepEqual(normalize(wrap('')), []);
  assert.deepEqual(normalize(wrap({ item: { dateKind: '01', dateName: '한글날', isHoliday: 'Y', locdate: 20261009, seq: 1 } })),
    [{ date: '2026-10-09', name: '한글날' }]);
  const many = normalize(wrap({ item: [
    { dateName: '어린이날', isHoliday: 'Y', locdate: 20250505 },
    { dateName: '부처님오신날', isHoliday: 'Y', locdate: 20250505 },
    { dateName: '평일 기념일', isHoliday: 'N', locdate: 20250506 }
  ] }));
  assert.deepEqual(merge(many), [{ date: '2025-05-05', name: '어린이날 · 부처님오신날' }]);
  assert.throws(() => normalize({ response: { header: { resultCode: '30', resultMsg: 'SERVICE KEY IS NOT REGISTERED' } } }), /API 오류: 30/);
});

test('공휴일 API XML 응답도 같은 모양으로 읽는다', () => {
  const { normalize, fromXml } = require('../scripts/fetch-holidays.js');
  const xml = '<?xml version="1.0" encoding="UTF-8"?><response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>' +
    '<body><items><item><dateKind>01</dateKind><dateName>개천절</dateName><isHoliday>Y</isHoliday><locdate>20261003</locdate><seq>1</seq></item>' +
    '<item><dateKind>01</dateKind><dateName>한글날</dateName><isHoliday>Y</isHoliday><locdate>20261009</locdate><seq>1</seq></item></items>' +
    '<numOfRows>50</numOfRows><pageNo>1</pageNo><totalCount>2</totalCount></body></response>';
  assert.deepEqual(normalize(fromXml(xml)), [{ date: '2026-10-03', name: '개천절' }, { date: '2026-10-09', name: '한글날' }]);
  const empty = '<response><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header><body><items/><totalCount>0</totalCount></body></response>';
  assert.deepEqual(normalize(fromXml(empty)), []);
  const keyErr = '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';
  assert.throws(() => normalize(fromXml(keyErr)), /API 오류: 30 SERVICE_KEY_IS_NOT_REGISTERED_ERROR/);
});

test('공휴일 API 인증키 오류(JSON)를 이유와 함께 알린다', () => {
  const { normalize } = require('../scripts/fetch-holidays.js');
  const err = { OpenAPI_ServiceResponse: { cmmMsgHeader: { errMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR', returnAuthMsg: '등록되지 않은 서비스키', returnReasonCode: '30' } } };
  assert.throws(() => normalize(err), /API 오류: 30 SERVICE_KEY_IS_NOT_REGISTERED_ERROR \(등록되지 않은 서비스키\)/);
});

// ---------- 상황 루틴 ----------
test('상황 루틴: 루틴 종류 구분', () => {
  assert.equal(Calc.routineKind({ anchor: null }), 'anytime');
  assert.equal(Calc.routineKind({ anchor: { type: 'time', time: '22:00' } }), 'time');
  ['block', 'routine', 'dayoff', 'situation'].forEach((t) => assert.equal(Calc.routineKind({ anchor: { type: t } }), 'situation'));
  assert.equal(Calc.isSituation({ anchor: { type: 'time' } }), false);
});

test('상황 루틴: 다른 루틴을 끝낸 날이 상황, 그중 실천한 날을 센다', () => {
  const now = new Date(2026, 9, 16, 21); // 금
  const r = { id: 'r2', anchor: { type: 'routine', routineId: 'r1' }, createdAt: iso(2026, 10, 1) };
  const records = [
    rec({ routineId: 'r1', startedAt: iso(2026, 10, 12, 22) }), rec({ routineId: 'r1', startedAt: iso(2026, 10, 13, 22) }),
    rec({ routineId: 'r1', startedAt: iso(2026, 10, 14, 22) }),
    rec({ routineId: 'r2', startedAt: iso(2026, 10, 12, 22, 40) }), rec({ routineId: 'r2', startedAt: iso(2026, 10, 14, 22, 50) })
  ];
  const env = { blocks: [], records, events: [], holidays: [], shift: 0, now };
  assert.deepEqual(Calc.situationWeek(r, env), { occ: 3, hit: 2 });
  const today = Calc.situationToday(r, env, new Date(2026, 9, 16));
  assert.equal(today.today, false);
  const env2 = Object.assign({}, env, { records: records.concat(rec({ routineId: 'r1', startedAt: iso(2026, 10, 16, 20), endedAt: iso(2026, 10, 16, 20, 30) })) });
  const t2 = Calc.situationToday(r, env2, new Date(2026, 9, 16));
  assert.equal(t2.today, true);
  assert.equal(t2.plannedMin, 20 * 60 + 30, '끝낸 시각이 시작 신호');
});

test('상황 루틴: 내가 알려 준 상황과 어제 놓침', () => {
  const now = new Date(2026, 9, 16, 21);
  const r = { id: 'r3', anchor: { type: 'situation', label: '집 도착' }, createdAt: iso(2026, 10, 1) };
  const events = [{ id: 'e1', label: '집 도착', at: iso(2026, 10, 15, 18, 40) }, { id: 'e2', label: '집 도착', at: iso(2026, 10, 16, 18, 50) }];
  const env = { blocks: [], records: [], events, holidays: [], shift: 0, now };
  assert.equal(Calc.situationMissedYesterday(r, env), true);
  const t = Calc.situationToday(r, env, new Date(2026, 9, 16));
  assert.equal(t.plannedMin, 18 * 60 + 50);
  const env2 = Object.assign({}, env, { records: [rec({ routineId: 'r3', startedAt: iso(2026, 10, 15, 19) })] });
  assert.equal(Calc.situationMissedYesterday(r, env2), false);
});

test('상황 루틴: 쉬는 날은 공휴일이거나 고정 일정이 없는 날', () => {
  const now = new Date(2026, 9, 18, 21); // 일
  const r = { id: 'r4', anchor: { type: 'dayoff' }, createdAt: iso(2026, 10, 1) };
  const blocks = [{ id: 'b1', name: '수업', kind: '수업', days: [1, 2, 3, 4, 5], start: '10:00', end: '12:00' },
    { id: 'b2', name: '알바', kind: '알바', days: [6], start: '14:00', end: '19:00' }];
  const env = { blocks, records: [], events: [], holidays: [{ date: '2026-10-14', name: '테스트 공휴일' }], off: ['수업', '통학'], shift: 0, now };
  // 이번 주: 수(공휴일, 수업 쉼) + 일(일정 없음) = 2일. 토요일은 알바가 있어 쉬는 날이 아님
  assert.deepEqual(Calc.situationWeek(r, env), { occ: 2, hit: 0 });
});

test('상황 루틴: 저장소 검사 (perWeek 없음, 상황 버튼 기록)', () => {
  const d = Store.empty();
  d.routines.push({ id: 'r1', name: '정리', category: '생활', perWeek: null, baseMin: 10, minMin: 5,
    anchor: { type: 'situation', label: '집 도착' }, measure: { type: 'none' }, createdAt: iso(2026, 10, 1) });
  d.events.push({ id: 'e1', label: '집 도착', at: iso(2026, 10, 15, 18) });
  assert.equal(Store.validate(d), true);
  d.routines[0].anchor = { type: 'time', time: '22:00' };
  assert.equal(Store.validate(d), false, '시각 루틴은 perWeek가 있어야 함');
  assert.equal(Calc.checkSituationLabel(''), '상황 이름을 적어 주세요 (예: 집 도착)');
});

test('규칙 제안: 상황 루틴이 섞여 있어도 오류 없이 기본 시간 제안만', () => {
  const now = new Date(2026, 9, 19, 9);
  const r = { id: 'r1', perWeek: null, baseMin: 10, minMin: 5, anchor: { type: 'situation', label: '집 도착' }, createdAt: iso(2026, 9, 1) };
  const rs = [20, 21, 19, 22, 20].map((m, i) => rec({ startedAt: iso(2026, 10, 10 + i), actualMin: m }));
  const kinds = Calc.suggestions(rs, [r], now, 0).map((x) => x.kind);
  assert.deepEqual(kinds, ['baseMin']);
});

// ---------- 얼마나 자주와 연속 기록 (한 번은 봐주기) ----------
test('연속: 요일을 정한 루틴, 한 번은 봐주고 두 번 연속 놓치면 끊김', () => {
  const r = { id: 'r1', days: [0, 1, 2, 3, 4, 5, 6], anchor: null, createdAt: iso(2026, 10, 1, 8) };
  const day = (d) => rec({ startedAt: iso(2026, 10, d, 22) });
  // 1~5 지킴, 6 놓침(봐줌), 7~9 지킴, 10·11 놓침(끊김), 12~15 지킴, 16(오늘) 아직
  const records = [1, 2, 3, 4, 5, 7, 8, 9, 12, 13, 14, 15].map(day);
  const s = Calc.streak(r, { blocks: [], records, events: [], holidays: [], shift: 0, now: new Date(2026, 9, 16, 12) });
  assert.equal(s.unit, '일');
  assert.equal(s.current, 4);
  assert.equal(s.best, 8, '1~9일 중 6일 하나 봐주고 8번');
  assert.equal(s.perfectBest, 5);
  assert.deepEqual(s.forgiven, ['2026-10-06', '2026-10-10']);
  assert.deepEqual(s.forgivenInRun, []);
  assert.equal(s.pending, true);
  assert.equal(s.atRisk, false);
});

test('연속: 직전에 놓쳤으면 오늘이 고비(atRisk)', () => {
  const r = { id: 'r1', days: [1, 3, 5], anchor: null, createdAt: iso(2026, 10, 1, 8) };
  const records = [rec({ startedAt: iso(2026, 10, 12, 9) })]; // 월 지킴, 수(14) 놓침, 금(16) 오늘
  const s = Calc.streak(r, { blocks: [], records, events: [], holidays: [], shift: 0, now: new Date(2026, 9, 16, 9) });
  assert.equal(s.atRisk, true);
  assert.equal(s.current, 1);
});

test('연속: 주 몇 번만 정한 루틴은 주 단위', () => {
  const r = { id: 'r1', perWeek: 2, anchor: null, createdAt: iso(2026, 9, 21, 8) }; // 9/21 월
  const records = [iso(2026, 9, 22), iso(2026, 9, 24), iso(2026, 9, 29), iso(2026, 10, 1), iso(2026, 10, 6),
    iso(2026, 10, 13), iso(2026, 10, 15)].map((t) => rec({ startedAt: t }));
  const s = Calc.streak(r, { blocks: [], records, events: [], holidays: [], shift: 0, now: new Date(2026, 9, 16, 9) });
  assert.equal(s.unit, '주');
  assert.equal(s.current, 3, '9/21·9/28 채움, 10/5 주 1회(봐줘서 이어짐, 연속에 더하지는 않음), 10/12 채움 → 3주');
  assert.equal(s.perfect, 1);
  assert.equal(Calc.scheduleOf(r), 'weekly');
});

test('연속: 상황 루틴은 상황이 생길 때마다', () => {
  const r = { id: 'r3', anchor: { type: 'situation', label: '집 도착' }, createdAt: iso(2026, 10, 1) };
  const events = [12, 13, 14, 15].map((d, i) => ({ id: 'e' + i, label: '집 도착', at: iso(2026, 10, d, 18, 40) }));
  const records = [12, 14, 15].map((d) => rec({ routineId: 'r3', startedAt: iso(2026, 10, d, 18, 50) }));
  const s = Calc.streak(r, { blocks: [], records, events, holidays: [], shift: 0, now: new Date(2026, 9, 16, 9) });
  assert.equal(s.unit, '번');
  assert.equal(s.current, 3);
  assert.equal(s.perfect, 2);
});

test('저장소 검사: 요일을 정한 루틴', () => {
  const d = Store.empty();
  d.routines.push({ id: 'r1', name: '단어', category: '공부', perWeek: null, days: [1, 3, 5], baseMin: 30, minMin: 10,
    anchor: { type: 'time', time: '22:00' }, measure: { type: 'none' }, createdAt: iso(2026, 10, 1) });
  assert.equal(Store.validate(d), true);
  d.routines[0].days = [];
  assert.equal(Store.validate(d), false);
});

test('규칙 제안: 요일 루틴은 자주 놓친 요일을 빼자고', () => {
  const now = new Date(2026, 9, 19, 9); // 월
  const r = { id: 'r1', days: [1, 3, 5], baseMin: 30, minMin: 10, anchor: null, createdAt: iso(2026, 9, 1) };
  // 지난 4주(9/21~10/18) 월·금은 다 하고 수요일은 한 번만
  const days = [];
  [21, 28].forEach((d) => days.push(iso(2026, 9, d), iso(2026, 9, d + 4)));
  days.push(iso(2026, 9, 23));
  [5, 12].forEach((d) => days.push(iso(2026, 10, d), iso(2026, 10, d + 4)));
  const rs = days.map((t) => rec({ startedAt: t }));
  const s = Calc.suggestions(rs, [r], now, 0).find((x) => x.kind === 'dropDay');
  assert.equal(s.day, 3);
  assert.deepEqual([s.done, s.total], [1, 4]);
  assert.deepEqual(s.to, [1, 5]);
});

test('규칙 제안: 상황 루틴 실천이 절반 미만이면', () => {
  const now = new Date(2026, 9, 19, 9);
  const r = { id: 'r3', anchor: { type: 'situation', label: '집 도착' }, baseMin: 20, minMin: 10, createdAt: iso(2026, 9, 1) };
  const events = [22, 23, 24, 29, 30].map((d, i) => ({ id: 'e' + i, label: '집 도착', at: iso(2026, 9, d, 19) }));
  const rs = [rec({ routineId: 'r3', startedAt: iso(2026, 9, 22, 19, 10) })];
  const env = { blocks: [], events, holidays: [] };
  const s = Calc.suggestions(rs, [r], now, 0, env).find((x) => x.kind === 'situationLow');
  assert.deepEqual([s.occ, s.hit, s.from, s.to], [5, 1, 10, 5]);
  assert.equal(Calc.suggestions(rs, [r], now, 0).some((x) => x.kind === 'situationLow'), false, 'env 없으면 보지 않음');
});

// ---------- 최소 시간: 기준선 ----------
test('최소 시간: 기록할 때의 최소 시간보다 짧으면 한 번으로 세지 않는다', () => {
  assert.equal(Calc.countsAsDone(rec({ actualMin: 6, minMin: 10 })), false);
  assert.equal(Calc.countsAsDone(rec({ actualMin: 10, minMin: 10 })), true);
  // 예전 기록과 늘 같은 분량 루틴(minMin 없음)은 센다
  assert.equal(Calc.countsAsDone(rec({ actualMin: 3 })), true);
  assert.equal(Calc.countsAsDone(rec({ actualMin: 3, version: 'min' })), true);
});

test('최소 시간: 짧은 기록은 이번 주 횟수와 오늘 한 일에서 빠진다', () => {
  const now = new Date(2026, 9, 14, 20, 0);
  const records = [rec({ actualMin: 4, minMin: 10 })];
  assert.equal(Calc.weekDone(records, 'r1', now, 0), 0);
  assert.equal(Calc.doneOn(records, 'r1', new Date(2026, 9, 14), 0), false);
  records.push(rec({ actualMin: 12, minMin: 10, startedAt: iso(2026, 10, 14, 15) }));
  assert.equal(Calc.weekDone(records, 'r1', now, 0), 1);
});

test('저장 검사: 루틴 색과 기록의 최소 시간', () => {
  const d = Store.empty();
  d.routines.push({ id: 'r1', name: 'a', category: '공부', perWeek: 3, baseMin: 30, minMin: 10, anchor: null,
    measure: { type: 'none' }, createdAt: iso(2026, 10, 1), color: 'blue' });
  d.records.push(rec({ minMin: 10 }));
  assert.equal(Store.validate(d), true);
  d.routines[0].color = 'neon';
  assert.equal(Store.validate(d), false);
  d.routines[0].color = 'blue';
  d.records[0].minMin = -1;
  assert.equal(Store.validate(d), false);
});

// ---------- 시간을 바꾼 뒤 다시 보정 ----------
test('보정: 루틴 시간을 바꾸면 그 뒤 기록만 보고, 3개가 안 되면 보정하지 않는다', () => {
  const old = [1, 2, 3, 4].map((d) => rec({ estimateMin: 30, actualMin: 45, startedAt: iso(2026, 10, d) }));
  // 바꾸기 전: 배율 1.5
  assert.equal(Calc.calibration(old, { routineId: 'r1', category: '공부' }).ratio, 1.5);
  const since = iso(2026, 10, 5, 0);
  // 바꾼 뒤 기록이 없으면 (카테고리 기록이 있어도) 보정 없음 → 새 기본 시간 그대로
  assert.equal(Calc.calibration(old, { routineId: 'r1', category: '공부', since }), null);
  const after = old.concat([6, 7, 8].map((d) => rec({ estimateMin: 45, actualMin: 45, startedAt: iso(2026, 10, d) })));
  assert.equal(Calc.calibration(after, { routineId: 'r1', category: '공부', since }).ratio, 1);
  assert.equal(Calc.lastChange({ history: [{ at: since }] }), since);
  assert.equal(Calc.lastChange({}), null);
});

test('제안: 기본 시간을 바꾼 뒤에는 그 뒤 기록만 본다', () => {
  const now = new Date(2026, 9, 26, 9);
  const r = { id: 'r1', name: 'x', category: '공부', perWeek: 7, baseMin: 30, minMin: 10, anchor: null, measure: { type: 'fixed', amount: 1, unit: '개' }, createdAt: iso(2026, 9, 1) };
  const records = [1, 2, 3, 4, 5, 6].map((d) => rec({ actualMin: 45, startedAt: iso(2026, 10, d) }));
  assert.ok(Calc.suggestions(records, [r], now, 0).some((s) => s.kind === 'baseMin'));
  r.baseMin = 45;
  r.history = [{ at: iso(2026, 10, 7), baseMin: 45, minMin: 10, fromBase: 30, fromMin: 10, by: 'ruti' }];
  assert.ok(!Calc.suggestions(records, [r], now, 0).some((s) => s.kind === 'baseMin'));
});

test('저장 검사: 시간 변경 이력과 앱 예상', () => {
  const d = Store.empty();
  d.routines.push({ id: 'r1', name: 'a', category: '공부', perWeek: 3, baseMin: 45, minMin: 10, anchor: null,
    measure: { type: 'none' }, createdAt: iso(2026, 10, 1), history: [{ at: iso(2026, 10, 5), baseMin: 45, minMin: 10, fromBase: 30, fromMin: 10, by: 'edit' }] });
  d.records.push(rec({ appMin: 40 }));
  assert.equal(Store.validate(d), true);
  d.routines[0].history[0].by = 'robot';
  assert.equal(Store.validate(d), false);
});

// ---------- 예상과 실제: 로그 중앙값, 그만둔 일, 보정 효과 ----------
test('배율: 로그 중앙값과 가운데 절반 범위', () => {
  // 2배 늦음과 0.5배 빠름은 같은 크기 → 중앙값 1배
  const r = Calc.ratioOf([rec({ estimateMin: 30, actualMin: 60 }), rec({ estimateMin: 30, actualMin: 30 }), rec({ estimateMin: 30, actualMin: 15 })]);
  assert.equal(r.ratio, 1);
  assert.ok(r.lo < 1 && r.hi > 1);
  // 긴 일 하나가 전체를 좌우하지 않는다 (합 ÷ 합이면 3.8배)
  const s = Calc.ratioOf([rec({ estimateMin: 10, actualMin: 12 }), rec({ estimateMin: 10, actualMin: 12 }), rec({ estimateMin: 60, actualMin: 300 })]);
  assert.equal(s.ratio, 1.2);
});

test('그만둔 일: 횟수·보정·배율에서 빠진다', () => {
  const stopped = rec({ outcome: 'stopped', actualMin: 90 });
  assert.equal(Calc.countsAsDone(stopped), false);
  const rs = [rec({ actualMin: 30 }), rec({ actualMin: 30 }), rec({ actualMin: 30 }), stopped];
  assert.equal(Calc.calibration(rs, { routineId: 'r1', category: '공부' }).n, 3);
  assert.equal(Calc.categoryStats(rs)[0].n, 3);
});

test('보정 효과 확인: 늘 1.5배 걸리는 사람은 앱 예상이 더 가깝다', () => {
  const rs = [1, 2, 3, 4, 5, 6, 7, 8].map((d) => rec({ kind: 'task', routineId: null, category: '과제', estimateMin: 40, actualMin: 60, startedAt: iso(2026, 10, d) }));
  const bt = Calc.backtest(rs, []);
  assert.equal(bt.n, 5); // 앞의 3개는 보정할 기록이 없음
  assert.ok(Math.abs(bt.mine - 1 / 3) < 1e-9);
  assert.equal(bt.app, 0);
  assert.equal(Calc.backtest(rs.slice(0, 4), []), null);
});

test('저장 검사: 그만둔 일', () => {
  const d = Store.empty();
  d.records.push(rec({ outcome: 'stopped' }));
  assert.equal(Store.validate(d), true);
  d.records[0].outcome = 'paused';
  assert.equal(Store.validate(d), false);
});
