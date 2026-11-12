// 임시 점검: 소득 자료 받기 시험. 결과는 cache/discover.json
import fs from 'node:fs/promises';
import { fetchIncome } from '../lib/income.mjs';
import { meta } from '../lib/kosis.mjs';
const geo = JSON.parse(await fs.readFile('public/data/geo.json', 'utf8'));
const VALID = {}; for (const f of geo.sgg) (VALID[f.sd] ||= new Set()).add(f.n);
const out = { at: new Date().toISOString() };
try {
  const r = await fetchIncome(VALID);
  out.info = r.info; out.years = r.data.years; out.nat = r.data.nat;
  out.sido = Object.fromEntries(Object.entries(r.data.sido).map(([k, v]) => [k, v.avg.at(-1)]));
  out.sample = { 강남구: r.data.sgg.서울?.강남구, 화성시: r.data.sgg.경기?.화성시, 제물포구: r.data.sgg.인천?.제물포구, 광주동구: r.data.sgg.전남광주?.동구, 세종: r.data.sgg.세종 };
  out.counts = Object.fromEntries(Object.entries(r.data.sgg).map(([k, v]) => [k, Object.keys(v).length]));
} catch (e) { out.error = String(e.stack || e.message); }
try { const m = await meta({ orgId: '133', tblId: 'DT_133001N_4215' }, 'ITM'); out.itmSample = m.filter((x) => x.OBJ_ID !== 'B').slice(0, 30).map((x) => [x.OBJ_ID, x.ITM_ID, x.ITM_NM, x.UP_ITM_ID]); } catch (e) { out.metaErr = e.message; }
await fs.mkdir('cache', { recursive: true });
await fs.writeFile('cache/discover.json', JSON.stringify(out, null, 1));
