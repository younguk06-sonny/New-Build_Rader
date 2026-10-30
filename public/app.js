/* 분양시장 레이더 — 지도·미분양·향후공급·청약결과 */
(() => {
'use strict';

const ORDER = ['서울','인천','경기','강원','충남','세종','충북','경북','대전','전북','대구','울산','전남광주','경남','부산','제주'];
const LONG = { 서울:'서울특별시', 부산:'부산광역시', 대구:'대구광역시', 인천:'인천광역시', 대전:'대전광역시', 울산:'울산광역시', 세종:'세종특별자치시', 경기:'경기도', 강원:'강원특별자치도', 충북:'충청북도', 충남:'충청남도', 전북:'전북특별자치도', 전남광주:'전남광주통합특별시', 경북:'경상북도', 경남:'경상남도', 제주:'제주특별자치도' };
const GJ = new Set(['서구','동구','남구','북구','광산구']); // 옛 광주광역시 구

const $ = (s) => document.querySelector(s);
const fmt = (n) => n == null || !isFinite(n) ? '–' : Math.round(n).toLocaleString('ko-KR');
const fmtM = (p) => p ? `${p.slice(0,4)}.${p.slice(4,6)}` : '';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function chg(cur, prev, pct = true) {
  if (cur == null || prev == null) return { t: '–', c: 'flat' };
  const d = cur - prev;
  const c = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  let t = `${sign}${fmt(Math.abs(d))}`;
  if (pct && prev > 0) t += ` (${d >= 0 ? '+' : '−'}${Math.abs(d / prev * 100).toFixed(1)}%)`;
  return { t, c };
}

const S = {
  geo: null, supply: null,
  months: [], sido: {}, sgg: {}, nat: [],
  unsoldSrc: '', permit: undefined,
  sel: { sido: null, sgg: null },
  metric: 'level', range: 36, sort: 'date',
  cy: new Map(), cyShow: 20,
  view: null, // 지도 viewBox
};

/* ---------- 데이터 로드 ---------- */
async function getJSON(url) {
  let r;
  try { r = await fetch(url); } catch (_) { const e = new Error('서버에 연결하지 못했습니다'); e.code = 'no_server'; throw e; }
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { const e = new Error(`응답 형식 오류 (${r.status})`); e.status = r.status; if (r.status === 404 || r.status === 0) e.code = 'no_server'; throw e; }
  if (!r.ok) { const e = new Error(j.message || `HTTP ${r.status}`); e.code = j.error; e.status = r.status; throw e; }
  return j;
}

function buildUnsold(tab) {
  const months = tab.months; const L = months.length;
  const T = new Map();
  for (const r of tab.rows) T.set(r[0] + '|' + r[1], r.slice(2));
  const get = (a, b) => T.get(a + '|' + b) || null;
  const stitch = (a, b) => a && b ? a.map((v, i) => v ?? b[i]) : (a || b);
  const sumS = (list) => { const ok = list.filter(Boolean); if (!ok.length) return null; return new Array(L).fill(0).map((_, i) => { let s = null; for (const x of ok) if (x[i] != null) s = (s || 0) + x[i]; return s; }); };

  const sido = {}, sgg = {};
  for (const sd of ORDER) {
    let tot = get(sd, '계');
    if (sd === '전남광주') tot = stitch(tot, sumS([get('광주', '계'), get('전남', '계')]));
    const kids = {};
    for (const f of S.geo.sgg.filter((f) => f.sd === sd)) {
      let s = get(sd, f.n);
      if (sd === '전남광주') s = stitch(s, get(GJ.has(f.n) ? '광주' : '전남', f.n));
      if (sd === '대구' && f.n === '군위군') s = stitch(s, get('경북', '군위군'));
      kids[f.n] = s || new Array(L).fill(null);
    }
    if (!tot) tot = sumS(Object.values(kids));
    sido[sd] = tot || new Array(L).fill(null);
    sgg[sd] = kids;
  }
  // 최근 시점이 비어 있으면(공표 전) 잘라냄
  let last = L - 1;
  while (last > 0 && ORDER.every((sd) => sido[sd][last] == null)) last--;
  const cut = (a) => a.slice(0, last + 1);
  S.months = months.slice(0, last + 1);
  for (const sd of ORDER) { sido[sd] = cut(sido[sd]); for (const k in sgg[sd]) sgg[sd][k] = cut(sgg[sd][k]); }
  S.sido = sido; S.sgg = sgg;
  S.nat = S.months.map((_, i) => { let s = 0, any = false; for (const sd of ORDER) if (sido[sd][i] != null) { s += sido[sd][i]; any = true; } return any ? s : null; });
  S.full = { months: S.months, sido: S.sido, sgg: S.sgg, nat: S.nat }; // 기준월을 바꿔도 원본은 그대로 보관
}

// 기준월 바꾸기: 그 달까지만 남겨서 지도·목록·추이·KPI가 모두 그 시점 기준이 되게 함
function applyAsOf(idx) {
  const F = S.full, cut = (a) => a.slice(0, idx + 1);
  S.months = cut(F.months); S.nat = cut(F.nat);
  S.sido = {}; S.sgg = {};
  for (const sd of ORDER) { S.sido[sd] = cut(F.sido[sd]); S.sgg[sd] = {}; for (const k in F.sgg[sd]) S.sgg[sd][k] = cut(F.sgg[sd][k]); }
  S.asOf = idx;
}

function setupAsOf() {
  const sel = $('#asOf'), F = S.full, last = F.months.length - 1;
  // 최근 달이 위로 오도록, 연도별로 묶어서 표시
  let html = '', year = '';
  for (let i = last; i >= 0; i--) {
    const m = F.months[i], y = m.slice(0, 4);
    if (y !== year) { if (year) html += '</optgroup>'; html += `<optgroup label="${y}년">`; year = y; }
    html += `<option value="${i}">${fmtM(m)}${i === last ? ' (최신)' : ''}</option>`;
  }
  sel.innerHTML = html + '</optgroup>';
  sel.value = String(last);
  const go = (idx) => {
    idx = Math.max(0, Math.min(last, idx));
    applyAsOf(idx); sel.value = String(idx);
    $('#asOfPrev').disabled = idx === 0; $('#asOfNext').disabled = idx === last;
    $('#asOfLatest').hidden = idx === last;
    document.body.classList.toggle('past', idx !== last);
    select(S.sel.sido, S.sel.sgg, { push: false });
  };
  sel.onchange = () => go(+sel.value);
  $('#asOfPrev').onclick = () => go(S.asOf - 1);
  $('#asOfNext').onclick = () => go(S.asOf + 1);
  $('#asOfLatest').onclick = () => go(last);
  S.asOf = last; $('#asOfNext').disabled = true; $('#asOfLatest').hidden = true;
}

async function loadUnsold() {
  try {
    const j = await getJSON('data/unsold.json'); // GitHub Actions가 매일 KOSIS에서 받아 저장
    buildUnsold(j);
    S.unsoldSrc = 'live';
  } catch (e) {
    const j = await getJSON('data/unsold-fallback.json');
    buildUnsold(j);
    S.unsoldSrc = 'fallback';
    S.unsoldErr = e.message;
  }
}

/* ---------- 지도 ---------- */
const K = Math.cos(36 * Math.PI / 180);
const P = (x, y) => [(x - 124) * K * 100, (39 - y) * 100];
function toPath(rings) {
  let d = '';
  for (const r of rings) { d += 'M'; for (let i = 0; i < r.length; i++) { const [x, y] = P(r[i][0], r[i][1]); d += (i ? 'L' : '') + x.toFixed(2) + ',' + y.toFixed(2); } d += 'Z'; }
  return d;
}
function bboxOf(rings) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const r of rings) for (const p of r) { const [x, y] = P(p[0], p[1]); if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
}
function ringArea(r) { let A = 0; for (let i = 0; i < r.length - 1; i++) { const [x0, y0] = P(...r[i]), [x1, y1] = P(...r[i + 1]); A += x0 * y1 - x1 * y0; } return Math.abs(A / 2); }
function coreBBox(rings) {
  const list = rings.map((r) => [ringArea(r), r]).sort((a, b) => b[0] - a[0]);
  const tot = list.reduce((a, x) => a + x[0], 0); let acc = 0; const keep = [];
  for (const [a, r] of list) { keep.push(r); acc += a; if (acc >= tot * 0.97) break; }
  return bboxOf(keep);
}
function labelPoint(rings) {
  let best = null, ba = 0;
  for (const r of rings) {
    let A = 0, cx = 0, cy = 0;
    for (let i = 0; i < r.length - 1; i++) { const [x0, y0] = P(...r[i]), [x1, y1] = P(...r[i + 1]); const f = x0 * y1 - x1 * y0; A += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f; }
    if (Math.abs(A) > ba) { ba = Math.abs(A); best = [cx / (3 * A), cy / (3 * A)]; }
  }
  return { pt: best, area: ba / 2 };
}
// 전국 지도에서 너무 작아 안에 글자를 못 넣는 시·도: 바다 쪽에 이름표를 두고 선으로 연결 (지도 좌표)
const CALLOUT = { 서울: [178, 108], 세종: [124, 214], 대전: [124, 258] };
const LABEL_NUDGE = { 경기: [24, -34], 인천: [-20, 6], 서울: [2, -2], 대전: [3, 4], 충북: [6, -6], 세종: [-4, -2] };

// 모양 안에서 가장 넓은 지점(가장자리에서 가장 먼 점)과 그 거리 — 이름표 위치용
function poleOf(rings) {
  let best = null, bestA = 0;
  for (const r of rings) { const a = ringArea(r); if (a > bestA) { bestA = a; best = r; } }
  if (!best) return { pole: null, rad: 0 };
  const pts = best.map((q) => P(q[0], q[1]));
  let a0 = Infinity, b0 = Infinity, a1 = -Infinity, b1 = -Infinity;
  for (const [x, y] of pts) { if (x < a0) a0 = x; if (y < b0) b0 = y; if (x > a1) a1 = x; if (y > b1) b1 = y; }
  const inside = (x, y) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  const dist = (x, y) => { let m = Infinity; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [x1, y1] = pts[j], [x2, y2] = pts[i]; const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy; let t = L2 ? ((x - x1) * dx + (y - y1) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); const ex = x1 + t * dx - x, ey = y1 + t * dy - y; const d = ex * ex + ey * ey; if (d < m) m = d; } return Math.sqrt(m); };
  let bx = (a0 + a1) / 2, by = (b0 + b1) / 2, bd = inside(bx, by) ? dist(bx, by) : 0;
  let cw = (a1 - a0), ch = (b1 - b0);
  for (let pass = 0; pass < 3; pass++) {
    const N = pass ? 8 : 18, ox = pass ? bx - cw / 2 : a0, oy = pass ? by - ch / 2 : b0;
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const x = ox + cw * i / N, y = oy + ch * j / N;
      if (!inside(x, y)) continue;
      const d = dist(x, y); if (d > bd) { bd = d; bx = x; by = y; }
    }
    cw /= N / 2; ch /= N / 2;
  }
  return { pole: [bx, by], rad: bd };
}

