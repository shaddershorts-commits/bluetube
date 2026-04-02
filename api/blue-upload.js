// api/blue-upload.js — Apenas metadata + retorna info para upload direto
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;

  try {
    const { token, title, description, duration, width, height,
            file_name, content_type, thumbnail_data, video_uploaded } = req.body || {};
    if (!token) return res.status(401).json({ error: 'Login necessário' });

    const uR = await fetch(`${SU}/auth/v1/user`, {
      headers: { apikey: AK, Authorization: 'Bearer ' + token }
    });
    if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
    const { id: userId } = await uR.json();

    const crypto = require('crypto');
    const videoId = crypto.randomUUID();
    const safe = (file_name || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${userId}/${videoId}/${safe}`;
    const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

    // Se veio thumbnail, faz upload via service key (pequeno, cabe no Vercel)
    let thumbnailUrl = null;
    if (thumbnail_data) {
      try {
        const thumbPath = `${userId}/${videoId}/thumb.jpg`;
        const buf = Buffer.from(thumbnail_data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const tR = await fetch(`${SU}/storage/v1/object/blue-videos/${thumbPath}`, {
          method: 'POST',
          headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
          body: buf
        });
        if (tR.ok) thumbnailUrl = `${SU}/storage/v1/object/public/blue-videos/${thumbPath}`;
        else console.log('thumb upload failed:', await tR.text());
      } catch(e) { console.log('thumb error:', e.message); }
    }

    const videoUrl = `${SU}/storage/v1/object/public/blue-videos/${storagePath}`;

    // Suporte a override de ID (passo 3 do upload em 3 etapas)
    const { _override_id, _override_url, _override_thumb } = req.body || {};
    const finalVideoId = _override_id || videoId;
    const finalVideoUrl = _override_url || `${SU}/storage/v1/object/public/blue-videos/${storagePath}`;
    const finalThumbUrl = _override_thumb || thumbnailUrl;

    if (!video_uploaded) {
      return res.status(200).json({
        ok: true,
        video_id: videoId,
        storage_path: storagePath,
        video_url: videoUrl,
        thumbnail_url: thumbnailUrl,
        supabase_url: SU,
        anon_key: AK,
        // Para o cliente fazer: PUT {supabase_url}/storage/v1/object/blue-videos/{storage_path}
        // Headers: apikey: {anon_key}, Authorization: Bearer {user_token}, Content-Type: {mime}
        user_token: token  // cliente usa para autenticar o upload direto
      });
    }

    // video_uploaded = true: salva no banco
    const vR = await fetch(`${SU}/rest/v1/blue_videos`, {
      method: 'POST',
      headers: { ...h, Prefer: 'return=representation' },
      body: JSON.stringify({
        id: finalVideoId, user_id: userId, title: title || '',
        description: description || '', video_url: finalVideoUrl,
        thumbnail_url: finalThumbUrl, duration: duration || 0,
        width: width || 1080, height: height || 1920,
        score: 50, status: 'active', test_phase: true
      })
    });
    const vData = await vR.json();
    const video = Array.isArray(vData) ? vData[0] : vData;
    if (!vR.ok) { console.log('DB insert error:', JSON.stringify(vData)); }

    return res.status(200).json({ ok: true, video });
  } catch(err) {
    console.error('blue-upload:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
