// api/blue-upload.js — Salva metadata + retorna destino de upload
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'Env vars não configuradas' });

  try {
    const { token, title, description, duration, width, height, file_name, content_type, thumbnail_data } = req.body || {};
    if (!token) return res.status(401).json({ error: 'Login necessário' });

    // Valida token
    const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!uR.ok) return res.status(401).json({ error: 'Token inválido — faça login novamente' });
    const { id: userId, email } = await uR.json();

    const crypto = require('crypto');
    const videoId = crypto.randomUUID();
    const ext = (file_name || 'video.mp4').split('.').pop().replace(/[^a-z0-9]/gi, '') || 'mp4';
    const storagePath = `${userId}/${videoId}/video.${ext}`;
    const videoUrl = `${SU}/storage/v1/object/public/blue-videos/${storagePath}`;
    const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

    // Upload thumbnail se veio (pequena, cabe no Vercel)
    let thumbnailUrl = null;
    if (thumbnail_data && thumbnail_data.length < 500000) {
      try {
        const thumbPath = `${userId}/${videoId}/thumb.jpg`;
        const buf = Buffer.from(thumbnail_data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const tR = await fetch(`${SU}/storage/v1/object/blue-videos/${thumbPath}`, {
          method: 'POST',
          headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
          body: buf
        });
        if (tR.ok) thumbnailUrl = `${SU}/storage/v1/object/public/blue-videos/${thumbPath}`;
        else console.log('thumb failed:', tR.status, await tR.text());
      } catch(e) { console.log('thumb error:', e.message); }
    }

    // Garante que o perfil existe
    try {
      const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${userId}`, { headers: h });
      if (pR.ok) {
        const pArr = await pR.json();
        if (!pArr.length) {
          const uname = (email || 'user').split('@')[0].replace(/[^a-z0-9]/gi,'').toLowerCase().slice(0,20) || 'blue'+userId.slice(0,6);
          await fetch(`${SU}/rest/v1/blue_profiles`, {
            method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
            body: JSON.stringify({ user_id: userId, email: email||'', username: uname, display_name: uname })
          });
        }
      }
    } catch(e) {}

    // Salva registro no banco AGORA com URL esperada
    const vR = await fetch(`${SU}/rest/v1/blue_videos`, {
      method: 'POST',
      headers: { ...h, Prefer: 'return=representation' },
      body: JSON.stringify({
        id: videoId, user_id: userId,
        title: (title||'').slice(0,100),
        description: (description||'').slice(0,500),
        video_url: videoUrl,
        thumbnail_url: thumbnailUrl,
        duration: parseFloat(duration)||0,
        width: parseInt(width)||1080,
        height: parseInt(height)||1920,
        score: 50, status: 'active', test_phase: true
      })
    });
    if (!vR.ok) {
      const err = await vR.text();
      console.error('DB insert failed:', vR.status, err);
      return res.status(500).json({ error: 'Erro ao salvar no banco: ' + err.slice(0,100) });
    }
    const vData = await vR.json();
    const video = Array.isArray(vData) ? vData[0] : vData;

    return res.status(200).json({
      ok: true,
      video,
      storage_path: storagePath,
      video_url: videoUrl,
      supabase_url: SU,
      anon_key: AK,
      user_token: token
    });
  } catch(err) {
    console.error('blue-upload fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
