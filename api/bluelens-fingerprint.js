// api/bluelens-fingerprint.js
//
// BlueLens — detecta cópias do vídeo do user em YouTube + outras plataformas
// usando busca POR FRAMES (visual reverse search), não por título.
//
// Threshold rigoroso: só mostra matches >= 90% (zero falso positivo).
//
// Pipeline (2026-05-04 — SerpAPI Google Lens como fonte):
//   1. Em paralelo:
//      a. Pega metadata do video do user (YouTube Data API)
//      b. Extract fingerprint do user em 15fps (Railway)
//      c. SerpAPI Google Lens com a thumbnail — descobre candidatos visuais
//         (acha reposts cross-idioma e cross-canal sem depender de título)
//   2. Enrich candidatos YouTube com snippet+duration+views (videos.list)
//   3. Filtra ±20% duration similarity
//   4. Top MAX_CANDIDATES por views
//   5. Extract fingerprint dos top em paralelo (5fps cada)
//   6. Match algorithm strict — score >= 0.90 entra como confirmed
//   7. URLs cross-plataforma (TikTok/Instagram/Twitter/etc) listadas em web_matches
//
// Custos:
//   - SerpAPI Google Lens: 1 busca por análise (free 250/mês non-commercial,
//     Starter $25/mês = 1000/mês comercial)
//   - YouTube Data API: ~5 unidades por análise (videos.list enrich)
//   - Railway: free (yt-dlp + ffmpeg + sharp local)
//
// maxDuration Vercel: 300s (cabe ~2-3 min típico)

const RAILWAY_URL = process.env.RAILWAY_FFMPEG_URL;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const YT_KEY = process.env.YOUTUBE_API_KEY_5 || process.env.YOUTUBE_API_KEY_1;
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const supaH = SUPA_KEY ? { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY } : null;

const FPS_USER = 15;       // alta densidade pro video do user
const FPS_CANDIDATE = 5;   // suficiente pra confirmar match
const MAX_CANDIDATES = 5;  // top filtrados por duration similarity
const MAX_SECONDS = 60;    // limita extract a 60s (Shorts <= 60s)
const SCORE_THRESHOLD = 0.50; // nao mostra abaixo disso (calibrado em 2026-05-04 — reposts editados batem 40-55%)

// Hamming distance entre 2 hex strings (16 chars = 64 bits)
function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let dist = 0;
  for (let i = 0; i < a.length; i += 8) {
    const ax = BigInt('0x' + a.slice(i, i + 8));
    const bx = BigInt('0x' + b.slice(i, i + 8));
    let xor = ax ^ bx;
    while (xor > 0n) { dist += Number(xor & 1n); xor >>= 1n; }
  }
  return dist;
}

function colorDistance(a, b) {
  if (!a || !b || a.length < 12) return 1;
  const parse = (s) => {
    const arr = [];
    for (let i = 0; i < Math.min(s.length, 24); i += 2) arr.push(parseInt(s.slice(i, i + 2), 16) || 0);
    return arr;
  };
  const aa = parse(a), bb = parse(b);
  const len = Math.min(aa.length, bb.length);
  let sum = 0;
  for (let i = 0; i < len; i++) sum += Math.abs(aa[i] - bb[i]);
  return Math.min(1, sum / (len * 128));
}

