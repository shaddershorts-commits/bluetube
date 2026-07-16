// api/blue-chat.js — DM system: conversations, messages, status
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

  const action = req.method === 'GET' ? req.query.action : req.body?.action;
  const token  = req.method === 'GET' ? req.query.token  : req.body?.token;

  // Validate user
  let userId = null;
  if (token) {
    try {
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (uR.ok) userId = (await uR.json()).id;
    } catch(e) {}
  }
  if (!userId) return res.status(401).json({ error: 'Login necessário' });

  // ── HELPER: assertParticipant (fix B1) ──────────────────────────────────
  // Verifica que o userId logado eh participante da conversa antes de qualquer
  // operacao sensivel. Antes deste fix, GET messages?conv_id=X aceitava conv_id
  // arbitrario — qualquer user logado podia ler DMs de outros.
  // Loga tentativa bloqueada via console.error pra aparecer em Vercel Logs com
  // [SECURITY-BLOCK][blue-chat] — facil de filtrar/alertar depois.
  // Fail-closed: erro de query => return false (nao deixa passar).
  async function assertParticipant(convId, type) {
    try {
      const cR = await fetch(
        `${SU}/rest/v1/blue_conversations?id=eq.${convId}&select=id,user1_id,user2_id`,
        { headers: h }
      );
      const arr = cR.ok ? await cR.json() : [];
      if (arr.length === 0) {
        console.error('[SECURITY-BLOCK][blue-chat]', JSON.stringify({
          type, requester_id: userId, attempted_conv_id: convId,
          conv_participants: null, reason: 'conv_not_found',
          ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown',
          timestamp: new Date().toISOString(),
        }));
        return false;
      }
      const conv = arr[0];
      const ok = conv.user1_id === userId || conv.user2_id === userId;
      if (!ok) {
        console.error('[SECURITY-BLOCK][blue-chat]', JSON.stringify({
          type, requester_id: userId, attempted_conv_id: convId,
          conv_participants: [conv.user1_id, conv.user2_id], reason: 'not_participant',
          ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown',
          timestamp: new Date().toISOString(),
        }));
      }
      return ok;
    } catch (e) {
      console.error('[blue-chat][assertParticipant] erro:', e.message);
      return false; // fail-closed por seguranca
    }
  }

  // ── GET unread count (para badge de notificação) ──────────────────────────
  if (req.method === 'GET' && action === 'unread-count') {
    try {
      const r = await fetch(
        `${SU}/rest/v1/blue_messages?receiver_id=eq.${userId}&read=eq.false&select=id`,
        { headers: { ...h, Prefer: 'count=exact', Range: '0-0' } }
      );
      const count = parseInt(r.headers?.get?.('Content-Range')?.split('/')[1] || '0') || 0;
      return res.status(200).json({ count });
    } catch(e) { return res.status(200).json({ count: 0 }); }
  }

  // ── GET conversations list ────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'conversations') {
    try {
      // Ticks estilo WhatsApp: buscar conversas = "meu aparelho recebeu" →
      // marca delivered nas mensagens destinadas a mim (fire com await:
      // serverless descarta promises nao-aguardadas)
      await fetch(`${SU}/rest/v1/blue_messages?receiver_id=eq.${userId}&delivered=eq.false`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ delivered: true })
      }).catch(() => {});
      const r = await fetch(
        `${SU}/rest/v1/blue_conversations?or=(user1_id.eq.${userId},user2_id.eq.${userId})&order=last_message_at.desc&limit=30&select=*`,
        { headers: h }
      );
      if (!r.ok) return res.status(200).json({ conversations: [] });
      const convs = await r.json();

      // Get other user profiles
      const otherIds = convs.map(c => c.user1_id === userId ? c.user2_id : c.user1_id);
      const uniqueIds = [...new Set(otherIds)];
      let profiles = {};
      if (uniqueIds.length > 0) {
        const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=in.(${uniqueIds.join(',')})&select=user_id,username,display_name,avatar_url,status,status_updated_at`, { headers: h });
        if (pR.ok) { const pd = await pR.json(); pd.forEach(p => profiles[p.user_id] = p); }
      }

      // Count unread
      const unreadR = await fetch(
        `${SU}/rest/v1/blue_messages?receiver_id=eq.${userId}&read=eq.false&select=conversation_id`,
        { headers: h }
      );
      let unreadMap = {};
      if (unreadR.ok) {
        const ur = await unreadR.json();
        ur.forEach(m => unreadMap[m.conversation_id] = (unreadMap[m.conversation_id]||0) + 1);
      }

      // v3: prefs (fixado/apagada) + contatos (aba "Novos contatos")
      const convIds = convs.map(c => c.id);
      let prefsMap = {}, meusContatos = new Set();
      if (convIds.length) {
        const [prR, ctR] = await Promise.all([
          fetch(`${SU}/rest/v1/blue_conv_prefs?user_id=eq.${userId}&conv_id=in.(${convIds.join(',')})&select=conv_id,pinned,cleared_at`, { headers: h }),
          fetch(`${SU}/rest/v1/blue_contatos?user_id=eq.${userId}&select=contato_id`, { headers: h }),
        ]);
        if (prR.ok) (await prR.json()).forEach(p => prefsMap[p.conv_id] = p);
        if (ctR.ok) (await ctR.json()).forEach(c => meusContatos.add(c.contato_id));
      }

      const enriched = convs.map(c => {
        const otherId = c.user1_id === userId ? c.user2_id : c.user1_id;
        const pref = prefsMap[c.id] || {};
        // Apagada "pra mim" e sem mensagem nova depois → some da lista
        if (pref.cleared_at && (!c.last_message_at || new Date(c.last_message_at) <= new Date(pref.cleared_at))) return null;
        return {
          ...c,
          other: profiles[otherId] || {},
          unread: unreadMap[c.id] || 0,
          pinned: !!pref.pinned,
          // Novo contato: o OUTRO iniciou e eu ainda não adicionei
          is_request: c.initiator_id === otherId && !meusContatos.has(otherId),
        };
      }).filter(Boolean);
      return res.status(200).json({ conversations: enriched });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── GET messages ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'messages') {
    const { conv_id } = req.query;
    if (!conv_id) return res.status(400).json({ error: 'conv_id obrigatório' });
    // FIX B1: valida que userId eh participante antes de retornar mensagens.
    // Sem isso, qualquer user logado podia ler DMs de outros via conv_id arbitrario.
    const ok = await assertParticipant(conv_id, 'messages_read');
    if (!ok) return res.status(403).json({ error: 'forbidden' });
    try {
      // Mark messages as read
      fetch(`${SU}/rest/v1/blue_messages?conversation_id=eq.${conv_id}&receiver_id=eq.${userId}&read=eq.false`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ read: true })
      }).catch(() => {});

      const [r, prR] = await Promise.all([
        fetch(`${SU}/rest/v1/blue_messages?conversation_id=eq.${conv_id}&order=created_at.asc&limit=100&select=*`, { headers: h }),
        fetch(`${SU}/rest/v1/blue_conv_prefs?user_id=eq.${userId}&conv_id=eq.${conv_id}&select=cleared_at`, { headers: h }),
      ]);
      let msgs = r.ok ? await r.json() : [];
      const clearedAt = prR.ok ? (await prR.json())[0]?.cleared_at : null;
      msgs = msgs.filter(m =>
        !(Array.isArray(m.deleted_for) && m.deleted_for.includes(userId)) &&
        (!clearedAt || new Date(m.created_at) > new Date(clearedAt))
      );
      return res.status(200).json({ messages: msgs });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── POST send message ─────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'send') {
    const { to_user_id, text, media_url, media_type, media_duration } = req.body;
    const hasText = !!text?.trim();
    // 'share' = vídeo do Blue compartilhado no chat (media_url = video_id)
    const hasMedia = !!media_url && ['image', 'video', 'audio', 'gif', 'share'].includes(media_type);
    if (!to_user_id || (!hasText && !hasMedia)) return res.status(400).json({ error: 'to_user_id e text (ou mídia) obrigatórios' });
    if (hasText && text.length > 1000) return res.status(400).json({ error: 'Mensagem muito longa' });
    // Preview na lista de conversas quando for midia
    const preview = hasText ? text.trim()
      : media_type === 'image' ? '📷 Foto'
      : media_type === 'gif' ? '🎞️ GIF'
      : media_type === 'video' ? '🎬 Vídeo'
      : media_type === 'share' ? '🎬 Vídeo do Blue'
      : '🎤 Áudio';
    if (to_user_id === userId) return res.status(400).json({ error: 'Não pode enviar para si mesmo' });

    try {
      // Find or create conversation (sorted user IDs to avoid duplicates)
      const [u1, u2] = [userId, to_user_id].sort();
      let convId;

      const cR = await fetch(
        `${SU}/rest/v1/blue_conversations?user1_id=eq.${u1}&user2_id=eq.${u2}&select=id`,
        { headers: h }
      );
      const existing = cR.ok ? await cR.json() : [];

      if (existing.length > 0) {
        convId = existing[0].id;
      } else {
        const ncR = await fetch(`${SU}/rest/v1/blue_conversations`, {
          method: 'POST', headers: { ...h, Prefer: 'return=representation' },
          body: JSON.stringify({ user1_id: u1, user2_id: u2, initiator_id: userId, last_message: preview, last_message_at: new Date().toISOString() })
        });
        const nc = await ncR.json();
        convId = (Array.isArray(nc) ? nc[0] : nc).id;
      }

      // Quem manda mensagem conhece o destinatário → vira meu contato
      // (a conversa nunca cai em "Novos contatos" PRA MIM; pro outro cai)
      fetch(`${SU}/rest/v1/blue_contatos`, {
        method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: userId, contato_id: to_user_id }),
      }).catch(() => {});

      // Insert message (texto e/ou midia)
      const mR = await fetch(`${SU}/rest/v1/blue_messages`, {
        method: 'POST', headers: { ...h, Prefer: 'return=representation' },
        body: JSON.stringify({
          conversation_id: convId, sender_id: userId, receiver_id: to_user_id,
          text: hasText ? text.trim() : '',
          media_url: hasMedia ? media_url : null,
          media_type: hasMedia ? media_type : null,
          media_duration: hasMedia ? (parseInt(media_duration) || null) : null,
        })
      });
      const msg = await mR.json();

      // Update conversation last message
      await fetch(`${SU}/rest/v1/blue_conversations?id=eq.${convId}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ last_message: preview, last_message_at: new Date().toISOString() })
      }).catch(() => {});

      // Notificacao inbox (blue_notificacoes — tabela VIVA; blue_notifications
      // e legacy inexistente). Dedupe: 1 notif nao-lida por remetente.
      try {
        const dupR = await fetch(
          `${SU}/rest/v1/blue_notificacoes?user_id=eq.${to_user_id}&tipo=eq.mensagem&lida=eq.false&dados->>from_user_id=eq.${userId}&select=id&limit=1`,
          { headers: h }
        );
        const dup = dupR.ok ? await dupR.json() : [];
        if (!dup.length) {
          const pr = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${userId}&select=username`, { headers: h });
          const username = pr.ok ? (await pr.json())?.[0]?.username || 'alguém' : 'alguém';
          await fetch(`${SU}/rest/v1/blue_notificacoes`, {
            method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
            body: JSON.stringify({
              user_id: to_user_id, tipo: 'mensagem', titulo: 'Nova mensagem',
              mensagem: `@${username}: "${preview.slice(0, 60)}${preview.length > 60 ? '…' : ''}"`,
              dados: { from_user_id: userId, conv_id: convId },
            })
          }).catch(() => null);
          try {
            const { sendPushToUser } = require('./_helpers/push.js');
            await sendPushToUser(to_user_id, { title: 'Nova mensagem', body: `@${username} te mandou uma mensagem` });
          } catch (_) {}
        }
      } catch (_) {}

      return res.status(200).json({ message: Array.isArray(msg) ? msg[0] : msg, conv_id: convId });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── POST update status ────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'status') {
    const { status } = req.body;
    const valid = ['online', 'away', 'busy', 'offline'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Status inválido' });
    try {
      await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${userId}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ status, status_updated_at: new Date().toISOString() })
      });
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── GET presence: online / visto por ultimo (header da conversa) ─────────
  // Privacidade "Novos contatos": só vê presença de quem TE adicionou.
  // (Conversas antigas foram semeadas como contatos mútuos na migração v3.)
  if (req.method === 'GET' && action === 'presence') {
    const uid = req.query.user_id;
    if (!uid) return res.status(400).json({ error: 'user_id obrigatório' });
    try {
      const ctR = await fetch(`${SU}/rest/v1/blue_contatos?user_id=eq.${encodeURIComponent(uid)}&contato_id=eq.${userId}&select=contato_id&limit=1`, { headers: h });
      const souContato = ctR.ok && (await ctR.json()).length > 0;
      if (!souContato) return res.status(200).json({ status: 'hidden', status_updated_at: null });
      const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${encodeURIComponent(uid)}&select=status,status_updated_at`, { headers: h });
      const p = pR.ok ? (await pR.json())?.[0] : null;
      return res.status(200).json({ status: p?.status || 'offline', status_updated_at: p?.status_updated_at || null });
    } catch (e) { return res.status(200).json({ status: 'offline', status_updated_at: null }); }
  }

  // ── POST get or create conversation ──────────────────────────────────────
  if (req.method === 'POST' && action === 'open-conv') {
    const { with_user_id } = req.body;
    if (!with_user_id) return res.status(400).json({ error: 'with_user_id obrigatório' });
    try {
      const [u1, u2] = [userId, with_user_id].sort();
      const cR = await fetch(`${SU}/rest/v1/blue_conversations?user1_id=eq.${u1}&user2_id=eq.${u2}&select=id`, { headers: h });
      const existing = cR.ok ? await cR.json() : [];
      let convId;
      if (existing.length > 0) {
        convId = existing[0].id;
      } else {
        const ncR = await fetch(`${SU}/rest/v1/blue_conversations`, {
          method: 'POST', headers: { ...h, Prefer: 'return=representation' },
          body: JSON.stringify({ user1_id: u1, user2_id: u2, last_message: '', last_message_at: new Date().toISOString() })
        });
        const nc = await ncR.json();
        convId = (Array.isArray(nc) ? nc[0] : nc).id;
      }
      // Get other user profile
      const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${with_user_id}&select=*`, { headers: h });
      const pArr = pR.ok ? await pR.json() : [];
      return res.status(200).json({ conv_id: convId, other: pArr[0] || {} });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ══ CHAT v3 (2026-07-16) — fixar/apagar conversa, contatos/requests,
  //    apagar/editar mensagem, ranking pra compartilhar ══════════════════════

  // ── POST conv-pin: fixa/desafixa conversa (por usuário) ───────────────────
  if (req.method === 'POST' && action === 'conv-pin') {
    const { conv_id } = req.body;
    if (!conv_id || !(await assertParticipant(conv_id, 'conv_pin'))) return res.status(403).json({ error: 'forbidden' });
    try {
      const pR = await fetch(`${SU}/rest/v1/blue_conv_prefs?user_id=eq.${userId}&conv_id=eq.${conv_id}&select=pinned`, { headers: h });
      const cur = pR.ok ? (await pR.json())[0] : null;
      const pinned = !(cur?.pinned);
      await fetch(`${SU}/rest/v1/blue_conv_prefs`, {
        method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: userId, conv_id, pinned }),
      });
      return res.status(200).json({ ok: true, pinned });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── POST conv-clear: "apagar conversa" (só pra mim — cleared_at) ──────────
  if (req.method === 'POST' && action === 'conv-clear') {
    const { conv_id } = req.body;
    if (!conv_id || !(await assertParticipant(conv_id, 'conv_clear'))) return res.status(403).json({ error: 'forbidden' });
    try {
      await fetch(`${SU}/rest/v1/blue_conv_prefs`, {
        method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: userId, conv_id, cleared_at: new Date().toISOString() }),
      });
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── POST contato-add: aceita "novo contato" → conversa vai pra lista main ─
  if (req.method === 'POST' && action === 'contato-add') {
    const { user_id: cid } = req.body;
    if (!cid || cid === userId) return res.status(400).json({ error: 'user_id inválido' });
    try {
      await fetch(`${SU}/rest/v1/blue_contatos`, {
        method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: userId, contato_id: cid }),
      });
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── POST msg-delete: apagar pra mim (sempre) ou pra todos (minha, ≤3h) ────
  if (req.method === 'POST' && action === 'msg-delete') {
    const { message_id, scope } = req.body; // scope: 'me' | 'all'
    if (!message_id) return res.status(400).json({ error: 'message_id obrigatório' });
    try {
      const mR = await fetch(`${SU}/rest/v1/blue_messages?id=eq.${encodeURIComponent(message_id)}&select=id,sender_id,receiver_id,created_at,deleted_for`, { headers: h });
      const msg = mR.ok ? (await mR.json())[0] : null;
      if (!msg || (msg.sender_id !== userId && msg.receiver_id !== userId)) return res.status(403).json({ error: 'forbidden' });
      if (scope === 'all') {
        if (msg.sender_id !== userId) return res.status(403).json({ error: 'Só quem enviou pode apagar pra todos.' });
        if (Date.now() - new Date(msg.created_at).getTime() > 3 * 3600 * 1000) {
          return res.status(400).json({ error: 'Só dá pra apagar o envio nas primeiras 3 horas.' });
        }
        await fetch(`${SU}/rest/v1/blue_messages?id=eq.${encodeURIComponent(message_id)}`, {
          method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify({ deleted_for_all: true, text: '', media_url: null, media_type: null }),
        });
      } else {
        const df = Array.isArray(msg.deleted_for) ? msg.deleted_for : [];
        if (!df.includes(userId)) df.push(userId);
        await fetch(`${SU}/rest/v1/blue_messages?id=eq.${encodeURIComponent(message_id)}`, {
          method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify({ deleted_for: df }),
        });
      }
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── POST msg-edit: editar minha mensagem (≤3h, máx 3 edições) ─────────────
  if (req.method === 'POST' && action === 'msg-edit') {
    const { message_id, text } = req.body;
    const novo = (text || '').trim();
    if (!message_id || !novo) return res.status(400).json({ error: 'message_id e text obrigatórios' });
    if (novo.length > 1000) return res.status(400).json({ error: 'Mensagem muito longa' });
    try {
      const mR = await fetch(`${SU}/rest/v1/blue_messages?id=eq.${encodeURIComponent(message_id)}&select=id,sender_id,created_at,edited_count,deleted_for_all`, { headers: h });
      const msg = mR.ok ? (await mR.json())[0] : null;
      if (!msg || msg.sender_id !== userId) return res.status(403).json({ error: 'forbidden' });
      if (msg.deleted_for_all) return res.status(400).json({ error: 'Mensagem apagada.' });
      if (Date.now() - new Date(msg.created_at).getTime() > 3 * 3600 * 1000) {
        return res.status(400).json({ error: 'Só dá pra editar nas primeiras 3 horas.' });
      }
      if ((msg.edited_count || 0) >= 3) return res.status(400).json({ error: 'Limite de 3 edições atingido.' });
      await fetch(`${SU}/rest/v1/blue_messages?id=eq.${encodeURIComponent(message_id)}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ text: novo, edited_count: (msg.edited_count || 0) + 1, edited_at: new Date().toISOString() }),
      });
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── GET top-chats: contatos+grupos que EU mais mando mensagem (share) ─────
  if (req.method === 'GET' && action === 'top-chats') {
    try {
      const [mR, gR] = await Promise.all([
        fetch(`${SU}/rest/v1/blue_messages?sender_id=eq.${userId}&order=created_at.desc&limit=300&select=receiver_id`, { headers: h }),
        fetch(`${SU}/rest/v1/blue_grupo_mensagens?user_id=eq.${userId}&order=created_at.desc&limit=200&select=grupo_id`, { headers: h }),
      ]);
      const msgs = mR.ok ? await mR.json() : [];
      const gmsgs = gR.ok ? await gR.json() : [];
      const rank = {};
      msgs.forEach((m) => { rank['u:' + m.receiver_id] = (rank['u:' + m.receiver_id] || 0) + 1; });
      gmsgs.forEach((m) => { rank['g:' + m.grupo_id] = (rank['g:' + m.grupo_id] || 0) + 1; });
      const top = Object.entries(rank).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const uids = top.filter(([k]) => k.startsWith('u:')).map(([k]) => k.slice(2));
      const gids = top.filter(([k]) => k.startsWith('g:')).map(([k]) => k.slice(2));
      const [pR2, gR2] = await Promise.all([
        uids.length ? fetch(`${SU}/rest/v1/blue_profiles?user_id=in.(${uids.join(',')})&select=user_id,username,display_name,avatar_url`, { headers: h }) : null,
        gids.length ? fetch(`${SU}/rest/v1/blue_grupos?id=in.(${gids.join(',')})&select=id,nome,avatar_url`, { headers: h }) : null,
      ]);
      const profs = pR2?.ok ? await pR2.json() : [];
      const grupos = gR2?.ok ? await gR2.json() : [];
      const items = top.map(([k]) => {
        if (k.startsWith('u:')) {
          const p = profs.find((x) => x.user_id === k.slice(2));
          return p ? { type: 'user', id: p.user_id, nome: p.display_name || p.username, username: p.username, avatar: p.avatar_url } : null;
        }
        const g = grupos.find((x) => x.id === k.slice(2));
        return g ? { type: 'grupo', id: g.id, nome: g.nome, avatar: g.avatar_url } : null;
      }).filter(Boolean);
      return res.status(200).json({ chats: items });
    } catch (e) { return res.status(200).json({ chats: [] }); }
  }

  return res.status(400).json({ error: 'Ação inválida' });
};
