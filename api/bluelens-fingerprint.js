// api/bluelens-fingerprint.js — v4 (2026-06-23) — SerpAPI-only, sem Railway.
//
// MUDANÇA HISTÓRICA: removido extract-fingerprint do Railway. Razão:
//   - Problema recorrente de cookies YouTube expirando (manutenção contínua)
//   - Race conditions de webhooks afetando download
//   - Custos Vercel pra paralelizar extract de 5 candidatos
//
// Pipeline v4 (curto e estável):
//   1. PARALELO: fetchVideoMeta (YouTube Data API) + getSerpAPICandidates (Google Lens)
//   2. enrichVideoDetails (videos.list — title/duration/views dos candidatos)
//   3. Heurística pra ordenar e atribuir score "confiança aparente" (não é match pixel-real):
//      - Base 30
//      - +30 se duração ±20% do user
//      - +20 se SerpAPI rank top 3, +10 se top 10
//      - +10 se canal != user (mais provável repost)
//      - +10 se imagem aparece TAMBÉM em outras plataformas (sinal forte)
//      - Cap 95 (nunca afirma 100% sem fingerprint pixel)
//   4. Retorna top 10 candidatos YouTube + lista cross-platform (web_matches)
//
// Fallbacks:
//   - Cache hit: retorna em <500ms (Supabase bluelens_cache TTL 7d)
//   - SerpAPI down: retorna response mínima com só video_meta + mensagem clara
//   - YouTube API down: candidatos vêm sem enrich (só video_id+url)
//   - Cross-platform vazio: ainda mostra YouTube se houver
//
// Custos:
//   - SerpAPI Google Lens: 1 chamada (Starter $25/mês = 1000 análises)
//   - YouTube Data API: ~5 unidades por análise
//   - Railway: ZERO (removido)
//
// Schema response (compatível com frontend blueLens.html que já existe):
//   { ok, url, video_meta, matches:[{video_id,title,thumbnail,channel,views,duration,
//     published_at,score,confidence_pct}], web_matches:[...], serpapi:{...}, engine, cached }

// Env lido no momento do uso, não na carga do módulo (mesma lição do
// roteiro-chat): capturar no import quebra teste e depende de ordem de boot.
const cfg = () => {
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
  return {
    SUPA_URL, SUPA_KEY,
    supaH: SUPA_KEY ? { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY } : null,
    SERPAPI_KEY: process.env.SERPAPI_KEY,
  };
};

// ── ROTAÇÃO DE CHAVES YOUTUBE (2026-07-30) ──────────────────────────────────
// Antes: YT_KEY = KEY_5 || KEY_1, fixo. Em 30/07 a KEY_5 estava SUSPENSA e a
// KEY_1 nem existia — toda análise saía "metadata indisponível" e a heurística
// perdia duração e canal (os critérios que mais pesam), enquanto a KEY_3 vivia
// ociosa. Agora:
//   1º BLUELENS_YT_KEY* — chaves DEDICADAS (pedido do user: sair do balde da
//      Virais, que já viveu apagão de quota)
//   2º YOUTUBE_API_KEY* — pool compartilhado, só como fallback
// ytFetch tenta a partir da última que funcionou; 403/quota pula pra próxima.
function listYtKeys() {
  const dedicadas = [], pool = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (/^BLUELENS_YT_KEY(_\d+)?$/.test(k)) dedicadas.push(v);
    else if (/^YOUTUBE_API_KEY(_\d+)?$/.test(k)) pool.push(v);
  }
  return [...dedicadas.sort(), ...pool.sort()];
}
let _ytIdx = 0; // lembra a última chave boa (vive enquanto a função está quente)

