/* 루틴메이커 화면 모듈: 화면 그리기와 입력 처리.
 * 계산은 Calc, 저장은 Store에 맡긴다. 사용자 입력은 textContent로만 넣는다(innerHTML 사용 안 함).
 */
(function () {
  'use strict';

  const C = window.Calc;
  const S = window.Store;
  const BASE_CATEGORIES = ['과제', '공부', '복습', '시험 준비', '팀플', '기타'];
  const TABS = ['today', 'calendar', 'routines', 'week', 'review'];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const RECORDS_PAGE = 30;
  const KIND_ORDER = ['수업', '통학', '알바', '기타'];
  const KIND_CLASS = { 수업: 'k-class', 통학: 'k-commute', 알바: 'k-work', 기타: 'k-etc' };
  const kindClass = (kind) => KIND_CLASS[kind] || 'k-etc';

  let state = S.empty();
  const ui = {
    tab: 'today',
    panel: null,          // 오늘 탭 루틴 항목 안의 작은 입력칸 { routineId, mode: 'start'|'manual', version }
    filter: '전체',
    showAll: false,
    editBlock: null,
    editRoutine: null,
    confirm: null,        // 삭제 확인 중인 항목 'r:<id>' | 'b:<id>'
    pendingImport: null,
    editRecord: null,     // 고치는 중인 기록 id
    more: null,           // 오늘 탭에서 '더보기'를 연 루틴 id
    calMonth: null,       // 캘린더에 보이는 달 (그달 1일)
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

  function uid(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function q(name) { return '‘' + name + '’'; }
  function daysText(days) { return DAY_ORDER.filter((d) => days.includes(d)).map((d) => C.DAY_NAMES[d]).join('·'); }
  function perWeekText(n) { return n == null ? '상황이 올 때마다' : n === 7 ? '매일' : '주 ' + n + '회'; }
  /* 루틴 호칭: 시각 루틴 · 상황 루틴 · 아무 때나 루틴 */
  const KIND_NAMES = { time: '시각 루틴', situation: '상황 루틴', anytime: '아무 때나 루틴' };
  function kindName(r) { return KIND_NAMES[C.routineKind(r)]; }
  /* 얼마나 자주: 상황 루틴은 늘 "상황이 올 때마다" */
  function goalText(r) { return C.isSituation(r) ? '상황이 올 때마다' : perWeekText(r.perWeek); }
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
      .then(() => { renderToday(); renderCalendar(); renderHolidayInfo(); });
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
  /* 월별 달력: 공휴일과 기록한 날을 보여 주고, 날짜를 누르면 그날 고정 일정과 기록 */
  function renderCalendar() {
    const box = $('calendarDyn');
    if (!box) return;
    const L = nowL();
    const todayKey = C.dayKey(L.day);
    if (!ui.calMonth) ui.calMonth = new Date(L.day.getFullYear(), L.day.getMonth(), 1);
    if (!ui.calSel) ui.calSel = todayKey;
    const y = ui.calMonth.getFullYear(), mo = ui.calMonth.getMonth();
    const first = new Date(y, mo, 1);
    const gridStart = C.addDays(first, -C.mondayIndex(first));
    const weeks = Math.ceil((C.mondayIndex(first) + new Date(y, mo + 1, 0).getDate()) / 7);

    const byDay = {};
    state.records.forEach((r) => { const k = C.logicalKey(r.startedAt, L.shift); (byDay[k] = byDay[k] || []).push(r); });
    const hmap = {};
    holidays.list.forEach((x) => { hmap[x.date] = x.name; });

    const move = (n) => { ui.calMonth = new Date(y, mo + n, 1); renderCalendar(); };
    const head = h('div', { class: 'cal-head' },
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => move(-1), 'aria-label': '이전 달' }, '‹ 이전'),
      h('h2', { id: 'calTitle', 'aria-live': 'polite' }, y + '년 ' + (mo + 1) + '월'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small', onclick: () => { ui.calMonth = null; ui.calSel = null; renderCalendar(); } }, '오늘'),
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => move(1), 'aria-label': '다음 달' }, '다음 ›')));

    const rows = [];
    for (let w = 0; w < weeks; w++) {
      rows.push(h('tr', null, [0, 1, 2, 3, 4, 5, 6].map((i) => {
        const d = C.addDays(gridStart, w * 7 + i);
        const k = C.dayKey(d);
        const hol = hmap[k];
        const recs = byDay[k] || [];
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
        recs.length ? h('span', { class: 'cal-dots', 'aria-hidden': 'true' }, '●'.repeat(Math.min(3, recs.length)) + (recs.length > 3 ? '+' : '')) : null));
      })));
    }
    const table = h('table', { class: 'cal' },
      h('caption', { class: 'sr-only' }, y + '년 ' + (mo + 1) + '월 달력'),
      h('thead', null, h('tr', null, DAY_ORDER.map((d) => h('th', { scope: 'col', class: d === 0 ? 'red' : '' }, C.DAY_NAMES[d])))),
      h('tbody', null, rows));

    box.replaceChildren(
      h('h2', { class: 'sr-only' }, '캘린더'),
      h('section', { class: 'card', 'aria-labelledby': 'calTitle' }, head, table,
        h('div', { class: 'legend' }, h('span', { class: 'lg-hol' }, '공휴일'), h('span', { class: 'lg-dot' }, '기록한 날')),
        holidays.status === 'ok' ? null : h('p', { class: 'hint' }, holidayStatusText())),
      calendarDay(ui.calSel, hmap, byDay));
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
            h('span', null, h('span', { class: 'num' }, clockText(r.startedAt)), ' ' + r.name + (r.version === 'min' ? ' (최소)' : '')),
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
  function focusFirst(ids) {
    const id = ids.find(Boolean);
    if (!id) return false;
    const el = $(id);
    const target = el.tagName === 'FIELDSET' ? el.querySelector('input') : el;
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
    try { if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name); } catch (e) { /* file:// 등 */ }
    if (name === 'today') renderToday();
    if (name === 'calendar') renderCalendar();
    if (focusId) {
      const el = $(focusId);
      if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
    }
  }

  function bindTabs() {
    const tabs = TABS.map((t) => $('tab-' + t));
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => switchTab(TABS[i]));
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
      if (TABS.includes(name) && name !== ui.tab) switchTab(name);
    });
  }

  // ---------- 전체 다시 그리기 ----------
  function renderAll() {
    renderCategories();
    renderActive();
    renderToday();
    renderRoutines();
    renderWeek();
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
    $('activeKind').textContent = a.kind === 'routine'
      ? (a.version === 'min' ? '하는 중 · 루틴 최소 버전' : '하는 중 · 루틴')
      : '하는 중 · 다른 활동';
    $('activeTitle').textContent = a.name;
    const bits = [a.category, '예상 ' + a.estimateMin + '분', clockText(a.startedAt) + ' 시작'];
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

  function onFinishClick() {
    if (!state.active) return;
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

  function amountFor(routine, version, entered) {
    if (!routine) return null;
    if (routine.measure.type === 'count') return entered || null;
    if (routine.measure.type === 'fixed') return version === 'base' ? routine.measure.amount : null;
    return null;
  }

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
      amount: amountFor(routine, a.version, opts.amount),
      plannedStartAt: a.plannedStartAt || null,
      startedAt: a.startedAt, endedAt: endedAt.toISOString(), source: 'timer'
    };
    state.records.push(rec);
    state.active = null;
    if (commit()) showStatus('info', q(rec.name) + ' 기록했어요. 실제 ' + actual + '분 걸렸어요.', recordSummary(rec, routine));
    renderAll();
    afterActiveEnds();
  }

  function recordSummary(rec, routine) {
    const bits = [];
    if (routine && C.isSituation(routine)) {
      const wk = C.situationWeek(routine, sitEnv());
      bits.push(sitWeekText(wk.occ, wk.hit));
    } else if (routine) {
      const done = C.weekDone(state.records, routine.id, new Date(), shift());
      bits.push(done >= routine.perWeek ? '이번 주 ' + perWeekText(routine.perWeek) + ' 채웠어요 (' + done + '일)' : '이번 주 ' + done + '/' + routine.perWeek);
    }
    if (rec.amount && routine && routine.measure.type === 'count') bits.push('1' + routine.measure.unit + '당 ' + C.round1(rec.actualMin / rec.amount) + '분');
    if (!routine || routine.measure.type === 'none') bits.push('예상 ' + rec.estimateMin + '분 → 실제 ' + rec.actualMin + '분 (' + ratioText(rec.actualMin / rec.estimateMin) + ')');
    return bits.join(' · ');
  }

  function afterActiveEnds() {
    if (ui.tab === 'today') { const t = $('todayH'); if (t) t.focus(); }
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
    const base = {
      r, doneToday, anchor, cal, predBase, predMin, pick, since,
      fit: pick ? C.fit(predBase, predMin, pick.avail) : 'nogap'
    };
    if (C.isSituation(r)) {
      // 상황 루틴: 이번 주 목표 = 상황이 생긴 날 수, 오늘 할 일 = 오늘 상황이 생겼고 아직 안 했을 때
      const env = sitEnv(now);
      const wk = C.situationWeek(r, env);
      return Object.assign(base, {
        situation: true, done: wk.hit, target: wk.occ,
        missed: C.situationMissedYesterday(r, env), tight: null,
        todo: !!anchor.today && !doneToday
      });
    }
    return Object.assign(base, {
      situation: false, done, target: r.perWeek,
      missed: C.missedYesterday(state.records, r, now, L.shift),
      tight: C.weekTight(r, done, doneToday, now, L.shift),
      todo: !doneToday && done < r.perWeek
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
          h('button', { type: 'button', class: 'btn primary', onclick: () => switchTab('week', 'bName') }, '주간 틀에 고정 일정 넣기'),
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

  const FIT_LONG = { fits: '남은 시간 안에 끝나요', min: '최소 버전만 끝낼 수 있어요', tight: '시간이 모자라요', nogap: '오늘 남은 빈 시간이 없어요' };
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
    const version = pick.nowFit === 'fits' ? 'base' : 'min';
    card.id = 'ti-' + r.id;
    card.append(
      h('div', { class: 'now-row' },
        h('span', { class: 'dot routine', 'aria-hidden': 'true' }),
        h('div', { class: 'now-main' },
          h('span', { class: 'now-name' }, r.name),
          h('span', { class: 'now-meta' }, '약 ' + (version === 'base' ? pick.predBase : pick.predMin) + '분' +
            (pick.since != null ? ' · ' + sinceText(pick) : '') + (pick.missed ? ' · 어제 못 했어요' : ''))),
        h('button', { type: 'button', class: 'btn primary start-btn', onclick: () => onStartRoutine(r, version) },
          version === 'base' ? '시작' : '최소 버전 시작')),
      h('div', { class: 'now-foot' },
        h('span', { class: 'fit-chip ' + pick.nowFit }, FIT_LONG[pick.nowFit]),
        version === 'base' ? h('button', { type: 'button', class: 'link-btn', onclick: () => onStartRoutine(r, 'min') }, '최소 버전 ' + r.minMin + '분') : null));
    if (ui.panel && ui.panel.routineId === r.id) card.append(routinePanel(r));
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
      marks.map((i) => h('span', { class: 'tl-mark', style: 'left:' + pct(i.anchor.plannedMin) + '%', title: i.r.name + ' · ' + C.fmtHM(i.anchor.plannedMin) })),
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

  /* 오늘 남은 루틴: 한 줄씩. 자세한 내용과 최소 버전·직접 기록은 "더보기" */
  function todayRoutines(infos, shownId) {
    const sec = h('section', { class: 'section', 'aria-labelledby': 'todayRoutinesH' },
      h('h3', { id: 'todayRoutinesH' }, '오늘 남은 루틴'));
    if (!state.routines.length) {
      sec.append(emptyBox('루틴이 없어요.',
        '주 1회처럼 작게 하나 만들어 보세요. 시작 신호(앵커)와 바쁜 날용 최소 버전을 함께 정해요.',
        h('button', { type: 'button', class: 'btn', onclick: () => switchTab('routines', 'rName') }, '루틴 만들기')));
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

  function ruleLine(r, anchor) {
    const p = h('p', { class: 'rule' }, anchorPhrase(r), h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
      h('span', { class: 'sr-only' }, ' 그러면 '), r.name);
    if (anchor && anchor.type === 'block' && !anchor.today) p.append(h('span', { class: 'sub' }, ' · 오늘은 ' + (anchor.holiday ? '공휴일이라 ' : '') + q(anchor.block.name) + '이(가) 없는 날'));
    if (anchor && anchor.type === 'block' && anchor.today) p.append(h('span', { class: 'sub num' }, ' · ' + anchor.block.end));
    return p;
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
    const open = ui.more === r.id || (ui.panel && ui.panel.routineId === r.id);
    const notes = [];
    if (info.missed) notes.push('어제 못 했어요 · 최소 버전도 괜찮아요');
    if (info.tight) notes.push('이번 주 ' + info.tight.left + '번 남았는데 ' + info.tight.daysLeft + '일 남았어요');
    if (info.since != null) notes.push(sinceText(info));
    const li = h('li', { class: 'rrow' + (info.missed || info.tight ? ' flagged' : ''), id: 'ti-' + r.id },
      h('div', { class: 'rrow-line' },
        h('span', { class: 'dot routine-soft', 'aria-hidden': 'true' }),
        h('div', { class: 'rrow-main' },
          h('h4', { class: 'rrow-name' }, r.name),
          h('span', { class: 'rrow-meta' }, anchorShort(r, info.anchor) + ' · 약 ' + info.predBase + '분 · ' + weekText(info)),
          notes.length ? h('span', { class: 'rrow-note' }, notes.join(' · ')) : null),
        h('span', { class: 'fit-word ' + info.fit }, FIT_SHORT[info.fit]),
        h('button', { type: 'button', class: 'btn small outline', onclick: () => onStartRoutine(r, 'base'), 'aria-label': q(r.name) + ' 시작' }, '시작'),
        h('button', {
          type: 'button', class: 'more-btn', 'aria-expanded': String(!!open), 'aria-label': q(r.name) + ' 더보기',
          onclick: () => { ui.more = ui.more === r.id ? null : r.id; if (ui.panel && ui.panel.routineId === r.id) ui.panel = null; renderToday(); const b = document.querySelector('#ti-' + CSS.escape(r.id) + ' .more-btn'); if (b) b.focus(); }
        }, open ? '접기' : '더보기')));
    if (open) {
      li.append(h('div', { class: 'rrow-more' },
        ruleLine(r, info.anchor),
        h('p', { class: 'sub' }, info.cal
          ? '기록 기준으로 기본은 약 ' + info.predBase + '분, 최소는 약 ' + info.predMin + '분 걸려요 (' +
            (info.cal.source === 'routine' ? '이 루틴' : q(r.category) + ' 기록') + ', 예상의 ' + info.cal.ratio.toFixed(1) + '배).'
          : '기본 ' + r.baseMin + '분 · 최소 ' + r.minMin + '분 · 기록이 3개 쌓이면 실제 걸리는 시간으로 보정해 드려요.'),
        fitLine(info),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn small', onclick: () => onStartRoutine(r, 'min') }, '최소 버전 · ' + r.minMin + '분'),
          h('button', { type: 'button', class: 'btn small ghost', onclick: () => openPanel(r.id, 'manual', 'base') }, '타이머 없이 기록'))));
    }
    if (ui.panel && ui.panel.routineId === r.id) li.append(routinePanel(r));
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

  function openPanel(routineId, mode, version) {
    ui.panel = { routineId, mode, version };
    renderToday();
    const first = document.querySelector('#ti-' + CSS.escape(routineId) + ' .panel input, #ti-' + CSS.escape(routineId) + ' .panel select');
    if (first) first.focus();
  }
  function closePanel(routineId) {
    ui.panel = null;
    renderToday();
    const item = $('ti-' + routineId);
    const btn = item && item.querySelector('button');
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
        h('label', { for: 'pVer' }, '어떤 버전으로 했나요?'),
        h('select', { id: 'pVer' },
          h('option', { value: 'base', selected: p.version === 'base' }, '기본 (' + r.baseMin + '분)'),
          h('option', { value: 'min', selected: p.version === 'min' }, '최소 버전 (' + r.minMin + '분)'))));
      fields.push(h('div', { class: 'field' },
        h('label', { for: 'pAct' }, '실제로 걸린 시간 (분)'),
        h('input', { id: 'pAct', inputmode: 'numeric', autocomplete: 'off', 'aria-describedby': 'pActErr' }),
        h('p', { class: 'err', id: 'pActErr' })));
    }
    if (r.measure.type === 'none') {
      fields.push(h('div', { class: 'field' },
        h('label', { for: 'pEst' }, '오늘 예상 시간 (분)'),
        h('input', { id: 'pEst', inputmode: 'numeric', autocomplete: 'off', value: String(p.version === 'min' ? r.minMin : r.baseMin), 'aria-describedby': 'pEstHint pEstErr' }),
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
      const version = manual ? $('pVer').value : p.version;
      const estimate = $('pEst') ? Number($('pEst').value) : (version === 'min' ? r.minMin : r.baseMin);
      if (manual) saveManualRoutine(r, version, Number($('pAct').value), $('pAmt') && $('pAmt').value.trim() ? Number($('pAmt').value) : null, estimate, Number($('pDay').value));
      else startRoutine(r, version, estimate);
    });
    return form;
  }

  function onStartRoutine(r, version) {
    if (state.active) { blockedByActive(); return; }
    if (r.measure.type === 'none') { openPanel(r.id, 'start', version); return; }
    startRoutine(r, version, version === 'min' ? r.minMin : r.baseMin);
  }

  function startRoutine(r, version, estimateMin) {
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
      id: uid('t'), kind: 'routine', routineId: r.id, name: r.name, category: r.category, version,
      estimateMin, plannedStartAt: planned, startedAt: now.toISOString()
    };
    ui.panel = null;
    if (commit()) showStatus('info', q(r.name) + (version === 'min' ? ' 최소 버전' : '') + ' 시작했어요.', '새로고침하거나 탭을 닫아도 시작 시각부터 이어서 계산해요.');
    renderAll();
    $('activeTitle').focus();
  }

  function saveManualRoutine(r, version, actual, amount, estimate, daysAgo) {
    const rec = Object.assign({
      id: uid('t'), kind: 'routine', routineId: r.id, name: r.name, category: r.category, version,
      estimateMin: estimate, actualMin: actual, amount: amountFor(r, version, amount), plannedStartAt: null, source: 'manual'
    }, manualSpan(daysAgo || 0, actual));
    state.records.push(rec);
    ui.panel = null;
    if (commit()) showStatus('info', q(r.name) + ' ' + (daysAgo ? ['', '어제', '그저께'][daysAgo] + ' 기록으로 ' : '') + '저장했어요. 실제 ' + actual + '분 걸렸어요.', recordSummary(rec, r));
    renderAll();
    $('todayH').focus();
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

  // ========== 루틴 ==========
  /* 지난 4주를 주별 일수 막대로. 매일 루틴도 "0주 채움"이 아니라 몇 일 했는지가 보이게 */
  function weeksDots(r) {
    if (C.isSituation(r)) return situationBars(r);
    const weeks = C.lastWeeks(state.records, r, new Date(), 4, shift());
    const counted = weeks.filter((w) => w.state !== 'none');
    if (!counted.length) return h('span', { class: 'sub' }, '루틴을 만든 지 아직 한 주가 안 됐어요.');
    const avg = counted.reduce((s, w) => s + w.count, 0) / counted.length;
    const label = '지난 ' + counted.length + '주 평균 주 ' + C.round1(avg) + '일 (목표 ' + perWeekText(r.perWeek) + ', 주별 ' +
      counted.map((w) => w.count).join('·') + '일)';
    return h('span', { class: 'weekbars-wrap' },
      h('span', { class: 'weekbars', 'aria-hidden': 'true' }, weeks.map((w) => h('span', { class: 'wb ' + w.state },
        h('span', { class: 'wb-track' }, h('span', { class: 'wb-fill', style: 'height:' + Math.min(100, w.count / r.perWeek * 100) + '%' })),
        h('span', { class: 'wb-num num' }, w.state === 'none' ? '–' : String(w.count))))),
      h('span', { class: 'sub' }, label));
  }

  /* 상황 루틴의 지난 4주: 상황이 생긴 날 중 실천한 날 */
  function situationBars(r) {
    const weeks = C.situationWeeks(r, sitEnv(), 4);
    const counted = weeks.filter((w) => w.state !== 'none');
    if (!counted.length) return h('span', { class: 'sub' }, '루틴을 만든 지 아직 한 주가 안 됐어요.');
    const occ = counted.reduce((n, w) => n + w.occ, 0), hit = counted.reduce((n, w) => n + w.hit, 0);
    const label = occ ? '지난 ' + counted.length + '주 동안 상황 ' + occ + '번 중 ' + hit + '번 실천 (' + Math.round(hit / occ * 100) + '%)'
      : '지난 ' + counted.length + '주 동안 상황이 없었어요';
    return h('span', { class: 'weekbars-wrap' },
      h('span', { class: 'weekbars', 'aria-hidden': 'true' }, weeks.map((w) => h('span', { class: 'wb ' + (w.state === 'quiet' ? 'none' : w.state) },
        h('span', { class: 'wb-track' }, h('span', { class: 'wb-fill', style: 'height:' + (w.occ ? Math.min(100, w.hit / w.occ * 100) : 0) + '%' })),
        h('span', { class: 'wb-num num' }, w.state === 'none' || w.state === 'quiet' ? '–' : w.hit + '/' + w.occ)))),
      h('span', { class: 'sub' }, label));
  }

  function renderRoutines() {
    const box = $('routinesDyn');
    const nodes = [h('h2', { class: 'sr-only' }, '내 루틴')];
    if (!state.routines.length) {
      nodes.push(emptyBox('아직 루틴이 없어요.', '아래에서 주 1회처럼 작게 하나 만들어 보세요. 한 번에 한두 개로 시작하는 편이 오래가요.'));
    } else {
      const now = new Date();
      nodes.push(h('ul', { class: 'items plain-list', role: 'list' }, state.routines.map((r) => {
        const li = h('li', { class: 'item', id: 'rc-' + r.id },
          h('div', { class: 'item-head' }, h('h3', { class: 'item-name' }, r.name),
            h('span', { class: 'row' }, h('span', { class: 'kind-tag ' + C.routineKind(r) }, kindName(r)), h('span', { class: 'tag' }, r.category))),
          ruleLine(r, null),
          h('div', { class: 'facts' },
            h('p', null, goalText(r) + ' · 기본 ' + r.baseMin + '분 / 최소 ' + r.minMin + '분 · ' + measureText(r.measure)),
            h('p', null, C.isSituation(r)
              ? (() => { const wk = C.situationWeek(r, sitEnv(now)); return sitWeekText(wk.occ, wk.hit); })()
              : '이번 주 ' + C.weekDone(state.records, r.id, now, shift()) + '/' + r.perWeek),
            weeksDots(r),
            r.anchor && r.anchor.type === 'block' && findBlock(r.anchor.blockId)
              ? h('p', null, '앵커 요일: ' + daysText(findBlock(r.anchor.blockId).days)) : null),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'btn small', onclick: () => editRoutine(r.id), 'aria-label': q(r.name) + ' 고치기' }, '고치기'),
            h('button', { type: 'button', class: 'btn small danger', onclick: () => askDelete('r:' + r.id), 'aria-label': q(r.name) + ' 지우기' }, '지우기')));
        if (ui.confirm === 'r:' + r.id) {
          li.append(h('div', { class: 'confirm' },
            h('p', null, q(r.name) + ' 루틴을 지울까요? 지금까지의 기록은 돌아보기에 남아요.'),
            h('div', { class: 'row' },
              h('button', { type: 'button', class: 'btn danger', id: 'confirmYes', onclick: () => deleteRoutine(r.id) }, '루틴 지우기'),
              h('button', { type: 'button', class: 'btn', onclick: () => cancelDelete('rc-' + r.id) }, '취소'))));
        }
        return li;
      })));
    }
    box.replaceChildren(...nodes);
  }

  function askDelete(key) {
    ui.confirm = key;
    if (key.startsWith('r:')) renderRoutines(); else renderWeek();
    const yes = $('confirmYes');
    if (yes) yes.focus();
  }
  function cancelDelete(itemId) {
    ui.confirm = null;
    renderRoutines();
    renderWeek();
    const item = $(itemId);
    const btn = item && item.querySelector('.danger');
    if (btn) btn.focus();
  }

  function deleteRoutine(id) {
    const r = findRoutine(id);
    ui.confirm = null;
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
    if (ui.editRoutine === id) resetRoutineForm();
    if (ui.panel && ui.panel.routineId === id) ui.panel = null;
    if (commit()) showStatus('info', q(r.name) + ' 루틴을 지웠어요.', '기록은 돌아보기에 남아 있어요.' +
      (chained.length ? ' ' + chained.map((x) => q(x.name)).join(', ') + '은(는) 이제 아무 때나 루틴(주 ' + chained[0].perWeek + '회)이에요.' : ''));
    renderAll();
    $('routineFormH').focus();
  }

  function selectedRadio(name) { const el = document.querySelector('input[name="' + name + '"]:checked'); return el ? el.value : null; }
  function setRadio(name, value) { document.querySelectorAll('input[name="' + name + '"]').forEach((el) => { el.checked = el.value === value; }); }

  const SITUATION_ANCHORS = ['block', 'routine', 'dayoff', 'situation'];
  function toggleRoutineFields() {
    $('rPerWeekHint').hidden = $('rPerWeek').value !== '7';
    const a = selectedRadio('rAnchor');
    $('rAnchorBlockField').hidden = a !== 'block';
    $('rAnchorTimeField').hidden = a !== 'time';
    $('rAnchorRoutineField').hidden = a !== 'routine';
    $('rAnchorSituationField').hidden = a !== 'situation';
    // 상황 루틴은 "주 N회" 대신 "상황이 올 때마다"
    const each = SITUATION_ANCHORS.includes(a);
    $('rPerWeekField').hidden = each;
    $('rEachField').hidden = !each;
    const m = selectedRadio('rMeasure');
    $('rFixedField').hidden = m !== 'fixed';
    $('rCountField').hidden = m !== 'count';
  }

  function syncAnchorBlocks() {
    const sel = $('rAnchorBlock');
    const keep = sel.value;
    if (!state.blocks.length) {
      sel.replaceChildren(h('option', { value: '' }, '먼저 주간 틀에 고정 일정을 넣어 주세요'));
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
    $('rBase').value = '';
    $('rMin').value = '';
    setRadio('rAnchor', state.blocks.length ? 'block' : 'none');
    $('rAnchorTime').value = '';
    $('rAnchorSituation').value = '';
    setRadio('rMeasure', 'count');
    $('rCountUnit').value = '장';
    $('rFixedAmount').value = '';
    $('rFixedUnit').value = '';
    $('rSubmit').textContent = '루틴 만들기';
    $('rCancel').hidden = true;
    syncAnchorBlocks();
    syncAnchorRoutines();
    toggleRoutineFields();
  }

  function editRoutine(id) {
    const r = findRoutine(id);
    if (!r) return;
    resetRoutineForm();
    ui.editRoutine = id;
    syncAnchorRoutines();
    $('rName').value = r.name;
    $('rCategory').value = r.category;
    $('rPerWeek').value = String(r.perWeek || 3);
    $('rBase').value = String(r.baseMin);
    $('rMin').value = String(r.minMin);
    const a = r.anchor;
    if (a && a.type === 'block' && findBlock(a.blockId)) { setRadio('rAnchor', 'block'); $('rAnchorBlock').value = a.blockId; }
    else if (a && a.type === 'time') { setRadio('rAnchor', 'time'); $('rAnchorTime').value = a.time; }
    else if (a && a.type === 'routine' && findRoutine(a.routineId)) { setRadio('rAnchor', 'routine'); $('rAnchorRoutine').value = a.routineId; }
    else if (a && a.type === 'situation') { setRadio('rAnchor', 'situation'); $('rAnchorSituation').value = a.label; }
    else if (a && a.type === 'dayoff') setRadio('rAnchor', 'dayoff');
    else setRadio('rAnchor', 'none');
    setRadio('rMeasure', r.measure.type);
    if (r.measure.type === 'fixed') { $('rFixedAmount').value = String(r.measure.amount); $('rFixedUnit').value = r.measure.unit; }
    if (r.measure.type === 'count') $('rCountUnit').value = r.measure.unit;
    $('rSubmit').textContent = '고친 내용 저장';
    $('rCancel').hidden = false;
    toggleRoutineFields();
    openEditDialog('routineForm', q(r.name) + ' 고치기', () => {
      const item = $('rc-' + id);
      return item ? item.querySelector('button') : $('tab-routines');
    }, resetRoutineForm);
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
    document.querySelectorAll('input[name="rAnchor"], input[name="rMeasure"]').forEach((el) => el.addEventListener('change', toggleRoutineFields));
    $('rPerWeek').addEventListener('change', toggleRoutineFields);
    $('rCancel').addEventListener('click', () => { if (dialog) closeEditDialog(); else resetRoutineForm(); });
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
      if (!minMsg && !baseMsg && Number($('rMin').value) >= Number($('rBase').value)) minMsg = '최소 버전은 기본보다 짧게 적어 주세요';
      errs.push(setErr('rMin', minMsg));

      const anchorType = selectedRadio('rAnchor');
      let anchor = null;
      if (anchorType === 'block') {
        if (!$('rAnchorBlock').value || !findBlock($('rAnchorBlock').value)) errs.push(setErr('rAnchorBlock', '고정 일정을 골라 주세요. 없다면 주간 틀에서 먼저 넣어 주세요', 'rAnchorErr'));
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
        perWeek: SITUATION_ANCHORS.includes(anchorType) ? null : Number($('rPerWeek').value),
        baseMin: Number($('rBase').value),
        minMin: Number($('rMin').value),
        anchor, measure
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
      if (editing && dialog) closeEditDialog(); else $('rName').focus();
    });
  }

  // ========== 주간 틀 ==========
  function renderWeek() {
    const box = $('weekDyn');
    const nodes = [h('h2', { class: 'sr-only' }, '주간 틀'),
      h('p', { class: 'sub' }, '매주 반복되는 고정 일정이에요. 이걸 빼고 남는 시간이 빈 시간이 돼요.')];
    if (!state.blocks.length) {
      nodes.push(emptyBox('아직 고정 일정이 없어요.', '수업, 통학, 알바처럼 내가 옮길 수 없는 일정을 아래에서 넣어 보세요.'));
      box.replaceChildren(...nodes);
      return;
    }
    nodes.push(weekChart());

    nodes.push(h('ul', { class: 'items plain-list', role: 'list', 'aria-label': '고정 일정 목록' }, state.blocks.map((b) => {
      const anchored = state.routines.filter((r) => r.anchor && r.anchor.type === 'block' && r.anchor.blockId === b.id);
      const li = h('li', { class: 'item', id: 'bc-' + b.id },
        h('div', { class: 'item-head' }, h('h3', { class: 'item-name' }, b.name), h('span', { class: 'tag' }, b.kind)),
        h('p', { class: 'sub' }, daysText(b.days) + ' · ', h('span', { class: 'num' }, b.start + '–' + b.end),
          anchored.length ? ' · 앵커로 쓰는 루틴: ' + anchored.map((r) => r.name).join(', ') : ''),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn small', onclick: () => editBlock(b.id), 'aria-label': q(b.name) + ' 고치기' }, '고치기'),
          h('button', { type: 'button', class: 'btn small danger', onclick: () => askDelete('b:' + b.id), 'aria-label': q(b.name) + ' 지우기' }, '지우기')));
      if (ui.confirm === 'b:' + b.id) {
        li.append(h('div', { class: 'confirm' },
          h('p', null, q(b.name) + ' 고정 일정을 지울까요?' + (anchored.length
            ? ' 이걸 앵커로 쓰는 루틴(' + anchored.map((r) => r.name).join(', ') + ')은 ‘빈 시간 아무 때나’로 바뀌어요.' : '')),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'btn danger', id: 'confirmYes', onclick: () => deleteBlock(b.id) }, '고정 일정 지우기'),
            h('button', { type: 'button', class: 'btn', onclick: () => cancelDelete('bc-' + b.id) }, '취소'))));
      }
      return li;
    })));
    box.replaceChildren(...nodes);
  }

  /* 요일별 막대: 고정 일정을 종류별 색으로. 막대에 마우스를 올리거나 초점을 주면 이름·시간이 뜨고, 누르면 고치기 */
  function weekChart() {
    const s = state.settings;
    let ds = C.toMin(s.dayStart), de = C.dayEndMin(s);
    state.blocks.forEach((b) => { ds = Math.min(ds, C.toMin(b.start)); de = Math.max(de, C.toMin(b.end)); });
    ds = Math.floor(ds / 60) * 60;
    de = Math.ceil(de / 60) * 60;
    const total = de - ds;
    const pct = (m) => (m - ds) / total * 100;
    const step = total > 12 * 60 ? 180 : 120;
    const ticks = [];
    for (let t = Math.ceil(ds / step) * step; t <= de; t += step) ticks.push(t);

    const rows = DAY_ORDER.map((d) => {
      const list = C.dayBlocks(state.blocks, d);
      const bar = h('div', { class: 'wbar' },
        ticks.map((t) => h('span', { class: 'wtick', style: 'left:' + pct(t) + '%', 'aria-hidden': 'true' })),
        list.map((b) => {
          const left = pct(C.toMin(b.start));
          const width = pct(C.toMin(b.end)) - left;
          const edge = left < 15 ? ' tip-left' : (left + width > 85 ? ' tip-right' : '');
          return h('button', {
            type: 'button', class: 'seg ' + kindClass(b.kind) + edge,
            style: 'left:' + left + '%;width:' + width + '%',
            'data-tip': b.name + ' · ' + b.start + '–' + b.end,
            'aria-label': C.DAY_NAMES[d] + '요일 ' + b.name + ' (' + b.kind + ') ' + b.start + '–' + b.end + ', 고치기',
            onclick: () => editBlock(b.id)
          }, width >= 12 ? h('span', { class: 'seg-label', 'aria-hidden': 'true' }, b.name) : null);
        }));
      return h('div', { class: 'wrow' },
        h('span', { class: 'wday' + (list.length ? '' : ' muted') }, C.DAY_NAMES[d]),
        bar);
    });
    const scale = h('div', { class: 'wrow wscale', 'aria-hidden': 'true' }, h('span', { class: 'wday' }),
      h('div', { class: 'wticks' }, ticks.map((t) => h('span', { style: 'left:' + pct(t) + '%' }, (Math.floor(t / 60) % 24) + '시'))));
    const kinds = KIND_ORDER.filter((k) => state.blocks.some((b) => (KIND_ORDER.includes(b.kind) ? b.kind : '기타') === k));

    return h('section', { class: 'card', 'aria-labelledby': 'weekOverviewH' },
      h('h3', { id: 'weekOverviewH' }, '요일별로 보기'),
      h('p', { class: 'sub' }, '막대에 마우스를 올리면 일정 이름이 보이고, 누르면 고칠 수 있어요.'),
      h('div', { class: 'week-chart' }, rows, scale),
      h('div', { class: 'legend', 'aria-label': '색 구분' }, kinds.map((k) => h('span', { class: 'lg-k ' + kindClass(k) }, k))));
  }

  function deleteBlock(id) {
    const b = findBlock(id);
    ui.confirm = null;
    if (!b) return;
    const anchored = state.routines.filter((r) => r.anchor && r.anchor.type === 'block' && r.anchor.blockId === id);
    anchored.forEach((r) => { r.anchor = null; });
    state.blocks = state.blocks.filter((x) => x.id !== id);
    if (ui.editBlock === id) resetBlockForm();
    if (commit()) showStatus('info', q(b.name) + ' 고정 일정을 지웠어요.',
      anchored.length ? anchored.map((r) => q(r.name)).join(', ') + '은(는) 이제 빈 시간 아무 때나 하는 루틴이에요.' : '');
    renderAll();
    $('blockFormH').focus();
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
    openEditDialog('blockForm', q(b.name) + ' 고치기', () => {
      const item = $('bc-' + id);
      return item ? item.querySelector('button') : $('tab-week');
    }, resetBlockForm);
  }

  function bindBlockForm() {
    $('bCancel').addEventListener('click', () => { if (dialog) closeEditDialog(); else resetBlockForm(); });
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
      if (editing && dialog) closeEditDialog(); else $('bName').focus();
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
    if (state.routines.length) nodes.push(observationSection());
    nodes.push(ratioSection());
    nodes.push(recordsSection());
    box.replaceChildren(...nodes);
  }

  // ---------- 규칙 다듬기 제안 ----------
  function activeSuggestions() {
    const dismissed = state.dismissed || [];
    return C.suggestions(state.records, state.routines, new Date(), shift()).filter((s) => !dismissed.includes(s.key));
  }

  function reviewBanner() {
    const list = activeSuggestions().filter((s) => s.kind !== 'steady');
    if (!list.length) return null;
    return h('button', { type: 'button', class: 'chip-btn', onclick: () => switchTab('review', 'suggestH'), 'aria-label': '규칙 다듬기 제안 ' + list.length + '개 보기' },
      '제안 ' + list.length + '개');
  }

  function dismissSuggestion(key) {
    const week = key.split('|')[0];
    state.dismissed = (state.dismissed || []).filter((k) => k.startsWith(week + '|')).concat(key);
  }

  function applySuggestion(s) {
    const r = findRoutine(s.routineId);
    if (!r) return;
    if (s.kind === 'perWeek') r.perWeek = s.to;
    if (s.kind === 'baseMin') r.baseMin = s.to;
    dismissSuggestion(s.key);
    if (commit()) {
      showStatus('info', q(r.name) + ' 루틴을 ' + (s.kind === 'perWeek' ? perWeekText(s.to) + '로' : '기본 ' + s.to + '분으로') + ' 바꿨어요.',
        '되돌리려면 루틴 탭에서 고치면 돼요.');
    }
    renderAll();
    const head = $('suggestH') || $('tab-review');
    head.focus();
  }

  function suggestionSection() {
    const list = activeSuggestions();
    if (!list.length) return null;
    return h('section', { class: 'card', 'aria-labelledby': 'suggestH' },
      h('h3', { id: 'suggestH', tabindex: '-1' }, '규칙 다듬기 제안'),
      h('p', { class: 'sub' }, '기록에 근거한 제안이에요. 반영하거나 이번 주는 넘어갈 수 있어요.'),
      h('ul', { class: 'plain' }, list.map((s) => {
        const r = findRoutine(s.routineId);
        let text, apply = null;
        if (s.kind === 'perWeek') {
          text = q(r.name) + ' 루틴은 지난 2주 동안 ' + perWeekText(s.from) + ' 목표에 ' + s.counts.join('·') + '일 했어요. ' +
            perWeekText(s.to) + '로 낮추면 지키기 쉬워져요.';
          apply = perWeekText(s.to) + '로 바꾸기';
        } else if (s.kind === 'baseMin') {
          text = q(r.name) + ' 기본 시간은 ' + s.from + '분인데, 최근 5번 중앙값은 ' + Math.round(s.median) + '분이에요. 기본을 ' +
            s.to + '분으로 바꾸면 빈 시간 판단이 실제에 가까워져요.';
          apply = '기본 ' + s.to + '분으로 바꾸기';
        } else {
          text = q(r.name) + ' 루틴은 지난 4주 내내 목표를 채웠어요.';
        }
        return h('li', { class: 'suggest' }, h('p', null, text), h('div', { class: 'row' },
          apply ? h('button', { type: 'button', class: 'btn small primary', onclick: () => applySuggestion(s) }, apply) : null,
          h('button', {
            type: 'button', class: 'btn small ghost',
            onclick: () => { dismissSuggestion(s.key); commit(); renderAll(); const t = $('suggestH') || $('reviewDyn').querySelector('h2'); if (t) t.focus(); }
          }, apply ? '이번 주는 넘어가기' : '확인')));
      })));
  }

  function observationSection() {
    return h('section', { class: 'section', 'aria-labelledby': 'obsH' },
      h('h3', { id: 'obsH' }, '루틴별로 보기'),
      h('ul', { class: 'items plain-list', role: 'list' }, state.routines.map((r) => {
        const dur = C.observeDuration(state.records, r);
        const label = { fixed: '걸린 시간 (' + (r.measure.amount || '') + (r.measure.unit || '') + ', 기본 버전)', count: r.measure.unit + '당 걸린 시간', none: '예상과 실제' }[r.measure.type];
        const li = h('li', { class: 'item' },
          h('div', { class: 'item-head' }, h('h4', { class: 'item-name' }, r.name), h('span', { class: 'sub' }, goalText(r))),
          h('div', { class: 'obs' }, h('span', { class: 'label' }, label), h('p', null, C.durationSentence(dur, r))));
        if (r.anchor) {
          const delay = C.observeDelay(state.records, r);
          const text = C.delaySentence(delay, anchorLabel(r));
          li.append(h('div', { class: 'obs' }, h('span', { class: 'label' }, '앵커부터 시작까지'),
            h('p', null, text || '앵커가 있는 날 타이머로 시작하면 시작까지 걸린 시간을 기록해요.')));
        }
        li.append(h('div', { class: 'obs' }, h('span', { class: 'label' }, '지난 4주'), h('p', null, weeksDots(r))));
        return li;
      })));
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
      const kind = r.kind === 'task' ? '다른 활동' : (r.version === 'min' ? '루틴 · 최소' : '루틴');
      const amountUnit = routine && routine.measure.unit ? routine.measure.unit : '';
      const label = q(r.name) + ' ' + dateText(r.startedAt);
      const li = h('li', { class: 'rec', id: 'rec-' + r.id },
        h('span', { class: 'rec-name' }, r.name),
        h('span', { class: 'rec-times' }, r.estimateMin + '→' + r.actualMin + '분'),
        h('span', { class: 'rec-meta' }, r.category + ' · ' + dateText(r.startedAt) + ' · ' + kind +
          (r.amount ? ' · ' + r.amount + amountUnit : ''),
          r.source === 'manual' ? h('span', { class: 'tag' }, '직접 입력') : null,
          r.edited ? h('span', { class: 'tag' }, '고침') : null),
        h('span', { class: 'rec-del' },
          h('button', { type: 'button', class: 'btn small ghost edit', 'aria-label': label + ' 기록 고치기', onclick: () => openRecordEdit(r.id) }, '고치기'),
          h('button', { type: 'button', class: 'btn small ghost del', 'aria-label': label + ' 기록 지우기', onclick: () => deleteRecord(r.id) }, '지우기')));
      if (ui.editRecord === r.id) li.append(recordEditForm(r, routine));
      return li;
    })));
    if (list.length > shown.length) {
      sec.append(h('button', {
        type: 'button', class: 'btn', onclick: () => { ui.showAll = true; renderReview(); const items = document.querySelectorAll('#recordList .rec-del .del'); if (items[RECORDS_PAGE]) items[RECORDS_PAGE].focus(); }
      }, '더 보기 (' + (list.length - shown.length) + '개 남음)'));
    }
    return sec;
  }

  function openRecordEdit(id) {
    ui.editRecord = id;
    renderReview();
    const first = document.querySelector('#rec-' + CSS.escape(id) + ' form input');
    if (first) first.focus();
  }
  function closeRecordEdit(id) {
    ui.editRecord = null;
    renderReview();
    const btn = document.querySelector('#rec-' + CSS.escape(id) + ' .edit');
    if (btn) btn.focus();
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
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => closeRecordEdit(r.id) }, '취소')));
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
      const btn = document.querySelector('#rec-' + CSS.escape(r.id) + ' .edit');
      if (btn) btn.focus();
    });
    return form;
  }

  /* 지우고 나서 상태 안내의 "되돌리기"로 바로 되살릴 수 있다 */
  function deleteRecord(id) {
    const idx = [...document.querySelectorAll('#recordList .rec-del .del')].indexOf(document.activeElement);
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
          const btn = document.querySelector('#rec-' + CSS.escape(rec.id) + ' .del');
          if (btn) btn.focus();
        }
      });
    }
    renderAll();
    const after = [...document.querySelectorAll('#recordList .rec-del .del')];
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
      ui.panel = null; ui.confirm = null; ui.filter = '전체'; ui.editRecord = null;
      resetBlockForm();
      resetRoutineForm();
      $('clearConfirm').hidden = true;
      if (commit()) showStatus('info', '모든 데이터를 지웠어요.', '주간 틀에 고정 일정을 넣는 것부터 다시 시작할 수 있어요.');
      renderAll();
      $('tab-review').focus();
    });

    $('btnSample').addEventListener('click', () => {
      if (hasAnyData()) return;
      state = window.Sample.build(new Date());
      if (commit()) showStatus('info', '예시 데이터를 넣었어요.', '대학생 한 명의 5주치 기록이에요. 돌아보기 › 기록 관리 › 전체 삭제로 언제든 지울 수 있어요.');
      resetRoutineForm();
      renderAll();
      switchTab('today', 'todayH');
    });
  }

  function applyImport(d) {
    state = d;
    ui.panel = null; ui.confirm = null; ui.filter = '전체'; ui.editRecord = null;
    resetBlockForm();
    resetRoutineForm();
    if (commit()) showStatus('info', '기록을 가져왔어요.', countsText(state));
    renderAll();
    $('btnImport').focus();
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
          '내보낸 파일이 있다면 돌아보기 › 기록 관리 › 가져오기로 되살릴 수 있어요. 없다면 새로 시작하면 돼요.');
      }
    } else {
      state = res.data || S.empty();
      clearStatus();
    }
    resetRoutineForm();
    resetBlockForm();
    const start = location.hash.slice(1);
    switchTab(TABS.includes(start) ? start : 'today');
    renderAll();
    renderHolidayInfo();
    loadHolidays();
    setInterval(minuteTicker, 10000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderActive(); minuteTicker(); } });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
