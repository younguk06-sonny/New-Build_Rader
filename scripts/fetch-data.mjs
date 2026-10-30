// GitHub Actions가 매일 실행하는 데이터 수집 스크립트
//   node scripts/fetch-data.mjs
// 필요한 환경변수(GitHub 저장소 Settings → Secrets and variables → Actions):
//   DATA_GO_KR_KEY  공공데이터포털 '청약홈 분양정보'·'청약 경쟁률' Decoding 키
//   KOSIS_KEY       KOSIS OpenAPI 키
// 결과: public/data/unsold.json, permit.json, cheongyak/<시도>.json, meta.json
//       cache/comp.json (경쟁률 캐시 — 이미 받은 단지는 다시 묻지 않음)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSeries, fetchByFirstClass, search, call as kosisCall, meta as kosisMeta } from '../lib/kosis.mjs';
import { KOSIS_SOURCES, SUPPLY_SOURCES, POPULATION_SOURCE } from '../lib/sources.mjs';
import { REGION_TABLES, monthlySeries, ageProfile } from '../lib/regionstats.mjs';
import { collectTrades, buildTradeView } from '../lib/trade.mjs';
import { summarizeCompetition } from '../lib/competition.mjs';
import { parseRegion } from '../lib/region.mjs';
import { getJSON, pool } from '../lib/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'data');
const CACHE = path.join(ROOT, 'cache', 'comp.json');
const YEARS = 3;
const RECHECK_DAYS = 45; // 최근 공고는 경쟁률이 바뀔 수 있어 다시 확인
const ODCLOUD = process.env.ODCLOUD_BASE || 'https://api.odcloud.kr/api';
const DETAIL = '/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail';
const CMPET = '/ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet';
const SIDOS = ['서울','인천','경기','강원','충남','세종','충북','경북','대전','전북','대구','울산','전남광주','경남','부산','제주'];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const readJSON = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return d; } };
const writeJSON = async (p, o) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, JSON.stringify(o)); };
const num = (v) => { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const ymd = (d) => d.toISOString().slice(0, 10);

// 실제 시·군·구 목록(지도와 같은 2026.10 기준) — 주소 해석 검증용
const GEO = await readJSON(path.join(OUT, 'geo.json'), { sgg: [] });
const VALID = {};
for (const f of GEO.sgg) (VALID[f.sd] ||= new Set()).add(f.n);

const meta = await readJSON(path.join(OUT, 'meta.json'), {});
meta.runAt = new Date().toISOString();
delete meta.permit; delete meta.permitPrd; delete meta.kosisSearch; // 예전 항목 정리
const errors = [];

/* ---------- KOSIS: 미분양 · 인허가 ---------- */
const TOTALS = new Set(['', '계', '합계', '총계', '전체', '소계']);
const distinct = (rows, i, n = 40) => [...new Set(rows.map((r) => r[i]))].slice(0, n);
// 월별 누계 → 월별 값 (같은 해 안에서 전월 누계를 뺌, 1월은 그대로)
// 통합 첫 달의 '전남광주'는 전월 행이 없으므로 전월 광주+전남 누계를 대신 사용
function decumulate(rows) {
  const val = new Map();
  for (const r of rows) val.set(r.slice(0, 5).join('|'), r[5]);
  const prevPeriod = (p) => { const y = +p.slice(0, 4), m = +p.slice(4); return m === 1 ? null : `${y}${String(m - 1).padStart(2, '0')}`; };
  return rows.map((r) => {
    const p = r[4];
    if (p.slice(4) === '01' || r[5] == null) return [...r.slice(0, 5), r[5]];
    const pp = prevPeriod(p);
    let prev = val.get([...r.slice(0, 4), pp].join('|'));
    if (prev == null) {
      const i = r.findIndex((c, k) => k < 3 && c === '전남광주');
      if (i >= 0) {
        const alt = (name) => { const x = r.slice(0, 4); x[i] = name; return val.get([...x, pp].join('|')); };
        const g = alt('광주'), j = alt('전남');
        if (g != null || j != null) prev = (g || 0) + (j || 0);
      }
    }
    return [...r.slice(0, 5), prev == null ? null : r[5] - prev];
  });
}

if (process.env.KOSIS_KEY) {
  try {
    let j;
    try { j = await fetchByFirstClass(KOSIS_SOURCES.unsold, 120); }
    catch (e1) { log('시·도별 요청 실패 → 기간 분할로 재시도:', e1.message); j = await fetchSeries(KOSIS_SOURCES.unsold, 120); }
    // 항목이 여러 개면 '미분양' 합계 항목만 사용
    const items = distinct(j.rows, 3);
    const itm = items.find((t) => /미분양/.test(t)) || items[0];
    const rows = j.rows.filter((r) => r[3] === itm && TOTALS.has(r[2]));
    const months = [...new Set(rows.map((r) => r[4]))].filter(Boolean).sort();
    const mi = new Map(months.map((m, i) => [m, i]));
    const map = new Map();
    for (const [a, b, , , p, v] of rows) {
      const k = a + '|' + b;
      if (!map.has(k)) map.set(k, [a, b, ...new Array(months.length).fill(null)]);
      if (mi.has(p)) map.get(k)[2 + mi.get(p)] = v;
    }
    if (map.size < 50) throw new Error(`미분양 행이 너무 적음(${map.size}) · 항목 ${items.join('/')}`);
    const fetchedAt = new Date().toISOString();
    await writeJSON(path.join(OUT, 'unsold.json'), { source: `KOSIS ${KOSIS_SOURCES.unsold.tblId} ${j.tblNm}`, months, rows: [...map.values()], fetchedAt });
    meta.unsold = { ok: true, at: fetchedAt, last: months.at(-1), rows: map.size, items, ...j.info };
    log('미분양', months.at(-1), map.size, '행');
  } catch (e) { errors.push('미분양: ' + e.message); meta.unsold = { ok: false, error: e.message }; }

  // 공급 선행지표: 인허가 · 착공 · 분양 (월별)
  meta.supply = {};
  const supplyList = [];
  for (const [name, src] of Object.entries(SUPPLY_SOURCES)) {
    try {
      let j;
      try { j = await fetchSeries(src, 48); }
      catch (e1) { log(name, '기간 분할 실패 → 시·도별로 재시도:', e1.message); j = await fetchByFirstClass(src, 48); }
      let rows = j.rows;
      if (src.cumulative || /누계/.test(j.tblNm)) rows = decumulate(rows);
      const fetchedAt = new Date().toISOString();
      await writeJSON(path.join(OUT, `supply-${name}.json`), { src: name, label: src.label, tblId: src.tblId, tblNm: j.tblNm, unit: j.unit, rows, fetchedAt });
      supplyList.push(name);
      meta.supply[name] = { ok: true, at: fetchedAt, tbl: j.tblNm, rows: rows.length, ...j.info,
        latest: rows.reduce((m, r) => (r[4] > m ? r[4] : m), ''),
        c1: distinct(rows, 0), c2: distinct(rows, 1, 25), c3: distinct(rows, 2, 25), items: distinct(rows, 3, 20) };
      log('공급', name, j.tblNm, rows.length, '행');
    } catch (e) { errors.push(`공급 ${name}: ${e.message}`); meta.supply[name] = { ok: false, tbl: src.tblId, error: e.message }; }
  }
  await writeJSON(path.join(OUT, 'supply-index.json'), { list: supplyList, labels: Object.fromEntries(Object.entries(SUPPLY_SOURCES).map(([k, v]) => [k, v.label])) });

  // 지역 여건: 아파트·주택 매매 거래량, 인구, 세대수(최근 60개월) + 최신 연령 분포
  delete meta.discover;
  const rs = { fetchedAt: new Date().toISOString(), series: {}, age: null };
  meta.regionStats = {};
  for (const [name, src] of Object.entries(REGION_TABLES)) {
    try {
      const d = await monthlySeries(src, VALID, 60);
      rs.series[name] = d;
      const missing = [];
      for (const [sd, set] of Object.entries(VALID)) for (const n of set) if (!d.sgg[sd]?.[n] && !(sd === '세종' && d.sido['세종'])) missing.push(sd + ' ' + n);
      meta.regionStats[name] = { ok: true, tbl: src.tblId, item: d.itm, from: d.months[0], to: d.months.at(-1), regions: d.regions, missingCount: missing.length, missing: missing.slice(0, 20) };
      log('지역여건', name, d.months[0], '~', d.months.at(-1), '빠짐', missing.length);
    } catch (e) { errors.push(`지역여건 ${name}: ${e.message}`); meta.regionStats[name] = { ok: false, tbl: src.tblId, error: e.message }; }
  }
  try {
    rs.age = await ageProfile(VALID);
    const nS = Object.values(rs.age.sgg).reduce((a, o) => a + Object.keys(o).length, 0);
    meta.regionStats.age = { ok: true, month: rs.age.month, groups: rs.age.groups.length, sgg: nS };
    log('연령', rs.age.month, '시·군·구', nS);
  } catch (e) { errors.push('연령: ' + e.message); meta.regionStats.age = { ok: false, error: e.message }; }
  if (Object.keys(rs.series).length || rs.age) await writeJSON(path.join(OUT, 'region-stats.json'), rs);

  // 인구: 최신 1개월, 시·도와 시·군·구별 총인구
  try {
    const src = POPULATION_SOURCE;
    let raw = null, lastErr = null;
    for (const lv of [1, 2]) {
      const extra = { prdSe: 'M', newEstPrdCnt: '1' };
      for (let k = 1; k <= lv; k++) extra[`objL${k}`] = 'ALL';
      try { raw = await kosisCall(src, extra); break; } catch (e) { lastErr = e; }
    }
    if (!raw) throw lastErr || new Error('인구 응답 없음');
    const items = [...new Set(raw.map((r) => (r.ITM_NM || '').trim()))];
    const itm = items.find((t) => /총인구/.test(t)) || items.find((t) => /계|인구/.test(t)) || items[0];
    const rows = raw.filter((r) => (r.ITM_NM || '').trim() === itm);
    // 행정구역 코드 앞 2자리 = 시·도. 시·도 행(뒤가 0)으로 이름표 만들기
    const code = (r) => String(r.C1 || '');
    const sidoName = {};
    // 시·도 행: 코드 2자리(예: 11) 또는 뒤가 모두 0인 긴 코드(예: 1100000000). 00은 전국
    const isSido = (c) => /^\d+$/.test(c) && c.slice(0, 2) !== '00' && (c.length === 2 || /^0+$/.test(c.slice(2)));
    for (const r of rows) { const c = code(r); if (isSido(c)) sidoName[c.slice(0, 2)] = (r.C1_NM || '').trim(); }
    const SHORT = { 서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천', 대전광역시: '대전', 울산광역시: '울산', 세종특별자치시: '세종', 경기도: '경기', 강원도: '강원', 강원특별자치도: '강원', 충청북도: '충북', 충청남도: '충남', 전라북도: '전북', 전북특별자치도: '전북', 전남광주통합특별시: '전남광주', 광주광역시: '전남광주', 전라남도: '전남광주', 경상북도: '경북', 경상남도: '경남', 제주특별자치도: '제주' };
    const pop = { sido: {}, sgg: {} };
    let month = '';
    for (const r of rows) {
      const c = code(r), v = r.DT == null || r.DT === '-' ? null : Number(r.DT);
      if (v == null || c.length < 2 || c.slice(0, 2) === '00') continue;
      month = String(r.PRD_DE || month);
      const sd = SHORT[sidoName[c.slice(0, 2)]];
      if (!sd) continue;
      const nm = (r.C1_NM || '').trim();
      if (isSido(c)) { pop.sido[sd] = (pop.sido[sd] || 0) + v; continue; } // 광주+전남은 합산
      if (sd === '세종') { pop.sgg['세종'] = { 세종시: pop.sido['세종'] || v }; continue; }
      const name = nm.replace(/특례시$/, '시').split(' ').pop();
      if (!VALID[sd]?.has(name)) continue; // 일반구(장안구 등)·옛 행정구역은 건너뜀
      (pop.sgg[sd] ||= {})[name] = v;
    }
    if (pop.sgg['세종'] && pop.sido['세종']) pop.sgg['세종'].세종시 = pop.sido['세종'];
    const nSgg = Object.values(pop.sgg).reduce((a, o) => a + Object.keys(o).length, 0);
    if (Object.keys(pop.sido).length < 10) throw new Error(`시·도 인구가 너무 적음(${Object.keys(pop.sido).length}) · 예: ${rows.slice(0, 3).map((r) => code(r) + ' ' + r.C1_NM).join(', ')}`);
    await writeJSON(path.join(OUT, 'population.json'), { source: '행정안전부 주민등록인구(KOSIS ' + src.tblId + ')', item: itm, month, ...pop });
    const missing = [];
    for (const [sd, set] of Object.entries(VALID)) for (const n of set) if (pop.sgg[sd]?.[n] == null) missing.push(sd + ' ' + n);
    meta.population = { ok: true, month, item: itm, sido: Object.keys(pop.sido).length, sgg: nSgg, missing: missing.slice(0, 30), missingCount: missing.length };
    log('인구', month, '시·도', Object.keys(pop.sido).length, '시·군·구', nSgg, '빠짐', missing.length);
  } catch (e) { errors.push('인구: ' + e.message); meta.population = { ok: false, error: e.message }; }
} else {
  log('KOSIS_KEY 없음 — 미분양·인허가 건너뜀');
}

/* ---------- 청약홈: 공고 + 경쟁률 ---------- */
async function paged(key, pathName, cond) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const q = new URLSearchParams({ page: String(page), perPage: '1000', ...cond, serviceKey: key });
    const res = await getJSON(`${ODCLOUD}${pathName}?${q}`, { timeoutMs: 30000, tries: 3 });
    const data = res?.data || [];
    out.push(...data);
    const total = res?.matchCount ?? res?.totalCount;
    if (data.length < 1000 || (total && out.length >= total)) break;
  }
  return out;
}

