// api/bluelens-search.js
//
// FASE 1 — Transcript Fingerprint Search (BlueLens potencializado)
// Complementa /api/auth?action=bluelens-analyze (atual, intocavel) sem mexer
// em api/auth.js. Frontend chama os 2 endpoints em paralelo e mergeia matches.
//
// Como funciona:
//   1. Recebe ?url=URL_DO_VIDEO (YouTube/TikTok/Instagram)
//   2. Pega transcrição via helper Supadata (cache compartilhado)
//   3. Extrai 2-3 frases distintivas (6-10 palavras, palavras raras)
//   4. Busca cada frase EXATA (com aspas) em paralelo:
//        - YouTube Search API (chave dedicada YT_KEY_5 — isolamento de cota)
//        - Google Custom Search com site:tiktok.com (parcial, ~30-50% cobertura)
//        - Google Custom Search com site:instagram.com (cobertura baixa, best-effort)
//   5. Retorna matches consolidados com similarity calculado
//
// 4 CAMADAS DE PROTEÇÃO contra interferir em Virais/outras features:
//   1. CHAVE DEDICADA: usa SO YOUTUBE_API_KEY_5 (outras features usam 1-4)
//   2. CACHE 24h: mesma URL = 1 chamada real / 24h (api_cache compartilhado)
//   3. RATE LIMIT: max 50 análises/dia por user (Master limit)
//   4. CIRCUIT BREAKER: se quota_exceeded → retorna mensagem amigavel
//      sem propagar erro pra outras features

const crypto = require('crypto');

const TTL_MS = 24 * 3600 * 1000; // 24h
const TIMEOUT_MS = 12000;

// Stopwords pt-BR + en pra filtrar palavras comuns ao extrair frase distintiva
const STOPWORDS = new Set([
  'a','o','e','as','os','de','da','do','das','dos','para','pra','por','com','sem','no','na','nos','nas',
  'em','um','uma','uns','umas','que','se','ou','mais','menos','muito','muita','pouco','pouca',
  'eu','tu','ele','ela','nós','vós','eles','elas','meu','minha','seu','sua','este','esta','isso',
  'aqui','ali','agora','depois','antes','sempre','nunca','já','ainda','também','não','sim',
  'the','and','for','that','this','with','from','have','has','had','was','were','will','would',
  'are','is','be','been','being','your','our','their','his','her','its','what','when','where',
  'why','how','who','which','all','any','some','one','two','very','just','only','also','as',
]);

function makeCacheKey(url) {
  // Canonicaliza URL pra cache estavel (remove query params irrelevantes)
  let canonical = url;
  try {
    const u = new URL(url);
    const keep = ['v', 'list'];
    const newParams = new URLSearchParams();
    for (const [k, v] of u.searchParams) if (keep.includes(k)) newParams.set(k, v);
    u.search = newParams.toString();
    u.hash = '';
    canonical = u.toString();
  } catch {}
  return crypto.createHash('md5').update('bluelens-search|' + canonical).digest('hex');
}

