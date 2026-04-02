// api/blue-upload.js — Upload de vídeo (metadata + signed URL do Supabase Storage)
// POST { token, title, description, duration, width, height, file_name, content_type, thumbnail_data }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  try {
    const { token, title, description, duration, width, height, file_name, content_type, thumbnail_data, video_url } = req.body || {};
    if (!token) return res.status(401).json({ error: 'Login necessário' });

    // Verifica usuário
    const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
    const uData = await uR.json();
    const userId = uData.id;

    const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
    const videoId = crypto.randomUUID ? crypto.randomUUID() : require('crypto').randomUUID();
    const safeName = file_name ? file_name.replace(/[^a-zA-Z0-9._-]/g, '_') : `video_${Date.now()}.mp4`;
    const storagePath = `${userId}/${videoId}/${safeName}`;

    // Upload thumbnail se veio em base64
    let thumbnailUrl = null;
    if (thumbnail_data) {
      const thumbPath = `${userId}/${videoId}/thumb.jpg`;
      const thumbBuf = Buffer.from(thumbnail_data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      const thumbR = await fetch(`${SU}/storage/v1/object/blue-videos/${thumbPath}`, {
        method: 'POST',
        headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
        body: thumbBuf
      });
      if (thumbR.ok) thumbnailUrl = `${SU}/storage/v1/object/public/blue-videos/${thumbPath}`;
    }

    // Salva metadata
    const finalVideoUrl = video_url || `${SU}/storage/v1/object/public/blue-videos/${storagePath}`;
    const vidR = await fetch(`${SU}/rest/v1/blue_videos`, {
      method: 'POST',
      headers: { ...h, Prefer: 'return=representation' },
      body: JSON.stringify({ id: videoId, user_id: userId, title: title || '', description: description || '', video_url: finalVideoUrl, thumbnail_url: thumbnailUrl, duration: duration || 0, width: width || 1080, height: height || 1920, score: 50, status: 'active', test_phase: true })
    });

    const vidData = await vidR.json();
    const vid = Array.isArray(vidData) ? vidData[0] : vidData;

    // Atualiza contagem de vídeos do perfil
    fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${userId}`, {
      method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({ videos_count: 1, updated_at: new Date().toISOString() })
    }).catch(() => {});

    // Gera signed URL para upload direto do cliente
    const signedR = await fetch(`${SU}/storage/v1/object/sign/blue-videos/${storagePath}`, {
      method: 'POST',
      headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 3600 })
    });
    let uploadUrl = null;
    if (signedR.ok) {
      const sd = await signedR.json();
      uploadUrl = `${SU}/storage/v1${sd.signedURL}`;
    }

    return res.status(200).json({ video: vid, upload_url: uploadUrl, storage_path: storagePath });
  } catch(err) {
    console.error('blue-upload error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
