// api/blue-search.js — Search videos and users in Blue
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK };

  const q = (req.query.q || '').trim();
  const type = req.query.type || 'all';
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  // Trending (no query)
  if (!q || q.length < 2) {
    try {
      const tr = await fetch(`${SU}/rest/v1/blue_videos?status=eq.active&video_url=neq.null&order=views.desc&limit=5&select=id,title,thumbnail_url,views,user_id`, { headers: h });
      const trending = tr.ok ? await tr.json() : [];
      return res.status(200).json({ videos: trending, users: [], trending: true });
    } catch(e) { return res.status(200).json({ videos: [], users: [], trending: true }); }
  }

  const safeQ = q.replace(/['"\\%_]/g, '');
  const results = { videos: [], users: [] };

  try {
    if (type === 'all' || type === 'videos') {
      const vr = await fetch(
        `${SU}/rest/v1/blue_videos?status=eq.active&video_url=neq.null&or=(title.ilike.*${encodeURIComponent(safeQ)}*,description.ilike.*${encodeURIComponent(safeQ)}*)&order=views.desc&limit=${limit}&select=id,title,description,thumbnail_url,views,likes,user_id,created_at`,
        { headers: h }
      );
      if (vr.ok) results.videos = await vr.json();
    }

    if (type === 'all' || type === 'users') {
      const ur = await fetch(
        `${SU}/rest/v1/blue_profiles?or=(username.ilike.*${encodeURIComponent(safeQ)}*,display_name.ilike.*${encodeURIComponent(safeQ)}*)&limit=${limit}&select=user_id,username,display_name,avatar_url,bio`,
        { headers: h }
      );
      if (ur.ok) results.users = await ur.json();
    }

    return res.status(200).json(results);
  } catch(e) {
    return res.status(500).json({ error: e.message, videos: [], users: [] });
  }
};
