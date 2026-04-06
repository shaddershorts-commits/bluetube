// api/blue-feed.js — Feed de vídeos com paginação por cursor
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK };
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const cursor = req.query.cursor; // ISO timestamp of last seen video's created_at

  try {
    // Build query with cursor-based pagination
    let url = `${SU}/rest/v1/blue_videos?status=eq.active&video_url=neq.null&order=score.desc,created_at.desc&limit=${limit + 1}&select=*`;
    if (cursor) {
      url += `&created_at=lt.${cursor}`;
    }

    const r = await fetch(url, { headers: h });
    if (!r.ok) {
      const err = await r.text();
      console.error('blue-feed error:', r.status, err);
      return res.status(200).json({ videos: [], has_more: false });
    }

    const raw = await r.json();

    // Filter safety: double-check status and video_url
    const safe = raw.filter(v => v.video_url && v.status === 'active');

    // Determine has_more: if we got limit+1 results, there are more
    const has_more = safe.length > limit;
    const videos = has_more ? safe.slice(0, limit) : safe;

    // Next cursor = created_at of last video returned
    const next_cursor = videos.length > 0 ? videos[videos.length - 1].created_at : null;

    // Enrich with creator profiles
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

    return res.status(200).json({ videos: enriched, has_more, next_cursor });
  } catch(err) {
    console.error('blue-feed fatal:', err.message);
    return res.status(500).json({ error: err.message, videos: [], has_more: false });
  }
};