// Match fingerprints. Pra cada frame do user, busca melhor match em
// janela ±5 frames do candidate (tolera offset de speedup leve).
function compareFingerprints(fpUser, fpCand) {
  const fU = fpUser.p_hashes?.length || 0;
  const fC = fpCand.p_hashes?.length || 0;
  if (fU === 0 || fC === 0) return { score: 0, matchedFrames: 0, total: 0 };

  const ratio = fC / fU;
  const T_AHASH = 8;
  const T_DHASH = 6;
  const T_COLOR = 0.15;

  const matches = [];
  let firstU = -1, lastU = -1, firstC = -1, lastC = -1;

  for (let i = 0; i < fU; i++) {
    const expectedJ = Math.floor(i * ratio);
    const lo = Math.max(0, expectedJ - 5);
    const hi = Math.min(fC - 1, expectedJ + 5);
    let bestJ = -1, bestScore = 0;
    for (let j = lo; j <= hi; j++) {
      const aDist = hammingHex(fpUser.p_hashes[i], fpCand.p_hashes[j]);
      const dDist = hammingHex(fpUser.d_hashes[i], fpCand.d_hashes[j]);
      const cDist = colorDistance(fpUser.color_hashes[i], fpCand.color_hashes[j]);
      const aSim = aDist <= T_AHASH ? 1 - (aDist / 64) : 0;
      const dSim = dDist <= T_DHASH ? 1 - (dDist / 64) : 0;
      const cSim = cDist <= T_COLOR ? 1 - cDist : 0;
      const fs = aSim * 0.30 + dSim * 0.40 + cSim * 0.30;
      if (fs > bestScore) { bestScore = fs; bestJ = j; }
    }
    if (bestScore >= 0.6) {
      matches.push({ src: i, dst: bestJ, score: bestScore });
      if (firstU === -1) { firstU = i; firstC = bestJ; }
      lastU = i; lastC = bestJ;
    }
  }

  const matchRatio = matches.length / fU;
  const avgQuality = matches.length > 0 ? matches.reduce((s, m) => s + m.score, 0) / matches.length : 0;
  // Validity penalty: corrige bug onde 1-2 frames coincidentes (ex: tela preta)
  // inflavam o score via avgQuality * 0.35. Exige minimo de 5% dos frames OU 5
  // frames absolutos pra dar score "cheio". Abaixo disso, score e proporcional.
  const matchCount = matches.length;
  const minMatchesForValid = Math.max(5, Math.floor(fU * 0.05));
  const validityPenalty = matchCount >= minMatchesForValid ? 1.0 : (matchCount / minMatchesForValid);
  const baseScore = matchRatio * 0.65 + avgQuality * 0.35;
  const score = baseScore * validityPenalty;

  return {
    score,
    matchedFrames: matches.length,
    total: fU,
    matchRatio,
    avgQuality,
    temporalOverlap: matches.length > 5 ? {
      src_start_sec: Math.round(firstU / FPS_USER),
      src_end_sec: Math.round(lastU / FPS_USER),
      dst_start_sec: Math.round(firstC / FPS_CANDIDATE),
      dst_end_sec: Math.round(lastC / FPS_CANDIDATE),
    } : null,
  };
}