async function ytFetch(pathAndQuery, timeoutMs) {
  const keys = listYtKeys();
  if (!keys.length) return null;
  for (let tent = 0; tent < keys.length; tent++) {
    const key = keys[(_ytIdx + tent) % keys.length];
    try {
      const r = await fetch(
        `https://www.googleapis.com/youtube/v3/${pathAndQuery}&key=${key}`,
        { signal: AbortSignal.timeout(timeoutMs || 10000) }
      );
      if (r.ok) { _ytIdx = (_ytIdx + tent) % keys.length; return r; }
      // 403 = suspensa/quota, 400 = chave inválida → tenta a próxima
      if (r.status === 403 || r.status === 400) continue;
      return r; // outros erros (404, 5xx) não são culpa da chave
    } catch { continue; }   // timeout/rede: tenta a próxima
  }
  return null;
}

const MAX_CANDIDATES = 10;        // mostra mais agora (sem custo Railway)
const CACHE_TTL_DAYS = 7;

function extractYouTubeId(url) {
  try {
    const m = url.match(/(?:shorts\/|v=|youtu\.be\/|ytimg\.com\/vi\/)([a-zA-Z0-9_-]{6,20})/);
    return m?.[1] || null;
  } catch { return null; }
}

function detectPlatform(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
    if (host === 'i.ytimg.com' || host.endsWith('.ytimg.com')) return 'youtube_thumb';
    if (host.includes('tiktok.com')) return 'tiktok';
    if (host.includes('instagram.com')) return 'instagram';
    if (host === 'twitter.com' || host === 'x.com') return 'twitter';
    if (host.includes('facebook.com') || host.includes('fbsbx.com')) return 'facebook';
    if (host.includes('kwai')) return 'kwai';
    if (host.includes('reddit.com')) return 'reddit';
    if (host.includes('pinterest.com') || host.includes('pinimg.com')) return 'pinterest';
    return 'other';
  } catch { return 'unknown'; }
}

// Cache 7d — economiza SerpAPI quota se mesma URL é re-analisada.
async function getCachedAnalysis(youtubeId) {
  const { SUPA_URL, supaH } = cfg();
  if (!supaH || !SUPA_URL) return null;
  try {
    const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 86400 * 1000).toISOString();
    const r = await fetch(
      `${SUPA_URL}/rest/v1/bluelens_cache?youtube_id=eq.${encodeURIComponent(youtubeId)}&created_at=gt.${cutoff}&select=response,hits,created_at&limit=1`,
      { headers: supaH, signal: AbortSignal.timeout(3000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.[0]?.response) return null;
    fetch(`${SUPA_URL}/rest/v1/bluelens_cache?youtube_id=eq.${encodeURIComponent(youtubeId)}`, {
      method: 'PATCH',
      headers: { ...supaH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hits: (d[0].hits || 1) + 1, last_hit_at: new Date().toISOString() }),
    }).catch(() => {});
    return { response: d[0].response, created_at: d[0].created_at };
  } catch { return null; }
}