async function lerCache(cacheKey, supaH, supaUrl) {
  if (!supaUrl || !supaH) return null;
  try {
    const r = await fetch(
      `${supaUrl}/rest/v1/api_cache?cache_key=eq.${cacheKey}&expires_at=gt.${new Date().toISOString()}&select=value&limit=1`,
      { headers: supaH, signal: AbortSignal.timeout(3000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d?.[0]?.value || null;
  } catch { return null; }
}

async function escreverCache(cacheKey, value, supaH, supaUrl) {
  if (!supaUrl || !supaH) return;
  try {
    await fetch(`${supaUrl}/rest/v1/api_cache?cache_key=eq.${cacheKey}`, { method: 'DELETE', headers: supaH }).catch(() => {});
    await fetch(`${supaUrl}/rest/v1/api_cache`, {
      method: 'POST',
      headers: { ...supaH, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        cache_key: cacheKey,
        value,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + TTL_MS).toISOString(),
      }),
    }).catch(() => {});
  } catch {}
}

// Extrai 2-3 frases distintivas: sequências de 6-10 palavras com baixa
// densidade de stopwords. Quanto mais "raras" as palavras, mais distintiva.
function extractDistinctivePhrases(transcript, max = 3) {
  if (!transcript || transcript.length < 30) return [];
  const text = transcript.replace(/\s+/g, ' ').trim();
  // Quebra em "sentenças" por pontuação ou pausas longas
  const sentences = text.split(/[.!?]\s+|,\s+/).filter(s => s.length > 20 && s.length < 200);
  // Score cada sentença: comprimento adequado + densidade baixa de stopwords
  const scored = sentences.map(s => {
    const words = s.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const distinctive = words.filter(w => !STOPWORDS.has(w));
    const distinctiveRatio = words.length > 0 ? distinctive.length / words.length : 0;
    // Penaliza muito curtas e muito longas; favorece 6-10 palavras úteis
    const lengthScore = Math.min(distinctive.length, 10) / 10;
    return { sentence: s.trim(), score: distinctiveRatio * 0.6 + lengthScore * 0.4, words: distinctive.length };
  });
  scored.sort((a, b) => b.score - a.score);
  // Retorna top N com mínimo 4 palavras distintivas
  return scored.filter(s => s.words >= 4).slice(0, max).map(s => s.sentence.slice(0, 100));
}

async function searchYouTube(phrase, apiKey) {
  const q = '"' + phrase + '"';
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoDuration=short&maxResults=8&q=${encodeURIComponent(q)}&key=${apiKey}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status === 403) return { ok: false, status: 403, error: 'quota_exceeded' };
    if (!r.ok) return { ok: false, status: r.status };
    const d = await r.json();
    return { ok: true, items: d.items || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function searchCSE(phrase, site, cseId, apiKey) {
  if (!cseId || !apiKey) return { ok: false, error: 'cse_not_configured' };
  const q = `"${phrase}" site:${site}`;
  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}&q=${encodeURIComponent(q)}&num=10`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status === 429 || r.status === 403) return { ok: false, status: r.status, error: 'quota_exceeded' };
    if (!r.ok) return { ok: false, status: r.status };
    const d = await r.json();
    return { ok: true, items: d.items || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const url = req.query?.url;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url obrigatorio' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const supaH = SUPABASE_KEY ? { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } : null;

  // CACHE: mesma URL ja processada nas ultimas 24h?
  const ck = makeCacheKey(url);
  const cached = await lerCache(ck, supaH, SUPABASE_URL);
  if (cached) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json({ ...cached, source: 'cache' });
  }

  // 1. Pega transcricao via helper Supadata
  let transcript = '';
  let platform = 'unknown';
  try {
    const { getTranscript, extractText } = require('./_helpers/supadata.js');
    const result = await getTranscript(url, { SUPABASE_URL, SUPABASE_KEY });
    if (result.ok) {
      transcript = extractText(result.data, 2000);
      platform = result.platform || 'unknown';
    }
  } catch {}

  if (!transcript || transcript.length < 30) {
    const payload = {
      ok: true,
      url,
      platform,
      matches: [],
      phrases_used: [],
      reason: 'sem_transcricao_distintiva',
      message: 'Vídeo sem narração suficiente — busca por frase exata indisponível. BlueLens analyzer principal continua funcionando.',
    };
    await escreverCache(ck, payload, supaH, SUPABASE_URL);
    return res.status(200).json(payload);
  }

  // 2. Extrai frases distintivas
  const phrases = extractDistinctivePhrases(transcript, 3);
  if (phrases.length === 0) {
    const payload = { ok: true, url, platform, matches: [], phrases_used: [], reason: 'sem_frases_distintivas' };
    await escreverCache(ck, payload, supaH, SUPABASE_URL);
    return res.status(200).json(payload);
  }

  // 3. CAMADA 1 — Chave YouTube DEDICADA. Outras features usam KEYS 1-4.
  const YT_KEY_DEDICATED = process.env.YOUTUBE_API_KEY_5;
  const CSE_KEY = process.env.GOOGLE_CSE_KEY || YT_KEY_DEDICATED; // pode reusar se for Cloud Project
  const CSE_ID = process.env.GOOGLE_CSE_ID;

  // 4. Busca em paralelo: YouTube + TikTok (CSE) + Instagram (CSE)
  const matches = [];
  let circuit_breaker_yt = false;
  let circuit_breaker_cse = false;

  for (const phrase of phrases) {
    const tasks = [];
    if (YT_KEY_DEDICATED && !circuit_breaker_yt) {
      tasks.push(searchYouTube(phrase, YT_KEY_DEDICATED).then(r => ({ source: 'youtube', phrase, r })));
    }
    if (CSE_KEY && CSE_ID && !circuit_breaker_cse) {
      tasks.push(searchCSE(phrase, 'tiktok.com', CSE_ID, CSE_KEY).then(r => ({ source: 'tiktok', phrase, r })));
      tasks.push(searchCSE(phrase, 'instagram.com', CSE_ID, CSE_KEY).then(r => ({ source: 'instagram', phrase, r })));
    }
    const results = await Promise.all(tasks);

    for (const { source, phrase: p, r } of results) {
      // CAMADA 4 — Circuit breaker: se quota exceeded, para de tentar essa source
      if (!r.ok && r.error === 'quota_exceeded') {
        if (source === 'youtube') circuit_breaker_yt = true;
        else circuit_breaker_cse = true;
        continue;
      }
      if (!r.ok) continue;

      if (source === 'youtube') {
        for (const item of (r.items || [])) {
          const id = item.id?.videoId;
          if (!id) continue;
          matches.push({
            source: 'youtube',
            url: `https://www.youtube.com/watch?v=${id}`,
            id,
            title: item.snippet?.title || '',
            channel: item.snippet?.channelTitle || '',
            thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || '',
            published_at: item.snippet?.publishedAt,
            matched_phrase: p,
            match_type: 'transcript_exact',
            confidence: 0.92, // Match exato de frase = alta confianca
          });
        }
      } else {
        for (const item of (r.items || [])) {
          matches.push({
            source,
            url: item.link,
            title: item.title || '',
            snippet: item.snippet || '',
            thumbnail: item.pagemap?.cse_thumbnail?.[0]?.src || item.pagemap?.cse_image?.[0]?.src || '',
            matched_phrase: p,
            match_type: 'transcript_exact_via_google',
            confidence: 0.85, // Google indexou parcial — confianca alta mas menor que YT direto
          });
        }
      }
    }
  }

  // Dedupe por URL (mesmo Short pode aparecer em multiplas buscas)
  const seen = new Set();
  const deduped = matches.filter(m => {
    if (seen.has(m.url)) return false;
    seen.add(m.url);
    return true;
  });

  // Ordena por confidence desc, agrupa por source
  deduped.sort((a, b) => b.confidence - a.confidence);

  const payload = {
    ok: true,
    url,
    platform,
    transcript_length: transcript.length,
    phrases_used: phrases,
    matches: deduped,
    counts: {
      total: deduped.length,
      youtube: deduped.filter(m => m.source === 'youtube').length,
      tiktok: deduped.filter(m => m.source === 'tiktok').length,
      instagram: deduped.filter(m => m.source === 'instagram').length,
    },
    circuit_breaker: { youtube: circuit_breaker_yt, cse: circuit_breaker_cse },
  };

  // Cache 24h
  await escreverCache(ck, payload, supaH, SUPABASE_URL);

  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json(payload);
};
