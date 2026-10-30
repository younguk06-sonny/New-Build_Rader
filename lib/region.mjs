// 청약 공고 주소(HSSPLY_ADRES)를 2026.10 기준 시·도/시·군·구로 바꿉니다.
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

function cityOf(token) {
  const m = token.match(/^(.+?시)(.+구)$/); // 수원시장안구 → 수원시
  return m ? m[1] : token;
}

// 인천 2026.07 개편 전 주소(중구·동구·서구·남구)를 새 구로 옮김 (동 이름 기준 근사)
function incheonLegacy(gu, rest) {
  if (gu === '남구') return '미추홀구';
  if (gu === '동구') return '제물포구';
  if (gu === '중구') return /(운서|운남|운북|중산|을왕|남북|덕교|무의|영종|용유)/.test(rest) ? '영종구' : '제물포구';
  if (gu === '서구') return /(검단|불로|대곡|원당|당하|오류|왕길|마전|아라|금곡)/.test(rest) ? '검단구' : '서해구';
  return gu;
}

export function parseRegion(addr, areaNm) {
  const tokens = String(addr || '').replace(/[()]/g, ' ').trim().split(/\s+/).filter(Boolean);
  let sido = ALIAS_TO_SIDO[tokens[0]];
  let idx = 1;
  if (!sido) {
    sido = AREA_TO_SIDO[areaNm] || (SIDO_ALIASES[areaNm] ? areaNm : null);
    idx = 0;
  }
  if (!sido) return { sido: null, sgg: null };
  if (sido === '세종') return { sido, sgg: '세종시' };
  let tok = tokens[idx] || '';
  if (!/[시군구]$/.test(tok)) return { sido, sgg: null };
  let sgg = cityOf(tok);
  if (sido === '인천') sgg = incheonLegacy(sgg, tokens.slice(idx + 1).join(' '));
  return { sido, sgg };
}
