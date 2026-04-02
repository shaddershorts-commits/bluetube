// api/blue-feed.js — Feed de vídeos simples e confiável
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK };
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  try {
    // Busca todos os vídeos ativos ordenados por score e data
    const r = await fetch(
      `${SU}/rest/v1/blue_videos?status=eq.active&order=score.desc,created_at.desc&limit=${limit}&select=*`,
      { headers: h }
    );

    if (!r.ok) {
      const err = await r.text();
      console.error('blue-feed error:', r.status, err);
      return res.status(200).json({ videos: [], error: r.status + ': ' + err.slice(0,100) });
    }

    const videos = await r.json();

    // Busca perfis dos criadores
    const userIds = [...new Set(videos.map(v => v.user_id).filter(Boolean))];
    let profiles = {};
    if (userIds.length > 0) {
      const pR = await fetch(
        `${SU}/rest/v1/blue_profiles?user_id=in.(${userIds.join(',')})&select=user_id,username,display_name,avatar_url`,
        { headers: h }
      );
      if (pR.ok) {
        const pData = await pR.json();
        pData.forEach(p => { profiles[p.user_id] = p; });
      }
    }

    const enriched = videos.map(v => ({
      ...v,
      creator: profiles[v.user_id] || { username: 'blue', display_name: 'Blue' }
    }));

    return res.status(200).json({ videos: enriched });
  } catch(err) {
    console.error('blue-feed fatal:', err.message);
    return res.status(500).json({ error: err.message, videos: [] });
  }
};
