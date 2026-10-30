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
import { fetchSeries, fetchByFirstClass, search, meta as kosisMeta } from '../lib/kosis.mjs';
import { KOSIS_SOURCES } from '../lib/sources.mjs';
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
const errors = [];

/* ---------- KOSIS: 미분양 · 인허가 ---------- */
const TOTALS = new Set(['', '계', '합계', '총계', '전체', '소계']);
const distinct = (rows, i, n = 40) => [...new Set(rows.map((r) => r[i]))].slice(0, n);

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

  try {
    const j = await fetchSeries(KOSIS_SOURCES.permit, 48);
    const fetchedAt = new Date().toISOString();
    await writeJSON(path.join(OUT, 'permit.json'), { src: 'permit', label: KOSIS_SOURCES.permit.label, tblId: KOSIS_SOURCES.permit.tblId, tblNm: j.tblNm, unit: j.unit, prdSe: j.info.prdSe, rows: j.rows, fetchedAt });
    // 표 구조 확인용 요약(분류 이름 일부)
    meta.permit = { ok: true, at: fetchedAt, tbl: j.tblNm, rows: j.rows.length, ...j.info, c1: distinct(j.rows, 0), c2: distinct(j.rows, 1, 20), c3: distinct(j.rows, 2, 20), items: distinct(j.rows, 3, 20) };
    log('인허가', j.tblNm, j.rows.length, '행', j.info);
  } catch (e) { errors.push('인허가: ' + e.message); meta.permit = { ok: false, error: e.message }; }

  // 시·군·구 단위 인허가·착공 통계표 후보 찾기(참고용)
  meta.kosisSearch = {};
  try { const pm = await kosisMeta(KOSIS_SOURCES.permit, 'PRD'); meta.permitPrd = pm.slice(0, 5); } catch (e) { meta.permitPrd = 'error: ' + e.message; }
  for (const w of ['인허가', '주택건설 인허가', '착공', '주택 착공', '주택건설실적', '시군구별 인허가']) {
    try { meta.kosisSearch[w] = (await search(w)).slice(0, 20); } catch (e) { meta.kosisSearch[w] = 'error: ' + e.message; }
  }
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

await writeJSON(path.join(OUT, 'meta.json'), meta);
if (errors.length) { console.error('일부 실패:\n- ' + errors.join('\n- ')); }
log('끝');
// 일부가 실패해도 이전 자료로 사이트는 배포되도록 종료 코드는 0
