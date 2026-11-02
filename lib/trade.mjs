// 국토교통부 아파트 매매 실거래가 (공공데이터포털 RTMSDataSvcAptTrade)
// - 시·군·구 법정동코드(LAWD_CD) × 계약월(DEAL_YMD) 단위 조회
// - 하루 호출 한도(개발계정 1만 회)를 넘지 않게 나눠서 3년치를 채우고, 이후엔 최근 달만 갱신
// - 원자료는 cache/rt/<YYYYMM>.json 에 코드별로 요약 보관(가격 목록 + 최근 거래 일부)
import fs from 'node:fs/promises';
import path from 'node:path';
import { env, pool } from './http.mjs';

const BASE = () => env('RT_BASE') || 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade';
const MONTHS = 36;
const DAILY_LIMIT = 9000;   // 개발계정 1만 회 중 여유분 남김
const RUN_LIMIT = 3500;     // 한 번 실행에서 쓰는 최대 호출 수
const VER = 2;              // 보관 형식(2: 단지별 요약 포함)

const readJSON = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return d; } };
const writeJSON = async (p, o) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, JSON.stringify(o)); };
const ym = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const kst = () => new Date(Date.now() + 9 * 3600e3);

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
      if (/returnAuthMsg|SERVICE_KEY|SERVICE ACCESS DENIED|LIMITED_NUMBER/.test(text) || (code0 && !/^0+$/.test(code0))) {
        const e = new Error(msg || `오류 코드 ${code0}`); e.fatal = /KEY|DENIED|LIMITED|등록되지|권한/.test(text); throw e;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
      return { items, total: +tag(text, 'totalCount') || items.length };
    } catch (e) { lastErr = e; if (e.fatal) throw e; }
  }
  throw lastErr;
}

// 동 이름으로 2026.07 인천 개편 후 구 배정
function incheonGu(code, dong) {
  if (code === '28140') return '제물포구';
  if (code === '28110') return /(운서|운남|운북|중산|을왕|남북|덕교|무의|영종|용유)/.test(dong) ? '영종구' : '제물포구';
  if (code === '28260') return /(검단|불로|대곡|원당|당하|오류|왕길|마전|아라|금곡)/.test(dong) ? '검단구' : '서해구';
  return null;
}

const median = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const TOP_CX = 8; // 코드·월마다 평당가 상위 단지는 거래 내역을 모두 보관(대장 아파트 표시용)

function summarize(items, info, code) {
  const parts = {};
  for (const x of items) {
    if (/O/.test(tag(x, 'cdealType', '해제여부'))) continue; // 해제된 거래 제외
    const amt = +tag(x, 'dealAmount', '거래금액').replace(/[^0-9]/g, '');
    const area = +tag(x, 'excluUseAr', '전용면적');
    if (!amt || !area) continue;
    const dong = tag(x, 'umdNm', '법정동');
    const name = info.incheon ? incheonGu(code, dong) : info.n;
    if (!name) continue;
    const p = (parts[name] ||= { a: [], p: [], d: [], cx: {} });
    const py = Math.round(amt / area * 10); // 만원/㎡ ×10
    p.a.push(amt); p.p.push(py);
    const apt = tag(x, 'aptNm', '아파트'), by = +tag(x, 'buildYear', '건축년도') || null;
    const k = apt + '|' + dong;
    const c = (p.cx[k] ||= { by, py: [], amt: [], d: [] });
    c.py.push(py); c.amt.push(amt);
    c.d.push([+tag(x, 'dealDay', '일') || 0, apt, dong, Math.round(area * 100) / 100, +tag(x, 'floor', '층') || null, amt, by]);
  }
  for (const p of Object.values(parts)) {
    // 단지별 요약 [건축년도, 건수, 평당 중위(만원/㎡×10), 거래가 중위]
    const list = Object.entries(p.cx).map(([k, c]) => [k, c, median(c.py)]);
    list.sort((a, b) => b[2] - a[2]);
    p.d = list.slice(0, TOP_CX).flatMap(([, c]) => c.d).sort((a, b) => b[0] - a[0]);
    p.c = Object.fromEntries(list.map(([k, c, mp]) => [k, [c.by, c.py.length, Math.round(mp), Math.round(median(c.amt))]]));
    delete p.cx;
  }
  return parts;
}

