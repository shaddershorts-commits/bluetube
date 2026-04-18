// api/blue-follow.js — Sistema de seguir/deixar de seguir
// Tabela necessária no Supabase:
// CREATE TABLE blue_follows (
//   id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   follower_id uuid NOT NULL,
//   following_id uuid NOT NULL,
//   created_at timestamptz DEFAULT now(),
//   UNIQUE(follower_id, following_id)
// );
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

  async function getUser(token) {
    if (!token) return null;
    try {
      const r = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      return r.ok ? (await r.json()).id : null;
    } catch(e) { return null; }
  }

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { action, user_id, token } = req.query;

    // Contagem de seguidores de um usuário (público)
    if (action === 'count' && user_id) {
      try {
        const r = await fetch(
          `${SU}/rest/v1/blue_follows?following_id=eq.${user_id}&select=id`,
          { headers: { ...h, Prefer: 'count=exact', Range: '0-0' } }
        );
        const count = parseInt(r.headers?.get?.('Content-Range')?.split('/')[1] || '0') || 0;
        return res.status(200).json({ count });
      } catch(e) { return res.status(200).json({ count: 0 }); }
    }

    // Lista de quem o usuário logado segue
    if (action === 'following' && token) {
      const userId = await getUser(token);
      if (!userId) return res.status(200).json({ following: [] });
      try {
        const r = await fetch(
          `${SU}/rest/v1/blue_follows?follower_id=eq.${userId}&select=following_id&limit=500`,
          { headers: h }
        );
        const data = r.ok ? await r.json() : [];
        return res.status(200).json({ following: data.map(d => d.following_id) });
      } catch(e) { return res.status(200).json({ following: [] }); }
    }

    // Lista de SEGUIDORES de um user (quem segue X) — paginado, com perfil
    if (action === 'lista-seguidores' && user_id) {
      const pagina = Math.max(1, parseInt(req.query.pagina || '1', 10) || 1);
      const limite = 30;
      const offset = (pagina - 1) * limite;
      try {
        const fr = await fetch(
          `${SU}/rest/v1/blue_follows?following_id=eq.${user_id}&select=follower_id,created_at&order=created_at.desc&offset=${offset}&limit=${limite}`,
          { headers: { ...h, Prefer: 'count=exact' } }
        );
        if (!fr.ok) return res.status(200).json({ usuarios: [], total: 0 });
        const rows = await fr.json();
        const cr = fr.headers.get('content-range') || '';
        const m = cr.match(/\/(\d+)$/);
        const total = m ? parseInt(m[1], 10) : rows.length;
        const ids = [...new Set(rows.map(r => r.follower_id))];
        let perfis = [];
        if (ids.length) {
          const pR = await fetch(
            `${SU}/rest/v1/blue_profiles?user_id=in.(${ids.join(',')})&select=user_id,username,display_name,avatar_url,verificado`,
            { headers: h }
          );
          perfis = pR.ok ? await pR.json() : [];
        }
        const byId = Object.fromEntries(perfis.map(p => [p.user_id, p]));
        return res.status(200).json({
          usuarios: rows.map(r => ({ ...byId[r.follower_id], seguindo_desde: r.created_at })).filter(u => u.user_id),
          total, pagina, total_paginas: Math.max(1, Math.ceil(total / limite)),
        });
      } catch(e) { return res.status(200).json({ usuarios: [], total: 0, error: e.message }); }
    }

    // Lista de SEGUINDO (quem X segue) — paginado, com perfil
    if (action === 'lista-seguindo' && user_id) {
      const pagina = Math.max(1, parseInt(req.query.pagina || '1', 10) || 1);
      const limite = 30;
      const offset = (pagina - 1) * limite;
      try {
        const fr = await fetch(
          `${SU}/rest/v1/blue_follows?follower_id=eq.${user_id}&select=following_id,created_at&order=created_at.desc&offset=${offset}&limit=${limite}`,
          { headers: { ...h, Prefer: 'count=exact' } }
        );
        if (!fr.ok) return res.status(200).json({ usuarios: [], total: 0 });
        const rows = await fr.json();
        const cr = fr.headers.get('content-range') || '';
        const m = cr.match(/\/(\d+)$/);
        const total = m ? parseInt(m[1], 10) : rows.length;
        const ids = [...new Set(rows.map(r => r.following_id))];
        let perfis = [];
        if (ids.length) {
          const pR = await fetch(
            `${SU}/rest/v1/blue_profiles?user_id=in.(${ids.join(',')})&select=user_id,username,display_name,avatar_url,verificado`,
            { headers: h }
          );
          perfis = pR.ok ? await pR.json() : [];
        }
        const byId = Object.fromEntries(perfis.map(p => [p.user_id, p]));
        return res.status(200).json({
          usuarios: rows.map(r => ({ ...byId[r.following_id], seguindo_desde: r.created_at })).filter(u => u.user_id),
          total, pagina, total_paginas: Math.max(1, Math.ceil(total / limite)),
        });
      } catch(e) { return res.status(200).json({ usuarios: [], total: 0, error: e.message }); }
    }

    // Verifica se está seguindo um perfil específico
    if (action === 'is-following' && user_id && token) {
      const userId = await getUser(token);
      if (!userId) return res.status(200).json({ following: false });
      try {
        const r = await fetch(
          `${SU}/rest/v1/blue_follows?follower_id=eq.${userId}&following_id=eq.${user_id}&select=id`,
          { headers: h }
        );
        const data = r.ok ? await r.json() : [];
        return res.status(200).json({ following: data.length > 0 });
      } catch(e) { return res.status(200).json({ following: false }); }
    }

    return res.status(400).json({ error: 'Parâmetros inválidos' });
  }

  // ── POST follow / unfollow ─────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, token, target_id } = req.body || {};
    if (!token || !target_id) return res.status(400).json({ error: 'Parâmetros obrigatórios' });
    const userId = await getUser(token);
    if (!userId) return res.status(401).json({ error: 'Token inválido' });
    if (userId === target_id) return res.status(400).json({ error: 'Não pode seguir a si mesmo' });

    if (action === 'follow') {
      try {
        await fetch(`${SU}/rest/v1/blue_follows`, {
          method: 'POST',
          headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify({ follower_id: userId, following_id: target_id })
        });
        // Notifica o alvo do seguidor (fire-and-forget) + push mobile
        try {
          const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${userId}&select=username,display_name`, { headers: h });
          const [me] = pR.ok ? await pR.json() : [];
          const uname = me?.username || 'alguém';
          const titulo = 'Novo seguidor';
          const mensagem = `@${uname} começou a te seguir`;
          fetch(`${SU}/rest/v1/blue_notificacoes`, {
            method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
            body: JSON.stringify({
              user_id: target_id, tipo: 'follow', titulo, mensagem,
              dados: { from_user_id: userId },
            }),
          }).catch(() => {});
          // Push mobile via Expo (se app instalado)
          try {
            const { sendPushToUser } = require('./_helpers/push.js');
            sendPushToUser(target_id, {
              title: titulo, body: mensagem,
              data: { tipo: 'follow', from_user_id: userId, url: '/blue' },
            }).catch(() => {});
          } catch(e) {}
        } catch(e) { /* fail-soft */ }
        return res.status(200).json({ ok: true, following: true });
      } catch(e) { return res.status(200).json({ ok: true, following: true }); }
    }

    if (action === 'unfollow') {
      try {
        await fetch(
          `${SU}/rest/v1/blue_follows?follower_id=eq.${userId}&following_id=eq.${target_id}`,
          { method: 'DELETE', headers: h }
        );
        return res.status(200).json({ ok: true, following: false });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }

    return res.status(400).json({ error: 'Ação inválida' });
  }

  return res.status(405).end();
};
