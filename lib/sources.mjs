// KOSIS 통계표 설정 (scripts/fetch-data.mjs가 사용)
// 통계표 ID는 KOSIS 통계표 주소의 tblId= 값입니다. 예) https://kosis.kr/statHtml/statHtml.do?orgId=116&tblId=DT_MLTM_2082
// prdSe(M 월·Q 분기·Y 연)와 levels(분류 단계 수)를 비워 두면 처음 실행 때 자동으로 알아냅니다.
export const KOSIS_SOURCES = {
  // 시·군·구별 미분양현황 (국토교통부)
  unsold: { orgId: '116', tblId: 'DT_MLTM_2082', prdSe: 'M', levels: 2, label: '미분양 주택' },

  // 주택건설 인허가 실적 (국토교통부) — 지역 단위는 수집 후 meta.json의 permit.c1/c2로 확인
  permit: { orgId: '116', tblId: 'DT_MLTM_666', label: '주택 인허가' },
};
