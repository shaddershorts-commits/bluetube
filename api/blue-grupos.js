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
      let msgs = mR.ok ? await mR.json() : [];
      // v3: esconde as que EU apaguei "pra mim" (deleted_for_all fica visível
      // como placeholder "mensagem apagada" no app)
      const quem = await getUser(req.query.token).catch(() => null);
      if (quem) msgs = msgs.filter(m => !(Array.isArray(m.deleted_for) && m.deleted_for.includes(quem.id)));
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
    const gHasMedia = !!media_url && ['image', 'video', 'audio', 'gif', 'share'].includes(media_type);
    if (!grupo_id || (!mensagem?.trim() && !gHasMedia)) return res.status(400).json({ error: 'grupo_id e mensagem (ou mídia) obrigatórios' });

    try {
      // Verify membership + role (modo "só admins enviam")
      const [mR, gInfoR] = await Promise.all([
        fetch(`${SU}/rest/v1/blue_grupo_membros?grupo_id=eq.${grupo_id}&user_id=eq.${user.id}&select=grupo_id,role`, { headers: h }),
        fetch(`${SU}/rest/v1/blue_grupos?id=eq.${grupo_id}&select=only_admins`, { headers: h }),
      ]);
      const membro = mR.ok ? (await mR.json())[0] : null;
      if (!membro) return res.status(403).json({ error: 'Não é membro deste grupo' });
      const gInfo = gInfoR.ok ? (await gInfoR.json())[0] : null;
      if (gInfo?.only_admins && membro.role !== 'admin') {
        return res.status(403).json({ error: 'Só admins podem enviar mensagens neste grupo.', only_admins: true });
      }

      const gPreview = mensagem?.trim()
        || (media_type === 'image' ? '📷 Foto' : media_type === 'gif' ? '🎞️ GIF' : media_type === 'video' ? '🎬 Vídeo' : media_type === 'share' ? '🎬 Vídeo do Blue' : '🎤 Áudio');
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

  // ══ GRUPOS v3 (2026-07-16) — personalização, ADMs, só-admins, msg edit/del ═

  // Helper: role do usuário no grupo ('admin' | 'membro' | null)
  async function roleNoGrupo(grupoId, uid) {
    const r = await fetch(`${SU}/rest/v1/blue_grupo_membros?grupo_id=eq.${grupoId}&user_id=eq.${uid}&select=role`, { headers: h });
    return r.ok ? ((await r.json())[0]?.role || null) : null;
  }

  // ── EDITAR GRUPO (nome/descrição/foto) — admin ───────────────────────────
  if (req.method === 'POST' && action === 'editar') {
    const { token, grupo_id, nome, descricao, avatar_url } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    if (!grupo_id) return res.status(400).json({ error: 'grupo_id obrigatório' });
    try {
      if ((await roleNoGrupo(grupo_id, user.id)) !== 'admin') return res.status(403).json({ error: 'Só admins podem editar o grupo' });
      const patch = {};
      if (typeof nome === 'string' && nome.trim()) patch.nome = nome.replace(/<[^>]*>/g, '').trim().slice(0, 60);
      if (typeof descricao === 'string') patch.descricao = descricao.replace(/<[^>]*>/g, '').trim().slice(0, 300);
      if (typeof avatar_url === 'string' && avatar_url.startsWith(SU)) patch.avatar_url = avatar_url;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada pra salvar' });
      await fetch(`${SU}/rest/v1/blue_grupos?id=eq.${grupo_id}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── SÓ ADMINS ENVIAM (toggle) — admin ────────────────────────────────────
  if (req.method === 'POST' && action === 'only-admins') {
    const { token, grupo_id } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      if ((await roleNoGrupo(grupo_id, user.id)) !== 'admin') return res.status(403).json({ error: 'Só admins' });
      const gR = await fetch(`${SU}/rest/v1/blue_grupos?id=eq.${grupo_id}&select=only_admins`, { headers: h });
      const cur = gR.ok ? (await gR.json())[0] : null;
      const novo = !(cur?.only_admins);
      await fetch(`${SU}/rest/v1/blue_grupos?id=eq.${grupo_id}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ only_admins: novo }),
      });
      return res.status(200).json({ ok: true, only_admins: novo });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── PROMOVER/REBAIXAR ADMIN — admin (criador não pode ser rebaixado) ─────
  if (req.method === 'POST' && action === 'set-role') {
    const { token, grupo_id, user_id: alvoId, role } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    if (!grupo_id || !alvoId || !['admin', 'membro'].includes(role)) return res.status(400).json({ error: 'grupo_id, user_id e role obrigatórios' });
    try {
      if ((await roleNoGrupo(grupo_id, user.id)) !== 'admin') return res.status(403).json({ error: 'Só admins' });
      const gR = await fetch(`${SU}/rest/v1/blue_grupos?id=eq.${grupo_id}&select=criador_id`, { headers: h });
      const criador = gR.ok ? (await gR.json())[0]?.criador_id : null;
      if (alvoId === criador && role !== 'admin') return res.status(400).json({ error: 'O criador do grupo é sempre admin.' });
      await fetch(`${SU}/rest/v1/blue_grupo_membros?grupo_id=eq.${grupo_id}&user_id=eq.${encodeURIComponent(alvoId)}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ role }),
      });
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── REMOVER MEMBRO — admin (criador não pode ser removido) ───────────────
  if (req.method === 'POST' && action === 'remover-membro') {
    const { token, grupo_id, user_id: alvoId } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    if (!grupo_id || !alvoId) return res.status(400).json({ error: 'grupo_id e user_id obrigatórios' });
    try {
      if ((await roleNoGrupo(grupo_id, user.id)) !== 'admin') return res.status(403).json({ error: 'Só admins' });
      const gR = await fetch(`${SU}/rest/v1/blue_grupos?id=eq.${grupo_id}&select=criador_id,membros_count`, { headers: h });
      const g = gR.ok ? (await gR.json())[0] : null;
      if (alvoId === g?.criador_id) return res.status(400).json({ error: 'O criador não pode ser removido.' });
      await fetch(`${SU}/rest/v1/blue_grupo_membros?grupo_id=eq.${grupo_id}&user_id=eq.${encodeURIComponent(alvoId)}`, { method: 'DELETE', headers: h });
      if (g) fetch(`${SU}/rest/v1/blue_grupos?id=eq.${grupo_id}`, { method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ membros_count: Math.max(0, (g.membros_count || 1) - 1) }) }).catch(() => {});
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── EXCLUIR GRUPO — só o criador ─────────────────────────────────────────
  if (req.method === 'POST' && action === 'excluir') {
    const { token, grupo_id } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    try {
      const gR = await fetch(`${SU}/rest/v1/blue_grupos?id=eq.${grupo_id}&select=criador_id`, { headers: h });
      const g = gR.ok ? (await gR.json())[0] : null;
      if (!g || g.criador_id !== user.id) return res.status(403).json({ error: 'Só o criador pode excluir o grupo' });
      await fetch(`${SU}/rest/v1/blue_grupo_mensagens?grupo_id=eq.${grupo_id}`, { method: 'DELETE', headers: h }).catch(() => {});
      await fetch(`${SU}/rest/v1/blue_grupo_membros?grupo_id=eq.${grupo_id}`, { method: 'DELETE', headers: h }).catch(() => {});
      await fetch(`${SU}/rest/v1/blue_grupos?id=eq.${grupo_id}`, { method: 'DELETE', headers: h });
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── APAGAR MENSAGEM DO GRUPO (minha ≤3h; admin apaga qualquer uma) ───────
  if (req.method === 'POST' && action === 'gmsg-delete') {
    const { token, message_id, scope } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    if (!message_id) return res.status(400).json({ error: 'message_id obrigatório' });
    try {
      const mR = await fetch(`${SU}/rest/v1/blue_grupo_mensagens?id=eq.${encodeURIComponent(message_id)}&select=id,grupo_id,user_id,created_at,deleted_for`, { headers: h });
      const msg = mR.ok ? (await mR.json())[0] : null;
      if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
      const meuRole = await roleNoGrupo(msg.grupo_id, user.id);
      if (!meuRole) return res.status(403).json({ error: 'forbidden' });
      if (scope === 'all') {
        const minha = msg.user_id === user.id;
        const dentro3h = Date.now() - new Date(msg.created_at).getTime() <= 3 * 3600 * 1000;
        if (!((minha && dentro3h) || meuRole === 'admin')) {
          return res.status(403).json({ error: minha ? 'Só dá pra apagar o envio nas primeiras 3 horas.' : 'Só admins apagam mensagens de outros.' });
        }
        await fetch(`${SU}/rest/v1/blue_grupo_mensagens?id=eq.${encodeURIComponent(message_id)}`, {
          method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify({ deleted_for_all: true, mensagem: '', media_url: null, media_type: null }),
        });
      } else {
        const df = Array.isArray(msg.deleted_for) ? msg.deleted_for : [];
        if (!df.includes(user.id)) df.push(user.id);
        await fetch(`${SU}/rest/v1/blue_grupo_mensagens?id=eq.${encodeURIComponent(message_id)}`, {
          method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ deleted_for: df }),
        });
      }
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── EDITAR MENSAGEM DO GRUPO (minha, ≤3h, máx 3 edições) ─────────────────
  if (req.method === 'POST' && action === 'gmsg-edit') {
    const { token, message_id, text } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });
    const novo = (text || '').trim();
    if (!message_id || !novo) return res.status(400).json({ error: 'message_id e text obrigatórios' });
    try {
      const mR = await fetch(`${SU}/rest/v1/blue_grupo_mensagens?id=eq.${encodeURIComponent(message_id)}&select=id,user_id,created_at,edited_count,deleted_for_all`, { headers: h });
      const msg = mR.ok ? (await mR.json())[0] : null;
      if (!msg || msg.user_id !== user.id) return res.status(403).json({ error: 'forbidden' });
      if (msg.deleted_for_all) return res.status(400).json({ error: 'Mensagem apagada.' });
      if (Date.now() - new Date(msg.created_at).getTime() > 3 * 3600 * 1000) return res.status(400).json({ error: 'Só dá pra editar nas primeiras 3 horas.' });
      if ((msg.edited_count || 0) >= 3) return res.status(400).json({ error: 'Limite de 3 edições atingido.' });
      await fetch(`${SU}/rest/v1/blue_grupo_mensagens?id=eq.${encodeURIComponent(message_id)}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ mensagem: novo.slice(0, 1000), edited_count: (msg.edited_count || 0) + 1, edited_at: new Date().toISOString() }),
      });
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(404).json({ error: 'Action não encontrada' });
};
