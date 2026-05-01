// api/instagram-feed.js
//
// Endpoint publico que retorna lista de posts ativos do Instagram pro
// carrossel da home. Sem auth (publico). Cache em memoria 5min pra
// reduzir hits no Supabase.
//
// Frontend chama em /api/instagram-feed → renderiza cada URL como
// <blockquote class="instagram-media"> que o embed.js oficial do
// Instagram transforma em card visual com thumbnail + caption.

let _cache = null;
let _cacheAt = 0;
const TTL_MS = 5 * 60 * 1000;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Cache hit
  if (_cache && (Date.now() - _cacheAt) < TTL_MS) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json({ ..._cache, cached: true });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'config_missing' });
  }

  try {
    const supaHeaders = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
    // Busca posts + foto de perfil em paralelo (foto vem da tabela site_kv)
    const [postsR, kvR] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/instagram_posts?active=eq.true&select=id,url,caption&order=sort_order.asc,added_at.desc`,
        { headers: supaHeaders }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/site_kv?key=eq.instagram_profile_photo_url&select=value`,
        { headers: supaHeaders }
      ).catch(() => null),
    ]);
    if (!postsR.ok) return res.status(500).json({ error: 'Supabase ' + postsR.status });
    const posts = await postsR.json();
    const kvRows = kvR && kvR.ok ? await kvR.json().catch(() => []) : [];
    const photoUrl = kvRows[0]?.value || null;
    const payload = {
      ok: true,
      count: posts.length,
      profile: {
        username: 'bluetubevirais',
        url: 'https://www.instagram.com/bluetubevirais/',
        display_name: 'BlueTube Virais',
        photo_url: photoUrl,
      },
      posts: posts.map(p => ({ id: p.id, url: p.url, caption: p.caption })),
    };
    _cache = payload;
    _cacheAt = Date.now();
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
