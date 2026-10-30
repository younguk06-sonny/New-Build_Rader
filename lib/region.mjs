// 청약 공고 주소(HSSPLY_ADRES)를 2026.10 기준 시·도/시·군·구로 바꿉니다.
// 실제 주소는 "광주연구개발특구 첨단3지구 A6블록(전남광주통합특별시 북구 월출동)",
// "경기도 화성특례시 동탄구 …", "인천검단시 서구 불로동 …" 처럼 제각각이라
// 괄호 안·밖을 모두 살펴보고, 실제 시·군·구 목록(valid)과 맞는 것을 고릅니다.
const SIDO_ALIASES = {
  서울: ['서울특별시', '서울시', '서울'],
  부산: ['부산광역시', '부산시', '부산'],
  대구: ['대구광역시', '대구시', '대구'],
  인천: ['인천광역시', '인천시', '인천'],
  대전: ['대전광역시', '대전시', '대전'],
  울산: ['울산광역시', '울산시', '울산'],
  세종: ['세종특별자치시', '세종시', '세종'],
  경기: ['경기도', '경기'],
  강원: ['강원특별자치도', '강원도', '강원'],
  충북: ['충청북도', '충북'],
  충남: ['충청남도', '충남'],
  전북: ['전북특별자치도', '전라북도', '전북'],
  // 2026.07 광주광역시 + 전라남도 → 전남광주통합특별시
  전남광주: ['전남광주통합특별시', '전남광주특별시', '전남광주', '광주광역시', '광주시', '광주', '전라남도', '전남'],
  경북: ['경상북도', '경북'],
  경남: ['경상남도', '경남'],
  제주: ['제주특별자치도', '제주도', '제주'],
};
const ALIAS_TO_SIDO = {};
for (const [k, list] of Object.entries(SIDO_ALIASES)) for (const a of list) ALIAS_TO_SIDO[a] = k;

// 청약홈 SUBSCRPT_AREA_CODE_NM(약칭) → 현재 시·도
const AREA_TO_SIDO = { 광주: '전남광주', 전남: '전남광주' };

// 이름으로 시·군·구를 알 수 없는 개발지구 (시·도별)
const DISTRICT_HINTS = {
  인천: [[/검단/, '검단구'], [/영종|용유|운서|하늘도시/, '영종구'], [/청라|가정|루원/, '서해구'], [/송도/, '연수구']],
  충남: [[/내포/, '홍성군']],
  경기: [[/동탄|봉담|향남/, '화성시'], [/위례/, '하남시'], [/광교/, '수원시'], [/운정/, '파주시'], [/한강신도시|풍무/, '김포시']],
  세종: [[/.*/, '세종시']],
};

function normCity(token) {
  let t = token.replace(/특례시/, '시');
  const m = t.match(/^(.+?시)(.+구)$/); // 수원시장안구 → 수원시
  return m ? m[1] : t;
}

// 인천 2026.07 개편 전 주소(중구·동구·서구·남구)를 새 구로 옮김 (동 이름 기준 근사)
function incheonLegacy(gu, rest) {
  if (gu === '남구') return '미추홀구';
  if (gu === '동구') return '제물포구';
  if (gu === '중구') return /(운서|운남|운북|중산|을왕|남북|덕교|무의|영종|용유)/.test(rest) ? '영종구' : '제물포구';
  if (gu === '서구') return /(검단|불로|대곡|원당|당하|오류|왕길|마전|아라|금곡)/.test(rest) ? '검단구' : '서해구';
  return gu;
}

function tokensOf(s) { return String(s || '').replace(/[,·]/g, ' ').trim().split(/\s+/).filter(Boolean); }

// 한 덩어리(괄호 밖 또는 괄호 안)에서 시·도와 시·군·구 후보를 찾음
function parseSegment(seg, fallbackSido, valid) {
  const t = tokensOf(seg);
  let sido = null, i0 = 0;
  for (let i = 0; i < t.length; i++) {
    if (ALIAS_TO_SIDO[t[i]]) { sido = ALIAS_TO_SIDO[t[i]]; i0 = i + 1; break; }
    // '인천검단시' 처럼 시·도 이름이 붙어 있는 경우
    const hit = Object.keys(ALIAS_TO_SIDO).find((a) => a.length >= 2 && t[i].startsWith(a) && t[i].length > a.length && !/^광주시?$/.test(t[i]));
    if (hit && i === 0) { sido = ALIAS_TO_SIDO[hit]; i0 = 1; break; }
  }
  if (!sido) { sido = fallbackSido; i0 = 0; }
  if (!sido) return { sido: null, sgg: null };
  if (sido === '세종') return { sido, sgg: '세종시' };
  const names = valid?.[sido];
  for (let i = i0; i < t.length; i++) {
    let c = normCity(t[i]);
    if (sido === '인천') c = incheonLegacy(c, t.slice(i + 1).join(' '));
    if (names ? names.has(c) : /[시군구]$/.test(c)) return { sido, sgg: c };
    if (names) {
      // '용인고림지구', '원주무실' → 이름 앞부분이 시·군 이름과 같으면 인정
      const pre = [...names].find((n) => n.length >= 3 && /[시군]$/.test(n) && t[i].startsWith(n.slice(0, -1)));
      if (pre) return { sido, sgg: pre };
    }
    if (!names) break; // 목록이 없으면 첫 토큰만 봄(이전 방식)
  }
  return { sido, sgg: null };
}

export function parseRegion(addr, areaNm, valid) {
  const s = String(addr || '');
  const fallbackSido = AREA_TO_SIDO[areaNm] || (SIDO_ALIASES[areaNm] ? areaNm : null);
  const inner = [...s.matchAll(/[(\[]([^)\]]*)[)\]]/g)].map((m) => m[1]);
  const outer = s.replace(/[(\[][^)\]]*[)\]]/g, ' ');
  // 괄호 안에 정식 주소가 있는 경우가 많아 괄호 안을 먼저 봄
  let best = { sido: null, sgg: null };
  for (const seg of [...inner, outer]) {
    const r = parseSegment(seg, fallbackSido, valid);
    if (r.sido && r.sgg) return r;
    if (r.sido && !best.sido) best = r;
  }
  if (best.sido && DISTRICT_HINTS[best.sido]) {
    for (const [re, name] of DISTRICT_HINTS[best.sido]) if (re.test(s)) return { sido: best.sido, sgg: name };
  }
  return best.sido ? best : { sido: fallbackSido, sgg: null };
}
