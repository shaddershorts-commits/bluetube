// api/bluelens-fingerprint.js
//
// BlueLens deep search: detecta cópias do vídeo do user em YouTube + outras
// plataformas. Estratégia tripla de descoberta de candidatos + validação
// rigorosa via fingerprint visual frame-by-frame.
//
// Threshold rigoroso: só mostra matches >= 90% (zero falso positivo).
//
// Pipeline (Plano A+B, 2026-05-04):
//   1. Em paralelo:
//      a. Pega metadata do video do user (YouTube Data API)
//      b. Extract fingerprint do user em 15fps (Railway)
//      c. Claude Vision: extrai keywords visuais da thumbnail (Plano A)
//      d. Cloud Vision Web Detection: acha onde a imagem aparece na web (Plano B)
//   2. YouTube Search com title + keywords (Plano A complementa)
//   3. Combina candidatos: search + IDs YouTube do Web Detection
//   4. Filtra Top 5 por duration similarity (±20%)
//   5. Extract fingerprint dos 5 em paralelo (5fps cada)
//   6. Match algorithm strict — score >= 0.90 entra como confirmed
//   7. URLs cross-plataforma (TikTok/Instagram/etc) listadas em web_matches
//      (não verificadas via fingerprint, mas Google detectou imagem matching)
//
// Custos:
//   - YouTube Data API: ~300 unidades por analise (KEY 5 dedicada)
//   - Cloud Vision Web Detection: ~$0.0015 por análise (1k/mês free)
//   - Claude Vision (Haiku): ~$0.001 por análise
//   - Railway: free (yt-dlp + ffmpeg + sharp local)
//
// maxDuration Vercel: 300s

const RAILWAY_URL = process.env.RAILWAY_FFMPEG_URL;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const YT_KEY = process.env.YOUTUBE_API_KEY_5 || process.env.YOUTUBE_API_KEY_1;
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
const VISION_KEY = process.env.GOOGLE_VISION_API_KEY;
const supaH = SUPA_KEY ? { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY } : null;

const FPS_USER = 15;       // alta densidade pro video do user
const FPS_CANDIDATE = 5;   // suficiente pra confirmar match
const MAX_CANDIDATES = 5;  // top filtrados por duration similarity
const MAX_SECONDS = 60;    // limita extract a 60s (Shorts <= 60s)
const SCORE_THRESHOLD = 0.90; // nao mostra abaixo disso

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

  // User fps > Candidate fps. Mapeia user frame i pra candidate frame
  // proporcional + janela.
  const ratio = fC / fU; // se user tem 450 e candidate 150, ratio=0.33
  const T_AHASH = 8;  // strict
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
    if (bestScore >= 0.6) {  // frame-level threshold tighter (was 0.5)
      matches.push({ src: i, dst: bestJ, score: bestScore });
      if (firstU === -1) { firstU = i; firstC = bestJ; }
      lastU = i; lastC = bestJ;
    }
  }

  const matchRatio = matches.length / fU; // user tem mais frames, denominador deve ser user
  const avgQuality = matches.length > 0 ? matches.reduce((s, m) => s + m.score, 0) / matches.length : 0;
  const score = matchRatio * 0.65 + avgQuality * 0.35;

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
    const m = url.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/);
    return m?.[1] || null;
  } catch { return null; }
}

// Claude Vision: descreve o conteudo visual e extrai keywords pra busca.
// Pega reposts dentro do YouTube com titulos completamente diferentes.
async function getVisualKeywords(thumbnailUrl) {
  if (!CLAUDE_KEY || !thumbnailUrl) return [];
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: thumbnailUrl } },
            { type: 'text', text: 'Extract 5 visual keywords describing this video for YouTube search (objects, scene, action). Output ONLY comma-separated keywords in English, no explanation, no numbering.' },
          ],
        }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return [];
    const d = await r.json();
    const text = d.content?.[0]?.text || '';
    return text.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 1 && s.length < 30).slice(0, 6);
  } catch { return []; }
}

