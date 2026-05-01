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

const INVIDIOUS_INSTANCES = [
  'https://yewtu.be',
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.privacyredirect.com',
  'https://iv.melmac.space',
];

const TIMEOUT_MS = 15000;

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

  const failures = [];
  for (const instance of INVIDIOUS_INSTANCES) {
    const host = (() => { try { return new URL(instance).hostname; } catch { return instance; } })();
    const result = await tryInstance(instance, videoId);
    if (result.ok) {
      return res.status(200).json({
        ok: true,
        url: result.url,
        title: result.title,
        thumbnail: result.thumbnail,
        quality: result.quality,
        platform: 'youtube',
        provider: 'invidious',
        instance: host,
      });
    }
    failures.push(`${host}: ${result.error || 'HTTP ' + result.status}`);
  }

  return res.status(502).json({
    error: 'Todas instancias Invidious falharam',
    detail: failures.join(' | '),
    instancias_tentadas: INVIDIOUS_INSTANCES.length,
  });
};
