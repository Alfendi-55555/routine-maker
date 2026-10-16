/* 예시 데이터: 대학생 한 명의 5주치 고정 일정·루틴·기록.
 * 화면이 비어 있을 때 "예시 데이터로 둘러보기"로만 넣는다. 매번 같은 결과가 나오도록 고정 씨앗을 쓴다.
 */
(function (root) {
  'use strict';
  var C = root.Calc || (typeof require === 'function' ? require('./calc.js') : null);

  function build(nowInput) {
    var now = nowInput ? new Date(nowInput) : new Date();
    var seed = 20261016;
    function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
    function at(day, hm, addMin) { return C.atMinutes(day, C.toMin(hm) + (addMin || 0)); }
    function span(start, min) { return { startedAt: start.toISOString(), endedAt: new Date(start.getTime() + min * 60000).toISOString() }; }

    var start = C.addDays(C.startOfWeek(now), -35); // 5주 전 월요일
    var created = at(start, '09:00').toISOString();
    var today = C.startOfDay(now);
    var totalDays = Math.round((today.getTime() - start.getTime()) / 864e5);

    var blocks = [
      { id: 'b_s1', name: '자료구조', kind: '수업', days: [1, 3], start: '10:30', end: '11:45' },
      { id: 'b_s2', name: '운영체제', kind: '수업', days: [2, 4], start: '13:00', end: '14:15' },
      { id: 'b_s3', name: '등교', kind: '통학', days: [1, 2, 3, 4, 5], start: '09:00', end: '10:00' },
      { id: 'b_s4', name: '하교', kind: '통학', days: [1, 2, 3, 4], start: '17:30', end: '18:30' },
      { id: 'b_s5', name: '카페 알바', kind: '알바', days: [5, 6], start: '14:00', end: '19:00' }
    ];
    var routines = [
      { id: 'r_s1', name: '자료구조 복습', category: '복습', perWeek: null, baseMin: 45, minMin: 15,
        anchor: { type: 'block', blockId: 'b_s1' }, measure: { type: 'count', unit: '장' }, createdAt: created },
      { id: 'r_s2', name: '영어 단어 100개', category: '공부', perWeek: 7, baseMin: 30, minMin: 10,
        anchor: { type: 'time', time: '22:00' }, measure: { type: 'fixed', amount: 100, unit: '개' }, createdAt: created },
      { id: 'r_s3', name: '팀플 회의록 정리', category: '팀플', perWeek: 1, baseMin: 40, minMin: 15,
        anchor: null, measure: { type: 'none' }, createdAt: created },
      // 상황 루틴: 다른 루틴을 끝내면 / 쉬는 날이면 / 내가 알려 주는 상황
      { id: 'r_s4', name: '하루 3줄 일기', category: '기록', perWeek: null, baseMin: 10, minMin: 3,
        anchor: { type: 'routine', routineId: 'r_s2' }, measure: { type: 'fixed', amount: 3, unit: '줄' }, createdAt: created },
      { id: 'r_s5', name: '방 정리', category: '생활', perWeek: null, baseMin: 20, minMin: 10,
        anchor: { type: 'dayoff' }, measure: { type: 'none' }, createdAt: created },
      { id: 'r_s6', name: '정리 10분', category: '생활', perWeek: null, baseMin: 10, minMin: 5,
        anchor: { type: 'situation', label: '집 도착' }, measure: { type: 'none' }, createdAt: created }
    ];
    var events = [], en = 0;

    var records = [], n = 0;
    function push(o) { n += 1; o.id = 't_s' + n; records.push(o); }

    for (var i = 0; i < totalDays; i++) {
      var day = C.addDays(start, i), wd = day.getDay(), p = i / totalDays;

      // 영어 단어: 매일 밤 10시. 시간이 지날수록 시작 지연과 수행 시간이 조금씩 줄어든다
      if (rnd() < 0.82) {
        var minVer = rnd() < 0.12;
        var act = minVer ? Math.round(9 + rnd() * 4) : Math.round(42 - 14 * p + (rnd() - 0.5) * 8);
        var s = at(day, '22:00', Math.round(35 - 25 * p + rnd() * 10));
        push(Object.assign({ kind: 'routine', routineId: 'r_s2', name: '영어 단어 100개', category: '공부',
          version: minVer ? 'min' : 'base', estimateMin: minVer ? 10 : 30, actualMin: act, amount: minVer ? null : 100,
          plannedStartAt: at(day, '22:00').toISOString(), source: 'timer' }, span(s, act)));
      }
      // 하루 3줄 일기: 영어 단어를 끝낸 날, 끝내고 조금 뒤에
      var wordsToday = records.filter(function (x) { return x.routineId === 'r_s2' && C.dayKey(x.startedAt) === C.dayKey(day); })[0];
      if (wordsToday && rnd() < 0.75) {
        var act4 = Math.round(7 + rnd() * 6);
        push(Object.assign({ kind: 'routine', routineId: 'r_s4', name: '하루 3줄 일기', category: '기록',
          version: 'base', estimateMin: 10, actualMin: act4, amount: 3, plannedStartAt: wordsToday.endedAt, source: 'timer' },
          span(new Date(Date.parse(wordsToday.endedAt) + Math.round(3 + rnd() * 12) * 60000), act4)));
      }
      // 방 정리: 쉬는 날(이 예시에서는 일요일)
      if (wd === 0 && rnd() < 0.7) {
        var est5 = 20, act5 = Math.round(est5 * (1.2 + rnd() * 0.5));
        push(Object.assign({ kind: 'routine', routineId: 'r_s5', name: '방 정리', category: '생활',
          version: 'base', estimateMin: est5, actualMin: act5, amount: null, plannedStartAt: null, source: 'timer' },
          span(at(day, '15:00', Math.round(rnd() * 60)), act5)));
      }
      // 집 도착: 월~목 하교 뒤 상황 버튼을 누르고, 대부분 바로 정리
      if (wd >= 1 && wd <= 4 && rnd() < 0.85) {
        var arrive = at(day, '18:40', Math.round(rnd() * 25));
        en += 1;
        events.push({ id: 'e_s' + en, label: '집 도착', at: arrive.toISOString() });
        if (rnd() < 0.8) {
          var act6 = Math.round(8 + rnd() * 7);
          push(Object.assign({ kind: 'routine', routineId: 'r_s6', name: '정리 10분', category: '생활',
            version: 'base', estimateMin: 10, actualMin: act6, amount: null, plannedStartAt: arrive.toISOString(), source: 'timer' },
            span(new Date(arrive.getTime() + Math.round(2 + rnd() * 14) * 60000), act6)));
        }
      }
      // 자료구조 복습: 월·수 수업 끝나고. 슬라이드 장수가 매번 다르다
      if ((wd === 1 || wd === 3) && rnd() < 0.85) {
        var slides = 20 + Math.floor(rnd() * 18);
        var act2 = Math.round(slides * (1.8 - 0.5 * p + (rnd() - 0.5) * 0.3));
        var s2 = at(day, '11:45', Math.round(45 - 30 * p + rnd() * 10));
        var manual = rnd() < 0.15;
        push(Object.assign({ kind: 'routine', routineId: 'r_s1', name: '자료구조 복습', category: '복습',
          version: 'base', estimateMin: 45, actualMin: act2, amount: slides,
          plannedStartAt: manual ? null : at(day, '11:45').toISOString(), source: manual ? 'manual' : 'timer' }, span(s2, act2)));
      }
      // 팀플 회의록: 목요일 저녁. 셀 수 없는 일이라 그날 예상을 적는다
      if (wd === 4 && rnd() < 0.8) {
        var est = 30 + Math.round(rnd() * 4) * 5;
        var act3 = Math.round(est * (1.7 - 0.4 * p + (rnd() - 0.5) * 0.2));
        push(Object.assign({ kind: 'routine', routineId: 'r_s3', name: '팀플 회의록 정리', category: '팀플',
          version: 'base', estimateMin: est, actualMin: act3, amount: null, plannedStartAt: null, source: 'timer' },
          span(at(day, '20:00', Math.round(rnd() * 30)), act3)));
      }
    }

    [['자료구조 과제 2번', '과제', 90, 140, 30], ['운영체제 리포트', '과제', 45, 72, 24],
     ['웹프로그래밍 실습 과제', '과제', 60, 95, 17], ['중간고사 1단원 정리', '시험 준비', 120, 150, 12],
     ['통계학 퀴즈 준비', '시험 준비', 40, 55, 5], ['발표 자료 만들기', '팀플', 60, 85, 3]
    ].forEach(function (t) {
      if (t[4] > totalDays) return;
      push(Object.assign({ kind: 'task', routineId: null, name: t[0], category: t[1], version: null,
        estimateMin: t[2], actualMin: t[3], amount: null, plannedStartAt: null, source: 'timer' },
        span(at(C.addDays(today, -t[4]), '15:00'), t[3])));
    });

    return {
      version: 1,
      settings: { dayStart: '08:00', dayEnd: '01:00', bufferMin: 10 },
      blocks: blocks, routines: routines, active: null, records: records, events: events, dismissed: []
    };
  }

  var Sample = { build: build };
  if (typeof module === 'object' && module.exports) module.exports = Sample;
  else root.Sample = Sample;
})(this);
