// api/blue-feed.js — Feed de vídeos com paginação por cursor + stats + waitlist
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const action = req.query.action || (req.body && req.body.action);

  // ── CDN HELPER ──────────────────────────────────────────────────────────
  const CDN = process.env.SUPABASE_CDN_URL;
  function applyCDN(url) {
    if (!CDN || !url) return url;
    return url.replace(`${SU}/storage/v1/object/public`, CDN);
  }

  // ── RATE LIMITING ───────────────────────────────────────────────────────
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  async function checkRate(id, endpoint, max, windowMin) {
    try {
      const janela = new Date(Date.now() - windowMin * 60000).toISOString();
      const rr = await fetch(`${SU}/rest/v1/blue_rate_limits?identificador=eq.${encodeURIComponent(id)}&endpoint=eq.${endpoint}&select=requests,janela_inicio`, { headers: h });
      const rows = rr.ok ? await rr.json() : [];
      const row = rows[0];
      if (!row || new Date(row.janela_inicio) < new Date(janela)) {
        fetch(`${SU}/rest/v1/blue_rate_limits`, { method: 'POST', headers: { ...h, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ identificador: id, endpoint, requests: 1, janela_inicio: new Date().toISOString() }) }).catch(() => {});
        return true;
      }
      if (row.requests >= max) return false;
      fetch(`${SU}/rest/v1/blue_rate_limits?identificador=eq.${encodeURIComponent(id)}&endpoint=eq.${endpoint}`, { method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ requests: row.requests + 1 }) }).catch(() => {});
      return true;
    } catch(e) { return true; } // fail open
  }

  // Rate limit feed: 60 req/min per IP
  if (!action && req.method === 'GET') {
    const allowed = await checkRate(ip, 'feed', 60, 1);
    if (!allowed) return res.status(429).json({ error: 'Rate limit exceeded', retry_after: 60 });
  }

  // ── STATS (criadores hoje, vídeos semana, usuários 24h) ──────────────────
  if (action === 'stats') {
    try {
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      const weekAgo = new Date(now - 7*24*60*60*1000).toISOString();
      const dayAgo = new Date(now - 24*60*60*1000).toISOString();
      const [creatorsR, videosR, usersR] = await Promise.all([
        fetch(`${SU}/rest/v1/blue_videos?created_at=gte.${today}T00:00:00Z&status=eq.active&select=user_id`, { headers: h }),
        fetch(`${SU}/rest/v1/blue_videos?created_at=gte.${weekAgo}&status=eq.active&select=id`, { headers: h }),
        fetch(`${SU}/rest/v1/ip_online?pinged_at=gte.${dayAgo}&select=ip_address`, { headers: h }),
      ]);
      const creators = creatorsR.ok ? await creatorsR.json() : [];
      const vids = videosR.ok ? await videosR.json() : [];
      const users = usersR.ok ? await usersR.json() : [];
      return res.status(200).json({
        creators_hoje: new Set(creators.map(c => c.user_id)).size,
        videos_semana: vids.length,
        usuarios_24h: users.length,
      });
    } catch(e) { return res.status(200).json({ creators_hoje: 0, videos_semana: 0, usuarios_24h: 0 }); }
  }

  // ── WAITLIST MONETIZAÇÃO ─────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'waitlist') {
    const { email, user_id } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email obrigatório' });
    try {
      await fetch(`${SU}/rest/v1/blue_monetizacao_waitlist`, {
        method: 'POST',
        headers: { ...h, 'Prefer': 'return=minimal,resolution=ignore' },
        body: JSON.stringify({ email, user_id: user_id || null })
      });
      const countR = await fetch(`${SU}/rest/v1/blue_monetizacao_waitlist?select=id`, { headers: { ...h, 'Prefer': 'count=exact' } });
      const total = parseInt(countR.headers?.get('content-range')?.split('/')[1] || '0');
      return res.status(200).json({ ok: true, posicao_na_lista: total });
    } catch(e) { return res.status(200).json({ ok: false, error: e.message }); }
  }

  // ── POPUP IMPRESSION ─────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'popup_impression') {
    const { popup_tipo, user_id, converteu } = req.body || {};
    if (!popup_tipo) return res.status(400).json({ error: 'popup_tipo obrigatório' });
    try {
      await fetch(`${SU}/rest/v1/blue_popup_impressoes`, {
        method: 'POST',
        headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ popup_tipo, user_id: user_id || null, converteu: converteu || false })
      });
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(200).json({ ok: false }); }
  }

  // ── POPUP STATS (admin) ──────────────────────────────────────────────────
  if (action === 'popup_stats') {
    try {
      const [impR, wlR] = await Promise.all([
        fetch(`${SU}/rest/v1/blue_popup_impressoes?select=popup_tipo,converteu,created_at&order=created_at.desc&limit=5000`, { headers: h }),
        fetch(`${SU}/rest/v1/blue_monetizacao_waitlist?select=id`, { headers: { ...h, 'Prefer': 'count=exact' } }),
      ]);
      const imps = impR.ok ? await impR.json() : [];
      const wlTotal = parseInt(wlR.headers?.get('content-range')?.split('/')[1] || '0');
      const tipos = ['pioneiro', 'futuro', 'monetizacao'];
      const stats = {};
      tipos.forEach(t => {
        const tipImps = imps.filter(i => i.popup_tipo === t);
        stats[t] = { impressoes: tipImps.length, conversoes: tipImps.filter(i => i.converteu).length };
        stats[t].taxa = tipImps.length > 0 ? ((stats[t].conversoes / tipImps.length) * 100).toFixed(1) : '0';
      });
      return res.status(200).json({ ...stats, waitlist_total: wlTotal });
    } catch(e) { return res.status(200).json({ waitlist_total: 0 }); }
  }

  // ── POPUP CONVERSIONS (admin — quem aceitou o desafio + seguidores) ─────
  if (action === 'popup_conversions') {
    try {
      // Busca conversões com user_id real (não null)
      const impR = await fetch(`${SU}/rest/v1/blue_popup_impressoes?converteu=eq.true&user_id=not.is.null&select=user_id,popup_tipo,created_at&order=created_at.desc&limit=200`, { headers: h });
      const imps = impR.ok ? await impR.json() : [];
      if (!imps.length) return res.status(200).json({ conversions: [] });

      // Deduplica por user_id (mantém a mais recente)
      const seen = new Set();
      const unique = imps.filter(i => { if (seen.has(i.user_id)) return false; seen.add(i.user_id); return true; });
      const userIds = unique.map(i => i.user_id);

      // Busca perfis
      const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=in.(${userIds.join(',')})&select=user_id,username,display_name,avatar_url`, { headers: h });
      const profiles = pR.ok ? await pR.json() : [];
      const profMap = {};
      profiles.forEach(p => { profMap[p.user_id] = p; });

      // Busca contagem de seguidores para cada user
      const fR = await fetch(`${SU}/rest/v1/blue_follows?following_id=in.(${userIds.join(',')})&select=following_id`, { headers: h });
      const follows = fR.ok ? await fR.json() : [];
      const followerCount = {};
      follows.forEach(f => { followerCount[f.following_id] = (followerCount[f.following_id] || 0) + 1; });

      // Busca contagem de vídeos postados
      const vR = await fetch(`${SU}/rest/v1/blue_videos?user_id=in.(${userIds.join(',')})&status=eq.active&select=user_id`, { headers: h });
      const vids = vR.ok ? await vR.json() : [];
      const videoCount = {};
      vids.forEach(v => { videoCount[v.user_id] = (videoCount[v.user_id] || 0) + 1; });

      const conversions = unique.map(i => ({
        user_id: i.user_id,
        popup_tipo: i.popup_tipo,
        accepted_at: i.created_at,
        profile: profMap[i.user_id] || null,
        followers: followerCount[i.user_id] || 0,
        videos: videoCount[i.user_id] || 0,
      }));

      return res.status(200).json({ conversions });
    } catch(e) { return res.status(200).json({ conversions: [], error: e.message }); }
  }

  // ── HASHTAG SEARCH ───────────────────────────────────────────────────────
  if (action === 'hashtag-search') {
    const q = (req.query.q || '').toLowerCase().replace(/^#/, '');
    if (!q) return res.status(200).json({ hashtags: [] });
    try {
      const r = await fetch(`${SU}/rest/v1/blue_hashtags?nome=ilike.${encodeURIComponent(q)}*&order=usos.desc&limit=10&select=id,nome,usos,trending`, { headers: h });
      return res.status(200).json({ hashtags: r.ok ? await r.json() : [] });
    } catch(e) { return res.status(200).json({ hashtags: [] }); }
  }

  // ── TRENDING HASHTAGS ──────────────────────────────────────────────────
  if (action === 'trending-hashtags') {
    try {
      const r = await fetch(`${SU}/rest/v1/blue_hashtags?order=usos.desc&limit=20&select=id,nome,usos,trending`, { headers: h });
      return res.status(200).json({ hashtags: r.ok ? await r.json() : [] });
    } catch(e) { return res.status(200).json({ hashtags: [] }); }
  }

  // ── HASHTAG FEED ───────────────────────────────────────────────────────
  if (action === 'hashtag-feed') {
    const hashtag = (req.query.hashtag || '').toLowerCase().replace(/^#/, '');
    if (!hashtag) return res.status(400).json({ error: 'hashtag obrigatória' });
    try {
      // Find hashtag ID
      const hR = await fetch(`${SU}/rest/v1/blue_hashtags?nome=eq.${encodeURIComponent(hashtag)}&select=id,usos`, { headers: h });
      const hArr = hR.ok ? await hR.json() : [];
      if (!hArr.length) return res.status(200).json({ videos: [], has_more: false, hashtag: { nome: hashtag, usos: 0 } });
      const hId = hArr[0].id;
      // Get video IDs from junction table
      const vjR = await fetch(`${SU}/rest/v1/blue_video_hashtags?hashtag_id=eq.${hId}&select=video_id&limit=50`, { headers: h });
      const vIds = (vjR.ok ? await vjR.json() : []).map(r => r.video_id);
      if (!vIds.length) return res.status(200).json({ videos: [], has_more: false, hashtag: hArr[0] });
      // Get videos
      const vR = await fetch(`${SU}/rest/v1/blue_videos?id=in.(${vIds.join(',')})&status=eq.active&order=score.desc,created_at.desc&limit=20&select=*`, { headers: h });
      const vids = vR.ok ? await vR.json() : [];
      // Enrich
      const uIds = [...new Set(vids.map(v => v.user_id).filter(Boolean))];
      let profs = {};
      if (uIds.length) {
        const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=in.(${uIds.join(',')})&select=user_id,username,display_name,avatar_url`, { headers: h });
        if (pR.ok) (await pR.json()).forEach(p => { profs[p.user_id] = p; });
      }
      return res.status(200).json({
        videos: vids.map(v => ({ ...v, video_url: applyCDN(v.video_url), thumbnail_url: applyCDN(v.thumbnail_url), creator: profs[v.user_id] || { username: 'blue', display_name: 'Blue' } })),
        has_more: false, hashtag: hArr[0]
      });
    } catch(e) { return res.status(200).json({ videos: [], has_more: false, error: e.message }); }
  }

  // ── UPDATE TRENDING (cron) ─────────────────────────────────────────────
  if (action === 'update-trending') {
    try {
      // Reset all trending
      await fetch(`${SU}/rest/v1/blue_hashtags?trending=eq.true`, { method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' }, body: JSON.stringify({ trending: false }) });
      // Get top 20 by usage
      const r = await fetch(`${SU}/rest/v1/blue_hashtags?order=usos.desc&limit=20&select=id`, { headers: h });
      const top = r.ok ? await r.json() : [];
      if (top.length) {
        await fetch(`${SU}/rest/v1/blue_hashtags?id=in.(${top.map(t => t.id).join(',')})`, {
          method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' }, body: JSON.stringify({ trending: true })
        });
      }
      return res.status(200).json({ ok: true, updated: top.length });
    } catch(e) { return res.status(200).json({ ok: false, error: e.message }); }
  }

  // ── VIDEO PÚBLICO (sem login) ──────────────────────────────────────────
  if (action === 'video-publico') {
    const videoId = req.query.id;
    if (!videoId) return res.status(400).json({ error: 'id obrigatório' });
    try {
      const vR = await fetch(`${SU}/rest/v1/blue_videos?id=eq.${videoId}&status=eq.active&select=*`, { headers: h });
      const vArr = vR.ok ? await vR.json() : [];
      if (!vArr.length) return res.status(404).json({ error: 'Vídeo não encontrado' });
      const v = vArr[0];
      let creator = { username: 'blue', display_name: 'Blue' };
      if (v.user_id) {
        const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${v.user_id}&select=user_id,username,display_name,avatar_url,verificado`, { headers: h });
        if (pR.ok) { const pArr = await pR.json(); if (pArr[0]) creator = pArr[0]; }
      }
      return res.status(200).json({ video: { ...v, video_url: applyCDN(v.video_url), thumbnail_url: applyCDN(v.thumbnail_url), creator } });
    } catch(e) { return res.status(404).json({ error: e.message }); }
  }

  // ── ANALYTICS OVERVIEW ───────────────────────────────────────────────────
  if (action === 'analytics-overview') {
    const { token, periodo } = req.query;
    if (!token) return res.status(401).json({ error: 'token obrigatório' });
    const AK = process.env.SUPABASE_ANON_KEY || SK;
    try {
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
      const uid = (await uR.json()).id;
      const days = parseInt(periodo) || 28;
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const prevSince = new Date(Date.now() - days * 2 * 86400000).toISOString();

      // Current period videos
      const [vR, fR, fPrevR, aR] = await Promise.all([
        fetch(`${SU}/rest/v1/blue_videos?user_id=eq.${uid}&status=eq.active&select=id,title,thumbnail_url,views,likes,comments,saves,completion_rate,skip_rate,score,created_at,duration&order=created_at.desc`, { headers: h }),
        fetch(`${SU}/rest/v1/blue_follows?following_id=eq.${uid}&created_at=gte.${since}&select=id`, { headers: h }),
        fetch(`${SU}/rest/v1/blue_follows?following_id=eq.${uid}&created_at=gte.${prevSince}&created_at=lt.${since}&select=id`, { headers: h }),
        fetch(`${SU}/rest/v1/blue_video_analytics?user_id=eq.${uid}&created_at=gte.${since}&select=percentual_assistido,origem,created_at&order=created_at.desc&limit=5000`, { headers: h }),
      ]);
      const vids = vR.ok ? await vR.json() : [];
      const newFollowers = fR.ok ? (await fR.json()).length : 0;
      const prevFollowers = fPrevR.ok ? (await fPrevR.json()).length : 0;
      const analytics = aR.ok ? await aR.json() : [];

      const totalViews = vids.reduce((s, v) => s + (v.views || 0), 0);
      const totalLikes = vids.reduce((s, v) => s + (v.likes || 0), 0);
      const totalComments = vids.reduce((s, v) => s + (v.comments || 0), 0);
      const engRate = totalViews > 0 ? ((totalLikes + totalComments) / totalViews * 100).toFixed(1) : '0';
      const followerGrowth = prevFollowers > 0 ? ((newFollowers - prevFollowers) / prevFollowers * 100).toFixed(0) : newFollowers > 0 ? '+100' : '0';

      // Origem breakdown
      const origemMap = {};
      analytics.forEach(a => { const o = a.origem || 'feed'; origemMap[o] = (origemMap[o] || 0) + 1; });

      // Heatmap: day x hour
      const heatmap = Array(7).fill(null).map(() => Array(24).fill(0));
      analytics.forEach(a => {
        const d = new Date(a.created_at);
        heatmap[d.getDay()][d.getHours()]++;
      });

      // Best hours
      let bestSlots = [];
      heatmap.forEach((day, di) => { day.forEach((count, hi) => { if (count > 0) bestSlots.push({ day: di, hour: hi, count }); }); });
      bestSlots.sort((a, b) => b.count - a.count);

      return res.status(200).json({
        overview: { totalViews, totalLikes, totalComments, engRate, newFollowers, followerGrowth, alcance: totalViews },
        videos: vids.map(v => ({ ...v, thumbnail_url: applyCDN(v.thumbnail_url) })),
        origem: origemMap,
        heatmap,
        bestHours: bestSlots.slice(0, 5),
        periodo: days,
      });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── ANALYTICS VIDEO (retenção detalhada) ────────────────────────────────
  if (action === 'analytics-video') {
    const { video_id: avId, token } = req.query;
    if (!token || !avId) return res.status(400).json({ error: 'token e video_id obrigatórios' });
    try {
      const aR = await fetch(`${SU}/rest/v1/blue_video_analytics?video_id=eq.${avId}&select=percentual_assistido,origem,created_at&limit=2000`, { headers: h });
      const data = aR.ok ? await aR.json() : [];
      // Retention curve: for each 10% bucket, count how many viewers reached it
      const total = data.length || 1;
      const retention = [];
      for (let p = 0; p <= 100; p += 10) {
        retention.push({ percentual: p, viewers: data.filter(d => (d.percentual_assistido || 0) >= p).length, pct: Math.round(data.filter(d => (d.percentual_assistido || 0) >= p).length / total * 100) });
      }
      const origemMap = {};
      data.forEach(d => { const o = d.origem || 'feed'; origemMap[o] = (origemMap[o] || 0) + 1; });
      return res.status(200).json({ retention, origem: origemMap, total_views: total });
    } catch(e) { return res.status(200).json({ retention: [], error: e.message }); }
  }

  // ── TRACK VIEW (analytics logging from frontend) ────────────────────────
  if (req.method === 'POST' && action === 'track-view') {
    const { video_id: tvId, percentual, origem, token } = req.body || {};
    if (!tvId) return res.status(200).json({ ok: true });
    let uid = null;
    if (token) {
      try {
        const AK = process.env.SUPABASE_ANON_KEY || SK;
        const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
        if (uR.ok) uid = (await uR.json()).id;
      } catch(e) {}
    }
    fetch(`${SU}/rest/v1/blue_video_analytics`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ video_id: tvId, user_id: uid, percentual_assistido: percentual || 0, origem: origem || 'feed' })
    }).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  // ── BUSCA COMPLETA ──────────────────────────────────────────────────────
  if (action === 'busca') {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(200).json({ usuarios: [], hashtags: [], videos: [] });
    try {
      const [uR, hR, vR] = await Promise.all([
        fetch(`${SU}/rest/v1/blue_profiles?or=(username.ilike.*${encodeURIComponent(q)}*,display_name.ilike.*${encodeURIComponent(q)}*)&select=user_id,username,display_name,avatar_url,verificado&limit=10`, { headers: h }),
        fetch(`${SU}/rest/v1/blue_hashtags?nome=ilike.*${encodeURIComponent(q)}*&order=usos.desc&limit=10&select=id,nome,usos,trending`, { headers: h }),
        fetch(`${SU}/rest/v1/blue_videos?status=eq.active&or=(title.ilike.*${encodeURIComponent(q)}*,description.ilike.*${encodeURIComponent(q)}*)&order=score.desc&limit=10&select=id,title,thumbnail_url,views,likes,user_id`, { headers: h }),
      ]);
      return res.status(200).json({
        usuarios: uR.ok ? await uR.json() : [],
        hashtags: hR.ok ? await hR.json() : [],
        videos: vR.ok ? await vR.json() : [],
      });
    } catch(e) { return res.status(200).json({ usuarios: [], hashtags: [], videos: [], error: e.message }); }
  }

  // ── VERIFICAÇÃO: SOLICITAR ──────────────────────────────────────────────
  if (req.method === 'POST' && action === 'solicitar-verificacao') {
    const { token, motivo, redes_sociais } = req.body || {};
    if (!token) return res.status(401).json({ error: 'token obrigatório' });
    try {
      const AK = process.env.SUPABASE_ANON_KEY || SK;
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
      const uid = (await uR.json()).id;
      // Check if already pending
      const eR = await fetch(`${SU}/rest/v1/blue_verificacao_solicitacoes?user_id=eq.${uid}&status=eq.pendente&select=id`, { headers: h });
      if (eR.ok && (await eR.json()).length) return res.status(200).json({ ok: true, message: 'Solicitação já enviada' });
      await fetch(`${SU}/rest/v1/blue_verificacao_solicitacoes`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ user_id: uid, motivo: motivo || '', redes_sociais: redes_sociais || {}, status: 'pendente' }) });
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── LIMPAR RATE LIMITS (cron diário) ────────────────────────────────────
  if (action === 'limpar-rate-limits') {
    try {
      const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
      await fetch(`${SU}/rest/v1/blue_rate_limits?janela_inicio=lt.${oneDayAgo}`, { method: 'DELETE', headers: h });
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(200).json({ ok: false }); }
  }

  // ── FEED INTELIGENTE ────────────────────────────────────────────────────
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const cursor = req.query.cursor;
  const feedToken = req.query.token;

  // Load user preferences if logged in
  let userPrefs = null;
  if (feedToken) {
    try {
      const AK = process.env.SUPABASE_ANON_KEY || SK;
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + feedToken } });
      if (uR.ok) {
        const uid = (await uR.json()).id;
        // Get following list + recent seen
        const [flR, seenR] = await Promise.all([
          fetch(`${SU}/rest/v1/blue_follows?follower_id=eq.${uid}&select=following_id`, { headers: h }),
          fetch(`${SU}/rest/v1/blue_feed_seen?user_id=eq.${uid}&select=video_id&order=seen_at.desc&limit=100`, { headers: h }),
        ]);
        const following = flR.ok ? (await flR.json()).map(f => f.following_id) : [];
        const seen = seenR.ok ? (await seenR.json()).map(s => s.video_id) : [];
        userPrefs = { uid, following, seen };
      }
    } catch(e) {}
  }

  try {
    let url = `${SU}/rest/v1/blue_videos?status=eq.active&video_url=neq.null&order=score.desc,created_at.desc&limit=${limit * 3}&select=*`;
    if (cursor) url += `&created_at=lt.${cursor}`;

    const r = await fetch(url, { headers: h });
    if (!r.ok) {
      const err = await r.text();
      console.error('blue-feed error:', r.status, err);
      return res.status(200).json({ videos: [], has_more: false });
    }

    let raw = (await r.json()).filter(v => v.video_url && v.status === 'active');

    // Apply intelligent scoring if user is logged in
    if (userPrefs) {
      raw = raw.filter(v => !userPrefs.seen.includes(v.id)); // remove already seen
      raw.forEach(v => {
        let s = v.score || 0;
        // Boost followed creators
        if (userPrefs.following.includes(v.user_id)) s += 20;
        // Recency bonus
        const hoursAgo = (Date.now() - new Date(v.created_at)) / 3600000;
        if (hoursAgo < 6) s += 15;
        else if (hoursAgo < 24) s += 8;
        // Engagement bonus
        const views = v.views || 1;
        const engRate = ((v.likes || 0) * 3 + (v.saves || 0) * 5) / views;
        s += Math.min(20, engRate * 10);
        v._feedScore = s;
      });
      raw.sort((a, b) => (b._feedScore || b.score || 0) - (a._feedScore || a.score || 0));
    }

    const videos = raw.slice(0, limit);
    const has_more = raw.length > limit;
    const next_cursor = videos.length > 0 ? videos[videos.length - 1].created_at : null;

    // Enrich with creator profiles
    const userIds = [...new Set(videos.map(v => v.user_id).filter(Boolean))];
    let profiles = {};
    if (userIds.length > 0) {
      const pR = await fetch(
        `${SU}/rest/v1/blue_profiles?user_id=in.(${userIds.join(',')})&select=user_id,username,display_name,avatar_url,verificado`,
        { headers: h }
      );
      if (pR.ok) (await pR.json()).forEach(p => { profiles[p.user_id] = p; });
    }

    const enriched = videos.map(v => ({
      ...v,
      video_url: applyCDN(v.video_url),
      thumbnail_url: applyCDN(v.thumbnail_url),
      creator: profiles[v.user_id] || { username: 'blue', display_name: 'Blue' }
    }));

    return res.status(200).json({ videos: enriched, has_more, next_cursor });
  } catch(err) {
    console.error('blue-feed fatal:', err.message);
    return res.status(500).json({ error: err.message, videos: [], has_more: false });
  }
};