export async function collectTrades({ root, codes, log }) {
  const key = env('DATA_GO_KR_KEY');
  if (!key) return { ok: false, error: 'DATA_GO_KR_KEY 없음' };
  const dir = path.join(root, 'cache', 'rt');
  const statePath = path.join(dir, '_state.json');
  const state = await readJSON(statePath, {});
  const today = kst().toISOString().slice(0, 10);
  if (state.date !== today) { state.date = today; state.calls = 0; }
  let budget = Math.min(RUN_LIMIT, DAILY_LIMIT - (state.calls || 0));

  // 대상 월: 이번 달 포함 최근 36개월
  const now = kst(); const months = [];
  for (let k = MONTHS - 1; k >= 0; k--) months.push(ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1))));
  const recent = new Set(months.slice(-3)); // 최근 3개월은 신고가 계속 들어오므로 하루 1번 다시 받음
  const store = {};
  for (const m of months) store[m] = await readJSON(path.join(dir, `${m}.json`), {});

  // 할 일 목록: 최근 달 갱신 → 비어 있는 과거 달(최근부터)
  const jobs = [];
  for (const m of [...months].reverse()) {
    for (const [code, info] of Object.entries(codes)) {
      if (info.from && m < info.from) continue;
      if (info.to && m > info.to) continue;
      const have = store[m][code];
      if (!have || have.v !== VER || (recent.has(m) && have.at !== today)) jobs.push([m, code, info]);
    }
  }
  jobs.sort((a, b) => (recent.has(b[0]) - recent.has(a[0])) || b[0].localeCompare(a[0]));
  const upgrading = jobs.filter(([m, code]) => store[m][code] && store[m][code].v !== VER).length;
  const todo = jobs.slice(0, Math.max(0, budget));
  log('실거래가: 할 일', jobs.length, '이번 실행', todo.length, '오늘 사용', state.calls);

  let fatal = null, done = 0, fails = 0;
  await pool(todo, 4, async ([m, code, info]) => {
    if (fatal) return;
    try {
      let page = 1, items = [], total = 0;
      do {
        const r = await fetchPage(key, code, m, page); state.calls = (state.calls || 0) + 1;
        items.push(...r.items); total = r.total; page++;
      } while (items.length < total && page <= 10);
      store[m][code] = { at: today, v: VER, n: items.length, parts: summarize(items, info, code) };
      done++;
    } catch (e) { if (e.fatal) fatal = e.message; fails++; }
  });
  for (const m of months) if (Object.keys(store[m]).length) await writeJSON(path.join(dir, `${m}.json`), store[m]);
  // 36개월보다 오래된 파일 정리
  try { for (const f of await fs.readdir(dir)) if (/^\d{6}\.json$/.test(f) && f.slice(0, 6) < months[0]) await fs.unlink(path.join(dir, f)); } catch (_) {}
  await writeJSON(statePath, state);

  const filled = months.map((m) => Object.keys(store[m]).length);
  const expected = months.map((m) => Object.values(codes).filter((i) => !(i.from && m < i.from) && !(i.to && m > i.to)).length);
  const complete = filled.reduce((a, b) => a + b, 0) / expected.reduce((a, b) => a + b, 0);
  return { ok: !fatal, error: fatal, upgrading, done, fails, remaining: jobs.length - done, callsToday: state.calls, complete: Math.round(complete * 1000) / 10, months, store, codes };
}


