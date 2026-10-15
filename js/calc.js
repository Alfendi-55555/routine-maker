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
  function fmtHM(min) { return pad(Math.floor(min / 60)) + ':' + pad(min % 60); }
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

  // ---------- 고정 일정과 빈 시간 ----------
  function dayBlocks(blocks, weekday) {
    return blocks.filter(function (b) { return b.days.indexOf(weekday) !== -1; })
      .sort(function (a, b) { return toMin(a.start) - toMin(b.start); });
  }

  /* 하루 활동 시간에서 고정 일정(앞뒤 전환 시간 포함)을 빼고 남는 빈 시간.
   * nowMin을 주면 각 빈 시간에 state(past/now/future)와 remaining(남은 분)을 붙인다. */
  function computeGaps(blocks, weekday, settings, nowMin) {
    var ds = toMin(settings.dayStart), de = toMin(settings.dayEnd), buf = settings.bufferMin;
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

  /* 'fits' 들어가요 / 'min' 최소 버전만 / 'tight' 빠듯해요 */
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
  function anchorToday(routine, blocks, weekday) {
    var a = routine.anchor;
    if (!a) return { type: 'none' };
    if (a.type === 'time') return { type: 'time', today: true, plannedMin: toMin(a.time), time: a.time };
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
  function daysDone(records, routineId, from, to) {
    var set = {};
    records.forEach(function (r) {
      if (r.routineId !== routineId) return;
      var t = Date.parse(r.startedAt);
      if (t >= from.getTime() && t < to.getTime()) set[dayKey(r.startedAt)] = true;
    });
    return Object.keys(set).length;
  }
  function weekDone(records, routineId, now) {
    var ws = startOfWeek(now);
    return daysDone(records, routineId, ws, addDays(ws, 7));
  }
  function doneOn(records, routineId, day) {
    var s = startOfDay(day);
    return daysDone(records, routineId, s, addDays(s, 1)) > 0;
  }

  /* 지난 4주(이번 주 제외), 오래된 주부터. state: done | miss | none(루틴을 만들기 전) */
  function lastWeeks(records, routine, now, count) {
    count = count || 4;
    var out = [], thisWeek = startOfWeek(now), created = Date.parse(routine.createdAt);
    for (var i = count; i >= 1; i--) {
      var ws = addDays(thisWeek, -7 * i), we = addDays(ws, 7);
      if (created >= we.getTime()) { out.push({ weekStart: ws, count: 0, state: 'none' }); continue; }
      var c = daysDone(records, routine.id, ws, we);
      out.push({ weekStart: ws, count: c, state: c >= routine.perWeek ? 'done' : 'miss' });
    }
    return out;
  }

  /* 매일 루틴을 어제 놓쳤는지. 어제가 시작되기 전에 만든 루틴만 본다. */
  function missedYesterday(records, routine, now) {
    if (routine.perWeek !== 7) return false;
    var y = addDays(startOfDay(now), -1);
    if (Date.parse(routine.createdAt) >= y.getTime()) return false;
    return !doneOn(records, routine.id, y);
  }

  /* 주 N회 루틴: 이번 주 남은 횟수가 남은 날수보다 많은지 */
  function weekTight(routine, done, doneToday, now) {
    if (routine.perWeek >= 7) return null;
    var left = routine.perWeek - done;
    if (left <= 0) return null;
    var daysLeft = 7 - mondayIndex(now) - (doneToday ? 1 : 0);
    return left > daysLeft ? { left: left, daysLeft: daysLeft } : null;
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
   * fixed: 분 (최소 버전 제외) / count: 단위당 분 / none: 배율 */
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
    dayBlocks: dayBlocks, computeGaps: computeGaps, findOverlaps: findOverlaps,
    ratioOf: ratioOf, calibration: calibration, predict: predict, fit: fit, categoryStats: categoryStats,
    anchorToday: anchorToday, pickGap: pickGap,
    weekDone: weekDone, doneOn: doneOn, lastWeeks: lastWeeks, missedYesterday: missedYesterday, weekTight: weekTight,
    actualMinutes: actualMinutes, delayMinutes: delayMinutes, compareHalves: compareHalves,
    observeDuration: observeDuration, observeDelay: observeDelay, durationSentence: durationSentence, delaySentence: delaySentence,
    checkName: checkName, checkCategory: checkCategory, checkMinutes: checkMinutes, checkAmount: checkAmount,
    checkUnit: checkUnit, checkTimeRange: checkTimeRange
  };

  if (typeof module === 'object' && module.exports) module.exports = Calc;
  else root.Calc = Calc;
})(this);