// Cloud Vision Web Detection: o motor cross-plataforma. Pega 1 frame e busca
// onde aparece na web inteira. Retorna IDs YouTube + URLs de outras plataformas.
async function getWebDetectionMatches(thumbnailUrl) {
  const empty = { youtube_ids: [], other_platforms: [], total_pages: 0, error: null };
  if (!VISION_KEY) return { ...empty, error: 'GOOGLE_VISION_API_KEY ausente' };
  if (!thumbnailUrl) return { ...empty, error: 'thumbnail ausente' };
  try {
    const r = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${VISION_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { source: { imageUri: thumbnailUrl } },
          features: [{ type: 'WEB_DETECTION', maxResults: 50 }],
        }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ...empty, error: `HTTP ${r.status}: ${txt.slice(0, 250)}` };
    }
    const d = await r.json();
    if (d.responses?.[0]?.error) {
      return { ...empty, error: `Vision API: ${JSON.stringify(d.responses[0].error).slice(0, 250)}` };
    }
    const wd = d.responses?.[0]?.webDetection || {};

    const fullPages = (wd.fullMatchingImages || []).map(p => p.url);
    const partialPages = (wd.partialMatchingImages || []).map(p => p.url);
    const matchingPages = (wd.pagesWithMatchingImages || []).map(p => p.url);
    const allUrls = [...new Set([...fullPages, ...partialPages, ...matchingPages])];

    const youtubeIds = new Set();
    const otherPlatforms = [];
    // Padroes de URL irrelevantes (thumbs YouTube, paginas de canal, etc) — descartar
    const isIrrelevant = (url) => {
      try {
        const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        const path = new URL(url).pathname;
        if (host === 'i.ytimg.com' || host.endsWith('.ytimg.com')) return true; // thumb propria
        if (host === 'youtube.com' && /^\/(@|c\/|channel\/|user\/|playlist|results)/.test(path)) return true;
        if (host === 'm.youtube.com' && /^\/(@|c\/|channel\/|user\/|playlist|results)/.test(path)) return true;
        return false;
      } catch { return false; }
    };
    for (const url of allUrls) {
      if (isIrrelevant(url)) continue;
      const ytId = extractYouTubeId(url);
      if (ytId) { youtubeIds.add(ytId); continue; }
      try {
        const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        let platform = 'web';
        if (host.includes('tiktok')) platform = 'tiktok';
        else if (host.includes('instagram')) platform = 'instagram';
        else if (host === 'twitter.com' || host === 'x.com') platform = 'twitter';
        else if (host.includes('facebook')) platform = 'facebook';
        else if (host.includes('kwai')) platform = 'kwai';
        otherPlatforms.push({ url, platform, host });
      } catch {}
    }
    return {
      youtube_ids: [...youtubeIds],
      other_platforms: otherPlatforms,
      total_pages: allUrls.length,
      error: null,
    };
  } catch (e) { return { ...empty, error: `exception: ${(e.message || '').slice(0, 250)}` }; }
}

async function callRailwayExtract(url, fps) {
  const r = await fetch(`${RAILWAY_URL.replace(/\/$/, '')}/extract-fingerprint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, fps, max_seconds: MAX_SECONDS }),
    signal: AbortSignal.timeout(110000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('Railway HTTP ' + r.status + ': ' + txt.slice(0, 150));
  }
  return await r.json();
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

async function searchYouTubeCandidates(meta, originalVideoId, visualKeywords = []) {
  if (!YT_KEY) return [];
  // Limpa título: remove hashtags, menções, pontuação excessiva
  const cleanTitle = (meta?.title || '')
    .replace(/#\w+/g, '').replace(/@\w+/g, '')
    .replace(/[|\[\]()【】「」]/g, ' ')
    .replace(/[^\w\sÀ-ÿ]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 80);

  const baseUrl = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoDuration=short&safeSearch=none&maxResults=10';
  const queries = [];

  // Title-based (Plano original)
  if (cleanTitle) {
    queries.push(`${baseUrl}&order=viewCount&q=${encodeURIComponent(cleanTitle)}&key=${YT_KEY}`);
    queries.push(`${baseUrl}&order=relevance&q=${encodeURIComponent(cleanTitle.slice(0, 60))}&key=${YT_KEY}`);
  }
  // Keywords visuais do Claude (Plano A) — pega reposts com titulo/idioma diferente
  if (visualKeywords.length > 0) {
    const kwQuery = visualKeywords.slice(0, 5).join(' ').slice(0, 80);
    queries.push(`${baseUrl}&order=viewCount&q=${encodeURIComponent(kwQuery)}&key=${YT_KEY}`);
  }
  if (queries.length === 0) return [];

  try {
    const results = await Promise.all(queries.map(q => fetch(q, { signal: AbortSignal.timeout(15000) }).then(r => r.ok ? r.json() : { items: [] }).catch(() => ({ items: [] }))));
    const seen = new Set([originalVideoId]);
    const all = [];
    for (const res of results) {
      for (const item of (res.items || [])) {
        const id = item.id?.videoId;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        all.push({
          id,
          url: `https://www.youtube.com/watch?v=${id}`,
          title: item.snippet?.title || '',
          channel: item.snippet?.channelTitle || '',
          thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || '',
          published_at: item.snippet?.publishedAt,
          source: 'youtube_search',
        });
      }
    }
    return all;
  } catch (e) { return []; }
}