function prepGeo() {
  for (const f of S.geo.sido) { f.d = toPath(f.r); f.bb = bboxOf(f.r); f.core = coreBBox(f.sd === '인천' ? f.r.filter((r) => Math.max(...r.map((q) => q[0])) > 126.35) : f.r); Object.assign(f, labelPoint(f.r)); }
  for (const f of S.geo.sgg) { f.d = toPath(f.r); f.bb = bboxOf(f.r); Object.assign(f, labelPoint(f.r)); }
  for (const f of [...S.geo.sido, ...S.geo.sgg]) Object.assign(f, poleOf(f.r));
  const all = S.geo.sido.map((f) => f.bb);
  S.natBB = [Math.min(...all.map((b) => b[0])), Math.min(...all.map((b) => b[1])), Math.max(...all.map((b) => b[2])), Math.max(...all.map((b) => b[3]))];
}

function bins(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return [0];
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const t = [q(1/7), q(2/7), q(3/7), q(4/7), q(5/7), q(6/7)];
  return t.map((x, i) => i && x <= t[i - 1] ? t[i - 1] + 1 : x);
}
function colorLevel(v, th) { if (v == null) return 'var(--land)'; let i = 0; while (i < th.length && v >= th[i]) i++; return `var(--s${i})`; }
function colorMom(cur, prev) {
  if (cur == null || prev == null) return 'var(--land)';
  const p = prev > 0 ? (cur - prev) / prev : (cur > 0 ? 1 : 0);
  const k = p >= 0.15 ? 3 : p >= 0.05 ? 2 : p > 0.005 ? 1 : p <= -0.15 ? -3 : p <= -0.05 ? -2 : p < -0.005 ? -1 : 0;
  return `var(--d${k})`;
}

// 인구 (주민등록인구, 최신 월)
function popOf(sido, sgg) { const P = S.pop; if (!P) return null; return sgg ? (P.sgg?.[sido]?.[sgg] ?? null) : (sido ? (P.sido?.[sido] ?? null) : Object.values(P.sido || {}).reduce((a, b) => a + b, 0) || null); }
function fmtPop(v) { if (v == null) return '–'; if (v >= 10000) { const m = v / 10000; return (m >= 100 ? Math.round(m).toLocaleString('ko-KR') : m.toFixed(1)) + '만'; } return fmt(v); }
function curVal(s) { return s ? s[s.length - 1] : null; }
function prevVal(s) { return s ? s[s.length - 2] : null; }

