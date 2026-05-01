// api/baixa-invidious.js
//
// Camada 5 da blindagem baixaBlue YouTube. Provider de natureza DIFERENTE
// (frontend alternativo do YouTube com scraper independente). Usado como
// fallback final quando os 4 providers principais (Cobalt, ytstream,
// youtube-media-downloader, Railway yt-dlp) caem juntos — situacao
// classica quando YouTube faz update anti-bot.
//
// Tenta lista de instancias publicas em sequencia, retorna primeira que
// responder com URL valida. Lista hardcoded de instancias com bom uptime;
// pode ser melhorada futuramente fetchando https://api.invidious.io/instances.json
//
// Resposta tem mesmo formato que /api/auth?action=download:
//   { url, title, thumbnail, platform: 'youtube', provider: 'invidious' }

// Fallback list — usada se fetch da lista oficial falhar.
// Importante: muitas instancias publicas Invidious fecharam API por abuso
// de bots ao longo de 2025-2026. Piped (fork mais ativo) e adicionado como
// segunda linha de fallback.
const INVIDIOUS_INSTANCES_FALLBACK = [
  'https://yewtu.be',
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.privacyredirect.com',
  'https://iv.melmac.space',
];

// Piped instances — formato API ligeiramente diferente do Invidious.
// /api/v1/streams/VIDEO_ID retorna { videoStreams: [...], audioStreams: [...] }
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.leptons.xyz',
  'https://api.piped.private.coffee',
];

const TIMEOUT_MS = 15000;
const INSTANCES_LIST_URL = 'https://api.invidious.io/instances.json';

// Cache em memoria das instancias ativas (TTL 1h — funcao do Vercel pode
// reciclar antes mas e melhor que nada)
let _instancesCache = null;
let _instancesCacheAt = 0;

async function getActiveInstances() {
  // Cache 1h
  if (_instancesCache && (Date.now() - _instancesCacheAt) < 3600000) {
    return _instancesCache;
  }
  try {
    const r = await fetch(INSTANCES_LIST_URL + '?sort_by=health,users&pretty=0', {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!r.ok) throw new Error('list HTTP ' + r.status);
    const data = await r.json();
    // data e array de [name, info] tuplas. Filtra: HTTPS + API enabled + healthy
    const active = data
      .filter(([_, info]) => info && info.api === true && info.type === 'https')
      .filter(([_, info]) => {
        const sc = info.monitor?.statusClass;
        return !sc || sc === 'success' || sc === 'monitor-success';
      })
      .slice(0, 8)
      .map(([name]) => 'https://' + name);
    if (active.length > 0) {
      _instancesCache = active;
      _instancesCacheAt = Date.now();
      return active;
    }
  } catch (e) {
    console.warn('[invidious] lista oficial falhou:', e.message);
  }
  return INVIDIOUS_INSTANCES_FALLBACK;
}

async function tryInstance(instance, videoId) {
  try {
    const r = await fetch(`${instance}/api/v1/videos/${videoId}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    if (!r.ok) return { ok: false, status: r.status };
    const d = await r.json();

    // formatStreams = URL com video+audio combinado (preferido)
    const fs = (d.formatStreams || []).find(f =>
      f.qualityLabel === '720p' || f.qualityLabel === '480p' || f.qualityLabel === '360p'
    );
    if (fs?.url) {
      return {
        ok: true,
        url: fs.url,
        title: d.title || 'YouTube Short',
        thumbnail: d.videoThumbnails?.find(t => t.quality === 'high')?.url || d.videoThumbnails?.[0]?.url,
        quality: fs.qualityLabel,
      };
    }

    // Fallback: adaptiveFormats (precisa muxar audio+video, mas user
    // pelo menos consegue salvar video sem audio se preferir 1080p)
    const af = (d.adaptiveFormats || []).filter(f =>
      f.type?.includes('video/mp4') || f.encoding === 'h264'
    );
    const best = af.find(f => f.qualityLabel === '720p') ||
                 af.find(f => f.qualityLabel === '480p') ||
                 af[0];
    if (best?.url) {
      return {
        ok: true,
        url: best.url,
        title: d.title || 'YouTube Short',
        thumbnail: d.videoThumbnails?.[0]?.url,
        quality: best.qualityLabel || 'auto',
      };
    }

    return { ok: false, error: 'sem_formatos_disponiveis' };
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
  if (!url) return res.status(400).json({ error: 'url query param required' });

  const match = String(url).match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/);
  if (!match) return res.status(400).json({ error: 'URL YouTube invalida' });
  const videoId = match[1];

  // 1. Tenta Invidious dinamicamente
  const invidiousList = await getActiveInstances();
  const failures = [];
  for (const instance of invidiousList) {
    const host = (() => { try { return new URL(instance).hostname; } catch { return instance; } })();
    const result = await tryInstance(instance, videoId);
    if (result.ok) {
      return res.status(200).json({
        ok: true, url: result.url, title: result.title, thumbnail: result.thumbnail,
        quality: result.quality, platform: 'youtube', provider: 'invidious', instance: host,
      });
    }
    failures.push(`invidious/${host}: ${result.error || 'HTTP ' + result.status}`);
  }

  // 2. Fallback: tenta Piped (fork ativo do Invidious)
  for (const instance of PIPED_INSTANCES) {
    const host = (() => { try { return new URL(instance).hostname; } catch { return instance; } })();
    const result = await tryPiped(instance, videoId);
    if (result.ok) {
      return res.status(200).json({
        ok: true, url: result.url, title: result.title, thumbnail: result.thumbnail,
        quality: result.quality, platform: 'youtube', provider: 'piped', instance: host,
      });
    }
    failures.push(`piped/${host}: ${result.error || 'HTTP ' + result.status}`);
  }

  return res.status(502).json({
    error: 'Todas instancias alternativas (Invidious + Piped) falharam',
    detail: failures.join(' | '),
    invidious_tentadas: invidiousList.length,
    piped_tentadas: PIPED_INSTANCES.length,
  });
};

async function tryPiped(instance, videoId) {
  try {
    const r = await fetch(`${instance}/streams/${videoId}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    if (!r.ok) return { ok: false, status: r.status };
    const d = await r.json();
    // videoStreams = formato combinado (preferido)
    const vs = (d.videoStreams || []).find(s => s.format === 'MPEG_4' && s.videoOnly === false);
    if (vs?.url) {
      return {
        ok: true, url: vs.url, title: d.title || 'YouTube Short',
        thumbnail: d.thumbnailUrl, quality: vs.quality || 'auto',
      };
    }
    // Fallback: pega melhor mp4 video-only (sem audio, mas user pode salvar)
    const vs2 = (d.videoStreams || []).find(s => s.format === 'MPEG_4');
    if (vs2?.url) {
      return {
        ok: true, url: vs2.url, title: d.title || 'YouTube Short',
        thumbnail: d.thumbnailUrl, quality: vs2.quality || 'auto',
      };
    }
    return { ok: false, error: 'sem_video_streams' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
