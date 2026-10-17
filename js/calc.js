/* 루틴메이커 계산 모듈
 * 화면과 저장소를 모르는 순수 함수만 둔다. 브라우저에서는 window.Calc,
 * Node 테스트에서는 require('./calc.js')로 쓴다.
 * 시각은 모두 사용자 기기의 현지 시간 기준이다.
 */
(function (root) {
  'use strict';

  var MIN_GAP = 15;          // 이보다 짧은 빈 시간은 버린다 (분)
  var CALIBRATE_FROM = 3;    // 보정 제안을 시작하는 기록 수
  var OBSERVE_FROM = 10;     // 변화 비교를 시작하는 기록 수
  var SAME_BAND = 0.1;       // 이보다 작은 변화는 "비슷해요"
  var MAX_DELAY = 180;       // 시작 지연으로 인정하는 최대값 (분)
  var DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

  // ---------- 시간 도구 ----------
  function pad(n) { return String(n).padStart(2, '0'); }

  function toMin(hm) {
    if (typeof hm !== 'string' || !/^\d{2}:\d{2}$/.test(hm)) return NaN;
    var h = Number(hm.slice(0, 2)), m = Number(hm.slice(3));
    if (h > 23 || m > 59) return NaN;
    return h * 60 + m;
  }
  /* 자정을 넘긴 분(예: 1500)도 시계 시각(01:00)으로 */
  function fmtHM(min) { return pad(Math.floor(min / 60) % 24) + ':' + pad(min % 60); }
  function fmtDuration(min) {
    min = Math.round(min);
    if (min < 60) return min + '분';
    var h = Math.floor(min / 60), m = min % 60;
    return m ? h + '시간 ' + m + '분' : h + '시간';
  }
  function round1(n) { return Math.round(n * 10) / 10; }
  function round5(n) { return Math.max(5, Math.round(n / 5) * 5); }
  function median(list) {
    if (!list.length) return NaN;
    var s = list.slice().sort(function (a, b) { return a - b; });
    var k = Math.floor(s.length / 2);
    return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
  }
  function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function mondayIndex(d) { return (new Date(d).getDay() + 6) % 7; }
  function startOfWeek(d) { return addDays(startOfDay(d), -mondayIndex(d)); }
  function dayKey(d) { var x = new Date(d); return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()); }
  function minutesOfDay(d) { var x = new Date(d); return x.getHours() * 60 + x.getMinutes(); }
  function atMinutes(day, min) { var x = startOfDay(day); x.setMinutes(min); return x; }
  function diffMin(a, b) { return (new Date(b).getTime() - new Date(a).getTime()) / 60000; }
  function byStart(a, b) { return Date.parse(a.startedAt) - Date.parse(b.startedAt); }

  // ---------- 앱 안의 하루 (자정을 넘기는 하루 끝) ----------
  var MAX_ROLLOVER = 4 * 60; // 하루 끝은 새벽 4시까지

  /* 하루 끝(분). 하루 끝이 시작보다 이르면 다음 날로 보고 1440을 더한다. */
  function dayEndMin(settings) {
    var s = toMin(settings.dayStart), e = toMin(settings.dayEnd);
    return e <= s ? e + 1440 : e;
  }
  /* 자정 뒤 몇 분까지 전날로 치는지 */
  function rolloverMin(settings) { return Math.max(0, dayEndMin(settings) - 1440); }

  /* 지금이 앱 안에서 어느 날 몇 분인지. 새벽 1시에 하루 끝이 2시면 전날 25:00(=1500분)으로 본다. */
  function logical(now, settings) {
    var shift = rolloverMin(settings);
    var shifted = new Date(new Date(now).getTime() - shift * 60000);
    var day = startOfDay(shifted);
    return {
      shift: shift,
      day: day,
      weekday: day.getDay(),
      nowMin: Math.round((new Date(now).getTime() - day.getTime()) / 60000)
    };
  }
  /* 기록 시각을 앱 안의 날짜로 */
  function logicalKey(iso, shift) { return dayKey(new Date(Date.parse(iso) - (shift || 0) * 60000)); }

  /* 하루 설정 검사: null 또는 { field, msg } */
  function checkSettings(dayStart, dayEnd) {
    if (isNaN(toMin(dayStart))) return { field: 'start', msg: '하루 시작 시각을 골라 주세요' };
    if (isNaN(toMin(dayEnd))) return { field: 'end', msg: '하루 끝 시각을 골라 주세요' };
    var s = toMin(dayStart), e = toMin(dayEnd);
    if (e === s) return { field: 'end', msg: '하루 끝은 시작과 달라야 해요' };
    if (e < s && e > MAX_ROLLOVER) return { field: 'end', msg: '자정을 넘긴다면 하루 끝은 새벽 4시 전이어야 해요' };
    if (e < s && s < MAX_ROLLOVER) return { field: 'start', msg: '하루 시작은 새벽 4시 이후로 골라 주세요' };
    return null;
  }

  // ---------- 공휴일 ----------
  var DEFAULT_HOLIDAY_OFF = ['수업', '통학'];

  /* 공휴일에 쉬는 고정 일정 종류 (설정이 없으면 수업·통학) */
  function holidayOff(settings) { return Array.isArray(settings.holidayOff) ? settings.holidayOff : DEFAULT_HOLIDAY_OFF; }

  /* holidays: [{ date: 'YYYY-MM-DD', name }] · day: 앱 안의 날짜 → 공휴일 이름 또는 null */
  function holidayName(holidays, day) {
    var key = dayKey(day);
    for (var i = 0; i < holidays.length; i++) if (holidays[i].date === key) return holidays[i].name;
    return null;
  }

  /* 그날 실제로 있는 고정 일정: 공휴일이면 쉬는 종류를 뺀다 */
  function blocksForDay(blocks, isHoliday, offKinds) {
    if (!isHoliday) return blocks;
    return blocks.filter(function (b) { return offKinds.indexOf(b.kind) === -1; });
  }

  /* from(포함)부터 days일 안의 공휴일 */
  function upcomingHolidays(holidays, from, days) {
    var a = dayKey(from), b = dayKey(addDays(from, days));
    return holidays.filter(function (h) { return h.date >= a && h.date < b; });
  }

  /* 공휴일 파일 모양 검사 */
  function validHolidays(d) {
    return !!d && Array.isArray(d.holidays) && d.holidays.every(function (h) {
      return h && typeof h.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h.date) && typeof h.name === 'string';
    });
  }

  // ---------- 고정 일정과 빈 시간 ----------
  function dayBlocks(blocks, weekday) {
    return blocks.filter(function (b) { return b.days.indexOf(weekday) !== -1; })
      .sort(function (a, b) { return toMin(a.start) - toMin(b.start); });
  }

  /* 하루 활동 시간에서 고정 일정(앞뒤 전환 시간 포함)을 빼고 남는 빈 시간.
   * nowMin을 주면 각 빈 시간에 state(past/now/future)와 remaining(남은 분)을 붙인다. */
  function computeGaps(blocks, weekday, settings, nowMin) {
    var ds = toMin(settings.dayStart), de = dayEndMin(settings), buf = settings.bufferMin;
    var busy = dayBlocks(blocks, weekday).map(function (b) {
      return [Math.max(ds, toMin(b.start) - buf), Math.min(de, toMin(b.end) + buf)];
    }).filter(function (p) { return p[1] > p[0]; });
    busy.sort(function (a, b) { return a[0] - b[0]; });

    var gaps = [], cursor = ds;
    busy.forEach(function (p) {
      if (p[0] > cursor) gaps.push([cursor, p[0]]);
      cursor = Math.max(cursor, p[1]);
    });
    if (de > cursor) gaps.push([cursor, de]);

    return gaps.filter(function (g) { return g[1] - g[0] >= MIN_GAP; }).map(function (g) {
      var gap = { start: g[0], end: g[1], len: g[1] - g[0], state: 'future', remaining: g[1] - g[0] };
      if (nowMin != null) {
        if (g[1] <= nowMin) { gap.state = 'past'; gap.remaining = 0; }
        else if (g[0] <= nowMin) { gap.state = 'now'; gap.remaining = g[1] - nowMin; }
      }
      return gap;
    });
  }

  /* 같은 요일에 시간이 겹치는 다른 고정 일정 목록: [{block, day}] */
  function findOverlaps(blocks, candidate, excludeId) {
    var out = [], s = toMin(candidate.start), e = toMin(candidate.end);
    blocks.forEach(function (b) {
      if (b.id === excludeId) return;
      if (!(toMin(b.start) < e && s < toMin(b.end))) return;
      candidate.days.forEach(function (d) { if (b.days.indexOf(d) !== -1) out.push({ block: b, day: d }); });
    });
    return out;
  }

  // ---------- 배율과 보정 ----------
  function ratioOf(records) {
    var est = 0, act = 0;
    records.forEach(function (r) { est += r.estimateMin; act += r.actualMin; });
    return { n: records.length, est: est, act: act, ratio: est > 0 ? round1(act / est) : NaN };
  }

  /* 보정에 쓸 배율: 그 루틴 기록 3개 이상 → 같은 카테고리 기록 3개 이상 → 없음(null) */
  function calibration(records, opts) {
    if (opts.routineId) {
      var rs = records.filter(function (r) { return r.routineId === opts.routineId; });
      if (rs.length >= CALIBRATE_FROM) return Object.assign({ source: 'routine' }, ratioOf(rs));
    }
    if (opts.category) {
      var cs = records.filter(function (r) { return r.category === opts.category; });
      if (cs.length >= CALIBRATE_FROM) return Object.assign({ source: 'category' }, ratioOf(cs));
    }
    return null;
  }
  function predict(planMin, cal) { return cal ? round5(planMin * cal.ratio) : planMin; }

  /* 'fits' 들어가요 / 'min' 최소 시간만큼만 / 'tight' 빠듯해요 */
  function fit(predBase, predMin, avail) {
    if (avail >= predBase) return 'fits';
    if (avail >= predMin) return 'min';
    return 'tight';
  }

  function categoryStats(records) {
    var map = {};
    records.forEach(function (r) { (map[r.category] = map[r.category] || []).push(r); });
    return Object.keys(map).map(function (c) { return Object.assign({ category: c }, ratioOf(map[c])); })
      .sort(function (a, b) { return b.n - a.n; });
  }

  // ---------- 앵커 ----------
  /* shift: 자정 뒤 전날로 치는 분. 시각 앵커가 그보다 이르면(예: 00:30) 앱 안의 하루 끝 쪽(24:30)으로 본다. */
  function anchorToday(routine, blocks, weekday, shift) {
    var a = routine.anchor;
    if (!a) return { type: 'none' };
    if (a.type === 'time') {
      var t = toMin(a.time);
      return { type: 'time', today: true, plannedMin: t < (shift || 0) ? t + 1440 : t, time: a.time };
    }
    var b = blocks.filter(function (x) { return x.id === a.blockId; })[0];
    if (!b) return { type: 'none' };
    if (b.days.indexOf(weekday) === -1) return { type: 'block', today: false, block: b };
    return { type: 'block', today: true, block: b, plannedMin: toMin(b.end) };
  }

  /* 루틴을 비교할 빈 시간: 앵커 직후(또는 앵커 시각을 품은) 빈 시간, 없으면 오늘 남은 가장 큰 빈 시간.
   * avail은 지금부터(또는 앵커 시각부터) 그 빈 시간이 끝날 때까지 쓸 수 있는 분. */
  function pickGap(gaps, plannedMin, nowMin, bufferMin) {
    var live = gaps.filter(function (g) { return g.state !== 'past'; });
    function availOf(g, from) {
      var s = Math.max(g.start, from == null ? g.start : from);
      if (nowMin != null) s = Math.max(s, nowMin);
      return Math.max(0, g.end - s);
    }
    if (plannedMin != null) {
      var hit = live.filter(function (g) {
        return (g.start <= plannedMin && g.end > plannedMin) ||
          (g.start >= plannedMin && g.start <= plannedMin + (bufferMin || 0) + 1);
      })[0];
      if (hit) return { gap: hit, avail: availOf(hit, plannedMin), anchored: true };
    }
    if (!live.length) return null;
    var best = live.slice().sort(function (a, b) { return availOf(b) - availOf(a); })[0];
    return { gap: best, avail: availOf(best), anchored: false };
  }

  // ---------- 달성과 놓침 ----------
  /* 모든 날짜 계산은 앱 안의 하루 기준. shift(분)만큼 시각을 당겨서 본다. */
  function shifted(d, shift) { return new Date(new Date(d).getTime() - (shift || 0) * 60000); }

  /* 한 번으로 세는 기록인지: 기록할 때의 최소 시간(minMin)을 넘겼으면 센다.
   * minMin이 없는 기록(예전 기록, 늘 같은 분량을 끝낸 기록)은 센다 */
  function countsAsDone(rec) { return rec.minMin == null || rec.actualMin >= rec.minMin; }

  function daysDone(records, routineId, from, to, shift) {
    var set = {};
    records.forEach(function (r) {
      if (r.routineId !== routineId || !countsAsDone(r)) return;
      var t = Date.parse(r.startedAt) - (shift || 0) * 60000;
      if (t >= from.getTime() && t < to.getTime()) set[dayKey(t)] = true;
    });
    return Object.keys(set).length;
  }
  function weekDone(records, routineId, now, shift) {
    var ws = startOfWeek(shifted(now, shift));
    return daysDone(records, routineId, ws, addDays(ws, 7), shift);
  }
  /* day: 앱 안의 날짜(자정 기준 Date) */
  function doneOn(records, routineId, day, shift) {
    var s = startOfDay(day);
    return daysDone(records, routineId, s, addDays(s, 1), shift) > 0;
  }

  /* 지난 4주(이번 주 제외), 오래된 주부터. state: done | miss | none(루틴을 만들기 전) */
  function lastWeeks(records, routine, now, count, shift) {
    count = count || 4;
    var out = [], thisWeek = startOfWeek(shifted(now, shift)), created = Date.parse(routine.createdAt) - (shift || 0) * 60000;
    for (var i = count; i >= 1; i--) {
      var ws = addDays(thisWeek, -7 * i), we = addDays(ws, 7);
      if (created >= we.getTime()) { out.push({ weekStart: ws, count: 0, state: 'none' }); continue; }
      var c = daysDone(records, routine.id, ws, we, shift);
      var target = routine.perWeek || (Array.isArray(routine.days) && routine.days.length) || 7;
      out.push({ weekStart: ws, count: c, state: c >= target ? 'done' : 'miss' });
    }
    return out;
  }

  /* 매일 루틴을 어제 놓쳤는지. 어제가 시작되기 전에 만든 루틴만 본다. */
  function missedYesterday(records, routine, now, shift) {
    if (routine.perWeek !== 7) return false;
    var y = addDays(startOfDay(shifted(now, shift)), -1);
    if (Date.parse(routine.createdAt) - (shift || 0) * 60000 >= y.getTime()) return false;
    return !doneOn(records, routine.id, y, shift);
  }

  /* 주 N회 루틴: 이번 주 남은 횟수가 남은 날수보다 많은지 */
  function weekTight(routine, done, doneToday, now, shift) {
    if (routine.perWeek >= 7) return null;
    var left = routine.perWeek - done;
    if (left <= 0) return null;
    var daysLeft = 7 - mondayIndex(shifted(now, shift)) - (doneToday ? 1 : 0);
    return left > daysLeft ? { left: left, daysLeft: daysLeft } : null;
  }

  // ---------- 루틴 종류와 상황 루틴 ----------
  /* 시각 루틴(time) · 상황 루틴(situation) · 아무 때나 루틴(anytime)
   * 상황 루틴의 신호: 고정 일정이 끝나면(block) · 다른 루틴을 끝내면(routine) · 쉬는 날이면(dayoff) · 내가 알려 주는 상황(situation)
   * 상황 루틴은 "주 N회" 대신 "상황이 올 때마다" 하고, 상황이 생긴 날 중 실천한 날로 센다. */
  var SITUATION_TYPES = ['block', 'routine', 'dayoff', 'situation'];
  function routineKind(r) {
    if (!r.anchor) return 'anytime';
    return r.anchor.type === 'time' ? 'time' : 'situation';
  }
  function isSituation(r) { return !!r.anchor && SITUATION_TYPES.indexOf(r.anchor.type) !== -1; }

  /* env: { blocks, records, events, holidays, off, shift, now } · from·to: 앱 안의 날짜(to는 제외)
   * 루틴을 만든 날 전과 오늘 뒤는 세지 않는다 → 상황이 생긴 날 { 'YYYY-MM-DD': true } */
  function occurrenceDays(r, env, from, to) {
    var a = r.anchor, set = {}, shift = env.shift || 0;
    var today = startOfDay(shifted(env.now, shift));
    var made = startOfDay(shifted(r.createdAt, shift));
    var s = Math.max(from.getTime(), made.getTime()), e = Math.min(to.getTime(), addDays(today, 1).getTime());
    if (a.type === 'routine' || a.type === 'situation') {
      var times = a.type === 'routine'
        ? env.records.filter(function (x) { return x.routineId === a.routineId; }).map(function (x) { return x.startedAt; })
        : (env.events || []).filter(function (ev) { return ev.label === a.label; }).map(function (ev) { return ev.at; });
      times.forEach(function (iso) {
        var t = Date.parse(iso) - shift * 60000;
        if (t >= s && t < e) set[dayKey(t)] = true;
      });
      return set;
    }
    for (var d = new Date(s); d.getTime() < e; d = addDays(d, 1)) {
      var hol = holidayName(env.holidays || [], d) != null;
      var wd = d.getDay();
      var dayBl = blocksForDay(env.blocks, hol, env.off || DEFAULT_HOLIDAY_OFF).filter(function (b) { return b.days.indexOf(wd) !== -1; });
      if (a.type === 'block' && dayBl.some(function (b) { return b.id === a.blockId; })) set[dayKey(d)] = true;
      if (a.type === 'dayoff' && (hol || dayBl.length === 0)) set[dayKey(d)] = true;
    }
    return set;
  }
  function doneDays(records, routineId, from, to, shift) {
    var set = {};
    records.forEach(function (r) {
      if (r.routineId !== routineId || !countsAsDone(r)) return;
      var t = Date.parse(r.startedAt) - (shift || 0) * 60000;
      if (t >= from.getTime() && t < to.getTime()) set[dayKey(t)] = true;
    });
    return set;
  }
  /* 상황이 생긴 날(occ) 중 실천한 날(hit) */
  function situationProgress(r, env, from, to) {
    var occ = occurrenceDays(r, env, from, to), done = doneDays(env.records, r.id, from, to, env.shift);
    var keys = Object.keys(occ);
    return { occ: keys.length, hit: keys.filter(function (k) { return done[k]; }).length };
  }
  function situationWeek(r, env) {
    var ws = startOfWeek(shifted(env.now, env.shift));
    return situationProgress(r, env, ws, addDays(ws, 7));
  }
  /* 지난 4주(이번 주 제외). state: none(만들기 전) | quiet(상황 없음) | done(전부 실천) | miss */
  function situationWeeks(r, env, count) {
    var out = [], thisWeek = startOfWeek(shifted(env.now, env.shift)), made = Date.parse(r.createdAt) - (env.shift || 0) * 60000;
    for (var i = (count || 4); i >= 1; i--) {
      var ws = addDays(thisWeek, -7 * i), we = addDays(ws, 7);
      if (made >= we.getTime()) { out.push({ weekStart: ws, occ: 0, hit: 0, state: 'none' }); continue; }
      var p = situationProgress(r, env, ws, we);
      out.push({ weekStart: ws, occ: p.occ, hit: p.hit, state: p.occ === 0 ? 'quiet' : (p.hit >= p.occ ? 'done' : 'miss') });
    }
    return out;
  }
  /* 어제 상황이 생겼는데 하지 못했는지 (두 번 연속 놓치지 않기) */
  function situationMissedYesterday(r, env) {
    var y = addDays(startOfDay(shifted(env.now, env.shift)), -1);
    var p = situationProgress(r, env, y, addDays(y, 1));
    return p.occ > 0 && p.hit === 0;
  }
  /* 오늘 상황이 생겼는지와 그 시각(앱 안의 하루 기준 분). day: 앱 안의 오늘(자정 Date) */
  function situationToday(r, env, day) {
    var a = r.anchor, shift = env.shift || 0, key = dayKey(day);
    var minOf = function (iso) { return Math.round((Date.parse(iso) - day.getTime()) / 60000); };
    var onDay = function (iso) { return dayKey(Date.parse(iso) - shift * 60000) === key; };
    if (a.type === 'routine') {
      var recs = env.records.filter(function (x) { return x.routineId === a.routineId && onDay(x.startedAt); })
        .sort(function (p, q) { return Date.parse(q.endedAt) - Date.parse(p.endedAt); });
      return { type: 'routine', today: recs.length > 0, plannedMin: recs.length ? minOf(recs[0].endedAt) : null };
    }
    if (a.type === 'situation') {
      var evs = (env.events || []).filter(function (ev) { return ev.label === a.label && onDay(ev.at); })
        .sort(function (p, q) { return Date.parse(q.at) - Date.parse(p.at); });
      return { type: 'situation', today: evs.length > 0, plannedMin: evs.length ? minOf(evs[0].at) : null, label: a.label };
    }
    if (a.type === 'dayoff') {
      var p = situationProgress(r, Object.assign({}, env, { now: env.now }), day, addDays(day, 1));
      return { type: 'dayoff', today: p.occ > 0, plannedMin: null };
    }
    return null;
  }
  function checkSituationLabel(v) {
    var t = String(v == null ? '' : v).trim();
    if (!t) return '상황 이름을 적어 주세요 (예: 집 도착)';
    if (t.length > 20) return '상황 이름은 20자 이내로 적어 주세요';
    return '';
  }

  // ---------- 얼마나 자주와 연속 기록 ----------
  /* 시각·아무 때나 루틴은 요일을 정하거나(days) 주 몇 번만 정한다(weekly). 상황 루틴은 상황이 올 때마다(situation). */
  function scheduleOf(r) {
    if (isSituation(r)) return 'situation';
    return Array.isArray(r.days) && r.days.length ? 'days' : 'weekly';
  }
  function streakUnit(r) { return { days: '일', weekly: '주', situation: '번' }[scheduleOf(r)]; }

  /* 기회마다 결과: hit(지킴) | miss(놓침). 아직 끝나지 않은 오늘(이번 주)은 pending.
   * 오래된 것부터. 루틴을 만들기 전은 세지 않는다. */
  function opportunities(r, env) {
    var shift = env.shift || 0, sched = scheduleOf(r);
    var today = startOfDay(shifted(env.now, shift));
    var made = startOfDay(shifted(r.createdAt, shift));
    var done = doneDays(env.records, r.id, made, addDays(today, 1), shift);
    var out = [], d, k;
    if (sched === 'days') {
      for (d = new Date(made); d.getTime() <= today.getTime(); d = addDays(d, 1)) {
        if (r.days.indexOf(d.getDay()) === -1) continue;
        k = dayKey(d);
        out.push({ key: k, result: done[k] ? 'hit' : (k === dayKey(today) ? 'pending' : 'miss') });
      }
    } else if (sched === 'weekly') {
      var thisWeek = startOfWeek(today);
      for (d = startOfWeek(made); d.getTime() <= thisWeek.getTime(); d = addDays(d, 7)) {
        var c = Object.keys(done).filter(function (x) { var t = Date.parse(x + 'T00:00:00'); return t >= d.getTime() && t < addDays(d, 7).getTime(); }).length;
        var cur = d.getTime() === thisWeek.getTime();
        var first = d.getTime() === startOfWeek(made).getTime() && made.getTime() > d.getTime();
        if (c >= r.perWeek) out.push({ key: dayKey(d), result: 'hit' });
        else if (cur) out.push({ key: dayKey(d), result: 'pending' });
        else if (!first) out.push({ key: dayKey(d), result: 'miss' }); // 중간에 만든 첫 주는 못 채워도 놓친 걸로 치지 않는다
      }
    } else {
      var occ = occurrenceDays(r, env, made, addDays(today, 1));
      Object.keys(occ).sort().forEach(function (x) {
        out.push({ key: x, result: done[x] ? 'hit' : (x === dayKey(today) ? 'pending' : 'miss') });
      });
    }
    return out;
  }

  /* 연속 기록 (한 번은 봐주기): 한 번 놓쳐도 이어지고, 두 번 연속 놓치면 처음부터.
   * current·best: 봐준 것 포함 연속 / perfect·perfectBest: 봐주기 없는 완벽 연속
   * forgiven: 봐준 기회(날짜 또는 주 시작일) — 화면에는 쓰지 않고 업적용으로 남긴다
   * atRisk: 직전 기회를 놓쳐서, 지금 기회(오늘·이번 주)까지 놓치면 끊기는 상태 */
  function streak(r, env) {
    var list = opportunities(r, env);
    var current = 0, best = 0, perfect = 0, perfectBest = 0, lastMiss = false, forgiven = [], runForgiven = [];
    list.forEach(function (o) {
      if (o.result === 'pending') return;
      if (o.result === 'hit') {
        current += 1; perfect += 1; lastMiss = false;
      } else if (lastMiss) {
        current = 0; perfect = 0; runForgiven = []; // 두 번 연속 놓침: 끊김
      } else {
        lastMiss = true; perfect = 0;
        if (current > 0) { forgiven.push(o.key); runForgiven.push(o.key); }
      }
      if (current > best) best = current;
      if (perfect > perfectBest) perfectBest = perfect;
    });
    var pending = list.length && list[list.length - 1].result === 'pending';
    return {
      unit: streakUnit(r), current: current, best: best, perfect: perfect, perfectBest: perfectBest,
      forgiven: forgiven, forgivenInRun: runForgiven, atRisk: lastMiss && current > 0 && !!pending, pending: !!pending
    };
  }

  // ---------- 규칙 다듬기 제안 ----------
  /* 기록에 근거한 제안만. 횟수를 올리자는 제안은 하지 않는다(목표는 행동, 기록이 좋다고 목표를 키우지 않음).
   * 반환: [{ key, routineId, kind: 'perWeek'|'baseMin'|'steady', from, to }] */
  /* env(선택): 상황 루틴 계산용 { blocks, events, holidays, off } */
  function suggestions(records, routines, now, shift, env) {
    var out = [];
    var wk = dayKey(startOfWeek(shifted(now, shift)));
    routines.forEach(function (r) {
      // 상황 루틴은 "주 N회"가 없어서 횟수 제안과 4주 채움을 보지 않는다 (기본 시간 제안만)
      var weeks = isSituation(r) || !r.perWeek ? [] : lastWeeks(records, r, now, 4, shift);
      var last2 = weeks.slice(-2);
      if (r.perWeek > 1 && last2.length === 2 && last2.every(function (w) { return w.state === 'miss'; })) {
        var avg = (last2[0].count + last2[1].count) / 2;
        var to = Math.max(1, Math.round(avg));
        if (to < r.perWeek && avg <= r.perWeek - 1) {
          out.push({ key: wk + '|' + r.id + '|perWeek', routineId: r.id, kind: 'perWeek', from: r.perWeek, to: to, counts: last2.map(function (w) { return w.count; }) });
        }
      }
      if (weeks.length && weeks.every(function (w) { return w.state === 'done'; })) {
        out.push({ key: wk + '|' + r.id + '|steady', routineId: r.id, kind: 'steady' });
      }
      // 요일 루틴: 지난 4주 동안 4번 중 1번 이하로 한 요일은 빼자고 (요일이 2개 이상일 때만)
      if (scheduleOf(r) === 'days' && r.days.length >= 2) {
        var stats = dayStats(records, r, now, shift);
        var worst = stats.filter(function (x) { return x.total >= 3 && x.done / x.total <= 0.25; })
          .sort(function (a, b) { return a.done / a.total - b.done / b.total; })[0];
        if (worst) {
          out.push({ key: wk + '|' + r.id + '|dropDay', routineId: r.id, kind: 'dropDay', day: worst.day, done: worst.done, total: worst.total,
            to: r.days.filter(function (d) { return d !== worst.day; }) });
        }
      }
      // 상황 루틴: 지난 4주 실천이 절반 미만이면 (상황 4번 이상) 최소 시간을 줄이거나 시작 신호를 바꿔 보자고
      if (isSituation(r) && env) {
        var full = Object.assign({ records: records, now: now, shift: shift }, env);
        var ws4 = addDays(startOfWeek(shifted(now, shift)), -28);
        var p4 = situationProgress(r, full, ws4, startOfWeek(shifted(now, shift)));
        if (p4.occ >= 4 && p4.hit / p4.occ < 0.5) {
          var smaller = r.minMin > 5 ? Math.max(5, round5(r.minMin / 2)) : null;
          out.push({ key: wk + '|' + r.id + '|situationLow', routineId: r.id, kind: 'situationLow', occ: p4.occ, hit: p4.hit,
            from: r.minMin, to: smaller && smaller < r.minMin ? smaller : null });
        }
      }
      var base = records.filter(function (x) { return x.routineId === r.id && x.version !== 'min' && countsAsDone(x); }).sort(byStart).slice(-5);
      if (base.length >= 5) {
        var med = median(base.map(function (x) { return x.actualMin; }));
        var next = round5(med);
        if (Math.abs(med - r.baseMin) / r.baseMin >= 0.2 && Math.abs(next - r.baseMin) >= 5 && next > r.minMin && next <= 720) {
          out.push({ key: wk + '|' + r.id + '|baseMin', routineId: r.id, kind: 'baseMin', from: r.baseMin, to: next, median: med });
        }
      }
    });
    return out;
  }

  /* 요일 루틴의 지난 4주(이번 주 제외) 요일별 실천: [{ day, done, total }] */
  function dayStats(records, r, now, shift) {
    var thisWeek = startOfWeek(shifted(now, shift)), made = startOfDay(shifted(r.createdAt, shift));
    var done = doneDays(records, r.id, addDays(thisWeek, -28), thisWeek, shift);
    return r.days.map(function (day) {
      var total = 0, hit = 0;
      for (var i = 4; i >= 1; i--) {
        var d = addDays(addDays(thisWeek, -7 * i), (day + 6) % 7);
        if (d.getTime() < made.getTime()) continue;
        total += 1;
        if (done[dayKey(d)]) hit += 1;
      }
      return { day: day, done: hit, total: total };
    });
  }

  /* 타이머를 늦게 끈 것 같은지: 12시간 초과, 또는 예상의 2배를 넘고 30분 이상 더 걸림 */
  function looksTooLong(estimateMin, elapsedMin) {
    return elapsedMin > 720 || (elapsedMin > estimateMin * 2 && elapsedMin - estimateMin >= 30);
  }

  // ---------- 측정 ----------
  function actualMinutes(startedAt, endedAt) {
    return Math.max(1, Math.round(diffMin(startedAt, endedAt)));
  }
  /* 계획한 시작 시각부터 실제 시작까지(분). 0~180분 밖이면 null */
  function delayMinutes(plannedStartAt, startedAt) {
    if (!plannedStartAt) return null;
    var d = Math.round(diffMin(plannedStartAt, startedAt));
    return d >= 0 && d <= MAX_DELAY ? d : null;
  }

  /* 처음 5개와 최근 5개의 중앙값 비교. 기록이 10개 미만이면 ready:false */
  function compareHalves(values) {
    var n = values.length;
    if (n < OBSERVE_FROM) return { ready: false, n: n, need: OBSERVE_FROM };
    var first = median(values.slice(0, 5)), recent = median(values.slice(-5));
    var lastFive = values.slice(-5);
    var change = first > 0 ? (recent - first) / first : 0;
    return {
      ready: true, n: n, first: first, recent: recent, change: change,
      dir: Math.abs(change) < SAME_BAND ? 'same' : change < 0 ? 'down' : 'up',
      lo: Math.min.apply(null, lastFive), hi: Math.max.apply(null, lastFive)
    };
  }

  /* 루틴 수행 시간 관찰. 유형에 따라 비교 기준을 바꾼다.
   * fixed: 분 (예전 최소 버전 기록 제외) / count: 단위당 분 / none: 배율 */
  function observeDuration(records, routine) {
    var rs = records.filter(function (r) { return r.routineId === routine.id; }).sort(byStart);
    var type = routine.measure.type, values;
    if (type === 'fixed') values = rs.filter(function (r) { return r.version !== 'min'; }).map(function (r) { return r.actualMin; });
    else if (type === 'count') values = rs.filter(function (r) { return r.amount > 0; }).map(function (r) { return r.actualMin / r.amount; });
    else values = rs.map(function (r) { return r.actualMin / r.estimateMin; });
    return Object.assign({ kind: type }, compareHalves(values));
  }
  function observeDelay(records, routine) {
    var values = records.filter(function (r) { return r.routineId === routine.id; }).sort(byStart)
      .map(function (r) { return delayMinutes(r.plannedStartAt, r.startedAt); })
      .filter(function (v) { return v != null; });
    return compareHalves(values);
  }

  // ---------- 관찰 문장 (판단 없이 사실과 쓸모만) ----------
  function durationSentence(obs, routine) {
    if (!obs.ready) return '기록 ' + obs.n + '/' + obs.need + ' · ' + obs.need + '개가 쌓이면 변화를 보여 드려요.';
    var unit = routine.measure.unit || '';
    var fmt, range;
    if (obs.kind === 'fixed') {
      fmt = function (v) { return Math.round(v) + '분'; };
      range = Math.round(obs.lo) + '~' + Math.round(obs.hi) + '분';
    } else if (obs.kind === 'count') {
      fmt = function (v) { return '1' + unit + '당 ' + round1(v) + '분'; };
      range = '1' + unit + '당 ' + round1(obs.lo) + '~' + round1(obs.hi) + '분';
    } else {
      fmt = function (v) { return '예상의 ' + round1(v).toFixed(1) + '배'; };
      range = '예상의 ' + round1(obs.lo).toFixed(1) + '~' + round1(obs.hi).toFixed(1) + '배';
    }
    if (obs.dir === 'same') return '최근 5번은 ' + range + ' 사이로, 처음과 비슷해요.';
    var s = '처음 5번은 중앙값 ' + fmt(obs.first) + ', 최근 5번은 ' + fmt(obs.recent) + '이에요.';
    if (obs.kind === 'fixed' && obs.dir === 'down') s += ' 다음 계획은 ' + round5(obs.recent) + '분으로 잡아도 돼요.';
    else if (obs.kind === 'none') s += Math.abs(obs.recent - 1) < SAME_BAND ? ' 요즘은 예상과 거의 맞아요.' : '';
    else if (obs.dir === 'up') s += ' 내용이나 상황이 달라졌을 수 있어요.';
    else if (obs.kind === 'count') s += ' 같은 분량이면 전보다 시간이 덜 들어요.';
    return s;
  }
  function delaySentence(obs, anchorLabel) {
    if (!obs.ready) return obs.n ? '시작 지연 기록 ' + obs.n + '/' + obs.need + ' · ' + obs.need + '개가 쌓이면 변화를 보여 드려요.' : '';
    if (obs.dir === 'same') return anchorLabel + '부터 시작까지 최근 5번은 ' + Math.round(obs.lo) + '~' + Math.round(obs.hi) + '분이에요.';
    return anchorLabel + '부터 시작까지 처음 5번은 중앙값 ' + Math.round(obs.first) + '분, 최근 5번은 ' + Math.round(obs.recent) + '분이에요.';
  }

  // ---------- 입력 검사 (빈 문자열 = 통과) ----------
  function checkName(v) {
    var t = String(v == null ? '' : v).trim();
    if (!t) return '이름을 적어 주세요';
    if (t.length > 50) return '50자 이내로 적어 주세요';
    return '';
  }
  function checkCategory(v) {
    return String(v == null ? '' : v).trim().length > 20 ? '카테고리는 20자 이내로 적어 주세요' : '';
  }
  function checkMinutes(v) {
    var t = String(v == null ? '' : v).trim();
    var n = Number(t);
    if (t === '' || !isFinite(n)) return '분 단위 숫자로 적어 주세요';
    if (n <= 0) return '1분 이상으로 적어 주세요';
    if (!Number.isInteger(n)) return '분 단위 숫자로 적어 주세요';
    if (n > 720) return '12시간을 넘는 일은 나눠서 적어 보세요';
    return '';
  }
  function checkAmount(v) {
    var t = String(v == null ? '' : v).trim(), n = Number(t);
    if (t === '' || !Number.isInteger(n) || n < 1 || n > 9999) return '1 이상의 정수로 적어 주세요';
    return '';
  }
  function checkUnit(v) {
    var t = String(v == null ? '' : v).trim();
    if (!t) return '단위를 적어 주세요 (예: 장, 문제, 쪽)';
    if (t.length > 10) return '단위는 10자 이내로 적어 주세요';
    return '';
  }
  function checkTimeRange(start, end) {
    if (isNaN(toMin(start))) return { field: 'start', msg: '시작 시각을 골라 주세요' };
    if (isNaN(toMin(end))) return { field: 'end', msg: '끝 시각을 골라 주세요' };
    if (toMin(end) <= toMin(start)) return { field: 'end', msg: '끝 시각은 시작보다 늦어야 해요' };
    return null;
  }

  var Calc = {
    MIN_GAP: MIN_GAP, CALIBRATE_FROM: CALIBRATE_FROM, OBSERVE_FROM: OBSERVE_FROM, MAX_DELAY: MAX_DELAY, DAY_NAMES: DAY_NAMES,
    pad: pad, toMin: toMin, fmtHM: fmtHM, fmtDuration: fmtDuration, round1: round1, round5: round5, median: median,
    startOfDay: startOfDay, addDays: addDays, mondayIndex: mondayIndex, startOfWeek: startOfWeek, dayKey: dayKey,
    minutesOfDay: minutesOfDay, atMinutes: atMinutes, diffMin: diffMin,
    MAX_ROLLOVER: MAX_ROLLOVER, dayEndMin: dayEndMin, rolloverMin: rolloverMin, logical: logical, logicalKey: logicalKey,
    checkSettings: checkSettings, suggestions: suggestions, looksTooLong: looksTooLong,
    SITUATION_TYPES: SITUATION_TYPES, routineKind: routineKind, isSituation: isSituation, occurrenceDays: occurrenceDays,
    doneDays: doneDays, situationProgress: situationProgress, situationWeek: situationWeek, situationWeeks: situationWeeks,
    situationMissedYesterday: situationMissedYesterday, situationToday: situationToday, checkSituationLabel: checkSituationLabel,
    scheduleOf: scheduleOf, dayStats: dayStats, streakUnit: streakUnit, opportunities: opportunities, streak: streak,
    DEFAULT_HOLIDAY_OFF: DEFAULT_HOLIDAY_OFF, holidayOff: holidayOff, holidayName: holidayName, blocksForDay: blocksForDay,
    upcomingHolidays: upcomingHolidays, validHolidays: validHolidays,
    dayBlocks: dayBlocks, computeGaps: computeGaps, findOverlaps: findOverlaps,
    ratioOf: ratioOf, calibration: calibration, predict: predict, fit: fit, categoryStats: categoryStats,
    anchorToday: anchorToday, pickGap: pickGap,
    weekDone: weekDone, doneOn: doneOn, countsAsDone: countsAsDone, lastWeeks: lastWeeks, missedYesterday: missedYesterday, weekTight: weekTight,
    actualMinutes: actualMinutes, delayMinutes: delayMinutes, compareHalves: compareHalves,
    observeDuration: observeDuration, observeDelay: observeDelay, durationSentence: durationSentence, delaySentence: delaySentence,
    checkName: checkName, checkCategory: checkCategory, checkMinutes: checkMinutes, checkAmount: checkAmount,
    checkUnit: checkUnit, checkTimeRange: checkTimeRange
  };

  if (typeof module === 'object' && module.exports) module.exports = Calc;
  else root.Calc = Calc;
})(this);