function renderMap() {
  const svg = $('#map');
  const { sido, sgg } = S.sel;
  const lastM = S.months[S.months.length - 1];
  let html = '';
  let items; // {f, s, key}
  if (!sido) {
    items = S.geo.sido.map((f) => ({ f, s: S.sido[f.sd], key: f.sd, label: f.sd, pop: popOf(f.sd) }));
  } else {
    items = S.geo.sgg.filter((f) => f.sd === sido).map((f) => ({ f, s: S.sgg[sido][f.n], key: f.n, label: f.n, pop: popOf(sido, f.n) }));
    for (const f of S.geo.sido) if (f.sd !== sido) html += `<path class="rg fade" d="${f.d}" data-sido="${esc(f.sd)}"/>`;
  }
  const th = S.metric === 'pop' ? bins(items.map((x) => x.pop)) : bins(items.map((x) => curVal(x.s)));
  for (const it of items) {
    const fill = S.metric === 'level' ? colorLevel(curVal(it.s), th) : S.metric === 'pop' ? colorLevel(it.pop, th) : colorMom(curVal(it.s), prevVal(it.s));
    const sel = sgg && it.key === sgg ? ' sel' : '';
    html += `<path class="rg${sel}" d="${it.f.d}" fill="${fill}" data-key="${esc(it.key)}"/>`;
  }
  if (sido) { const o = S.geo.sido.find((f) => f.sd === sido); html += `<path class="outline" d="${o.d}"/>`; }

  // 보기 영역
  const bb = sido ? S.geo.sido.find((f) => f.sd === sido).core : S.natBB;
  const pad = sido ? 0.06 : 0.03, padY = sido ? 0.09 : 0.03;
  const w = bb[2] - bb[0], h = bb[3] - bb[1];
  let target = [bb[0] - w * pad, bb[1] - h * padY, w * (1 + 2 * pad), h * (1 + 2 * padY)];
  const bw = svg.parentElement.clientWidth || 600;
  const maxH = Math.min(window.innerHeight * 0.64, 620);
  const basePx = bw < 520 ? 10 : 11.5; // 글자 크기(화면 px)

  const valueText = (it) => {
    // 미분양 호수 모드는 호수, 전월 대비 모드는 증감분(+3, −12, ±0), 인구 모드는 인구
    if (S.metric === 'pop') return { t: fmtPop(it.pop), c: '' };
    const mc = S.metric === 'mom' ? chg(curVal(it.s), prevVal(it.s), false) : null;
    return { t: mc ? mc.t : fmt(curVal(it.s)), c: mc ? ' ' + mc.c : '' };
  };
  // 이름표 배치: 모양 안에 들어가면 안쪽, 아니면 옆 여백에 세우고 선으로 연결
  const layout = (tg) => {
    // 좁은 화면은 옆 이름표 공간까지 고려해 지도를 정사각형 가까이 키움
    const minH = bw < 520 ? Math.min(maxH, bw * 0.95) : Math.min(260, maxH);
    svg.style.height = Math.round(Math.max(minH, Math.min(maxH, bw * tg[3] / tg[2]))) + 'px';
    const box = svg.getBoundingClientRect();
    const scale = Math.max(tg[2] / (box.width || 600), tg[3] / (box.height || 600));
    const fs = basePx * scale;
    const placed = [], inside = [], outs = [];
    if (!sido) for (const it of items) if (CALLOUT[it.key] && it.f.pt) {
      const [lx, ly] = CALLOUT[it.key];
      placed.push([lx - 20 * scale, ly, 22 * scale, fs * 1.2], [it.f.pt[0], it.f.pt[1], 2 * scale, 2 * scale]);
    }
    const order = items.filter((it) => !(!sido && CALLOUT[it.key]) && it.f.pole).sort((a, b) => b.f.rad - a.f.rad);
    for (const it of order) {
      const vt = valueText(it);
      const nud = !sido && LABEL_NUDGE[it.key] ? LABEL_NUDGE[it.key] : [0, 0];
      const x = it.f.pole[0] + nud[0] * scale / 0.9, y = it.f.pole[1] + nud[1] * scale / 0.9;
      const hw = Math.max(it.label.length * fs * 0.5, vt.t.length * fs * 0.3), hh = fs * 1.1;
      const room = nud[0] || nud[1] ? Infinity : it.f.rad;
      const fits = room >= hh * 0.85 && room >= hw * 0.7;
      const hit = placed.some((q) => Math.abs(q[0] - x) < q[2] + hw && Math.abs(q[1] - y) < q[3] + hh);
      if (fits && !hit) { placed.push([x, y, hw, hh]); inside.push({ it, x, y, vt }); }
      else outs.push({ it, vt, w: (it.label.length * 1.1 + vt.t.length * 0.7 + 1.8) * fs });
    }
    return { scale, fs, inside, outs };
  };
  let L = layout(target);
  if (L.outs.length) {
    // 옆 이름표 자리만큼 좌우 여백을 넓힌 뒤 다시 배치
    const cx = (bb[0] + bb[2]) / 2, gap = 1.6 * L.fs;
    const side = (o) => (!sido || o.it.f.pole[0] >= cx ? 'R' : 'L');
    const wl = Math.max(0, ...L.outs.filter((o) => side(o) === 'L').map((o) => o.w)), wr = Math.max(0, ...L.outs.filter((o) => side(o) === 'R').map((o) => o.w));
    target = [target[0] - (wl ? wl + gap : 0), target[1], target[2] + (wl ? wl + gap : 0) + (wr ? wr + gap : 0), target[3]];
    L = layout(target);
  }
  const { scale, fs } = L, sw = (3 * scale).toFixed(2);

  // 고정 이름표(전국 지도의 서울·세종·대전)
  if (!sido) {
    for (const it of items) {
      const pos = CALLOUT[it.key];
      if (!pos || !it.f.pt) continue;
      const [lx, ly] = pos, [px, py] = it.f.pt;
      const vt = valueText(it);
      const tw = Math.max(it.label.length * fs * 0.95, vt.t.length * fs * 0.55);
      html += `<line class="leader" x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${(lx + 3 * scale).toFixed(1)}" y2="${ly.toFixed(1)}"/>`;
      html += `<circle class="leader-dot" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${(2.2 * scale).toFixed(2)}"/>`;
      html += `<rect class="callout-hit" data-key="${esc(it.key)}" x="${(lx - tw).toFixed(1)}" y="${(ly - fs * 1.3).toFixed(1)}" width="${(tw + 4 * scale).toFixed(1)}" height="${(fs * 2.5).toFixed(1)}" rx="${(3 * scale).toFixed(1)}"/>`;
      html += `<text class="co" x="${lx.toFixed(1)}" y="${(ly - fs * 0.55).toFixed(1)}" font-size="${fs.toFixed(2)}" style="stroke-width:${sw}px">${esc(it.label)}</text>`;
      html += `<text class="co v${vt.c}" x="${lx.toFixed(1)}" y="${(ly + fs * 0.6).toFixed(1)}" font-size="${(fs * 0.9).toFixed(2)}" style="stroke-width:${sw}px">${vt.t}</text>`;
    }
  }
  // 안쪽 이름표
  for (const { it, x, y, vt } of L.inside) {
    html += `<text x="${x.toFixed(1)}" y="${(y - fs * 0.55).toFixed(1)}" font-size="${fs.toFixed(2)}" style="stroke-width:${sw}px">${esc(it.label)}</text>`;
    html += `<text class="v${vt.c}" x="${x.toFixed(1)}" y="${(y + fs * 0.6).toFixed(1)}" font-size="${(fs * 0.9).toFixed(2)}" style="stroke-width:${sw}px">${vt.t}</text>`;
  }
  // 옆 이름표: 왼쪽·오른쪽 기둥에 위아래로 겹치지 않게 세움
  if (L.outs.length) {
    const cx = (bb[0] + bb[2]) / 2, gap = 1.2 * fs, sp = fs * 1.5;
    const top = target[1] + fs, bottom = target[1] + target[3] - fs * 0.5;
    for (const sideKey of ['L', 'R']) {
      const col = L.outs.filter((o) => (!sido || o.it.f.pole[0] >= cx ? 'R' : 'L') === sideKey).sort((a, b) => a.it.f.pole[1] - b.it.f.pole[1]);
      if (!col.length) continue;
      const step = Math.min(sp, (bottom - top) / Math.max(1, col.length - 1 || 1));
      let ys = []; let prev = -Infinity;
      for (const o of col) { const yy = Math.max(o.it.f.pole[1], prev + step, top); ys.push(yy); prev = yy; }
      const over = ys[ys.length - 1] - bottom;
      if (over > 0) { ys = ys.map((v) => v - over); for (let i = 0; i < ys.length; i++) ys[i] = Math.max(ys[i], top + i * step); }
      const lx = sideKey === 'L' ? bb[0] - gap : bb[2] + gap, anchor = sideKey === 'L' ? 'end' : 'start';
      col.forEach((o, i) => {
        const [px, py] = o.it.f.pole, ly = ys[i];
        const ex = sideKey === 'L' ? lx + 0.4 * fs : lx - 0.4 * fs;
        html += `<line class="leader" x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${(ly - fs * 0.35).toFixed(1)}"/>`;
        html += `<circle class="leader-dot" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${(1.8 * scale).toFixed(2)}"/>`;
        const rx = sideKey === 'L' ? lx - o.w : lx - 0.2 * fs;
        html += `<rect class="callout-hit" data-key="${esc(o.it.key)}" x="${rx.toFixed(1)}" y="${(ly - fs * 1.05).toFixed(1)}" width="${(o.w + 0.2 * fs).toFixed(1)}" height="${(fs * 1.4).toFixed(1)}" rx="${(3 * scale).toFixed(1)}"/>`;
        html += `<text class="co1 ${sideKey}" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="${fs.toFixed(2)}" style="stroke-width:${sw}px">${esc(o.it.label)} <tspan class="v${o.vt.c}" font-size="${(fs * 0.9).toFixed(2)}">${o.vt.t}</tspan></text>`;
      });
    }
  }
  svg.innerHTML = html;
  animateView(svg, target);
  renderLegend(th);
  S.mapItems = new Map(items.map((x) => [x.key, x]));
}

