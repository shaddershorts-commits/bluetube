// api/blue-comment.js — Comentários do Blue
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
      // Busca perfis
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

  // POST — cria comentário
  if (req.method === 'POST') {
    const { token, video_id, text } = req.body || {};
    if (!token) return res.status(401).json({ error: 'Login necessário' });
    if (!video_id || !text?.trim()) return res.status(400).json({ error: 'video_id e text obrigatórios' });
    if (text.length > 300) return res.status(400).json({ error: 'Máximo 300 caracteres' });
    try {
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
      const { id: userId } = await uR.json();
      // Salva comentário
      const cR = await fetch(`${SU}/rest/v1/blue_comments`, {
        method: 'POST', headers: { ...h, Prefer: 'return=representation' },
        body: JSON.stringify({ video_id, user_id: userId, text: text.trim() })
      });
      if (!cR.ok) return res.status(500).json({ error: await cR.text() });
      const comment = (await cR.json())[0];
      // Incrementa contador de comments no vídeo
      fetch(`${SU}/rest/v1/blue_videos?id=eq.${video_id}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ comments: 1 }) // incremento simples, será somado via trigger
      }).catch(() => {});
      return res.status(200).json({ comment });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }
};
