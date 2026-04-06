// api/blue-profile.js — Perfil completo do Blue
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  const action = req.method === 'GET' ? req.query.action : req.body?.action;
  const token  = req.method === 'GET' ? req.query.token  : req.body?.token;

  // Verifica usuário (quando token fornecido)
  let userId = null, userEmail = null;
  if (token) {
    const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
    const ud = await uR.json();
    userId = ud.id; userEmail = ud.email;
  }

  // GET notifications
  if (req.method === 'GET' && action === 'notifications') {
    if (!userId) return res.status(401).json({ error: 'Login necessário' });
    try {
      const nr = await fetch(
        `${SU}/rest/v1/blue_notifications?user_id=eq.${userId}&order=created_at.desc&limit=20&select=*`,
        { headers: h }
      );
      const notifs = nr.ok ? await nr.json() : [];
      const unread = notifs.filter(n => !n.read).length;
      return res.status(200).json({ notifications: notifs, unread });
    } catch(e) { return res.status(200).json({ notifications: [], unread: 0 }); }
  }

  // POST mark notifications as read
  if (req.method === 'POST' && action === 'mark-notifications-read') {
    if (!userId) return res.status(401).json({ error: 'Login necessário' });
    try {
      await fetch(
        `${SU}/rest/v1/blue_notifications?user_id=eq.${userId}&read=eq.false`,
        { method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ read: true }) }
      );
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(200).json({ ok: false }); }
  }

  // GET analytics
  if (req.method === 'GET' && action === 'analytics') {
    if (!userId) return res.status(401).json({ error: 'Login necessário' });
    try {
      const vr = await fetch(
        `${SU}/rest/v1/blue_videos?user_id=eq.${userId}&status=eq.active&select=id,title,thumbnail_url,views,likes,saves,comments,completion_rate,skip_rate,created_at&order=views.desc`,
        { headers: h }
      );
      const vids = vr.ok ? await vr.json() : [];
      const stats = {
        total_views: vids.reduce((s, v) => s + (v.views || 0), 0),
        total_likes: vids.reduce((s, v) => s + (v.likes || 0), 0),
        total_saves: vids.reduce((s, v) => s + (v.saves || 0), 0),
        total_comments: vids.reduce((s, v) => s + (v.comments || 0), 0),
        avg_completion: vids.length > 0 ? vids.reduce((s, v) => s + (v.completion_rate || 0), 0) / vids.length : 0,
        video_count: vids.length,
      };
      return res.status(200).json({ stats, videos: vids });
    } catch(e) { return res.status(200).json({ stats: {}, videos: [], error: e.message }); }
  }

  // GET profile — by token, username, or public user_id
  if (req.method === 'GET' && (!action || action === 'profile')) {
    const username = req.query.username;
    const queryUserId = req.query.user_id;
    try {
      let profile;
      if (username) {
        const r = await fetch(`${SU}/rest/v1/blue_profiles?username=eq.${encodeURIComponent(username)}&select=*`, { headers: h });
        const d = r.ok ? await r.json() : [];
        profile = d[0];
      } else if (queryUserId) {
        // Busca pública por user_id (sem auth necessária)
        const r = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${encodeURIComponent(queryUserId)}&select=*`, { headers: h });
        const d = r.ok ? await r.json() : [];
        profile = d[0];
        return res.status(200).json({ profile: profile || null });
      } else if (userId) {
        const r = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${userId}&select=*`, { headers: h });
        const d = r.ok ? await r.json() : [];
        profile = d[0];
        if (!profile) {
          // Auto-cria
          const uname = (userEmail||'user').split('@')[0].replace(/[^a-z0-9_]/gi,'').toLowerCase().slice(0,20)||'blue'+userId.slice(0,6);
          const nR = await fetch(`${SU}/rest/v1/blue_profiles`, {
            method: 'POST', headers: { ...h, Prefer: 'return=representation' },
            body: JSON.stringify({ user_id: userId, email: userEmail||'', username: uname, display_name: uname })
          });
          profile = (await nR.json())[0];
        }
      }
      return res.status(200).json({ profile: profile || null });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // GET videos do usuário
  if (req.method === 'GET' && action === 'my-videos') {
    if (!userId) return res.status(401).json({ error: 'Login necessário' });
    try {
      const r = await fetch(`${SU}/rest/v1/blue_videos?user_id=eq.${userId}&status=neq.deleted&order=created_at.desc&select=*`, { headers: h });
      return res.status(200).json({ videos: r.ok ? await r.json() : [] });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // POST update profile
  if (req.method === 'POST' && action === 'update') {
    if (!userId) return res.status(401).json({ error: 'Login necessário' });
    const { display_name, bio, avatar_data, username } = req.body;
    try {
      const patch = { updated_at: new Date().toISOString() };
      if (display_name !== undefined) patch.display_name = display_name.slice(0,50);
      if (bio !== undefined) patch.bio = bio.slice(0,150);
      if (username) {
        const clean = username.toLowerCase().replace(/[^a-z0-9_.]/g,'').slice(0,30);
        if (clean.length > 2) patch.username = clean;
      }
      // Avatar upload
      if (avatar_data && avatar_data.length < 2000000) {
        const avatarPath = `avatars/${userId}/avatar.jpg`;
        const buf = Buffer.from(avatar_data.replace(/^data:image\/\w+;base64,/,''), 'base64');
        const aR = await fetch(`${SU}/storage/v1/object/blue-videos/${avatarPath}`, {
          method: 'POST', headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
          body: buf
        });
        if (aR.ok) patch.avatar_url = `${SU}/storage/v1/object/public/blue-videos/${avatarPath}`;
      }
      await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${userId}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(patch)
      });
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // POST edit video
  if (req.method === 'POST' && action === 'edit-video') {
    if (!userId) return res.status(401).json({ error: 'Login necessário' });
    const { video_id, title, description } = req.body;
    if (!video_id) return res.status(400).json({ error: 'video_id obrigatório' });
    try {
      // Verifica que o vídeo é do usuário
      const vR = await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}&user_id=eq.${userId}&select=id`, { headers: h });
      const vd = await vR.json();
      if (!vd.length) return res.status(403).json({ error: 'Sem permissão' });
      await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ title: (title||'').slice(0,100), description: (description||'').slice(0,500), updated_at: new Date().toISOString() })
      });
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // POST delete video
  if (req.method === 'POST' && action === 'delete-video') {
    if (!userId) return res.status(401).json({ error: 'Login necessário' });
    const { video_id } = req.body;
    if (!video_id) return res.status(400).json({ error: 'video_id obrigatório' });
    try {
      const vR = await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}&user_id=eq.${userId}&select=id`, { headers: h });
      const vd = await vR.json();
      if (!vd.length) return res.status(403).json({ error: 'Sem permissão' });
      // Soft delete
      await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'deleted', updated_at: new Date().toISOString() })
      });
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(400).json({ error: 'Ação inválida' });
};
