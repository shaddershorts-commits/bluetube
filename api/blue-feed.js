// api/blue-feed.js — Feed de vídeos com algoritmo de recomendação
// GET /api/blue-feed?session=xxx&uid=xxx&limit=10&offset=0

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK };
  const { session, uid, limit = 8, offset = 0 } = req.query;

  try {
    const lim = Math.min(parseInt(limit) || 8, 20);

    // ── Busca vídeos com algoritmo híbrido ────────────────────────────────
    // 60% alto desempenho + 25% novos + 15% aleatório
    const highPerf = Math.ceil(lim * 0.60);
    const newVids  = Math.ceil(lim * 0.25);
    const random   = lim - highPerf - newVids;

    // IDs já vistos para esta sessão (evita repetição)
    let seenIds = [];
    if (session || uid) {
      const key = uid ? `user_id=eq.${uid}` : `session_id=eq.${session}`;
      const seenR = await fetch(
        `${SU}/rest/v1/blue_feed_seen?${key}&select=video_id&order=seen_at.desc&limit=50`,
        { headers: h }
      );
      if (seenR.ok) {
        const seenData = await seenR.json();
        seenIds = seenData.map(s => s.video_id);
      }
    }

    const notInFilter = seenIds.length > 0
      ? `&id=not.in.(${seenIds.join(',')})` : '';

    const ago24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const ago1h  = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const [perfRes, newRes, randRes] = await Promise.all([
      // Alto desempenho
      fetch(`${SU}/rest/v1/blue_videos?status=eq.active&order=score.desc${notInFilter}&limit=${highPerf}&select=*`, { headers: h }),
      // Novos (< 24h) com boa fase de teste
      fetch(`${SU}/rest/v1/blue_videos?status=eq.active&created_at=gte.${ago24h}${notInFilter}&order=created_at.desc&limit=${newVids}&select=*`, { headers: h }),
      // Aleatório (para descoberta)
      fetch(`${SU}/rest/v1/blue_videos?status=eq.active${notInFilter}&order=random()&limit=${random}&select=*`, { headers: h }),
    ]);

    const [perfData, newData, randData] = await Promise.all([
      perfRes.ok ? perfRes.json() : [],
      newRes.ok ? newRes.json() : [],
      randRes.ok ? randRes.json() : [],
    ]);

    // Merge e deduplica
    const seen = new Set();
    const videos = [];
    for (const v of [...perfData, ...newData, ...randData]) {
      if (!seen.has(v.id) && v.video_url) {
        seen.add(v.id);
        videos.push(v);
      }
      if (videos.length >= lim) break;
    }

    // Busca perfis dos criadores
    const userIds = [...new Set(videos.map(v => v.user_id))];
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

    // Enriquece vídeos com perfil
    const enriched = videos.map(v => ({
      ...v,
      creator: profiles[v.user_id] || { username: 'criador', display_name: 'Criador' }
    }));

    // Embaralha levemente para não ser sempre a mesma ordem
    for (let i = enriched.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [enriched[i], enriched[j]] = [enriched[j], enriched[i]];
    }

    return res.status(200).json({ videos: enriched, total: enriched.length });
  } catch(err) {
    console.error('blue-feed error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
