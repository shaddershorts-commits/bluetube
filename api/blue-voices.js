// api/blue-voices.js — Vozes customizadas do BlueVoice salvas no Supabase
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const EL = process.env.ELEVENLABS_API_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  const token = req.method === 'GET' ? req.query.token : req.body?.token;
  if (!token) return res.status(401).json({ error: 'Login necessário' });

  // Valida usuário
  let userId;
  try {
    const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
    userId = (await uR.json()).id;
  } catch(e) { return res.status(401).json({ error: 'Token inválido' }); }

  // GET — lista vozes do usuário
  if (req.method === 'GET') {
    try {
      const r = await fetch(
        `${SU}/rest/v1/blue_custom_voices?user_id=eq.${userId}&order=created_at.asc&select=*`,
        { headers: h }
      );
      const voices = r.ok ? await r.json() : [];
      return res.status(200).json({ voices });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // POST — adiciona voz
  if (req.method === 'POST') {
    const { voice_id, name } = req.body || {};
    if (!voice_id) return res.status(400).json({ error: 'voice_id obrigatório' });

    // Valida se a voz existe no ElevenLabs tentando buscar preview
    if (EL) {
      try {
        const check = await fetch(`https://api.elevenlabs.io/v1/voices/${voice_id}`, {
          headers: { 'xi-api-key': EL }
        });
        if (!check.ok) return res.status(404).json({ error: 'Voz não encontrada no ElevenLabs. Verifique o Voice ID.' });
        const vd = await check.json();
        // Use the real name from ElevenLabs if not provided
        const finalName = name || vd.name || 'Voz personalizada';

        // Salva no banco (upsert)
        const r = await fetch(`${SU}/rest/v1/blue_custom_voices`, {
          method: 'POST',
          headers: { ...h, Prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify({ user_id: userId, voice_id, name: finalName })
        });
        const saved = await r.json();
        return res.status(200).json({ ok: true, voice: Array.isArray(saved) ? saved[0] : saved, real_name: vd.name });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    } else {
      // Sem chave ElevenLabs, salva direto sem validar
      try {
        const r = await fetch(`${SU}/rest/v1/blue_custom_voices`, {
          method: 'POST',
          headers: { ...h, Prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify({ user_id: userId, voice_id, name: name || 'Voz personalizada' })
        });
        const saved = await r.json();
        return res.status(200).json({ ok: true, voice: Array.isArray(saved) ? saved[0] : saved });
      } catch(e) { return res.status(500).json({ error: e.message }); }
    }
  }

  // DELETE — remove voz
  if (req.method === 'DELETE') {
    const { voice_id } = req.body || {};
    if (!voice_id) return res.status(400).json({ error: 'voice_id obrigatório' });
    try {
      await fetch(`${SU}/rest/v1/blue_custom_voices?user_id=eq.${userId}&voice_id=eq.${voice_id}`, {
        method: 'DELETE', headers: h
      });
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(405).end();
};
