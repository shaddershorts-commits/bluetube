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
        const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=in.(${uniqueIds.join(',')})&select=user_id,username,display_name,avatar_url,status`, { headers: h });
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

      const enriched = convs.map(c => ({
        ...c,
        other: profiles[c.user1_id === userId ? c.user2_id : c.user1_id] || {},
        unread: unreadMap[c.id] || 0
      }));
      return res.status(200).json({ conversations: enriched });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── GET messages ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'messages') {
    const { conv_id } = req.query;
    if (!conv_id) return res.status(400).json({ error: 'conv_id obrigatório' });
    try {
      // Mark messages as read
      fetch(`${SU}/rest/v1/blue_messages?conversation_id=eq.${conv_id}&receiver_id=eq.${userId}&read=eq.false`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ read: true })
      }).catch(() => {});

      const r = await fetch(
        `${SU}/rest/v1/blue_messages?conversation_id=eq.${conv_id}&order=created_at.asc&limit=100&select=*`,
        { headers: h }
      );
      return res.status(200).json({ messages: r.ok ? await r.json() : [] });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── POST send message ─────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'send') {
    const { to_user_id, text } = req.body;
    if (!to_user_id || !text?.trim()) return res.status(400).json({ error: 'to_user_id e text obrigatórios' });
    if (text.length > 1000) return res.status(400).json({ error: 'Mensagem muito longa' });
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
          body: JSON.stringify({ user1_id: u1, user2_id: u2, last_message: text.trim(), last_message_at: new Date().toISOString() })
        });
        const nc = await ncR.json();
        convId = (Array.isArray(nc) ? nc[0] : nc).id;
      }

      // Insert message
      const mR = await fetch(`${SU}/rest/v1/blue_messages`, {
        method: 'POST', headers: { ...h, Prefer: 'return=representation' },
        body: JSON.stringify({ conversation_id: convId, sender_id: userId, receiver_id: to_user_id, text: text.trim() })
      });
      const msg = await mR.json();

      // Update conversation last message
      fetch(`${SU}/rest/v1/blue_conversations?id=eq.${convId}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ last_message: text.trim(), last_message_at: new Date().toISOString() })
      }).catch(() => {});

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

  return res.status(400).json({ error: 'Ação inválida' });
};
