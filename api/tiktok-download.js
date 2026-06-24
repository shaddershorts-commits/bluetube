// api/tiktok-download.js — Proxy de download MP4 do TikTok (2026-06-24)
// =====================================================================
// Recebe ?id=<tiktok_video_id> e:
// 1. Busca metadata no banco (tem video_url canonical)
// 2. Chama TikAPI /public/video pra obter downloadAddr fresh
//    (downloadAddr expira, precisa renovar a cada download)
// 3. Faz streaming proxy do MP4 com Content-Disposition: attachment
//    → browser baixa nativo sem abrir nova aba
//
// Isolado do BaixaBlue: não toca nada da infra YouTube.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const TIKAPI_KEY = process.env.TIKAPI_KEY;
  if (!SU || !SK || !TIKAPI_KEY) return res.status(500).json({ error: 'config_missing' });

  const tiktokId = (req.query.id || '').replace(/[^0-9]/g, '');
  if (!tiktokId) return res.status(400).json({ error: 'id_obrigatorio' });

  try {
    // 1. Busca metadata no banco (autor + caption pra montar filename)
    const h = { apikey: SK, Authorization: 'Bearer ' + SK };
    const mR = await fetch(
      `${SU}/rest/v1/tiktok_virais?tiktok_video_id=eq.${tiktokId}&select=author_handle,caption&limit=1`,
      { headers: h }
    );
    const meta = mR.ok ? (await mR.json())[0] : null;

    // 2. TikAPI /public/video — pega downloadAddr fresh
    const tikR = await fetch(
      `https://api.tikapi.io/public/video?id=${tiktokId}`,
      {
        headers: { 'X-API-KEY': TIKAPI_KEY, 'accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!tikR.ok) {
      console.error('[tiktok-download] TikAPI status:', tikR.status);
      return res.status(502).json({ error: 'tikapi_falhou', status: tikR.status });
    }
    const tikData = await tikR.json();
    const item = tikData?.itemInfo?.itemStruct || tikData?.aweme_detail || tikData;
    const downloadAddr = item?.video?.downloadAddr || item?.video?.playAddr;
    if (!downloadAddr) {
      console.error('[tiktok-download] sem downloadAddr no response TikAPI');
      return res.status(404).json({ error: 'video_indisponivel' });
    }

    // 3. Streaming proxy do MP4
    // Cookies / headers que o TikTok CDN espera (sem isso retorna 403)
    const videoHeaders = {
      'Cookie': 'tt_chain_token=oZErKUkoYjA3eubs2RVYzA==;',
      'Origin': 'https://www.tiktok.com',
      'Referer': 'https://www.tiktok.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    // Repassa Range header (pra resume/streaming)
    if (req.headers['range']) videoHeaders['Range'] = req.headers['range'];

    const vidR = await fetch(downloadAddr, {
      headers: videoHeaders,
      signal: AbortSignal.timeout(60000),
    });

    if (!vidR.ok && vidR.status !== 206) {
      console.error('[tiktok-download] CDN status:', vidR.status);
      return res.status(502).json({ error: 'cdn_falhou', status: vidR.status });
    }

    // Filename amigável: @handle_id.mp4
    const safeHandle = (meta?.author_handle || 'tiktok').replace(/[^a-zA-Z0-9_]/g, '');
    const filename = `${safeHandle}_${tiktokId}.mp4`;

    // Propaga headers relevantes
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (vidR.headers.get('content-length')) {
      res.setHeader('Content-Length', vidR.headers.get('content-length'));
    }
    if (vidR.headers.get('content-range')) {
      res.setHeader('Content-Range', vidR.headers.get('content-range'));
      res.setHeader('Accept-Ranges', 'bytes');
    }
    res.status(vidR.status);

    // Stream do body
    if (vidR.body) {
      const reader = vidR.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    return res.end();
  } catch (e) {
    console.error('[tiktok-download fatal]', e?.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: e?.message });
    }
    return res.end();
  }
};