function animateView(svg, target) {
  const from = S.view || target;
  const t0 = performance.now(), dur = S.view ? 420 : 0;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  cancelAnimationFrame(S.raf);
  const step = (now) => {
    const t = dur ? Math.min(1, (now - t0) / dur) : 1;
    const v = from.map((a, i) => a + (target[i] - a) * ease(t));
    svg.setAttribute('viewBox', v.join(' '));
    if (t < 1) S.raf = requestAnimationFrame(step); else S.view = target;
  };
  S.raf = requestAnimationFrame(step);
}

function renderLegend(th) {
  const el = $('#legend');
  if (S.metric === 'pop') {
    el.innerHTML = `<span>주민등록인구 (${esc(fmtM(S.pop?.month || ''))})</span><div class="bar">${[0,1,2,3,4,5,6].map((i) => `<i style="background:var(--s${i})"></i>`).join('')}</div><div class="ticks"><span>적음</span><span>${fmtPop(th[2])}</span><span>${fmtPop(th[5])}+</span></div>`;
  } else if (S.metric === 'level') {
    el.innerHTML = `<span>미분양 호수 (${fmtM(S.months.at(-1))})</span><div class="bar">${[0,1,2,3,4,5,6].map((i) => `<i style="background:var(--s${i})"></i>`).join('')}</div><div class="ticks"><span>적음</span><span>${fmt(th[2])}</span><span>${fmt(th[5])}+</span></div>`;
  } else {
    el.innerHTML = `<span>전월 대비 증감률</span><div class="bar">${[-3,-2,-1,0,1,2,3].map((i) => `<i style="background:var(--d${i})"></i>`).join('')}</div><div class="ticks"><span>−15%</span><span>0</span><span>+15%</span></div>`;
  }
}

function bindMap() {
  const svg = $('#map'), tip = $('#tip'), wrap = $('#mapWrap');
  svg.addEventListener('click', (e) => {
    const p = e.target.closest('path, rect.callout-hit');
    if (!p) return;
    if (p.dataset.sido) return select(p.dataset.sido, null);
    const k = p.dataset.key; if (!k) return;
    if (!S.sel.sido) select(k, null); else select(S.sel.sido, k === S.sel.sgg ? null : k);
  });
  svg.addEventListener('mousemove', (e) => {
    const p = e.target.closest('path[data-key], path[data-sido], rect[data-key]');
    if (!p) { tip.hidden = true; return; }
    const r = wrap.getBoundingClientRect();
    let name, s, pop;
    if (p.dataset.sido) { name = p.dataset.sido; s = S.sido[name]; pop = popOf(name); }
    else { const it = S.mapItems.get(p.dataset.key); name = (S.sel.sido ? S.sel.sido + ' ' : '') + it.key; s = it.s; pop = it.pop; }
    const c = chg(curVal(s), prevVal(s));
    tip.innerHTML = `<b>${esc(name)}</b><br>미분양 ${fmt(curVal(s))}호 · 전월 <span>${c.t}</span>${pop ? `<br>인구 ${fmt(pop)}명 · 1만 명당 미분양 ${(curVal(s) / pop * 1e4).toFixed(1)}호` : ''}`;
    tip.style.left = (e.clientX - r.left) + 'px'; tip.style.top = (e.clientY - r.top) + 'px';
    tip.hidden = false;
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; });
  document.querySelectorAll('[data-metric]').forEach((b) => b.addEventListener('click', () => {
    S.metric = b.dataset.metric;
    document.querySelectorAll('[data-metric]').forEach((x) => x.classList.toggle('on', x === b));
    renderMap();
  }));
  let rt; if (window.ResizeObserver) new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { S.view = null; renderMap(); renderTrend(); renderPermit(); }, 120); }).observe(wrap);
}

/* ---------- 목록 ---------- */
function renderRank() {
  const { sido, sgg } = S.sel;
  const el = $('#rank');
  let rows;
  if (!sido) rows = ORDER.map((k) => ({ k, s: S.sido[k] }));
  else rows = Object.entries(S.sgg[sido]).map(([k, s]) => ({ k, s }));
  rows.sort((a, b) => (curVal(b.s) ?? -1) - (curVal(a.s) ?? -1));
  const max = Math.max(1, ...rows.map((r) => curVal(r.s) || 0));
  $('#listTitle').textContent = sido ? `${sido} 시·군·구별 미분양` : '시·도별 미분양';
  $('#listMonth').textContent = `${fmtM(S.months.at(-1))} 기준 · 호`;
  el.innerHTML = rows.map((r, i) => {
    const v = curVal(r.s), c = chg(v, prevVal(r.s), false);
    return `<li data-k="${esc(r.k)}" class="${sgg === r.k ? 'sel' : ''}"><span class="i">${i + 1}</span><span class="n">${esc(r.k)}</span><span class="b"><i style="width:${((v || 0) / max * 100).toFixed(1)}%"></i></span><span class="v">${fmt(v)}</span><span class="c ${c.c}">${c.t}</span></li>`;
  }).join('');
  el.onclick = (e) => { const li = e.target.closest('li'); if (!li) return; if (!sido) select(li.dataset.k, null); else select(sido, li.dataset.k === sgg ? null : li.dataset.k); };
}

/* ---------- 상세 ---------- */
function currentSeries() {
  const { sido, sgg } = S.sel;
  if (sgg) return S.sgg[sido][sgg];
  if (sido) return S.sido[sido];
  return S.nat;
}