// Enriquece candidates com duration + views + (se faltar) title/channel/thumbnail.
// Importante pros videoIds vindos do Cloud Vision Web Detection que chegam sem
// metadata. Uma chamada videos.list cobre os 2 casos.
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
    // Merge: dados existentes do candidate prevalecem, enrich só preenche faltas
    return candidates
      .map(c => {
        const enriched = map.get(c.id);
        if (!enriched) return c;
        return {
          ...c,
          duration: c.duration ?? enriched.duration,
          views: c.views ?? enriched.views,
          title: c.title || enriched.title,
          channel: c.channel || enriched.channel,
          thumbnail: c.thumbnail || enriched.thumbnail,
          published_at: c.published_at || enriched.published_at,
        };
      })
      // Filtra videoIds que nao retornaram (privados/deletados)
      .filter(c => map.has(c.id) || c.title);
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

  const youtubeId = extractYouTubeId(url);
  if (!youtubeId) return res.status(400).json({ error: 'URL deve ser de Short YouTube — formato: youtube.com/shorts/CODIGO ou watch?v=CODIGO' });

  const startTs = Date.now();
  const stages = [];

  try {
    // Thumbnail YouTube (sem precisar de metadata) — input pras 2 Vision APIs.
    // hqdefault funciona pra TODOS Shorts; maxres pode 404 em vídeos antigos.
    const thumbnailUrl = `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;

    // ── 1. METADATA + USER FINGERPRINT + CLAUDE VISION + WEB DETECTION ──────
    // 4 chamadas em paralelo. A mais lenta (extract Railway ~30s) define o tempo.
    stages.push({ stage: 'parallel_discovery', t: Date.now() });
    const [meta, userFp, visualKeywords, webMatches] = await Promise.all([
      fetchVideoMeta(youtubeId),
      callRailwayExtract(url, FPS_USER),
      getVisualKeywords(thumbnailUrl),
      getWebDetectionMatches(thumbnailUrl),
    ]);
    stages[stages.length - 1].duration_ms = Date.now() - stages[stages.length - 1].t;
    stages[stages.length - 1].keywords = visualKeywords.length;
    stages[stages.length - 1].web_pages = webMatches.total_pages;

    if (!meta || !meta.title) {
      return res.status(404).json({ error: 'Video YouTube nao encontrado ou privado' });
    }
    if (!userFp || !userFp.ok || (userFp.p_hashes?.length || 0) === 0) {
      return res.status(502).json({ error: 'Falha ao extrair fingerprint do video' });
    }

    // ── 2. YouTube Search (title + visual keywords) ────────────────────────
    stages.push({ stage: 'search_combined', t: Date.now() });
    const searchCandidates = await searchYouTubeCandidates(meta, youtubeId, visualKeywords);
    stages[stages.length - 1].duration_ms = Date.now() - stages[stages.length - 1].t;
    stages[stages.length - 1].count = searchCandidates.length;

    // ── 3. Combina fontes: search + Web Detection ──────────────────────────
    // Web Detection tem alta prioridade (Google ja confirmou que a imagem aparece la).
    const seen = new Set([youtubeId, ...searchCandidates.map(c => c.id)]);
    const webDetectionCandidates = webMatches.youtube_ids
      .filter(id => !seen.has(id))
      .map(id => ({
        id,
        url: `https://www.youtube.com/watch?v=${id}`,
        title: '', channel: '', thumbnail: '', published_at: null,
        source: 'web_detection',
      }));
    const candidates = [...webDetectionCandidates, ...searchCandidates];

    if (candidates.length === 0) {
      return res.status(200).json({
        ok: true,
        url, video_meta: meta,
        matches: [],
        web_matches: webMatches.other_platforms,
        message: webMatches.other_platforms.length > 0
          ? 'Nenhum candidato YouTube encontrado, mas imagem aparece em outras plataformas.'
          : 'Nenhum candidato encontrado.',
        timing: { total_ms: Date.now() - startTs, stages },
      });
    }

    // ── 4. Enriquece (snippet + duration + views) e filtra ±20% ────────────
    stages.push({ stage: 'enrich', t: Date.now() });
    const enriched = await enrichVideoDetails(candidates);
    stages[stages.length - 1].duration_ms = Date.now() - stages[stages.length - 1].t;

    const userDur = meta.duration || userFp.duration_seconds || 0;
    const filtered = enriched
      .filter(c => {
        if (!userDur || !c.duration) return true; // sem duration, mantem
        const diff = Math.abs(userDur - c.duration) / Math.max(userDur, c.duration);
        return diff <= 0.20;
      })
      // Web Detection candidates primeiro (sinal mais forte), depois por views
      .sort((a, b) => {
        if (a.source === 'web_detection' && b.source !== 'web_detection') return -1;
        if (b.source === 'web_detection' && a.source !== 'web_detection') return 1;
        return (b.views || 0) - (a.views || 0);
      })
      .slice(0, MAX_CANDIDATES);

    if (filtered.length === 0) {
      return res.status(200).json({
        ok: true,
        url, video_meta: meta,
        matches: [],
        web_matches: webMatches.other_platforms,
        message: 'Nenhum candidato com duracao similar.',
        candidates_searched: candidates.length,
        timing: { total_ms: Date.now() - startTs, stages },
      });
    }

    // ── 5. Extract fingerprints dos top 5 em PARALELO ──────────────────────
    stages.push({ stage: 'extract_candidates', t: Date.now(), count: filtered.length });
    const candFps = await Promise.all(
      filtered.map(c =>
        callRailwayExtract(c.url, FPS_CANDIDATE)
          .then(fp => ({ ...c, fp, fp_ok: !!fp.ok }))
          .catch(err => ({ ...c, fp: null, fp_ok: false, fp_error: err.message.slice(0, 100) }))
      )
    );
    stages[stages.length - 1].duration_ms = Date.now() - stages[stages.length - 1].t;

    // ── 6. MATCH algorithm strict — score >= 0.90 ──────────────────────────
    stages.push({ stage: 'match', t: Date.now() });
    const matches = [];
    const allScored = [];  // pra debug: TODOS os candidatos com score
    for (const c of candFps) {
      if (!c.fp_ok || !c.fp.p_hashes?.length) continue;
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
        source: c.source,
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
    allScored.sort((a, b) => b.score - a.score);
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
      // Discovery sources
      visual_keywords: visualKeywords,
      web_detection: {
        total_pages: webMatches.total_pages,
        youtube_ids_found: webMatches.youtube_ids.length,
        youtube_ids: webMatches.youtube_ids,  // debug: lista completa
        error: webMatches.error,
      },
      // Candidates pipeline
      candidates_searched: candidates.length,
      candidates_filtered: filtered.length,
      candidates_extracted: candFps.filter(c => c.fp_ok).length,
      // Confirmed matches (>= 90% via fingerprint)
      matches,
      // Debug: top candidatos com score (mesmo abaixo do threshold) pra ajustar threshold
      top_candidates: allScored.slice(0, 10),
      // Cross-platform URLs (TikTok/Instagram/etc) — Google detectou imagem matching
      // mas nao validamos com fingerprint (Railway so suporta YouTube hoje)
      web_matches: webMatches.other_platforms,
      threshold: SCORE_THRESHOLD,
      timing: { total_ms: Date.now() - startTs, stages },
    });
  } catch (e) {
    console.error('[bluelens-fingerprint]', e.message);
    return res.status(500).json({ error: e.message, timing: { total_ms: Date.now() - startTs, stages } });
  }
};
