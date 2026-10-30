// 지역 여건 자료(KOSIS): 아파트·주택 매매 거래량, 인구, 세대수 (최근 60개월) + 최신 연령 분포
// 지역 분류(시·도 → 시·군·구)를 통계표의 분류 목록(getMeta ITM)에서 읽어 2026.10 행정구역 이름에 맞춥니다.
import { call, meta } from './kosis.mjs';

export const REGION_TABLES = {
  aptDeal:   { orgId: '408', tblId: 'DT_408_2006_S0064', item: /호수/, label: '아파트 매매 거래량', unit: '건' },
  houseDeal: { orgId: '408', tblId: 'DT_408_2006_S0057', item: /호수|동/, label: '주택 매매 거래량', unit: '건' },
  pop:       { orgId: '101', tblId: 'DT_1B040A3', item: /총인구/, label: '주민등록인구', unit: '명' },
  hh:        { orgId: '101', tblId: 'DT_1B040B3', item: /세대/, label: '주민등록세대수', unit: '세대' },
};
export const AGE_TABLE = { orgId: '101', tblId: 'DT_1B04005N', item: /총인구/ };

const SHORT = {
  서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천', 대전광역시: '대전', 울산광역시: '울산',
  세종특별자치시: '세종', 경기도: '경기', 강원도: '강원', 강원특별자치도: '강원', 충청북도: '충북', 충청남도: '충남',
  전라북도: '전북', 전북특별자치도: '전북', 전남광주통합특별시: '전남광주', 광주광역시: '전남광주', 전라남도: '전남광주',
  경상북도: '경북', 경상남도: '경남', 제주특별자치도: '제주',
  서울: '서울', 부산: '부산', 대구: '대구', 인천: '인천', 대전: '대전', 울산: '울산', 세종: '세종', 경기: '경기', 강원: '강원',
  충북: '충북', 충남: '충남', 전북: '전북', 전남: '전남광주', 광주: '전남광주', 경북: '경북', 경남: '경남', 제주: '제주',
};
const NEW_UNIT = new Set(['전남광주통합특별시']); // 통합 뒤 이름(있으면 옛 광주+전남 합계보다 우선)

// 분류 목록 → { regions: [{id, sd, sgg|null, isNew, isNat}], itm }
export async function regionMap(src, VALID) {
  const items = await meta(src, 'ITM');
  const itm = items.find((r) => r.OBJ_ID === 'ITEM' && src.item.test(r.ITM_NM || '')) || items.find((r) => r.OBJ_ID === 'ITEM');
  const objIds = [...new Set(items.map((r) => r.OBJ_ID).filter((x) => x && x !== 'ITEM'))];
  const regionObj = objIds[0];
  const list = items.filter((r) => r.OBJ_ID === regionObj);
  const byId = new Map(list.map((r) => [r.ITM_ID, r]));
  const regions = [];
  for (const r of list) {
    const name = (r.ITM_NM || '').trim();
    const parent = r.UP_ITM_ID ? byId.get(r.UP_ITM_ID) : null;
    const pname = parent ? (parent.ITM_NM || '').trim() : '';
    if (name === '전국' && !parent) { regions.push({ id: r.ITM_ID, isNat: true }); continue; }
    if (SHORT[name] && (!parent || pname === '전국')) { regions.push({ id: r.ITM_ID, sd: SHORT[name], sgg: null, isNew: NEW_UNIT.has(name) }); continue; }
    if (parent && SHORT[pname] && (!parent.UP_ITM_ID || (byId.get(parent.UP_ITM_ID)?.ITM_NM || '').trim() === '전국')) {
      const sd = SHORT[pname];
      if (sd === '세종') { regions.push({ id: r.ITM_ID, sd, sgg: '세종시' }); continue; }
      const nm = name.replace(/특례시$/, '시').split(' ').pop();
      if (VALID[sd]?.has(nm)) regions.push({ id: r.ITM_ID, sd, sgg: nm });
    }
  }
  return { regions, itm, regionObj, levels: objIds.length };
}

function shiftMonth(p, k) { const y = +p.slice(0, 4), m = +p.slice(4, 6) - 1 - k; const d = new Date(Date.UTC(y, m, 1)); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }

async function latestPeriod(src) {
  const prd = await meta(src, 'PRD');
  const end = String(prd.find((p) => /월|M/.test(p.PRD_SE || ''))?.END_PRD_DE || prd[0]?.END_PRD_DE || '').replace(/\D/g, '');
  return end.slice(0, 6);
}

