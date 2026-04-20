// api/blue-feed.js — Feed de vídeos com paginação por cursor + stats + waitlist
const { cacheGetOrSet, cacheDel } = require('./_helpers/cache');
const { checkBan } = require('./_helpers/checkBan');
const { dbRetry } = require('./_helpers/db');

// Wrapper minimo: retry+circuit-breaker em fetches criticos ao Supabase.
// So joga pro retry em 5xx/network (client errors 4xx nao disparam o breaker).
async function fetchDb(url, init) {
  return dbRetry(async () => {
    const r = await fetch(url, init);
    if (r.status >= 500 || r.status === 0) {
      throw new Error(`supabase ${r.status}`);
    }
    return r;
  });
}

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
          body: JSON.stringify({ identificador: id, endpoint, requests: 1, janela_inicio: new Date().toISOString() }) }).catch(e => console.error('[blue-feed:rate-insert]', e?.message));
        return true;
      }
      if (row.requests >= max) return false;
      fetch(`${SU}/rest/v1/blue_rate_limits?identificador=eq.${encodeURIComponent(id)}&endpoint=eq.${endpoint}`, { method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ requests: row.requests + 1 }) }).catch(e => console.error('[blue-feed:rate-patch]', e?.message));
      return true;
    } catch(e) { return true; } // fail open
  }

  // Rate limit feed: 60 req/min per IP
  if (!action && req.method === 'GET') {
    const allowed = await checkRate(ip, 'feed', 60, 1);
    if (!allowed) return res.status(429).json({ error: 'Rate limit exceeded', retry_after: 60 });
  }

  // ── STATS (criadores hoje, vídeos semana, usuários 24h) — cached 5min ───
  if (action === 'stats') {
    try {
      const data = await cacheGetOrSet('blue:stats', async () => {
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
        return { creators_hoje: new Set(creators.map(c => c.user_id)).size, videos_semana: vids.length, usuarios_24h: users.length };
      }, 300);
      return res.status(200).json(data);
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

  // ── TRENDING HASHTAGS — cached 30min ─────────────────────────────────
  if (action === 'trending-hashtags') {
    try {
      const data = await cacheGetOrSet('trending:hashtags', async () => {
        const r = await fetch(`${SU}/rest/v1/blue_hashtags?order=usos.desc&limit=20&select=id,nome,usos,trending`, { headers: h });
        return { hashtags: r.ok ? await r.json() : [] };
      }, 1800);
      return res.status(200).json(data);
    } catch(e) { return res.status(200).json({ hashtags: [] }); }
  }

  // Explorar: top videos por views (cache 5min). Usado pra popular a pagina
  // Explorar — antes mostrava so hashtags + texto vazio.
  if (action === 'explorar') {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 30, 50);
      const data = await cacheGetOrSet(`explorar:top:${limit}`, async () => {
        const r = await fetch(
          `${SU}/rest/v1/blue_videos?status=eq.active&video_url=neq.null&order=views.desc.nullslast,created_at.desc&limit=${limit}&select=id,title,thumbnail_url,video_url,views,likes,comments,user_id,created_at,duration`,
          { headers: h }
        );
        const vids = r.ok ? await r.json() : [];
        if (!vids.length) return { videos: [] };
        const uids = [...new Set(vids.map(v => v.user_id).filter(Boolean))];
        let profs = {};
        if (uids.length) {
          const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=in.(${uids.join(',')})&select=user_id,username,display_name,avatar_url,verificado`, { headers: h });
          if (pR.ok) (await pR.json()).forEach(p => { profs[p.user_id] = p; });
        }
        return {
          videos: vids.map(v => ({
            ...v,
            video_url: applyCDN(v.video_url),
            thumbnail_url: applyCDN(v.thumbnail_url),
            creator: profs[v.user_id] || { username: 'blue', display_name: 'Blue' },
          })),
        };
      }, 300);
      return res.status(200).json(data);
    } catch(e) { return res.status(200).json({ videos: [], error: e.message }); }
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

  // ── TRACK VIEW (analytics + algoritmo em tempo real) ────────────────────
  // POST body: { token, video_id, percentual, origem, pulou, replay, curtiu,
  //              salvou, comentou, compartilhou, abriu_perfil, tempo_total_segundos }
  // Registra em blue_video_analytics + blue_feed_historico + atualiza
  // blue_user_interests de forma assincrona (fire-and-forget pros 2 ultimos).
  if (req.method === 'POST' && action === 'track-view') {
    const body = req.body || {};
    const tvId = body.video_id;
    const token = body.token;
    if (!tvId) return res.status(200).json({ ok: true });

    // Resolve user (opcional — visitante ainda grava em analytics)
    let uid = null;
    if (token) {
      try {
        const AK = process.env.SUPABASE_ANON_KEY || SK;
        const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
        if (uR.ok) uid = (await uR.json()).id;
      } catch(e) {}
    }

    const pct = Math.max(0, Math.min(100, parseInt(body.percentual) || 0));
    const pulou = !!body.pulou;

    // Grava em blue_video_analytics (backward-compat com codigo existente)
    fetch(`${SU}/rest/v1/blue_video_analytics`, {
      method: 'POST',
      headers: { ...h, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        video_id: tvId,
        user_id: uid,
        percentual_assistido: pct,
        origem: body.origem || 'feed',
      }),
    }).catch(e => console.error('[blue-feed:analytics]', e?.message));

    // Se nao estiver logado, para aqui — algoritmo personalizado so para logados
    if (!uid) return res.status(200).json({ ok: true });

    // Responde rapido — o resto eh fire-and-forget
    res.status(200).json({ ok: true });

    // Upsert em blue_feed_historico (uma linha por user+video, agrega sinais)
    const historicoPayload = {
      user_id: uid,
      video_id: tvId,
      percentual_assistido: pct,
      pulou,
      replay: !!body.replay,
      curtiu: !!body.curtiu,
      salvou: !!body.salvou,
      comentou: !!body.comentou,
      compartilhou: !!body.compartilhou,
      abriu_perfil: !!body.abriu_perfil,
      tempo_total_segundos: parseInt(body.tempo_total_segundos) || 0,
      updated_at: new Date().toISOString(),
    };

    try {
      await fetch(`${SU}/rest/v1/blue_feed_historico?on_conflict=user_id,video_id`, {
        method: 'POST',
        headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(historicoPayload),
      });
    } catch (e) { console.error('[feed hist]', e.message); return; }

    // Atualiza perfil de interesses (async, nao bloqueia)
    try {
      await atualizarInteresses(uid, tvId, historicoPayload, { SU, h });
    } catch (e) {
      console.error('[feed interesses]', e.message);
    }
    return;
  }

  // ── BUSCA COMPLETA ──────────────────────────────────────────────────────
  // Estrategia: tsvector (FTS) com fallback pra trigram (fuzzy) e ILIKE.
  // Small compute + GIN indexes = resposta <100ms mesmo com milhoes de rows.
  if (action === 'busca') {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(200).json({ usuarios: [], hashtags: [], videos: [] });

    // Sanitize pra tsquery (escapa chars especiais, lowercase, junta com &)
    const ftsQuery = q.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/).filter(Boolean)
      .map(w => `${w}:*`) // prefix match
      .join(' & ');

    if (!ftsQuery) {
      return res.status(200).json({ usuarios: [], hashtags: [], videos: [] });
    }

    try {
      const [uR, hR, vR] = await Promise.all([
        // Usuarios — FTS na coluna search_tsv
        fetch(`${SU}/rest/v1/blue_profiles?search_tsv=fts(portuguese).${encodeURIComponent(ftsQuery)}&select=user_id,username,display_name,avatar_url,verificado&limit=10`, { headers: h }),
        // Hashtags — mantem ILIKE (tabela pequena, rapido)
        fetch(`${SU}/rest/v1/blue_hashtags?nome=ilike.*${encodeURIComponent(q)}*&order=usos.desc&limit=10&select=id,nome,usos,trending`, { headers: h }),
        // Videos — FTS + ordena por score
        fetch(`${SU}/rest/v1/blue_videos?status=eq.active&search_tsv=fts(portuguese).${encodeURIComponent(ftsQuery)}&order=score.desc&limit=10&select=id,title,thumbnail_url,views,likes,user_id`, { headers: h }),
      ]);
      let usuarios = uR.ok ? await uR.json() : [];
      let videos = vR.ok ? await vR.json() : [];

      // Fallback fuzzy (trigram) se FTS nao retornou nada — usuario digitou algo com typo
      if (usuarios.length === 0 || videos.length === 0) {
        const pattern = `%${q}%`;
        const [uFb, vFb] = await Promise.all([
          usuarios.length === 0
            ? fetch(`${SU}/rest/v1/blue_profiles?or=(username.ilike.${encodeURIComponent(pattern)},display_name.ilike.${encodeURIComponent(pattern)})&select=user_id,username,display_name,avatar_url,verificado&limit=10`, { headers: h })
            : null,
          videos.length === 0
            ? fetch(`${SU}/rest/v1/blue_videos?status=eq.active&or=(title.ilike.${encodeURIComponent(pattern)},description.ilike.${encodeURIComponent(pattern)})&order=score.desc&limit=10&select=id,title,thumbnail_url,views,likes,user_id`, { headers: h })
            : null,
        ]);
        if (uFb?.ok) usuarios = await uFb.json();
        if (vFb?.ok) videos = await vFb.json();
      }

      return res.status(200).json({
        usuarios,
        hashtags: hR.ok ? await hR.json() : [],
        videos,
        query: q,
      });
    } catch(e) { return res.status(200).json({ usuarios: [], hashtags: [], videos: [], error: e.message }); }
  }

  // ── AUTOCOMPLETE (sugestoes instantaneas enquanto digita) ──────────────────
  // Usa trigram similarity pra melhor relevance em strings curtas
  if (action === 'busca-sugestoes') {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.status(200).json({ sugestoes: [] });
    try {
      const pattern = `%${q}%`;
      const [uR, hR] = await Promise.all([
        fetch(`${SU}/rest/v1/blue_profiles?or=(username.ilike.${encodeURIComponent(pattern)},display_name.ilike.${encodeURIComponent(pattern)})&select=username,display_name,avatar_url,verificado&limit=5`, { headers: h }),
        fetch(`${SU}/rest/v1/blue_hashtags?nome=ilike.${encodeURIComponent(pattern)}&order=usos.desc&limit=5&select=nome,usos`, { headers: h }),
      ]);
      return res.status(200).json({
        usuarios: uR.ok ? await uR.json() : [],
        hashtags: hR.ok ? await hR.json() : [],
      });
    } catch(e) { return res.status(200).json({ usuarios: [], hashtags: [] }); }
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

  // ── FEED SEGUINDO (tab "Seguindo" — simples, cronologico, so seguidos) ──
  if (action === 'feed-seguindo') {
    const seguindoToken = req.query.token;
    if (!seguindoToken) return res.status(401).json({ error: 'token obrigatorio' });
    const segLimit = Math.min(parseInt(req.query.limit) || 10, 50);
    const segCursor = req.query.cursor;
    try {
      const AK = process.env.SUPABASE_ANON_KEY || SK;
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + seguindoToken } });
      if (!uR.ok) return res.status(401).json({ error: 'token invalido' });
      const uid = (await uR.json()).id;

      const fR = await fetch(`${SU}/rest/v1/blue_follows?follower_id=eq.${uid}&select=following_id`, { headers: h });
      const following = fR.ok ? (await fR.json()).map(f => f.following_id) : [];
      if (!following.length) return res.status(200).json({ videos: [], has_more: false, next_cursor: null });

      // user_id=neq.${uid} blinda contra eventual self-follow — proprio usuario nao aparece no Seguindo.
      let url = `${SU}/rest/v1/blue_videos?status=eq.active&video_url=neq.null&user_id=in.(${following.join(',')})&user_id=neq.${uid}&order=created_at.desc,id.desc&limit=${segLimit + 1}&select=*`;
      if (segCursor) {
        try {
          const decoded = Buffer.from(segCursor, 'base64').toString('utf8');
          const [ts, id] = decoded.split('|');
          if (ts && id) url += `&or=(created_at.lt.${ts},and(created_at.eq.${ts},id.lt.${id}))`;
        } catch(e) {}
      }
      const vR = await fetch(url, { headers: h });
      const vids = vR.ok ? await vR.json() : [];
      const hasMore = vids.length > segLimit;
      const videos = hasMore ? vids.slice(0, segLimit) : vids;
      const last = videos[videos.length - 1];
      const nextCursor = hasMore && last
        ? Buffer.from(`${last.created_at}|${last.id}`, 'utf8').toString('base64')
        : null;

      // Enrich profiles
      const userIds = [...new Set(videos.map(v => v.user_id).filter(Boolean))];
      let profiles = {};
      if (userIds.length) {
        const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=in.(${userIds.join(',')})&select=user_id,username,display_name,avatar_url,verificado`, { headers: h });
        if (pR.ok) (await pR.json()).forEach(p => { profiles[p.user_id] = p; });
      }
      const enriched = videos.map(v => ({
        ...v,
        video_url: applyCDN(v.video_url),
        thumbnail_url: applyCDN(v.thumbnail_url),
        creator: profiles[v.user_id] || { username: 'blue', display_name: 'Blue' },
      }));
      return res.status(200).json({ videos: enriched, has_more: hasMore, next_cursor: nextCursor });
    } catch(e) {
      console.error('feed-seguindo:', e.message);
      return res.status(200).json({ videos: [], has_more: false, error: e.message });
    }
  }

  // ── UPDATE METRICS (cron horario — agrega avg_watch_percent + views_24h) ─
  if (action === 'update-metrics') {
    try {
      const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      // Busca analytics das ultimas 24h agrupadas por video
      const aR = await fetch(
        `${SU}/rest/v1/blue_video_analytics?created_at=gte.${dayAgo}&select=video_id,percentual_assistido&limit=10000`,
        { headers: h }
      );
      const rows = aR.ok ? await aR.json() : [];
      const perVideo = {};
      for (const row of rows) {
        if (!perVideo[row.video_id]) perVideo[row.video_id] = { sum: 0, count: 0 };
        perVideo[row.video_id].count++;
        perVideo[row.video_id].sum += (row.percentual_assistido || 0);
      }
      let atualizados = 0;
      for (const [vid, agg] of Object.entries(perVideo)) {
        const avg = Math.round(agg.sum / agg.count);
        await fetch(`${SU}/rest/v1/blue_videos?id=eq.${vid}`, {
          method: 'PATCH',
          headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify({ avg_watch_percent: avg, views_24h: agg.count }),
        }).catch(e => console.error('[blue-feed:metrics-patch]', e?.message));
        atualizados++;
      }
      return res.status(200).json({ ok: true, videos_atualizados: atualizados });
    } catch(e) {
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  // ── FEED INTELIGENTE (Para Voce) ────────────────────────────────────────
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const cursor = req.query.cursor;
  const feedToken = req.query.token;

  // Cursor format: base64("<created_at>|<id>"). Legacy cursors (plain ISO) fall back to created_at only.
  function decodeCursor(c) {
    if (!c) return null;
    try {
      const decoded = Buffer.from(c, 'base64').toString('utf8');
      const [ts, id] = decoded.split('|');
      if (ts && id && ts.includes('T')) return { ts, id };
    } catch(e) {}
    if (c.includes('T')) return { ts: c, id: null };
    return null;
  }
  function encodeCursor(ts, id) {
    return Buffer.from(`${ts}|${id}`, 'utf8').toString('base64');
  }

  // Load user preferences if logged in
  let userPrefs = null;
  let blockedIds = [];
  if (feedToken) {
    try {
      const AK = process.env.SUPABASE_ANON_KEY || SK;
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + feedToken } });
      if (uR.ok) {
        const uid = (await uR.json()).id;
        const ban = await checkBan(uid, SU, h);
        if (ban) return res.status(403).json({ error: 'Conta suspensa', motivo: ban.motivo, expira_em: ban.expira_em });
        // Following + seen (legacy) + historico (500 mais recentes, fonte da verdade) + blocked + interests
        const [flR, seenR, histR, blkR, intR] = await Promise.all([
          fetch(`${SU}/rest/v1/blue_follows?follower_id=eq.${uid}&select=following_id`, { headers: h }),
          fetch(`${SU}/rest/v1/blue_feed_seen?user_id=eq.${uid}&select=video_id&order=seen_at.desc&limit=100`, { headers: h }),
          fetch(`${SU}/rest/v1/blue_feed_historico?user_id=eq.${uid}&select=video_id&order=created_at.desc&limit=500`, { headers: h }),
          fetch(`${SU}/rest/v1/blue_bloqueios?user_id=eq.${uid}&select=bloqueado_id`, { headers: h }),
          fetch(`${SU}/rest/v1/blue_user_interests?user_id=eq.${uid}&select=*&limit=1`, { headers: h }),
        ]);
        const following = flR.ok ? (await flR.json()).map(f => f.following_id) : [];
        const seenLegacy = seenR.ok ? (await seenR.json()).map(s => s.video_id) : [];
        const seenHist = histR.ok ? (await histR.json()).map(r => r.video_id) : [];
        const seen = [...new Set([...seenLegacy, ...seenHist])];
        blockedIds = blkR.ok ? (await blkR.json()).map(b => b.bloqueado_id) : [];
        const interests = intR.ok ? (await intR.json())[0] || null : null;
        userPrefs = { uid, following, seen, interests };
      }
    } catch(e) {}
  }

  try {
    // ORDER matches cursor dimensions so pagination can't skip rows.
    // Score is applied post-hoc in JS re-rank; keeping score in SQL ORDER would
    // break the (created_at,id) cursor and silently hide newly-posted videos.
    // Exclui videos do proprio usuario logado (nao faz sentido aparecer no For You).
    const excludeSelf = userPrefs?.uid ? `&user_id=neq.${userPrefs.uid}` : '';
    // Select seletivo — apenas campos usados pelo rerank + frontend.
    // Omite embedding (1536 floats = 12KB por video!), description (pesado),
    // e outros campos nao necessarios. Reduz payload em ~80% por video.
    const FEED_FIELDS = 'id,user_id,title,description,hashtags,thumbnail_url,video_url,duration,views,likes,comments,saves,avg_watch_percent,score,nichos,views_24h,created_at';
    let url = `${SU}/rest/v1/blue_videos?status=eq.active&video_url=neq.null${excludeSelf}&order=created_at.desc,id.desc&limit=${limit * 3}&select=${FEED_FIELDS}`;
    const cur = decodeCursor(cursor);
    if (cur) {
      if (cur.id) {
        // Compound predicate: (created_at < ts) OR (created_at = ts AND id < id)
        url += `&or=(created_at.lt.${cur.ts},and(created_at.eq.${cur.ts},id.lt.${cur.id}))`;
      } else {
        url += `&created_at=lt.${cur.ts}`;
      }
    }

    let r;
    try {
      r = await fetchDb(url, { headers: h });
    } catch (e) {
      console.error('blue-feed retry esgotado:', e.message);
      return res.status(200).json({ videos: [], has_more: false });
    }
    if (!r.ok) {
      const err = await r.text();
      console.error('blue-feed error:', r.status, err);
      return res.status(200).json({ videos: [], has_more: false });
    }

    // SQL ja filtrou por status=eq.active. Nao re-checar v.status no JS porque
    // FEED_FIELDS nao inclui 'status' no SELECT — undefined === 'active' = false
    // zerava o feed inteiro. So mantem o guard de video_url defensivamente.
    const rawSql = (await r.json()).filter(v => v.video_url);
    // Cursor advances through SQL ordering (score,created_at,id DESC) — use the LAST
    // SQL row BEFORE client-side filters/re-rank so pagination never skips rows.
    const lastSql = rawSql[rawSql.length - 1];

    let raw = rawSql;
    // Filter out blocked users' content
    if (blockedIds.length) raw = raw.filter(v => !blockedIds.includes(v.user_id));

    // Apply intelligent scoring if user is logged in
    if (userPrefs) {
      // ANTI-FEED-VAZIO: separa nao-vistos e vistos. Se nao-vistos < limit,
      // anexa os vistos no final (preferindo nao-vistos no topo). Garante
      // que o usuario nunca veja "Nenhum video" mesmo apos consumir tudo.
      const seenSet = new Set(userPrefs.seen || []);
      const naoVistos = raw.filter(v => !seenSet.has(v.id));
      if (naoVistos.length >= limit) {
        raw = naoVistos;
      } else {
        const vistos = raw.filter(v => seenSet.has(v.id));
        raw = [...naoVistos, ...vistos];
      }
      const I = userPrefs.interests || null;
      const nichosScore = (I && I.nichos) || {};
      const criadoresFav = Array.isArray(I?.criadores_favoritos) ? I.criadores_favoritos : [];
      const criadoresBloq = Array.isArray(I?.criadores_bloqueados) ? I.criadores_bloqueados : [];
      const tagsPos = Array.isArray(I?.tags_positivas) ? I.tags_positivas : [];
      const tagsNeg = Array.isArray(I?.tags_negativas) ? I.tags_negativas : [];
      const ultimoNicho = I?.ultimo_nicho || null;

      raw.forEach(v => {
        let s = v.score || 0;

        // Engagement de video (sinal mais forte)
        s += (v.avg_watch_percent || 0) * 0.4; // ate 40 pontos
        const views = v.views || 1;
        const likes = v.likes || 0;
        const comments = v.comments || 0;
        const saves = v.saves || 0;
        s += Math.min(20, (likes / views) * 200); // like rate
        s += Math.min(15, (comments / views) * 300); // comment rate
        s += Math.min(10, (saves / views) * 500); // save rate

        // Afinidade com criador
        if (userPrefs.following.includes(v.user_id)) s += 20;
        const fav = criadoresFav.find(c => c.id === v.user_id);
        if (fav) s += (fav.score || 0.5) * 25;
        if (criadoresBloq.includes(v.user_id)) s -= 50;

        // Nichos
        const nichosVideo = (v.nichos && v.nichos.length) ? v.nichos
          : (Array.isArray(v.hashtags) ? v.hashtags.slice(0, 3) : []);
        nichosVideo.forEach(n => {
          const sc = nichosScore[n];
          if (sc != null) s += sc * 30; // ate 30 pontos por nicho ativo
        });

        // Tags
        const hashtags = Array.isArray(v.hashtags) ? v.hashtags : [];
        hashtags.forEach(t => {
          if (tagsPos.includes(t)) s += 5;
          if (tagsNeg.includes(t)) s -= 10;
        });

        // Recencia
        const hoursAgo = (Date.now() - new Date(v.created_at)) / 3600000;
        if (hoursAgo < 1) s += 20;
        else if (hoursAgo < 6) s += 15;
        else if (hoursAgo < 24) s += 10;
        else if (hoursAgo < 72) s += 5;
        else if (hoursAgo > 168) s -= 5;

        // Viralizando (velho mas com views_24h alto)
        if (hoursAgo > 24 && (v.views_24h || 0) > 1000) s += 10;

        // Diversificacao: penaliza se mesmo nicho do ultimo assistido
        if (ultimoNicho && nichosVideo.includes(ultimoNicho)) s -= 15;

        v._feedScore = Math.max(0, s);
      });

      raw.sort((a, b) => (b._feedScore || b.score || 0) - (a._feedScore || a.score || 0));

      // 80/20: mistura 80% top-score + 20% exploracao (random do resto)
      if (raw.length > limit) {
        const slice80 = Math.floor(limit * 0.8);
        const slice20 = limit - slice80;
        const top = raw.slice(0, slice80);
        const pool = raw.slice(slice80);
        // Shuffle pool e pega slice20 — exploracao
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const exploration = pool.slice(0, slice20);
        // Interleave pra nao concentrar exploracao no fim
        const merged = [];
        let ti = 0, ei = 0;
        const every = Math.max(3, Math.floor(slice80 / Math.max(1, slice20)));
        for (let i = 0; i < limit; i++) {
          if (i > 0 && i % every === 0 && ei < exploration.length) {
            merged.push(exploration[ei++]);
          } else if (ti < top.length) {
            merged.push(top[ti++]);
          } else if (ei < exploration.length) {
            merged.push(exploration[ei++]);
          }
        }
        raw = merged;
      }
    }

    let videos = raw.slice(0, limit);
    const has_more = rawSql.length >= limit * 3;
    const next_cursor = has_more && lastSql ? encodeCursor(lastSql.created_at, lastSql.id) : null;

    // FALLBACK FINAL: se mesmo apos tudo o feed ficou vazio (ex: usuario novo
    // sem cursor + filtros muito restritivos retornaram 0), busca top videos
    // populares do banco inteiro pra nunca mostrar "Nenhum video ainda".
    if (videos.length === 0) {
      try {
        const fbExclude = userPrefs?.uid ? `&user_id=neq.${userPrefs.uid}` : '';
        const fbR = await fetchDb(
          `${SU}/rest/v1/blue_videos?status=eq.active&video_url=neq.null${fbExclude}&order=views.desc.nullslast,created_at.desc&limit=${limit}&select=${FEED_FIELDS}`,
          { headers: h }
        );
        if (fbR.ok) {
          let fb = (await fbR.json()).filter(v => v.video_url);
          if (blockedIds.length) fb = fb.filter(v => !blockedIds.includes(v.user_id));
          videos = fb;
        }
      } catch (e) { /* fail-soft */ }
    }

    // Enrich with creator profiles (com retry+CB — falha silenciosa mantém feed)
    const userIds = [...new Set(videos.map(v => v.user_id).filter(Boolean))];
    let profiles = {};
    if (userIds.length > 0) {
      try {
        const pR = await fetchDb(
          `${SU}/rest/v1/blue_profiles?user_id=in.(${userIds.join(',')})&select=user_id,username,display_name,avatar_url,verificado`,
          { headers: h }
        );
        if (pR.ok) (await pR.json()).forEach(p => { profiles[p.user_id] = p; });
      } catch (e) {
        console.warn('blue-feed enrich retry esgotado:', e.message);
      }
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

// ──────────────────────────────────────────────────────────────────────────
// Algoritmo: atualiza perfil de interesses do usuario em tempo real
// ──────────────────────────────────────────────────────────────────────────
async function atualizarInteresses(userId, videoId, sinal, { SU, h }) {
  // 1. Busca video (nichos, hashtags, user_id do criador)
  const vR = await fetch(
    `${SU}/rest/v1/blue_videos?id=eq.${videoId}&select=user_id,nichos,hashtags&limit=1`,
    { headers: h }
  );
  const [video] = vR.ok ? await vR.json() : [];
  if (!video) return;

  // 2. Busca interesses atuais
  const iR = await fetch(
    `${SU}/rest/v1/blue_user_interests?user_id=eq.${userId}&select=*&limit=1`,
    { headers: h }
  );
  const [atual] = iR.ok ? await iR.json() : [];
  const nichos = atual?.nichos || {};
  const criadoresFav = Array.isArray(atual?.criadores_favoritos) ? atual.criadores_favoritos : [];
  const criadoresBloq = Array.isArray(atual?.criadores_bloqueados) ? atual.criadores_bloqueados : [];
  const tagsPos = Array.isArray(atual?.tags_positivas) ? atual.tags_positivas : [];
  const tagsNeg = Array.isArray(atual?.tags_negativas) ? atual.tags_negativas : [];

  // 3. Calcula forca do sinal (-1.0 a +1.0)
  let forca = 0;
  if (sinal.pulou) {
    forca = -0.5;
  } else {
    forca = (sinal.percentual_assistido / 100) * 0.3;
    if (sinal.curtiu) forca += 0.2;
    if (sinal.salvou) forca += 0.3;
    if (sinal.comentou) forca += 0.2;
    if (sinal.compartilhou) forca += 0.4;
    if (sinal.replay) forca += 0.3;
    if (sinal.abriu_perfil) forca += 0.2;
    forca = Math.min(1, forca);
  }

  // 4. Atualiza score de nichos (usa 'nichos' se existir, senao hashtags como proxy)
  const nichosVideo = (video.nichos && video.nichos.length) ? video.nichos
    : (Array.isArray(video.hashtags) ? video.hashtags.slice(0, 3) : []);

  nichosVideo.forEach((nicho) => {
    if (!nicho) return;
    const atualScore = nichos[nicho] != null ? nichos[nicho] : 0.5;
    // Decay exponencial em direcao ao novo sinal (80% historia + 20% novo)
    const alvo = forca >= 0 ? Math.min(1, 0.5 + forca) : Math.max(0, 0.5 + forca);
    nichos[nicho] = Math.max(0, Math.min(1, atualScore * 0.8 + alvo * 0.2));
  });

  // 5. Atualiza afinidade com criador
  if (video.user_id && video.user_id !== userId) {
    const idxFav = criadoresFav.findIndex((c) => c.id === video.user_id);
    if (forca > 0) {
      if (idxFav >= 0) {
        criadoresFav[idxFav].score = Math.min(1, (criadoresFav[idxFav].score || 0.5) + forca * 0.1);
      } else {
        criadoresFav.push({ id: video.user_id, score: 0.5 + forca });
      }
      // Remove da lista de bloqueados se estava la
      const idxBlq = criadoresBloq.indexOf(video.user_id);
      if (idxBlq >= 0) criadoresBloq.splice(idxBlq, 1);
    } else if (forca < -0.3) {
      // Conta quantos videos deste criador o usuario pulou
      const pulosR = await fetch(
        `${SU}/rest/v1/blue_feed_historico?user_id=eq.${userId}&pulou=eq.true&select=video_id&limit=100`,
        { headers: { ...h, Prefer: 'count=exact' } }
      );
      const pulos = pulosR.ok ? await pulosR.json() : [];
      // Quais desses videos sao deste criador?
      const pulosIds = pulos.map((p) => p.video_id);
      if (pulosIds.length > 0) {
        const vidsCriadorR = await fetch(
          `${SU}/rest/v1/blue_videos?id=in.(${pulosIds.join(',')})&user_id=eq.${video.user_id}&select=id`,
          { headers: h }
        );
        const vidsCriador = vidsCriadorR.ok ? await vidsCriadorR.json() : [];
        if (vidsCriador.length >= 3 && !criadoresBloq.includes(video.user_id)) {
          criadoresBloq.push(video.user_id);
        }
      }
    }
  }

  // 6. Atualiza tags positivas/negativas (usa hashtags do video)
  const hashtags = Array.isArray(video.hashtags) ? video.hashtags : [];
  if (forca > 0.3) {
    hashtags.forEach((t) => {
      if (t && !tagsPos.includes(t)) tagsPos.push(t);
      const idxNeg = tagsNeg.indexOf(t);
      if (idxNeg >= 0) tagsNeg.splice(idxNeg, 1);
    });
  } else if (forca < -0.3) {
    hashtags.forEach((t) => {
      if (t && !tagsNeg.includes(t) && !tagsPos.includes(t)) tagsNeg.push(t);
    });
  }

  // 7. Ultimo nicho (pra diversificacao)
  const ultimoNicho = nichosVideo[0] || atual?.ultimo_nicho || null;

  // 8. Upsert final
  await fetch(`${SU}/rest/v1/blue_user_interests?on_conflict=user_id`, {
    method: 'POST',
    headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      user_id: userId,
      nichos,
      criadores_favoritos: criadoresFav.slice(-50),
      criadores_bloqueados: criadoresBloq.slice(-100),
      tags_positivas: tagsPos.slice(-100),
      tags_negativas: tagsNeg.slice(-50),
      ultimo_nicho: ultimoNicho,
      updated_at: new Date().toISOString(),
    }),
  });
}
