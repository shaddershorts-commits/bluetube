// api/_helpers/supadata.js
// Helper compartilhado pra transcricao via Supadata com:
//   - cache no Supabase (api_cache, mesma key MD5 que transcript.js usa, TTL 30d)
//   - fallback de chave (SUPADATA_API_KEY → SUPADATA_API_KEY_FALLBACK)
//
// Usado por features que precisam transcricao de YouTube Short. Retorna
// { ok, source, data } ou { ok:false, error }. Caller decide o que fazer
// se retornar !ok (geralmente cair pro fallback timedtext).

const crypto = require('crypto');

const TRANSCRIPT_BASE = 'https://api.supadata.ai/v1/transcript';
const TTL_MS = 30 * 24 * 3600 * 1000; // 30 dias
const TIMEOUT_MS = 25000;

// Detecta plataforma e retorna URL canonica + cache key estavel.
// YouTube mantem formato antigo (md5('transcript|' + videoId)) pra
// nao invalidar cache existente. TikTok/Instagram usam URL canonica.
function buildCacheInputs(videoIdOrUrl) {
  const input = String(videoIdOrUrl || '').trim();
  if (!input) return null;
  const isUrl = /^https?:\/\//i.test(input);
  if (!isUrl) {
    // Compat: input curto = videoId YouTube (pre-multiplatform)
    return {
      url: 'https://www.youtube.com/watch?v=' + input,
      cacheKey: crypto.createHash('md5').update('transcript|' + input).digest('hex'),
      platform: 'youtube',
    };
  }
  // URL completa — detecta plataforma e canonicaliza
  let platform = 'unknown';
  let canonical = input;
  try {
    const u = new URL(input);
    const host = u.hostname.replace(/^www\./, '');
    if (/youtube\.com|youtu\.be/i.test(host)) {
      platform = 'youtube';
      // YouTube: extrai videoId pra manter compat de cache
      const m = input.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/);
      if (m) {
        return {
          url: 'https://www.youtube.com/watch?v=' + m[1],
          cacheKey: crypto.createHash('md5').update('transcript|' + m[1]).digest('hex'),
          platform: 'youtube',
        };
      }
    } else if (/tiktok\.com/i.test(host)) {
      platform = 'tiktok';
    } else if (/instagram\.com/i.test(host)) {
      platform = 'instagram';
    } else if (/twitter\.com|x\.com/i.test(host)) {
      platform = 'x';
    }
    // Canonicaliza: remove query params irrelevantes (utm_*, si=, t=, etc)
    const keep = ['v', 'list']; // YouTube params relevantes
    const newParams = new URLSearchParams();
    for (const [k, val] of u.searchParams) {
      if (keep.includes(k)) newParams.set(k, val);
    }
    u.search = newParams.toString();
    u.hash = '';
    canonical = u.toString();
  } catch (_) {}
  return {
    url: canonical,
    cacheKey: crypto.createHash('md5').update('transcript|url|' + canonical).digest('hex'),
    platform,
  };
}

async function lerCache(cacheKey, { SUPABASE_URL, SUPABASE_KEY }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const ck = cacheKey;
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/api_cache?cache_key=eq.${ck}&expires_at=gt.${new Date().toISOString()}&select=value&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }, signal: AbortSignal.timeout(3000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d?.[0]?.value || null;
  } catch (e) { return null; }
}

async function escreverCache(cacheKey, value, { SUPABASE_URL, SUPABASE_KEY }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const ck = cacheKey;
    // Delete antigo + insert novo (mesma estrategia que transcript.js usa)
    await fetch(`${SUPABASE_URL}/rest/v1/api_cache?cache_key=eq.${ck}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
    }).catch(() => {});
    await fetch(`${SUPABASE_URL}/rest/v1/api_cache`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        cache_key: ck,
        value,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + TTL_MS).toISOString(),
      }),
    }).catch(() => {});
  } catch (e) {}
}

async function chamarSupadata(targetUrl, key) {
  const url = `${TRANSCRIPT_BASE}?url=${encodeURIComponent(targetUrl)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { 'x-api-key': key }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, data: await r.json() };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.message };
  }
}

/**
 * Retorna { ok: true, source: 'cache'|'supadata_primary'|'supadata_fallback', data, platform }
 * ou { ok: false, error }
 *
 * @param {string} videoIdOrUrl — id YouTube curto OU URL completa de qualquer plataforma
 *                                (YouTube, TikTok, Instagram, X/Twitter — Supadata aceita)
 * @param {object} opts — { SUPABASE_URL, SUPABASE_KEY } (default: env vars)
 */
async function getTranscript(videoIdOrUrl, opts = {}) {
  const SUPABASE_URL = opts.SUPABASE_URL || process.env.SUPABASE_URL;
  const SUPABASE_KEY = opts.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

  const inputs = buildCacheInputs(videoIdOrUrl);
  if (!inputs) return { ok: false, error: 'input_invalido' };

  // 1. Cache check (key estavel — compartilhado com transcript.js pra YouTube)
  const cached = await lerCache(inputs.cacheKey, { SUPABASE_URL, SUPABASE_KEY });
  if (cached) return { ok: true, source: 'cache', data: cached, platform: inputs.platform };

  // 2. Tenta chaves Supadata em sequencia (primaria → fallback)
  const keys = [
    process.env.SUPADATA_API_KEY,
    process.env.SUPADATA_API_KEY_FALLBACK,
  ].filter(Boolean);

  if (!keys.length) return { ok: false, error: 'no_supadata_keys' };

  for (let i = 0; i < keys.length; i++) {
    const result = await chamarSupadata(inputs.url, keys[i]);
    if (result.ok) {
      // Cache write fire-and-forget (nao bloqueia retorno)
      escreverCache(inputs.cacheKey, result.data, { SUPABASE_URL, SUPABASE_KEY }).catch(() => {});
      return {
        ok: true,
        source: i === 0 ? 'supadata_primary' : 'supadata_fallback',
        data: result.data,
        platform: inputs.platform,
      };
    }
    // Erro: tenta proxima chave (fallback)
  }

  return { ok: false, error: 'all_keys_failed', platform: inputs.platform };
}

/**
 * Extrai texto da resposta Supadata.
 * Formato: { content: [{text}, ...] } ou { content: 'string' }
 */
function extractText(data, maxLen = 800) {
  if (!data || !data.content) return '';
  const t = Array.isArray(data.content)
    ? data.content.map(s => s.text || '').join(' ')
    : String(data.content);
  return t.trim().slice(0, maxLen);
}

module.exports = { getTranscript, extractText };
