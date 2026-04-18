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

  // GET — lista comentários de um vídeo
  if (req.method === 'GET') {
    const { video_id, limit = 50 } = req.query;
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
        const pR = await fetch(
          `${SU}/rest/v1/blue_profiles?user_id=in.(${userIds.join(',')})&select=user_id,username,display_name`,
          { headers: h }
        );
        if (pR.ok) { const pd = await pR.json(); pd.forEach(p => profiles[p.user_id] = p); }
      }
      const enriched = comments.map(c => ({ ...c, creator: profiles[c.user_id] || { username: 'usuário' } }));
      return res.status(200).json({ comments: enriched });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // POST — cria comentário com rate limiting
  if (req.method === 'POST') {
    const { token, video_id, text } = req.body || {};
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

      // Max 3 comments on same video
      const vidRes = await fetch(
        `${SU}/rest/v1/blue_comments?user_id=eq.${userId}&video_id=eq.${video_id}&select=id`,
        { headers: h }
      );
      if (vidRes.ok && (await vidRes.json()).length >= 3) {
        return res.status(429).json({ error: 'Você já comentou 3 vezes neste vídeo.' });
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
        body: JSON.stringify({ video_id, user_id: userId, text: cleanText })
      });
      if (!cR.ok) return res.status(500).json({ error: 'Erro ao salvar comentário.' });
      const comment = (await cR.json())[0];

      // Increment comment counter on video
      fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ comments: 1 })
      }).catch(() => {});

      // ── CREATE NOTIFICATION for video owner ────────────────────────────────
      try {
        const vr = await fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}&select=user_id`, { headers: h });
        if (vr.ok) {
          const vd = await vr.json();
          const ownerId = vd?.[0]?.user_id;
          if (ownerId && ownerId !== userId) {
            const pr = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${userId}&select=username`, { headers: h });
            const username = pr.ok ? (await pr.json())?.[0]?.username || 'alguém' : 'alguém';
            const titulo = 'Novo comentário';
            const mensagem = `@${username} comentou: "${cleanText.slice(0, 60)}${cleanText.length > 60 ? '…' : ''}"`;
            // Tabela legacy (blue_notifications) — mantida por compatibilidade
            fetch(`${SU}/rest/v1/blue_notifications`, {
              method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
              body: JSON.stringify({
                user_id: ownerId, type: 'comment', from_user_id: userId, video_id,
                message: mensagem, read: false
              })
            }).catch(() => {});
            // Tabela ativa do feed da inbox (blue_notificacoes) — usado por blue-interact action=notificacoes
            fetch(`${SU}/rest/v1/blue_notificacoes`, {
              method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
              body: JSON.stringify({
                user_id: ownerId, tipo: 'comment', titulo, mensagem,
                dados: { from_user_id: userId, video_id, comment_id: comment?.id || null },
              })
            }).catch(() => {});
            // Push mobile via Expo (chega no celular)
            try {
              const { sendPushToUser } = require('./_helpers/push.js');
              sendPushToUser(ownerId, {
                title: titulo, body: mensagem,
                data: { tipo: 'comment', from_user_id: userId, video_id, url: '/blue' },
              }).catch(() => {});
            } catch(e) {}
          }
        }
      } catch(e) {}

      return res.status(200).json({ comment });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }
};
