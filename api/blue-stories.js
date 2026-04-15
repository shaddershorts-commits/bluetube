// api/blue-stories.js — Stories de 24h pro perfil Blue (feed + viewer + reações)
// Actions:
//   GET  ?action=feed&token=X         → lista stories dos seguidos agrupados por user
//   GET  ?action=ver&story_id=X&token → marca visto + retorna story completo
//   GET  ?action=meus&token=X         → meus stories com viewers + reações + replies
//   GET  ?action=limpar               → cron: deleta stories expirados (público)
//   POST {action:'criar',   token, tipo, media_url, texto, cor_fundo, duracao}
//   POST {action:'reagir',  token, story_id, emoji}
//   POST {action:'reply',   token, story_id, mensagem}
//   POST {action:'deletar', token, story_id}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'Supabase não configurado' });
  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  const action = req.method === 'GET' ? req.query.action : req.body?.action;

  // ── CRON: limpar stories expirados (sem auth, chamado por /api/blue-stories?action=limpar)
  if (action === 'limpar') {
    try {
      const now = new Date().toISOString();
      const r = await fetch(`${SU}/rest/v1/blue_stories?expirado_em=lt.${now}`, {
        method: 'DELETE',
        headers: { ...H, Prefer: 'return=minimal' }
      });
      return res.status(200).json({ ok: r.ok, cleaned_at: now });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Auth check — todas as outras actions requerem token
  const token = req.method === 'GET' ? req.query.token : req.body?.token;
  if (!token) return res.status(401).json({ error: 'Login necessário' });

  let userId;
  try {
    const ur = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!ur.ok) return res.status(401).json({ error: 'Token inválido' });
    const u = await ur.json();
    userId = u.id;
  } catch (e) { return res.status(401).json({ error: 'Token inválido' }); }
  if (!userId) return res.status(401).json({ error: 'Sem user id' });

  const EMOJI_ALLOWED = ['❤️', '🔥', '😂', '😮', '😢', '👏', '🤯'];

  // ── GET feed: stories dos seguidos agrupados por user ────────────────────
  if (req.method === 'GET' && action === 'feed') {
    try {
      // 1) Quem o user segue
      const fR = await fetch(
        `${SU}/rest/v1/blue_follows?follower_id=eq.${userId}&select=following_id&limit=500`,
        { headers: H }
      );
      const follows = fR.ok ? await fR.json() : [];
      const followedIds = follows.map(f => f.following_id);

      // Incluir o próprio user pra "Seu story" aparecer também
      const targetIds = [...new Set([userId, ...followedIds])];
      if (!targetIds.length) return res.status(200).json({ users: [], meu: null });

      // 2) Stories ativos dos seguidos (expirado_em > NOW())
      const now = new Date().toISOString();
      const idsParam = targetIds.map(id => `"${id}"`).join(',');
      const sR = await fetch(
        `${SU}/rest/v1/blue_stories?user_id=in.(${idsParam})&expirado_em=gt.${now}&order=user_id,created_at.asc&select=id,user_id,tipo,media_url,texto,cor_fundo,duracao,visto_por,created_at,expirado_em`,
        { headers: H }
      );
      const stories = sR.ok ? await sR.json() : [];

      // 3) Perfis dos users (avatar + username)
      const pR = await fetch(
        `${SU}/rest/v1/blue_profiles?user_id=in.(${idsParam})&select=user_id,username,display_name,avatar_url`,
        { headers: H }
      );
      const profiles = pR.ok ? await pR.json() : [];
      const profileMap = new Map(profiles.map(p => [p.user_id, p]));

      // 4) Agrupa stories por user_id
      const grouped = new Map();
      for (const s of stories) {
        const arr = grouped.get(s.user_id) || [];
        const vistoArr = Array.isArray(s.visto_por) ? s.visto_por : [];
        arr.push({
          id: s.id,
          tipo: s.tipo,
          media_url: s.media_url,
          texto: s.texto,
          cor_fundo: s.cor_fundo,
          duracao: s.duracao,
          visto: vistoArr.includes(userId),
          created_at: s.created_at,
          expirado_em: s.expirado_em
        });
        grouped.set(s.user_id, arr);
      }

      // 5) Separa meu do resto
      const meuStories = grouped.get(userId) || [];
      const meuProfile = profileMap.get(userId);
      const meu = {
        user_id: userId,
        username: meuProfile?.username || 'você',
        display_name: meuProfile?.display_name,
        avatar_url: meuProfile?.avatar_url,
        stories_count: meuStories.length,
        tem_nao_visto: false,
        stories: meuStories
      };

      // 6) Outros users (seguidos com stories)
      const outros = [];
      for (const uid of followedIds) {
        const arr = grouped.get(uid);
        if (!arr?.length) continue;
        const prof = profileMap.get(uid);
        outros.push({
          user_id: uid,
          username: prof?.username || 'user',
          display_name: prof?.display_name,
          avatar_url: prof?.avatar_url,
          stories_count: arr.length,
          tem_nao_visto: arr.some(s => !s.visto),
          stories: arr
        });
      }

      // Ordena: não-vistos primeiro, depois por timestamp do story mais recente
      outros.sort((a, b) => {
        if (a.tem_nao_visto !== b.tem_nao_visto) return a.tem_nao_visto ? -1 : 1;
        const aT = Math.max(...a.stories.map(s => new Date(s.created_at).getTime()));
        const bT = Math.max(...b.stories.map(s => new Date(s.created_at).getTime()));
        return bT - aT;
      });

      return res.status(200).json({ users: outros, meu });
    } catch (e) {
      console.error('[stories feed]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET ver: marca visto + retorna story + reações + reply count ─────────
  if (req.method === 'GET' && action === 'ver') {
    const storyId = req.query.story_id;
    if (!storyId) return res.status(400).json({ error: 'story_id obrigatório' });

    try {
      // Busca story
      const sR = await fetch(`${SU}/rest/v1/blue_stories?id=eq.${storyId}&select=*`, { headers: H });
      const srows = sR.ok ? await sR.json() : [];
      const story = srows[0];
      if (!story) return res.status(404).json({ error: 'story não encontrado' });
      if (new Date(story.expirado_em) < new Date()) return res.status(410).json({ error: 'story expirado' });

      // Marca visto (não duplica)
      const vistoArr = Array.isArray(story.visto_por) ? story.visto_por : [];
      if (!vistoArr.includes(userId)) {
        vistoArr.push(userId);
        await fetch(`${SU}/rest/v1/blue_stories?id=eq.${storyId}`, {
          method: 'PATCH',
          headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify({ visto_por: vistoArr })
        });
      }

      // Busca reações do story (agrupadas por emoji + minha reação)
      const rR = await fetch(
        `${SU}/rest/v1/blue_story_reacoes?story_id=eq.${storyId}&select=user_id,emoji`,
        { headers: H }
      );
      const reacoes = rR.ok ? await rR.json() : [];
      const reacoesPorEmoji = {};
      let minhaReacao = null;
      for (const r of reacoes) {
        reacoesPorEmoji[r.emoji] = (reacoesPorEmoji[r.emoji] || 0) + 1;
        if (r.user_id === userId) minhaReacao = r.emoji;
      }

      return res.status(200).json({
        story,
        reacoes: reacoesPorEmoji,
        total_reacoes: reacoes.length,
        minha_reacao: minhaReacao,
        visualizacoes: vistoArr.length
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET meus: stories do próprio user com viewers + reactions + replies ──
  if (req.method === 'GET' && action === 'meus') {
    try {
      const sR = await fetch(
        `${SU}/rest/v1/blue_stories?user_id=eq.${userId}&order=created_at.desc&select=*`,
        { headers: H }
      );
      const stories = sR.ok ? await sR.json() : [];

      const enriched = [];
      for (const s of stories) {
        const vistoArr = Array.isArray(s.visto_por) ? s.visto_por : [];
        const isExpired = new Date(s.expirado_em) < new Date();

        // Reações
        const rR = await fetch(
          `${SU}/rest/v1/blue_story_reacoes?story_id=eq.${s.id}&select=user_id,emoji`,
          { headers: H }
        );
        const reacoes = rR.ok ? await rR.json() : [];
        const reacoesPorEmoji = {};
        for (const r of reacoes) {
          reacoesPorEmoji[r.emoji] = (reacoesPorEmoji[r.emoji] || 0) + 1;
        }

        // Replies
        const repR = await fetch(
          `${SU}/rest/v1/blue_story_replies?story_id=eq.${s.id}&select=user_id,mensagem,created_at&order=created_at.desc`,
          { headers: H }
        );
        const replies = repR.ok ? await repR.json() : [];

        // Perfis dos viewers (apenas avatars + nomes)
        let viewerProfiles = [];
        if (vistoArr.length > 0) {
          const idsParam = vistoArr.slice(0, 50).map(id => `"${id}"`).join(',');
          const vpR = await fetch(
            `${SU}/rest/v1/blue_profiles?user_id=in.(${idsParam})&select=user_id,username,avatar_url`,
            { headers: H }
          );
          viewerProfiles = vpR.ok ? await vpR.json() : [];
        }

        enriched.push({
          ...s,
          expirado: isExpired,
          visualizacoes: vistoArr.length,
          viewers: viewerProfiles,
          reacoes: reacoesPorEmoji,
          total_reacoes: reacoes.length,
          replies
        });
      }

      return res.status(200).json({ stories: enriched });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST criar: cria novo story ──────────────────────────────────────────
  if (req.method === 'POST' && action === 'criar') {
    const { tipo, media_url, texto, cor_fundo, duracao } = req.body;
    if (!['imagem', 'video', 'texto'].includes(tipo)) {
      return res.status(400).json({ error: 'tipo inválido (imagem|video|texto)' });
    }
    if (tipo === 'texto' && !texto) return res.status(400).json({ error: 'texto obrigatório' });
    if ((tipo === 'imagem' || tipo === 'video') && !media_url) return res.status(400).json({ error: 'media_url obrigatório' });

    const duracaoFinal = Math.max(2, Math.min(15, parseInt(duracao) || (tipo === 'video' ? 15 : tipo === 'texto' ? 4 : 5)));

    try {
      const r = await fetch(`${SU}/rest/v1/blue_stories`, {
        method: 'POST',
        headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({
          user_id: userId,
          tipo,
          media_url: media_url || null,
          texto: texto || null,
          cor_fundo: cor_fundo || '#020817',
          duracao: duracaoFinal,
          visto_por: []
        })
      });
      if (!r.ok) {
        const et = await r.text();
        return res.status(500).json({ error: 'insert falhou: ' + et.slice(0, 200) });
      }
      const rows = await r.json();
      return res.status(200).json({ ok: true, story: rows[0] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST reagir: toggle/update reação ────────────────────────────────────
  if (req.method === 'POST' && action === 'reagir') {
    const { story_id, emoji } = req.body;
    if (!story_id || !emoji) return res.status(400).json({ error: 'story_id e emoji obrigatórios' });
    if (!EMOJI_ALLOWED.includes(emoji)) return res.status(400).json({ error: 'emoji não permitido' });

    try {
      // Checa se já reagiu
      const exR = await fetch(
        `${SU}/rest/v1/blue_story_reacoes?story_id=eq.${story_id}&user_id=eq.${userId}&select=id,emoji`,
        { headers: H }
      );
      const existing = exR.ok ? (await exR.json())[0] : null;

      let minhaReacao = emoji;
      if (existing) {
        if (existing.emoji === emoji) {
          // Toggle: remove
          await fetch(`${SU}/rest/v1/blue_story_reacoes?id=eq.${existing.id}`, {
            method: 'DELETE',
            headers: { ...H, Prefer: 'return=minimal' }
          });
          minhaReacao = null;
        } else {
          // Update
          await fetch(`${SU}/rest/v1/blue_story_reacoes?id=eq.${existing.id}`, {
            method: 'PATCH',
            headers: { ...H, Prefer: 'return=minimal' },
            body: JSON.stringify({ emoji })
          });
        }
      } else {
        // Insert
        await fetch(`${SU}/rest/v1/blue_story_reacoes`, {
          method: 'POST',
          headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify({ story_id, user_id: userId, emoji })
        });
      }

      // Re-conta todas as reações do story
      const rR = await fetch(
        `${SU}/rest/v1/blue_story_reacoes?story_id=eq.${story_id}&select=emoji`,
        { headers: H }
      );
      const all = rR.ok ? await rR.json() : [];
      const reacoesPorEmoji = {};
      for (const r of all) reacoesPorEmoji[r.emoji] = (reacoesPorEmoji[r.emoji] || 0) + 1;

      return res.status(200).json({
        ok: true,
        reacoes: reacoesPorEmoji,
        total_reacoes: all.length,
        minha_reacao: minhaReacao
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST reply: cria DM com referência ao story ──────────────────────────
  if (req.method === 'POST' && action === 'reply') {
    const { story_id, mensagem } = req.body;
    if (!story_id || !mensagem) return res.status(400).json({ error: 'story_id e mensagem obrigatórios' });
    if (mensagem.length > 500) return res.status(400).json({ error: 'mensagem excede 500 chars' });

    try {
      // 1) Busca dono do story
      const sR = await fetch(`${SU}/rest/v1/blue_stories?id=eq.${story_id}&select=user_id`, { headers: H });
      const srows = sR.ok ? await sR.json() : [];
      const ownerId = srows[0]?.user_id;
      if (!ownerId) return res.status(404).json({ error: 'story não encontrado' });
      if (ownerId === userId) return res.status(400).json({ error: 'não pode responder próprio story' });

      // 2) Salva reply no blue_story_replies (histórico)
      await fetch(`${SU}/rest/v1/blue_story_replies`, {
        method: 'POST',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ story_id, user_id: userId, mensagem })
      });

      // 3) Find-or-create conversation (user_ids ordenados pra evitar dup)
      const [u1, u2] = [userId, ownerId].sort();
      const cR = await fetch(
        `${SU}/rest/v1/blue_conversations?user1_id=eq.${u1}&user2_id=eq.${u2}&select=id`,
        { headers: H }
      );
      const cData = cR.ok ? await cR.json() : [];
      let convId = cData[0]?.id;
      if (!convId) {
        const ncR = await fetch(`${SU}/rest/v1/blue_conversations`, {
          method: 'POST',
          headers: { ...H, Prefer: 'return=representation' },
          body: JSON.stringify({
            user1_id: u1,
            user2_id: u2,
            last_message_at: new Date().toISOString()
          })
        });
        if (ncR.ok) convId = (await ncR.json())[0]?.id;
      }
      if (!convId) return res.status(500).json({ error: 'falha ao criar conversa' });

      // 4) Envia mensagem no DM com referência ao story
      await fetch(`${SU}/rest/v1/blue_messages`, {
        method: 'POST',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({
          conversation_id: convId,
          sender_id: userId,
          receiver_id: ownerId,
          content: `↳ Respondeu seu story: ${mensagem}`,
          read: false
        })
      });

      // 5) Atualiza last_message_at da conversation
      await fetch(`${SU}/rest/v1/blue_conversations?id=eq.${convId}`, {
        method: 'PATCH',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ last_message_at: new Date().toISOString() })
      });

      return res.status(200).json({ ok: true, conversation_id: convId });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST deletar: soft delete (marca expirado_em = NOW) ──────────────────
  if (req.method === 'POST' && action === 'deletar') {
    const { story_id } = req.body;
    if (!story_id) return res.status(400).json({ error: 'story_id obrigatório' });

    try {
      // Valida ownership
      const sR = await fetch(`${SU}/rest/v1/blue_stories?id=eq.${story_id}&user_id=eq.${userId}&select=id`, { headers: H });
      const srows = sR.ok ? await sR.json() : [];
      if (!srows[0]) return res.status(403).json({ error: 'não é dono do story' });

      await fetch(`${SU}/rest/v1/blue_stories?id=eq.${story_id}`, {
        method: 'PATCH',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ expirado_em: new Date().toISOString() })
      });

      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'action inválida' });
};
