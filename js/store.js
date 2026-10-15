/* 루틴메이커 저장소 모듈
 * localStorage 읽기·쓰기와 데이터 구조 검사. 모든 저장소 접근은 try/catch로 감싼다.
 * 브라우저에서는 window.Store, Node 테스트에서는 require('./store.js').
 */
(function (root) {
  'use strict';

  var KEY = 'routinemaker.v1';
  var BACKUP_KEY = 'routinemaker.v1.damaged';
  var TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

  function empty() {
    return {
      version: 1,
      settings: { dayStart: '08:00', dayEnd: '23:00', bufferMin: 10 },
      blocks: [],
      routines: [],
      active: null,
      records: []
    };
  }

  // ---------- 구조 검사 ----------
  function isStr(v, max) { return typeof v === 'string' && v.trim().length > 0 && v.length <= (max || 200); }
  function isPos(v, max) { return typeof v === 'number' && isFinite(v) && v > 0 && v <= (max || Infinity); }
  function isDate(v) { return typeof v === 'string' && !isNaN(Date.parse(v)); }
  function minOf(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3)); }

  function validSettings(s) {
    return !!s && TIME.test(s.dayStart) && TIME.test(s.dayEnd) && minOf(s.dayStart) < minOf(s.dayEnd) &&
      Number.isInteger(s.bufferMin) && s.bufferMin >= 0 && s.bufferMin <= 30;
  }
  function validBlock(b) {
    return !!b && isStr(b.id) && isStr(b.name, 50) && typeof b.kind === 'string' &&
      Array.isArray(b.days) && b.days.length > 0 &&
      b.days.every(function (d) { return Number.isInteger(d) && d >= 0 && d <= 6; }) &&
      TIME.test(b.start) && TIME.test(b.end) && minOf(b.start) < minOf(b.end);
  }
  function validAnchor(a) {
    if (a === null) return true;
    if (!a || typeof a !== 'object') return false;
    if (a.type === 'block') return isStr(a.blockId);
    if (a.type === 'time') return TIME.test(a.time);
    return false;
  }
  function validMeasure(m) {
    if (!m || typeof m !== 'object') return false;
    if (m.type === 'fixed') return Number.isInteger(m.amount) && m.amount >= 1 && isStr(m.unit, 10);
    if (m.type === 'count') return isStr(m.unit, 10);
    return m.type === 'none';
  }
  function validRoutine(r) {
    return !!r && isStr(r.id) && isStr(r.name, 50) && isStr(r.category, 20) &&
      Number.isInteger(r.perWeek) && r.perWeek >= 1 && r.perWeek <= 7 &&
      isPos(r.baseMin, 720) && isPos(r.minMin, 720) && r.minMin < r.baseMin &&
      validAnchor(r.anchor) && validMeasure(r.measure) && isDate(r.createdAt);
  }
  function validEntry(e, finished) {
    if (!e || !isStr(e.id) || (e.kind !== 'routine' && e.kind !== 'task')) return false;
    if (!isStr(e.name, 50) || !isStr(e.category, 20) || !isPos(e.estimateMin, 720) || !isDate(e.startedAt)) return false;
    if (e.kind === 'routine' && (!isStr(e.routineId) || (e.version !== 'base' && e.version !== 'min'))) return false;
    if (e.plannedStartAt != null && !isDate(e.plannedStartAt)) return false;
    if (!finished) return true;
    if (!isPos(e.actualMin) || !isDate(e.endedAt)) return false;
    if (e.amount != null && !isPos(e.amount)) return false;
    return e.source === 'timer' || e.source === 'manual';
  }

  /* 이 앱이 저장하거나 내보낸 데이터 모양인지 */
  function validate(d) {
    if (!d || typeof d !== 'object' || d.version !== 1) return false;
    if (!validSettings(d.settings)) return false;
    if (!Array.isArray(d.blocks) || !d.blocks.every(validBlock)) return false;
    if (!Array.isArray(d.routines) || !d.routines.every(validRoutine)) return false;
    if (d.active !== null && !validEntry(d.active, false)) return false;
    if (!Array.isArray(d.records) || !d.records.every(function (r) { return validEntry(r, true); })) return false;
    return true;
  }

  // ---------- 읽기·쓰기 ----------
  /* { ok:true, data:null(처음) | data } 또는 { ok:false, reason:'storage' | 'corrupt', backedUp } */
  function load() {
    var raw;
    try { raw = root.localStorage.getItem(KEY); }
    catch (e) { return { ok: false, reason: 'storage' }; }
    if (raw === null) return { ok: true, data: null };
    var data;
    try { data = JSON.parse(raw); } catch (e) { data = null; }
    if (validate(data)) return { ok: true, data: data };
    // 손상된 원본은 지우지 않고 따로 보관해 둔다
    var backedUp = false;
    try { root.localStorage.setItem(BACKUP_KEY, raw); backedUp = true; } catch (e) { /* 보관 실패는 안내만 */ }
    return { ok: false, reason: 'corrupt', backedUp: backedUp };
  }

  function save(state) {
    try { root.localStorage.setItem(KEY, JSON.stringify(state)); return true; }
    catch (e) { return false; }
  }

  /* 가져오기: 문자열 → { ok:true, data } | { ok:false } */
  function parseImport(text) {
    var d;
    try { d = JSON.parse(text); } catch (e) { return { ok: false }; }
    return validate(d) ? { ok: true, data: d } : { ok: false };
  }

  var Store = { KEY: KEY, BACKUP_KEY: BACKUP_KEY, empty: empty, validate: validate, load: load, save: save, parseImport: parseImport };

  if (typeof module === 'object' && module.exports) module.exports = Store;
  else root.Store = Store;
})(this);
