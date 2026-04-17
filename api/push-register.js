// api/push-register.js — app registra/desregistra tokens Expo Push (CommonJS)
// POST   body: { token, expo_push_token, platform?, device_name? }
// DELETE body: { token, expo_push_token }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });

  const body = req.body || {};
  const token = body.token;
  const expoPushToken = body.expo_push_token;
  if (!token) return res.status(401).json({ error: 'token_obrigatorio' });
  if (!expoPushToken || typeof expoPushToken !== 'string' || !expoPushToken.startsWith('ExponentPushToken')) {
    return res.status(400).json({ error: 'expo_push_token_invalido' });
  }

  // Resolve user via Supabase Auth
  let userId;
  try {
    const uR = await fetch(`${SU}/auth/v1/user`, {
      headers: { apikey: AK, Authorization: 'Bearer ' + token },
    });
    if (!uR.ok) return res.status(401).json({ error: 'token_invalido' });
    const uD = await uR.json();
    userId = uD.id;
  } catch (e) {
    return res.status(401).json({ error: 'token_invalido' });
  }

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  if (req.method === 'DELETE') {
    await fetch(
      `${SU}/rest/v1/user_push_tokens?expo_push_token=eq.${encodeURIComponent(expoPushToken)}&user_id=eq.${userId}`,
      { method: 'DELETE', headers: h }
    ).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  // POST: upsert pela unique em expo_push_token (se outro user logar no mesmo device, transfere)
  try {
    const r = await fetch(`${SU}/rest/v1/user_push_tokens?on_conflict=expo_push_token`, {
      method: 'POST',
      headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        user_id: userId,
        expo_push_token: expoPushToken,
        platform: body.platform || null,
        device_name: body.device_name || null,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      return res.status(500).json({ error: 'upsert_failed', detail: err.slice(0, 200) });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
