// api/blue-upload.js — Salva metadata + retorna destino de upload
// Upload limits by plan: Free=5/50MB, Full=20/200MB, Master=100/500MB

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

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  try {
    const { token, title, description, duration, width, height, file_name, content_type, file_size, thumbnail_data } = req.body || {};
    if (!token) return res.status(401).json({ error: 'Login necessário para postar vídeos.' });

    // Valida token e pega userId
    const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!uR.ok) return res.status(401).json({ error: 'Token inválido — faça login novamente.' });
    const { id: userId, email } = await uR.json();

    // ── VALIDAÇÃO DE MIME TYPE ─────────────────────────────────────────────
    const allowedTypes = ['video/mp4', 'video/quicktime', 'video/webm'];
    if (content_type && !allowedTypes.includes(content_type)) {
      return res.status(400).json({ error: 'Formato não suportado. Use MP4, MOV ou WebM.' });
    }

    // ── BUSCA PLANO DO USUÁRIO ────────────────────────────────────────────
    let plan = 'free';
    try {
      const planRes = await fetch(
        `${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=plan,plan_expires_at,is_manual`,
        { headers: h }
      );
      if (planRes.ok) {
        const subs = await planRes.json();
        const sub = subs?.[0];
        if (sub?.plan && sub.plan !== 'free') {
          const valid = sub.is_manual || !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date();
          if (valid) plan = sub.plan;
        }
      }
    } catch(e) {}

    // ── LIMITES POR PLANO ─────────────────────────────────────────────────
    const LIMITS = {
      free:   { maxVideos: 5,   maxSizeMB: 50  },
      full:   { maxVideos: 20,  maxSizeMB: 200 },
      master: { maxVideos: 100, maxSizeMB: 500 },
    };
    const limits = LIMITS[plan] || LIMITS.free;

    // Conta vídeos ativos do usuário
    const countRes = await fetch(
      `${SU}/rest/v1/blue_videos?user_id=eq.${userId}&status=eq.active&select=id`,
      { headers: h }
    );
    const activeCount = countRes.ok ? (await countRes.json()).length : 0;

    if (activeCount >= limits.maxVideos) {
      const upgradeMsg = plan === 'free'
        ? `Você atingiu o limite de ${limits.maxVideos} vídeos. Faça upgrade para o plano Full e poste até 20 vídeos.`
        : plan === 'full'
        ? `Você atingiu o limite de ${limits.maxVideos} vídeos. Faça upgrade para o plano Master e poste até 100 vídeos.`
        : `Você atingiu o limite de ${limits.maxVideos} vídeos.`;
      return res.status(403).json({ error: upgradeMsg, limit: true, plan });
    }

    // Verifica tamanho do arquivo
    const fileSizeMB = file_size ? parseFloat(file_size) / (1024 * 1024) : 0;
    if (fileSizeMB > limits.maxSizeMB) {
      return res.status(400).json({ error: `Seu vídeo é muito grande. O limite para o plano ${plan.toUpperCase()} é ${limits.maxSizeMB}MB.` });
    }

    // ── MODERAÇÃO BÁSICA DE TEXTO ─────────────────────────────────────────
    const cleanTitle = (title || '').replace(/<[^>]*>/g, '').trim().slice(0, 100);
    const cleanDesc = (description || '').replace(/<[^>]*>/g, '').trim().slice(0, 500);

    const BLOCKED_WORDS = ['porn','xxx','nude','nudes','onlyfans','xvideos','pornhub','sex','hentai','gore','morte','matar','suicidio','drogas','cocaine','maconha'];
    const combined = (cleanTitle + ' ' + cleanDesc).toLowerCase();
    const hasBlocked = BLOCKED_WORDS.some(w => combined.includes(w));

    let moderationStatus = 'approved';
    if (hasBlocked) {
      moderationStatus = 'rejected';
      return res.status(400).json({ error: 'Conteúdo não permitido. Verifique o título e descrição.' });
    }

    // ── UPLOAD ─────────────────────────────────────────────────────────────
    const crypto = require('crypto');
    const videoId = crypto.randomUUID();
    const ext = (file_name || 'video.mp4').split('.').pop().replace(/[^a-z0-9]/gi, '') || 'mp4';
    const storagePath = `${userId}/${videoId}/video.${ext}`;
    const videoUrl = `${SU}/storage/v1/object/public/blue-videos/${storagePath}`;

    // Upload thumbnail
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
      } catch(e) {}
    }

    // Garante perfil
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

    // Salva no banco
    const vR = await fetch(`${SU}/rest/v1/blue_videos`, {
      method: 'POST',
      headers: { ...h, Prefer: 'return=representation' },
      body: JSON.stringify({
        id: videoId, user_id: userId,
        title: cleanTitle,
        description: cleanDesc,
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
      return res.status(500).json({ error: 'Erro ao salvar no banco.' });
    }
    const vData = await vR.json();
    const video = Array.isArray(vData) ? vData[0] : vData;

    return res.status(200).json({
      ok: true, video,
      storage_path: storagePath,
      video_url: videoUrl,
      supabase_url: SU,
      anon_key: AK,
      user_token: token
    });
  } catch(err) {
    console.error('blue-upload fatal:', err.message);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
};
