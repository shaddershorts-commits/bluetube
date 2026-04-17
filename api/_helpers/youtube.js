// api/_helpers/youtube.js — Rotação de chaves do YouTube Data API v3.
// Lê YOUTUBE_API_KEY, YOUTUBE_API_KEY_1..11. Ao receber 403 (cota) ou 429
// (rate limit), marca a chave como falha e tenta a próxima. Reset automático
// em 24h (quando a cota da chave reseta à meia-noite PT).

const TIMEOUT_MS = 15000;

function listKeys() {
  return Object.entries(process.env)
    .filter(([k, v]) => /^YOUTUBE_API_KEY(_\d+)?$/i.test(k) && v)
    .map(([, v]) => v);
}

const failures = new Map();       // key → { count, markedAt }
const FAIL_THRESHOLD = 1;         // 1 falha de cota já marca — cota não volta no mesmo dia
const RESET_MS = 24 * 60 * 60 * 1000;

let idx = 0;

function availableKeys() {
  const keys = listKeys();
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

function pickKey() {
  const keys = availableKeys();
  if (!keys.length) {
    // Todas falharam — limpa failures (o reset automático do Google pode já ter rolado)
    failures.clear();
    const all = listKeys();
    if (!all.length) return null;
    return all[idx++ % all.length];
  }
  const k = keys[idx % keys.length];
  idx++;
  return k;
}

function markFailed(key, reason) {
  const prev = failures.get(key) || { count: 0 };
  failures.set(key, { count: prev.count + 1, markedAt: Date.now(), reason });
  console.warn(`[youtube] chave ...${key.slice(-6)} marcada (${reason}). ${availableKeys().length} ainda OK`);
}

async function youtubeRequest(endpoint, params = {}, opts = {}) {
  const allKeys = listKeys();
  if (!allKeys.length) throw new Error('YouTube: nenhuma chave configurada');

  const maxAttempts = opts.maxAttempts || allKeys.length;
  const errors = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = pickKey();
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
        markFailed(key, `HTTP ${r.status}`);
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

  const err = new Error(`YouTube API: todas as ${allKeys.length} chaves falharam`);
  err.attempts = errors;
  throw err;
}

// Atalhos comuns
const getVideoInfo = (videoId) =>
  youtubeRequest('videos', { id: videoId, part: 'snippet,statistics,contentDetails' });

const getChannelInfo = (channelId) =>
  youtubeRequest('channels', { id: channelId, part: 'snippet,statistics,contentDetails' });

const searchVideos = (query, params = {}) =>
  youtubeRequest('search', { q: query, part: 'snippet', type: 'video', maxResults: params.maxResults || 10, ...params });

function getKeyStats() {
  const all = listKeys();
  const available = availableKeys();
  const failed = [];
  failures.forEach((f, k) => failed.push({ key: `...${k.slice(-6)}`, count: f.count, reason: f.reason, age_min: Math.round((Date.now() - f.markedAt) / 60000) }));
  return { total: all.length, available: available.length, failed };
}

module.exports = { youtubeRequest, getVideoInfo, getChannelInfo, searchVideos, getKeyStats };
