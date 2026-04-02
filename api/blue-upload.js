// api/blue-upload.js — Upload via multipart direto para Supabase Storage
const { Readable } = require('stream');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Title, X-Description, X-Duration, X-Width, X-Height, X-Filename, X-Thumbnail');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;

  try {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Login necessário' });

    // Verifica usuário
    const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
    const uData = await uR.json();
    const userId = uData.id;

    const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
    const crypto = require('crypto');
    const videoId = crypto.randomUUID();

    const title = req.headers['x-title'] || '';
    const description = req.headers['x-description'] || '';
    const duration = parseFloat(req.headers['x-duration'] || '0');
    const width = parseInt(req.headers['x-width'] || '1080');
    const height = parseInt(req.headers['x-height'] || '1920');
    const filename = req.headers['x-filename'] || `video_${Date.now()}.mp4`;
    const thumbnailB64 = req.headers['x-thumbnail'] || '';
    const contentType = req.headers['content-type'] || 'video/mp4';

    const safeFile = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${userId}/${videoId}/${safeFile}`;

    // Upload thumbnail
    let thumbnailUrl = null;
    if (thumbnailB64) {
      const thumbPath = `${userId}/${videoId}/thumb.jpg`;
      const thumbBuf = Buffer.from(thumbnailB64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      const thumbR = await fetch(`${SU}/storage/v1/object/blue-videos/${thumbPath}`, {
        method: 'POST',
        headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
        body: thumbBuf
      });
      if (thumbR.ok) thumbnailUrl = `${SU}/storage/v1/object/public/blue-videos/${thumbPath}`;
    }

    // Coleta body (o vídeo em si)
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const videoBuffer = Buffer.concat(chunks);

    // Upload vídeo para Supabase Storage
    const upR = await fetch(`${SU}/storage/v1/object/blue-videos/${storagePath}`, {
      method: 'POST',
      headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': contentType, 'x-upsert': 'true' },
      body: videoBuffer
    });

    if (!upR.ok) {
      const err = await upR.text();
      console.error('Storage upload error:', upR.status, err);
      return res.status(500).json({ error: 'Falha no upload: ' + upR.status });
    }

    const videoUrl = `${SU}/storage/v1/object/public/blue-videos/${storagePath}`;

    // Salva metadata no banco
    const vidR = await fetch(`${SU}/rest/v1/blue_videos`, {
      method: 'POST',
      headers: { ...h, Prefer: 'return=representation' },
      body: JSON.stringify({ id: videoId, user_id: userId, title, description, video_url: videoUrl, thumbnail_url: thumbnailUrl, duration, width, height, score: 50, status: 'active', test_phase: true })
    });
    const vidData = await vidR.json();
    const video = Array.isArray(vidData) ? vidData[0] : vidData;

    return res.status(200).json({ ok: true, video });
  } catch(err) {
    console.error('blue-upload fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
