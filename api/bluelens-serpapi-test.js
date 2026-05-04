// api/bluelens-serpapi-test.js
//
// Endpoint ISOLADO de teste — NAO afeta producao do BlueLens.
// Valida SerpAPI Google Lens com a thumbnail de um Short YouTube.
//
// Custo: 1 busca da quota SerpAPI por chamada.
// Plano free: 250/mes (uso nao-comercial — OK pra validacao tecnica).
//
// Uso:
//   GET /api/bluelens-serpapi-test?url=https://www.youtube.com/shorts/<id>
//   GET /api/bluelens-serpapi-test?url=...&thumbnail=<url-customizada>
//
// Returna estruturado + raw pra avaliar se vale assinar Starter $25/mes.

const SERPAPI_KEY = process.env.SERPAPI_KEY;

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
    if (host.includes('tiktok.com')) return 'tiktok';
    if (host.includes('instagram.com')) return 'instagram';
    if (host === 'twitter.com' || host === 'x.com') return 'twitter';
    if (host.includes('facebook.com') || host.includes('fbsbx.com')) return 'facebook';
    if (host.includes('kwai')) return 'kwai';
    if (host.includes('reddit.com')) return 'reddit';
    if (host.includes('pinterest.com') || host.includes('pinimg.com')) return 'pinterest';
    if (host === 'i.ytimg.com' || host.endsWith('.ytimg.com')) return 'youtube_thumb';
    return 'other';
  } catch { return 'unknown'; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!SERPAPI_KEY) return res.status(500).json({ error: 'SERPAPI_KEY nao configurada na Vercel' });

  const url = req.query?.url;
  if (!url) return res.status(400).json({ error: 'url obrigatorio (Short YouTube)' });

  const youtubeId = extractYouTubeId(url);
  if (!youtubeId) return res.status(400).json({ error: 'URL deve ser de Short/Video YouTube' });

  // Permite override do thumbnail (caso queira testar com frame especifico ou maxres)
  const thumbnailParam = req.query?.thumbnail;
  // hqdefault funciona pra TODOS Shorts; maxres pode 404 em alguns
  const thumbnailUrl = thumbnailParam || `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;

  const startTs = Date.now();

  try {
    const serpUrl = `https://serpapi.com/search?engine=google_lens&url=${encodeURIComponent(thumbnailUrl)}&api_key=${SERPAPI_KEY}`;
    const r = await fetch(serpUrl, { signal: AbortSignal.timeout(55000) });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(502).json({
        error: `SerpAPI HTTP ${r.status}`,
        body: txt.slice(0, 500),
        thumbnail_used: thumbnailUrl,
        timing_ms: Date.now() - startTs,
      });
    }

    const data = await r.json();

    // Erro estruturado da SerpAPI
    if (data.error) {
      return res.status(502).json({
        error: `SerpAPI error: ${data.error}`,
        thumbnail_used: thumbnailUrl,
        timing_ms: Date.now() - startTs,
      });
    }

    const allMatches = data.visual_matches || [];

    // Enriquecer cada match
    const enrichedMatches = allMatches.map(m => ({
      title: m.title,
      link: m.link,
      thumbnail: m.thumbnail,
      source: m.source,
      platform: detectPlatform(m.link),
      youtube_id: extractYouTubeId(m.link),
    }));

    // Stats por plataforma
    const platformCounts = {};
    for (const m of enrichedMatches) {
      platformCounts[m.platform] = (platformCounts[m.platform] || 0) + 1;
    }

    // YouTube IDs unicos achados (excluindo o proprio video)
    const youtubeIdsFound = [...new Set(
      enrichedMatches.map(m => m.youtube_id).filter(Boolean).filter(id => id !== youtubeId)
    )];

    // Matches separados por plataforma (top 20 cada pra nao gigantear response)
    const youtubeMatches = enrichedMatches.filter(m => m.platform === 'youtube').slice(0, 30);
    const tiktokMatches = enrichedMatches.filter(m => m.platform === 'tiktok').slice(0, 20);
    const instagramMatches = enrichedMatches.filter(m => m.platform === 'instagram').slice(0, 20);
    const otherMatches = enrichedMatches.filter(m =>
      !['youtube', 'tiktok', 'instagram', 'youtube_thumb'].includes(m.platform)
    ).slice(0, 20);

    return res.status(200).json({
      ok: true,
      input: {
        url,
        youtube_id: youtubeId,
        thumbnail_used: thumbnailUrl,
      },
      summary: {
        total_visual_matches: allMatches.length,
        platform_counts: platformCounts,
        youtube_ids_found: youtubeIdsFound,
        youtube_count_unique: youtubeIdsFound.length,
      },
      youtube_matches: youtubeMatches,
      tiktok_matches: tiktokMatches,
      instagram_matches: instagramMatches,
      other_matches: otherMatches,
      // Auxiliar (knowledge graph, related)
      knowledge_graph: data.knowledge_graph || null,
      // Debug
      raw_keys_returned: Object.keys(data),
      serpapi_metadata: data.search_metadata ? {
        status: data.search_metadata.status,
        time_taken: data.search_metadata.processed_at,
        google_lens_url: data.search_metadata.google_lens_url,
      } : null,
      timing_ms: Date.now() - startTs,
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message,
      thumbnail_used: thumbnailUrl,
      timing_ms: Date.now() - startTs,
    });
  }
};