function renderHero() {
  const { sido, sgg } = S.sel;
  $('#dLevel').textContent = sgg ? `${LONG[sido]} · 시·군·구` : sido ? '시·도' : '전국';
  $('#dName').textContent = sgg || (sido ? LONG[sido] : '대한민국');
  $('#backBtn').hidden = !sido;
  const s = currentSeries(), L = s.length;
  const now = s[L - 1];
  $('#kNow').textContent = fmt(now) + '호';
  $('#kMonth').textContent = fmtM(S.months[L - 1]) + ' 기준';
  const kc = (prev) => { const c = chg(now, prev, false); const p = now != null && prev > 0 ? ((now - prev) / prev * 100) : null; return `<span class="${c.c}">${c.t}</span>` + (p != null ? `<small class="${c.c}">${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}%</small>` : ''); };
  $('#kMom').innerHTML = kc(s[L - 2]);
  $('#kYoy').innerHTML = kc(s[L - 13]);
  let pk = -1, pi = -1; for (let i = Math.max(0, L - 36); i < L; i++) if (s[i] != null && s[i] > pk) { pk = s[i]; pi = i; }
  const pp = popOf(sido, sgg);
  $('#dPop').textContent = pp ? `인구 ${fmt(pp)}명 (${fmtM(S.pop.month)}) · 1만 명당 미분양 ${now != null ? (now / pp * 1e4).toFixed(1) : '–'}호` : '';
  $('#kPeak').textContent = pk >= 0 ? fmt(pk) + '호' : '–';
  $('#kPeakM').textContent = pi >= 0 ? fmtM(S.months[pi]) + (now != null && pk > 0 ? ` · 현재 ${Math.round(now / pk * 100)}%` : '') : '';
  const nat = S.nat, nc = chg(nat.at(-1), nat.at(-2));
  $('#natVal').textContent = fmt(nat.at(-1)) + '호';
  $('#natChg').className = 'chg ' + nc.c; $('#natChg').textContent = nc.t;
  renderCrumb();
}

function renderCrumb() {
  const { sido, sgg } = S.sel;
  const parts = [];
  parts.push(sido ? `<button data-go="">전국</button>` : `<span class="cur">전국</span>`);
  if (sido) { parts.push('<span class="sep">›</span>'); parts.push(sgg ? `<button data-go="${esc(sido)}">${esc(sido)}</button>` : `<span class="cur">${esc(sido)}</span>`); }
  if (sgg) { parts.push('<span class="sep">›</span>'); parts.push(`<span class="cur">${esc(sgg)}</span>`); }
  const el = $('#crumb'); el.innerHTML = parts.join('');
  el.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; select(b.dataset.go || null, null); };
}

/* ---------- 차트 ---------- */
function niceMax(v) { if (v <= 0) return 10; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }

