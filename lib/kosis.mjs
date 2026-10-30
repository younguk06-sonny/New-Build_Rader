// KOSIS OpenAPI 조회 — scripts/fetch-data.mjs가 사용. 키는 KOSIS_KEY 환경변수.
// - 한 번에 4만 칸까지만 받을 수 있어서 기간을 나눠 여러 번 받습니다.
// - 통계표마다 주기(월·분기·연)와 분류 단계 수가 달라 처음에 자동으로 알아냅니다.
import { env, getJSON } from './http.mjs';

const DATA = () => env('KOSIS_BASE') || 'https://kosis.kr/openapi/Param/statisticsParameterData.do';
const SEARCH = () => env('KOSIS_SEARCH') || 'https://kosis.kr/openapi/statisticsSearch.do';
const META = () => env('KOSIS_META') || 'https://kosis.kr/openapi/statisticsData.do';
const LIMIT = 38000;

async function call(src, extra) {
  const key = env('KOSIS_KEY');
  const q = new URLSearchParams({ method: 'getList', apiKey: key, format: 'json', jsonVD: 'Y', orgId: src.orgId, tblId: src.tblId, itmId: 'ALL', ...extra });
  const data = await getJSON(`${DATA()}?${q}`, { timeoutMs: 60000, tries: 2 });
  if (!Array.isArray(data)) { const e = new Error(data?.errMsg || 'KOSIS 응답 오류'); e.code = data?.err; throw e; }
  return data;
}

function objParams(levels) { const o = {}; for (let i = 1; i <= levels; i++) o[`objL${i}`] = 'ALL'; return o; }

// 주기·분류 단계 수 알아내기 (최근 1개 시점만 요청)
export async function probe(src) {
  const tried = [];
  for (const prdSe of src.prdSe ? [src.prdSe] : ['M', 'Q', 'Y']) {
    for (const levels of src.levels ? [src.levels, 1, 2, 3, 4].filter((v, i, a) => a.indexOf(v) === i) : [2, 1, 3, 4]) {
      try {
        const rows = await call(src, { prdSe, newEstPrdCnt: '1', ...objParams(levels) });
        if (rows.length) return { prdSe, levels, cells: rows.length, latest: String(rows[0].PRD_DE), sample: rows.slice(0, 3) };
      } catch (e) { tried.push(`${prdSe}/${levels}: ${e.message}`); }
    }
  }
  const e = new Error('주기·분류를 찾지 못함 — ' + tried.slice(0, 4).join(' | ')); throw e;
}

function shift(p, prdSe, k) { // 시점 문자열을 k 주기만큼 앞으로
  if (prdSe === 'M') { const y = +p.slice(0, 4), m = +p.slice(4, 6) - 1 - k; const d = new Date(Date.UTC(y, m, 1)); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
  if (prdSe === 'Q') { let y = +p.slice(0, 4), q = +p.slice(4) - k; while (q < 1) { q += 4; y--; } return `${y}${String(q).padStart(2, '0')}`; }
  return String(+p.slice(0, 4) - k);
}

// 최근 periods개 시점 전체를 나눠 받기 → [분류1, 분류2, 분류3, 항목명, 시점, 값]
export async function fetchSeries(src, periods) {
  const info = await probe(src);
  const per = Math.max(1, Math.floor(LIMIT / Math.max(1, info.cells)));
  const out = [];
  let end = info.latest, left = periods;
  while (left > 0) {
    const n = Math.min(per, left);
    const start = shift(end, info.prdSe, n - 1);
    const rows = await call(src, { prdSe: info.prdSe, startPrdDe: start, endPrdDe: end, ...objParams(info.levels) });
    out.push(...rows);
    left -= n; end = shift(start, info.prdSe, 1);
  }
  const rows = out.map((r) => [
    (r.C1_NM || '').trim(), (r.C2_NM || '').trim(), (r.C3_NM || '').trim(),
    (r.ITM_NM || '').trim(), String(r.PRD_DE || ''), r.DT === '-' || r.DT === '' || r.DT == null ? null : Number(r.DT),
  ]);
  return { info: { prdSe: info.prdSe, levels: info.levels, cells: info.cells, latest: info.latest }, tblNm: out[0]?.TBL_NM || '', unit: out[0]?.UNIT_NM || '', rows };
}

// 통계표 분류·항목 목록 (getMeta type=ITM)
export async function meta(src, type = 'ITM') {
  const key = env('KOSIS_KEY');
  const q = new URLSearchParams({ method: 'getMeta', type, apiKey: key, format: 'json', jsonVD: 'Y', orgId: src.orgId, tblId: src.tblId });
  const data = await getJSON(`${META()}?${q}`, { timeoutMs: 60000 });
  if (!Array.isArray(data)) throw new Error(data?.errMsg || 'meta 오류');
  return data;
}

// 첫 번째 분류(시·도)를 하나씩 바꿔 가며 받기 — 한 번에 받으면 4만 칸 한도를 넘는 표용
export async function fetchByFirstClass(src, periods) {
  const items = await meta(src, 'ITM');
  const objIds = [...new Set(items.map((r) => r.OBJ_ID).filter((x) => x && x !== 'ITEM'))];
  const first = items.filter((r) => r.OBJ_ID === objIds[0]);
  const out = []; const errs = [];
  for (const c of first) {
    const extra = { prdSe: src.prdSe || 'M', newEstPrdCnt: String(periods), objL1: c.ITM_ID };
    for (let i = 2; i <= (src.levels || 2); i++) extra[`objL${i}`] = 'ALL';
    try { out.push(...await call(src, extra)); } catch (e) { errs.push(`${c.ITM_NM}: ${e.message}`); }
  }
  if (!out.length) throw new Error('시·도별 요청 모두 실패 — ' + errs.slice(0, 3).join(' | ') + ` (분류 ${objIds.join(',')}, 첫 분류 ${first.length}개)`);
  const rows = out.map((r) => [
    (r.C1_NM || '').trim(), (r.C2_NM || '').trim(), (r.C3_NM || '').trim(),
    (r.ITM_NM || '').trim(), String(r.PRD_DE || ''), r.DT === '-' || r.DT === '' || r.DT == null ? null : Number(r.DT),
  ]);
  return { info: { mode: 'byFirstClass', classes: objIds, firstCount: first.length, failed: errs.length, errSample: errs.slice(0, 3) }, tblNm: out[0]?.TBL_NM || '', unit: out[0]?.UNIT_NM || '', rows };
}

// 통계표 검색 (알맞은 표를 찾을 때 참고용)
export async function search(word) {
  const key = env('KOSIS_KEY');
  const q = new URLSearchParams({ method: 'getList', apiKey: key, format: 'json', jsonVD: 'Y', searchNm: word, sort: 'RANK', startCount: '1', resultCount: '20' });
  const data = await getJSON(`${SEARCH()}?${q}`, { timeoutMs: 30000 });
  if (!Array.isArray(data)) throw new Error(data?.errMsg || '검색 오류');
  return data.map((r) => ({ org: r.ORG_ID, tbl: r.TBL_ID, name: r.TBL_NM, stat: r.STAT_NM, end: r.END_PRD_DE || r.ED_PRD_DE }));
}
