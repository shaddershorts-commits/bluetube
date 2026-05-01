// api/_helpers/youtube.js — Rotação de chaves do YouTube Data API v3.
//
// POOLS DE CHAVES:
//   'virais' (default): YOUTUBE_API_KEY, YOUTUBE_API_KEY_1..11 (12 chaves)
//   'secretos':         YOUTUBE_API_KEY_SECRETOS_1..3 (3 chaves) — exclusivas Nichos Secretos
//   'virais-fallback':  virais primeiro; se TODAS falharem, cai pra secretos
//
// Regex usado pra cada pool:
//   virais:    ^YOUTUBE_API_KEY(_\d+)?$  (NAO matches _SECRETOS_*)
//   secretos:  ^YOUTUBE_API_KEY_SECRETOS_\d+$
//
// Ao receber 403 (cota) ou 429 (rate limit), marca chave como falha e
// tenta proxima. Reset automatico em 24h (cota Google reseta meia-noite PT).

const TIMEOUT_MS = 15000;

function listKeysForPool(pool = 'virais') {
  const allEnv = Object.entries(process.env);
  if (pool === 'virais') {
    return allEnv.filter(([k, v]) => /^YOUTUBE_API_KEY(_\d+)?$/i.test(k) && v).map(([, v]) => v);
  }
  if (pool === 'secretos') {
    return allEnv.filter(([k, v]) => /^YOUTUBE_API_KEY_SECRETOS_\d+$/i.test(k) && v).map(([, v]) => v);
  }
  if (pool === 'virais-fallback') {
    // virais primeiro, secretos depois (fallback se todas as virais falharem)
    const virais = allEnv.filter(([k, v]) => /^YOUTUBE_API_KEY(_\d+)?$/i.test(k) && v).map(([, v]) => v);
    const secretos = allEnv.filter(([k, v]) => /^YOUTUBE_API_KEY_SECRETOS_\d+$/i.test(k) && v).map(([, v]) => v);
    return [...virais, ...secretos];
  }
  return [];
}

// Compat com codigo antigo que chamava listKeys() sem args
function listKeys() {
  return listKeysForPool('virais');
}

const failures = new Map();       // key → { count, markedAt }
const FAIL_THRESHOLD = 1;         // 1 falha de cota já marca — cota não volta no mesmo dia
const RESET_MS = 24 * 60 * 60 * 1000;

const idxByPool = { virais: 0, secretos: 0, 'virais-fallback': 0 };

function availableKeysForPool(pool) {
  const keys = listKeysForPool(pool);
  const now = Date.now();
  return keys.filter((k) => {
    const f = failures.get(k);
    if (!f) return true;
    if (now - f.markedAt > RESET_MS) {
      failures.delete(k);
      return true;
    }
    return f.count < FAIL_THRESHOLD;
  });
}

function pickKey(pool = 'virais') {
  const keys = availableKeysForPool(pool);
  if (!keys.length) {
    // Todas falharam — limpa failures (reset automatico do Google pode ja ter rolado)
    listKeysForPool(pool).forEach(k => failures.delete(k));
    const all = listKeysForPool(pool);
    if (!all.length) return null;
    return all[(idxByPool[pool] = (idxByPool[pool] || 0) + 1) % all.length];
  }
  const i = idxByPool[pool] || 0;
  const k = keys[i % keys.length];
  idxByPool[pool] = i + 1;
  return k;
}

function markFailed(key, reason, pool = 'virais') {
  const prev = failures.get(key) || { count: 0 };
  failures.set(key, { count: prev.count + 1, markedAt: Date.now(), reason });
  console.warn(`[youtube:${pool}] chave ...${key.slice(-6)} marcada (${reason}). ${availableKeysForPool(pool).length} ainda OK`);
}

async function youtubeRequest(endpoint, params = {}, opts = {}) {
  const pool = opts.pool || 'virais';
  const allKeys = listKeysForPool(pool);
  if (!allKeys.length) {
    throw new Error(`YouTube: nenhuma chave configurada no pool '${pool}'`);
  }

  const maxAttempts = opts.maxAttempts || allKeys.length;
  const errors = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = pickKey(pool);
    if (!key) break;

    const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
    url.searchParams.set('key', key);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url.toString(), { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.status === 403 || r.status === 429) {
        markFailed(key, `HTTP ${r.status}`, pool);
        errors.push({ key: `...${key.slice(-6)}`, status: r.status });
        continue;
      }
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`YouTube API ${r.status} ${body.slice(0, 200)}`);
      }
      return r.json();
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        errors.push({ key: `...${key.slice(-6)}`, error: 'timeout' });
        continue;
      }
      errors.push({ key: `...${key.slice(-6)}`, error: e.message });
      if (attempt === maxAttempts - 1) throw e;
    }
  }

  const err = new Error(`YouTube API: todas as ${allKeys.length} chaves do pool '${pool}' falharam`);
  err.attempts = errors;
  err.pool = pool;
  throw err;
}

// Atalhos comuns (pool default 'virais', compat com codigo antigo)
const getVideoInfo = (videoId) =>
  youtubeRequest('videos', { id: videoId, part: 'snippet,statistics,contentDetails' });

const getChannelInfo = (channelId) =>
  youtubeRequest('channels', { id: channelId, part: 'snippet,statistics,contentDetails' });

const searchVideos = (query, params = {}) =>
  youtubeRequest('search', { q: query, part: 'snippet', type: 'video', maxResults: params.maxResults || 10, ...params });

function getKeyStats() {
  const stats = { total: 0, by_pool: {} };
  for (const pool of ['virais', 'secretos']) {
    const all = listKeysForPool(pool);
    const available = availableKeysForPool(pool);
    const failed = [];
    failures.forEach((f, k) => {
      if (all.includes(k)) {
        failed.push({ key: `...${k.slice(-6)}`, count: f.count, reason: f.reason, age_min: Math.round((Date.now() - f.markedAt) / 60000) });
      }
    });
    stats.by_pool[pool] = { total: all.length, available: available.length, failed };
    stats.total += all.length;
  }
  return stats;
}

module.exports = { youtubeRequest, getVideoInfo, getChannelInfo, searchVideos, getKeyStats };