const key = process.env.DATA_GO_KR_KEY;
if (key) {
  try {
    const fromD = new Date(); fromD.setFullYear(fromD.getFullYear() - YEARS);
    const from = ymd(fromD);
    let notices;
    try { notices = await paged(key, DETAIL, { 'cond[RCRIT_PBLANC_DE::GTE]': from }); }
    catch (e) { log('날짜 조건 검색 실패 → 전체 조회 후 거름:', e.message); notices = await paged(key, DETAIL, {}); }
    const seen = new Set();
    notices = notices.filter((r) => {
      const id = r.PBLANC_NO || r.HOUSE_MANAGE_NO;
      if (!id || seen.has(id)) return false; seen.add(id);
      return !r.RCRIT_PBLANC_DE || r.RCRIT_PBLANC_DE >= from;
    });
    log('청약 공고', notices.length, '건 (', from, '이후)');

    // 경쟁률: 캐시에 없거나 최근 공고만 새로 조회
    const cache = await readJSON(CACHE, {});
    const recent = ymd(new Date(Date.now() - RECHECK_DAYS * 864e5));
    const ids = notices.map((r) => r.HOUSE_MANAGE_NO || r.PBLANC_NO);
    const need = notices.filter((r) => { const id = r.HOUSE_MANAGE_NO || r.PBLANC_NO; const c = cache[id]; return !c || (r.RCRIT_PBLANC_DE || '') >= recent || !c.sum; });
    log('경쟁률 조회 필요', need.length, '건 / 캐시', Object.keys(cache).length);
    let sample = null, fails = 0;
    await pool(need, 4, async (r) => {
      const id = r.HOUSE_MANAGE_NO || r.PBLANC_NO;
      try {
        const rows = await paged(key, CMPET, { 'cond[HOUSE_MANAGE_NO::EQ]': id });
        if (!sample && rows[0]) sample = rows[0];
        cache[id] = { at: ymd(new Date()), sum: summarizeCompetition(rows) };
      } catch (e) { fails++; }
    });
    const idSet = new Set(ids);
    for (const id of Object.keys(cache)) if (!idSet.has(id)) delete cache[id]; // 3년 지난 단지 정리
    await writeJSON(CACHE, cache);

    // 시·도별 파일
    const bySido = Object.fromEntries(SIDOS.map((s) => [s, []]));
    let unmatched = 0; const noSgg = [];
    for (const r of notices) {
      const reg = parseRegion(r.HSSPLY_ADRES, r.SUBSCRPT_AREA_CODE_NM, VALID);
      if (!reg.sido || !bySido[reg.sido]) { unmatched++; continue; }
      if (!reg.sgg) noSgg.push(r.HSSPLY_ADRES);
      const id = r.HOUSE_MANAGE_NO || r.PBLANC_NO;
      bySido[reg.sido].push({
        id, name: r.HOUSE_NM, addr: r.HSSPLY_ADRES, sgg: reg.sgg,
        date: r.RCRIT_PBLANC_DE || null, rcept: r.RCEPT_BGNDE || null, winner: r.PRZWNER_PRESNATN_DE || null,
        total: num(r.TOT_SUPLY_HSHLDCO),
        kind: [r.HOUSE_DTL_SECD_NM, r.RENT_SECD_NM].filter(Boolean).join(' · '),
        builder: r.CNSTRCT_ENTRPS_NM || r.BSNS_MBY_NM || '',
        mvn: r.MVN_PREARNGE_YM || null,
        url: /^https?:\/\//.test(r.PBLANC_URL || '') ? r.PBLANC_URL : null,
        comp: cache[id]?.sum || null,
      });
    }
    const fetchedAt = new Date().toISOString();
    for (const [sd, items] of Object.entries(bySido)) {
      items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      await writeJSON(path.join(OUT, 'cheongyak', `${sd}.json`), { sido: sd, from, fetchedAt, items });
    }
    meta.cheongyak = { ok: fails === 0, at: fetchedAt, from, notices: notices.length, unmatched, noSgg: noSgg.length, noSggSample: noSgg.slice(0, 10), compFails: fails };
    if (sample) meta.compSample = Object.keys(sample); // 경쟁률 응답 필드 이름 확인용(값은 저장 안 함)
    log('청약 저장 완료 · 지역 미배정', unmatched, '· 경쟁률 실패', fails);
    if (fails > need.length * 0.3 && need.length > 10) errors.push(`청약 경쟁률 조회 실패 ${fails}/${need.length}`);
  } catch (e) { errors.push('청약: ' + e.message); meta.cheongyak = { ...(meta.cheongyak || {}), ok: false, error: e.message }; }
} else {
  log('DATA_GO_KR_KEY 없음 — 청약 건너뜀');
}

