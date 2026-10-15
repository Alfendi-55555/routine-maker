/* 루틴메이커 화면 모듈: 화면 그리기와 입력 처리.
 * 계산은 Calc, 저장은 Store에 맡긴다. 사용자 입력은 textContent로만 넣는다(innerHTML 사용 안 함).
 */
(function () {
  'use strict';

  const C = window.Calc;
  const S = window.Store;
  const BASE_CATEGORIES = ['과제', '공부', '복습', '시험 준비', '팀플', '기타'];
  const TABS = ['today', 'routines', 'week', 'review'];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const RECORDS_PAGE = 30;

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
  function perWeekText(n) { return n === 7 ? '매일' : '주 ' + n + '회'; }
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

  function anchorPhrase(r) {
    const a = r.anchor;
    if (!a) return '빈 시간 아무 때나';
    if (a.type === 'time') return a.time + '이 되면';
    const b = findBlock(a.blockId);
    return b ? q(b.name) + ' 끝나면' : '빈 시간 아무 때나';
  }

  /* 시작 지연 문장의 기준점: "‘자료구조’ 끝" / "22:00" */
  function anchorLabel(r) {
    const a = r.anchor;
    if (a && a.type === 'time') return a.time;
    const b = a && findBlock(a.blockId);
    return b ? q(b.name) + ' 끝' : '앵커';
  }

  // ---------- 상태 안내 ----------
  function showStatus(kind, title, body) {
    const el = $('status');
    el.className = 'status ' + kind;
    el.replaceChildren(h('strong', null, title), body ? h('span', null, body) : null);
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
      : '하는 중 · 한 번만 하는 일';
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
    return {
      routine: r,
      amount: !!(r && r.measure.type === 'count'),
      actual: C.diffMin(a.startedAt, new Date()) > 720
    };
  }

  function onFinishClick() {
    if (!state.active) return;
    const need = needsForFinish();
    if (!need.amount && !need.actual) { finish({}); return; }
    clearErrs($('finishForm'));
    $('finishAmount').value = '';
    $('finishActual').value = '';
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
    const rec = {
      id: a.id, kind: a.kind, routineId: a.routineId || null, name: a.name, category: a.category,
      version: a.version || null, estimateMin: a.estimateMin, actualMin: actual,
      amount: amountFor(routine, a.version, opts.amount),
      plannedStartAt: opts.actual != null ? null : (a.plannedStartAt || null),
      startedAt: a.startedAt, endedAt: end.toISOString(), source: 'timer'
    };
    state.records.push(rec);
    state.active = null;
    if (commit()) showStatus('info', q(rec.name) + ' 기록했어요. 실제 ' + actual + '분 걸렸어요.', recordSummary(rec, routine));
    renderAll();
    afterActiveEnds();
  }

  function recordSummary(rec, routine) {
    const bits = [];
    if (routine) {
      const done = C.weekDone(state.records, routine.id, new Date());
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
  function routineInfo(r, now, gaps, nowMin) {
    const done = C.weekDone(state.records, r.id, now);
    const doneToday = C.doneOn(state.records, r.id, now);
    const anchor = C.anchorToday(r, state.blocks, now.getDay());
    const cal = C.calibration(state.records, { routineId: r.id, category: r.category });
    const predBase = C.predict(r.baseMin, cal);
    const predMin = C.predict(r.minMin, cal);
    const pick = C.pickGap(gaps, anchor.today ? anchor.plannedMin : null, nowMin, state.settings.bufferMin);
    return {
      r, done, doneToday, anchor, cal, predBase, predMin, pick,
      fit: pick ? C.fit(predBase, predMin, pick.avail) : 'nogap',
      missed: C.missedYesterday(state.records, r, now),
      tight: C.weekTight(r, done, doneToday, now),
      todo: !doneToday && done < r.perWeek
    };
  }

  function renderToday() {
    const box = $('todayDyn');
    const now = new Date();
    const wd = now.getDay();
    const nowMin = C.minutesOfDay(now);
    const s = state.settings;
    const gaps = C.computeGaps(state.blocks, wd, s, nowMin);
    const todays = C.dayBlocks(state.blocks, wd);
    const left = gaps.reduce((sum, g) => sum + g.remaining, 0);
    ui.lastMinute = nowMin;

    const nodes = [];
    nodes.push(h('div', { class: 'day-head' },
      h('h2', { id: 'todayH', tabindex: '-1' }, (now.getMonth() + 1) + '월 ' + now.getDate() + '일 ' + C.DAY_NAMES[wd] + '요일'),
      h('p', { class: 'sub' }, state.blocks.length
        ? '오늘 고정 일정 ' + todays.length + '개 · 남은 빈 시간 ' + C.fmtDuration(left)
        : '고정 일정을 넣으면 오늘의 빈 시간이 보여요.')));

    if (!state.blocks.length) {
      nodes.push(emptyBox('아직 고정 일정이 없어요.',
        '수업·통학·알바처럼 매주 같은 시간에 하는 일부터 넣어 보세요. 그걸 빼고 남는 시간이 빈 시간이 돼요.',
        h('button', { type: 'button', class: 'btn primary', onclick: () => switchTab('week', 'bName') }, '주간 틀에 고정 일정 넣기')));
    } else {
      nodes.push(dayCard(todays, gaps, nowMin));
    }
    nodes.push(todayRoutines(now, gaps, nowMin));
    box.replaceChildren(...nodes);
    updateTaskHint();
  }

  function dayCard(todays, gaps, nowMin) {
    const s = state.settings;
    const ds = C.toMin(s.dayStart), de = C.toMin(s.dayEnd), total = de - ds;
    const pos = (a, b) => {
      a = Math.max(a, ds); b = Math.min(b, de);
      return 'left:' + ((a - ds) / total * 100) + '%;width:' + (Math.max(0, b - a) / total * 100) + '%';
    };
    const bar = h('div', { class: 'timeline', 'aria-hidden': 'true' });
    gaps.forEach((g) => bar.append(h('span', { class: 'tl-gap' + (g.state === 'past' ? ' past' : ''), style: pos(g.start, g.end) })));
    todays.forEach((b) => bar.append(h('span', {
      class: 'tl-block' + (C.toMin(b.end) <= nowMin ? ' past' : ''), style: pos(C.toMin(b.start), C.toMin(b.end))
    })));
    if (nowMin >= ds && nowMin <= de) bar.append(h('span', { class: 'tl-now', style: 'left:' + ((nowMin - ds) / total * 100) + '%' }));

    // 화면 읽기 프로그램도 같은 내용을 읽을 수 있게 글 목록으로도 보여 준다
    const rows = todays.map((b) => ({ start: C.toMin(b.start), block: b }))
      .concat(gaps.map((g) => ({ start: g.start, gap: g })))
      .sort((x, y) => x.start - y.start);
    const list = h('ul', { class: 'plain', 'aria-label': '오늘 일정과 빈 시간' }, rows.map((row) => {
      if (row.block) {
        const b = row.block;
        return h('li', null, h('div', { class: 'gap-row past' },
          h('span', null, h('span', { class: 'num' }, b.start + '–' + b.end), ' ' + b.name),
          h('span', null, b.kind)));
      }
      const g = row.gap;
      const label = g.state === 'past' ? '지남'
        : g.state === 'now' ? '지금 · ' + C.fmtDuration(g.remaining) + ' 남음'
          : C.fmtDuration(g.len);
      return h('li', null, h('div', { class: 'gap-row' + (g.state === 'past' ? ' past' : '') },
        h('span', { class: 'when' }, h('span', { class: 'num' }, C.fmtHM(g.start) + '–' + C.fmtHM(g.end)), ' 빈 시간'),
        h('span', null, label)));
    }));

    return h('section', { class: 'card', 'aria-labelledby': 'dayCardH' },
      h('h3', { id: 'dayCardH' }, '오늘의 시간'),
      h('div', null, bar,
        h('div', { class: 'tl-scale', 'aria-hidden': 'true' }, h('span', null, s.dayStart), h('span', null, s.dayEnd)),
        h('div', { class: 'legend', 'aria-hidden': 'true' },
          h('span', { class: 'lg-block' }, '고정 일정'), h('span', { class: 'lg-gap' }, '빈 시간'), h('span', { class: 'lg-now' }, '지금'))),
      gaps.length ? null : h('p', { class: 'sub' }, '오늘은 15분 넘는 빈 시간이 없어요. 루틴은 최소 버전을 고려해 보세요.'),
      list);
  }

  function todayRoutines(now, gaps, nowMin) {
    const sec = h('section', { class: 'section', 'aria-labelledby': 'todayRoutinesH' },
      h('div', { class: 'section-head' },
        h('h3', { id: 'todayRoutinesH' }, '오늘 할 루틴'),
        h('span', { class: 'sub' }, '목표는 하나, 정한 횟수만큼 하기')));
    if (!state.routines.length) {
      sec.append(emptyBox('루틴이 없어요.',
        '주 1회처럼 작게 하나 만들어 보세요. 시작 신호(앵커)와 바쁜 날용 최소 버전을 함께 정해요.',
        h('button', { type: 'button', class: 'btn', onclick: () => switchTab('routines', 'rName') }, '루틴 만들기')));
      return sec;
    }
    const infos = state.routines.map((r) => routineInfo(r, now, gaps, nowMin));
    const todo = infos.filter((i) => i.todo).sort((a, b) =>
      (b.missed - a.missed) || (!!b.tight - !!a.tight) ||
      ((a.anchor.today ? a.anchor.plannedMin : 9999) - (b.anchor.today ? b.anchor.plannedMin : 9999)) ||
      a.r.name.localeCompare(b.r.name));
    const rest = infos.filter((i) => !i.todo);

    if (!todo.length) sec.append(h('p', { class: 'sub' }, '오늘 할 루틴을 모두 했거나 이번 주 횟수를 채웠어요.'));
    else sec.append(h('ul', { class: 'items plain-list', role: 'list' }, todo.map(todayItem)));

    if (rest.length) {
      sec.append(h('h3', { class: 'sub' }, '오늘은 쉬어도 되는 루틴'),
        h('ul', { class: 'plain done-list' }, rest.map((i) => h('li', null,
          i.r.name + ' · ' + (i.doneToday ? '오늘 했어요' : '이번 주 횟수를 채웠어요') +
          ' (이번 주 ' + i.done + '/' + i.r.perWeek + ')'))));
    }
    return sec;
  }

  function ruleLine(r, anchor) {
    const p = h('p', { class: 'rule' }, anchorPhrase(r), h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
      h('span', { class: 'sr-only' }, ' 그러면 '), r.name);
    if (anchor && anchor.type === 'block' && !anchor.today) p.append(h('span', { class: 'sub' }, ' · 오늘은 ' + q(anchor.block.name) + '이(가) 없는 날'));
    if (anchor && anchor.type === 'block' && anchor.today) p.append(h('span', { class: 'sub num' }, ' · ' + anchor.block.end));
    return p;
  }

  function fitLine(info) {
    if (info.fit === 'nogap') return h('p', { class: 'fit-line' }, h('span', { class: 'pill nogap' }, '오늘 남은 빈 시간이 없어요'));
    const label = { fits: '들어가요', min: '최소 버전만 들어가요', tight: '빠듯해요' }[info.fit];
    const g = info.pick.gap;
    return h('p', { class: 'fit-line' },
      h('span', { class: 'pill ' + info.fit }, label),
      h('span', null, (info.pick.anchored ? '앵커 다음 빈 시간 ' : '남은 가장 큰 빈 시간 ') + C.fmtHM(g.start) + '–' + C.fmtHM(g.end) +
        ' · 쓸 수 있는 시간 ' + C.fmtDuration(info.pick.avail)));
  }

  function todayItem(info) {
    const r = info.r;
    const li = h('li', { class: 'item' + (info.missed || info.tight ? ' flagged' : ''), id: 'ti-' + r.id });
    li.append(h('div', { class: 'item-head' },
      h('h4', { class: 'item-name' }, r.name),
      h('span', { class: 'sub num' }, '이번 주 ' + info.done + '/' + r.perWeek)));
    li.append(ruleLine(r, info.anchor));
    if (info.missed) li.append(h('p', { class: 'flag' }, '어제는 못 했어요. 두 번 연속으로는 놓치지 않기 · 최소 버전도 괜찮아요.'));
    if (info.tight) li.append(h('p', { class: 'flag' }, '이번 주 ' + info.tight.left + '번 남았는데 남은 날은 ' + info.tight.daysLeft + '일이에요. 하루에 두 번은 한 번으로 세요.'));
    li.append(h('div', { class: 'facts' }, h('p', null, info.cal
      ? '기록 기준으로 기본은 약 ' + info.predBase + '분, 최소는 약 ' + info.predMin + '분 걸려요 (' +
        (info.cal.source === 'routine' ? '이 루틴' : q(r.category) + ' 기록') + ', 예상의 ' + info.cal.ratio.toFixed(1) + '배).'
      : '기본 ' + r.baseMin + '분 · 최소 ' + r.minMin + '분 · 기록이 3개 쌓이면 실제 걸리는 시간으로 보정해 드려요.')));
    li.append(fitLine(info));

    const preferMin = info.fit === 'min' || info.fit === 'tight' || info.fit === 'nogap';
    li.append(h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn' + (preferMin ? '' : ' primary'), onclick: () => onStartRoutine(r, 'base') },
        '시작 · 기본 ' + r.baseMin + '분'),
      h('button', { type: 'button', class: 'btn' + (preferMin ? ' primary' : ''), onclick: () => onStartRoutine(r, 'min') },
        '최소 버전 · ' + r.minMin + '분'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => openPanel(r.id, 'manual', 'base') }, '타이머 없이 기록')));
    if (ui.panel && ui.panel.routineId === r.id) li.append(routinePanel(r));
    return li;
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
      if (manual) saveManualRoutine(r, version, Number($('pAct').value), $('pAmt') && $('pAmt').value.trim() ? Number($('pAmt').value) : null, estimate);
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
    const anchor = C.anchorToday(r, state.blocks, now.getDay());
    let planned = null;
    if (anchor.today && anchor.plannedMin != null) {
      const p = C.atMinutes(now, anchor.plannedMin).toISOString();
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

  function saveManualRoutine(r, version, actual, amount, estimate) {
    const end = new Date();
    const rec = {
      id: uid('t'), kind: 'routine', routineId: r.id, name: r.name, category: r.category, version,
      estimateMin: estimate, actualMin: actual, amount: amountFor(r, version, amount), plannedStartAt: null,
      startedAt: new Date(end.getTime() - actual * 60000).toISOString(), endedAt: end.toISOString(), source: 'manual'
    };
    state.records.push(rec);
    ui.panel = null;
    if (commit()) showStatus('info', q(r.name) + ' 기록했어요. 실제 ' + actual + '분 걸렸어요.', recordSummary(rec, r));
    renderAll();
    $('todayH').focus();
  }

  // ---------- 한 번만 하는 일 ----------
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
    const now = new Date();
    const cur = C.computeGaps(state.blocks, now.getDay(), state.settings, C.minutesOfDay(now)).find((g) => g.state === 'now');
    if (state.blocks.length && cur) text += ' 지금 빈 시간은 ' + C.fmtDuration(cur.remaining) + ' 남았어요.';
    $('tHint').textContent = text;
  }

  function bindTaskForm() {
    const toggle = () => {
      const m = $('tManual').checked;
      $('tActualField').hidden = !m;
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
        const rec = {
          id: uid('t'), kind: 'task', routineId: null, name, category, version: null, estimateMin: est, actualMin: act,
          amount: null, plannedStartAt: null, startedAt: new Date(now.getTime() - act * 60000).toISOString(),
          endedAt: now.toISOString(), source: 'manual'
        };
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
      if (manual) $('tName').focus(); else $('activeTitle').focus();
    });
  }

  // ========== 루틴 ==========
  function weeksDots(r) {
    const weeks = C.lastWeeks(state.records, r, new Date());
    const counted = weeks.filter((w) => w.state !== 'none');
    const doneN = counted.filter((w) => w.state === 'done').length;
    const label = counted.length
      ? '지난 ' + counted.length + '주 중 ' + doneN + '주 채움 (주별 ' + counted.map((w) => w.count).join('·') + '일 / 목표 ' + r.perWeek + '일)'
      : '지난주 기록 전이에요';
    return h('span', { class: 'weeks' },
      h('span', { class: 'weeks', 'aria-hidden': 'true' }, weeks.map((w) => h('span', { class: 'wk ' + w.state, title: w.count + '/' + r.perWeek }))),
      h('span', { class: 'sub' }, ' ' + label));
  }

  function renderRoutines() {
    const box = $('routinesDyn');
    const nodes = [h('div', { class: 'day-head' },
      h('h2', null, '내 루틴'),
      h('p', { class: 'sub' }, '목표는 정한 횟수만큼 하는 것 하나예요. 걸린 시간은 기록만 하고 판단하지 않아요.'))];
    if (!state.routines.length) {
      nodes.push(emptyBox('아직 루틴이 없어요.', '아래에서 주 1회처럼 작게 하나 만들어 보세요. 한 번에 한두 개로 시작하는 편이 오래가요.'));
    } else {
      const now = new Date();
      nodes.push(h('ul', { class: 'items plain-list', role: 'list' }, state.routines.map((r) => {
        const li = h('li', { class: 'item', id: 'rc-' + r.id },
          h('div', { class: 'item-head' }, h('h3', { class: 'item-name' }, r.name), h('span', { class: 'tag' }, r.category)),
          ruleLine(r, null),
          h('div', { class: 'facts' },
            h('p', null, perWeekText(r.perWeek) + ' · 기본 ' + r.baseMin + '분 / 최소 ' + r.minMin + '분 · ' + measureText(r.measure)),
            h('p', null, '이번 주 ' + C.weekDone(state.records, r.id, now) + '/' + r.perWeek + ' · ', weeksDots(r)),
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
    state.routines = state.routines.filter((x) => x.id !== id);
    if (ui.editRoutine === id) resetRoutineForm();
    if (ui.panel && ui.panel.routineId === id) ui.panel = null;
    if (commit()) showStatus('info', q(r.name) + ' 루틴을 지웠어요.', '기록은 돌아보기에 남아 있어요.');
    renderAll();
    $('routineFormH').focus();
  }

  function selectedRadio(name) { const el = document.querySelector('input[name="' + name + '"]:checked'); return el ? el.value : null; }
  function setRadio(name, value) { document.querySelectorAll('input[name="' + name + '"]').forEach((el) => { el.checked = el.value === value; }); }

  function toggleRoutineFields() {
    const a = selectedRadio('rAnchor');
    $('rAnchorBlockField').hidden = a !== 'block';
    $('rAnchorTimeField').hidden = a !== 'time';
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
    setRadio('rMeasure', 'count');
    $('rCountUnit').value = '장';
    $('rFixedAmount').value = '';
    $('rFixedUnit').value = '';
    $('routineFormH').textContent = '루틴 만들기';
    $('rSubmit').textContent = '루틴 만들기';
    $('rCancel').hidden = true;
    syncAnchorBlocks();
    toggleRoutineFields();
  }

  function editRoutine(id) {
    const r = findRoutine(id);
    if (!r) return;
    resetRoutineForm();
    ui.editRoutine = id;
    $('rName').value = r.name;
    $('rCategory').value = r.category;
    $('rPerWeek').value = String(r.perWeek);
    $('rBase').value = String(r.baseMin);
    $('rMin').value = String(r.minMin);
    const a = r.anchor;
    if (a && a.type === 'block' && findBlock(a.blockId)) { setRadio('rAnchor', 'block'); $('rAnchorBlock').value = a.blockId; }
    else if (a && a.type === 'time') { setRadio('rAnchor', 'time'); $('rAnchorTime').value = a.time; }
    else setRadio('rAnchor', 'none');
    setRadio('rMeasure', r.measure.type);
    if (r.measure.type === 'fixed') { $('rFixedAmount').value = String(r.measure.amount); $('rFixedUnit').value = r.measure.unit; }
    if (r.measure.type === 'count') $('rCountUnit').value = r.measure.unit;
    $('routineFormH').textContent = q(r.name) + ' 고치기';
    $('rSubmit').textContent = '고친 내용 저장';
    $('rCancel').hidden = false;
    toggleRoutineFields();
    $('routineFormH').scrollIntoView({ block: 'start' });
    $('rName').focus();
  }

  function bindRoutineForm() {
    document.querySelectorAll('input[name="rAnchor"], input[name="rMeasure"]').forEach((el) => el.addEventListener('change', toggleRoutineFields));
    $('rCancel').addEventListener('click', () => {
      const id = ui.editRoutine;
      resetRoutineForm();
      const item = id && $('rc-' + id);
      (item ? item.querySelector('button') : $('rName')).focus();
    });
    ['rName', 'rCategory', 'rBase', 'rMin', 'rFixedAmount', 'rFixedUnit', 'rCountUnit', 'rAnchorTime', 'rAnchorBlock'].forEach((id) =>
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
        perWeek: Number($('rPerWeek').value),
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
          anchorPhrase(saved) + ' → ' + saved.name + ', ' + perWeekText(saved.perWeek) + '. 오늘 탭에서 시작할 수 있어요.');
      }
      resetRoutineForm();
      renderAll();
      const card = $('rc-' + saved.id);
      if (card && editing) card.querySelector('button').focus(); else $('rName').focus();
    });
  }

  // ========== 주간 틀 ==========
  function renderWeek() {
    const box = $('weekDyn');
    const nodes = [h('div', { class: 'day-head' },
      h('h2', null, '주간 틀'),
      h('p', { class: 'sub' }, '매주 같은 요일·시간에 반복되는 일정이에요. 이걸 빼고 남는 시간이 빈 시간이 돼요.'))];
    if (!state.blocks.length) {
      nodes.push(emptyBox('아직 고정 일정이 없어요.', '수업, 통학, 알바처럼 내가 옮길 수 없는 일정을 아래에서 넣어 보세요.'));
      box.replaceChildren(...nodes);
      return;
    }
    nodes.push(h('section', { class: 'card', 'aria-labelledby': 'weekOverviewH' },
      h('h3', { id: 'weekOverviewH' }, '요일별로 보기'),
      h('ul', { class: 'plain' }, DAY_ORDER.map((d) => {
        const list = C.dayBlocks(state.blocks, d);
        return h('li', null, h('div', { class: 'gap-row' },
          h('span', { class: 'when' }, C.DAY_NAMES[d] + '요일'),
          h('span', { class: 'sub' }, list.length ? list.map((b) => b.start + '–' + b.end + ' ' + b.name).join(' · ') : '고정 일정 없음')));
      }))));

    nodes.push(h('ul', { class: 'items plain-list', role: 'list', 'aria-label': '고정 일정 목록' }, state.blocks.map((b) => {
      const anchored = state.routines.filter((r) => r.anchor && r.anchor.type === 'block' && r.anchor.blockId === b.id);
      const li = h('li', { class: 'item', id: 'bc-' + b.id },
        h('div', { class: 'item-head' }, h('h3', { class: 'item-name' }, b.name), h('span', { class: 'tag' }, b.kind)),
        h('p', { class: 'facts' }, daysText(b.days) + ' · ', h('span', { class: 'num' }, b.start + '–' + b.end),
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
    $('blockFormH').textContent = '고정 일정 넣기';
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
    $('blockFormH').textContent = q(b.name) + ' 고치기';
    $('bSubmit').textContent = '고친 내용 저장';
    $('bCancel').hidden = false;
    $('blockFormH').scrollIntoView({ block: 'start' });
    $('bName').focus();
  }

  function bindBlockForm() {
    $('bCancel').addEventListener('click', () => {
      const id = ui.editBlock;
      resetBlockForm();
      const item = id && $('bc-' + id);
      (item ? item.querySelector('button') : $('bName')).focus();
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
      $('bName').focus();
    });
  }

  function fillSettingsForm() {
    if ($('settingsForm').contains(document.activeElement)) return;
    $('sDayStart').value = state.settings.dayStart;
    $('sDayEnd').value = state.settings.dayEnd;
    $('sBuffer').value = String(state.settings.bufferMin);
  }

  function bindSettingsForm() {
    $('settingsForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      clearErrs($('settingsForm'));
      const errs = [];
      const range = C.checkTimeRange($('sDayStart').value, $('sDayEnd').value);
      if (range) errs.push(setErr(range.field === 'start' ? 'sDayStart' : 'sDayEnd',
        range.field === 'start' ? '하루 시작 시각을 골라 주세요' : range.msg === '끝 시각은 시작보다 늦어야 해요' ? '하루 끝은 시작보다 늦어야 해요' : '하루 끝 시각을 골라 주세요'));
      const buf = $('sBuffer').value.trim();
      if (!/^\d+$/.test(buf) || Number(buf) > 30) errs.push(setErr('sBuffer', '0~30 사이의 분으로 적어 주세요'));
      if (focusFirst(errs)) return;
      state.settings = { dayStart: $('sDayStart').value, dayEnd: $('sDayEnd').value, bufferMin: Number(buf) };
      if (commit()) showStatus('info', '하루 설정을 저장했어요.', state.settings.dayStart + '–' + state.settings.dayEnd + ', 전환 시간 ' + state.settings.bufferMin + '분');
      renderAll();
    });
  }

  // ========== 돌아보기 ==========
  function renderReview() {
    const box = $('reviewDyn');
    const nodes = [h('div', { class: 'day-head' },
      h('h2', null, '돌아보기'),
      h('p', { class: 'sub' }, '목표는 행동, 시간은 거울이에요. 숫자는 잘잘못을 따지려는 게 아니라 다음 계획에 쓰려고 보여 드려요.'))];
    if (!state.records.length) {
      nodes.push(emptyBox('아직 기록이 없어요.', '오늘 탭에서 루틴이나 한 번만 하는 일을 시작해 보세요. 끝내면 여기에 쌓여요.',
        h('button', { type: 'button', class: 'btn', onclick: () => switchTab('today', 'todayH') }, '오늘 탭으로')));
      box.replaceChildren(...nodes);
      return;
    }
    if (state.routines.length) nodes.push(observationSection());
    nodes.push(ratioSection());
    nodes.push(recordsSection());
    box.replaceChildren(...nodes);
  }

  function observationSection() {
    return h('section', { class: 'section', 'aria-labelledby': 'obsH' },
      h('h3', { id: 'obsH' }, '루틴별로 보기'),
      h('ul', { class: 'items plain-list', role: 'list' }, state.routines.map((r) => {
        const dur = C.observeDuration(state.records, r);
        const label = { fixed: '걸린 시간 (' + (r.measure.amount || '') + (r.measure.unit || '') + ', 기본 버전)', count: r.measure.unit + '당 걸린 시간', none: '예상과 실제' }[r.measure.type];
        const li = h('li', { class: 'item' },
          h('div', { class: 'item-head' }, h('h4', { class: 'item-name' }, r.name), h('span', { class: 'sub' }, perWeekText(r.perWeek))),
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
      const kind = r.kind === 'task' ? '한 번만' : (r.version === 'min' ? '루틴 · 최소' : '루틴');
      const amountUnit = routine && routine.measure.unit ? routine.measure.unit : '';
      return h('li', { class: 'rec' },
        h('span', { class: 'rec-name' }, r.name),
        h('span', { class: 'rec-times' }, r.estimateMin + '→' + r.actualMin + '분'),
        h('span', { class: 'rec-meta' }, r.category + ' · ' + dateText(r.startedAt) + ' · ' + kind +
          (r.amount ? ' · ' + r.amount + amountUnit : ''),
          r.source === 'manual' ? h('span', { class: 'tag' }, '직접 입력') : null),
        h('span', { class: 'rec-del' }, h('button', {
          type: 'button', class: 'btn small ghost', 'aria-label': q(r.name) + ' ' + dateText(r.startedAt) + ' 기록 지우기',
          onclick: () => deleteRecord(r.id)
        }, '지우기')));
    })));
    if (list.length > shown.length) {
      sec.append(h('button', {
        type: 'button', class: 'btn', onclick: () => { ui.showAll = true; renderReview(); const items = document.querySelectorAll('#recordList .rec-del button'); if (items[RECORDS_PAGE]) items[RECORDS_PAGE].focus(); }
      }, '더 보기 (' + (list.length - shown.length) + '개 남음)'));
    }
    return sec;
  }

  function deleteRecord(id) {
    const idx = [...document.querySelectorAll('#recordList .rec-del button')].indexOf(document.activeElement);
    const rec = state.records.find((r) => r.id === id);
    state.records = state.records.filter((r) => r.id !== id);
    if (commit() && rec) showStatus('info', q(rec.name) + ' 기록을 지웠어요.', dateText(rec.startedAt) + ' · ' + rec.actualMin + '분');
    renderAll();
    const after = [...document.querySelectorAll('#recordList .rec-del button')];
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
      ui.panel = null; ui.confirm = null; ui.filter = '전체';
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
    ui.panel = null; ui.confirm = null; ui.filter = '전체';
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
    setInterval(minuteTicker, 10000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderActive(); minuteTicker(); } });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
