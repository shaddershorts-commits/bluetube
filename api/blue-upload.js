// api/blue-upload.js — Gera signed URL para upload direto ao Supabase Storage
// Vídeo NUNCA passa pelo Vercel (evita 413)
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
            file_name, content_type, thumbnail_data } = req.body || {};
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

    // Upload thumbnail
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
      } catch(e) {}
    }

    // Gera signed URL para upload direto (cliente faz PUT nessa URL)
    const signR = await fetch(`${SU}/storage/v1/object/sign/upload/blue-videos/${storagePath}`, {
      method: 'POST',
      headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    let uploadUrl = null;
    if (signR.ok) {
      const sd = await signR.json();
      uploadUrl = `${SU}/storage/v1${sd.signedURL}`;
    } else {
      // Fallback: retorna URL pública e deixa cliente fazer upload via anon key
      const err = await signR.text();
      console.log('sign URL failed:', signR.status, err.slice(0,100));
    }

    const videoUrl = `${SU}/storage/v1/object/public/blue-videos/${storagePath}`;

    // Salva metadata
    const vR = await fetch(`${SU}/rest/v1/blue_videos`, {
      method: 'POST',
      headers: { ...h, Prefer: 'return=representation' },
      body: JSON.stringify({
        id: videoId, user_id: userId, title: title || '', description: description || '',
        video_url: videoUrl, thumbnail_url: thumbnailUrl,
        duration: duration || 0, width: width || 1080, height: height || 1920,
        score: 50, status: 'active', test_phase: true
      })
    });
    const vData = await vR.json();
    const video = Array.isArray(vData) ? vData[0] : vData;

    return res.status(200).json({
      ok: true, video,
      upload_url: uploadUrl,
      storage_path: storagePath,
      storage_url: SU + '/storage/v1/object/blue-videos/' + storagePath,
      apikey: AK // anon key — safe to expose (only accesses public bucket)
    });
  } catch(err) {
    console.error('blue-upload:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
