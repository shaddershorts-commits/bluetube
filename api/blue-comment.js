// api/blue-comment.js — Comentários do Blue com rate limiting
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

  // GET — lista comentários de um vídeo (flat; app faz o threading via parent_id)
  if (req.method === 'GET') {
    const { video_id, limit = 200, token } = req.query;
    if (!video_id) return res.status(400).json({ error: 'video_id obrigatório' });
    try {
      const r = await fetch(
        `${SU}/rest/v1/blue_comments?video_id=eq.${video_id}&order=created_at.desc&limit=${limit}&select=*`,
        { headers: h }
      );
      const comments = r.ok ? await r.json() : [];
      const userIds = [...new Set(comments.map(c => c.user_id).filter(Boolean))];
      let profiles = {};
      if (userIds.length > 0) {
        // avatar_url incluido (fix: foto nao aparecia nos comentarios)
        const pR = await fetch(
          `${SU}/rest/v1/blue_profiles?user_id=in.(${userIds.join(',')})&select=user_id,username,display_name,avatar_url,verificado`,
          { headers: h }
        );
        if (pR.ok) { const pd = await pR.json(); pd.forEach(p => profiles[p.user_id] = p); }
      }
      // liked_by_me: quais comentarios o user logado ja curtiu
      let likedSet = new Set();
      if (token && comments.length) {
        try {
          const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
          if (uR.ok) {
            const uid = (await uR.json()).id;
            const ids = comments.map(c => c.id).join(',');
            const lR = await fetch(`${SU}/rest/v1/blue_comment_likes?user_id=eq.${uid}&comment_id=in.(${ids})&select=comment_id`, { headers: h });
            if (lR.ok) (await lR.json()).forEach(l => likedSet.add(l.comment_id));
          }
        } catch (_) {}
      }
      const enriched = comments.map(c => ({
        ...c,
        likes: c.likes || 0,
        parent_id: c.parent_id || null,
        liked_by_me: likedSet.has(c.id),
        creator: profiles[c.user_id] || { username: 'usuário' },
      }));
      return res.status(200).json({ comments: enriched });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // POST action=like — curtir/descurtir um comentário (toggle)
  if (req.method === 'POST' && req.body?.action === 'like') {
    const { token, comment_id } = req.body || {};
    if (!token) return res.status(401).json({ error: 'Login necessário.' });
    if (!comment_id) return res.status(400).json({ error: 'comment_id obrigatório.' });
    try {
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (!uR.ok) return res.status(401).json({ error: 'Token inválido.' });
      const { id: userId } = await uR.json();

      // Ja curtiu? (unique comment_id+user_id)
      const exR = await fetch(`${SU}/rest/v1/blue_comment_likes?comment_id=eq.${comment_id}&user_id=eq.${userId}&select=id`, { headers: h });
      const existing = exR.ok ? await exR.json() : [];
      // Contador atual (+ autor e texto pro push de curtida)
      const cR = await fetch(`${SU}/rest/v1/blue_comments?id=eq.${comment_id}&select=likes,user_id,text,video_id`, { headers: h });
      const com = cR.ok ? (await cR.json())?.[0] : null;
      const cur = com?.likes || 0;

      let liked, likes;
      if (existing.length) {
        await fetch(`${SU}/rest/v1/blue_comment_likes?id=eq.${existing[0].id}`, { method: 'DELETE', headers: h });
        likes = Math.max(0, cur - 1); liked = false;
      } else {
        const insR = await fetch(`${SU}/rest/v1/blue_comment_likes`, {
          method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify({ comment_id, user_id: userId }),
        });
        // se colidiu no unique (race), nao incrementa
        likes = insR.ok ? cur + 1 : cur; liked = true;
      }
      await fetch(`${SU}/rest/v1/blue_comments?id=eq.${comment_id}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ likes }),
      }).catch(() => null);
      // ── notifica o AUTOR do comentário (só na curtida, não no descurtir;
      //    estilo Instagram "curtiu seu comentário" — user 2026-07-24) ──
      if (liked && com?.user_id && com.user_id !== userId) {
        try {
          const pr = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${userId}&select=username`, { headers: h });
          const uname = pr.ok ? (await pr.json())?.[0]?.username || 'alguém' : 'alguém';
          const trecho = String(com.text || '').slice(0, 40);
          const mensagem = `@${uname} curtiu seu comentário${trecho ? `: "${trecho}${(com.text || '').length > 40 ? '…' : ''}"` : ''}`;
          await fetch(`${SU}/rest/v1/blue_notificacoes`, {
            method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
            body: JSON.stringify({
              user_id: com.user_id, tipo: 'comment_like', titulo: 'Curtida no comentário', mensagem,
              dados: { from_user_id: userId, video_id: com.video_id, comment_id },
            }),
          }).catch(() => null);
          const { sendPushToUser } = require('./_helpers/push.js');
          await sendPushToUser(com.user_id, {
            title: 'Curtida no comentário', body: mensagem,
            data: { tipo: 'comment_like', from_user_id: userId, video_id: com.video_id, url: '/blue' },
          }).catch(() => null);
        } catch (e) { /* fail-soft */ }
      }
      return res.status(200).json({ ok: true, liked, likes });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // POST — cria comentário (ou resposta, via parent_id) com rate limiting
  if (req.method === 'POST') {
    const { token, video_id, text, parent_id } = req.body || {};
    if (!token) return res.status(401).json({ error: 'Login necessário para comentar.' });
    if (!video_id || !text?.trim()) return res.status(400).json({ error: 'Comentário não pode ser vazio.' });

    const cleanText = text.replace(/<[^>]*>/g, '').trim();
    if (cleanText.length < 3) return res.status(400).json({ error: 'Comentário muito curto (mínimo 3 caracteres).' });
    if (cleanText.length > 500) return res.status(400).json({ error: 'Comentário muito longo (máximo 500 caracteres).' });

    // Check for excessive links
    const linkCount = (cleanText.match(/https?:\/\//g) || []).length;
    if (linkCount >= 3) return res.status(400).json({ error: 'Comentários com muitos links não são permitidos.' });

    try {
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (!uR.ok) return res.status(401).json({ error: 'Token inválido.' });
      const { id: userId } = await uR.json();

      // ── RATE LIMITS ────────────────────────────────────────────────────────
      const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();

      // Max 10 comments per hour
      const hourRes = await fetch(
        `${SU}/rest/v1/blue_comments?user_id=eq.${userId}&created_at=gte.${oneHourAgo}&select=id`,
        { headers: h }
      );
      if (hourRes.ok && (await hourRes.json()).length >= 10) {
        return res.status(429).json({ error: 'Muitos comentários. Aguarde um pouco antes de comentar novamente.' });
      }

      // Max 3 comentários-RAIZ no mesmo vídeo (respostas não contam — senão
      // travaria a conversa em thread)
      if (!parent_id) {
        const vidRes = await fetch(
          `${SU}/rest/v1/blue_comments?user_id=eq.${userId}&video_id=eq.${video_id}&parent_id=is.null&select=id`,
          { headers: h }
        );
        if (vidRes.ok && (await vidRes.json()).length >= 3) {
          return res.status(429).json({ error: 'Você já comentou 3 vezes neste vídeo.' });
        }
      }

      // Duplicate check: same text within 1 hour
      const dupRes = await fetch(
        `${SU}/rest/v1/blue_comments?user_id=eq.${userId}&text=eq.${encodeURIComponent(cleanText)}&created_at=gte.${oneHourAgo}&select=id`,
        { headers: h }
      );
      if (dupRes.ok && (await dupRes.json()).length > 0) {
        return res.status(400).json({ error: 'Comentário duplicado.' });
      }

      // ── SAVE COMMENT ───────────────────────────────────────────────────────
      const cR = await fetch(`${SU}/rest/v1/blue_comments`, {
        method: 'POST', headers: { ...h, Prefer: 'return=representation' },
        body: JSON.stringify({ video_id, user_id: userId, text: cleanText, parent_id: parent_id || null, likes: 0 })
      });
      if (!cR.ok) return res.status(500).json({ error: 'Erro ao salvar comentário.' });
      const comment = (await cR.json())[0];

      // Increment comment counter on video.
      // IMPORTANTE: usa AWAIT (era fire-and-forget). Em serverless Vercel,
      // promises não-awaited antes de res.send são DESCARTADAS quando a
      // função encerra. Fix 2026-05-17.
      // FIX 03/08/2026: era `{ comments: 1 }` — isso ATRIBUI 1, não soma.
      // Todo vídeo ficava eternamente com "1 comentário" por mais que
      // recebesse (o app tem 15 comentários e nenhum vídeo mostrava mais que
      // 1). PostgREST não faz incremento atômico, então conta a fonte de
      // verdade (blue_comments) e grava o total.
      try {
        const cntR = await fetch(
          `${SU}/rest/v1/blue_comments?video_id=eq.${encodeURIComponent(video_id)}&select=id`,
          { headers: { ...h, Prefer: 'count=exact', Range: '0-0' } }
        );
        const cr = cntR.headers.get('content-range') || '';
        const total = parseInt((cr.split('/')[1] || '0'), 10) || 0;
        if (total > 0) {
          await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}`, {
            method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
            body: JSON.stringify({ comments: total })
          }).catch(() => null);
        }
      } catch (e) { /* contador nunca derruba o comentário */ }

      // ── CREATE NOTIFICATION for video owner ────────────────────────────────
      // Removida tentativa de INSERT em blue_notifications (tabela LEGACY
      // que NÃO existe — confirmado PGRST205, dead code silencioso). Mantida
      // apenas a tabela ativa blue_notificacoes (lida por blue-interact action=notificacoes).
      const jaNotificados = new Set([userId]); // dedupe: menção não repete notif
      try {
        // Resposta → notifica o autor do comentário-pai; raiz → dono do vídeo
        let targetId = null;
        if (parent_id) {
          const parR = await fetch(`${SU}/rest/v1/blue_comments?id=eq.${parent_id}&select=user_id`, { headers: h });
          targetId = parR.ok ? (await parR.json())?.[0]?.user_id : null;
        } else {
          const vr = await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}&select=user_id`, { headers: h });
          targetId = vr.ok ? (await vr.json())?.[0]?.user_id : null;
        }
        {
          const ownerId = targetId;
          if (ownerId) jaNotificados.add(ownerId);
          if (ownerId && ownerId !== userId) {
            const pr = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${userId}&select=username`, { headers: h });
            const username = pr.ok ? (await pr.json())?.[0]?.username || 'alguém' : 'alguém';
            const titulo = parent_id ? 'Nova resposta' : 'Novo comentário';
            const verbo = parent_id ? 'respondeu' : 'comentou';
            const mensagem = `@${username} ${verbo}: "${cleanText.slice(0, 60)}${cleanText.length > 60 ? '…' : ''}"`;
            // Notif persistente na inbox (await — eram fire-and-forget perdidos)
            await fetch(`${SU}/rest/v1/blue_notificacoes`, {
              method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
              body: JSON.stringify({
                user_id: ownerId, tipo: 'comment', titulo, mensagem,
                dados: { from_user_id: userId, video_id, comment_id: comment?.id || null },
              })
            }).catch(() => null);
            // Push mobile via Expo (await — também era fire-and-forget)
            try {
              const { sendPushToUser } = require('./_helpers/push.js');
              await sendPushToUser(ownerId, {
                title: titulo, body: mensagem,
                data: { tipo: 'comment', from_user_id: userId, video_id, url: '/blue' },
              }).catch(() => null);
            } catch(e) {}
          }
        }
      } catch(e) {}

      // ── MENÇÕES @usuario no comentário (estilo Instagram, user 2026-07-24) ──
      // Até 3 menções; não repete quem já foi notificado acima.
      try {
        const handles = [...new Set(
          [...cleanText.matchAll(/@([a-z0-9_.]{3,30})/gi)].map((m) => m[1].toLowerCase())
        )].slice(0, 3);
        if (handles.length) {
          const inList = handles.map((u) => `"${u}"`).join(',');
          const mR = await fetch(`${SU}/rest/v1/blue_profiles?username=in.(${inList})&select=user_id,username`, { headers: h });
          const alvos = mR.ok ? await mR.json() : [];
          if (alvos.length) {
            const pr = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${userId}&select=username`, { headers: h });
            const quem = pr.ok ? (await pr.json())?.[0]?.username || 'alguém' : 'alguém';
            const { sendPushToUser } = require('./_helpers/push.js');
            for (const alvo of alvos) {
              if (!alvo.user_id || jaNotificados.has(alvo.user_id)) continue;
              jaNotificados.add(alvo.user_id);
              const mensagem = `@${quem} mencionou você em um comentário`;
              await fetch(`${SU}/rest/v1/blue_notificacoes`, {
                method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
                body: JSON.stringify({
                  user_id: alvo.user_id, tipo: 'mention', titulo: 'Você foi mencionado', mensagem,
                  dados: { from_user_id: userId, video_id, comment_id: comment?.id || null },
                }),
              }).catch(() => null);
              await sendPushToUser(alvo.user_id, {
                title: 'Você foi mencionado', body: mensagem,
                data: { tipo: 'mention', from_user_id: userId, video_id, url: '/blue' },
              }).catch(() => null);
            }
          }
        }
      } catch (e) { /* fail-soft */ }

      return res.status(200).json({ comment });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }
};
