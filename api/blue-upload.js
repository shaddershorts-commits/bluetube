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

    // Rate limit: 10 uploads/hora por user
    try {
      const rlJanela = new Date(Date.now() - 3600000).toISOString();
      const rlR = await fetch(`${SU}/rest/v1/blue_rate_limits?identificador=eq.${userId}&endpoint=eq.upload&select=requests,janela_inicio`, { headers: h });
      const rlRows = rlR.ok ? await rlR.json() : [];
      const rl = rlRows[0];
      if (rl && new Date(rl.janela_inicio) >= new Date(rlJanela) && rl.requests >= 10) {
        return res.status(429).json({ error: 'Você atingiu o limite de uploads (10/hora). Tente novamente mais tarde.' });
      }
    } catch(e) {}

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

    // ── EXTRAÇÃO DE HASHTAGS (assíncrona) ────────────────────────────────
    const hashtagMatches = (cleanTitle + ' ' + cleanDesc).match(/#([a-zA-Z0-9\u00C0-\u024Fà-ÿ_]+)/g);
    if (hashtagMatches && hashtagMatches.length > 0) {
      (async () => {
        try {
          const tags = [...new Set(hashtagMatches.map(t => t.slice(1).toLowerCase()))].slice(0, 10);
          for (const tag of tags) {
            // Upsert hashtag
            await fetch(`${SU}/rest/v1/blue_hashtags`, {
              method: 'POST', headers: { ...h, 'Prefer': 'resolution=ignore,return=representation' },
              body: JSON.stringify({ nome: tag, usos: 1 })
            });
            // Get hashtag id
            const hR = await fetch(`${SU}/rest/v1/blue_hashtags?nome=eq.${encodeURIComponent(tag)}&select=id,usos`, { headers: h });
            const hArr = hR.ok ? await hR.json() : [];
            if (hArr[0]) {
              // Increment usage
              await fetch(`${SU}/rest/v1/blue_hashtags?id=eq.${hArr[0].id}`, {
                method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
                body: JSON.stringify({ usos: (hArr[0].usos || 0) + 1 })
              });
              // Link to video
              await fetch(`${SU}/rest/v1/blue_video_hashtags`, {
                method: 'POST', headers: { ...h, 'Prefer': 'resolution=ignore,return=minimal' },
                body: JSON.stringify({ video_id: videoId, hashtag_id: hArr[0].id })
              });
            }
          }
        } catch(e) { console.error('Hashtag extraction error:', e.message); }
      })();
    }

    // ── MODERAÇÃO COM IA (assíncrona — não bloqueia upload) ──────────────
    if (thumbnail_data && process.env.ANTHROPIC_API_KEY) {
      (async () => {
        try {
          const imgB64 = thumbnail_data.replace(/^data:image\/\w+;base64,/, '');
          const modR = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 200,
              messages: [{ role: 'user', content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgB64 } },
                { type: 'text', text: 'Analise esta imagem de um frame de vídeo para uma rede social. Verifique se contém: nudez/conteúdo sexual, violência gráfica, conteúdo de ódio, spam. Retorne APENAS JSON: {"aprovado":true/false,"motivo":"texto se reprovado","confianca":0.0-1.0}' }
              ]}]
            })
          });
          if (!modR.ok) return;
          const modData = await modR.json();
          const txt = modData.content?.[0]?.text || '';
          const jsonMatch = txt.match(/\{[\s\S]*\}/);
          if (!jsonMatch) return;
          const resultado = JSON.parse(jsonMatch[0]);

          // Salva resultado de moderação
          await fetch(`${SU}/rest/v1/blue_moderacao`, {
            method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
            body: JSON.stringify({
              video_id: videoId,
              status: resultado.aprovado ? 'aprovado' : (resultado.confianca > 0.8 ? 'reprovado' : 'revisao'),
              motivo: resultado.motivo || null,
              confianca: resultado.confianca || 0
            })
          });

          // Se reprovado com alta confiança, marcar vídeo como under_review
          if (!resultado.aprovado && resultado.confianca > 0.8) {
            await fetch(`${SU}/rest/v1/blue_videos?id=eq.${videoId}`, {
              method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
              body: JSON.stringify({ status: 'under_review' })
            });
            console.log(`🛡️ AI moderation blocked: ${videoId} — ${resultado.motivo}`);
          } else if (!resultado.aprovado) {
            console.log(`🟡 AI moderation flagged for review: ${videoId} — ${resultado.motivo} (${resultado.confianca})`);
          }
        } catch(e) { console.error('AI moderation error:', e.message); }
      })();
    }

    // ── RATE LIMIT: 10 uploads/hora ───────────────────────────────────────
    try {
      const janela = new Date(Date.now() - 3600000).toISOString();
      fetch(`${SU}/rest/v1/blue_rate_limits`, { method: 'POST', headers: { ...h, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ identificador: userId, endpoint: 'upload', requests: 1, janela_inicio: new Date().toISOString() }) }).catch(() => {});
    } catch(e) {}

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
