// KOSIS 통계표 찾기용 (임시). 결과는 cache/discover.json
import fs from 'node:fs/promises';
import { search, meta } from '../lib/kosis.mjs';
const words = ['근로소득 연말정산 시군구', '시군구별 근로소득', '시·군·구별 근로소득', '근로소득 연말정산 주소지', '1인당 개인소득', '지역소득 시군구', '시군구 지역내총생산', '종합소득 시군구', '종합소득세 주소지'];
const out = { at: new Date().toISOString(), search: {}, meta: {} };
for (const w of words) { try { out.search[w] = await search(w); } catch (e) { out.search[w] = String(e.message); } }
const cand = new Map();
for (const list of Object.values(out.search)) if (Array.isArray(list)) for (const r of list) if (/근로소득|개인소득|종합소득|총생산/.test(r.name) && !cand.has(r.tbl)) cand.set(r.tbl, r);
for (const r of [...cand.values()].slice(0, 25)) {
  try {
    const m = await meta({ orgId: r.org, tblId: r.tbl }, 'ITM');
    const objs = {}; for (const x of m) (objs[x.OBJ_ID] ||= []).push(x.ITM_NM);
    let prd = null; try { prd = (await meta({ orgId: r.org, tblId: r.tbl }, 'PRD')).map((p) => [p.PRD_SE, p.STRT_PRD_DE, p.END_PRD_DE]); } catch (_) {}
    out.meta[r.tbl] = { org: r.org, name: r.name, prd, objs: Object.fromEntries(Object.entries(objs).map(([k, v]) => [k, { n: v.length, sample: v.slice(0, 12) }])) };
  } catch (e) { out.meta[r.tbl] = { name: r.name, err: String(e.message) }; }
}
await fs.mkdir('cache', { recursive: true });
await fs.writeFile('cache/discover.json', JSON.stringify(out, null, 1));
console.log(Object.keys(out.meta).length, 'tables');