/* ---------- 국토교통부 아파트 매매 실거래가 ---------- */
if (process.env.DATA_GO_KR_KEY) {
  try {
    const codes = await readJSON(path.join(ROOT, 'lib', 'lawd-codes.json'), {});
    const r = await collectTrades({ root: ROOT, codes, log });
    if (r.months && r.complete > 0) { // 하나도 못 받았으면 파일을 만들지 않음(화면에 신청 안내 표시)
      const view = buildTradeView(r);
      await writeJSON(path.join(OUT, 'trade.json'), { source: '국토교통부 아파트 매매 실거래가(공공데이터포털)', fetchedAt: new Date().toISOString(), complete: r.complete, ...view });
    }
    meta.trade = { ok: r.ok, error: r.error || undefined, complete: r.complete, done: r.done, fails: r.fails, remaining: r.remaining, callsToday: r.callsToday };
    log('실거래가', meta.trade);
    if (r.error) errors.push('실거래가: ' + r.error);
  } catch (e) { errors.push('실거래가: ' + e.message); meta.trade = { ok: false, error: e.message }; }
}

await writeJSON(path.join(OUT, 'meta.json'), meta);
if (errors.length) { console.error('일부 실패:\n- ' + errors.join('\n- ')); }
log('끝');
// 일부가 실패해도 이전 자료로 사이트는 배포되도록 종료 코드는 0
