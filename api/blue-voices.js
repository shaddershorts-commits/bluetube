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

  // GET ?action=library — retorna vozes da Shared Library do ElevenLabs
  if (req.method === 'GET' && req.query.action === 'library') {
    if (!EL) return res.status(500).json({ error: 'ElevenLabs não configurado' });
    try {
      // Usa shared-voices (biblioteca pública, sem restrição de permissions)
      const langs = ['pt', 'en', 'es', 'fr', 'de', 'it'];
      const allVoices = [];

      for (const lang of langs) {
        try {
          const r = await fetch(`https://api.elevenlabs.io/v1/shared-voices?page_size=10&language=${lang}&sort=trending`, {
            headers: { 'xi-api-key': EL }
          });
          if (!r.ok) continue;
          const data = await r.json();
          (data.voices || []).forEach(v => {
            if (v.preview_url && !allVoices.find(x => x.id === v.voice_id)) {
              allVoices.push({
                id: v.voice_id,
                name: v.name,
                preview_url: v.preview_url,
                labels: {
                  language: lang,
                  gender: v.gender || '',
                  age: v.age || '',
                  use_case: v.use_case || v.category || '',
                  description: v.description || ''
                },
                category: v.category || ''
              });
            }
          });
        } catch(e) { continue; }
      }

      if (allVoices.length > 0) {
        return res.status(200).json({ voices: allVoices });
      }

      // Fallback: tenta endpoint clássico /v1/voices
      const r2 = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': EL }
      });
      if (r2.ok) {
        const data2 = await r2.json();
        const voices2 = (data2.voices || []).filter(v => v.preview_url).map(v => ({
          id: v.voice_id, name: v.name, preview_url: v.preview_url,
          labels: v.labels || {}, category: v.category || ''
        }));
        if (voices2.length > 0) return res.status(200).json({ voices: voices2 });
      }

      return res.status(200).json({ voices: [] });
    } catch(e) {
      console.error('blue-voices library error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  const token = req.method === 'GET' ? req.query.token : req.body?.token;
  if (!token) return res.status(401).json({ error: 'Login necessário' });

  // Valida usuário
  let userId;
  try {
    const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
    userId = (await uR.json()).id;
  } catch(e) { return res.status(401).json({ error: 'Token inválido' }); }

  // GET — lista vozes do usuário + vozes compartilhadas da comunidade Master
  if (req.method === 'GET') {
    try {
      // 1. Vozes próprias do usuário
      const r = await fetch(
        `${SU}/rest/v1/blue_custom_voices?user_id=eq.${userId}&order=created_at.asc&select=*`,
        { headers: h }
      );
      const myVoices = r.ok ? await r.json() : [];
      const myIds = new Set(myVoices.map(v => v.voice_id));

      // 2. Vozes da comunidade (todos os outros usuários Master)
      let communityVoices = [];
      try {
        // Busca todas as vozes customizadas de todos os usuários
        const cr = await fetch(
          `${SU}/rest/v1/blue_custom_voices?user_id=neq.${userId}&order=created_at.desc&limit=50&select=voice_id,name,user_id,created_at`,
          { headers: h }
        );
        if (cr.ok) {
          const all = await cr.json();
          // Remove duplicatas (mesmo voice_id)
          const seen = new Set();
          communityVoices = all.filter(v => {
            if (myIds.has(v.voice_id) || seen.has(v.voice_id)) return false;
            seen.add(v.voice_id);
            return true;
          }).map(v => ({ ...v, community: true }));
        }
      } catch(e) {}

      return res.status(200).json({ voices: myVoices, community: communityVoices });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // POST — adiciona voz
  if (req.method === 'POST') {
    const { voice_id, name } = req.body || {};
    if (!voice_id) return res.status(400).json({ error: 'voice_id obrigatório' });

    const finalName = name || 'Voz personalizada';

    // Tenta buscar nome real do ElevenLabs (mas não bloqueia se falhar)
    let realName = '';
    if (EL) {
      try {
        const check = await fetch(`https://api.elevenlabs.io/v1/voices/${voice_id}`, {
          headers: { 'xi-api-key': EL }
        });
        if (check.ok) {
          const vd = await check.json();
          realName = vd.name || '';
        }
      } catch(e) { /* não bloqueia — salva mesmo sem validar */ }
    }

    // Salva no banco (upsert) — sempre salva, mesmo que ElevenLabs não responda
    try {
      const r = await fetch(`${SU}/rest/v1/blue_custom_voices`, {
        method: 'POST',
        headers: { ...h, Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ user_id: userId, voice_id, name: realName || finalName })
      });
      const saved = await r.json();
      return res.status(200).json({ ok: true, voice: Array.isArray(saved) ? saved[0] : saved, real_name: realName || finalName });
    } catch(e) { return res.status(500).json({ error: e.message }); }
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