function drawChart(el, months, vals, { type = 'line', height = 200, unit = '호', extremes = false, xTick = null } = {}) {
  const W = Math.max(280, el.clientWidth || 600), H = height;
  const m = { l: 44, r: 10, t: extremes ? 30 : 12, b: 24 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const n = vals.length;
  const max = niceMax(Math.max(1, ...vals.filter((v) => v != null)));
  const x = (i) => m.l + (type === 'bar' ? (i + 0.5) * iw / n : (n === 1 ? iw / 2 : i * iw / (n - 1)));
  const y = (v) => m.t + ih - v / max * ih;
  let g = '<g class="grid">';
  for (let k = 0; k <= 4; k++) { const v = max * k / 4, yy = y(v); g += `<line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`; }
  g += '</g><g class="axis">';
  for (let k = 0; k <= 4; k++) { const v = max * k / 4; g += `<text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v >= 10000 ? (v / 10000).toFixed(v % 10000 ? 1 : 0) + '만' : fmt(v)}</text>`; }
  if (xTick) {
    // 정해진 달에만 눈금(예: 6개월·1년 단위)
    for (let i = 0; i < n; i++) { const t = xTick(months[i]); if (t) g += `<line class="xt" x1="${x(i)}" x2="${x(i)}" y1="${m.t + ih}" y2="${m.t + ih + 4}"/><text x="${x(i)}" y="${H - 6}" text-anchor="middle">${t}</text>`; }
  } else {
    const step = Math.ceil(n / (W < 480 ? 4 : 7));
    for (let i = 0; i < n; i += step) g += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${months[i].slice(2, 4)}.${months[i].slice(4, 6)}</text>`;
  }
  g += '</g>';
  let body = '';
  if (type === 'line') {
    let d = '', a = '', started = false, first = null, lastX = null;
    vals.forEach((v, i) => { if (v == null) { started = false; return; } d += (started ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); if (first == null) first = i; lastX = i; started = true; });
    if (first != null) { a = d.replace(/^M/, 'M') + `L${x(lastX).toFixed(1)},${y(0)}L${x(first).toFixed(1)},${y(0)}Z`; }
    body = `<path class="ar" d="${a}"/><path class="ln" d="${d}"/>`;
    const li = vals.length - 1; if (vals[li] != null) body += `<circle class="dot" cx="${x(li)}" cy="${y(vals[li])}" r="4"/>`;
    if (extremes) {
      // 보이는 기간 안의 최고·최저 지점에 값과 시점 표시
      let hi = -1, lo = -1;
      vals.forEach((v, i) => { if (v == null) return; if (hi < 0 || v > vals[hi]) hi = i; if (lo < 0 || v < vals[lo]) lo = i; });
      const mark = (i, kind) => {
        const cx = x(i), cy = y(vals[i]);
        const anchor = cx < m.l + 50 ? 'start' : cx > W - m.r - 50 ? 'end' : 'middle';
        const below = kind === 'lo' && cy + 30 < m.t + ih;
        const ty = kind === 'hi' ? cy - 10 : below ? cy + 20 : cy - 10;
        return `<circle class="ex-dot ${kind}" cx="${cx}" cy="${cy}" r="4.5"/><text class="ex ${kind}" x="${cx}" y="${ty}" text-anchor="${anchor}">${kind === 'hi' ? '최고' : '최저'} ${fmt(vals[i])}<tspan class="exm"> (${months[i].slice(2, 4)}.${months[i].slice(4, 6)})</tspan></text>`;
      };
      if (hi >= 0) body += mark(hi, 'hi');
      if (lo >= 0 && lo !== hi) body += mark(lo, 'lo');
    }
  } else {
    const bw = Math.max(1, iw / n * 0.7);
    vals.forEach((v, i) => { if (v == null || v < 0) return; body += `<rect class="bar${i === n - 1 ? ' hl' : ''}" x="${(x(i) - bw / 2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y(0) - y(v)).toFixed(1)}" rx="1.5"/>`; });
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}">${g}${body}<line class="cross" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/><circle class="dot hv" r="4" visibility="hidden"/></svg><div class="ctip" hidden></div>`;
  const svg = el.querySelector('svg'), cross = svg.querySelector('.cross'), hv = svg.querySelector('.hv'), tip = el.querySelector('.ctip');
  svg.onmousemove = (e) => {
    const r = svg.getBoundingClientRect(); const px = (e.clientX - r.left) * W / r.width;
    let i = type === 'bar' ? Math.floor((px - m.l) / (iw / n)) : Math.round((px - m.l) / (iw / Math.max(1, n - 1)));
    i = Math.max(0, Math.min(n - 1, i));
    const v = vals[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    if (v != null && type === 'line') { hv.setAttribute('cx', x(i)); hv.setAttribute('cy', y(v)); hv.setAttribute('visibility', 'visible'); } else hv.setAttribute('visibility', 'hidden');
    tip.hidden = false; tip.style.left = (x(i) / W * r.width) + 'px';
    tip.textContent = `${fmtM(months[i])}  ${fmt(v)}${unit}`;
  };
  svg.onmouseleave = () => { cross.setAttribute('visibility', 'hidden'); hv.setAttribute('visibility', 'hidden'); tip.hidden = true; };
}

function renderTrend() {
  const s = currentSeries(); if (!s) return;
  const n = Math.min(S.range, s.length);
  // x축 눈금: 1년은 2개월, 3년은 6개월(1월·7월), 5·10년은 1년(1월) 단위
  const narrow = ($('#trend').clientWidth || 600) < 480;
  const xTick = S.range <= 12 ? (m) => (+m.slice(4) % 2 === 1 ? `${m.slice(2, 4)}.${m.slice(4)}` : null)
    : S.range <= 36 ? (m) => (m.slice(4) === '01' || m.slice(4) === '07' ? `${m.slice(2, 4)}.${m.slice(4)}` : null)
    : (m) => (m.slice(4) === '01' ? (narrow && S.range > 60 ? `${m.slice(2, 4)}년` : `${m.slice(0, 4)}`) : null); // 좁은 화면 10년은 '17년'처럼 짧게
  drawChart($('#trend'), S.months.slice(-n), s.slice(-n), { height: 230, extremes: true, xTick });
}

/* ---------- 향후 공급 ---------- */
function renderSupply() {
  const el = $('#supply');
  const sd = S.sel.sido;
  const sup = S.supply;
  if (!sup) { el.innerHTML = '<div class="empty">입주예정 자료를 불러오지 못했습니다.</div>'; return; }
  const rec = sd ? sup.sido[sd] : sup.national;
  const unsold = sd ? curVal(S.sido[sd]) : curVal(S.nat);
  const name = sd ? sd : '전국';
  const by = rec?.byYear;
  const ratio = rec && unsold ? rec.total / unsold : null;
  const yb = by ? `<div class="yearbars">${sup.years.map((y) => { const v = by[y] ?? 0; const mx = Math.max(...Object.values(by)); return `<div><i style="height:${(v / mx * 100) || 4}%"></i>${y.slice(2)}년 ${fmt(v)}</div>`; }).join('')}</div>` : '<div class="s">연도별 값 미공개(2년 합계만 발표)</div>';
  el.innerHTML = `
    <div class="supply-grid">
      <div class="sbox"><span class="k">${esc(name)} 입주예정 (${sup.years[0]}~${sup.years.at(-1)})</span><b>${rec ? fmt(rec.total) + '가구' : '–'}</b>${yb}</div>
      <div class="sbox"><span class="k">현재 미분양 (${esc(name)})</span><b>${fmt(unsold)}호</b><span class="s">${fmtM(S.months.at(-1))} 기준</span></div>
      <div class="sbox"><span class="k">공급 부담 지표</span><b>${ratio ? ratio.toFixed(1) + '배' : '–'}</b><span class="s">입주예정 ÷ 현재 미분양</span></div>
    </div>
    <p class="note">${esc(sup.source)}. ${esc(sup.note)}${S.sel.sgg ? ' 시·군·구를 골라도 상위 시·도 값을 보여줍니다.' : ''} 공급 부담 지표는 비교용 참고값이며 공식 지표가 아닙니다.</p>`;
}

async function loadPermit() {
  if (S.permit !== undefined) return S.permit;
  S.permit = null;
  try {
    const idx = await getJSON('data/supply-index.json'); // 인허가·착공·분양 중 받아진 것
    const list = [];
    for (const name of idx.list || []) { try { list.push(await getJSON(`data/supply-${name}.json`)); } catch (_) {} }
    S.permit = list.length ? { list } : { error: 'not_yet' };
  } catch (e) { S.permit = { error: e.status === 404 || e.code === 'no_server' ? 'not_yet' : 'error', message: e.message }; }
  return S.permit;
}

const TOTALS = new Set(['계', '합계', '총계', '소계', '전체', '']);
const ALL_SIDO_NAMES = new Set([...ORDER.filter((x) => x !== '전남광주'), '광주', '전남', ...Object.values(LONG), '광주광역시', '전라남도', '강원도', '전라북도']);
const AGG_REGIONS = new Set(['전국', '수도권', '지방', '지방소계', '기타광역시', '기타지방']);
// 분류값 하나가 '합계'에 가까운 정도 (높을수록 합계)
function totalScore(c) {
  if (TOTALS.has(c)) return 2;
  if (/가구수/.test(c)) return 3;          // 인허가: 합계(가구수기준)
  if (/동수/.test(c)) return -3;           // 인허가: 합계(동수기준) 제외
  if (c === '순계') return 2;              // 분양: 월 실적
  if (c === '누계') return -5;             // 분양: 누계 제외
  if (/^(합|총계|소계|합계)/.test(c)) return 1;
  return -1;
}
function pickPermitSeries(j, sido, sgg) {
  const rows = j.rows || [];
  const OLD = { 강원: ['강원도'], 전북: ['전라북도'], 제주: ['제주도'] };
  const names = (sd) => [sd, LONG[sd], ...(OLD[sd] || [])];
  const has = (r, list) => list.some((n) => r[0] === n || r[1] === n || r[2] === n);
  const isRegion = (c) => ALL_SIDO_NAMES.has(c) || AGG_REGIONS.has(c) || c === '전남광주';
  let level = null, groupsets = [];
  if (sgg) { const c = rows.filter((r) => has(r, [sgg]) && has(r, names(sido))); if (c.length) { level = 'sgg'; groupsets = [c]; } }
  if (!level && sido === '전남광주') {
    // 통합 뒤는 '전남광주' 행, 통합 전은 광주+전남 행을 이어 붙임
    level = 'sido'; groupsets = [rows.filter((r) => has(r, ['전남광주', '전남광주통합특별시'])), rows.filter((r) => has(r, ['광주', '광주광역시', '전남', '전라남도']))];
  } else if (!level && sido) { level = 'sido'; groupsets = [rows.filter((r) => has(r, names(sido)))]; }
  if (!level) {
    level = 'nat';
    const n = rows.filter((r) => has(r, ['전국']));
    groupsets = [n.length ? n : rows.filter((r) => !r.slice(0, 3).some(isRegion))];
  }
  const series = (cand) => {
    if (!cand.length) return null;
    const groups = new Map();
    for (const r of cand) {
      const other = r.slice(0, 3).filter((c) => c && !isRegion(c) && c !== sgg);
      const key = other.join('|') + '#' + r[3];
      if (!groups.has(key)) {
        const score = other.reduce((a, c) => a + totalScore(c), 0) + (/(합계|계|전체)/.test(r[3]) ? 1 : 0);
        groups.set(key, { score, rows: [], label: other.filter((c) => totalScore(c) < 2 && !/가구수/.test(c)).concat(/(합계|계)/.test(r[3]) ? [] : [r[3]]).join(' · ') });
      }
      groups.get(key).rows.push(r);
    }
    const best = [...groups.values()].sort((a, b) => b.score - a.score)[0];
    const byM = new Map();
    for (const r of best.rows) if (r[5] != null) byM.set(r[4], (byM.get(r[4]) || 0) + r[5]);
    return { byM, label: best.label };
  };
  const parts = groupsets.map(series).filter(Boolean);
  if (!parts.length) return null;
  const byM = new Map(parts[parts.length - 1].byM);
  if (parts.length > 1) for (const [m, v] of parts[0].byM) byM.set(m, v); // 앞쪽(통합 뒤) 값을 우선
  const months = [...byM.keys()].sort();
  return { level, months, vals: months.map((mm) => byM.get(mm)), label: parts[0].label };
}

const SUPPLY_NOTE = {
  permit: '인허가 후 보통 수개월~1년 안에 착공·분양으로 이어집니다.',
  start: '착공 후 보통 수개월 안에 분양(선분양), 2~3년 뒤 입주합니다.',
  sale: '실제 분양(입주자 모집) 실적입니다. 분양이 늘면 이후 미분양·입주 물량에 영향을 줍니다.',
};
async function renderPermit() {
  const el = $('#permit');
  const j = await loadPermit();
  if (!j) return;
  if (j.error) {
    const msg = window.PREVIEW ? '미리보기에는 공급 선행지표 자료가 들어 있지 않습니다. GitHub 사이트에서 표시됩니다.' : j.error === 'not_yet' ? '아직 공급 선행지표 자료가 없습니다. KOSIS_KEY를 넣고 데이터 수집을 실행하면 표시됩니다.' : `공급 선행지표를 불러오지 못했습니다: ${esc(j.message)}`;
    el.innerHTML = `<div class="sub-h">공급 선행지표</div><div class="empty">${msg}</div>`;
    return;
  }
  const blocks = [];
  const charts = [];
  j.list.forEach((d, i) => {
    const ps = pickPermitSeries(d, S.sel.sido, S.sel.sgg);
    if (!ps || !ps.months.length) { blocks.push(`<div class="sub-h">${esc(d.label)}</div><div class="empty">이 지역의 ${esc(d.label)} 자료가 통계표에 없습니다.</div>`); return; }
    const lv = { sgg: S.sel.sgg, sido: S.sel.sido, nat: '전국' }[ps.level];
    const last12 = ps.vals.slice(-12).reduce((a, b) => a + (b || 0), 0), prev12 = ps.vals.slice(-24, -12).reduce((a, b) => a + (b || 0), 0);
    const c = chg(last12, prev12);
    const unit = d.unit || '호';
    blocks.push(`<div class="sub-h"><span>${esc(d.label)} <span class="muted">${esc(lv)}${ps.level === 'sido' && S.sel.sgg ? ' · 시·도 단위' : ''} · 월별</span></span><span class="muted">최근 12개월 ${fmt(last12)}${esc(unit)} · 전년 대비 <span class="${c.c}">${c.t}</span></span></div><div class="chart" id="supChart${i}"></div><p class="note">${esc(d.tblNm || '')}${ps.label ? ' · ' + esc(ps.label) : ''} · ${esc(fmtM(ps.months.at(-1)))}까지 · ${SUPPLY_NOTE[d.src] || ''}</p>`);
    charts.push([i, ps, unit]);
  });
  el.innerHTML = `<div class="sub-h" style="margin-top:18px">공급 선행지표 <span class="muted">국토교통부 주택건설실적통계</span></div>` + blocks.join('');
  for (const [i, ps, unit] of charts) drawChart($('#supChart' + i), ps.months.slice(-36), ps.vals.slice(-36), { type: 'bar', height: 130, unit });
}

/* ---------- 청약 결과 ---------- */
async function renderCy() {
  const el = $('#cy');
  const { sido, sgg } = S.sel;
  if (!sido) { el.innerHTML = `<div class="empty">지도나 목록에서 <b>시·도</b>를 고르면 최근 3년 아파트 청약 결과가 나타납니다.</div>`; return; }
  let all = S.cy.get(sido);
  if (!all) {
    el.innerHTML = '<div class="skel" style="width:60%"></div><div class="skel"></div><div class="skel"></div><div class="skel" style="width:80%"></div>';
    try {
      all = (window.PRELOAD_CY && window.PRELOAD_CY[sido]) || await getJSON(`data/cheongyak/${encodeURIComponent(sido)}.json`); // 시·도별 파일(매일 갱신)
      S.cy.set(sido, all);
    } catch (e) {
      if (S.sel.sido !== sido || S.sel.sgg !== sgg) return;
      const msg = window.PREVIEW ? '미리보기에는 청약 자료가 들어 있지 않습니다.<br><span class="small-t">GitHub에 올려 매일 자료 수집을 돌리면 이 자리에 최근 3년 청약 결과가 나옵니다.</span>' : e.status === 404 || e.code === 'no_server' ? '아직 청약 자료가 없습니다.<br><span class="small-t">저장소 시크릿에 DATA_GO_KR_KEY를 넣고 데이터 수집을 한 번 실행하면 표시됩니다.</span>' : `청약 결과를 불러오지 못했습니다.<br><span class="small-t">${esc(e.message)}</span>`;
      el.innerHTML = `<div class="empty err">${msg}<br><button class="ghost retry">다시 시도</button></div>`;
      el.querySelector('.retry').onclick = () => renderCy();
      return;
    }
    if (S.sel.sido !== sido || S.sel.sgg !== sgg) return;
  }
  const d = { ...all, items: sgg ? all.items.filter((it) => it.sgg === sgg) : all.items.slice() };
  d.count = d.items.length;
  if (!d.items.length) { el.innerHTML = `<div class="empty">${esc(sgg || sido)}에는 최근 3년(${esc(d.from)} 이후) 아파트 분양 공고가 없습니다.</div>`; return; }

  const items = d.items.slice();
  const rate = (it) => it.comp?.avg1 ?? -1;
  if (S.sort === 'rate') items.sort((a, b) => rate(b) - rate(a));
  else if (S.sort === 'size') items.sort((a, b) => (b.total || 0) - (a.total || 0));

  // 묶음 요약: 단지 수, 공급 세대, 1순위 평균(합산), 미달 단지 수
  const stats = (list) => {
    const withC = list.filter((it) => it.comp && it.comp.supply > 0);
    const sup = withC.reduce((a, it) => a + it.comp.supply, 0), r1 = withC.reduce((a, it) => a + it.comp.r1, 0);
    return { n: list.length, hh: list.reduce((a, it) => a + (it.total || 0), 0), rate: sup ? r1 / sup : null, hasC: withC.length > 0, short: withC.filter((it) => it.comp.shortModels > 0).length };
  };
  const all3 = stats(d.items);

  const card = (it) => {
    const c = it.comp;
    const chip = !c ? '' : c.shortModels > 0 ? `<span class="chip short">미달 ${c.shortModels}/${c.models}개 타입</span>` : c.avg1 >= 10 ? '<span class="chip hot">1순위 마감</span>' : c.avg1 >= 1 ? '<span class="chip">1순위 마감</span>' : '<span class="chip">2순위</span>';
    const nm = it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.name)}</a>` : esc(it.name);
    const rateHtml = c && c.supply ? `<b>${c.avg1.toFixed(c.avg1 >= 100 ? 0 : 1)} : 1</b><span>1순위 평균 · 최고 ${c.max1.toFixed(c.max1 >= 100 ? 0 : 1)}</span>` : `<b class="muted">–</b><span>경쟁률 없음</span>`;
    return `<div class="cy-item"><div class="nm">${nm}${chip}</div><div class="rate">${rateHtml}</div><div class="meta">${!sgg && it.sgg ? esc(it.sgg) + ' · ' : ''}${esc(it.date || '')} 공고 · ${fmt(it.total)}세대${it.kind ? ' · ' + esc(it.kind) : ''}${it.mvn ? ' · 입주 ' + esc(fmtM(String(it.mvn))) : ''}</div></div>`;
  };
  // 공고 연도별 묶음: 올해 / 작년 / 재작년 / 그 이전
  const Y = new Date().getFullYear();
  const yearKey = (it) => { const y = +(String(it.date || '').slice(0, 4)) || 0; return y >= Y - 2 ? String(y) : 'older'; };
  const groupDefs = [String(Y), String(Y - 1), String(Y - 2), 'older'];
  const groupName = (k) => k === 'older' ? `${Y - 3}년 이하` : `${k}년`;
  const byYear = new Map(groupDefs.map((k) => [k, []]));
  for (const it of items) { const k = yearKey(it); (byYear.get(k) || byYear.get('older')).push(it); }
  if (!S.cyOpen) S.cyOpen = new Set([groupDefs.find((k) => byYear.get(k).length)]); // 처음엔 가장 최근 연도만 펼침
  S.cyShowY = S.cyShowY || {};
  const rateTxt = (r) => r == null ? '–' : r.toFixed(r >= 100 ? 0 : 1) + ' : 1';
  const groupsHtml = groupDefs.map((k) => {
    const list = byYear.get(k);
    if (!list.length) return '';
    const st = stats(list), show = S.cyShowY[k] || 20, open = S.cyOpen.has(k);
    return `<details class="cy-year" data-y="${k}"${open ? ' open' : ''}>
      <summary>
        <span class="yy">${groupName(k)}</span>
        <span class="ys"><b>${fmt(st.n)}</b>곳 · <b>${fmt(st.hh)}</b>세대 · 1순위 <b>${rateTxt(st.rate)}</b>${st.short ? ` · <span class="up">미달 ${fmt(st.short)}곳</span>` : ''}</span>
        <span class="chev" aria-hidden="true"></span>
      </summary>
      ${open ? `<div class="cy-list">${list.slice(0, show).map(card).join('')}</div>${list.length > show ? `<button class="ghost more" data-y="${k}">${fmt(list.length - show)}개 더 보기</button>` : ''}` : ''}
    </details>`;
  }).join('');
  el.innerHTML = `
    <div class="cy-sum">
      <div><span class="k">분양 단지</span><b>${fmt(all3.n)}곳</b></div>
      <div><span class="k">공급 세대</span><b>${fmt(all3.hh)}</b></div>
      <div><span class="k">1순위 평균 경쟁률</span><b>${rateTxt(all3.rate)}</b></div>
      <div><span class="k">미달 발생 단지</span><b>${all3.hasC ? fmt(all3.short) + '곳' : '–'}</b></div>
    </div>
    <div class="cy-years">${groupsHtml}</div>
    <p class="note">1순위 평균 = 1순위 접수 합계 ÷ 일반공급 세대(특별공급 제외). 미달 = 1·2순위 접수가 공급 세대보다 적은 주택형.${all.fetchedAt ? ' 자료 수집 ' + esc(all.fetchedAt.slice(0, 10)) + '.' : ''}</p>`;
  el.querySelectorAll('details.cy-year').forEach((det) => det.addEventListener('toggle', () => {
    const k = det.dataset.y;
    if (det.open) S.cyOpen.add(k); else S.cyOpen.delete(k);
    if (det.open && !det.querySelector('.cy-list')) renderCy(); // 펼칠 때 목록을 그림
  }));
  el.querySelectorAll('.more').forEach((b) => b.onclick = () => { const k = b.dataset.y; S.cyShowY[k] = (S.cyShowY[k] || 20) + 20; renderCy(); });
}

/* ---------- 선택 ---------- */
function select(sido, sgg, { push = true } = {}) {
  S.sel = { sido, sgg };
  S.view = S.view || null;
  S.cyShow = 20; S.cyOpen = null; S.cyShowY = {};
  // 주소창에 지역 기록(공유용). 미리보기처럼 막힌 환경에서는 조용히 건너뜀
  if (push && !window.NO_HASH) { try { const h = sido ? '#' + encodeURIComponent(sido) + (sgg ? '/' + encodeURIComponent(sgg) : '') : ''; history.replaceState(null, '', h || location.pathname + location.search); } catch (_) {} }
  // 한 부분이 실패해도 나머지는 그려지도록
  for (const fn of [renderMap, renderRank, renderHero, renderTrend, renderSupply, renderPermit, renderCy]) {
    try { const r = fn(); if (r && r.catch) r.catch((e) => console.error(fn.name, e)); } catch (e) { console.error(fn.name, e); }
  }
}
function fromHash() {
  const [a, b] = location.hash.slice(1).split('/').map((x) => decodeURIComponent(x || ''));
  if (a && S.sido[a]) return [a, b && S.sgg[a][b] ? b : null];
  return [null, null];
}

async function init() {
  try {
    const [geo, sup] = await Promise.all([getJSON('data/geo.json'), getJSON('data/supply.json').catch(() => null)]);
    S.geo = geo; S.supply = sup;
    prepGeo();
    await loadUnsold();
    try { S.pop = await getJSON('data/population.json'); } catch (_) { S.pop = null; }
  } catch (e) {
    $('#srcBadge').textContent = '데이터를 불러오지 못했습니다'; $('#srcBadge').classList.add('warn');
    console.error(e); return;
  }
  const b = $('#srcBadge');
  if (S.unsoldSrc === 'live') b.textContent = `미분양 KOSIS · ${fmtM(S.months.at(-1))} · 매일 자동 갱신`;
  else { b.textContent = `미분양 내장자료 · ${fmtM(S.months.at(-1))}`; b.classList.add('warn'); b.title = 'KOSIS 실시간 조회 실패: ' + (S.unsoldErr || ''); }

  setupAsOf();
  if (!S.pop) document.querySelector('[data-metric="pop"]').hidden = true; // 인구 자료가 아직 없으면 버튼 숨김
  bindMap();
  $('#backBtn').onclick = () => select(S.sel.sgg ? S.sel.sido : null, null);
  document.querySelectorAll('#rangeSeg button').forEach((x) => x.onclick = () => { S.range = +x.dataset.range; document.querySelectorAll('#rangeSeg button').forEach((y) => y.classList.toggle('on', y === x)); renderTrend(); });
  $('#sortSel').onchange = (e) => { S.sort = e.target.value; renderCy(); };
  window.addEventListener('hashchange', () => { const [a, c] = fromHash(); if (a !== S.sel.sido || c !== S.sel.sgg) select(a, c, { push: false }); });
  let a = null, c = null;
  try { [a, c] = fromHash(); } catch (_) {}
  select(a, c, { push: false });
}
init().catch((e) => {
  console.error(e);
  const b = $('#srcBadge'); b.textContent = '화면을 그리지 못했습니다: ' + (e.message || e); b.classList.add('warn');
});
})();
