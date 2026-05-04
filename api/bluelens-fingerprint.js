// api/bluelens-fingerprint.js
//
// BlueLens YouTube-only profundo: detecta quantos canais YouTube postaram
// o MESMO conteudo visual do video do user. Sem dependencia de base
// propria — busca candidatos via YouTube Search global e valida com
// fingerprint visual frame-by-frame.
//
// Threshold rigoroso: so mostra matches >= 90% (zero falso positivo).
//
// Pipeline (versao original 2026-05-03 + extractYouTubeId mais permissivo):
//   1. Pega metadata do video do user (YouTube Data API)
//   2. Extract fingerprint do user em 15fps (precisao maxima)
//   3. YouTube Search global (3 queries paralelas, sem regionCode)
//   4. Filtra Top 5 candidatos por duration similarity (±20%)
//   5. Extract fingerprint dos 5 em paralelo (5fps cada)
//   6. Match algorithm strict — score >= 0.90 entra
//
// Custo:
//   - YouTube Data API: ~600 unidades por analise (KEY 5 dedicada)
//   - Railway: free (yt-dlp + ffmpeg + sharp local)
//   - Cobalt fallback se yt-dlp falhar
//
// maxDuration Vercel: 300s (cabe ~2-3 min tipico)

const RAILWAY_URL = process.env.RAILWAY_FFMPEG_URL;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const YT_KEY = process.env.YOUTUBE_API_KEY_5 || process.env.YOUTUBE_API_KEY_1;
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
    // Mantida melhoria (sem risco): aceita tambem URLs i.ytimg.com/vi/<id>/...
    // pra casos edge onde URL vem de thumbnail. Nao afeta pipeline atual.
    const m = url.match(/(?:shorts\/|v=|youtu\.be\/|ytimg\.com\/vi\/)([a-zA-Z0-9_-]{6,20})/);
    return m?.[1] || null;
  } catch { return null; }
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

async function searchYouTubeCandidates(meta, originalVideoId) {
  if (!YT_KEY || !meta?.title) return [];
  // Limpa título: remove hashtags, menções, pontuação excessiva
  const cleanTitle = meta.title
    .replace(/#\w+/g, '').replace(/@\w+/g, '')
    .replace(/[|\[\]()【】「」]/g, ' ')
    .replace(/[^\w\sÀ-ÿ]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!cleanTitle) return [];

  // 3 queries paralelas SEM regionCode (busca GLOBAL)
  const baseUrl = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoDuration=short&safeSearch=none&maxResults=10';
  const queries = [
    `${baseUrl}&order=viewCount&q=${encodeURIComponent(cleanTitle)}&key=${YT_KEY}`,
    `${baseUrl}&order=date&q=${encodeURIComponent(cleanTitle)}&key=${YT_KEY}`,
    `${baseUrl}&order=relevance&q=${encodeURIComponent(cleanTitle.slice(0, 60))}&key=${YT_KEY}`,
  ];

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
        });
      }
    }
    return all;
  } catch (e) { return []; }
}

async function enrichDuration(candidates) {
  if (!YT_KEY || !candidates.length) return candidates;
  const ids = candidates.map(c => c.id).join(',');
  try {
    const r = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${ids}&key=${YT_KEY}`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!r.ok) return candidates;
    const d = await r.json();
    const map = new Map();
    for (const item of (d.items || [])) {
      const dur = item.contentDetails?.duration || '';
      const dm = dur.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
      const seconds = (parseInt(dm?.[1] || 0) * 60) + parseInt(dm?.[2] || 0);
      map.set(item.id, { duration: seconds, views: parseInt(item.statistics?.viewCount || 0) });
    }
    return candidates.map(c => ({ ...c, ...(map.get(c.id) || {}) }));
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
    // ── 1. METADATA + 2. EXTRACT USER FINGERPRINT (paralelos) ──────────────
    stages.push({ stage: 'metadata+extract_user', t: Date.now() });
    const [meta, userFp] = await Promise.all([
      fetchVideoMeta(youtubeId),
      callRailwayExtract(url, FPS_USER),
    ]);
    stages[stages.length - 1].duration_ms = Date.now() - stages[stages.length - 1].t;
    if (!meta || !meta.title) {
      return res.status(404).json({ error: 'Video YouTube nao encontrado ou privado' });
    }
    if (!userFp || !userFp.ok || (userFp.p_hashes?.length || 0) === 0) {
      return res.status(502).json({ error: 'Falha ao extrair fingerprint do video' });
    }

    // ── 3. YouTube Search GLOBAL ───────────────────────────────────────────
    stages.push({ stage: 'search_global', t: Date.now() });
    const candidates = await searchYouTubeCandidates(meta, youtubeId);
    stages[stages.length - 1].duration_ms = Date.now() - stages[stages.length - 1].t;

    if (candidates.length === 0) {
      return res.status(200).json({
        ok: true,
        url, video_meta: meta,
        matches: [],
        message: 'Nenhum candidato encontrado pelo YouTube Search.',
        timing: { total_ms: Date.now() - startTs, stages },
      });
    }

    // ── 4. Enriquece com duration + filtra ±20% ────────────────────────────
    stages.push({ stage: 'enrich_duration', t: Date.now() });
    const enriched = await enrichDuration(candidates);
    stages[stages.length - 1].duration_ms = Date.now() - stages[stages.length - 1].t;

    const userDur = meta.duration || userFp.duration_seconds || 0;
    const filtered = enriched
      .filter(c => {
        if (!userDur || !c.duration) return true; // sem duration, mantem
        const diff = Math.abs(userDur - c.duration) / Math.max(userDur, c.duration);
        return diff <= 0.20;
      })
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, MAX_CANDIDATES);

    if (filtered.length === 0) {
      return res.status(200).json({
        ok: true,
        url, video_meta: meta,
        matches: [],
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
    for (const c of candFps) {
      if (!c.fp_ok || !c.fp.p_hashes?.length) continue;
      const cmp = compareFingerprints(userFp, c.fp);
      if (cmp.score >= SCORE_THRESHOLD) {
        matches.push({
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
        });
      }
    }
    matches.sort((a, b) => b.score - a.score);
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
      candidates_searched: candidates.length,
      candidates_filtered: filtered.length,
      candidates_extracted: candFps.filter(c => c.fp_ok).length,
      matches,
      threshold: SCORE_THRESHOLD,
      timing: { total_ms: Date.now() - startTs, stages },
    });
  } catch (e) {
    console.error('[bluelens-fingerprint]', e.message);
    return res.status(500).json({ error: e.message, timing: { total_ms: Date.now() - startTs, stages } });
  }
};
