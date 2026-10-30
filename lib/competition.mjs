function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// 경쟁률 행(주택형 × 순위 × 거주지역)을 단지 단위로 요약
export function summarizeCompetition(rows) {
  const models = new Map();
  for (const r of rows) {
    const m = String(r.MODEL_NO ?? r.HOUSE_TY ?? '?');
    const rank = String(r.SUBSCRPT_RANK_CODE ?? r.SUBSCRPT_RANK ?? '').replace(/[^0-9]/g, '');
    const o = models.get(m) || { ty: r.HOUSE_TY || m, supply: 0, r1: 0, r2: 0 };
    o.supply = Math.max(o.supply, num(r.SUPLY_HSHLDCO) || 0);
    const req = num(r.REQ_CNT) || 0;
    if (rank === '1') o.r1 += req; else if (rank === '2') o.r2 += req;
    models.set(m, o);
  }
  if (!models.size) return null;
  let supply = 0, r1 = 0, r2 = 0, max = 0, maxTy = '', short = 0, shortUnits = 0;
  for (const o of models.values()) {
    supply += o.supply; r1 += o.r1; r2 += o.r2;
    if (o.supply > 0) {
      const rate = o.r1 / o.supply;
      if (rate > max) { max = rate; maxTy = o.ty; }
      if (o.r1 + o.r2 < o.supply) { short++; shortUnits += o.supply - o.r1 - o.r2; } // 1·2순위 접수가 공급보다 적은 만큼
    }
  }
  return {
    supply, r1, r2,
    avg1: supply ? +(r1 / supply).toFixed(2) : null, // 1순위 평균 경쟁률 (일반공급 기준)
    max1: +max.toFixed(2), maxTy,
    shortModels: short, models: models.size, // 1·2순위 합쳐도 미달인 주택형 수
    shortUnits, // 청약 미달 세대(일반공급 기준)
  };
}
