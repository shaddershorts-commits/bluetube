// api/blue-profile.js — Perfil de usuário do Blue
// GET ?token=xxx  |  POST { token, username, display_name, avatar_url, bio }

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
  const token = req.method === 'GET' ? req.query.token : req.body?.token;

  if (!token) return res.status(401).json({ error: 'Token obrigatório' });

  try {
    const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
    const uData = await uR.json();
    const userId = uData.id;
    const email = uData.email;

    if (req.method === 'GET') {
      const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${userId}&select=*`, { headers: h });
      const pArr = pR.ok ? await pR.json() : [];
      let profile = pArr[0];

      // Auto-cria perfil se não existir
      if (!profile) {
        const username = email ? email.split('@')[0].replace(/[^a-z0-9_]/gi, '').toLowerCase() : 'user_' + userId.slice(0, 6);
        const newP = await fetch(`${SU}/rest/v1/blue_profiles`, {
          method: 'POST', headers: { ...h, Prefer: 'return=representation' },
          body: JSON.stringify({ user_id: userId, email, username, display_name: username, created_at: new Date().toISOString() })
        });
        const newPData = await newP.json();
        profile = Array.isArray(newPData) ? newPData[0] : newPData;
      }
      return res.status(200).json({ profile });
    }

    if (req.method === 'POST') {
      const { username, display_name, avatar_url, bio } = req.body;
      const patch = {};
      if (username) patch.username = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (display_name) patch.display_name = display_name;
      if (avatar_url) patch.avatar_url = avatar_url;
      if (bio !== undefined) patch.bio = bio;
      patch.updated_at = new Date().toISOString();

      await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${userId}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(patch)
      });
      return res.status(200).json({ ok: true });
    }
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
};
