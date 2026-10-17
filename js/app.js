/* 루틴메이커 화면 모듈: 화면 그리기와 입력 처리.
 * 계산은 Calc, 저장은 Store에 맡긴다. 사용자 입력은 textContent로만 넣는다(innerHTML 사용 안 함).
 */
(function () {
  'use strict';

  const C = window.Calc;
  const S = window.Store;
  const BASE_CATEGORIES = ['과제', '공부', '복습', '시험 준비', '팀플', '기타'];
  const TABS = ['today', 'calendar', 'routines', 'review'];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const RECORDS_PAGE = 30;
  const KIND_ORDER = ['수업', '통학', '알바', '기타'];
  const KIND_CLASS = { 수업: 'k-class', 통학: 'k-commute', 알바: 'k-work', 기타: 'k-etc' };
  const kindClass = (kind) => KIND_CLASS[kind] || 'k-etc';

  let state = S.empty();
  const ui = {
    tab: 'today',
    panel: null,          // 루틴 항목 안의 작은 입력칸 { routineId, mode: 'start'|'manual' }
    filter: '전체',
    showAll: false,
    editBlock: null,
    editRoutine: null,
    pendingImport: null,
    editRecord: null,     // 고치는 중인 기록 id
    routine: null,        // 루틴 탭에서 상세로 연 루틴 id (#routine-<id>)
    editWhere: 'review',  // 기록 고치기 칸을 연 곳: review | detail
    calView: 'week',      // 캘린더 보기: week(기본) | month
    calWeek: null,        // 주 보기에 보이는 주 (월요일)
    calMonth: null,       // 월 보기에 보이는 달 (그달 1일)
    calSel: null,         // 캘린더에서 고른 날 'YYYY-MM-DD'
    lastMinute: -1
  };
  let timerTick = null;
  let lastAnnounced = -1;

  // ---------- 작은 도구 ----------
  const $ = (id) => document.getElementById(id);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : String(c));
    }
    return el;
  }

  /* 연필 아이콘 버튼 (고치기). 지우기는 고치기 창 안에서 */
  function pencilBtn(label, onclick, cls) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '18'); svg.setAttribute('height', '18');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z');
    svg.append(path);
    return h('button', { type: 'button', class: 'icon-btn' + (cls ? ' ' + cls : ''), 'aria-label': label, title: '고치기', onclick }, svg);
  }

  function uid(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function q(name) { return '‘' + name + '’'; }
  function daysText(days) { return DAY_ORDER.filter((d) => days.includes(d)).map((d) => C.DAY_NAMES[d]).join('·'); }
  function perWeekText(n) { return n == null ? '상황이 올 때마다' : n === 7 ? '매일' : '주 ' + n + '회'; }
  /* 루틴 호칭: 시각 루틴 · 상황 루틴 · 아무 때나 루틴 */
  const KIND_NAMES = { time: '시각 루틴', situation: '상황 루틴', anytime: '아무 때나 루틴' };
  function kindName(r) { return KIND_NAMES[C.routineKind(r)]; }
  /* 얼마나 자주: 상황 루틴은 늘 "상황이 올 때마다" */
  function daysGoal(days) {
    const set = new Set(days);
    if (set.size === 7) return '매일';
    if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return '평일';
    if (set.size === 2 && set.has(0) && set.has(6)) return '주말';
    return daysText(days);
  }
  function goalText(r) {
    const sc = C.scheduleOf(r);
    if (sc === 'situation') return '상황이 올 때마다';
    if (sc === 'days') return daysGoal(r.days);
    return perWeekText(r.perWeek) + ' (요일 자유)';
  }
  /* 이번 주에 해야 할 날 수: 요일 루틴은 이번 주의 그 요일 수, 주 N회 루틴은 N */
  function weekTarget(r) { return C.scheduleOf(r) === 'days' ? r.days.length : r.perWeek; }
  function streakText(st) { return st.current > 0 ? '연속 ' + st.current + st.unit : ''; }
  function sitWeekText(occ, hit) { return occ ? '이번 주 상황 ' + occ + '번 중 ' + hit + '번' : '이번 주는 아직 상황이 없어요'; }
  function dateText(iso) {
    const d = new Date(iso);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' (' + C.DAY_NAMES[d.getDay()] + ')';
  }
  function clockText(iso) { return C.fmtHM(C.minutesOfDay(iso)); }
  function ratioText(r) {
    if (!isFinite(r)) return '';
    if (r >= 0.95 && r <= 1.05) return '예상과 비슷';
    return '예상의 ' + r.toFixed(1) + '배';
  }
  function measureText(m) {
    if (m.type === 'fixed') return '늘 ' + m.amount + m.unit;
    if (m.type === 'count') return m.unit + ' 수를 셈';
    return '셀 수 없음 (그날 예상과 비교)';
  }
  function findRoutine(id) { return state.routines.find((r) => r.id === id) || null; }
  function findBlock(id) { return state.blocks.find((b) => b.id === id) || null; }
  function hasAnyData() { return state.blocks.length || state.routines.length || state.records.length || state.active; }

  /* 시작 신호를 "~하면" 문장으로 */
  function anchorPhrase(r) {
    const a = r.anchor;
    if (!a) return '빈 시간 아무 때나';
    if (a.type === 'time') return a.time + '이 되면';
    if (a.type === 'block') { const b = findBlock(a.blockId); return b ? q(b.name) + ' 끝나면' : '빈 시간 아무 때나'; }
    if (a.type === 'routine') { const x = findRoutine(a.routineId); return x ? q(x.name) + ' 끝내면' : '빈 시간 아무 때나'; }
    if (a.type === 'situation') return q(a.label) + ' 상황이 되면';
    if (a.type === 'dayoff') return '쉬는 날이면';
    return '빈 시간 아무 때나';
  }

  /* 시작 지연 문장의 기준점: "‘자료구조’ 끝" / "22:00" / "‘집 도착’" */
  function anchorLabel(r) {
    const a = r.anchor;
    if (!a) return '시작 신호';
    if (a.type === 'time') return a.time;
    if (a.type === 'block') { const b = findBlock(a.blockId); return b ? q(b.name) + ' 끝' : '시작 신호'; }
    if (a.type === 'routine') { const x = findRoutine(a.routineId); return x ? q(x.name) + ' 끝' : '시작 신호'; }
    if (a.type === 'situation') return q(a.label);
    return '시작 신호';
  }

  // ---------- 상태 안내 ----------
  /* action: { label, onclick } — 예: 지운 기록 되돌리기 */
  function showStatus(kind, title, body, action) {
    // 설정 창이 열려 있으면 창 안에도 같은 안내를 보여 준다 (창 뒤의 안내는 안 보이므로)
    const sd = $('settingsDialog');
    if (sd && sd.open) {
      const box = $('settingsStatus');
      box.className = 'status ' + kind;
      box.replaceChildren(...[h('strong', null, title), body ? h('span', null, body) : null].filter(Boolean));
    }
    const el = $('status');
    el.className = 'status ' + kind;
    el.replaceChildren(...[h('strong', null, title), body ? h('span', null, body) : null,
      action ? h('span', null, h('button', { type: 'button', class: 'btn small', id: 'statusAction', onclick: action.onclick }, action.label)) : null]
      .filter(Boolean));
  }

  // ---------- 공휴일 (data/holidays.json, GitHub Actions가 매달 갱신) ----------
  const holidays = { list: [], updatedAt: null, status: 'loading' }; // status: loading | ok | empty | error

  /* 그날의 공휴일 이름과, 공휴일에 쉬는 종류를 뺀 고정 일정 */
  function dayContext(L) {
    const name = C.holidayName(holidays.list, L.day);
    const off = C.holidayOff(state.settings);
    return { holiday: name, off, blocks: C.blocksForDay(state.blocks, !!name, off) };
  }
  /* 상황 루틴 계산에 쓰는 재료 */
  function sitEnv(now) {
    return {
      blocks: state.blocks, records: state.records, events: state.events || [], holidays: holidays.list,
      off: C.holidayOff(state.settings), shift: shift(), now: now || new Date()
    };
  }
  /* 오늘의 시작 신호: 언제(plannedMin), 오늘 신호가 있는지(today).
   * 앵커 일정이 공휴일이라 쉬는 날이면 오늘은 앵커가 없는 날로 본다 */
  function anchorFor(r, L, ctx) {
    const t = r.anchor && r.anchor.type;
    if (t === 'routine' || t === 'situation' || t === 'dayoff') return C.situationToday(r, sitEnv(), L.day);
    const a = C.anchorToday(r, state.blocks, L.weekday, L.shift);
    if (ctx.holiday && a.type === 'block' && a.today && ctx.off.includes(a.block.kind)) {
      return Object.assign({}, a, { today: false, holiday: true, plannedMin: null });
    }
    return a;
  }
  function loadHolidays() {
    fetch('data/holidays.json', { cache: 'no-cache' })
      .then((res) => { if (!res.ok) throw new Error('http'); return res.json(); })
      .then((d) => {
        if (!C.validHolidays(d)) throw new Error('shape');
        holidays.list = d.holidays;
        holidays.updatedAt = d.updatedAt || null;
        holidays.status = d.holidays.length ? 'ok' : 'empty';
      })
      .catch(() => { holidays.status = 'error'; })
      .then(() => { renderToday(); renderCalendar(); renderReview(); renderHolidayInfo(); });
  }
  function holidayStatusText() {
    return {
      loading: '공휴일 정보를 불러오는 중이에요.',
      ok: '공휴일 정보: 한국천문연구원 특일 정보 · ' + (holidays.updatedAt || '') + ' 갱신',
      empty: '공휴일 정보가 아직 없어요. 저장소에 공공데이터포털 인증키를 넣으면 GitHub Actions가 받아 와요.',
      error: '공휴일 정보를 불러오지 못했어요. index.html을 파일로 열면 불러올 수 없고, 배포된 주소에서는 자동으로 반영돼요.'
    }[holidays.status];
  }
  function renderHolidayInfo() {
    const el = $('holidayInfo');
    if (el) el.textContent = holidayStatusText();
  }

  // ========== 캘린더 ==========
  /* 주 보기(기본): 시간표처럼 고정 일정(회색)·한 루틴(루틴 색)·할 차례(점선). 월 보기: 공휴일과 기록한 날.
   * 아래에는 매주 반복되는 고정 일정 목록 (예전 주간 틀) */
  function renderCalendar() {
    const box = $('calendarDyn');
    if (!box) return;
    const L = nowL();
    const todayKey = C.dayKey(L.day);
    if (!ui.calSel) ui.calSel = todayKey;
    const byDay = {};
    state.records.forEach((r) => { const k = C.logicalKey(r.startedAt, L.shift); (byDay[k] = byDay[k] || []).push(r); });
    const hmap = {};
    holidays.list.forEach((x) => { hmap[x.date] = x.name; });

    const setView = (v) => { ui.calView = v; renderCalendar(); const b = document.querySelector('.view-toggle [aria-pressed="true"]'); if (b) b.focus(); };
    const toggle = h('div', { class: 'view-toggle', role: 'group', 'aria-label': '보기' },
      h('button', { type: 'button', 'aria-pressed': String(ui.calView === 'week'), onclick: () => setView('week') }, '주'),
      h('button', { type: 'button', 'aria-pressed': String(ui.calView === 'month'), onclick: () => setView('month') }, '월'));

    const nodes = [h('h2', { class: 'sr-only' }, '캘린더')];
    if (ui.calView === 'month') nodes.push(monthView(L, todayKey, byDay, hmap, toggle));
    else nodes.push(...weekView(L, todayKey, byDay, hmap, toggle));
    nodes.push(calendarDay(ui.calSel, hmap, byDay));
    nodes.push(blockList());
    box.replaceChildren(...nodes);
  }

  function monthView(L, todayKey, byDay, hmap, toggle) {
    if (!ui.calMonth) ui.calMonth = new Date(L.day.getFullYear(), L.day.getMonth(), 1);
    const y = ui.calMonth.getFullYear(), mo = ui.calMonth.getMonth();
    const first = new Date(y, mo, 1);
    const gridStart = C.addDays(first, -C.mondayIndex(first));
    const weeks = Math.ceil((C.mondayIndex(first) + new Date(y, mo + 1, 0).getDate()) / 7);
    const move = (n) => { ui.calMonth = new Date(y, mo + n, 1); renderCalendar(); };
    const head = h('div', { class: 'cal-head' }, toggle,
      h('div', { class: 'cal-nav' },
        h('button', { type: 'button', class: 'icon-btn', onclick: () => move(-1), 'aria-label': '이전 달' }, svgIcon(ICON_BACK)),
        h('h3', { id: 'calTitle', 'aria-live': 'polite' }, y + '년 ' + (mo + 1) + '월'),
        h('button', { type: 'button', class: 'icon-btn', onclick: () => move(1), 'aria-label': '다음 달' }, svgIcon(ICON_NEXT))),
      h('button', { type: 'button', class: 'btn small', onclick: () => { ui.calMonth = null; ui.calSel = null; renderCalendar(); } }, '오늘'));

    const rows = [];
    for (let w = 0; w < weeks; w++) {
      rows.push(h('tr', null, [0, 1, 2, 3, 4, 5, 6].map((i) => {
        const d = C.addDays(gridStart, w * 7 + i);
        const k = C.dayKey(d);
        const hol = hmap[k];
        const recs = byDay[k] || [];
        const routines = [...new Set(recs.filter((r) => r.routineId && C.countsAsDone(r)).map((r) => r.routineId))].map(findRoutine).filter(Boolean);
        const tasks = recs.filter((r) => r.kind === 'task').length;
        const label = (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + C.DAY_NAMES[d.getDay()] + '요일' +
          (hol ? ', ' + hol : '') + (recs.length ? ', 기록 ' + recs.length + '개' : '') + (k === todayKey ? ', 오늘' : '');
        return h('td', null, h('button', {
          type: 'button',
          class: 'cal-day' + (d.getMonth() === mo ? '' : ' out') + (k === todayKey ? ' today' : '') +
            (k === ui.calSel ? ' sel' : '') + (hol || d.getDay() === 0 ? ' red' : ''),
          'aria-pressed': String(k === ui.calSel), 'aria-label': label,
          onclick: () => {
            ui.calSel = k;
            if (d.getMonth() !== mo) ui.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
            renderCalendar();
            const again = document.querySelector('.cal-day.sel');
            if (again) again.focus();
          }
        },
        h('span', { class: 'cal-num', 'aria-hidden': 'true' }, String(d.getDate())),
        hol ? h('span', { class: 'cal-hol', 'aria-hidden': 'true' }, hol) : null,
        routines.length || tasks ? h('span', { class: 'cal-dots', 'aria-hidden': 'true' },
          routines.slice(0, 4).map((r) => h('i', { class: rc(r) })), tasks ? h('i', { class: 'task' }) : null) : null));
      })));
    }
    const table = h('table', { class: 'cal' },
      h('caption', { class: 'sr-only' }, y + '년 ' + (mo + 1) + '월 달력'),
      h('thead', null, h('tr', null, DAY_ORDER.map((d) => h('th', { scope: 'col', class: d === 0 ? 'red' : '' }, C.DAY_NAMES[d])))),
      h('tbody', null, rows));
    return h('section', { class: 'card', 'aria-labelledby': 'calTitle' }, head, table,
      h('div', { class: 'legend' }, h('span', { class: 'lg-hol' }, '공휴일'), h('span', { class: 'lg-dot' }, '한 루틴(루틴 색)'), h('span', { class: 'lg-task' }, '다른 활동')),
      holidays.status === 'ok' ? null : h('p', { class: 'hint' }, holidayStatusText()));
  }

  /* 그 주 각 날의 할 차례(아직 안 한 루틴): 시각 루틴은 그 시각, 고정 일정이 끝나면은 그 끝, 다른 루틴을 끝내면은 그 뒤.
   * 쉬는 날이면은 종일 칸. 아무 때나·내가 알려 주는 상황은 시각을 알 수 없어 그리지 않는다 */
  function plannedFor(d, dayBl, isOff) {
    const L = nowL();
    const out = [], allDay = [];
    const notDone = (r) => !C.doneOn(state.records, r.id, d, L.shift);
    state.routines.forEach((r) => {
      const a = r.anchor;
      if (!a || !notDone(r)) return;
      if (a.type === 'time') {
        if (C.scheduleOf(r) === 'days' && !r.days.includes(d.getDay())) return;
        if (C.scheduleOf(r) === 'weekly') return;
        const t = C.toMin(a.time);
        out.push({ r, start: t < L.shift ? t + 1440 : t, len: r.baseMin });
      } else if (a.type === 'block') {
        const b = dayBl.find((x) => x.id === a.blockId);
        if (b) out.push({ r, start: C.toMin(b.end) + state.settings.bufferMin, len: r.baseMin });
      } else if (a.type === 'dayoff' && isOff) allDay.push(r);
    });
    // 다른 루틴을 끝내면: 그 루틴의 할 차례 바로 뒤
    state.routines.forEach((r) => {
      const a = r.anchor;
      if (!a || a.type !== 'routine' || !notDone(r)) return;
      const prev = out.find((p) => p.r.id === a.routineId);
      if (prev) out.push({ r, start: prev.start + prev.len, len: r.baseMin });
    });
    return { out, allDay };
  }

  function weekView(L, todayKey, byDay, hmap, toggle) {
    if (!ui.calWeek) ui.calWeek = C.startOfWeek(L.day);
    const ws = ui.calWeek;
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => C.addDays(ws, i));
    // 고른 날이 이 주 밖이면 이 주의 오늘(없으면 월요일)로
    const keys = days.map(C.dayKey);
    if (!keys.includes(ui.calSel)) ui.calSel = keys.includes(todayKey) ? todayKey : keys[0];
    const off = C.holidayOff(state.settings);
    const s = state.settings;
    // 보이는 시간: 하루 시작~끝 (고정 일정이 밖에 있으면 넓힌다)
    let ds = C.toMin(s.dayStart), de = C.dayEndMin(s);
    state.blocks.forEach((b) => { ds = Math.min(ds, C.toMin(b.start)); de = Math.max(de, C.toMin(b.end)); });
    ds = Math.floor(ds / 60) * 60; de = Math.ceil(de / 60) * 60;
    const PX = 34;
    const y = (m) => (Math.min(Math.max(m, ds), de) - ds) / 60 * PX;
    const H = (de - ds) / 60 * PX;

    const move = (n) => { ui.calWeek = C.addDays(ws, 7 * n); renderCalendar(); };
    const last = days[6];
    const title = (ws.getMonth() + 1) + '월 ' + ws.getDate() + '일 – ' + (last.getMonth() !== ws.getMonth() ? (last.getMonth() + 1) + '월 ' : '') + last.getDate() + '일';
    const head = h('div', { class: 'cal-head' }, toggle,
      h('div', { class: 'cal-nav' },
        h('button', { type: 'button', class: 'icon-btn', onclick: () => move(-1), 'aria-label': '이전 주' }, svgIcon(ICON_BACK)),
        h('h3', { id: 'calTitle', 'aria-live': 'polite' }, title),
        h('button', { type: 'button', class: 'icon-btn', onclick: () => move(1), 'aria-label': '다음 주' }, svgIcon(ICON_NEXT))),
      h('button', { type: 'button', class: 'btn small', onclick: () => { ui.calWeek = null; ui.calSel = null; renderCalendar(); } }, '오늘'));

    const heads = [], lanes = [], cols = [];
    let anyAllDay = false;
    days.forEach((d) => {
      const k = C.dayKey(d);
      const hol = hmap[k];
      const dayBl = C.dayBlocks(C.blocksForDay(state.blocks, !!hol, off), d.getDay());
      const isOff = !!hol || dayBl.length === 0;
      heads.push(h('button', {
        type: 'button', class: 'wk-day' + (k === todayKey ? ' today' : '') + (k === ui.calSel ? ' sel' : '') + (hol || d.getDay() === 0 ? ' red' : ''),
        'aria-pressed': String(k === ui.calSel), title: hol || null,
        'aria-label': (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + C.DAY_NAMES[d.getDay()] + '요일' + (hol ? ', ' + hol : '') + (k === todayKey ? ', 오늘' : '') + ' 자세히 보기',
        onclick: () => { ui.calSel = k; renderCalendar(); const b = document.querySelector('.wk-day.sel'); if (b) b.focus(); }
      }, h('span', null, C.DAY_NAMES[d.getDay()]), h('b', null, String(d.getDate()))));

      const items = [];
      // 고정 일정 (공휴일에 쉬는 종류는 뺌)
      dayBl.forEach((b) => {
        const top = y(C.toMin(b.start)), hh = y(C.toMin(b.end)) - top;
        items.push(h('button', {
          type: 'button', class: 'ev fixed ' + kindClass(b.kind), style: 'top:' + top + 'px;height:' + Math.max(6, hh - 1) + 'px',
          title: b.name + ' ' + b.start + '–' + b.end, 'aria-label': C.DAY_NAMES[d.getDay()] + '요일 ' + b.name + ' ' + b.start + '–' + b.end + ', 고정 일정 고치기',
          onclick: () => editBlock(b.id)
        }, hh >= 28 ? h('span', { 'aria-hidden': 'true' }, b.name) : null));
      });
      // 한 기록
      (byDay[k] || []).forEach((r) => {
        const st = (Date.parse(r.startedAt) - d.getTime()) / 60000;
        const top = y(st), hh = y(st + r.actualMin) - top;
        const routine = r.routineId ? findRoutine(r.routineId) : null;
        const label = clockText(r.startedAt) + ' ' + r.name + ' ' + r.actualMin + '분' + (C.countsAsDone(r) ? '' : ' (최소 미만)');
        items.push(h(routine ? 'button' : 'span', {
          type: routine ? 'button' : null,
          class: 'ev rec ' + (routine ? rc(routine) : 'task') + (C.countsAsDone(r) ? '' : ' short'),
          style: 'top:' + top + 'px;height:' + Math.max(7, hh - 1) + 'px', title: label,
          'aria-label': routine ? label + ', 루틴 자세히 보기' : null,
          onclick: routine ? () => openRoutine(routine.id) : null
        }, hh >= 20 ? h('span', { 'aria-hidden': 'true' }, r.name) : null));
      });
      // 할 차례 (오늘과 그 뒤)
      let allDay = [];
      if (k >= todayKey) {
        const p = plannedFor(d, dayBl, isOff);
        allDay = p.allDay;
        p.out.forEach((x) => {
          const top = y(x.start), hh = y(x.start + x.len) - top;
          if (hh <= 0) return;
          items.push(h('button', {
            type: 'button', class: 'ev plan ' + rc(x.r), style: 'top:' + top + 'px;height:' + Math.max(7, hh - 1) + 'px',
            title: C.fmtHM(x.start) + ' ' + x.r.name + ' 할 차례', 'aria-label': C.DAY_NAMES[d.getDay()] + '요일 ' + C.fmtHM(x.start) + ' ' + x.r.name + ' 할 차례, 루틴 자세히 보기',
            onclick: () => openRoutine(x.r.id)
          }, hh >= 20 ? h('span', { 'aria-hidden': 'true' }, x.r.name) : null));
        });
      }
      if (allDay.length) anyAllDay = true;
      lanes.push(h('div', { class: 'wk-lane' }, allDay.map((r) => h('button', {
        type: 'button', class: 'ev-all ' + rc(r), title: r.name + ' · 쉬는 날이면', onclick: () => openRoutine(r.id),
        'aria-label': C.DAY_NAMES[d.getDay()] + '요일 ' + r.name + ' 할 차례 (쉬는 날), 루틴 자세히 보기'
      }, r.name))));
      if (k === todayKey && L.nowMin >= ds && L.nowMin <= de) items.push(h('span', { class: 'wk-now', style: 'top:' + y(L.nowMin) + 'px', 'aria-hidden': 'true' }));
      cols.push(h('div', { class: 'wk-col' + (k === todayKey ? ' today' : ''), style: 'height:' + H + 'px;background-size:100% ' + PX + 'px' }, items));
    });
    const hours = [];
    for (let m = ds + 60; m < de; m += 120) hours.push(h('span', { style: 'top:' + (y(m) - 7) + 'px' }, String(Math.floor(m / 60) % 24)));

    const grid = h('section', { class: 'card wk', 'aria-labelledby': 'calTitle' }, head,
      h('div', { class: 'wk-grid' },
        h('span', { 'aria-hidden': 'true' }), heads,
        anyAllDay ? [h('span', { class: 'wk-allday-h', 'aria-hidden': 'true' }, '종일'), ...lanes] : null,
        h('div', { class: 'wk-hours', style: 'height:' + H + 'px', 'aria-hidden': 'true' }, hours), cols));
    const legend = h('div', { class: 'legend wk-legend', 'aria-hidden': 'true' },
      h('span', { class: 'lg-block' }, '고정 일정'), h('span', { class: 'lg-rec' }, '한 루틴(루틴 색)'),
      h('span', { class: 'lg-plan' }, '할 차례'), h('span', { class: 'lg-task' }, '다른 활동'), h('span', { class: 'lg-now' }, '지금'));
    grid.append(legend,
      h('p', { class: 'sub' }, '칸을 누르면 그 루틴이나 고정 일정이 열려요. 날짜를 누르면 그날을 아래에서 자세히 봐요.'),
      holidays.status === 'ok' ? null : h('p', { class: 'hint' }, holidayStatusText()));
    return [grid];
  }

  /* 매주 반복되는 고정 일정 목록 (예전 주간 틀). 이걸 빼고 남는 시간이 빈 시간 */
  function blockList() {
    const sec = h('section', { class: 'card', 'aria-labelledby': 'blocksH' },
      h('div', { class: 'section-head' }, h('h3', { id: 'blocksH' }, '고정 일정' + (state.blocks.length ? ' ' + state.blocks.length + '개' : '')),
        h('span', { class: 'sub' }, '매주 반복 · 빼고 남는 시간이 빈 시간')));
    if (!state.blocks.length) {
      sec.append(h('p', { class: 'sub' }, '수업, 통학, 알바처럼 내가 옮길 수 없는 일정을 넣어 보세요.'));
    } else {
      const sorted = state.blocks.slice().sort((a, b) =>
        (KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)) || C.toMin(a.start) - C.toMin(b.start));
      sec.append(h('ul', { class: 'plain blist' }, sorted.map((b) => {
        const anchored = state.routines.filter((r) => r.anchor && r.anchor.type === 'block' && r.anchor.blockId === b.id);
        return h('li', { id: 'bc-' + b.id, class: 'brow' },
          h('span', { class: 'bsq ' + kindClass(b.kind), 'aria-hidden': 'true' }),
          h('span', { class: 'bmain' }, h('b', null, b.name), ' ', h('span', { class: 'sub' }, b.kind + ' · ' + daysText(b.days) + ' ', h('span', { class: 'num' }, b.start + '–' + b.end)),
            anchored.length ? h('span', { class: 'sub bsig' }, '끝나면 → ' + anchored.map((r) => r.name).join(', ')) : null),
          pencilBtn(q(b.name) + ' 고치기', () => editBlock(b.id)));
      })));
    }
    sec.append(h('button', { type: 'button', class: 'new-btn', id: 'btnNewBlock', onclick: openNewBlock }, '+ 고정 일정 넣기'));
    return sec;
  }

  /* 고정 일정 넣기: 빈 폼을 화면 위 창으로 */
  function openNewBlock() {
    if (ui.tab !== 'calendar') switchTab('calendar');
    resetBlockForm();
    openEditDialog('blockForm', '고정 일정 넣기', () => $('btnNewBlock') || $('tab-calendar'), resetBlockForm);
    $('bCancel').hidden = false;
    $('bCancel').textContent = '취소';
  }

  /* 고른 날: 공휴일, 그날 고정 일정(공휴일에 쉬는 것 표시), 그날 기록 */
  function calendarDay(key, hmap, byDay) {
    const d = new Date(key + 'T00:00:00');
    const hol = hmap[key];
    const off = C.holidayOff(state.settings);
    const blocks = C.dayBlocks(state.blocks, d.getDay());
    const recs = (byDay[key] || []).slice().sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    return h('section', { class: 'card', 'aria-labelledby': 'calDayH' },
      h('h3', { id: 'calDayH' }, (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + C.DAY_NAMES[d.getDay()] + '요일',
        hol ? h('span', { class: 'pill holiday' }, hol) : null),
      h('div', { class: 'obs' }, h('span', { class: 'label' }, '고정 일정'),
        blocks.length
          ? h('ul', { class: 'plain' }, blocks.map((b) => {
            const skip = hol && off.includes(b.kind);
            return h('li', { class: 'gap-row' + (skip ? ' past' : '') },
              h('span', null, h('span', { class: 'num' }, b.start + '–' + b.end), ' ' + b.name),
              h('span', null, skip ? '공휴일이라 쉼' : b.kind));
          }))
          : h('p', { class: 'sub' }, '고정 일정이 없는 날이에요.')),
      h('div', { class: 'obs' }, h('span', { class: 'label' }, '기록'),
        recs.length
          ? h('ul', { class: 'plain' }, recs.map((r) => h('li', { class: 'gap-row' },
            h('span', null, h('span', { class: 'dot rc ' + (r.routineId && findRoutine(r.routineId) ? rc(findRoutine(r.routineId)) : 'task'), 'aria-hidden': 'true' }), ' ', h('span', { class: 'num' }, clockText(r.startedAt)), ' ' + r.name + (r.version === 'min' ? ' (최소)' : '') + (C.countsAsDone(r) ? '' : ' (최소 미만)')),
            h('span', { class: 'num' }, r.actualMin + '분'))))
          : h('p', { class: 'sub' }, '이날 기록이 없어요.')));
  }

  function bindHolidayForm() {
    $('holidayForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const off = [...document.querySelectorAll('input[name="sHolidayOff"]:checked')].map((el) => el.value);
      state.settings = Object.assign({}, state.settings, { holidayOff: off });
      if (commit()) showStatus('info', '공휴일 설정을 저장했어요.', off.length ? '공휴일에는 ' + off.join('·') + ' 일정을 빼고 계산해요.' : '공휴일에도 모든 고정 일정을 그대로 계산해요.');
      renderAll();
    });
  }

  /* 앱 안의 지금: 하루 끝이 자정을 넘기면 그 전까지는 전날로 본다 */
  function nowL() { return C.logical(new Date(), state.settings); }
  function shift() { return C.rolloverMin(state.settings); }
  function dayChoices() {
    const L = nowL();
    return [0, 1, 2].map((i) => {
      const d = C.addDays(L.day, -i);
      return { value: String(i), label: ['오늘', '어제', '그저께'][i] + ' (' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + C.DAY_NAMES[d.getDay()] + ')', day: d };
    });
  }
  /* 직접 입력 기록의 시각: 오늘이면 지금 끝난 것으로, 지난 날이면 그날 정오에 시작한 것으로 */
  function manualSpan(daysAgo, actual) {
    if (!daysAgo) {
      const end = new Date();
      return { startedAt: new Date(end.getTime() - actual * 60000).toISOString(), endedAt: end.toISOString() };
    }
    const start = C.atMinutes(C.addDays(nowL().day, -daysAgo), 12 * 60);
    return { startedAt: start.toISOString(), endedAt: new Date(start.getTime() + actual * 60000).toISOString() };
  }
  function clearStatus() { const el = $('status'); el.className = 'status'; el.replaceChildren(); }

  /* 저장. 실패하면 오류 상태로 안내하고 false */
  function commit() {
    if (S.save(state)) return true;
    showStatus('error', '저장하지 못했어요.',
      '사생활 보호 모드라면 일반 창에서 열어 주세요. 저장 공간이 가득 찼을 수도 있어요. 지금 바뀐 내용은 이 창을 닫으면 사라져요.');
    return false;
  }

  // ---------- 입력 오류 ----------
  function setErr(id, msg, errId) {
    const input = $(id);
    const err = $(errId || id + 'Err');
    if (err) err.textContent = msg || '';
    if (input) {
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    return msg ? id : null;
  }
  function clearErrs(root) {
    root.querySelectorAll('.err').forEach((e) => { e.textContent = ''; });
    root.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
  }
  /* 오류가 난 칸 중 화면에 보이는 첫 칸으로 초점 (아직 펼쳐지지 않은 단계의 칸은 건너뜀) */
  function focusFirst(ids) {
    const list = ids.filter(Boolean);
    if (!list.length) return false;
    const targetOf = (id) => { const el = $(id); return el.matches('input, select, textarea, button') ? el : el.querySelector('input, select, textarea'); };
    const visible = list.map(targetOf).find((t) => t && t.getClientRects().length > 0);
    const target = visible || targetOf(list[0]);
    if (target) target.focus();
    return true;
  }
  function emptyBox(title, body, action) {
    return h('div', { class: 'empty' }, h('strong', null, title), h('p', null, body), action || null);
  }

  // ---------- 탭 ----------
  function switchTab(name, focusId) {
    if (!TABS.includes(name)) name = 'today';
    ui.tab = name;
    TABS.forEach((t) => {
      const on = t === name;
      const tab = $('tab-' + t);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $('panel-' + t).hidden = !on;
    });
    setHash();
    if (name === 'today') renderToday();
    if (name === 'routines') renderRoutines();
    if (name === 'calendar') renderCalendar();
    if (focusId) {
      const el = $(focusId);
      if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
    }
  }

  function setHash() {
    const want = ui.tab === 'routines' && ui.routine ? 'routine-' + ui.routine : ui.tab;
    try { if (location.hash !== '#' + want) history.replaceState(null, '', '#' + want); } catch (e) { /* file:// 등 */ }
  }
  function routineFromHash(hash) {
    return hash.startsWith('routine-') && findRoutine(hash.slice(8)) ? hash.slice(8) : null;
  }

  function bindTabs() {
    const tabs = TABS.map((t) => $('tab-' + t));
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => {
        if (TABS[i] === 'routines' && ui.routine) { ui.routine = null; if (ui.panel && ui.panel.where === 'routines') ui.panel = null; }
        switchTab(TABS[i]);
      });
      tab.addEventListener('keydown', (ev) => {
        let next = null;
        if (ev.key === 'ArrowRight') next = (i + 1) % TABS.length;
        else if (ev.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
        else if (ev.key === 'Home') next = 0;
        else if (ev.key === 'End') next = TABS.length - 1;
        if (next === null) return;
        ev.preventDefault();
        switchTab(TABS[next]);
        tabs[next].focus();
      });
    });
    window.addEventListener('hashchange', () => {
      const name = location.hash.slice(1);
      const rid = routineFromHash(name);
      if (rid) { if (rid !== ui.routine || ui.tab !== 'routines') openRoutine(rid); return; }
      if (name === 'week') { switchTab('calendar'); return; }
      if (TABS.includes(name) && name !== ui.tab) switchTab(name);
    });
  }

  // ---------- 전체 다시 그리기 ----------
  function renderAll() {
    renderCategories();
    renderActive();
    renderToday();
    renderRoutines();
    renderCalendar();
    renderReview();
    syncAnchorBlocks();
    fillSettingsForm();
    updateTaskHint();
    $('sampleBox').hidden = !!hasAnyData();
  }

  function renderCategories() {
    const set = new Set(BASE_CATEGORIES);
    state.routines.forEach((r) => set.add(r.category));
    state.records.forEach((r) => set.add(r.category));
    $('categoryList').replaceChildren(...[...set].map((c) => h('option', { value: c })));
  }

  // ========== 하는 중 ==========
  function renderActive() {
    const a = state.active;
    $('active').hidden = !a;
    clearInterval(timerTick);
    timerTick = null;
    lastAnnounced = -1;
    if (!a) {
      $('finishForm').hidden = true;
      $('abandonConfirm').hidden = true;
      $('activeButtons').hidden = false;
      return;
    }
    $('activeKind').textContent = a.kind === 'routine' ? '하는 중 · 루틴' : '하는 중 · 다른 활동';
    $('activeTitle').textContent = a.name;
    const bits = [a.category, '예상 ' + a.estimateMin + '분', clockText(a.startedAt) + ' 시작'];
    if (a.minMin) bits.push('최소 ' + a.minMin + '분');
    // 막대 위 최소 시간 눈금: 여기를 넘기면 한 번으로 센다
    const tick = $('progressMin');
    tick.hidden = !a.minMin;
    if (a.minMin) tick.style.left = Math.min(100, a.minMin / a.estimateMin * 100) + '%';
    $('shortConfirm').hidden = true;
    const delay = C.delayMinutes(a.plannedStartAt, a.startedAt);
    if (delay != null) bits.push('앵커 ' + delay + '분 뒤 시작');
    $('activeMeta').textContent = bits.join(' · ');
    stepTimer();
    timerTick = setInterval(stepTimer, 1000);
  }

  function stepTimer() {
    const a = state.active;
    if (!a) return;
    const ms = Math.max(0, Date.now() - Date.parse(a.startedAt));
    const total = Math.floor(ms / 1000);
    const hh = Math.floor(total / 3600), mm = Math.floor((total % 3600) / 60), ss = total % 60;
    $('timer').textContent = (hh ? hh + ':' : '') + C.pad(mm) + ':' + C.pad(ss);
    const frac = ms / (a.estimateMin * 60000);
    $('progressBar').style.width = Math.min(100, frac * 100) + '%';
    $('progress').classList.toggle('over', frac > 1);
    $('progress').classList.toggle('past-min', !!a.minMin && ms >= a.minMin * 60000);
    const mins = Math.floor(ms / 60000);
    if (mins !== lastAnnounced) {
      lastAnnounced = mins;
      // 화면 읽기 프로그램에는 1분 단위로만 알린다
      $('timerLive').textContent = mins === 0 ? '' : mins + '분 지났어요' + (frac > 1 ? '. 예상 시간을 넘겼어요' : '');
    }
  }

  function needsForFinish() {
    const a = state.active;
    const r = a && a.kind === 'routine' ? findRoutine(a.routineId) : null;
    const elapsed = C.diffMin(a.startedAt, new Date());
    return {
      routine: r,
      amount: !!(r && r.measure.type === 'count'),
      actual: C.looksTooLong(a.estimateMin, elapsed),
      elapsed: Math.max(1, Math.round(elapsed))
    };
  }

  /* 최소 시간보다 짧게 끝내려 하면 한 번 묻는다. 그래도 끝내면 기록은 남고 횟수·연속에는 세지 않는다 */
  function onFinishClick() {
    const a = state.active;
    if (!a) return;
    const elapsed = C.diffMin(a.startedAt, new Date());
    if (a.minMin && elapsed < a.minMin) {
      $('shortText').textContent = '아직 최소 ' + a.minMin + '분이 안 됐어요 (지금 ' + Math.max(1, Math.floor(elapsed)) + '분). ' +
        '지금 끝내면 기록은 남지만 이번 횟수와 연속에는 세지 않아요.';
      $('activeButtons').hidden = true;
      $('shortConfirm').hidden = false;
      $('btnShortNo').focus();
      return;
    }
    proceedFinish();
  }
  function proceedFinish() {
    $('shortConfirm').hidden = true;
    const need = needsForFinish();
    if (!need.amount && !need.actual) { finish({}); return; }
    clearErrs($('finishForm'));
    $('finishAmount').value = '';
    $('finishActual').value = need.actual ? String(need.elapsed) : '';
    if (need.actual) {
      $('finishActualHint').textContent = '타이머로는 ' + C.fmtDuration(need.elapsed) + '이에요. 예상(' + state.active.estimateMin +
        '분)보다 꽤 길어요. 타이머를 늦게 껐다면 실제로 걸린 시간으로 고쳐 주세요. 맞으면 그대로 저장하면 돼요.';
    }
    $('finishAmountField').hidden = !need.amount;
    $('btnSkipAmount').hidden = !need.amount;
    $('finishActualField').hidden = !need.actual;
    if (need.amount) $('finishAmountLabel').textContent = '오늘 몇 ' + need.routine.measure.unit + ' 했어요?';
    $('activeButtons').hidden = true;
    $('finishForm').hidden = false;
    $(need.amount ? 'finishAmount' : 'finishActual').focus();
  }

  function onFinishSubmit(ev, skipAmount) {
    if (ev) ev.preventDefault();
    const need = needsForFinish();
    clearErrs($('finishForm'));
    const errs = [];
    if (need.amount && !skipAmount) errs.push(setErr('finishAmount', C.checkAmount($('finishAmount').value)));
    if (need.actual) errs.push(setErr('finishActual', C.checkMinutes($('finishActual').value)));
    if (focusFirst(errs)) return;
    finish({
      amount: need.amount && !skipAmount ? Number($('finishAmount').value) : null,
      actual: need.actual ? Number($('finishActual').value) : null
    });
  }

  /* 늘 같은 분량인 루틴은 끝내면 그 분량을 한 것으로 본다 */
  function amountFor(routine, entered) {
    if (!routine) return null;
    if (routine.measure.type === 'count') return entered || null;
    if (routine.measure.type === 'fixed') return routine.measure.amount;
    return null;
  }
  /* 기록에 남길 최소 시간: 늘 같은 분량인 루틴은 분량을 끝내면 한 번이라 시간으로 세지 않는다 */
  function minFor(routine) { return routine && routine.measure.type !== 'fixed' ? routine.minMin : null; }

  function finish(opts) {
    const a = state.active;
    if (!a) return;
    const end = new Date();
    const routine = a.kind === 'routine' ? findRoutine(a.routineId) : null;
    const actual = opts.actual != null ? opts.actual : C.actualMinutes(a.startedAt, end);
    // 실제 시간을 고쳤다면 끝난 시각도 시작 + 실제 시간으로 맞춘다. 시작 시각은 그대로라 시작 지연은 유지
    const endedAt = opts.actual != null ? new Date(Date.parse(a.startedAt) + actual * 60000) : end;
    const rec = {
      id: a.id, kind: a.kind, routineId: a.routineId || null, name: a.name, category: a.category,
      version: a.version || null, estimateMin: a.estimateMin, actualMin: actual,
      amount: amountFor(routine, opts.amount),
      plannedStartAt: a.plannedStartAt || null,
      startedAt: a.startedAt, endedAt: endedAt.toISOString(), source: 'timer'
    };
    if (a.minMin) rec.minMin = a.minMin;
    state.records.push(rec);
    state.active = null;
    if (commit()) showStatus('info', q(rec.name) + ' 기록했어요. 실제 ' + actual + '분 걸렸어요.', recordSummary(rec, routine));
    renderAll();
    afterActiveEnds();
  }

  function recordSummary(rec, routine) {
    const bits = [];
    if (!C.countsAsDone(rec)) bits.push('최소 ' + rec.minMin + '분보다 짧아서 이번 횟수와 연속에는 세지 않았어요');
    if (routine && C.isSituation(routine)) {
      const wk = C.situationWeek(routine, sitEnv());
      bits.push(sitWeekText(wk.occ, wk.hit));
    } else if (routine) {
      const done = C.weekDone(state.records, routine.id, new Date(), shift());
      const target = weekTarget(routine);
      bits.push(done >= target ? '이번 주 목표를 채웠어요 (' + done + '일)' : '이번 주 ' + done + '/' + target);
    }
    if (routine) {
      const st = C.streak(routine, sitEnv());
      if (st.current > 0) bits.push('연속 ' + st.current + st.unit);
    }
    if (rec.amount && routine && routine.measure.type === 'count') bits.push('1' + routine.measure.unit + '당 ' + C.round1(rec.actualMin / rec.amount) + '분');
    if (!routine || routine.measure.type === 'none') bits.push('예상 ' + rec.estimateMin + '분 → 실제 ' + rec.actualMin + '분 (' + ratioText(rec.actualMin / rec.estimateMin) + ')');
    return bits.join(' · ');
  }

  function afterActiveEnds() {
    if (ui.tab === 'today') { const t = $('todayH'); if (t) t.focus(); }
    else if (ui.tab === 'routines' && $('rdTitle')) $('rdTitle').focus();
    else $('tab-' + ui.tab).focus();
  }

  function blockedByActive(errElId) {
    const msg = '진행 중인 일을 먼저 끝내 주세요';
    if (errElId) $(errElId).textContent = msg;
    showStatus('error', msg + '.', q(state.active.name) + '이(가) 진행 중이에요. 끝내거나 그만둔 뒤 시작할 수 있어요.');
    $('btnFinish').focus();
  }

  function bindActive() {
    $('btnFinish').addEventListener('click', onFinishClick);
    $('finishForm').addEventListener('submit', (ev) => onFinishSubmit(ev, false));
    $('btnSkipAmount').addEventListener('click', () => onFinishSubmit(null, true));
    $('btnShortNo').addEventListener('click', () => {
      $('shortConfirm').hidden = true;
      $('activeButtons').hidden = false;
      $('btnFinish').focus();
    });
    $('btnShortYes').addEventListener('click', proceedFinish);
    $('btnFinishBack').addEventListener('click', () => {
      $('finishForm').hidden = true;
      $('activeButtons').hidden = false;
      $('btnFinish').focus();
    });
    $('btnAbandon').addEventListener('click', () => {
      $('activeButtons').hidden = true;
      $('abandonConfirm').hidden = false;
      $('btnAbandonNo').focus();
    });
    $('btnAbandonNo').addEventListener('click', () => {
      $('abandonConfirm').hidden = true;
      $('activeButtons').hidden = false;
      $('btnAbandon').focus();
    });
    $('btnAbandonYes').addEventListener('click', () => {
      const name = state.active ? state.active.name : '';
      state.active = null;
      if (commit()) showStatus('info', q(name) + ' 기록하지 않고 그만뒀어요.');
      renderAll();
      afterActiveEnds();
    });
  }

  // ========== 오늘 ==========
  function routineInfo(r, L, gaps, ctx) {
    const now = new Date();
    const done = C.weekDone(state.records, r.id, now, L.shift);
    const doneToday = C.doneOn(state.records, r.id, L.day, L.shift);
    const anchor = anchorFor(r, L, ctx);
    const cal = C.calibration(state.records, { routineId: r.id, category: r.category });
    const predBase = C.predict(r.baseMin, cal);
    const predMin = C.predict(r.minMin, cal);
    const pick = C.pickGap(gaps, anchor.today ? anchor.plannedMin : null, L.nowMin, state.settings.bufferMin);
    // 시작 신호가 이미 지났으면 몇 분 지났는지 (시작 지연이 지금 흐르는 중)
    const since = anchor.today && anchor.plannedMin != null && anchor.plannedMin <= L.nowMin && L.nowMin - anchor.plannedMin <= C.MAX_DELAY
      ? L.nowMin - anchor.plannedMin : null;
    const st = C.streak(r, sitEnv(now));
    const base = {
      r, doneToday, anchor, cal, predBase, predMin, pick, since, streak: st,
      // 직전 기회를 놓쳐서 지금 기회까지 놓치면 연속이 끊기는 상태 (놓쳤다는 말 대신 "이어져요"로 안내)
      missed: st.atRisk,
      fit: pick ? C.fit(predBase, predMin, pick.avail) : 'nogap'
    };
    if (C.isSituation(r)) {
      // 상황 루틴: 이번 주 목표 = 상황이 생긴 날 수, 오늘 할 일 = 오늘 상황이 생겼고 아직 안 했을 때
      const env = sitEnv(now);
      const wk = C.situationWeek(r, env);
      return Object.assign(base, {
        situation: true, done: wk.hit, target: wk.occ, tight: null,
        todo: !!anchor.today && !doneToday
      });
    }
    return Object.assign(base, {
      situation: false, done, target: weekTarget(r),
      tight: C.scheduleOf(r) === 'weekly' ? C.weekTight(r, done, doneToday, now, L.shift) : null,
      // 요일 루틴: 오늘이 그 요일이고 아직 안 했으면 / 주 N회: 이번 주 횟수를 아직 못 채웠으면
      todo: !doneToday && (C.scheduleOf(r) === 'days' ? r.days.includes(L.weekday) : done < r.perWeek)
    });
  }
  function weekText(info) {
    return info.situation ? sitWeekText(info.target, info.done) : '이번 주 ' + info.done + '/' + info.target;
  }

  /* 오늘 화면: 위에서부터 시간 막대 → 지금 → 다른 활동 기록하기 → 남은 루틴 → 고정 일정 */
  function renderToday() {
    const box = $('todayDyn');
    const L = nowL();
    const ctx = dayContext(L);
    const s = state.settings;
    const gaps = C.computeGaps(ctx.blocks, L.weekday, s, L.nowMin);
    const todays = C.dayBlocks(ctx.blocks, L.weekday);
    const infos = state.routines.map((r) => routineInfo(r, L, gaps, ctx));
    const skipped = ctx.holiday ? C.dayBlocks(state.blocks, L.weekday).filter((b) => ctx.off.includes(b.kind)) : [];
    ui.lastMinute = L.nowMin;

    const nodes = [];
    nodes.push(h('div', { class: 'today-head' },
      h('div', { class: 'day-head' },
        h('h2', { id: 'todayH', tabindex: '-1' }, (L.day.getMonth() + 1) + '월 ' + L.day.getDate() + '일 ' + C.DAY_NAMES[L.weekday] + '요일' +
          (L.nowMin >= 1440 ? ' 밤' : ''),
          ctx.holiday ? h('span', { class: 'pill holiday' }, ctx.holiday) : null),
        skipped.length ? h('p', { class: 'sub' }, '공휴일이라 ' + skipped.map((b) => q(b.name)).join(', ') + '은(는) 빼고 계산했어요.') : null),
      reviewBanner()));

    if (!state.blocks.length) {
      nodes.push(emptyBox('아직 고정 일정이 없어요.',
        '수업·통학·알바처럼 매주 같은 시간에 하는 일부터 넣어 보세요. 그걸 빼고 남는 시간이 빈 시간이 돼요.',
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn primary', onclick: openNewBlock }, '고정 일정 넣기'),
          hasAnyData() ? null : h('a', { class: 'btn ghost', href: 'intro.html' }, '처음이라면 앱 소개 보기'))));
    } else {
      nodes.push(dayCard(todays, gaps, L.nowMin, infos));
    }

    let shownId = null;
    if (!state.active && (state.blocks.length || state.routines.length)) {
      const now = nowCard(L, gaps, todays, infos);
      shownId = now.shownId;
      nodes.push(now.node);
    }
    nodes.push(h('button', { type: 'button', class: 'other-btn', id: 'btnOther', onclick: openOtherDialog }, '+ 다른 활동 기록하기'));
    const sit = situationButtons(L);
    if (sit) nodes.push(sit);
    nodes.push(todayRoutines(infos, shownId));
    if (todays.length) nodes.push(fixedChips(todays, L.nowMin));
    box.replaceChildren(...nodes);
    updateTaskHint();
  }

  /* 내가 알려 주는 상황: 상황 루틴에 쓴 상황마다 버튼. 누르면 그 시각이 상황이 생긴 시각이 된다 */
  function situationLabels() {
    return [...new Set(state.routines.filter((r) => r.anchor && r.anchor.type === 'situation').map((r) => r.anchor.label))];
  }
  function todayEvents(label, L) {
    const key = C.dayKey(L.day);
    return (state.events || []).filter((ev) => ev.label === label && C.logicalKey(ev.at, L.shift) === key);
  }
  function situationButtons(L) {
    const labels = situationLabels();
    if (!labels.length) return null;
    return h('section', { class: 'section', 'aria-labelledby': 'sitH' },
      h('h3', { id: 'sitH', class: 'muted-h' }, '지금 이런 상황이에요'),
      h('div', { class: 'sit-btns' }, labels.map((label) => {
        const evs = todayEvents(label, L);
        const on = evs.length > 0;
        return h('button', {
          type: 'button', class: 'sit-btn', 'aria-pressed': String(on),
          'aria-label': q(label) + (on ? ', 오늘 ' + clockText(evs[evs.length - 1].at) + '에 표시함. 누르면 취소' : ' 상황 표시'),
          onclick: () => toggleSituation(label)
        }, label, on ? h('span', { class: 'sit-time num' }, ' ' + clockText(evs[evs.length - 1].at)) : null);
      })));
  }
  function toggleSituation(label) {
    const L = nowL();
    const evs = todayEvents(label, L);
    if (evs.length) {
      state.events = state.events.filter((ev) => !evs.includes(ev));
      if (commit()) showStatus('info', q(label) + ' 표시를 취소했어요.');
    } else {
      state.events = (state.events || []).concat({ id: uid('e'), label, at: new Date().toISOString() });
      const linked = state.routines.filter((r) => r.anchor && r.anchor.type === 'situation' && r.anchor.label === label).map((r) => r.name);
      if (commit()) showStatus('info', q(label) + ' 상황이에요.', '연결된 루틴: ' + linked.join(', ') + '. 지금부터 시작까지 걸린 시간을 재요.');
    }
    renderToday();
    const again = [...document.querySelectorAll('.sit-btn')].find((b) => b.textContent.startsWith(label));
    if (again) again.focus();
  }

  /* 다른 활동(반복하지 않는 일) 기록하기: 입력칸을 화면 위 창으로 */
  function openOtherDialog() {
    openEditDialog('taskForm', '다른 활동 기록하기', () => (state.active ? $('activeTitle') : $('btnOther')), null);
    updateTaskHint();
  }

  const FIT_LONG = { fits: '남은 시간 안에 끝나요', min: '최소 시간만큼은 할 수 있어요', tight: '시간이 모자라요', nogap: '오늘 남은 빈 시간이 없어요' };
  const FIT_SHORT = { fits: '시간 충분', min: '최소만 가능', tight: '시간 부족', nogap: '빈 시간 없음' };

  /* 지금: 크림색 한 줄. 빈 시간이면 남은 시간에 끝낼 수 있는 루틴 하나와 시작 버튼 */
  function nowCard(L, gaps, todays, infos) {
    const s = state.settings;
    const ds = C.toMin(s.dayStart), de = C.dayEndMin(s);
    const card = h('section', { class: 'now-block', 'aria-labelledby': 'nowH' });
    const head = (text) => h('p', { id: 'nowH', class: 'now-head' }, text);
    if (L.nowMin < ds) { card.append(head('지금 · 하루 시작 전이에요 (' + s.dayStart + '부터)')); return { node: card, shownId: null }; }
    if (L.nowMin >= de) { card.append(head('지금 · 오늘 활동 시간이 끝났어요')); return { node: card, shownId: null }; }

    const inBlock = todays.find((b) => C.toMin(b.start) <= L.nowMin && L.nowMin < C.toMin(b.end));
    if (inBlock) {
      const next = infos.filter((i) => i.todo && i.anchor.type === 'block' && i.anchor.today && i.anchor.block.id === inBlock.id);
      card.append(head('지금 · ' + q(inBlock.name) + ' 시간, ' + inBlock.end + '에 끝나요'));
      if (next.length) card.append(h('p', { class: 'sub' }, '끝나면 → ' + next.map((i) => i.r.name).join(', ')));
      return { node: card, shownId: null };
    }
    const gap = gaps.find((g) => g.state === 'now');
    if (!gap) { card.append(head('지금 · 고정 일정 사이 이동 시간이에요')); return { node: card, shownId: null }; }

    card.append(head('지금 · 빈 시간, ' + C.fmtHM(gap.end) + '까지 ' + C.fmtDuration(gap.remaining)));
    if (!state.routines.length) return { node: card, shownId: null };
    const pick = infos.filter((i) => i.todo && i.predMin <= gap.remaining)
      .map((i) => Object.assign({}, i, { nowFit: i.predBase <= gap.remaining ? 'fits' : 'min' }))
      .sort((a, b) => (b.missed - a.missed) || ((b.since != null) - (a.since != null)) || (a.nowFit === 'fits' ? -1 : 1) - (b.nowFit === 'fits' ? -1 : 1))[0];
    if (!pick) {
      card.append(h('p', { class: 'sub' }, '남은 시간에 끝낼 수 있는 루틴이 없어요. 다른 활동을 기록해도 좋아요.'));
      return { node: card, shownId: null };
    }
    const r = pick.r;
    card.id = 'ti-' + r.id;
    card.append(
      h('div', { class: 'now-row' },
        h('span', { class: 'dot rc ' + rc(r), 'aria-hidden': 'true' }),
        h('div', { class: 'now-main' },
          h('button', { type: 'button', class: 'now-name name-link', onclick: () => openRoutine(r.id), 'aria-label': q(r.name) + ' 자세히 보기' }, r.name),
          h('span', { class: 'now-meta' }, '약 ' + pick.predBase + '분 · 최소 ' + r.minMin + '분' +
            (pick.since != null ? ' · ' + sinceText(pick) : '') + (pick.missed ? ' · 하면 ' + streakText(pick.streak) + '이 이어져요' : ''))),
        h('button', { type: 'button', class: 'btn primary start-btn', onclick: () => onStartRoutine(r) }, '시작')),
      h('div', { class: 'now-foot' },
        h('span', { class: 'fit-chip ' + pick.nowFit }, FIT_LONG[pick.nowFit])));
    if (ui.panel && ui.panel.routineId === r.id && ui.panel.where === 'today') card.append(routinePanel(r));
    return { node: card, shownId: r.id };
  }

  function sinceText(info) {
    const a = info.anchor;
    if (a.type === 'block') return q(a.block.name) + ' 끝난 지 ' + info.since + '분';
    if (a.type === 'time') return a.time + '부터 ' + info.since + '분';
    return anchorLabel(info.r) + (a.type === 'situation' ? '부터 ' : '난 지 ') + info.since + '분';
  }

  /* 오늘의 시간: 고정 일정은 회색, 빈 시간은 민트, 루틴 시작 신호는 청록 점, 지금은 세로선 */
  function dayCard(todays, gaps, nowMin, infos) {
    const s = state.settings;
    const ds = C.toMin(s.dayStart), de = C.dayEndMin(s), total = de - ds;
    const pct = (m) => (Math.min(Math.max(m, ds), de) - ds) / total * 100;
    const pos = (a, b) => 'left:' + pct(a) + '%;width:' + Math.max(0, pct(b) - pct(a)) + '%';
    const bar = h('div', { class: 'timeline' });
    gaps.forEach((g) => bar.append(h('span', { class: 'tl-gap' + (g.state === 'past' ? ' past' : ''), style: pos(g.start, g.end) })));
    todays.forEach((b) => bar.append(h('span', {
      class: 'tl-block' + (C.toMin(b.end) <= nowMin ? ' past' : ''), style: pos(C.toMin(b.start), C.toMin(b.end))
    })));
    const marks = infos.filter((i) => i.todo && i.anchor.today && i.anchor.plannedMin != null && i.anchor.plannedMin >= ds && i.anchor.plannedMin <= de);
    const track = h('div', { class: 'tl-track', 'aria-hidden': 'true' },
      marks.map((i) => h('span', { class: 'tl-mark ' + rc(i.r), style: 'left:' + pct(i.anchor.plannedMin) + '%', title: i.r.name + ' · ' + C.fmtHM(i.anchor.plannedMin) })),
      bar,
      nowMin >= ds && nowMin <= de ? h('span', { class: 'tl-now', style: 'left:' + pct(nowMin) + '%' }) : null);

    const step = total > 12 * 60 ? 240 : 120;
    const ticks = [];
    for (let t = Math.ceil(ds / step) * step; t <= de; t += step) ticks.push(t);
    const left = gaps.reduce((sum, g) => sum + g.remaining, 0);

    // 화면 읽기 프로그램과 자세히 보고 싶은 사람을 위한 글 목록 (접어 둠)
    const rows = todays.map((b) => ({ start: C.toMin(b.start), block: b }))
      .concat(gaps.map((g) => ({ start: g.start, gap: g })))
      .sort((x, y) => x.start - y.start);
    const list = h('details', { class: 'tl-details' },
      h('summary', null, '일정·빈 시간 목록'),
      h('ul', { class: 'plain' }, rows.map((row) => {
        if (row.block) {
          const b = row.block;
          return h('li', null, h('div', { class: 'gap-row past' },
            h('span', null, h('span', { class: 'num' }, b.start + '–' + b.end), ' ' + b.name), h('span', null, '고정 · ' + b.kind)));
        }
        const g = row.gap;
        const label = g.state === 'past' ? '지남' : g.state === 'now' ? '지금 · ' + C.fmtDuration(g.remaining) + ' 남음' : C.fmtDuration(g.len);
        return h('li', null, h('div', { class: 'gap-row' + (g.state === 'past' ? ' past' : '') },
          h('span', { class: 'when' }, h('span', { class: 'num' }, C.fmtHM(g.start) + '–' + C.fmtHM(g.end)), ' 빈 시간'), h('span', null, label)));
      })));

    return h('section', { class: 'card day-card', 'aria-labelledby': 'dayCardH' },
      h('div', { class: 'section-head' },
        h('h3', { id: 'dayCardH' }, '오늘의 시간'),
        h('span', { class: 'sub' }, gaps.length ? '빈 시간 ' + C.fmtDuration(left) + ' 남음' : '15분 넘는 빈 시간이 없어요')),
      track,
      h('div', { class: 'tl-ticks', 'aria-hidden': 'true' }, ticks.map((t) => h('span', { style: 'left:' + pct(t) + '%' }, (Math.floor(t / 60) % 24) + '시'))),
      h('div', { class: 'legend', 'aria-hidden': 'true' },
        h('span', { class: 'lg-block' }, '고정 일정'), h('span', { class: 'lg-gap' }, '빈 시간'),
        marks.length ? h('span', { class: 'lg-mark' }, '루틴 시작 신호') : null, h('span', { class: 'lg-now' }, '지금')),
      list);
  }

  /* 오늘 남은 루틴: 한 줄씩. 이름을 누르면 루틴 상세 */
  function todayRoutines(infos, shownId) {
    const sec = h('section', { class: 'section', 'aria-labelledby': 'todayRoutinesH' },
      h('h3', { id: 'todayRoutinesH' }, '오늘 남은 루틴'));
    if (!state.routines.length) {
      sec.append(emptyBox('루틴이 없어요.',
        '주 1회처럼 작게 하나 만들어 보세요. 시작 신호와 이만큼은 하자는 최소 시간을 함께 정해요.',
        h('button', { type: 'button', class: 'btn', onclick: openNewRoutine }, '루틴 만들기')));
      return sec;
    }
    const todo = infos.filter((i) => i.todo && i.r.id !== shownId).sort((a, b) =>
      (b.missed - a.missed) || (!!b.tight - !!a.tight) ||
      ((a.anchor.today ? a.anchor.plannedMin : 9999) - (b.anchor.today ? b.anchor.plannedMin : 9999)) ||
      a.r.name.localeCompare(b.r.name));
    const rest = infos.filter((i) => !i.todo);

    if (todo.length) sec.append(h('ul', { class: 'rlist', role: 'list' }, todo.map(todayItem)));
    else if (!shownId) sec.append(h('p', { class: 'sub' }, '오늘 할 루틴을 모두 했거나 이번 주 횟수를 채웠어요.'));
    else sec.append(h('p', { class: 'sub' }, '지금 루틴 말고는 오늘 남은 루틴이 없어요.'));

    if (rest.length) {
      sec.append(h('p', { class: 'sub' }, '오늘은 쉬어도 돼요: ' + rest.map((i) => i.r.name + ' (' + (i.doneToday ? '오늘 했어요' : i.situation ? '오늘은 상황 없음' : '이번 주 ' + i.done + '/' + i.r.perWeek) + ')').join(', ')));
    }
    return sec;
  }

  function anchorShort(r, anchor) {
    if (anchor.type === 'block' && !anchor.today) return '오늘은 ' + (anchor.holiday ? '공휴일이라 ' : '') + q(anchor.block.name) + ' 없는 날';
    if (anchor.type === 'block') return q(anchor.block.name) + ' 끝나면';
    if (anchor.type === 'time') return anchor.time + '부터';
    if (anchor.type === 'routine') return anchorPhrase(r) + (anchor.plannedMin != null ? ' (' + C.fmtHM(anchor.plannedMin) + ' 끝냄)' : '');
    if (anchor.type === 'situation') return q(anchor.label) + (anchor.plannedMin != null ? ' ' + C.fmtHM(anchor.plannedMin) : '');
    if (anchor.type === 'dayoff') return '쉬는 날';
    return '아무 때나';
  }

  function fitLine(info) {
    if (info.fit === 'nogap') return h('p', { class: 'fit-line' }, h('span', { class: 'fit-chip nogap' }, FIT_LONG.nogap));
    const g = info.pick.gap;
    return h('p', { class: 'fit-line' },
      h('span', { class: 'fit-chip ' + info.fit }, FIT_LONG[info.fit]),
      h('span', null, (info.pick.anchored ? '시작 신호 다음 빈 시간 ' : '남은 가장 큰 빈 시간 ') + C.fmtHM(g.start) + '–' + C.fmtHM(g.end) +
        ' · 쓸 수 있는 시간 ' + C.fmtDuration(info.pick.avail)));
  }

  function todayItem(info) {
    const r = info.r;
    const notes = [];
    if (info.missed) notes.push((C.scheduleOf(r) === 'weekly' ? '이번 주에 채우면 ' : '오늘 하면 ') + streakText(info.streak) + '이 이어져요 · 최소 ' + r.minMin + '분만 해도 돼요');
    if (info.tight) notes.push('이번 주 ' + info.tight.left + '번 남았는데 ' + info.tight.daysLeft + '일 남았어요');
    if (info.since != null) notes.push(sinceText(info));
    const li = h('li', { class: 'rrow' + (info.missed || info.tight ? ' flagged' : ''), id: 'ti-' + r.id },
      h('div', { class: 'rrow-line' },
        h('span', { class: 'dot rc ' + rc(r), 'aria-hidden': 'true' }),
        h('div', { class: 'rrow-main' },
          h('h4', { class: 'rrow-name' }, h('button', { type: 'button', class: 'name-link', onclick: () => openRoutine(r.id), 'aria-label': q(r.name) + ' 자세히 보기' }, r.name)),
          h('span', { class: 'rrow-meta' }, anchorShort(r, info.anchor) + ' · 약 ' + info.predBase + '분 · ' + weekText(info) + (info.streak.current ? ' · ' + streakText(info.streak) : '')),
          notes.length ? h('span', { class: 'rrow-note' }, notes.join(' · ')) : null),
        h('span', { class: 'fit-word ' + info.fit }, FIT_SHORT[info.fit]),
        h('button', { type: 'button', class: 'btn small outline', onclick: () => onStartRoutine(r), 'aria-label': q(r.name) + ' 시작' }, '시작')));
    if (ui.panel && ui.panel.routineId === r.id && ui.panel.where === 'today') li.append(routinePanel(r));
    return li;
  }

  /* 오늘 고정 일정: 회색 칩. 루틴(청록 동그라미)과 모양·색이 다르다 */
  function fixedChips(todays, nowMin) {
    return h('section', { class: 'section', 'aria-labelledby': 'fixedH' },
      h('h3', { id: 'fixedH', class: 'muted-h' }, '오늘 고정 일정'),
      h('ul', { class: 'fixed-chips' }, todays.map((b) => h('li', { class: 'fchip' + (C.toMin(b.end) <= nowMin ? ' past' : '') },
        h('span', { class: 'sq', 'aria-hidden': 'true' }),
        h('span', { class: 'num' }, b.start), ' ' + b.name,
        h('span', { class: 'sr-only' }, ' (' + b.kind + ', ' + b.end + '까지' + (C.toMin(b.end) <= nowMin ? ', 지남' : '') + ')')))));
  }

  function openPanel(routineId, mode) {
    ui.panel = { routineId, mode, where: ui.tab === 'routines' ? 'routines' : 'today' };
    renderToday();
    renderRoutines();
    const first = [...document.querySelectorAll('.panel input, .panel select')].find((el) => el.getClientRects().length > 0);
    if (first) first.focus();
  }
  function closePanel(routineId) {
    const where = ui.panel && ui.panel.where;
    ui.panel = null;
    renderToday();
    renderRoutines();
    if (where === 'routines') { const b = $('rdStart') || $('rdTitle'); if (b) b.focus(); return; }
    const item = $('ti-' + routineId);
    const btn = item && item.querySelector('button.btn');
    if (btn) btn.focus();
  }

  function routinePanel(r) {
    const p = ui.panel;
    const manual = p.mode === 'manual';
    const form = h('form', { class: 'panel', novalidate: true });
    const fields = [];
    if (manual) {
      fields.push(h('div', { class: 'field' },
        h('label', { for: 'pDay' }, '언제 했나요?'),
        h('select', { id: 'pDay' }, dayChoices().map((c) => h('option', { value: c.value }, c.label)))));
      fields.push(h('div', { class: 'field' },
        h('label', { for: 'pAct' }, '실제로 걸린 시간 (분)'),
        h('input', { id: 'pAct', inputmode: 'numeric', autocomplete: 'off', 'aria-describedby': 'pActErr' }),
        h('p', { class: 'err', id: 'pActErr' })));
    }
    if (r.measure.type === 'none') {
      fields.push(h('div', { class: 'field' },
        h('label', { for: 'pEst' }, '오늘 예상 시간 (분)'),
        h('input', { id: 'pEst', inputmode: 'numeric', autocomplete: 'off', value: String(r.baseMin), 'aria-describedby': 'pEstHint pEstErr' }),
        h('p', { class: 'hint', id: 'pEstHint' }, '셀 수 없는 일이라 그날 내용을 보고 예상을 적어요. 예상과 실제의 차이로 변화를 봐요.'),
        h('p', { class: 'err', id: 'pEstErr' })));
    }
    if (manual && r.measure.type === 'count') {
      fields.push(h('div', { class: 'field' },
        h('label', { for: 'pAmt' }, '몇 ' + r.measure.unit + ' 했어요? (모르면 비워 두세요)'),
        h('input', { id: 'pAmt', inputmode: 'numeric', autocomplete: 'off', 'aria-describedby': 'pAmtErr' }),
        h('p', { class: 'err', id: 'pAmtErr' })));
    }
    form.append(...fields, h('div', { class: 'row' },
      h('button', { type: 'submit', class: 'btn primary' }, manual ? '기록 저장' : '타이머 시작'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => closePanel(r.id) }, '취소')));

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      clearErrs(form);
      const errs = [];
      if (manual) errs.push(setErr('pAct', C.checkMinutes($('pAct').value)));
      if ($('pEst')) errs.push(setErr('pEst', C.checkMinutes($('pEst').value)));
      if ($('pAmt') && $('pAmt').value.trim() !== '') errs.push(setErr('pAmt', C.checkAmount($('pAmt').value)));
      if (focusFirst(errs)) return;
      const estimate = $('pEst') ? Number($('pEst').value) : r.baseMin;
      if (manual) saveManualRoutine(r, Number($('pAct').value), $('pAmt') && $('pAmt').value.trim() ? Number($('pAmt').value) : null, estimate, Number($('pDay').value));
      else startRoutine(r, estimate);
    });
    return form;
  }

  function onStartRoutine(r) {
    if (state.active) { blockedByActive(); return; }
    if (r.measure.type === 'none') { openPanel(r.id, 'start'); return; }
    startRoutine(r, r.baseMin);
  }

  function startRoutine(r, estimateMin) {
    if (state.active) { blockedByActive(); return; }
    const now = new Date();
    const L = nowL();
    const anchor = anchorFor(r, L, dayContext(L));
    let planned = null;
    if (anchor.today && anchor.plannedMin != null) {
      const p = C.atMinutes(L.day, anchor.plannedMin).toISOString();
      if (C.delayMinutes(p, now.toISOString()) != null) planned = p;
    }
    state.active = {
      id: uid('t'), kind: 'routine', routineId: r.id, name: r.name, category: r.category, version: 'base',
      estimateMin, plannedStartAt: planned, startedAt: now.toISOString()
    };
    if (minFor(r)) state.active.minMin = minFor(r);
    ui.panel = null;
    if (commit()) showStatus('info', q(r.name) + ' 시작했어요.', (minFor(r) ? '최소 ' + minFor(r) + '분을 넘기면 한 번으로 세요. ' : '') + '새로고침하거나 탭을 닫아도 시작 시각부터 이어서 계산해요.');
    renderAll();
    $('activeTitle').focus();
  }

  function saveManualRoutine(r, actual, amount, estimate, daysAgo) {
    const rec = Object.assign({
      id: uid('t'), kind: 'routine', routineId: r.id, name: r.name, category: r.category, version: 'base',
      estimateMin: estimate, actualMin: actual, amount: amountFor(r, amount), plannedStartAt: null, source: 'manual'
    }, manualSpan(daysAgo || 0, actual));
    if (minFor(r)) rec.minMin = minFor(r);
    state.records.push(rec);
    ui.panel = null;
    if (commit()) showStatus('info', q(r.name) + ' ' + (daysAgo ? ['', '어제', '그저께'][daysAgo] + ' 기록으로 ' : '') + '저장했어요. 실제 ' + actual + '분 걸렸어요.', recordSummary(rec, r));
    renderAll();
    ($(ui.tab === 'routines' ? 'rdTitle' : 'todayH') || $('tab-' + ui.tab)).focus();
  }

  // ---------- 다른 활동 ----------
  function updateTaskHint() {
    const cat = $('tCategory').value.trim() || '기타';
    const est = Number($('tEstimate').value);
    const same = state.records.filter((r) => r.category === cat);
    let text;
    if (same.length < C.CALIBRATE_FROM) {
      text = q(cat) + ' 기록이 ' + (same.length ? same.length + '개예요' : '아직 없어요') + '. 3개 이상 쌓이면 실제로 걸릴 시간을 알려 드려요.';
    } else {
      const cal = C.ratioOf(same);
      text = q(cat) + ' 카테고리는 보통 ' + ratioText(cal.ratio) + ' 걸렸어요.';
      if (!C.checkMinutes($('tEstimate').value)) text += ' ' + est + '분으로 잡으면 실제로는 약 ' + C.round5(est * cal.ratio) + '분 걸릴 거예요.';
    }
    const L = nowL();
    const cur = C.computeGaps(dayContext(L).blocks, L.weekday, state.settings, L.nowMin).find((g) => g.state === 'now');
    if (state.blocks.length && cur) text += ' 지금 빈 시간은 ' + C.fmtDuration(cur.remaining) + ' 남았어요.';
    $('tHint').textContent = text;
  }

  function bindTaskForm() {
    const toggle = () => {
      const m = $('tManual').checked;
      $('tActualField').hidden = !m;
      $('tDayField').hidden = !m;
      if (m) $('tDay').replaceChildren(...dayChoices().map((c) => h('option', { value: c.value }, c.label)));
      $('tSubmit').textContent = m ? '기록 저장' : '시작';
      if (!m) setErr('tActual', '');
    };
    $('tManual').addEventListener('change', toggle);
    ['tCategory', 'tEstimate'].forEach((id) => $(id).addEventListener('input', updateTaskHint));
    ['tName', 'tCategory', 'tEstimate', 'tActual'].forEach((id) => $(id).addEventListener('input', () => {
      if ($(id).getAttribute('aria-invalid')) setErr(id, '');
    }));

    $('taskForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const form = $('taskForm');
      clearErrs(form);
      const manual = $('tManual').checked;
      const errs = [
        setErr('tName', C.checkName($('tName').value)),
        setErr('tCategory', C.checkCategory($('tCategory').value)),
        setErr('tEstimate', C.checkMinutes($('tEstimate').value))
      ];
      if (manual) errs.push(setErr('tActual', C.checkMinutes($('tActual').value)));
      if (focusFirst(errs)) return;
      if (!manual && state.active) { blockedByActive('taskFormErr'); return; }

      const name = $('tName').value.trim();
      const category = $('tCategory').value.trim() || '기타';
      const est = Number($('tEstimate').value);
      const now = new Date();
      if (manual) {
        const act = Number($('tActual').value);
        const rec = Object.assign({
          id: uid('t'), kind: 'task', routineId: null, name, category, version: null, estimateMin: est, actualMin: act,
          amount: null, plannedStartAt: null, source: 'manual'
        }, manualSpan(Number($('tDay').value) || 0, act));
        state.records.push(rec);
        if (commit()) showStatus('info', q(name) + ' 기록했어요.', recordSummary(rec, null));
      } else {
        state.active = {
          id: uid('t'), kind: 'task', routineId: null, name, category, version: null, estimateMin: est,
          plannedStartAt: null, startedAt: now.toISOString()
        };
        if (commit()) showStatus('info', q(name) + ' 시작했어요.', '새로고침하거나 탭을 닫아도 시작 시각부터 이어서 계산해요.');
      }
      $('tName').value = '';
      $('tEstimate').value = '';
      $('tActual').value = '';
      $('tManual').checked = false;
      toggle();
      renderAll();
      if (dialog) closeEditDialog(); // 창은 닫고, 초점은 시작했으면 하는 중 카드, 아니면 다른 활동 버튼으로
      else if (manual) $('tName').focus(); else $('activeTitle').focus();
    });
  }

  // ---------- 루틴 색 ----------
  const COLOR_NAMES = { blue: '파랑', orange: '주황', purple: '보라', pink: '분홍', lime: '연두', sky: '하늘', mustard: '겨자', brown: '갈색' };
  function colorOf(r) { return (r && r.color) || 'blue'; }
  function rc(r) { return 'rc-' + colorOf(r); }
  /* 아직 안 쓴 색부터. 다 쓰면 순서대로 다시 */
  function nextColor(exceptId) {
    const used = state.routines.filter((x) => x.id !== exceptId).map((x) => x.color);
    return S.COLORS.find((c) => !used.includes(c)) || S.COLORS[state.routines.length % S.COLORS.length];
  }

  function svgIcon(d, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', String(size || 16)); svg.setAttribute('height', String(size || 16));
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  }
  const ICON_NEXT = 'M9 6l6 6-6 6';
  const ICON_BACK = 'M15 6l-6 6 6 6';
  const ICON_ARROW = 'M5 12h14M13 6l6 6-6 6';

  // ========== 루틴 ==========
  /* 이번 주 작은 막대: 요일 루틴은 월~일 칸, 주 N회는 N칸, 상황 루틴은 이번 주 상황 수만큼 */
  function weekStrip(r) {
    const L = nowL();
    const ws = C.startOfWeek(L.day);
    const done = C.doneDays(state.records, r.id, ws, C.addDays(ws, 7), L.shift);
    const todayIdx = C.mondayIndex(L.day);
    let cells = [];
    const sc = C.scheduleOf(r);
    if (sc === 'days') {
      cells = [0, 1, 2, 3, 4, 5, 6].map((i) => {
        const d = C.addDays(ws, i);
        const on = r.days.includes(d.getDay());
        return done[C.dayKey(d)] ? 'hit' : (!on ? 'off' : i === todayIdx ? 'now' : 'empty');
      });
    } else if (sc === 'weekly') {
      const n = Object.keys(done).length;
      for (let i = 0; i < r.perWeek; i++) cells.push(i < n ? 'hit' : 'empty');
    } else {
      const wk = C.situationWeek(r, sitEnv());
      for (let i = 0; i < wk.occ; i++) cells.push(i < wk.hit ? 'hit' : 'empty');
    }
    if (!cells.length) return null;
    return h('span', { class: 'strip', 'aria-hidden': 'true' }, cells.map((c) => h('span', { class: 's-' + c })));
  }

  function routineSummary(r) {
    const now = new Date();
    const st = C.streak(r, sitEnv(now));
    let week;
    if (C.isSituation(r)) { const wk = C.situationWeek(r, sitEnv(now)); week = wk.occ ? '이번 주 ' + wk.occ + '번 중 ' + wk.hit + '번' : '이번 주는 아직 상황 없음'; }
    else week = '이번 주 ' + C.weekDone(state.records, r.id, now, shift()) + '/' + weekTarget(r);
    return [anchorPhrase(r), C.isSituation(r) ? null : goalText(r), week, st.current ? streakText(st) : null].filter(Boolean).join(' · ');
  }

  function renderRoutines() {
    const box = $('routinesDyn');
    const open = ui.routine && findRoutine(ui.routine);
    if (open) { box.replaceChildren(...routineDetail(open)); return; }
    ui.routine = null;
    const nodes = [h('h2', { class: 'sr-only' }, '내 루틴'),
      h('button', { type: 'button', class: 'new-btn', id: 'btnNewRoutine', onclick: openNewRoutine }, '+ 새 루틴 만들기')];
    if (!state.routines.length) {
      nodes.push(emptyBox('아직 루틴이 없어요.', '위의 ‘새 루틴 만들기’로 주 1회처럼 작게 하나 만들어 보세요. 한 번에 한두 개로 시작하는 편이 오래가요.'));
    } else {
      nodes.push(h('div', { class: 'section-head' }, h('h3', null, '내 루틴 ' + state.routines.length + '개'), h('span', { class: 'sub' }, '눌러서 자세히 보기')));
      nodes.push(h('ul', { class: 'rcards', role: 'list' }, state.routines.map((r) => h('li', null,
        h('button', { type: 'button', class: 'rcard ' + rc(r), id: 'rc-' + r.id, onclick: () => openRoutine(r.id) },
          h('span', { class: 'rc-dot', 'aria-hidden': 'true' }),
          h('span', { class: 'rcard-main' },
            h('span', { class: 'rcard-top' }, h('span', { class: 'rcard-name' }, r.name), h('span', { class: 'rcard-kind' }, kindName(r))),
            h('span', { class: 'rcard-meta' }, routineSummary(r)),
            weekStrip(r)),
          svgIcon(ICON_NEXT))))));
    }
    box.replaceChildren(...nodes);
  }

  // ---------- 루틴 상세: 루틴 하나에 관한 모든 것 ----------
  function openRoutine(id) {
    if (!findRoutine(id)) return;
    ui.routine = id;
    if (ui.panel && ui.panel.where === 'routines' && ui.panel.routineId !== id) ui.panel = null;
    ui.editRecord = null;
    if (ui.tab !== 'routines') switchTab('routines');
    else { renderRoutines(); setHash(); }
    try { window.scrollTo(0, 0); } catch (e) { /* 무시 */ }
    const t = $('rdTitle');
    if (t) t.focus();
  }
  function closeRoutine() {
    const id = ui.routine;
    ui.routine = null;
    if (ui.panel && ui.panel.where === 'routines') ui.panel = null;
    renderRoutines();
    setHash();
    const card = $('rc-' + id);
    (card || $('btnNewRoutine')).focus();
  }

  /* 오늘 할 차례인지 한 줄로 */
  function todayLine(info) {
    const r = info.r, a = info.anchor;
    if (info.doneToday) return '오늘 했어요';
    if (info.todo) {
      if (a.today && a.plannedMin != null) return C.fmtHM(a.plannedMin) + (a.type === 'block' || a.type === 'routine' || a.type === 'situation' ? '부터 할 차례예요' : '에 할 차례예요');
      if (a.type === 'dayoff') return '쉬는 날이라 오늘 할 차례예요';
      return C.scheduleOf(r) === 'weekly' ? '이번 주 ' + (info.target - info.done) + '번 남았어요' : '오늘 할 차례예요';
    }
    if (info.situation) return a.type === 'block' && !a.today ? anchorShort(r, a) : '오늘은 아직 상황이 없어요';
    if (C.scheduleOf(r) === 'weekly') return '이번 주 횟수를 채웠어요';
    return '오늘은 쉬는 요일이에요';
  }

  function routineDetail(r) {
    const L = nowL();
    const ctx = dayContext(L);
    const gaps = C.computeGaps(ctx.blocks, L.weekday, state.settings, L.nowMin);
    const info = routineInfo(r, L, gaps, ctx);
    const st = info.streak;
    const nodes = [];

    nodes.push(h('button', { type: 'button', class: 'back-btn', id: 'rdBack', onclick: closeRoutine }, svgIcon(ICON_BACK), '내 루틴'));

    // 1. 머리
    nodes.push(h('div', { class: 'rd-head ' + rc(r) },
      h('span', { class: 'rd-badge', 'aria-hidden': 'true' }),
      h('div', { class: 'rd-title' },
        h('h2', { id: 'rdTitle', tabindex: '-1' }, r.name),
        h('span', { class: 'sub' }, kindName(r) + ' · ' + r.category + ' · ' + COLOR_NAMES[colorOf(r)])),
      pencilBtn(q(r.name) + ' 고치기', () => editRoutine(r.id), 'rd-edit')));

    // 2. 지금 상태
    const status = h('section', { class: 'card rd-status', 'aria-labelledby': 'rdTodayH' },
      h('div', { class: 'rd-today' },
        h('div', null, h('span', { class: 'sub' }, '오늘'), h('h3', { id: 'rdTodayH' }, todayLine(info))),
        state.active ? null : h('button', { type: 'button', class: 'btn primary', id: 'rdStart', onclick: () => onStartRoutine(r) }, '시작')),
      info.todo && !info.doneToday ? fitLine(info) : null,
      h('div', { class: 'tiles' },
        h('div', { class: 'tile' }, h('span', null, '이번 주'), h('b', null, info.situation ? info.done + ' / ' + info.target + '번' : info.done + ' / ' + info.target)),
        h('div', { class: 'tile accent ' + rc(r) }, h('span', null, '연속'), h('b', null, st.current + st.unit)),
        h('div', { class: 'tile' }, h('span', null, '최고'), h('b', null, st.best + st.unit))),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => openPanel(r.id, 'manual') }, '타이머 없이 기록')));
    if (ui.panel && ui.panel.routineId === r.id && ui.panel.where === 'routines') status.append(routinePanel(r));
    nodes.push(status);

    // 3. 규칙
    nodes.push(h('section', { class: 'card', 'aria-labelledby': 'rdRuleH' },
      h('h3', { id: 'rdRuleH' }, '규칙'),
      h('p', { class: 'rule-chips' }, h('span', { class: 'rchip' }, anchorPhrase(r)), svgIcon(ICON_ARROW), h('span', { class: 'sr-only' }, ' 그러면 '),
        h('span', { class: 'rchip ' + rc(r) + ' on' }, r.name)),
      h('dl', { class: 'facts-dl' },
        h('dt', null, '얼마나 자주'), h('dd', null, goalText(r)),
        h('dt', null, '시간'), h('dd', null, '기본 ' + r.baseMin + '분 · 최소 ' + r.minMin + '분',
          info.cal ? h('span', { class: 'sub' }, ' (기록 기준 약 ' + info.predBase + '분)') : null),
        h('dt', null, '분량'), h('dd', null, measureText(r.measure)),
        h('dt', null, '한 번으로 셈'), h('dd', null, r.measure.type === 'fixed' ? '정한 분량을 끝내면' : '최소 ' + r.minMin + '분을 넘기면'),
        r.anchor && r.anchor.type === 'block' && findBlock(r.anchor.blockId) ? [h('dt', null, '신호 요일'), h('dd', null, daysText(findBlock(r.anchor.blockId).days))] : null)));

    // 4. 기록 달력
    nodes.push(recordCalendar(r, L));

    // 5. 변화
    nodes.push(changeSection(r));

    // 6. 루티의 제안 (이 루틴 것만)
    const sugs = actionable(activeSuggestions()).filter((s) => s.routineId === r.id);
    if (sugs.length) {
      nodes.push(h('section', { class: 'card', 'aria-labelledby': 'rdSugH' },
        h('h3', { id: 'rdSugH', class: 'with-ruti' }, rutiFace(28), '루티의 제안'),
        h('ul', { class: 'suggest-list' }, sugs.map((s) => {
          const v = suggestionView(s);
          return h('li', { class: 'suggest' },
            h('p', null, v.text),
            h('details', { class: 'why' }, h('summary', null, '왜 이 제안이에요?'), h('p', null, v.why)),
            h('div', { class: 'row' },
              v.apply ? h('button', { type: 'button', class: 'btn small primary', onclick: () => applySuggestion(s) }, v.apply) : null,
              v.edit ? h('button', { type: 'button', class: 'btn small primary', onclick: () => { dismissSuggestion(s.key); commit(); editRoutine(r.id); } }, '루틴 고치기') : null,
              h('button', { type: 'button', class: 'btn small ghost', onclick: () => { dismissSuggestion(s.key); commit(); afterSuggestion(); } }, '이번 주는 넘어가기')));
        }))));
    }

    // 7. 연결
    const next = state.routines.filter((x) => x.anchor && x.anchor.type === 'routine' && x.anchor.routineId === r.id);
    const prev = r.anchor && r.anchor.type === 'routine' ? findRoutine(r.anchor.routineId) : null;
    if (next.length || prev) {
      const link = (x) => h('button', { type: 'button', class: 'rlink ' + rc(x), onclick: () => openRoutine(x.id) }, h('span', { class: 'rc-dot', 'aria-hidden': 'true' }), x.name);
      nodes.push(h('section', { class: 'card', 'aria-labelledby': 'rdLinkH' },
        h('h3', { id: 'rdLinkH' }, '이어지는 루틴'),
        prev ? h('p', { class: 'link-row' }, link(prev), h('span', { class: 'sub' }, '끝내면'), svgIcon(ICON_ARROW), h('b', null, r.name)) : null,
        next.map((x) => h('p', { class: 'link-row' }, h('b', null, r.name), h('span', { class: 'sub' }, '끝내면'), svgIcon(ICON_ARROW), link(x)))));
    }

    // 8. 최근 기록
    nodes.push(recentRecords(r));
    return nodes;
  }

  /* 지난 5주 달력: 한 날을 루틴 색으로 칠한다. 요일 루틴은 할 날이 아닌 날, 상황 루틴은 상황이 없던 날을 옅게 */
  function recordCalendar(r, L) {
    const ws = C.addDays(C.startOfWeek(L.day), -28), we = C.addDays(C.startOfWeek(L.day), 7);
    const done = C.doneDays(state.records, r.id, ws, we, L.shift);
    const occ = C.isSituation(r) ? C.occurrenceDays(r, sitEnv(), ws, we) : null;
    const todayKey = C.dayKey(L.day);
    const made = C.dayKey(C.startOfDay(new Date(Date.parse(r.createdAt) - L.shift * 60000)));
    let count = 0;
    const cells = [];
    for (let i = 0; i < 35; i++) {
      const d = C.addDays(ws, i), k = C.dayKey(d);
      const hit = !!done[k];
      if (hit) count += 1;
      const future = k > todayKey, before = k < made;
      const idle = !hit && (future || before || (C.scheduleOf(r) === 'days' && !r.days.includes(d.getDay())) || (occ && !occ[k]));
      cells.push(h('span', {
        class: 'cc' + (hit ? ' hit' : '') + (idle ? ' idle' : '') + (k === todayKey ? ' today' : ''),
        title: (d.getMonth() + 1) + '/' + d.getDate() + (hit ? ' 했어요' : '')
      }, String(d.getDate())));
    }
    return h('section', { class: 'card', 'aria-labelledby': 'rdCalH' },
      h('div', { class: 'section-head' }, h('h3', { id: 'rdCalH' }, '지난 5주'), h('span', { class: 'sub' }, count + '일 했어요')),
      h('div', { class: 'cc-grid ' + rc(r), role: 'img', 'aria-label': '지난 5주 동안 ' + count + '일 했어요' },
        DAY_ORDER.map((d) => h('span', { class: 'cc-h', 'aria-hidden': 'true' }, C.DAY_NAMES[d])), cells),
      h('div', { class: 'legend ' + rc(r), 'aria-hidden': 'true' }, h('span', { class: 'lg-hit' }, '한 날'), h('span', { class: 'lg-today' }, '오늘'),
        C.isSituation(r) ? h('span', { class: 'lg-idle' }, '상황 없던 날')
          : C.scheduleOf(r) === 'days' && r.days.length < 7 ? h('span', { class: 'lg-idle' }, '쉬는 요일') : null));
  }

  /* 변화: 최근 걸린 시간 막대(기본·최소 선)와 관찰 문장 */
  function changeSection(r) {
    const recs = state.records.filter((x) => x.routineId === r.id).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    const sec = h('section', { class: 'card', 'aria-labelledby': 'rdChangeH' }, h('h3', { id: 'rdChangeH' }, '변화'));
    if (!recs.length) { sec.append(h('p', { class: 'sub' }, '아직 기록이 없어요. 한 번 해 보면 여기에 걸린 시간이 쌓여요.')); return sec; }
    const last = recs.slice(-10);
    const top = Math.max(r.baseMin * 1.3, ...last.map((x) => x.actualMin));
    const pct = (m) => Math.min(100, m / top * 100);
    const med = C.median(recs.slice(-5).map((x) => x.actualMin));
    sec.append(
      h('div', { class: 'section-head' }, h('span', null, '걸린 시간 ', h('span', { class: 'sub' }, '최근 ' + last.length + '번')), h('b', null, '보통 ' + Math.round(med) + '분')),
      h('div', { class: 'tbars ' + rc(r), role: 'img', 'aria-label': '최근 ' + last.length + '번 걸린 시간: ' + last.map((x) => x.actualMin).join(', ') + '분' },
        last.map((x) => h('span', { class: 'tb' + (C.countsAsDone(x) ? '' : ' short'), style: 'height:' + pct(x.actualMin) + '%', title: dateText(x.startedAt) + ' ' + x.actualMin + '분' })),
        h('i', { class: 'tline base', style: 'bottom:' + pct(r.baseMin) + '%' }, h('em', null, '기본 ' + r.baseMin + '분')),
        h('i', { class: 'tline min', style: 'bottom:' + pct(r.minMin) + '%' }, h('em', null, '최소 ' + r.minMin + '분'))),
      h('p', { class: 'sub' }, C.durationSentence(C.observeDuration(state.records, r), r)));
    if (r.anchor) {
      const text = C.delaySentence(C.observeDelay(state.records, r), anchorLabel(r));
      sec.append(h('div', { class: 'obs' }, h('span', { class: 'label' }, '시작 신호부터 시작까지'),
        h('p', null, text || '시작 신호가 있는 날 타이머로 시작하면 시작까지 걸린 시간을 기록해요.')));
    }
    return sec;
  }

  function recentRecords(r) {
    const list = state.records.filter((x) => x.routineId === r.id).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, 5);
    const sec = h('section', { class: 'card', 'aria-labelledby': 'rdRecH' }, h('h3', { id: 'rdRecH' }, '최근 기록'));
    if (!list.length) { sec.append(h('p', { class: 'sub' }, '아직 기록이 없어요.')); return sec; }
    sec.append(h('ul', { class: 'plain rd-recs' }, list.map((x) => {
      const li = h('li', { id: 'rrec-' + x.id },
        h('div', { class: 'rd-rec' },
          h('span', null, dateText(x.startedAt) + ' ', h('span', { class: 'num' }, clockText(x.startedAt))),
          h('span', null, h('b', null, x.actualMin + '분'), C.countsAsDone(x) ? null : h('span', { class: 'tag' }, '최소 미만'), x.source === 'manual' ? h('span', { class: 'tag' }, '직접 입력') : null),
          pencilBtn(q(x.name) + ' ' + dateText(x.startedAt) + ' 기록 고치기', () => (ui.editRecord === x.id ? closeRecordEdit(x.id) : openRecordEdit(x.id, 'detail')), 'edit')));
      if (ui.editRecord === x.id && ui.editWhere === 'detail') li.append(recordEditForm(x, r));
      return li;
    })));
    sec.append(h('button', { type: 'button', class: 'btn small', onclick: () => { ui.filter = r.category; ui.showAll = false; switchTab('review', 'recH'); } }, q(r.category) + ' 기록 모두 보기'));
    return sec;
  }

  function deleteRoutine(id) {
    const r = findRoutine(id);
    if (!r) return;
    if (state.active && state.active.routineId === id) {
      showStatus('error', '진행 중인 루틴은 지울 수 없어요.', '먼저 끝내거나 그만둔 뒤 지워 주세요.');
      renderRoutines();
      $('btnFinish').focus();
      return;
    }
    const chained = state.routines.filter((x) => x.anchor && x.anchor.type === 'routine' && x.anchor.routineId === id);
    chained.forEach((x) => { x.anchor = null; x.perWeek = x.perWeek || 3; });
    state.routines = state.routines.filter((x) => x.id !== id);
    if (ui.routine === id) { ui.routine = null; setHash(); }
    if (ui.editRoutine === id) resetRoutineForm();
    if (ui.panel && ui.panel.routineId === id) ui.panel = null;
    if (commit()) showStatus('info', q(r.name) + ' 루틴을 지웠어요.', '기록은 돌아보기에 남아 있어요.' +
      (chained.length ? ' ' + chained.map((x) => q(x.name)).join(', ') + '은(는) 이제 아무 때나 루틴(주 ' + chained[0].perWeek + '회)이에요.' : ''));
    renderAll();
    ($('btnNewRoutine') || $('tab-routines')).focus();
  }

  function setRoutineDays(days) { document.querySelectorAll('input[name="rDay"]').forEach((el) => { el.checked = days.includes(Number(el.value)); }); }
  function checkedRoutineDays() { return [...document.querySelectorAll('input[name="rDay"]:checked')].map((el) => Number(el.value)).sort(); }

  function selectedRadio(name) { const el = document.querySelector('input[name="' + name + '"]:checked'); return el ? el.value : null; }
  function setRadio(name, value) { document.querySelectorAll('input[name="' + name + '"]').forEach((el) => { el.checked = el.value === value; }); }

  const SITUATION_ANCHORS = ['block', 'routine', 'dayoff', 'situation'];
  /* 고른 루틴 종류와 상황 종류 → 시작 신호 종류: time | none | block | routine | dayoff | situation | null(아직) */
  function getAnchorType() {
    const kind = selectedRadio('rKind');
    if (kind === 'time') return 'time';
    if (kind === 'anytime') return 'none';
    if (kind === 'situation') return selectedRadio('rSit');
    return null;
  }
  function setAnchorType(type) {
    if (type === 'time') { setRadio('rKind', 'time'); setRadio('rSit', ''); }
    else if (type === 'none') { setRadio('rKind', 'anytime'); setRadio('rSit', ''); }
    else if (SITUATION_ANCHORS.includes(type)) { setRadio('rKind', 'situation'); setRadio('rSit', type); }
    else { setRadio('rKind', ''); setRadio('rSit', ''); }
  }
  /* 앞 단계를 정하면 다음 단계가 아래에 나타난다 (고칠 때는 모두 보임) */
  function toggleRoutineFields() {
    const editing = !!ui.editRoutine;
    const nameOk = editing || $('rName').value.trim() !== '';
    const kind = selectedRadio('rKind');
    const a = getAnchorType();
    $('stepKind').hidden = !nameOk;
    $('stepDetail').hidden = !(nameOk && kind);
    $('rTimeDetail').hidden = kind !== 'time';
    $('rSitDetail').hidden = kind !== 'situation';
    $('stepRest').hidden = !(nameOk && kind && (kind !== 'situation' || a));
    $('rAnchorBlockField').hidden = a !== 'block';
    $('rAnchorRoutineField').hidden = a !== 'routine';
    $('rAnchorSituationField').hidden = a !== 'situation';
    // 상황 루틴은 "주 N회" 대신 "상황이 올 때마다"
    const each = kind === 'situation';
    $('rPerWeekField').hidden = !kind || each;
    $('rEachField').hidden = !each || !a;
    const freq = selectedRadio('rFreq');
    $('rDaysField').hidden = freq !== 'days';
    $('rWeeklyField').hidden = freq !== 'weekly';
    const m = selectedRadio('rMeasure');
    $('rFixedField').hidden = m !== 'fixed';
    $('rCountField').hidden = m !== 'count';
  }

  function syncAnchorBlocks() {
    const sel = $('rAnchorBlock');
    const keep = sel.value;
    if (!state.blocks.length) {
      sel.replaceChildren(h('option', { value: '' }, '먼저 캘린더 탭에서 고정 일정을 넣어 주세요'));
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    const sorted = state.blocks.slice().sort((a, b) =>
      DAY_ORDER.indexOf(a.days.slice().sort((x, y) => DAY_ORDER.indexOf(x) - DAY_ORDER.indexOf(y))[0]) -
      DAY_ORDER.indexOf(b.days.slice().sort((x, y) => DAY_ORDER.indexOf(x) - DAY_ORDER.indexOf(y))[0]) ||
      C.toMin(a.end) - C.toMin(b.end));
    sel.replaceChildren(...sorted.map((b) => h('option', { value: b.id }, b.name + ' 끝나면 (' + daysText(b.days) + ' ' + b.end + ')')));
    if (keep && findBlock(keep)) sel.value = keep;
  }
  /* 다른 루틴을 끝내면: 고치는 루틴 자신은 뺀다 */
  function syncAnchorRoutines() {
    const sel = $('rAnchorRoutine');
    const keep = sel.value;
    const list = state.routines.filter((r) => r.id !== ui.editRoutine);
    if (!list.length) {
      sel.replaceChildren(h('option', { value: '' }, '먼저 다른 루틴을 하나 만들어 주세요'));
      sel.disabled = true;
    } else {
      sel.disabled = false;
      sel.replaceChildren(...list.map((r) => h('option', { value: r.id }, r.name + ' 끝내면')));
      if (keep && list.some((r) => r.id === keep)) sel.value = keep;
    }
    $('situationList').replaceChildren(...situationLabels().map((l) => h('option', { value: l })));
  }

  function resetRoutineForm() {
    ui.editRoutine = null;
    const form = $('routineForm');
    clearErrs(form);
    $('rName').value = '';
    $('rCategory').value = '공부';
    $('rPerWeek').value = '3';
    setRadio('rFreq', 'days');
    setRoutineDays([0, 1, 2, 3, 4, 5, 6]);
    $('rBase').value = '';
    $('rMin').value = '';
    setAnchorType(null);
    setRadio('rColor', nextColor());
    $('rAnchorTime').value = '';
    $('rAnchorSituation').value = '';
    setRadio('rMeasure', 'count');
    $('rCountUnit').value = '장';
    $('rFixedAmount').value = '';
    $('rFixedUnit').value = '';
    $('rSubmit').textContent = '루틴 만들기';
    $('rCancel').hidden = true;
    $('rDelete').hidden = true;
    $('rDeleteConfirm').hidden = true;
    syncAnchorBlocks();
    syncAnchorRoutines();
    toggleRoutineFields();
  }

  /* 새 루틴 만들기: 빈 폼을 화면 위 창으로 */
  function openNewRoutine() {
    if (ui.tab !== 'routines') switchTab('routines');
    resetRoutineForm();
    openEditDialog('routineForm', '새 루틴 만들기', () => $('btnNewRoutine') || $('tab-routines'), resetRoutineForm);
    $('rCancel').hidden = false;
    $('rCancel').textContent = '취소';
  }

  function editRoutine(id) {
    const r = findRoutine(id);
    if (!r) return;
    resetRoutineForm();
    ui.editRoutine = id;
    syncAnchorRoutines();
    $('rName').value = r.name;
    $('rCategory').value = r.category;
    $('rPerWeek').value = String(r.perWeek && r.perWeek < 7 ? r.perWeek : 3);
    if (C.scheduleOf(r) === 'weekly') setRadio('rFreq', 'weekly');
    else { setRadio('rFreq', 'days'); setRoutineDays(r.days || [0, 1, 2, 3, 4, 5, 6]); }
    $('rBase').value = String(r.baseMin);
    $('rMin').value = String(r.minMin);
    const a = r.anchor;
    if (a && a.type === 'block' && findBlock(a.blockId)) { setAnchorType('block'); $('rAnchorBlock').value = a.blockId; }
    else if (a && a.type === 'time') { setAnchorType('time'); $('rAnchorTime').value = a.time; }
    else if (a && a.type === 'routine' && findRoutine(a.routineId)) { setAnchorType('routine'); $('rAnchorRoutine').value = a.routineId; }
    else if (a && a.type === 'situation') { setAnchorType('situation'); $('rAnchorSituation').value = a.label; }
    else if (a && a.type === 'dayoff') setAnchorType('dayoff');
    else setAnchorType('none');
    setRadio('rMeasure', r.measure.type);
    if (r.measure.type === 'fixed') { $('rFixedAmount').value = String(r.measure.amount); $('rFixedUnit').value = r.measure.unit; }
    if (r.measure.type === 'count') $('rCountUnit').value = r.measure.unit;
    $('rSubmit').textContent = '고친 내용 저장';
    $('rCancel').hidden = false;
    $('rCancel').textContent = '수정 취소';
    $('rDelete').hidden = false;
    toggleRoutineFields();
    setRadio('rColor', colorOf(r));
    openEditDialog('routineForm', q(r.name) + ' 고치기', () => $('rdTitle') || $('rc-' + id) || $('tab-routines'), resetRoutineForm);
  }

  // ---------- 고치기 대화상자 ----------
  /* 고치기는 화면 위 대화상자로 띄운다. 기존 입력 폼을 대화상자 안으로 옮겼다가 닫을 때 제자리로 돌려놓아서
   * 입력 검사·저장 코드를 그대로 쓴다. returnTo: 닫은 뒤 초점을 돌려줄 요소를 찾는 함수 */
  let dialog = null;
  function openEditDialog(formId, title, returnTo, onClose) {
    if (dialog) closeEditDialog();
    const form = $(formId);
    const home = document.createComment('form-home');
    form.before(home);
    dialog = { form, home, returnTo, onClose };
    $('editDialogTitle').textContent = title;
    $('editDialogBody').append(form);
    const dlg = $('editDialog');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    const first = form.querySelector('input:not([type="radio"]):not([type="checkbox"]), select');
    if (first) first.focus();
  }
  function closeEditDialog() {
    const d = dialog;
    if (!d) return;
    dialog = null; // close 이벤트가 다시 불러도 한 번만 처리
    d.home.replaceWith(d.form);
    const dlg = $('editDialog');
    if (dlg.open) { if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open'); }
    if (d.onClose) d.onClose();
    const target = d.returnTo && d.returnTo();
    if (target) target.focus();
  }
  /* 가이드: 활동 다섯 가지가 어떻게 나뉘는지 */
  function openGuide() {
    const dlg = $('guideDialog');
    ui.guideReturn = document.activeElement;
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    $('guideClose').focus();
  }
  /* 설정 창: 하루 설정 · 공휴일 설정 · 기록 관리 */
  function openSettings() {
    const dlg = $('settingsDialog');
    $('settingsStatus').className = 'status';
    $('settingsStatus').replaceChildren();
    fillSettingsForm();
    renderHolidayInfo();
    $('sampleBox').hidden = !!hasAnyData();
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    $('settingsClose').focus();
  }
  function closeSettings() {
    const dlg = $('settingsDialog');
    if (dlg.open) { if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); }
  }
  function bindSettings() {
    $('btnSettings').addEventListener('click', openSettings);
    $('settingsClose').addEventListener('click', closeSettings);
    $('settingsDialog').addEventListener('click', (ev) => { if (ev.target === $('settingsDialog')) closeSettings(); });
    $('settingsDialog').addEventListener('close', () => { $('importConfirm').hidden = true; $('clearConfirm').hidden = true; $('btnSettings').focus(); });
  }

  function bindGuide() {
    document.querySelectorAll('[data-guide]').forEach((el) => el.addEventListener('click', openGuide));
    const close = () => { const dlg = $('guideDialog'); if (dlg.open) { if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); } };
    $('guideClose').addEventListener('click', close);
    $('guideDialog').addEventListener('click', (ev) => { if (ev.target === $('guideDialog')) close(); });
    $('guideDialog').addEventListener('close', () => { if (ui.guideReturn && document.contains(ui.guideReturn)) ui.guideReturn.focus(); });
  }

  function bindEditDialog() {
    $('editDialogClose').addEventListener('click', closeEditDialog);
    $('editDialog').addEventListener('close', closeEditDialog); // Esc
    $('editDialog').addEventListener('click', (ev) => { if (ev.target === $('editDialog')) closeEditDialog(); }); // 바깥 누르기
  }

  function bindRoutineForm() {
    document.querySelectorAll('input[name="rKind"], input[name="rSit"], input[name="rMeasure"]').forEach((el) => el.addEventListener('change', () => {
      if (el.name === 'rKind') setErr('stepKind', '', 'rKindErr');
      if (el.name === 'rSit') setErr('rSitDetail', '', 'rAnchorErr');
      toggleRoutineFields();
    }));
    $('rName').addEventListener('input', toggleRoutineFields);
    // 루틴 색 고르기 (1단계)
    $('rColorSwatches').replaceChildren(...S.COLORS.map((c) => h('label', { class: 'sw rc-' + c, title: COLOR_NAMES[c] },
      h('input', { type: 'radio', name: 'rColor', value: c }), h('span', { class: 'sw-dot', 'aria-hidden': 'true' }), h('span', { class: 'sr-only' }, COLOR_NAMES[c]))));
    $('rPerWeek').addEventListener('change', toggleRoutineFields);
    document.querySelectorAll('input[name="rFreq"]').forEach((el) => el.addEventListener('change', toggleRoutineFields));
    document.querySelectorAll('.quick-days [data-days]').forEach((b) => b.addEventListener('click', () => {
      setRoutineDays(b.dataset.days.split(',').map(Number));
      setErr('rDaysField', '', 'rDaysErr');
    }));
    document.querySelectorAll('input[name="rDay"]').forEach((el) => el.addEventListener('change', () => setErr('rDaysField', '', 'rDaysErr')));
    $('rCancel').addEventListener('click', () => { if (dialog) closeEditDialog(); else resetRoutineForm(); });
    // 지우기는 고치기 창 안에서, 한 번 더 묻고
    $('rDelete').addEventListener('click', () => {
      const r = findRoutine(ui.editRoutine);
      if (!r) return;
      const chained = state.routines.filter((x) => x.anchor && x.anchor.type === 'routine' && x.anchor.routineId === r.id);
      $('rDeleteText').textContent = q(r.name) + ' 루틴을 지울까요? 지금까지의 기록은 돌아보기에 남아요.' +
        (chained.length ? ' 이 루틴을 끝내면 시작하던 ' + chained.map((x) => q(x.name)).join(', ') + '은(는) 아무 때나 루틴이 돼요.' : '');
      $('rDeleteConfirm').hidden = false;
      $('rDeleteNo').focus();
    });
    $('rDeleteNo').addEventListener('click', () => { $('rDeleteConfirm').hidden = true; $('rDelete').focus(); });
    $('rDeleteYes').addEventListener('click', () => {
      const id = ui.editRoutine;
      closeEditDialog();
      deleteRoutine(id);
    });
    ['rName', 'rCategory', 'rBase', 'rMin', 'rFixedAmount', 'rFixedUnit', 'rCountUnit', 'rAnchorTime', 'rAnchorBlock', 'rAnchorRoutine', 'rAnchorSituation'].forEach((id) =>
      $(id).addEventListener('input', () => { if ($(id).getAttribute('aria-invalid')) setErr(id, '', id.startsWith('rAnchor') ? 'rAnchorErr' : null); }));

    $('routineForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const form = $('routineForm');
      clearErrs(form);
      const errs = [
        setErr('rName', C.checkName($('rName').value)),
        setErr('rCategory', C.checkCategory($('rCategory').value))
      ];
      const baseMsg = C.checkMinutes($('rBase').value);
      errs.push(setErr('rBase', baseMsg));
      let minMsg = C.checkMinutes($('rMin').value);
      if (!minMsg && !baseMsg && Number($('rMin').value) >= Number($('rBase').value)) minMsg = '최소 시간은 기본보다 짧게 적어 주세요';
      errs.push(setErr('rMin', minMsg));

      const anchorType = getAnchorType();
      let anchor = null;
      if (!selectedRadio('rKind')) errs.push(setErr('stepKind', '어떤 루틴인지 골라 주세요', 'rKindErr'));
      else if (!anchorType) errs.push(setErr('rSitDetail', '어떤 상황이 되면 할지 골라 주세요', 'rAnchorErr'));
      if (anchorType === 'block') {
        if (!$('rAnchorBlock').value || !findBlock($('rAnchorBlock').value)) errs.push(setErr('rAnchorBlock', '고정 일정을 골라 주세요. 없다면 캘린더 탭에서 먼저 넣어 주세요', 'rAnchorErr'));
        else anchor = { type: 'block', blockId: $('rAnchorBlock').value };
      } else if (anchorType === 'time') {
        if (isNaN(C.toMin($('rAnchorTime').value))) errs.push(setErr('rAnchorTime', '시작할 시각을 골라 주세요', 'rAnchorErr'));
        else anchor = { type: 'time', time: $('rAnchorTime').value };
      } else if (anchorType === 'routine') {
        const rid = $('rAnchorRoutine').value;
        if (!rid || !findRoutine(rid) || rid === ui.editRoutine) errs.push(setErr('rAnchorRoutine', '어느 루틴을 끝내면 시작할지 골라 주세요', 'rAnchorErr'));
        else anchor = { type: 'routine', routineId: rid };
      } else if (anchorType === 'situation') {
        const msg = C.checkSituationLabel($('rAnchorSituation').value);
        if (msg) errs.push(setErr('rAnchorSituation', msg, 'rAnchorErr'));
        else anchor = { type: 'situation', label: $('rAnchorSituation').value.trim() };
      } else if (anchorType === 'dayoff') {
        anchor = { type: 'dayoff' };
      }

      // 얼마나 자주: 상황 루틴은 상황이 올 때마다, 그 밖에는 요일 또는 주 몇 번
      const isSit = SITUATION_ANCHORS.includes(anchorType);
      const freqDays = !isSit && selectedRadio('rFreq') === 'days';
      const freqWeekly = !isSit && selectedRadio('rFreq') === 'weekly';
      if (freqDays && !checkedRoutineDays().length) errs.push(setErr('rDaysField', '요일을 하나 이상 골라 주세요', 'rDaysErr'));

      const measureType = selectedRadio('rMeasure');
      let measure = { type: 'none' };
      if (measureType === 'fixed') {
        errs.push(setErr('rFixedAmount', C.checkAmount($('rFixedAmount').value)));
        errs.push(setErr('rFixedUnit', C.checkUnit($('rFixedUnit').value)));
        measure = { type: 'fixed', amount: Number($('rFixedAmount').value), unit: $('rFixedUnit').value.trim() };
      } else if (measureType === 'count') {
        errs.push(setErr('rCountUnit', C.checkUnit($('rCountUnit').value)));
        measure = { type: 'count', unit: $('rCountUnit').value.trim() };
      }
      if (focusFirst(errs)) return;

      const data = {
        name: $('rName').value.trim(),
        category: $('rCategory').value.trim() || '기타',
        perWeek: freqWeekly ? Number($('rPerWeek').value) : null,
        days: freqDays ? checkedRoutineDays() : null,
        baseMin: Number($('rBase').value),
        minMin: Number($('rMin').value),
        anchor, measure,
        color: selectedRadio('rColor') || nextColor(ui.editRoutine)
      };
      const editing = ui.editRoutine && findRoutine(ui.editRoutine);
      let saved;
      if (editing) {
        saved = Object.assign(editing, data);
      } else {
        saved = Object.assign({ id: uid('r') }, data, { createdAt: new Date().toISOString() });
        state.routines.push(saved);
      }
      if (commit()) {
        showStatus('info', editing ? q(saved.name) + ' 루틴을 고쳤어요.' : q(saved.name) + ' 루틴을 만들었어요.',
          anchorPhrase(saved) + ' → ' + saved.name + ', ' + goalText(saved) + '. 오늘 탭에서 시작할 수 있어요.');
      }
      resetRoutineForm();
      renderAll();
      if (dialog) closeEditDialog(); else $('rName').focus();
      if (!editing) openRoutine(saved.id);
    });
  }

  // ========== 고정 일정 (캘린더 탭) ==========
  function deleteBlock(id) {
    const b = findBlock(id);
    if (!b) return;
    const anchored = state.routines.filter((r) => r.anchor && r.anchor.type === 'block' && r.anchor.blockId === id);
    // 시작 신호가 사라진 루틴은 아무 때나 루틴(주 N회)으로. 상황 루틴이라 주 N회가 없었다면 주 3회
    anchored.forEach((r) => { r.anchor = null; if (!r.perWeek && !(Array.isArray(r.days) && r.days.length)) r.perWeek = 3; });
    state.blocks = state.blocks.filter((x) => x.id !== id);
    if (ui.editBlock === id) resetBlockForm();
    if (commit()) showStatus('info', q(b.name) + ' 고정 일정을 지웠어요.',
      anchored.length ? anchored.map((r) => q(r.name)).join(', ') + '은(는) 이제 아무 때나 루틴이에요. 루틴 탭에서 얼마나 자주 할지 확인해 주세요.' : '');
    renderAll();
    ($('btnNewBlock') || $('tab-calendar')).focus();
  }

  function checkedDays() {
    return [...document.querySelectorAll('input[name="bDay"]:checked')].map((el) => Number(el.value));
  }

  function resetBlockForm() {
    ui.editBlock = null;
    clearErrs($('blockForm'));
    $('bName').value = '';
    $('bKind').value = '수업';
    document.querySelectorAll('input[name="bDay"]').forEach((el) => { el.checked = false; });
    $('bStart').value = '';
    $('bEnd').value = '';
    $('bSubmit').textContent = '고정 일정 넣기';
    $('bDelete').hidden = true;
    $('bDeleteConfirm').hidden = true;
    $('bCancel').hidden = true;
  }

  function editBlock(id) {
    const b = findBlock(id);
    if (!b) return;
    resetBlockForm();
    ui.editBlock = id;
    $('bName').value = b.name;
    $('bKind').value = b.kind;
    document.querySelectorAll('input[name="bDay"]').forEach((el) => { el.checked = b.days.includes(Number(el.value)); });
    $('bStart').value = b.start;
    $('bEnd').value = b.end;
    $('bSubmit').textContent = '고친 내용 저장';
    $('bCancel').hidden = false;
    $('bDelete').hidden = false;
    const from = document.activeElement;
    openEditDialog('blockForm', q(b.name) + ' 고치기', () => {
      if (from && document.contains(from)) return from;
      const item = $('bc-' + id);
      return item ? item.querySelector('button') : $('tab-calendar');
    }, resetBlockForm);
  }

  function bindBlockForm() {
    $('bCancel').addEventListener('click', () => { if (dialog) closeEditDialog(); else resetBlockForm(); });
    $('bDelete').addEventListener('click', () => {
      const b = findBlock(ui.editBlock);
      if (!b) return;
      const anchored = state.routines.filter((r) => r.anchor && r.anchor.type === 'block' && r.anchor.blockId === b.id);
      $('bDeleteText').textContent = q(b.name) + ' 고정 일정을 지울까요?' + (anchored.length
        ? ' 이걸 시작 신호로 쓰는 루틴(' + anchored.map((r) => r.name).join(', ') + ')은 아무 때나 루틴이 돼요.' : '');
      $('bDeleteConfirm').hidden = false;
      $('bDeleteNo').focus();
    });
    $('bDeleteNo').addEventListener('click', () => { $('bDeleteConfirm').hidden = true; $('bDelete').focus(); });
    $('bDeleteYes').addEventListener('click', () => {
      const id = ui.editBlock;
      closeEditDialog();
      deleteBlock(id);
    });
    ['bName', 'bStart', 'bEnd'].forEach((id) => $(id).addEventListener('input', () => { if ($(id).getAttribute('aria-invalid')) setErr(id, ''); }));
    document.querySelectorAll('input[name="bDay"]').forEach((el) => el.addEventListener('change', () => setErr('bDaysSet', '', 'bDaysErr')));

    $('blockForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      clearErrs($('blockForm'));
      const days = checkedDays();
      const errs = [setErr('bName', C.checkName($('bName').value))];
      errs.push(days.length ? null : setErr('bDaysSet', '요일을 하나 이상 골라 주세요', 'bDaysErr'));
      const range = C.checkTimeRange($('bStart').value, $('bEnd').value);
      if (range) errs.push(setErr(range.field === 'start' ? 'bStart' : 'bEnd', range.msg));
      if (focusFirst(errs)) return;

      const data = { name: $('bName').value.trim(), kind: $('bKind').value, days: days.sort(), start: $('bStart').value, end: $('bEnd').value };
      const editing = ui.editBlock && findBlock(ui.editBlock);
      const overlaps = C.findOverlaps(state.blocks, data, editing ? editing.id : null);
      let saved;
      if (editing) saved = Object.assign(editing, data);
      else { saved = Object.assign({ id: uid('b') }, data); state.blocks.push(saved); }
      if (commit()) {
        const warn = overlaps.length
          ? overlaps.slice(0, 2).map((o) => C.DAY_NAMES[o.day] + '요일 ' + q(o.block.name)).join(', ') + '와(과) 시간이 겹쳐요. 맞는지 확인해 주세요.'
          : '오늘 탭의 빈 시간에 바로 반영돼요.';
        showStatus('info', editing ? q(saved.name) + ' 고정 일정을 고쳤어요.' : q(saved.name) + ' 고정 일정을 넣었어요.', warn);
      }
      resetBlockForm();
      renderAll();
      if (dialog) closeEditDialog(); else $('bName').focus();
    });
  }

  function fillSettingsForm() {
    if ($('settingsForm').contains(document.activeElement)) return;
    $('sDayStart').value = state.settings.dayStart;
    $('sDayEnd').value = state.settings.dayEnd;
    $('sBuffer').value = String(state.settings.bufferMin);
    const off = C.holidayOff(state.settings);
    document.querySelectorAll('input[name="sHolidayOff"]').forEach((el) => { el.checked = off.includes(el.value); });
  }

  function bindSettingsForm() {
    $('settingsForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      clearErrs($('settingsForm'));
      const errs = [];
      const range = C.checkSettings($('sDayStart').value, $('sDayEnd').value);
      if (range) errs.push(setErr(range.field === 'start' ? 'sDayStart' : 'sDayEnd', range.msg));
      const buf = $('sBuffer').value.trim();
      if (!/^\d+$/.test(buf) || Number(buf) > 30) errs.push(setErr('sBuffer', '0~30 사이의 분으로 적어 주세요'));
      if (focusFirst(errs)) return;
      state.settings = {
        dayStart: $('sDayStart').value, dayEnd: $('sDayEnd').value, bufferMin: Number(buf),
        holidayOff: C.holidayOff(state.settings)
      };
      const over = C.rolloverMin(state.settings) > 0;
      if (commit()) showStatus('info', '하루 설정을 저장했어요.', state.settings.dayStart + '–' + state.settings.dayEnd + (over ? '(다음 날)' : '') +
        ', 전환 시간 ' + state.settings.bufferMin + '분' + (over ? '. 자정부터 ' + state.settings.dayEnd + '까지 한 일은 전날로 쳐요.' : ''));
      renderAll();
    });
  }

  // ========== 돌아보기 ==========
  function renderReview() {
    const box = $('reviewDyn');
    const nodes = [h('h2', { class: 'sr-only', tabindex: '-1' }, '돌아보기')];
    if (!state.records.length) {
      nodes.push(emptyBox('아직 기록이 없어요.', '오늘 탭에서 루틴이나 다른 활동을 시작해 보세요. 끝내면 여기에 쌓여요.',
        h('button', { type: 'button', class: 'btn', onclick: () => switchTab('today', 'todayH') }, '오늘 탭으로')));
      box.replaceChildren(...nodes);
      return;
    }
    const sug = suggestionSection();
    if (sug) nodes.push(sug);
    if (state.routines.length) nodes.push(routineLinks());
    nodes.push(ratioSection());
    nodes.push(recordsSection());
    box.replaceChildren(...nodes);
  }

  // ---------- 규칙 다듬기 제안 (루티) ----------
  /* 루티: 제안을 건네는 동그란 캐릭터 (임시 디자인) */
  function rutiFace(size) {
    const NS = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs) => { const n = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); return n; };
    const svg = el('svg', { viewBox: '0 0 40 40', width: String(size || 40), height: String(size || 40), 'aria-hidden': 'true', class: 'ruti' });
    svg.append(
      el('circle', { cx: '20', cy: '21', r: '17', fill: 'var(--teal-mid)' }),
      el('circle', { cx: '14', cy: '19', r: '2.2', fill: 'var(--ink)' }),
      el('circle', { cx: '26', cy: '19', r: '2.2', fill: 'var(--ink)' }),
      el('path', { d: 'M14 26 Q20 31 26 26', fill: 'none', stroke: 'var(--ink)', 'stroke-width': '2', 'stroke-linecap': 'round' }),
      el('circle', { cx: '11', cy: '24', r: '2', fill: 'var(--cream)', opacity: '0.9' }),
      el('circle', { cx: '29', cy: '24', r: '2', fill: 'var(--cream)', opacity: '0.9' }));
    return svg;
  }

  function activeSuggestions() {
    const dismissed = state.dismissed || [];
    return C.suggestions(state.records, state.routines, new Date(), shift(), sitEnv())
      .filter((s) => !dismissed.includes(s.key) && findRoutine(s.routineId));
  }
  function actionable(list) { return list.filter((s) => s.kind !== 'steady'); }

  /* 제안 하나를 문장·버튼·근거로 */
  function suggestionView(s) {
    const r = findRoutine(s.routineId);
    const v = { text: '', apply: null, edit: false, why: '' };
    if (s.kind === 'perWeek') {
      v.text = q(r.name) + '은(는) 지난 2주 동안 ' + perWeekText(s.from) + ' 목표에 ' + s.counts.join('·') + '번 했어요. ' + perWeekText(s.to) + '로 낮춰 볼까요?';
      v.apply = perWeekText(s.to) + '로 바꾸기';
      v.why = '주 몇 번 루틴이 지난 2주 연속 목표를 못 채우고, 2주 평균(' + C.round1((s.counts[0] + s.counts[1]) / 2) + '번)이 목표보다 1번 이상 적을 때 제안해요. 평균을 반올림한 횟수예요.';
    } else if (s.kind === 'baseMin') {
      const last5 = state.records.filter((x) => x.routineId === r.id && x.version !== 'min')
        .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)).slice(-5).map((x) => x.actualMin);
      v.text = q(r.name) + ' 기본 시간은 ' + s.from + '분인데, 최근에는 보통 ' + Math.round(s.median) + '분 걸렸어요. 기본을 ' + s.to + '분으로 바꿔 볼까요?';
      v.apply = '기본 ' + s.to + '분으로 바꾸기';
      v.why = '기본 버전 기록이 5개 이상이고, 최근 5번의 중앙값이 기본 시간과 20% 이상, 5분 이상 다를 때 제안해요. 최근 5번: ' +
        last5.join('·') + '분 → 중앙값 ' + Math.round(s.median) + '분을 5분 단위로 맞췄어요.';
    } else if (s.kind === 'dropDay') {
      const stats = C.dayStats(state.records, r, new Date(), shift());
      v.text = q(r.name) + '은(는) 지난 4주 동안 ' + C.DAY_NAMES[s.day] + '요일에 ' + s.total + '번 중 ' + s.done + '번 했어요. ' +
        C.DAY_NAMES[s.day] + '요일을 빼고 ' + daysGoal(s.to) + '로 해 볼까요?';
      v.apply = C.DAY_NAMES[s.day] + '요일 빼기';
      v.why = '요일을 정한 루틴에서, 지난 4주 동안 4번 중 1번 이하로 한 요일이 있을 때 제안해요 (요일이 2개 이상일 때만). 요일별: ' +
        stats.map((x) => C.DAY_NAMES[x.day] + ' ' + x.done + '/' + x.total).join(' · ');
    } else if (s.kind === 'situationLow') {
      const lead = q(r.name) + '은(는) 지난 4주 동안 상황이 ' + s.occ + '번 생겼는데 ' + s.hit + '번 했어요 (' + anchorPhrase(r) + '). ';
      if (s.to) {
        v.text = lead + '최소 시간을 ' + s.from + '분에서 ' + s.to + '분으로 줄여 볼까요?';
        v.apply = '최소 ' + s.to + '분으로 줄이기';
      } else {
        v.text = lead + '시작 신호를 바꿔 보는 건 어때요?';
        v.edit = true;
      }
      v.why = '상황 루틴의 지난 4주 실천이 절반보다 적을 때(상황이 4번 이상 있었을 때) 제안해요. 최소 시간이 5분보다 길면 절반으로 줄이자고, 이미 짧으면 시작 신호를 바꿔 보자고 해요.';
    } else {
      v.text = q(r.name) + '은(는) 지난 4주 내내 목표를 채웠어요.';
      v.why = '주 몇 번 루틴이 지난 4주 모두 목표를 채웠을 때 알려 드려요. 횟수를 늘리자고는 하지 않아요.';
    }
    return v;
  }

  /* 오늘 탭 날짜 옆 칩: 누르면 제안 창 */
  function reviewBanner() {
    const n = actionable(activeSuggestions()).length;
    if (!n) return null;
    return h('button', { type: 'button', class: 'chip-btn', onclick: (ev) => openSuggestions(ev.currentTarget), 'aria-label': '루티의 제안 ' + n + '개 보기' },
      '제안 ' + n + '개');
  }

  /* 돌아보기 맨 위: 펼치지 않고 "루티가 제안 N개를 가져왔어요"만 */
  function suggestionSection() {
    const list = activeSuggestions();
    if (!list.length) return null;
    const n = actionable(list).length;
    return h('section', { class: 'ruti-card', 'aria-labelledby': 'suggestH' },
      rutiFace(44),
      h('div', { class: 'ruti-main' },
        h('h3', { id: 'suggestH', tabindex: '-1' }, n ? '루티가 규칙을 다듬을 제안 ' + n + '개를 가져왔어요' : '루티가 전할 소식이 있어요'),
        h('p', { class: 'sub' }, '기록을 보고 고르면 좋을 것만 골랐어요.')),
      h('button', { type: 'button', class: 'btn small primary', onclick: (ev) => openSuggestions(ev.currentTarget) }, n ? '제안 보기' : '보기'));
  }

  function openSuggestions(opener) {
    ui.suggestReturn = opener || null;
    renderSuggestList();
    const dlg = $('suggestDialog');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    const first = $('suggestBody').querySelector('button');
    (first || $('suggestClose')).focus();
  }
  function closeSuggestions() {
    const dlg = $('suggestDialog');
    if (dlg.open) { if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); }
  }
  function renderSuggestList() {
    const list = activeSuggestions();
    const body = $('suggestBody');
    if (!list.length) {
      body.replaceChildren(h('p', { class: 'sub' }, '지금은 제안할 게 없어요. 기록이 쌓이면 다시 살펴볼게요.'));
      return;
    }
    body.replaceChildren(h('ul', { class: 'suggest-list' }, list.map((s) => {
      const v = suggestionView(s);
      return h('li', { class: 'suggest' },
        h('p', null, v.text),
        h('details', { class: 'why' }, h('summary', null, '왜 이 제안이에요?'), h('p', null, v.why)),
        h('div', { class: 'row' },
          v.apply ? h('button', { type: 'button', class: 'btn small primary', onclick: () => applySuggestion(s) }, v.apply) : null,
          v.edit ? h('button', {
            type: 'button', class: 'btn small primary',
            onclick: () => { dismissSuggestion(s.key); commit(); closeSuggestions(); openRoutine(s.routineId); editRoutine(s.routineId); }
          }, '루틴 고치기') : null,
          h('button', { type: 'button', class: 'btn small ghost', onclick: () => { dismissSuggestion(s.key); commit(); afterSuggestion(); } },
            v.apply || v.edit ? '이번 주는 넘어가기' : '확인')));
    })));
  }
  function afterSuggestion() {
    renderAll();
    if (!$('suggestDialog').open) { const t = $('rdTitle') || $('tab-' + ui.tab); if (t) t.focus(); return; }
    renderSuggestList();
    const first = $('suggestBody').querySelector('button');
    (first || $('suggestClose')).focus();
  }

  function dismissSuggestion(key) {
    const week = key.split('|')[0];
    state.dismissed = (state.dismissed || []).filter((k) => k.startsWith(week + '|')).concat(key);
  }

  function applySuggestion(s) {
    const r = findRoutine(s.routineId);
    if (!r) return;
    let done = '';
    if (s.kind === 'perWeek') { r.perWeek = s.to; done = perWeekText(s.to) + '로'; }
    if (s.kind === 'baseMin') { r.baseMin = s.to; done = '기본 ' + s.to + '분으로'; }
    if (s.kind === 'dropDay') { r.days = s.to; done = daysGoal(s.to) + '로'; }
    if (s.kind === 'situationLow' && s.to) { r.minMin = s.to; done = '최소 ' + s.to + '분으로'; }
    dismissSuggestion(s.key);
    if (commit()) showStatus('info', q(r.name) + ' 루틴을 ' + done + ' 바꿨어요.', '되돌리려면 루틴 탭에서 연필을 눌러 고치면 돼요.');
    afterSuggestion();
  }

  function bindSuggestions() {
    $('suggestTitle').prepend(rutiFace(28));
    $('suggestClose').addEventListener('click', closeSuggestions);
    $('suggestDialog').addEventListener('click', (ev) => { if (ev.target === $('suggestDialog')) closeSuggestions(); });
    $('suggestDialog').addEventListener('close', () => {
      const t = ui.suggestReturn;
      if (t && document.contains(t)) t.focus();
      else { const h3 = $('suggestH'); if (h3) h3.focus(); }
    });
  }

  /* 루틴마다 변화·기록 달력은 루틴 상세에 있다 */
  function routineLinks() {
    return h('section', { class: 'section', 'aria-labelledby': 'obsH' },
      h('h3', { id: 'obsH' }, '루틴별로 보기'),
      h('p', { class: 'sub' }, '걸린 시간의 변화, 지난 5주 기록, 시작까지 걸린 시간은 루틴마다 자세히 볼 수 있어요.'),
      h('div', { class: 'rlinks' }, state.routines.map((r) =>
        h('button', { type: 'button', class: 'rlink ' + rc(r), onclick: () => openRoutine(r.id) }, h('span', { class: 'rc-dot', 'aria-hidden': 'true' }), r.name))));
  }

  function ratioSection() {
    const stats = C.categoryStats(state.records);
    const max = Math.max(...stats.map((s) => Math.max(s.est, s.act) / s.n));
    return h('section', { class: 'card', 'aria-labelledby': 'ratioH' },
      h('div', { class: 'section-head' }, h('h3', { id: 'ratioH' }, '카테고리별 배율'),
        h('div', { class: 'legend', 'aria-hidden': 'true' }, h('span', { class: 'lg-est' }, '평균 예상'), h('span', { class: 'lg-act' }, '평균 실제'))),
      h('p', { class: 'sub' }, '배율 = 실제 시간 합 ÷ 예상 시간 합. 기록이 3개 이상인 카테고리만 계산해요.'),
      h('div', { class: 'ratios' }, stats.map((s) => {
        const enough = s.n >= C.CALIBRATE_FROM;
        const avgE = s.est / s.n, avgA = s.act / s.n;
        return h('div', { class: 'ratio' },
          h('span', { class: 'cat' }, s.category),
          h('span', { class: 'bars', 'aria-hidden': 'true' },
            h('i', { class: 'e', style: 'width:' + (avgE / max * 100) + '%' }),
            h('i', { class: 'a', style: 'width:' + (avgA / max * 100) + '%' })),
          h('span', { class: 'val' }, enough ? s.ratio.toFixed(1) + '×' : '–'),
          h('span', { class: 'note' }, enough
            ? ratioText(s.ratio) + ' · 기록 ' + s.n + '개, 평균 예상 ' + Math.round(avgE) + '분 → 실제 ' + Math.round(avgA) + '분'
            : '기록 ' + s.n + '개 · 3개가 쌓이면 배율을 보여 드려요'));
      })));
  }

  function recordsSection() {
    const cats = ['전체'].concat([...new Set(state.records.map((r) => r.category))]);
    if (!cats.includes(ui.filter)) ui.filter = '전체';
    const chips = h('div', { class: 'chips', role: 'group', 'aria-label': '카테고리로 거르기' }, cats.map((c) =>
      h('button', {
        type: 'button', 'aria-pressed': String(c === ui.filter),
        onclick: () => { ui.filter = c; ui.showAll = false; renderReview(); const b = document.querySelector('#reviewDyn .chips [aria-pressed="true"]'); if (b) b.focus(); }
      }, c)));
    const list = state.records.filter((r) => ui.filter === '전체' || r.category === ui.filter)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const shown = ui.showAll ? list : list.slice(0, RECORDS_PAGE);

    const sec = h('section', { class: 'card', 'aria-labelledby': 'recH' },
      h('div', { class: 'section-head' }, h('h3', { id: 'recH' }, '기록'), h('span', { class: 'sub num' }, list.length + '개')),
      chips);
    if (!list.length) {
      sec.append(emptyBox(q(ui.filter) + ' 기록이 없어요.', '다른 카테고리를 고르거나 전체를 보세요.'));
      return sec;
    }
    sec.append(h('ul', { class: 'plain', id: 'recordList' }, shown.map((r) => {
      const routine = r.routineId ? findRoutine(r.routineId) : null;
      const kind = r.kind === 'task' ? '다른 활동' : (r.version === 'min' ? '루틴 · 최소' : C.countsAsDone(r) ? '루틴' : '루틴 · 최소 미만');
      const amountUnit = routine && routine.measure.unit ? routine.measure.unit : '';
      const label = q(r.name) + ' ' + dateText(r.startedAt);
      const li = h('li', { class: 'rec', id: 'rec-' + r.id },
        h('span', { class: 'rec-name' }, r.name),
        h('span', { class: 'rec-times' }, r.estimateMin + '→' + r.actualMin + '분'),
        h('span', { class: 'rec-meta' }, r.category + ' · ' + dateText(r.startedAt) + ' · ' + kind +
          (r.amount ? ' · ' + r.amount + amountUnit : ''),
          r.source === 'manual' ? h('span', { class: 'tag' }, '직접 입력') : null,
          r.edited ? h('span', { class: 'tag' }, '고침') : null),
        h('span', { class: 'rec-del' }, pencilBtn(label + ' 기록 고치기', () => (ui.editRecord === r.id ? closeRecordEdit(r.id) : openRecordEdit(r.id, 'review')), 'edit')));
      if (ui.editRecord === r.id && ui.editWhere === 'review') li.append(recordEditForm(r, routine));
      return li;
    })));
    if (list.length > shown.length) {
      sec.append(h('button', {
        type: 'button', class: 'btn', onclick: () => { ui.showAll = true; renderReview(); const items = document.querySelectorAll('#recordList .rec-del .edit'); if (items[RECORDS_PAGE]) items[RECORDS_PAGE].focus(); }
      }, '더 보기 (' + (list.length - shown.length) + '개 남음)'));
    }
    return sec;
  }

  function recordItem(id) { return $((ui.editWhere === 'detail' ? 'rrec-' : 'rec-') + id); }
  function focusRecordBtn(id) {
    const li = recordItem(id);
    const btn = li && li.querySelector('.edit');
    if (btn) btn.focus();
  }
  function openRecordEdit(id, where) {
    ui.editRecord = id;
    ui.editWhere = where || 'review';
    renderReview();
    renderRoutines();
    const li = recordItem(id);
    const first = li && li.querySelector('form input');
    if (first) first.focus();
  }
  function closeRecordEdit(id) {
    ui.editRecord = null;
    renderReview();
    renderRoutines();
    focusRecordBtn(id);
  }

  /* 기록 고치기: 실제 시간, 예상 시간, (분량을 세는 루틴이면) 분량 */
  function recordEditForm(r, routine) {
    const counts = !!(routine && routine.measure.type === 'count');
    const form = h('form', { class: 'panel rec-edit', novalidate: true },
      h('div', { class: 'grid2' },
        h('div', { class: 'field' },
          h('label', { for: 'eAct' }, '실제 시간 (분)'),
          h('input', { id: 'eAct', inputmode: 'numeric', autocomplete: 'off', value: String(r.actualMin), 'aria-describedby': 'eActErr' }),
          h('p', { class: 'err', id: 'eActErr' })),
        h('div', { class: 'field' },
          h('label', { for: 'eEst' }, '예상 시간 (분)'),
          h('input', { id: 'eEst', inputmode: 'numeric', autocomplete: 'off', value: String(r.estimateMin), 'aria-describedby': 'eEstErr' }),
          h('p', { class: 'err', id: 'eEstErr' }))),
      counts ? h('div', { class: 'field' },
        h('label', { for: 'eAmt' }, '분량 (' + routine.measure.unit + ', 모르면 비워 두세요)'),
        h('input', { id: 'eAmt', inputmode: 'numeric', autocomplete: 'off', value: r.amount ? String(r.amount) : '', 'aria-describedby': 'eAmtErr' }),
        h('p', { class: 'err', id: 'eAmtErr' })) : null,
      h('div', { class: 'row' },
        h('button', { type: 'submit', class: 'btn primary small' }, '고친 내용 저장'),
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => closeRecordEdit(r.id) }, '취소'),
        h('button', { type: 'button', class: 'btn small danger push-right', onclick: () => deleteRecord(r.id) }, '기록 지우기')));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      clearErrs(form);
      const errs = [setErr('eAct', C.checkMinutes($('eAct').value)), setErr('eEst', C.checkMinutes($('eEst').value))];
      if (counts && $('eAmt').value.trim() !== '') errs.push(setErr('eAmt', C.checkAmount($('eAmt').value)));
      if (focusFirst(errs)) return;
      r.actualMin = Number($('eAct').value);
      r.estimateMin = Number($('eEst').value);
      if (counts) r.amount = $('eAmt').value.trim() ? Number($('eAmt').value) : null;
      r.endedAt = new Date(Date.parse(r.startedAt) + r.actualMin * 60000).toISOString();
      r.edited = true;
      ui.editRecord = null;
      if (commit()) showStatus('info', q(r.name) + ' 기록을 고쳤어요.', '예상 ' + r.estimateMin + '분 → 실제 ' + r.actualMin + '분');
      renderAll();
      focusRecordBtn(r.id);
    });
    return form;
  }

  /* 지우고 나서 상태 안내의 "되돌리기"로 바로 되살릴 수 있다 */
  function deleteRecord(id) {
    const idx = [...document.querySelectorAll('#recordList > li')].findIndex((li) => li.id === 'rec-' + id);
    const at = state.records.findIndex((r) => r.id === id);
    if (at === -1) return;
    const rec = state.records[at];
    state.records.splice(at, 1);
    if (ui.editRecord === id) ui.editRecord = null;
    if (commit()) {
      showStatus('info', q(rec.name) + ' 기록을 지웠어요.', dateText(rec.startedAt) + ' · ' + rec.actualMin + '분', {
        label: '되돌리기',
        onclick: () => {
          if (state.records.some((r) => r.id === rec.id)) return;
          state.records.splice(Math.min(at, state.records.length), 0, rec);
          if (commit()) showStatus('info', q(rec.name) + ' 기록을 되돌렸어요.');
          renderAll();
          const btn = document.querySelector('#rec-' + CSS.escape(rec.id) + ' .edit');
          if (btn) btn.focus();
        }
      });
    }
    renderAll();
    if (ui.tab === 'routines') { const t = $('rdRecH') || $('rdTitle'); if (t) { t.tabIndex = -1; t.focus(); } return; }
    const after = [...document.querySelectorAll('#recordList .rec-del .edit')];
    const target = after[Math.max(0, Math.min(idx, after.length - 1))];
    if (target) target.focus(); else { const t = $('tab-review'); if (t) t.focus(); }
  }

  // ---------- 내보내기·가져오기·전체 삭제·예시 ----------
  function countsText(d) {
    return '고정 일정 ' + d.blocks.length + '개, 루틴 ' + d.routines.length + '개, 기록 ' + d.records.length + '개';
  }

  function bindData() {
    $('btnExport').addEventListener('click', () => {
      try {
        const name = 'routinemaker-' + C.dayKey(new Date()) + '.json';
        const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
        const a = h('a', { href: url, download: name });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        showStatus('info', '기록을 파일로 내보냈어요.', name + ' · 다운로드 폴더를 확인해 주세요.');
      } catch (e) {
        showStatus('error', '파일을 만들지 못했어요.', '브라우저가 다운로드를 막고 있을 수 있어요. 다른 브라우저에서 다시 시도해 주세요.');
      }
    });

    $('btnImport').addEventListener('click', () => $('fileImport').click());
    $('fileImport').addEventListener('change', (ev) => {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      showStatus('info loading', '기록을 불러오는 중이에요');
      const reader = new FileReader();
      reader.onload = () => {
        const res = S.parseImport(String(reader.result));
        if (!res.ok) {
          showStatus('error', '이 앱에서 내보낸 파일만 가져올 수 있어요.', '기존 기록은 그대로예요. 내보내기로 만든 .json 파일을 골라 주세요.');
          $('btnImport').focus();
          return;
        }
        if (hasAnyData()) {
          ui.pendingImport = res.data;
          $('importConfirmText').textContent = '가져오면 지금 데이터(' + countsText(state) + ')가 파일 내용(' + countsText(res.data) + ')으로 바뀌어요. 지금 데이터가 필요하면 먼저 내보내 두세요.';
          $('importConfirm').hidden = false;
          clearStatus();
          $('btnImportNo').focus();
        } else applyImport(res.data);
      };
      reader.onerror = () => showStatus('error', '파일을 읽지 못했어요.', '기존 기록은 그대로예요. 다시 시도해 주세요.');
      reader.readAsText(file);
    });
    $('btnImportNo').addEventListener('click', () => {
      ui.pendingImport = null;
      $('importConfirm').hidden = true;
      showStatus('info', '가져오기를 취소했어요.', '기존 기록은 그대로예요.');
      $('btnImport').focus();
    });
    $('btnImportYes').addEventListener('click', () => {
      const d = ui.pendingImport;
      ui.pendingImport = null;
      $('importConfirm').hidden = true;
      if (d) applyImport(d);
    });

    $('btnClear').addEventListener('click', () => {
      if (!hasAnyData()) { showStatus('info', '지울 데이터가 없어요.'); return; }
      $('clearConfirmText').textContent = countsText(state) + (state.active ? ', 진행 중인 일 1개' : '') +
        '를 모두 지울까요? 되돌릴 수 없어요. 먼저 내보내기를 해 두면 안전해요.';
      $('clearConfirm').hidden = false;
      $('btnClearNo').focus();
    });
    $('btnClearNo').addEventListener('click', () => { $('clearConfirm').hidden = true; $('btnClear').focus(); });
    $('btnClearYes').addEventListener('click', () => {
      state = S.empty();
      ui.panel = null; ui.filter = '전체'; ui.editRecord = null;
      resetBlockForm();
      resetRoutineForm();
      $('clearConfirm').hidden = true;
      if (commit()) showStatus('info', '모든 데이터를 지웠어요.', '캘린더 탭에서 고정 일정을 넣는 것부터 다시 시작할 수 있어요.');
      renderAll();
      $('sampleBox').hidden = false;
      $('btnClear').focus();
    });

    $('btnSample').addEventListener('click', () => {
      if (hasAnyData()) return;
      state = window.Sample.build(new Date());
      if (commit()) showStatus('info', '예시 데이터를 넣었어요.', '대학생 한 명의 5주치 기록이에요. 설정(톱니바퀴) › 기록 관리 › 전체 삭제로 언제든 지울 수 있어요.');
      resetRoutineForm();
      renderAll();
      closeSettings();
      switchTab('today', 'todayH');
    });
  }

  function applyImport(d) {
    state = normalizeState(d);
    ui.panel = null; ui.filter = '전체'; ui.editRecord = null;
    resetBlockForm();
    resetRoutineForm();
    if (commit()) showStatus('info', '기록을 가져왔어요.', countsText(state));
    renderAll();
    $('btnImport').focus();
  }

  /* 예전 데이터 옮기기: "매일(주 7회)"이던 시각·아무 때나 루틴은 "요일: 매일"로 */
  function normalizeState(d) {
    (d.routines || []).forEach((r) => {
      if (!C.isSituation(r) && r.perWeek === 7 && !(Array.isArray(r.days) && r.days.length)) { r.days = [0, 1, 2, 3, 4, 5, 6]; r.perWeek = null; }
    });
    if (!Array.isArray(d.events)) d.events = [];
    const used = [];
    (d.routines || []).forEach((r, i) => {
      if (!r.color) r.color = S.COLORS.find((c) => !used.includes(c)) || S.COLORS[i % S.COLORS.length];
      used.push(r.color);
    });
    return d;
  }

  // ---------- 시작 ----------
  function minuteTicker() {
    const m = C.minutesOfDay(new Date());
    if (m === ui.lastMinute) return;
    if (ui.tab !== 'today' || ui.panel) return;
    const box = $('todayDyn');
    if (box.contains(document.activeElement)) return; // 누르고 있는 버튼이 사라지지 않게
    renderToday();
  }

  function init() {
    bindTabs();
    bindActive();
    bindTaskForm();
    bindRoutineForm();
    bindBlockForm();
    bindEditDialog();
    bindGuide();
    bindSettings();
    bindSuggestions();
    bindHolidayForm();
    bindSettingsForm();
    bindData();

    const res = S.load();
    if (!res.ok) {
      state = S.empty();
      if (res.reason === 'storage') {
        showStatus('error', '저장소를 열 수 없어요.',
          '사생활 보호 모드이거나 브라우저가 사이트 데이터 저장을 막고 있어요. 일반 창에서 열어 주세요. 이대로 쓰면 창을 닫을 때 기록이 사라져요.');
      } else {
        showStatus('error', '저장된 기록이 손상돼서 읽지 못했어요.',
          (res.backedUp ? '원래 데이터는 지우지 않고 따로 보관해 뒀어요. ' : '') +
          '내보낸 파일이 있다면 설정(톱니바퀴) › 기록 관리 › 가져오기로 되살릴 수 있어요. 없다면 새로 시작하면 돼요.');
      }
    } else {
      state = normalizeState(res.data || S.empty());
      clearStatus();
    }
    resetRoutineForm();
    resetBlockForm();
    const start = location.hash.slice(1);
    ui.routine = routineFromHash(start);
    switchTab(ui.routine ? 'routines' : start === 'week' ? 'calendar' : TABS.includes(start) ? start : 'today');
    if (start === 'sample') setTimeout(openSettings, 0); // 앱 소개의 '예시 데이터로 둘러보기'
    renderAll();
    renderHolidayInfo();
    loadHolidays();
    setInterval(minuteTicker, 10000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderActive(); minuteTicker(); } });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
