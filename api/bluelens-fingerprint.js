// api/bluelens-fingerprint.js
//
// BlueLens Ultimate — visual fingerprint matching (visual-only, sem
// dependencia em titulo/audio/transcricao).
//
// Fluxo:
//   1. Recebe ?url=URL_DO_VIDEO
//   2. Verifica cache no DB — se ja indexado, usa fingerprint salvo
//   3. Caso nao, chama Railway /extract-fingerprint pra computar
//   4. Salva fingerprint em video_visual_fingerprints
//   5. Roda matching contra base existente (Hamming distance multi-hash)
//   6. Retorna ranking de matches com confidence + temporal overlap
//
// FUSION DE SCORE:
//   - aHash similarity   peso 0.30 (rapido, base)
//   - dHash similarity   peso 0.40 (robusto, principal)
//   - colorHash distance peso 0.30 (cobre filtros)
//   - Match threshold default: score >= 0.75 (Master pode ajustar)

const RAILWAY_URL = process.env.RAILWAY_FFMPEG_URL;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const supaH = SUPA_KEY ? { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY } : null;

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

// Color hash distance — interpreta como histograma RGB 4-bin (24 bytes)
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
  return Math.min(1, sum / (len * 128)); // normaliza pra [0,1]
}

// Calcula similarity entre 2 fingerprints alinhando frames temporalmente.
// Retorna { score, matchedFrames, total, temporalOverlap }
function compareFingerprints(fp1, fp2) {
  const frames1 = fp1.p_hashes?.length || 0;
  const frames2 = fp2.p_hashes?.length || 0;
  if (frames1 === 0 || frames2 === 0) return { score: 0, matchedFrames: 0, total: 0 };

  // Estrategia: pra cada frame de fp1, encontra melhor match em fp2 dentro
  // de janela temporal +/- 5 frames (cobre offsets de speedup/slowdown leve)
  const SIM_THRESHOLD_AHASH = 12; // hamming <= 12 (de 64) = similar
  const SIM_THRESHOLD_DHASH = 10;
  const SIM_THRESHOLD_COLOR = 0.20;

  const matches = [];
  let firstMatchIdx1 = -1, lastMatchIdx1 = -1, firstMatchIdx2 = -1, lastMatchIdx2 = -1;

  for (let i = 0; i < frames1; i++) {
    let bestJ = -1, bestScore = 0;
    const lo = Math.max(0, i - 5);
    const hi = Math.min(frames2 - 1, i + 5);
    for (let j = lo; j <= hi; j++) {
      const aDist = hammingHex(fp1.p_hashes[i], fp2.p_hashes[j]);
      const dDist = hammingHex(fp1.d_hashes[i], fp2.d_hashes[j]);
      const cDist = colorDistance(fp1.color_hashes[i], fp2.color_hashes[j]);
      // Frame-level fusion
      const aSim = aDist <= SIM_THRESHOLD_AHASH ? 1 - (aDist / 64) : 0;
      const dSim = dDist <= SIM_THRESHOLD_DHASH ? 1 - (dDist / 64) : 0;
      const cSim = cDist <= SIM_THRESHOLD_COLOR ? 1 - cDist : 0;
      const frameScore = aSim * 0.3 + dSim * 0.4 + cSim * 0.3;
      if (frameScore > bestScore) { bestScore = frameScore; bestJ = j; }
    }
    if (bestScore >= 0.5) {
      matches.push({ src: i, dst: bestJ, score: bestScore });
      if (firstMatchIdx1 === -1) { firstMatchIdx1 = i; firstMatchIdx2 = bestJ; }
      lastMatchIdx1 = i; lastMatchIdx2 = bestJ;
    }
  }

  const matchRatio = matches.length / Math.min(frames1, frames2);
  // Score final = ratio de frames batendo + qualidade media de cada match
  const avgQuality = matches.length > 0 ? matches.reduce((s, m) => s + m.score, 0) / matches.length : 0;
  const score = matchRatio * 0.7 + avgQuality * 0.3;

  return {
    score,
    matchedFrames: matches.length,
    total: Math.min(frames1, frames2),
    matchRatio,
    avgQuality,
    temporalOverlap: matches.length > 3 ? {
      src_start: firstMatchIdx1,
      src_end: lastMatchIdx1,
      dst_start: firstMatchIdx2,
      dst_end: lastMatchIdx2,
    } : null,
  };
}

// Detecta plataforma + canonicaliza URL pra cache estavel
function detectPlatform(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (/youtube\.com|youtu\.be/.test(host)) return 'youtube';
    if (/tiktok\.com/.test(host)) return 'tiktok';
    if (/instagram\.com/.test(host)) return 'instagram';
    if (/twitter\.com|x\.com/.test(host)) return 'x';
  } catch {}
  return 'unknown';
}