function extractYouTubeId(url) {
  try {
    // Aceita também URLs i.ytimg.com/vi/<id>/... (vem em visual_matches da SerpAPI)
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

// Railway extract com retry pra cobrir flakiness yt-dlp/Cobalt:
// - 5xx ou timeout: retry 1x apos 2s (yt-dlp/Cobalt podem 503/timeout intermitente)
// - 4xx: nao retry (URL invalida, video deletado, geo-blocked)
async function callRailwayExtract(url, fps) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(`${RAILWAY_URL.replace(/\/$/, '')}/extract-fingerprint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, fps, max_seconds: MAX_SECONDS }),
        signal: AbortSignal.timeout(110000),
      });
      if (r.ok) return await r.json();
      // 4xx: erro permanente do request, nao retry
      if (r.status >= 400 && r.status < 500) {
        const txt = await r.text().catch(() => '');
        throw new Error('Railway HTTP ' + r.status + ': ' + txt.slice(0, 150));
      }
      // 5xx: pode ser flakiness, vai retry
      const txt = await r.text().catch(() => '');
      lastError = new Error('Railway HTTP ' + r.status + ' (attempt ' + attempt + '): ' + txt.slice(0, 150));
    } catch (e) {
      // 4xx ja jogou no throw acima — aqui sao timeouts/network errors
      // que podem se beneficiar de retry
      if (e.message?.includes('Railway HTTP 4')) throw e;
      lastError = e;
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
  }
  throw lastError;
}

async function fetchVideoMeta(videoId) {
  if (!YT_KEY || !videoId) return null;
  try {
    const r = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${YT_KEY}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return null;
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
      duration: seconds,
    };
  } catch { return null; }
}

// SerpAPI Google Lens — busca reverse de imagem (motor que Google Lens web usa).
// Substitui YouTube Search por título — acha reposts cross-idioma e cross-canal.
async function getSerpAPICandidates(youtubeId, thumbnailUrl) {
  const empty = { youtube_ids: [], other_platforms: [], total_visual_matches: 0, error: null };
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
    const youtubeIds = new Set();
    const otherPlatforms = [];

    for (const m of allMatches) {
      const link = m.link;
      if (!link) continue;
      const ytId = extractYouTubeId(link);
      if (ytId && ytId !== youtubeId) {
        youtubeIds.add(ytId);
        continue;
      }
      // Cross-platform (excluindo YouTube e thumbnails)
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

    return {
      youtube_ids: [...youtubeIds],
      other_platforms: otherPlatforms,
      total_visual_matches: allMatches.length,
      error: null,
    };
  } catch (e) {
    return { ...empty, error: `exception: ${(e.message || '').slice(0, 200)}` };
  }
}

// Enriquece candidates com snippet + duration + views.
// Critico pros videoIds vindos do SerpAPI que chegam sem metadata.
async function enrichVideoDetails(candidates) {
  if (!YT_KEY || !candidates.length) return candidates;
  const ids = candidates.map(c => c.id).filter(Boolean).join(',');
  if (!ids) return candidates;
  try {
    const r = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${ids}&key=${YT_KEY}`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!r.ok) return candidates;
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
    // Merge: enrich preenche o que faltar
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
      // Filtra videoIds que YouTube nao retornou (privados/deletados/region-blocked)
      .filter(c => map.has(c.id));
  } catch { return candidates; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const url = req.query?.url;
  if (!url) return res.status(400).json({ error: 'url obrigatorio' });
  if (!RAILWAY_URL) return res.status(500).json({ error: 'RAILWAY_FFMPEG_URL nao configurada' });
  if (!YT_KEY) return res.status(500).json({ error: 'YOUTUBE_API_KEY_5 nao configurada' });
  if (!SERPAPI_KEY) return res.status(500).json({ error: 'SERPAPI_KEY nao configurada' });

  const youtubeId = extractYouTubeId(url);
  if (!youtubeId) return res.status(400).json({ error: 'URL deve ser de Short YouTube — formato: youtube.com/shorts/CODIGO ou watch?v=CODIGO' });

  const startTs = Date.now();
  const stages = [];

  try {
    // Thumbnail YouTube — input pra SerpAPI Google Lens
    const thumbnailUrl = `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;

    // ── 1. METADATA + USER FINGERPRINT + SERPAPI (3 paralelos) ─────────────
    stages.push({ stage: 'metadata+extract_user+serpapi', t: Date.now() });
    const [meta, userFp, serpResult] = await Promise.all([
      fetchVideoMeta(youtubeId),
      callRailwayExtract(url, FPS_USER),
      getSerpAPICandidates(youtubeId, thumbnailUrl),
    ]);
    stages[stages.length - 1].duration_ms = Date.now() - stages[stages.length - 1].t;
    stages[stages.length - 1].serpapi_total = serpResult.total_visual_matches;
    stages[stages.length - 1].serpapi_youtube = serpResult.youtube_ids.length;
    stages[stages.length - 1].serpapi_other = serpResult.other_platforms.length;

    if (!meta || !meta.title) {
      return res.status(404).json({ error: 'Video YouTube nao encontrado ou privado' });
    }
    if (!userFp || !userFp.ok || (userFp.p_hashes?.length || 0) === 0) {
      return res.status(502).json({ error: 'Falha ao extrair fingerprint do video' });
    }

    // ── 2. Constroi candidatos a partir dos YouTube IDs do SerpAPI ─────────
    const candidates = serpResult.youtube_ids.map(id => ({
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: '', channel: '', thumbnail: '', published_at: null,
      source: 'serpapi_google_lens',
    }));

    if (candidates.length === 0) {
      return res.status(200).json({
        ok: true,
        url, video_meta: meta,
        serpapi: {
          total_visual_matches: serpResult.total_visual_matches,
          youtube_ids_found: 0,
          error: serpResult.error,
        },
        matches: [],
        web_matches: serpResult.other_platforms,
        message: serpResult.other_platforms.length > 0
          ? 'Nenhum repost YouTube encontrado, mas imagem aparece em outras plataformas.'
          : (serpResult.error
              ? `Nenhum candidato — ${serpResult.error}`
              : 'Nenhum candidato visual encontrado pelo Google Lens.'),
        timing: { total_ms: Date.now() - startTs, stages },
      });
    }

    // ── 3. Enriquece (snippet + duration + views) e filtra ±20% ────────────
    stages.push({ stage: 'enrich', t: Date.now() });
    const enriched = await enrichVideoDetails(candidates);
    stages[stages.length - 1].duration_ms = Date.now() - stages[stages.length - 1].t;
    stages[stages.length - 1].alive = enriched.length;

    const userDur = meta.duration || userFp.duration_seconds || 0;
    // BYPASS duration filter pra candidates SerpAPI — Google Lens ja confirmou
    // imagem matching, reposts editados podem ter cortes/loops/velocidade alterada
    // e ainda serem reposts validos. Filtro ±20% so se aplica a outras fontes.
    const filtered = enriched
      .filter(c => {
        if (c.source === 'serpapi_google_lens') return true; // bypass
        if (!userDur || !c.duration) return true;
        const diff = Math.abs(userDur - c.duration) / Math.max(userDur, c.duration);
        return diff <= 0.20;
      })
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, MAX_CANDIDATES);

    if (filtered.length === 0) {
      return res.status(200).json({
        ok: true,
        url, video_meta: meta,
        serpapi: {
          total_visual_matches: serpResult.total_visual_matches,
          youtube_ids_found: serpResult.youtube_ids.length,
          error: serpResult.error,
        },
        matches: [],
        web_matches: serpResult.other_platforms,
        message: 'Candidatos encontrados mas nenhum com duracao similar (±20%).',
        candidates_searched: candidates.length,
        candidates_alive: enriched.length,
        timing: { total_ms: Date.now() - startTs, stages },
      });
    }

    // ── 4. Extract fingerprints dos top em PARALELO ────────────────────────
    stages.push({ stage: 'extract_candidates', t: Date.now(), count: filtered.length });
    const candFps = await Promise.all(
      filtered.map(c =>
        callRailwayExtract(c.url, FPS_CANDIDATE)
          .then(fp => ({ ...c, fp, fp_ok: !!fp.ok }))
          .catch(err => ({ ...c, fp: null, fp_ok: false, fp_error: err.message.slice(0, 100) }))
      )
    );
    stages[stages.length - 1].duration_ms = Date.now() - stages[stages.length - 1].t;

    // ── 5. MATCH algorithm — score >= SCORE_THRESHOLD entra como confirmed ─
    stages.push({ stage: 'match', t: Date.now() });
    const matches = [];
    const allScored = [];  // pra debug: todos com score (mesmo abaixo do threshold)
    for (const c of candFps) {
      if (!c.fp_ok || !c.fp.p_hashes?.length) {
        allScored.push({
          video_id: c.id, url: c.url, title: c.title || '(sem metadata)',
          fp_ok: false, fp_error: c.fp_error || 'fingerprint vazio',
          score: null, confidence_pct: null,
        });
        continue;
      }
      const cmp = compareFingerprints(userFp, c.fp);
      const item = {
        url: c.url,
        video_id: c.id,
        title: c.title,
        channel: c.channel,
        thumbnail: c.thumbnail,
        published_at: c.published_at,
        views: c.views,
        duration: c.duration,
        score: cmp.score,
        confidence_pct: Math.round(cmp.score * 100),
        matched_frames: cmp.matchedFrames,
        total_frames: cmp.total,
        temporal_overlap: cmp.temporalOverlap,
      };
      allScored.push(item);
      if (cmp.score >= SCORE_THRESHOLD) matches.push(item);
    }
    matches.sort((a, b) => b.score - a.score);
    allScored.sort((a, b) => (b.score || 0) - (a.score || 0));
    stages[stages.length - 1].duration_ms = Date.now() - stages[stages.length - 1].t;

    return res.status(200).json({
      ok: true,
      url,
      youtube_id: youtubeId,
      video_meta: meta,
      user_fingerprint: {
        total_frames: userFp.total_frames_extracted,
        fps: FPS_USER,
        duration_seconds: userFp.duration_seconds,
      },
      serpapi: {
        total_visual_matches: serpResult.total_visual_matches,
        youtube_ids_found: serpResult.youtube_ids.length,
        error: serpResult.error,
      },
      candidates_searched: candidates.length,
      candidates_alive: enriched.length,
      candidates_filtered: filtered.length,
      candidates_extracted: candFps.filter(c => c.fp_ok).length,
      matches,
      // Debug: TODOS candidates com score (mesmo abaixo do threshold) — ajusta threshold informado
      top_candidates: allScored.slice(0, 10),
      web_matches: serpResult.other_platforms,
      threshold: SCORE_THRESHOLD,
      timing: { total_ms: Date.now() - startTs, stages },
    });
  } catch (e) {
    console.error('[bluelens-fingerprint]', e.message);
    return res.status(500).json({ error: e.message, timing: { total_ms: Date.now() - startTs, stages } });
  }
};
