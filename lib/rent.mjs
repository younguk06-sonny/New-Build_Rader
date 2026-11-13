// 국토교통부 아파트 전월세 실거래가 (공공데이터포털 RTMSDataSvcAptRent) — 정비맵 '전세가' 탭용
// - 시·군·구(LAWD_CD) × 계약월 단위, 최근 12개월만 보관(전세 시세는 최근 값이 중요)
// - 하루 호출 한도를 나눠 쓰고, 이후엔 최근 2개월만 매일 갱신
// - cache/rent/<YYYYMM>.json : { 코드: { at, v, n, c: { '단지|동': [건축년도, 전세 건수, 전세 보증금 ㎡당 중위(만원/㎡×10), 전세 보증금 중위(만원), 월세 건수] } } }
import fs from 'node:fs/promises';
import path from 'node:path';
import { env, pool } from './http.mjs';

const BASE = () => env('RENT_BASE') || 'https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent';
const MONTHS = 12;
const DAILY_LIMIT = 9000;
const RUN_LIMIT = 3200;
const VER = 1;

const readJSON = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return d; } };
const writeJSON = async (p, o) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, JSON.stringify(o)); };
const ym = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const kst = () => new Date(Date.now() + 9 * 3600e3);
const median = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
function tag(x, ...names) { for (const n of names) { const m = x.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`)); if (m) return m[1].trim(); } return ''; }

async function fetchPage(key, code, month, page) {
  const q = new URLSearchParams({ LAWD_CD: code, DEAL_YMD: month, pageNo: String(page), numOfRows: '1000' });
  const url = `${BASE()}?serviceKey=${encodeURIComponent(key)}&${q}`;
  let lastErr;
  for (let t = 0; t < 3; t++) {
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 30000);
      const res = await fetch(url, { signal: ctl.signal }); clearTimeout(tm);
      const text = await res.text();
      const code0 = tag(text, 'resultCode'), msg = tag(text, 'resultMsg', 'returnAuthMsg', 'errMsg');
      if (res.status === 401 || res.status === 403 || /returnAuthMsg|SERVICE_KEY|SERVICE ACCESS DENIED|LIMITED_NUMBER|Unauthorized|Forbidden/.test(text) || (code0 && !/^0+$/.test(code0))) {
        const e = new Error(msg || (res.status >= 400 ? `HTTP ${res.status} ${text.slice(0, 80)}` : `오류 코드 ${code0}`));
        e.fatal = res.status === 401 || res.status === 403 || /KEY|DENIED|LIMITED|등록되지|권한|Unauthorized|Forbidden/.test(text); throw e;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
      return { items, total: +tag(text, 'totalCount') || items.length };
    } catch (e) { lastErr = e; if (e.fatal) throw e; }
  }
  throw lastErr;
}

function summarize(items) {
  const cx = {};
  for (const x of items) {
    const area = +tag(x, 'excluUseAr', '전용면적');
    const dep = +tag(x, 'deposit', '보증금액').replace(/[^0-9]/g, '');
    const rent = +tag(x, 'monthlyRent', '월세금액').replace(/[^0-9]/g, '');
    if (!area || !dep) continue;
    const apt = tag(x, 'aptNm', '아파트'), dong = tag(x, 'umdNm', '법정동');
    const c = (cx[apt + '|' + dong] ||= { by: +tag(x, 'buildYear', '건축년도') || null, py: [], dep: [], w: 0 });
    if (rent > 0) { c.w++; continue; }            // 월세(보증부 월세)는 건수만
    c.py.push(Math.round(dep / area * 10)); c.dep.push(dep);
  }
  return Object.fromEntries(Object.entries(cx).map(([k, c]) => [k, [c.by, c.py.length, c.py.length ? Math.round(median(c.py)) : null, c.dep.length ? Math.round(median(c.dep)) : null, c.w]]));
}

export async function collectRents({ root, codes, log }) {
  const key = env('DATA_GO_KR_KEY');
  if (!key) return { ok: false, error: 'DATA_GO_KR_KEY 없음' };
  const dir = path.join(root, 'cache', 'rent');
  const statePath = path.join(dir, '_state.json');
  const state = await readJSON(statePath, {});
  const today = kst().toISOString().slice(0, 10);
  if (state.date !== today) { state.date = today; state.calls = 0; }
  const budget = Math.min(RUN_LIMIT, DAILY_LIMIT - (state.calls || 0));
  const now = kst(); const months = [];
  for (let k = MONTHS - 1; k >= 0; k--) months.push(ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1))));
  const recent = new Set(months.slice(-2));
  const store = {};
  for (const m of months) store[m] = await readJSON(path.join(dir, `${m}.json`), {});
  const jobs = [];
  for (const m of [...months].reverse()) for (const [code, info] of Object.entries(codes)) {
    if (info.from && m < info.from) continue;
    if (info.to && m > info.to) continue;
    const have = store[m][code];
    if (!have || have.v !== VER || (recent.has(m) && have.at !== today)) jobs.push([m, code]);
  }
  jobs.sort((a, b) => (recent.has(b[0]) - recent.has(a[0])) || b[0].localeCompare(a[0]));
  const todo = jobs.slice(0, Math.max(0, budget));
  log('전월세: 할 일', jobs.length, '이번 실행', todo.length);
  let fatal = null, done = 0, fails = 0;
  await pool(todo, 4, async ([m, code]) => {
    if (fatal) return;
    try {
      let page = 1, items = [], total = 0;
      do { const r = await fetchPage(key, code, m, page); state.calls = (state.calls || 0) + 1; items.push(...r.items); total = r.total; page++; } while (items.length < total && page <= 10);
      store[m][code] = { at: today, v: VER, n: items.length, c: summarize(items) };
      done++;
    } catch (e) { if (e.fatal) fatal = e.message; fails++; }
  });
  for (const m of months) if (Object.keys(store[m]).length) await writeJSON(path.join(dir, `${m}.json`), store[m]);
  try { for (const f of await fs.readdir(dir)) if (/^\d{6}\.json$/.test(f) && f.slice(0, 6) < months[0]) await fs.unlink(path.join(dir, f)); } catch (_) {}
  await writeJSON(statePath, state);
  const filled = months.reduce((a, m) => a + Object.keys(store[m]).length, 0);
  return { ok: !fatal, error: fatal, done, fails, remaining: jobs.length - done, callsToday: state.calls, complete: Math.round(filled / (months.length * Object.keys(codes).length) * 1000) / 10 };
}