function extractExternalId(url, platform) {
  try {
    if (platform === 'youtube') {
      const m = url.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/);
      return m?.[1] || null;
    }
    if (platform === 'tiktok') {
      const m = url.match(/\/video\/(\d+)/);
      return m?.[1] || null;
    }
    if (platform === 'instagram') {
      const m = url.match(/\/(?:reel|reels|p)\/([a-zA-Z0-9_-]+)/);
      return m?.[1] || null;
    }
  } catch {}
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const url = req.query?.url;
  if (!url) return res.status(400).json({ error: 'url obrigatorio' });
  if (!RAILWAY_URL) return res.status(500).json({ error: 'RAILWAY_FFMPEG_URL nao configurada' });
  if (!supaH) return res.status(500).json({ error: 'Supabase nao configurada' });

  const platform = detectPlatform(url);
  const externalId = extractExternalId(url, platform);

  try {
    // 1. Verifica se ja temos fingerprint deste video
    let myFp;
    const existR = await fetch(
      `${SUPA_URL}/rest/v1/video_visual_fingerprints?source_url=eq.${encodeURIComponent(url)}&select=*&limit=1`,
      { headers: supaH }
    );
    const existing = existR.ok ? await existR.json() : [];
    if (existing.length > 0) {
      myFp = existing[0];
    } else {
      // 2. Nao temos — pede ao Railway pra extrair
      const t0 = Date.now();
      const railwayR = await fetch(`${RAILWAY_URL.replace(/\/$/, '')}/extract-fingerprint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, fps: 1, max_seconds: 60 }),
        signal: AbortSignal.timeout(120000),
      });
      if (!railwayR.ok) {
        const errTxt = await railwayR.text().catch(() => '');
        return res.status(502).json({ error: 'Railway falhou', detail: errTxt.slice(0, 300) });
      }
      const fp = await railwayR.json();
      const extractMs = Date.now() - t0;

      // 3. Salva no DB
      const insertR = await fetch(`${SUPA_URL}/rest/v1/video_visual_fingerprints`, {
        method: 'POST',
        headers: { ...supaH, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({
          source_url: url,
          platform,
          video_id_external: externalId,
          duration_seconds: fp.duration_seconds,
          width: fp.width,
          height: fp.height,
          total_frames_extracted: fp.total_frames_extracted,
          fps_extracted: fp.fps_extracted,
          p_hashes: fp.p_hashes,
          d_hashes: fp.d_hashes,
          color_hashes: fp.color_hashes,
          index_source: 'user_analysis',
        }),
      });
      if (!insertR.ok) {
        const errTxt = await insertR.text().catch(() => '');
        // Se já existe (race condition), busca de novo
        const refetch = await fetch(
          `${SUPA_URL}/rest/v1/video_visual_fingerprints?source_url=eq.${encodeURIComponent(url)}&select=*&limit=1`,
          { headers: supaH }
        );
        const refetched = refetch.ok ? await refetch.json() : [];
        if (refetched.length === 0) return res.status(500).json({ error: 'Falha ao salvar fingerprint', detail: errTxt.slice(0, 300) });
        myFp = refetched[0];
      } else {
        const inserted = await insertR.json();
        myFp = inserted[0];
        myFp._extract_ms = extractMs;
      }
    }

    // 4. Busca candidatos no DB (mesma plataforma OU outras — visual e cross-platform)
    // Filtra por durations similares (+/- 30%) pra reduzir comparacoes
    const durMin = (myFp.duration_seconds || 0) * 0.7;
    const durMax = (myFp.duration_seconds || 0) * 1.3;
    const candR = await fetch(
      `${SUPA_URL}/rest/v1/video_visual_fingerprints?id=neq.${myFp.id}` +
      (myFp.duration_seconds ? `&duration_seconds=gte.${durMin}&duration_seconds=lte.${durMax}` : '') +
      `&select=id,source_url,platform,duration_seconds,total_frames_extracted,p_hashes,d_hashes,color_hashes,index_source` +
      `&limit=500&order=indexed_at.desc`,
      { headers: supaH }
    );
    const candidates = candR.ok ? await candR.json() : [];

    // 5. Compara fingerprint contra todos candidates
    const matches = [];
    for (const c of candidates) {
      const cmp = compareFingerprints(myFp, c);
      if (cmp.score >= 0.5) {
        matches.push({
          source_url: c.source_url,
          platform: c.platform,
          score: cmp.score,
          matched_frames: cmp.matchedFrames,
          total_frames: cmp.total,
          match_ratio: cmp.matchRatio,
          avg_quality: cmp.avgQuality,
          temporal_overlap: cmp.temporalOverlap,
          confidence_label: cmp.score >= 0.85 ? 'altíssima' : cmp.score >= 0.7 ? 'alta' : cmp.score >= 0.55 ? 'média' : 'baixa',
          fps_extracted: 1, // alinhar com base
        });
      }
    }

    matches.sort((a, b) => b.score - a.score);

    // 6. Atualiza last_matched_at + counter (fire-and-forget)
    if (matches.length > 0) {
      fetch(`${SUPA_URL}/rest/v1/video_visual_fingerprints?id=eq.${myFp.id}`, {
        method: 'PATCH',
        headers: { ...supaH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ last_matched_at: new Date().toISOString(), times_matched: (myFp.times_matched || 0) + 1 }),
      }).catch(() => {});
    }

    return res.status(200).json({
      ok: true,
      url,
      platform,
      fingerprint: {
        id: myFp.id,
        total_frames: myFp.total_frames_extracted,
        duration_seconds: myFp.duration_seconds,
        was_cached: !myFp._extract_ms,
        extract_ms: myFp._extract_ms || null,
      },
      matches,
      counts: {
        total_compared: candidates.length,
        matched: matches.length,
        confidence_alta: matches.filter(m => m.score >= 0.7).length,
        confidence_altissima: matches.filter(m => m.score >= 0.85).length,
      },
    });
  } catch (e) {
    console.error('[bluelens-fingerprint]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
