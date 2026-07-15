// api/blue-grupos.js — Grupos e comunidades
// CommonJS

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
    if (!r.ok) return null;
    const u = await r.json();
    const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${u.id}&select=user_id,username,display_name,avatar_url`, { headers: h });
    return { id: u.id, profile: pR.ok ? (await pR.json())[0] : null };
  }

  // ── CRIAR GRUPO ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'criar') {
    const { token, nome, descricao, tipo, membros } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });

    try {
      const gR = await fetch(`${SU}/rest/v1/blue_grupos`, {
        method: 'POST', headers: { ...h, 'Prefer': 'return=representation' },
        body: JSON.stringify({ nome, descricao: descricao || '', criador_id: user.id, tipo: tipo || 'publico' })
      });
      const grupo = gR.ok ? (await gR.json())[0] : null;
      if (!grupo) return res.status(500).json({ error: 'Erro ao criar grupo' });

      // Add creator as admin
      await fetch(`${SU}/rest/v1/blue_grupo_membros`, {
        method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ grupo_id: grupo.id, user_id: user.id, role: 'admin' })
      });

      // Membros iniciais (WhatsApp-like: criador ja escolhe quem entra)
      if (Array.isArray(membros) && membros.length) {
        const rows = [...new Set(membros)].filter(id => id && id !== user.id).slice(0, 50)
          .map(id => ({ grupo_id: grupo.id, user_id: id, role: 'membro' }));
        if (rows.length) {
          await fetch(`${SU}/rest/v1/blue_grupo_membros`, {
            method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
            body: JSON.stringify(rows)
          }).catch(() => {});
        }
      }

      return res.status(200).json({ ok: true, grupo });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── ENTRAR NO GRUPO ─────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'entrar') {
    const { token, grupo_id } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });

    try {
      // Check if already member
      const eR = await fetch(`${SU}/rest/v1/blue_grupo_membros?grupo_id=eq.${grupo_id}&user_id=eq.${user.id}&select=grupo_id`, { headers: h });
      if (eR.ok && (await eR.json()).length) return res.status(200).json({ ok: true, already: true });

      await fetch(`${SU}/rest/v1/blue_grupo_membros`, {
        method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ grupo_id, user_id: user.id })
      });
      // Increment count
      const gR = await fetch(`${SU}/rest/v1/blue_grupos?id=eq.${grupo_id}&select=membros_count`, { headers: h });
      const g = gR.ok ? (await gR.json())[0] : null;
      if (g) fetch(`${SU}/rest/v1/blue_grupos?id=eq.${grupo_id}`, { method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ membros_count: (g.membros_count || 0) + 1 }) }).catch(() => {});

      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── SAIR DO GRUPO ───────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'sair') {
    const { token, grupo_id } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      await fetch(`${SU}/rest/v1/blue_grupo_membros?grupo_id=eq.${grupo_id}&user_id=eq.${user.id}`, { method: 'DELETE', headers: h });
      const gR = await fetch(`${SU}/rest/v1/blue_grupos?id=eq.${grupo_id}&select=membros_count`, { headers: h });
      const g = gR.ok ? (await gR.json())[0] : null;
      if (g) fetch(`${SU}/rest/v1/blue_grupos?id=eq.${grupo_id}`, { method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ membros_count: Math.max(0, (g.membros_count || 1) - 1) }) }).catch(() => {});
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── MEUS GRUPOS ─────────────────────────────────────────────────────────
  if (action === 'listar') {
    const user = await getUser(req.query.token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      const mR = await fetch(`${SU}/rest/v1/blue_grupo_membros?user_id=eq.${user.id}&select=grupo_id,role`, { headers: h });
      const memberships = mR.ok ? await mR.json() : [];
      if (!memberships.length) return res.status(200).json({ grupos: [] });
      const gIds = memberships.map(m => m.grupo_id);
      const gR = await fetch(`${SU}/rest/v1/blue_grupos?id=in.(${gIds.join(',')})&order=created_at.desc&select=*`, { headers: h });
      const grupos = gR.ok ? await gR.json() : [];
      const roleMap = {}; memberships.forEach(m => { roleMap[m.grupo_id] = m.role; });
      return res.status(200).json({ grupos: grupos.map(g => ({ ...g, meu_role: roleMap[g.id] || 'membro' })) });
    } catch(e) { return res.status(200).json({ grupos: [] }); }
  }

  // ── DESCOBRIR GRUPOS ────────────────────────────────────────────────────
  if (action === 'descobrir') {
    try {
      const gR = await fetch(`${SU}/rest/v1/blue_grupos?tipo=eq.publico&order=membros_count.desc&limit=20&select=*`, { headers: h });
      return res.status(200).json({ grupos: gR.ok ? await gR.json() : [] });
    } catch(e) { return res.status(200).json({ grupos: [] }); }
  }

  // ── MENSAGENS DO GRUPO ──────────────────────────────────────────────────
  if (action === 'mensagens') {
    const { grupo_id, cursor } = req.query;
    if (!grupo_id) return res.status(400).json({ error: 'grupo_id obrigatório' });
    try {
      let url = `${SU}/rest/v1/blue_grupo_mensagens?grupo_id=eq.${grupo_id}&order=created_at.desc&limit=50&select=*`;
      // encodeURIComponent: '+' do timestamp viraria espaco na query (400)
      if (cursor) url += `&created_at=lt.${encodeURIComponent(cursor)}`;
      const mR = await fetch(url, { headers: h });
      const msgs = mR.ok ? await mR.json() : [];
      // Enrich with profiles
      const uIds = [...new Set(msgs.map(m => m.user_id).filter(Boolean))];
      let profiles = {};
      if (uIds.length) {
        const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=in.(${uIds.join(',')})&select=user_id,username,display_name,avatar_url`, { headers: h });
        if (pR.ok) (await pR.json()).forEach(p => { profiles[p.user_id] = p; });
      }
      return res.status(200).json({ mensagens: msgs.reverse().map(m => ({ ...m, autor: profiles[m.user_id] || null })) });
    } catch(e) { return res.status(200).json({ mensagens: [] }); }
  }

  // ── ENVIAR MENSAGEM ─────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'mensagem') {
    const { token, grupo_id, mensagem, tipo, media_url, media_type, media_duration } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    const gHasMedia = !!media_url && ['image', 'video', 'audio', 'gif'].includes(media_type);
    if (!grupo_id || (!mensagem?.trim() && !gHasMedia)) return res.status(400).json({ error: 'grupo_id e mensagem (ou mídia) obrigatórios' });

    try {
      // Verify membership
      const mR = await fetch(`${SU}/rest/v1/blue_grupo_membros?grupo_id=eq.${grupo_id}&user_id=eq.${user.id}&select=grupo_id`, { headers: h });
      if (!mR.ok || !(await mR.json()).length) return res.status(403).json({ error: 'Não é membro deste grupo' });

      const gPreview = mensagem?.trim()
        || (media_type === 'image' ? '📷 Foto' : media_type === 'gif' ? '🎞️ GIF' : media_type === 'video' ? '🎬 Vídeo' : '🎤 Áudio');
      const msgR = await fetch(`${SU}/rest/v1/blue_grupo_mensagens`, {
        method: 'POST', headers: { ...h, 'Prefer': 'return=representation' },
        body: JSON.stringify({
          grupo_id, user_id: user.id, mensagem: mensagem?.trim() || '', tipo: tipo || 'texto',
          media_url: gHasMedia ? media_url : null,
          media_type: gHasMedia ? media_type : null,
          media_duration: gHasMedia ? (parseInt(media_duration) || null) : null,
        })
      });
      const msg = msgR.ok ? (await msgR.json())[0] : null;
      // last_message do grupo (lista de conversas estilo WhatsApp) — tolera coluna ausente
      await fetch(`${SU}/rest/v1/blue_grupos?id=eq.${grupo_id}`, {
        method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ last_message: gPreview.slice(0, 120), last_message_at: new Date().toISOString() })
      }).catch(() => {});
      return res.status(200).json({ ok: true, mensagem: msg ? { ...msg, autor: user.profile } : null });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── ADICIONAR MEMBRO (admin adiciona pessoas, estilo WhatsApp) ──────────
  if (req.method === 'POST' && action === 'adicionar') {
    const { token, grupo_id, user_id: novoId } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    if (!grupo_id || !novoId) return res.status(400).json({ error: 'grupo_id e user_id obrigatórios' });
    try {
      const aR = await fetch(`${SU}/rest/v1/blue_grupo_membros?grupo_id=eq.${grupo_id}&user_id=eq.${user.id}&role=eq.admin&select=grupo_id`, { headers: h });
      if (!aR.ok || !(await aR.json()).length) return res.status(403).json({ error: 'Só admins podem adicionar membros' });
      const exR = await fetch(`${SU}/rest/v1/blue_grupo_membros?grupo_id=eq.${grupo_id}&user_id=eq.${novoId}&select=grupo_id`, { headers: h });
      if (exR.ok && (await exR.json()).length) return res.status(200).json({ ok: true, ja_membro: true });
      await fetch(`${SU}/rest/v1/blue_grupo_membros`, {
        method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ grupo_id, user_id: novoId, role: 'membro' })
      });
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── MEMBROS DO GRUPO ────────────────────────────────────────────────────
  if (action === 'membros') {
    const { grupo_id } = req.query;
    if (!grupo_id) return res.status(400).json({ error: 'grupo_id obrigatório' });
    try {
      const mR = await fetch(`${SU}/rest/v1/blue_grupo_membros?grupo_id=eq.${grupo_id}&select=user_id,role,joined_at&limit=50`, { headers: h });
      const members = mR.ok ? await mR.json() : [];
      const uIds = members.map(m => m.user_id);
      let profiles = {};
      if (uIds.length) {
        const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=in.(${uIds.join(',')})&select=user_id,username,display_name,avatar_url`, { headers: h });
        if (pR.ok) (await pR.json()).forEach(p => { profiles[p.user_id] = p; });
      }
      return res.status(200).json({ membros: members.map(m => ({ ...m, profile: profiles[m.user_id] || null })) });
    } catch(e) { return res.status(200).json({ membros: [] }); }
  }

  return res.status(404).json({ error: 'Action não encontrada' });
};
