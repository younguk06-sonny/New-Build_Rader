// KOSIS 통계표 설정 (scripts/fetch-data.mjs가 사용)
// 통계표 ID는 KOSIS 통계표 주소의 tblId= 값입니다. 예) https://kosis.kr/statHtml/statHtml.do?orgId=116&tblId=DT_MLTM_2082
// prdSe(M 월·Q 분기·Y 연)와 levels(분류 단계 수)를 비워 두면 실행 때 자동으로 알아냅니다.
export const KOSIS_SOURCES = {
  // 시·군·구별 미분양현황 (국토교통부)
  unsold: { orgId: '116', tblId: 'DT_MLTM_2082', prdSe: 'M', levels: 2, label: '미분양 주택' },
};

// 공급 선행지표 (화면에 이 순서대로 표시). cumulative: 월별 누계로 공표되는 표 → 월별 값으로 바꿈
export const SUPPLY_SOURCES = {
  permit: { orgId: '116', tblId: 'DT_MLTM_1948', prdSe: 'M', label: '주택 인허가', cumulative: true },
  start:  { orgId: '116', tblId: 'DT_MLTM_5386', prdSe: 'M', label: '주택 착공' },
  sale:   { orgId: '116', tblId: 'DT_MLTM_5557', prdSe: 'M', label: '공동주택 분양' },
};

// 주민등록인구 (행정안전부) — 행정구역(시군구)별 인구수, 월별
export const POPULATION_SOURCE = { orgId: '101', tblId: 'DT_1B040A3', prdSe: 'M', label: '주민등록인구' };
