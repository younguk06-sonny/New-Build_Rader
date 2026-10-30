// KOSIS 통계표 설정. 서버 함수는 여기 등록된 표만 조회합니다(아무 표나 대신 호출하지 않도록).
// 통계표 ID는 KOSIS 통계표 주소의 tblId= 값입니다. 예) https://kosis.kr/statHtml/statHtml.do?orgId=116&tblId=DT_MLTM_2082
export const KOSIS_SOURCES = {
  // 시·군·구별 미분양현황 (국토교통부) — 확인된 표
  unsold: { orgId: '116', tblId: 'DT_MLTM_2082', levels: 2, label: '미분양 주택' },

  // 주택건설 인허가 실적 — '지역별 주택건설 인허가실적'(DT_MLTM_666). 지역 단위(시도/시군구)는 KOSIS에서 확인하세요.
  // 시군구별 표를 찾으면 tblId와 levels(분류 개수)만 바꾸면 됩니다.
  permit: { orgId: '116', tblId: 'DT_MLTM_666', levels: 2, label: '주택 인허가' },

  // 주택 착공 실적 — 시군구별 표의 tblId를 넣으면 화면에 자동으로 나타납니다. 비워두면 숨김.
  start: { orgId: '116', tblId: '', levels: 2, label: '주택 착공' },
};
