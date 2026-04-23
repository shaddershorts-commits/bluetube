// api/blue-onboarding.js — Onboarding de novos usuários
// CommonJS

const CATEGORIAS = [
  {id:'humor',emoji:'🎭',nome:'Humor'},{id:'culinaria',emoji:'🍳',nome:'Culinária'},
  {id:'fitness',emoji:'🏋️',nome:'Fitness'},{id:'musica',emoji:'🎵',nome:'Música'},
  {id:'games',emoji:'🎮',nome:'Games'},{id:'educacao',emoji:'📚',nome:'Educação'},
  {id:'beleza',emoji:'💄',nome:'Beleza'},{id:'viagens',emoji:'✈️',nome:'Viagens'},
  {id:'pets',emoji:'🐾',nome:'Pets'},{id:'financas',emoji:'💰',nome:'Finanças'},
  {id:'arte',emoji:'🎨',nome:'Arte'},{id:'esportes',emoji:'⚽',nome:'Esportes'},
  {id:'ciencia',emoji:'🔬',nome:'Ciência'},{id:'casa',emoji:'🏠',nome:'Casa'},
  {id:'moda',emoji:'👗',nome:'Moda'},{id:'bemestar',emoji:'🧘',nome:'Bem-estar'},
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const action = req.method === 'GET' ? req.query.action : (req.body && req.body.action);

  async function getUser(token) {
    if (!token) return null;
    const r = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    return r.ok ? await r.json() : null;
  }

  // ── STATUS ──────────────────────────────────────────────────────────────
  if (action === 'status') {
    const user = await getUser(req.query.token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${user.id}&select=onboarding_completo,onboarding_step,interesses`, { headers: h });
      const profile = pR.ok ? (await pR.json())[0] : null;
      return res.status(200).json({
        completo: profile?.onboarding_completo || false,
        step: profile?.onboarding_step || 0,
        interesses: profile?.interesses || [],
        categorias: CATEGORIAS
      });
    } catch(e) { return res.status(200).json({ completo: true }); } // fail safe
  }

  // ── SALVAR INTERESSES ───────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'interesses') {
    const { token, interesses } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    if (!interesses?.length || interesses.length < 3) return res.status(400).json({ error: 'Mínimo 3 interesses' });
    try {
      await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${user.id}`, {
        method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ interesses, onboarding_step: 1 })
      });
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── SUGESTÕES DE CRIADORES ──────────────────────────────────────────────
  // Filtros aplicados (evita sugerir perfis "parados"):
  //  1) avatar_url nao-nulo e nao-vazio (tem foto de perfil)
  //  2) >= 2 videos ativos postados
  // Query inicial sobe pra 80 pra ter margem depois dos filtros; retorno final
  // eh top 15 por contagem de followers.
  if (req.method === 'POST' && action === 'sugestoes-seguir') {
    const user = await getUser(req.body.token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      // Filtro 1 (REST): apenas perfis com avatar_url != null
      const cR = await fetch(`${SU}/rest/v1/blue_profiles?avatar_url=not.is.null&select=user_id,username,display_name,avatar_url,bio&order=created_at.asc&limit=80`, { headers: h });
      const creators = cR.ok ? await cR.json() : [];
      // Filter out self + avatar_url vazio (REST not.is.null nao pega strings vazias)
      const filtered = creators.filter(c =>
        c.user_id !== user.id &&
        typeof c.avatar_url === 'string' && c.avatar_url.trim() !== ''
      );
      // Get follower counts
      const uIds = filtered.map(c => c.user_id);
      let followerCounts = {};
      if (uIds.length) {
        const fR = await fetch(`${SU}/rest/v1/blue_follows?following_id=in.(${uIds.join(',')})&select=following_id`, { headers: h });
        const follows = fR.ok ? await fR.json() : [];
        follows.forEach(f => { followerCounts[f.following_id] = (followerCounts[f.following_id] || 0) + 1; });
      }
      // Get video counts
      let videoCounts = {};
      let thumbs = {};
      if (uIds.length) {
        const vR = await fetch(`${SU}/rest/v1/blue_videos?user_id=in.(${uIds.join(',')})&status=eq.active&select=user_id,thumbnail_url&order=score.desc`, { headers: h });
        const vids = vR.ok ? await vR.json() : [];
        vids.forEach(v => {
          videoCounts[v.user_id] = (videoCounts[v.user_id] || 0) + 1;
          if (!thumbs[v.user_id] && v.thumbnail_url) thumbs[v.user_id] = v.thumbnail_url;
        });
      }
      // Filtro 2 (memoria): apenas perfis com >= 2 videos ativos
      const sugestoes = filtered
        .filter(c => (videoCounts[c.user_id] || 0) >= 2)
        .map(c => ({
          ...c,
          preview_thumb: thumbs[c.user_id] || null,
          seguidores: followerCounts[c.user_id] || 0,
          videos: videoCounts[c.user_id] || 0,
        }))
        .sort((a, b) => b.seguidores - a.seguidores)
        .slice(0, 15);

      return res.status(200).json({ sugestoes });
    } catch(e) { return res.status(200).json({ sugestoes: [] }); }
  }

  // ── SEGUIR SUGERIDOS ────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'seguir-sugeridos') {
    const { token, user_ids } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      for (const uid of (user_ids || [])) {
        await fetch(`${SU}/rest/v1/blue_follows`, {
          method: 'POST', headers: { ...h, 'Prefer': 'resolution=ignore,return=minimal' },
          body: JSON.stringify({ follower_id: user.id, following_id: uid })
        });
      }
      await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${user.id}`, {
        method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ onboarding_step: 2 })
      });
      return res.status(200).json({ ok: true, seguindo: (user_ids || []).length });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── COMPLETAR ONBOARDING ────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'completar') {
    const user = await getUser(req.body.token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${user.id}`, {
        method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ onboarding_completo: true, onboarding_step: 5 })
      });
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── CATEGORIAS ──────────────────────────────────────────────────────────
  if (action === 'categorias') {
    return res.status(200).json({ categorias: CATEGORIAS });
  }

  return res.status(404).json({ error: 'Action não encontrada' });
};