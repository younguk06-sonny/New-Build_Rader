// 시·군·구별 근로자 1인당 평균 총급여 (국세청 근로소득 연말정산, 주소지 기준) — KOSIS 133 / DT_133001N_4215
// 금액·인원을 함께 받아 지역을 합칠 때(인천 중구+동구 등) 정확히 가중평균합니다.
import { call, meta } from './kosis.mjs';

export const INCOME_SRC = { orgId: '133', tblId: 'DT_133001N_4215', label: '근로소득 연말정산(주소지)' };
const SHORT = { 서울: '서울', 부산: '부산', 대구: '대구', 인천: '인천', 광주: '전남광주', 대전: '대전', 울산: '울산', 세종: '세종', 경기: '경기', 강원: '강원', 충북: '충북', 충남: '충남', 전북: '전북', 전남: '전남광주', 경북: '경북', 경남: '경남', 제주: '제주',
  서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천', 광주광역시: '전남광주', 대전광역시: '대전', 울산광역시: '울산', 세종특별자치시: '세종', 경기도: '경기', 강원도: '강원', 강원특별자치도: '강원', 충청북도: '충북', 충청남도: '충남', 전라북도: '전북', 전북특별자치도: '전북', 전라남도: '전남광주', 경상북도: '경북', 경상남도: '경남', 제주특별자치도: '제주' };
// 2026 개편 지역: 옛 지역 → 새 이름(여러 곳이면 같은 값을 나눠 씀)
const INCHEON = { 중구: ['제물포구', '영종구'], 동구: ['제물포구'], 서구: ['서해구', '검단구'] };

export async function fetchIncome(VALID) {
  const items = await meta(INCOME_SRC, 'ITM');
  const objIds = [...new Set(items.map((r) => r.OBJ_ID).filter((x) => x && x !== 'ITEM'))];
  const regObj = objIds.find((o) => items.some((r) => r.OBJ_ID === o && /서울/.test(r.ITM_NM))) || objIds[0];
  const kindObj = objIds.find((o) => o !== regObj);
  const kind = items.find((r) => r.OBJ_ID === kindObj && /총급여/.test(r.ITM_NM)) || items.find((r) => r.OBJ_ID === kindObj && /급여총계/.test(r.ITM_NM));
  const iPeople = items.find((r) => r.OBJ_ID === 'ITEM' && /인원/.test(r.ITM_NM));
  const iAmt = items.find((r) => r.OBJ_ID === 'ITEM' && /금액/.test(r.ITM_NM));
  // 지역 분류 → {sd, sgg}
  const regs = items.filter((r) => r.OBJ_ID === regObj);
  const byId = new Map(regs.map((r) => [r.ITM_ID, r]));
  const map = new Map(); let curSd = null;
  for (const r of regs) {
    const nm = (r.ITM_NM || '').trim(); const up = r.UP_ITM_ID ? byId.get(r.UP_ITM_ID) : null; const upNm = up ? (up.ITM_NM || '').trim() : '';
    if (/^(전국|합계|계)$/.test(nm)) { map.set(r.ITM_ID, { nat: true }); continue; }
    if (SHORT[nm] && (!up || /^(전국|합계|계)$/.test(upNm))) { curSd = SHORT[nm]; map.set(r.ITM_ID, { sd: curSd, sgg: null, raw: nm }); continue; }
    const sd = up && SHORT[upNm] ? SHORT[upNm] : curSd; if (!sd) continue;
    const n = nm.replace(/특례시$/, '시').split(' ').pop();
    if (sd === '세종') { map.set(r.ITM_ID, { sd, sgg: '세종시' }); continue; }
    if (sd === '인천' && INCHEON[n]) { map.set(r.ITM_ID, { sd, multi: INCHEON[n], raw: n }); continue; }
    if (VALID[sd]?.has(n)) map.set(r.ITM_ID, { sd, sgg: n, raw: (SHORT[upNm] || '') });
  }
  const rows = await call(INCOME_SRC, { prdSe: 'Y', startPrdDe: '2016', endPrdDe: '2030', objL1: 'ALL', objL2: kind.ITM_ID, itmId: [iPeople.ITM_ID, iAmt.ITM_ID].join('+') });
  const years = [...new Set(rows.map((r) => String(r.PRD_DE)))].sort();
  const yi = new Map(years.map((y, i) => [y, i]));
  const unit = rows.find((r) => r.ITM_ID === iAmt.ITM_ID)?.UNIT_NM || '';
  const acc = new Map(); // key → {p:[], a:[]}
  const add = (k, i, p, a) => { if (!acc.has(k)) acc.set(k, { p: years.map(() => 0), a: years.map(() => 0), has: years.map(() => false) }); const o = acc.get(k); if (p != null) o.p[i] += p; if (a != null) o.a[i] += a; o.has[i] = true; };
  const sidoParts = new Map(); // 전남광주는 광주+전남 합산
  for (const r of rows) {
    const g = map.get(r.C1); const i = yi.get(String(r.PRD_DE)); const v = r.DT === '-' || r.DT === '' || r.DT == null ? null : Number(r.DT);
    if (!g || i == null || v == null) continue;
    const isP = r.ITM_ID === iPeople.ITM_ID;
    const P = isP ? v : null, A = isP ? null : v;
    if (g.nat) add('', i, P, A);
    else if (!g.sgg && !g.multi) add(g.sd, i, P, A);
    else for (const s of g.multi || [g.sgg]) add(g.sd + '|' + s, i, g.multi && g.multi.length > 1 ? (P == null ? null : P) : P, A);
  }
  // 금액 단위 → 만원
  const toMan = /백만/.test(unit) ? 100 : /천원/.test(unit) ? 0.1 : /억/.test(unit) ? 10000 : 1;
  const series = (o) => years.map((_, i) => (o.has[i] && o.p[i] > 0 ? Math.round(o.a[i] * toMan / o.p[i]) : null));
  const people = (o) => years.map((_, i) => (o.has[i] ? o.p[i] : null));
  const out = { source: `국세청 ${INCOME_SRC.label} · KOSIS ${INCOME_SRC.tblId}`, unit: '만원', years, nat: null, sido: {}, sgg: {} };
  for (const [k, o] of acc) {
    const v = { avg: series(o), n: people(o) };
    if (k === '') out.nat = v; else if (!k.includes('|')) out.sido[k] = v; else { const [sd, s] = k.split('|'); (out.sgg[sd] ||= {})[s] = v; }
  }
  // 인천 나뉜 구는 같은 평균을 쓰되 인원은 표시하지 않음(나눌 수 없음)
  for (const [n, list] of Object.entries(INCHEON)) if (list.length > 1) for (const s of list) if (out.sgg.인천?.[s]) out.sgg.인천[s].shared = true;
  if (out.sgg.인천?.제물포구) out.sgg.인천.제물포구.shared = true;
  const missing = []; for (const [sd, set] of Object.entries(VALID)) for (const s of set) if (!out.sgg[sd]?.[s]) missing.push(sd + ' ' + s);
  return { data: out, info: { years: [years[0], years.at(-1)], unit, kind: kind.ITM_NM, regions: map.size, missing } };
}