// 화면용 요약: 지역별 월 거래건수·중위 거래가(만원)·중위 평당가(만원/3.3㎡) + 시·군·구별 최근 거래
export function buildTradeView(result) {
  const { months, store } = result;
  const n = months.length, blank = () => ({ n: new Array(n).fill(null), amt: new Array(n).fill(null), py: new Array(n).fill(null) });
  const acc = new Map(); // key: '' | 'sd' | 'sd|sgg' → {a:[][], p:[][]}
  const add = (k, i, part) => { if (!acc.has(k)) acc.set(k, { a: months.map(() => []), p: months.map(() => []), cnt: new Array(n).fill(0), seen: new Array(n).fill(false) }); const o = acc.get(k); o.a[i].push(...part.a); o.p[i].push(...part.p); o.cnt[i] += part.a.length; o.seen[i] = true; };
  months.forEach((m, i) => {
    for (const [code, rec] of Object.entries(store[m] || {})) {
      for (const [name, part] of Object.entries(rec.parts || {})) {
        const sd = result.codes[code]?.sd; if (!sd) continue;
        add('', i, part); add(sd, i, part); add(sd + '|' + name, i, part);
      }
      // 거래가 0건이어도 조회한 달은 0으로 표시
      const sd = result.codes[code]?.sd; const info = result.codes[code];
      if (sd && info && !info.incheon && !Object.keys(rec.parts || {}).length) { for (const k of ['', sd, sd + '|' + info.n]) { if (!acc.has(k)) add(k, i, { a: [], p: [] }); acc.get(k).seen[i] = true; } }
    }
  });
  const out = { months, nat: null, sido: {}, sgg: {} };
  for (const [k, o] of acc) {
    const v = blank();
    for (let i = 0; i < n; i++) {
      if (!o.seen[i]) continue;
      v.n[i] = o.cnt[i];
      const ma = median(o.a[i]), mp = median(o.p[i]);
      v.amt[i] = ma == null ? null : Math.round(ma);
      v.py[i] = mp == null ? null : Math.round(mp / 10 * 3.3058);
    }
    if (k === '') out.nat = v; else if (!k.includes('|')) out.sido[k] = v; else { const [sd, nm] = k.split('|'); (out.sgg[sd] ||= {})[nm] = v; }
  }
  out.leader = buildLeaders(result);
  return out;
}

// 시·군·구 대장 아파트: 최근 12개월 거래 10건 이상(없으면 5건→2건→1건) 단지 중 평당가 중위값이 가장 높은 단지
function buildLeaders({ months, store, codes }) {
  const n = months.length;
  let end = n - 1; while (end > 0 && !Object.values(store[months[end]] || {}).some((r) => r.v === VER)) end--;
  const from = Math.max(0, end - 11);
  const byPlace = new Map(); // 'sd|sgg' → Map(key → {by, n, pyw, ser:{i→[py,n,amt]}})
  months.forEach((m, i) => {
    for (const [code, rec] of Object.entries(store[m] || {})) {
      if (rec.v !== VER) continue;
      const sd = codes[code]?.sd; if (!sd) continue;
      for (const [name, part] of Object.entries(rec.parts || {})) {
        const pk = sd + '|' + name; if (!byPlace.has(pk)) byPlace.set(pk, new Map());
        const P = byPlace.get(pk);
        for (const [k, [by, cnt, mp, ma]] of Object.entries(part.c || {})) {
          const o = P.get(k) || { by, n: 0, pyw: 0, ser: {}, deals: [] }; P.set(k, o);
          if (by) o.by = by;
          o.ser[i] = [mp, cnt, ma];
          if (i >= from && i <= end) { o.n += cnt; o.pyw += mp * cnt; }
        }
        for (const d of part.d || []) { const o = P.get(d[1] + '|' + d[2]); if (o) o.deals.push([m + String(d[0]).padStart(2, '0'), d[3], d[4], d[5]]); }
      }
    }
  });
  const toPy = (v) => Math.round(v / 10 * 3.3058);
  const out = {};
  for (const [pk, P] of byPlace) {
    const all = [...P.entries()].filter(([, o]) => o.n > 0);
    let pick = null;
    for (const min of [10, 5, 2, 1]) {
      const c = all.filter(([, o]) => o.n >= min); if (!c.length) continue;
      c.sort((a, b) => b[1].pyw / b[1].n - a[1].pyw / a[1].n || b[1].n - a[1].n); pick = c; break;
    }
    if (!pick) continue;
    const [k, o] = pick[0]; const [apt, dong] = k.split('|');
    const py = new Array(n).fill(null), cnt = new Array(n).fill(null), amt = new Array(n).fill(null);
    for (const [i, [mp, c, ma]] of Object.entries(o.ser)) { py[i] = toPy(mp); cnt[i] = c; amt[i] = ma; }
    o.deals.sort((a, b) => b[0].localeCompare(a[0]));
    const [sd, sgg] = pk.split('|');
    (out[sd] ||= {})[sgg] = {
      apt, dong, by: o.by, n12: o.n, py12: toPy(o.pyw / o.n), py, n: cnt, amt, deals: o.deals.slice(0, 40),
      next: pick.slice(1, 4).map(([k2, o2]) => { const [a2, d2] = k2.split('|'); return [a2, d2, toPy(o2.pyw / o2.n), o2.n]; }),
    };
  }
  return out;
}
