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

/* XML 응답(포털 문서의 기본 형식)을 JSON 응답과 같은 모양으로 바꾼다 */
function fromXml(xml) {
  const tag = (src, name) => { const m = src.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>')); return m ? m[1].trim() : ''; };
  const code = tag(xml, 'resultCode') || tag(xml, 'returnReasonCode');
  const msg = tag(xml, 'resultMsg') || tag(xml, 'returnAuthMsg') || tag(xml, 'errMsg');
  const items = (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map((it) => ({
    dateName: tag(it, 'dateName'), isHoliday: tag(it, 'isHoliday'), locdate: tag(it, 'locdate')
  }));
  return { response: { header: { resultCode: code === '00' ? '00' : (code || '?'), resultMsg: msg }, body: { items: items.length ? { item: items } : '' } } };
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
  // 요청변수는 공공데이터포털 문서 기준: ServiceKey, pageNo, numOfRows, solYear, solMonth
  url.search = new URLSearchParams({
    ServiceKey: key, pageNo: '1', numOfRows: '50',
    solYear: String(year), solMonth: String(month).padStart(2, '0'), _type: 'json'
  }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(year + '-' + month + ' HTTP ' + res.status);
  const text = (await res.text()).trim();
  // JSON을 요청하지만, XML로 오면(기본 형식, 인증키 오류 등) XML로 읽는다
  const json = text.startsWith('<') ? fromXml(text) : JSON.parse(text);
  try { return normalize(json); } catch (e) { throw new Error(year + '-' + month + ' ' + e.message); }
}

async function main() {
  const key = process.env.DATA_GO_KR_KEY;
  if (!key) {
    // 키를 아직 넣지 않았으면 실패로 남기지 않고 건너뛴다. Secrets에 넣으면 다음 실행부터 받아 온다
    console.log('::notice::DATA_GO_KR_KEY가 없어서 공휴일 받기를 건너뛰어요. 저장소 Settings → Secrets → Actions에 키를 넣어 주세요.');
    return;
  }
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

module.exports = { normalize, merge, fromXml };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
