/* 공휴일 데이터 받기 (GitHub Actions에서 한 달에 한 번 실행)
 * 출처: 한국천문연구원 특일 정보 (공공데이터포털) · getRestDeInfo(공휴일 정보 조회)
 * 올해와 내년의 공휴일을 받아 data/holidays.json으로 저장한다. 앱은 이 파일만 읽는다.
 *
 * 실행: DATA_GO_KR_KEY=<공공데이터포털 일반 인증키(Decoding)> node scripts/fetch-holidays.js
 * 한 달이라도 실패하면 파일을 건드리지 않고 끝낸다 (기존 데이터를 지키기 위해).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ENDPOINT = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';
const OUT = path.join(__dirname, '..', 'data', 'holidays.json');

/* API 응답 하나 → [{ date: 'YYYY-MM-DD', name }] (공휴일만).
 * 결과가 0건이면 items가 빈 문자열, 1건이면 item이 배열이 아니라 객체로 온다. */
function normalize(json) {
  const header = json && json.response && json.response.header;
  if (!header || header.resultCode !== '00') {
    throw new Error('API 오류: ' + (header ? header.resultCode + ' ' + header.resultMsg : '응답 형식이 다름'));
  }
  const items = json.response.body && json.response.body.items;
  if (!items || !items.item) return [];
  const list = Array.isArray(items.item) ? items.item : [items.item];
  return list
    .filter((it) => it.isHoliday === 'Y')
    .map((it) => {
      const d = String(it.locdate);
      return { date: d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8), name: String(it.dateName).trim() };
    });
}

/* 같은 날 두 이름(예: 어린이날·부처님오신날)은 하나로 합친다 */
function merge(list) {
  const map = new Map();
  list.forEach((h) => {
    const prev = map.get(h.date);
    if (!prev) map.set(h.date, h.name);
    else if (!prev.split(' · ').includes(h.name)) map.set(h.date, prev + ' · ' + h.name);
  });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, name]) => ({ date, name }));
}

async function fetchMonth(key, year, month) {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    serviceKey: key, solYear: String(year), solMonth: String(month).padStart(2, '0'), _type: 'json', numOfRows: '50'
  }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(year + '-' + month + ' HTTP ' + res.status);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) {
    // 인증키 오류는 JSON이 아니라 XML로 온다
    throw new Error(year + '-' + month + ' JSON이 아닌 응답 (인증키를 확인해 주세요): ' + text.slice(0, 120).replace(/\s+/g, ' '));
  }
  return normalize(json);
}

async function main() {
  const key = process.env.DATA_GO_KR_KEY;
  if (!key) { console.error('DATA_GO_KR_KEY 환경 변수가 없어요.'); process.exit(1); }
  const thisYear = Number(new Date().toLocaleString('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric' }));
  const years = [thisYear, thisYear + 1];
  const all = [];
  for (const y of years) {
    for (let m = 1; m <= 12; m++) all.push(...await fetchMonth(key, y, m));
  }
  const holidays = merge(all);
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
  if (prev && JSON.stringify(prev.holidays) === JSON.stringify(holidays) && String(prev.years) === String(years)) {
    console.log('변경 없음 (' + holidays.length + '일)');
    return;
  }
  const data = {
    source: '한국천문연구원 특일 정보 (공공데이터포털)',
    updatedAt: new Date().toISOString().slice(0, 10),
    years,
    holidays
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n');
  console.log('저장: ' + holidays.length + '일 (' + years.join(', ') + ')');
}

module.exports = { normalize, merge };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