// 지역 묶음으로 나눠 요청 (한 번에 4만 칸 이하)
async function fetchRows(src, rm, extra, perRegionCells) {
  const ids = rm.regions.map((r) => r.id);
  const batch = Math.max(1, Math.min(150, Math.floor(36000 / Math.max(1, perRegionCells))));
  const out = [];
  for (let i = 0; i < ids.length; i += batch) {
    const q = { ...extra, itmId: rm.itm.ITM_ID, objL1: ids.slice(i, i + batch).join('+') };
    for (let k = 2; k <= rm.levels; k++) q[`objL${k}`] = q[`objL${k}`] || 'ALL';
    out.push(...await call(src, q));
  }
  return out;
}

// 최근 n개월 월별 계열 → { months, nat:[], sido:{sd:[]}, sgg:{sd:{name:[]}} }
export async function monthlySeries(src, VALID, n = 60) {
  const rm = await regionMap(src, VALID);
  const end = await latestPeriod(src);
  const start = shiftMonth(end, n - 1);
  const raw = await fetchRows(src, rm, { prdSe: 'M', startPrdDe: start, endPrdDe: end }, n);
  const months = []; for (let k = n - 1; k >= 0; k--) months.push(shiftMonth(end, k));
  const mi = new Map(months.map((m, i) => [m, i]));
  const reg = new Map(rm.regions.map((r) => [r.id, r]));
  const blank = () => new Array(n).fill(null);
  const nat = blank(), sido = {}, sgg = {}, sidoNew = {}, sidoOld = {};
  for (const r of raw) {
    const g = reg.get(r.C1); const i = mi.get(String(r.PRD_DE)); const v = r.DT == null || r.DT === '-' || r.DT === '' ? null : Number(r.DT);
    if (!g || i == null || v == null) continue;
    if (g.isNat) { nat[i] = v; continue; }
    if (!g.sgg) { const t = g.isNew ? sidoNew : sidoOld; (t[g.sd] ||= blank())[i] = ((t[g.sd]?.[i]) || 0) + v; continue; }
    const o = (sgg[g.sd] ||= {}); (o[g.sgg] ||= blank())[i] = ((o[g.sgg]?.[i]) || 0) + v;
  }
  for (const sd of new Set([...Object.keys(sidoNew), ...Object.keys(sidoOld)])) {
    sido[sd] = blank().map((_, i) => sidoNew[sd]?.[i] ?? sidoOld[sd]?.[i] ?? null);
  }
  // 시·도 합계가 빈 달(예: 통합 전 전남광주)은 시·군·구 합으로 채움
  for (const sd of Object.keys(sgg)) {
    const kids = Object.values(sgg[sd]);
    const arr = sido[sd] || blank();
    for (let i = 0; i < n; i++) if (arr[i] == null) { let t = null; for (const k of kids) if (k[i] != null) t = (t || 0) + k[i]; arr[i] = t; }
    sido[sd] = arr;
  }
  return { months, nat, sido, sgg, label: src.label, unit: src.unit, tbl: src.tblId, itm: rm.itm.ITM_NM, regions: rm.regions.length };
}

// 최신 월 5세별 인구 → { month, groups:[...], nat:[], sido:{sd:[]}, sgg:{sd:{name:[]}} }
export async function ageProfile(VALID) {
  const src = AGE_TABLE;
  const rm = await regionMap(src, VALID);
  rm.regions = rm.regions.filter((r) => r.isNat || r.sd); // 읍면동은 제외
  const items = await meta(src, 'ITM');
  const objIds = [...new Set(items.map((r) => r.OBJ_ID).filter((x) => x && x !== 'ITEM'))];
  const ageObj = items.filter((r) => r.OBJ_ID === objIds[1]);
  const groups = ageObj.map((r) => (r.ITM_NM || '').trim()).filter((t) => t !== '계');
  const raw = await fetchRows(src, rm, { prdSe: 'M', newEstPrdCnt: '1', objL2: 'ALL' }, ageObj.length);
  const gi = new Map(groups.map((g, i) => [g, i]));
  const reg = new Map(rm.regions.map((r) => [r.id, r]));
  const blank = () => new Array(groups.length).fill(0);
  const nat = blank(), sido = {}, sgg = {}; let month = '';
  const sidoNew = {}, sidoOld = {};
  for (const r of raw) {
    const g = reg.get(r.C1), i = gi.get((r.C2_NM || '').trim()); const v = Number(r.DT);
    if (!g || i == null || !Number.isFinite(v)) continue;
    month = String(r.PRD_DE || month);
    if (g.isNat) { nat[i] += v; continue; }
    if (!g.sgg) { const t = g.isNew ? sidoNew : sidoOld; (t[g.sd] ||= blank())[i] += v; continue; }
    const o = (sgg[g.sd] ||= {}); (o[g.sgg] ||= blank())[i] += v;
  }
  for (const sd of new Set([...Object.keys(sidoNew), ...Object.keys(sidoOld)])) sido[sd] = sidoNew[sd] || sidoOld[sd];
  return { month, groups, nat, sido, sgg };
}