async function saveCachedAnalysis(youtubeId, response) {
  const { SUPA_URL, supaH } = cfg();
  if (!supaH || !SUPA_URL) return { ok: false, error: 'no supabase' };
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/bluelens_cache?on_conflict=youtube_id`, {
      method: 'POST',
      headers: { ...supaH, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({
        youtube_id: youtubeId,
        response,
        matches_count: (response.matches || []).length,
        web_matches_count: (response.web_matches || []).length,
        hits: 1,
        created_at: new Date().toISOString(),
        last_hit_at: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e.message || '').slice(0, 200) };
  }
}

async function fetchVideoMeta(videoId) {
  if (!videoId) return null;
  try {
    const r = await ytFetch(`videos?part=snippet,contentDetails,statistics&id=${videoId}`, 10000);
    if (!r || !r.ok) return null;
    const d = await r.json();
    const item = d.items?.[0];
    if (!item) return null;
    const dur = item.contentDetails?.duration || '';
    const dm = dur.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
    const seconds = (parseInt(dm?.[1] || 0) * 60) + parseInt(dm?.[2] || 0);
    return {
      title: item.snippet?.title || '',
      channel: item.snippet?.channelTitle || '',
      thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || '',
      published_at: item.snippet?.publishedAt,
      views: parseInt(item.statistics?.viewCount || 0),
      duration: seconds,
    };
  } catch { return null; }
}

// SerpAPI Google Lens com a thumbnail. Retorna {youtube_ids, other_platforms, error}.
async function getSerpAPICandidates(youtubeId, thumbnailUrl) {
  const empty = { youtube_ids: [], other_platforms: [], total_visual_matches: 0, error: null };
  const { SERPAPI_KEY } = cfg();
  if (!SERPAPI_KEY) return { ...empty, error: 'SERPAPI_KEY ausente' };
  if (!thumbnailUrl) return { ...empty, error: 'thumbnail ausente' };
  try {
    const serpUrl = `https://serpapi.com/search?engine=google_lens&url=${encodeURIComponent(thumbnailUrl)}&api_key=${SERPAPI_KEY}`;
    const r = await fetch(serpUrl, { signal: AbortSignal.timeout(45000) });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ...empty, error: `SerpAPI HTTP ${r.status}: ${txt.slice(0, 200)}` };
    }
    const d = await r.json();
    if (d.error) return { ...empty, error: `SerpAPI: ${String(d.error).slice(0, 200)}` };

    const allMatches = d.visual_matches || [];
    const youtubeIds = [];          // mantém ordem do SerpAPI (rank)
    const seenIds = new Set();
    const otherPlatforms = [];

    for (const m of allMatches) {
      const link = m.link;
      if (!link) continue;
      const ytId = extractYouTubeId(link);
      if (ytId && ytId !== youtubeId && !seenIds.has(ytId)) {
        seenIds.add(ytId);
        youtubeIds.push(ytId);
        continue;
      }
      const platform = detectPlatform(link);
      if (platform !== 'youtube' && platform !== 'youtube_thumb' && platform !== 'other' && platform !== 'unknown') {
        otherPlatforms.push({
          url: link,
          title: m.title || '',
          thumbnail: m.thumbnail || '',
          source: m.source || '',
          platform,
        });
      }
    }

    return { youtube_ids: youtubeIds, other_platforms: otherPlatforms, total_visual_matches: allMatches.length, error: null };
  } catch (e) {
    return { ...empty, error: `exception: ${(e.message || '').slice(0, 200)}` };
  }
}

// Enriquece candidatos com snippet+duration+views via YouTube Data API.
async function enrichVideoDetails(candidates) {
  if (!candidates.length) return candidates;
  const ids = candidates.map(c => c.id).filter(Boolean).join(',');
  if (!ids) return candidates;
  try {
    const r = await ytFetch(`videos?part=snippet,contentDetails,statistics&id=${ids}`, 15000);
    if (!r || !r.ok) return candidates;
    const d = await r.json();
    const map = new Map();
    for (const item of (d.items || [])) {
      const dur = item.contentDetails?.duration || '';
      const dm = dur.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
      const seconds = (parseInt(dm?.[1] || 0) * 60) + parseInt(dm?.[2] || 0);
      map.set(item.id, {
        duration: seconds,
        views: parseInt(item.statistics?.viewCount || 0),
        title: item.snippet?.title || '',
        channel: item.snippet?.channelTitle || '',
        thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || '',
        published_at: item.snippet?.publishedAt,
      });
    }
    return candidates
      .map(c => {
        const e = map.get(c.id);
        if (!e) return c;
        return {
          ...c,
          duration: c.duration ?? e.duration,
          views: c.views ?? e.views,
          title: c.title || e.title,
          channel: c.channel || e.channel,
          thumbnail: c.thumbnail || e.thumbnail,
          published_at: c.published_at || e.published_at,
        };
      })
      .filter(c => map.has(c.id)); // pula videos que YouTube nao retornou (privados/deletados)
  } catch { return candidates; }
}

