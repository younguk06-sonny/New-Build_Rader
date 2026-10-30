// Cloudflare Pages는 요청마다 env를 넘겨주므로 setEnv로 받아 둡니다.
let ENV = null;
export function setEnv(e) { ENV = e || null; }
export function env(name) {
  if (ENV && ENV[name] != null) return ENV[name];
  if (typeof process !== 'undefined' && process.env) return process.env[name];
  return undefined;
}

// 브라우저는 10분, CDN(Cloudflare 캐시)은 cdnSeconds 동안 보관 — 공공 API 호출 횟수 절약
export function json(body, status = 200, cdnSeconds = 43200) {
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (status === 200) {
    headers['cache-control'] = 'public, max-age=600';
    headers['cdn-cache-control'] = `public, s-maxage=${cdnSeconds}`;
  } else {
    headers['cache-control'] = 'no-store';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export async function getJSON(url, { timeoutMs = 8000, tries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      try { return JSON.parse(text); }
      catch { throw new Error(`JSON 아님: ${text.slice(0, 200)}`); }
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

// 동시에 n개씩만 호출
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { __error: String(e.message || e) }; }
    }
  }));
  return out;
}
