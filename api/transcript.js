// api/transcript.js
// Primary: Supadata API | Fallback 1: RapidAPI | Fallback 2: YouTube timedtext (gratuito)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { videoId } = req.query;
  if (!videoId || !/^[a-zA-Z0-9_-]{6,20}$/.test(videoId))
    return res.status(400).json({ error: 'videoId inválido' });

  const SUPADATA_KEY = process.env.SUPADATA_API_KEY;
  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

  // ── 1. SUPADATA (primary) ──────────────────────────────────────────────────
  if (SUPADATA_KEY) {
    try {
      const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const supaRes = await fetch(
        `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(ytUrl)}`,
        { headers: { 'x-api-key': SUPADATA_KEY } }
      );
      const data = await supaRes.json();

      if (supaRes.status === 202 && data.jobId) {
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 3000));
          const poll = await fetch(`https://api.supadata.ai/v1/transcript/${data.jobId}`,
            { headers: { 'x-api-key': SUPADATA_KEY } });
          const pd = await poll.json();
          if (pd.content || pd.status === 'completed') return res.status(200).json(pd);
          if (pd.status === 'failed') break;
        }
      } else if (supaRes.ok && data.content) {
        return res.status(200).json(data);
      }
      // 429 ou erro → cai para fallback
      console.log('Supadata fallback triggered:', supaRes.status);
    } catch(e) {
      console.log('Supadata error:', e.message);
    }
  }

  // ── 2. RAPIDAPI (fallback) ─────────────────────────────────────────────────
  if (RAPIDAPI_KEY) {
    try {
      const rapidRes = await fetch(
        `https://youtube-transcript3.p.rapidapi.com/api/transcript?videoId=${encodeURIComponent(videoId)}&lang=pt`,
        { headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': 'youtube-transcript3.p.rapidapi.com' } }
      );
      if (rapidRes.ok) {
        const rd = await rapidRes.json();
        if (Array.isArray(rd) && rd.length > 0) {
          const content = rd.map(s => ({
            text: s.text || s.transcript || '',
            offset: Math.round((s.start || 0) * 1000),
            duration: Math.round((s.duration || 3) * 1000)
          })).filter(s => s.text);
          if (content.length > 0) return res.status(200).json({ content, lang: 'pt' });
        }
      }
      console.log('RapidAPI fallback failed:', rapidRes.status);
    } catch(e) {
      console.log('RapidAPI error:', e.message);
    }
  }

  // ── 3. YOUTUBE TIMEDTEXT (gratuito, sem chave) ─────────────────────────────
  try {
    // Busca a página do vídeo para extrair o playerResponse com caption tracks
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      }
    });

    if (!pageRes.ok) throw new Error('YouTube page fetch failed');
    const html = await pageRes.text();

    // Extrai captionTracks do playerResponse
    const match = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (!match) throw new Error('No caption tracks found');

    const tracks = JSON.parse(match[1]);
    if (!tracks || tracks.length === 0) throw new Error('Empty caption tracks');

    // Pega a legenda do idioma original do vídeo
    // Prioriza: legenda manual (sem 'asr') → automática → qualquer
    const manual = tracks.filter(t => t.kind !== 'asr');
    const preferred = manual[0] || tracks[0];

    if (!preferred?.baseUrl) throw new Error('No caption URL');

    // Busca XML das legendas
    const captionRes = await fetch(preferred.baseUrl + '&fmt=json3');
    if (!captionRes.ok) throw new Error('Caption fetch failed');

    const captionData = await captionRes.json();
    const events = captionData.events || [];

    const content = events
      .filter(e => e.segs && e.tStartMs !== undefined)
      .map(e => ({
        text: e.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim(),
        offset: e.tStartMs || 0,
        duration: e.dDurationMs || 3000
      }))
      .filter(s => s.text && s.text !== ' ');

    if (content.length === 0) throw new Error('No content extracted');

    console.log('YouTube timedtext success:', content.length, 'segments');
    return res.status(200).json({ content, lang: preferred.languageCode });

  } catch(e) {
    console.log('YouTube timedtext error:', e.message);
  }

  // ── Todos os serviços falharam ─────────────────────────────────────────────
  return res.status(503).json({
    error: 'Não foi possível obter a transcrição. O vídeo pode não ter legendas ou estar indisponível.'
  });
}