// Heurística pra atribuir score "confiança aparente" sem fingerprint pixel.
// NÃO é match real — é prioridade visual. Frontend usa pra ordenar/colorir.
function computeHeuristicScore(candidate, userMeta) {
  let score = 30; // base mínima
  // Duração próxima é o sinal mais forte sem fingerprint
  if (userMeta?.duration && candidate.duration) {
    const diff = Math.abs(userMeta.duration - candidate.duration) / Math.max(userMeta.duration, candidate.duration);
    if (diff <= 0.10) score += 35;
    else if (diff <= 0.20) score += 25;
    else if (diff <= 0.50) score += 10;
  }
  // Ranking SerpAPI (top resultados são mais visualmente similares pelo algoritmo do Google)
  const rank = candidate._serpRank;
  if (typeof rank === 'number') {
    if (rank < 3) score += 20;
    else if (rank < 10) score += 10;
  }
  // Canal diferente = mais provável repost (mesmo canal = mais provável outro vídeo da mesma série)
  if (userMeta?.channel && candidate.channel && userMeta.channel.toLowerCase() !== candidate.channel.toLowerCase()) {
    score += 10;
  }
  return Math.min(95, Math.max(30, score));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const url = req.query?.url;
  if (!url) return res.status(400).json({ error: 'url obrigatorio' });
  if (!cfg().SERPAPI_KEY) return res.status(500).json({ error: 'SERPAPI_KEY nao configurada' });
  // Sem chave YouTube NÃO é fatal: o safeMeta cobre (desenho v4). Antes isso
  // devolvia 500 e derrubava a feature inteira por falta do opcional.

  // ── PORTÃO FULL/MASTER (2026-07-30) ─────────────────────────────────────
  // A página sempre exigiu Full/Master, mas a API aceitava qualquer um com a
  // URL — e cada chamada queima 1 busca SerpAPI (plano de 250/mês). Sem cota
  // por usuário (decisão do user): assinante usa à vontade; só fecha a porta
  // pra quem não é cliente.
  {
    const { SUPA_URL, SUPA_KEY, supaH } = cfg();
    const AK = process.env.SUPABASE_ANON_KEY || SUPA_KEY;
    const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query?.token;
    let plano = null;
    if (token && SUPA_URL) {
      try {
        const ur = await fetch(`${SUPA_URL}/auth/v1/user`, {
          headers: { apikey: AK, Authorization: 'Bearer ' + token },
          signal: AbortSignal.timeout(5000),
        });
        if (ur.ok) {
          const u = await ur.json();
          if (u?.email) {
            const pr = await fetch(
              `${SUPA_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(u.email)}&select=plan,plan_expires_at,is_manual`,
              { headers: supaH, signal: AbortSignal.timeout(5000) }
            );
            const sub = pr.ok ? (await pr.json())[0] : null;
            if (sub && (sub.plan === 'full' || sub.plan === 'master')) {
              const vivo = sub.is_manual || !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date();
              if (vivo) plano = sub.plan;
            }
          }
        }
      } catch {}
    }
    if (!plano) {
      return res.status(403).json({
        error: 'O BlueLens é exclusivo dos planos Full e Master.',
        upgrade: true,
      });
    }
  }

  const youtubeId = extractYouTubeId(url);
  if (!youtubeId) return res.status(400).json({ error: 'URL deve ser de Short YouTube — formato: youtube.com/shorts/CODIGO ou watch?v=CODIGO' });

  const startTs = Date.now();
  const skipCache = req.query?.force === 'true';

  // ── CACHE CHECK (TTL 7d) ──────────────────────────────────────────────────
  if (!skipCache) {
    const cached = await getCachedAnalysis(youtubeId);
    if (cached?.response) {
      const cacheAgeDays = (Date.now() - new Date(cached.created_at).getTime()) / 86400000;
      return res.status(200).json({
        ...cached.response,
        cached: true,
        cache_age_days: Math.round(cacheAgeDays * 10) / 10,
        timing: { total_ms: Date.now() - startTs, source: 'cache' },
      });
    }
  }

  try {
    const thumbnailUrl = `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;

    // ── PARALELO: metadata + SerpAPI ────────────────────────────────────────
    const [meta, serpResult] = await Promise.all([
      fetchVideoMeta(youtubeId),
      getSerpAPICandidates(youtubeId, thumbnailUrl),
    ]);

    // FALLBACK: meta pode estar null se YouTube Data API tá sem quota.
    // Não bloqueia o flow — segue com metadata mínima e tenta SerpAPI mesmo assim.
    // (Cenário visto em 2026-06-23: todas YT_KEYs com quota_exceeded simultaneamente.)
    const safeMeta = meta && meta.title ? meta : {
      title: 'Vídeo do YouTube (metadata indisponível)',
      channel: '—',
      thumbnail: thumbnailUrl,
      published_at: null,
      views: 0,
      duration: 0,
      _meta_unavailable: true,
    };
    if (!meta || !meta.title) {
      console.warn(`[bluelens v4] ${youtubeId}: YouTube Data API falhou — seguindo com meta mínima (quota esgotada?)`);
    }

    // FALLBACK: SerpAPI quebrou — retorna resposta mínima com meta only,
    // sem matches mas sem erro fatal (UI mostra "tentativa falhou" graceful).
    if (serpResult.error && serpResult.youtube_ids.length === 0 && serpResult.other_platforms.length === 0) {
      const fallbackResponse = {
        ok: true,
        url,
        youtube_id: youtubeId,
        video_meta: safeMeta,
        serpapi: {
          total_visual_matches: 0,
          youtube_ids_found: 0,
          error: serpResult.error,
        },
        candidates_searched: 0,
        candidates_filtered: 0,
        matches: [],
        web_matches: [],
        engine: 'serpapi_v4_fallback_empty',
        message: 'Busca visual temporariamente indisponivel: ' + serpResult.error,
        cached: false,
        timing: { total_ms: Date.now() - startTs },
      };
      // Não cacheia erro
      return res.status(200).json(fallbackResponse);
    }

    // ── Constrói candidatos com rank preservado ─────────────────────────────
    let candidates = serpResult.youtube_ids.slice(0, MAX_CANDIDATES).map((id, idx) => ({
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: '', channel: '', thumbnail: '', published_at: null,
      _serpRank: idx,
    }));

    // ── Enrich (snippet + duration + views) ─────────────────────────────────
    candidates = await enrichVideoDetails(candidates);

    // ── Heurística score + ordenação por confidence desc ────────────────────
    const matches = candidates
      .map(c => {
        const score = computeHeuristicScore(c, safeMeta);
        return {
          url: c.url,
          video_id: c.id,
          title: c.title,
          channel: c.channel,
          thumbnail: c.thumbnail,
          published_at: c.published_at,
          views: c.views,
          duration: c.duration,
          score: score / 100,
          confidence_pct: score,
          // NÃO retorna: matched_frames, total_frames, temporal_overlap
          // (frontend ignora gracefully quando undefined)
        };
      })
      .sort((a, b) => b.confidence_pct - a.confidence_pct);

    const finalResponse = {
      ok: true,
      url,
      youtube_id: youtubeId,
      video_meta: safeMeta,
      serpapi: {
        total_visual_matches: serpResult.total_visual_matches,
        youtube_ids_found: serpResult.youtube_ids.length,
        error: serpResult.error,
      },
      candidates_searched: serpResult.youtube_ids.length,
      candidates_filtered: matches.length,
      matches,
      web_matches: serpResult.other_platforms,
      engine: 'serpapi_v4_no_fingerprint',
      cached: false,
      timing: { total_ms: Date.now() - startTs },
    };

    const saveResult = await saveCachedAnalysis(youtubeId, finalResponse);
    finalResponse.cache_saved = saveResult.ok;
    return res.status(200).json(finalResponse);
  } catch (e) {
    console.error('[bluelens-fingerprint v4]', e.message);
    return res.status(500).json({ error: e.message, timing: { total_ms: Date.now() - startTs } });
  }
};

// exportados pros testes (tests/unit/bluelens_rotacao.test.mjs)
module.exports.listYtKeys = listYtKeys;
module.exports.ytFetch = ytFetch;
module.exports.computeHeuristicScore = computeHeuristicScore;
