// KOSIS OpenAPI(통계자료) 조회 — scripts/fetch-data.mjs가 사용. 키는 KOSIS_KEY 환경변수.
import { KOSIS_SOURCES } from './sources.mjs';
import { env, json, getJSON } from './http.mjs';


export default async (req) => {
  const u = new URL(req.url);
  const name = u.searchParams.get('src') || 'unsold';
  const src = KOSIS_SOURCES[name];
  if (!src) return json({ error: 'unknown_source', message: `등록되지 않은 자료: ${name}` }, 400);
  if (!src.tblId) return json({ error: 'not_configured', message: `${src.label} 통계표 ID가 설정되지 않았습니다.` }, 404);

  const key = env('KOSIS_KEY');
  if (!key) return json({ error: 'no_key', message: 'KOSIS_KEY 환경변수가 없습니다.' }, 503);

  const n = Math.max(13, Math.min(240, parseInt(u.searchParams.get('n') || '60', 10) || 60));
  const base = env('KOSIS_BASE') || 'https://kosis.kr/openapi/Param/statisticsParameterData.do';
  const q = new URLSearchParams({
    method: 'getList', apiKey: key, format: 'json', jsonVD: 'Y',
    orgId: src.orgId, tblId: src.tblId, itmId: 'ALL', prdSe: 'M', newEstPrdCnt: String(n),
  });
  for (let i = 1; i <= (src.levels || 2); i++) q.set(`objL${i}`, 'ALL');

  try {
    const data = await getJSON(`${base}?${q}`, { timeoutMs: 9000 });
    if (!Array.isArray(data)) {
      // KOSIS 오류 형식: {err:"20", errMsg:"..."}
      return json({ error: 'kosis_error', code: data?.err, message: data?.errMsg || 'KOSIS 응답 오류' }, 502);
    }
    // [분류1, 분류2, 분류3, 항목명, 시점(YYYYMM), 값]
    const rows = data.map((r) => [
      (r.C1_NM || '').trim(), (r.C2_NM || '').trim(), (r.C3_NM || '').trim(),
      (r.ITM_NM || '').trim(), String(r.PRD_DE || ''), r.DT === '-' || r.DT === '' || r.DT == null ? null : Number(r.DT),
    ]);
    return json({ src: name, label: src.label, tblId: src.tblId, tblNm: data[0]?.TBL_NM || '', unit: data[0]?.UNIT_NM || '', rows, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return json({ error: 'fetch_failed', message: String(e.message || e) }, 502);
  }
};
