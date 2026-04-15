// api/blue-editor.js
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const SU   = process.env.SUPABASE_URL;
  const SK   = process.env.SUPABASE_SERVICE_KEY;
  const AK   = process.env.SUPABASE_ANON_KEY || SK;
  const OPENAI  = process.env.OPENAI_API_KEY;
  const ELABS   = process.env.ELEVENLABS_API_KEY;
  const SUPADATA = process.env.SUPADATA_API_KEY;
  const YTK  = [process.env.YOUTUBE_API_KEY_1, process.env.YOUTUBE_API_KEY_2].filter(Boolean);
  const GK   = [1,2,3,4,5].map(i => process.env['GEMINI_KEY_'+i]).filter(Boolean).sort(() => Math.random()-.5);

  const { action, token, videoUrl, videoId, voiceId, roteiro, lang, musicId } = req.body || {};

  // ── yt-download: baixa YouTube via yt-dlp no Railway com qualidade escolhida ──
  // Fluxo: browser POST com {youtube_url, quality} → Vercel → Railway /download-youtube
  // → yt-dlp baixa da CDN direto + muxa → Supabase Storage → public URL de volta
  // Resolve o problema de qualidade do ytstream (que só entrega itag=18 combinado).
  if (action === 'yt-download') {
    if (!token) return res.status(401).json({ error: 'Login necessário' });
    try {
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
    } catch (e) { return res.status(401).json({ error: e.message }); }

    const RAILWAY_URL = process.env.RAILWAY_FFMPEG_URL;
    if (!RAILWAY_URL) return res.status(503).json({ error: 'RAILWAY_FFMPEG_URL não configurada' });

    const youtubeUrl = req.body?.youtube_url;
    const quality = req.body?.quality || '720';
    if (!youtubeUrl) return res.status(400).json({ error: 'youtube_url obrigatório' });

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 180000); // 3 min (yt-dlp pode ser lento em vídeos longos)
      const r = await fetch(`${RAILWAY_URL.replace(/\/$/, '')}/download-youtube`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          youtube_url: youtubeUrl,
          quality,
          supabase_url: SU,
          supabase_key: SK
        }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      const d = await r.json();
      if (!r.ok || !d.url) {
        return res.status(r.status || 502).json({ error: d.error || 'yt-dlp falhou', detail: d });
      }
      return res.status(200).json({
        ok: true,
        url: d.url,
        path: d.path,
        size: d.size,
        quality: d.quality_requested,
        provider: 'yt-dlp'
      });
    } catch (e) {
      return res.status(500).json({ error: e.name === 'AbortError' ? 'yt-dlp timeout (3min)' : e.message });
    }
  }

  // ── get-upload-url: gera signed URL do Supabase Storage pra upload direto ──
  // Fluxo: browser POST aqui → recebe upload_url + public_url → PUT arquivo no
  // upload_url → usa public_url como video_url no action=edit. Sem body parsing
  // no Vercel, sem limite de 4.5MB. Browser do user tem IP residencial, extrai
  // do YouTube localmente (yt-dlp, BaixaBlue, etc) e só envia o arquivo final.
  if (action === 'upload-url' || action === 'get-upload-url') {
    if (!token) return res.status(401).json({ error: 'Login necessário' });
    try {
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
      const u = await uR.json();
      const uid = u.id;
      if (!uid) return res.status(401).json({ error: 'Sem user id' });

      const ext = (req.body?.ext || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5).toLowerCase() || 'mp4';
      const filePath = `editor/uploads/${uid}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const bucket = 'blue-videos';

      // Supabase: cria signed upload URL (válida por 15 min)
      const signR = await fetch(`${SU}/storage/v1/object/upload/sign/${bucket}/${filePath}`, {
        method: 'POST',
        headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 900 })
      });
      if (!signR.ok) {
        const et = await signR.text();
        console.error('[upload-url] sign failed:', signR.status, et.slice(0, 200));
        return res.status(500).json({ error: 'Falha ao gerar URL de upload: ' + et.slice(0, 150) });
      }
      const signD = await signR.json();
      // signD.url pode vir como path relativo ou absoluto
      const relUrl = signD.url || '';
      const uploadUrl = relUrl.startsWith('http') ? relUrl : `${SU}/storage/v1${relUrl.startsWith('/') ? relUrl : '/' + relUrl}`;
      const publicUrl = `${SU}/storage/v1/object/public/${bucket}/${filePath}`;

      return res.status(200).json({
        upload_url: uploadUrl,
        public_url: publicUrl,
        path: filePath,
        bucket,
        expires_in: 900
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Public read: list-estilos (não precisa de auth) ────────────────────────
  if (action === 'list-estilos') {
    try {
      const h = { apikey: SK, Authorization: 'Bearer ' + SK };
      const r = await fetch(`${SU}/rest/v1/editor_estilos?select=*&order=aprovacoes.desc`, { headers: h });
      if (!r.ok) return res.status(500).json({ error: 'Falha ao buscar estilos' });
      const rows = await r.json();
      return res.status(200).json({ estilos: rows });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── Public read: prepare (Claude Vision em thumbnails públicos) ────────────
  // Não expõe dados do usuário — só analisa thumbnails públicos do YouTube
  if (action === 'prepare') {
    const ANTHROPIC_PUB = process.env.ANTHROPIC_API_KEY;
    const vidPub = videoId || req.body?.videoId;
    const urlPub = videoUrl || req.body?.videoUrl;
    let vidFinalPub = vidPub;
    if (!vidFinalPub && urlPub) {
      const m = urlPub.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/);
      if (m) vidFinalPub = m[1];
    }
    if (!vidFinalPub) return res.status(400).json({ error: 'videoId ou videoUrl obrigatório' });
    if (!ANTHROPIC_PUB) return res.status(200).json({ description: '', niche: '', impactMoments: [], mood: 'curiosidade' });

    try {
      const frameUrlsPub = [
        'https://img.youtube.com/vi/' + vidFinalPub + '/maxresdefault.jpg',
        'https://img.youtube.com/vi/' + vidFinalPub + '/1.jpg',
        'https://img.youtube.com/vi/' + vidFinalPub + '/2.jpg',
        'https://img.youtube.com/vi/' + vidFinalPub + '/3.jpg',
      ];
      const contentPub = frameUrlsPub.map(u => ({ type: 'image', source: { type: 'url', url: u } }));
      contentPub.push({
        type: 'text',
        text: 'Analise estes frames de um YouTube Short. Retorne SOMENTE JSON:\n{\n' +
          '  "description": "descrição visual em 2-3 frases",\n' +
          '  "niche": "nicho em 1-2 palavras (Curiosidades, Ciência, Humor, Esporte, Tecnologia, etc)",\n' +
          '  "impactMoments": ["descrição breve do momento 1 com maior impacto visual", "momento 2", "momento 3"],\n' +
          '  "mood": "uma das opções: suspense | curiosidade | energetico | misterioso | informativo"\n' +
          '}'
      });

      const ctrlPub = new AbortController();
      const timerPub = setTimeout(() => ctrlPub.abort(), 25000);
      const rPub = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_PUB, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 700, messages: [{ role: 'user', content: contentPub }] }),
        signal: ctrlPub.signal
      });
      clearTimeout(timerPub);
      if (!rPub.ok) return res.status(200).json({ description: '', niche: '', impactMoments: [], mood: 'curiosidade' });
      const dPub = await rPub.json();
      const txtPub = dPub.content?.[0]?.text || '';
      const siPub = txtPub.indexOf('{'), eiPub = txtPub.lastIndexOf('}');
      if (siPub < 0) return res.status(200).json({ description: txtPub.slice(0, 500), niche: '', impactMoments: [], mood: 'curiosidade' });
      try {
        const parsedPub = JSON.parse(txtPub.slice(siPub, eiPub + 1));
        return res.status(200).json({
          description: parsedPub.description || '',
          niche: parsedPub.niche || '',
          impactMoments: Array.isArray(parsedPub.impactMoments) ? parsedPub.impactMoments : [],
          mood: parsedPub.mood || 'curiosidade'
        });
      } catch (e) {
        return res.status(200).json({ description: txtPub.slice(0, 500), niche: '', impactMoments: [], mood: 'curiosidade' });
      }
    } catch (e) {
      return res.status(200).json({ description: '', niche: '', impactMoments: [], mood: 'curiosidade', error: e.message });
    }
  }

  // ── Validate token ──────────────────────────────────────────────────────────
  let userId = null;
  if (token) {
    try {
      const r = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (r.ok) userId = (await r.json()).id;
    } catch(e) {}
  }
  if (!userId) return res.status(401).json({ error: 'Login necessário' });

  // ── generate: transcript + 2 roteiros ──────────────────────────────────────
  if (action === 'generate') {
    if (!videoUrl) return res.status(400).json({ error: 'videoUrl obrigatório' });
    const match = videoUrl.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/);
    if (!match) return res.status(400).json({ error: 'Link inválido. Use: youtube.com/shorts/...' });
    const vid = match[1];
    const safeLang = lang || 'Português (Brasil)';
    let transcript = '', ytTitle = '', ytDesc = '';

    // Transcrição via Supadata
    if (SUPADATA) {
      try {
        const r = await fetch('https://api.supadata.ai/v1/transcript?url=https://www.youtube.com/watch?v=' + vid, { headers: { 'x-api-key': SUPADATA } });
        if (r.ok) { const d = await r.json(); transcript = (Array.isArray(d.content) ? d.content.map(s=>s.text||'').join(' ') : String(d.content||'')).trim().slice(0,1000); }
      } catch(e) {}
    }
    // Fallback timedtext
    if (!transcript) {
      try {
        const h = await fetch('https://www.youtube.com/watch?v='+vid, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (h.ok) { const html = await h.text(); const cm = html.match(/"captionTracks":\s*(\[.*?\])/); if (cm) { const t = JSON.parse(cm[1])[0]; if (t?.baseUrl) { const cr = await fetch(t.baseUrl+'&fmt=json3'); if (cr.ok) { const cd = await cr.json(); transcript = (cd.events||[]).filter(e=>e.segs).map(e=>e.segs.map(s=>s.utf8||'').join('')).join(' ').replace(/\s+/g,' ').trim().slice(0,1000); } } } }
      } catch(e) {}
    }
    // YouTube metadata
    for (const k of YTK) {
      try { const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${vid}&key=${k}`); if (r.ok) { const d = await r.json(); ytTitle = d.items?.[0]?.snippet?.title||''; ytDesc = (d.items?.[0]?.snippet?.description||'').slice(0,200); break; } } catch(e) {}
    }
    if (!transcript && !ytTitle) return res.status(503).json({ error: 'Não consegui obter o conteúdo. O Short é público?' });

    const ctx = [transcript&&`CONTEÚDO:\n${transcript}`, ytTitle&&`TÍTULO: ${ytTitle}`, ytDesc&&`DESCRIÇÃO: ${ytDesc}`].filter(Boolean).join('\n\n');
    const prompt = `Especialista em virais para YouTube Shorts. Baseado neste conteúdo:\n${ctx}\n\nCrie 2 roteiros em ${safeLang}, máx 60 palavras cada, NÃO copie o original:\n1. CASUAL: conversacional, como um amigo\n2. APELATIVO: gancho forte, drama, engajamento\n\nResponda APENAS JSON:\n{"casual":"...","apelativo":"...","title_casual":"...","title_apelativo":"..."}`;

    let roteiros = null;
    if (OPENAI) { try { const r = await fetch('https://api.openai.com/v1/chat/completions', { method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+OPENAI}, body:JSON.stringify({model:'gpt-4o-mini',max_tokens:500,temperature:0.85,messages:[{role:'user',content:prompt}]}) }); const d = await r.json(); if (r.ok) { const t = d.choices?.[0]?.message?.content?.replace(/```json|```/g,'').trim(); const si=t?.indexOf('{'); if (si>=0) roteiros=JSON.parse(t.slice(si,t.lastIndexOf('}')+1)); } } catch(e) {} }
    for (let i=0; i<GK.length && !roteiros; i++) { try { const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GK[i]}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.85,maxOutputTokens:500}}) }); const d = await r.json(); if (d.error?.code===429) continue; const t = d.candidates?.[0]?.content?.parts?.[0]?.text; if (t) { const si=t.indexOf('{'); if(si>=0) roteiros=JSON.parse(t.slice(si,t.lastIndexOf('}')+1)); } } catch(e) {} }
    if (!roteiros) return res.status(503).json({ error: 'Falha ao gerar roteiros. Tente novamente.' });
    return res.status(200).json({ roteiros, videoId: vid });
  }

  // ── tts: gera áudio narração ────────────────────────────────────────────────
  if (action === 'tts') {
    if (!roteiro||!voiceId) return res.status(400).json({ error: 'roteiro e voiceId obrigatórios' });
    if (!ELABS) return res.status(500).json({ error: 'ElevenLabs não configurado' });
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, { method:'POST', headers:{'xi-api-key':ELABS,'Content-Type':'application/json',Accept:'audio/mpeg'}, body:JSON.stringify({text:roteiro,model_id:'eleven_multilingual_v2',voice_settings:{stability:0.45,similarity_boost:0.78}}) });
      if (!r.ok) { const e=await r.text(); return res.status(r.status).json({ error:'ElevenLabs: '+e.slice(0,100) }); }
      const buf = await r.arrayBuffer();
      return res.status(200).json({ audio_b64: Buffer.from(buf).toString('base64') });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── voice-preview: URL de preview de voz ElevenLabs ────────────────────────
  if (action === 'voice-preview') {
    if (!ELABS) return res.status(500).json({ error: 'ElevenLabs não configurado' });
    const vid2 = voiceId || req.body?.voiceId;
    if (!vid2) return res.status(400).json({ error: 'voiceId obrigatório' });
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/voices/${vid2}`, { headers: { 'xi-api-key': ELABS } });
      if (!r.ok) return res.status(404).json({ error: 'Voz não encontrada' });
      const d = await r.json();
      if (!d.preview_url) return res.status(404).json({ error: 'Preview não disponível' });
      return res.status(200).json({ url: d.preview_url, name: d.name });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── get-video-url: obtém URL direta do Short via YouTube Innertube ──────────
  if (action === 'get-video-url') {
    const vid3 = videoId || req.body?.videoId;
    if (!vid3) return res.status(400).json({ error: 'videoId obrigatório' });

    // Tenta múltiplos clientes do YouTube Innertube
    const CLIENTS = [
      { clientName:'ANDROID', clientVersion:'18.11.34', androidSdkVersion:30, userAgent:'com.google.android.youtube/18.11.34 (Linux; U; Android 11) gzip' },
      { clientName:'TV_EMBEDDED', clientVersion:'2.0', userAgent:'Mozilla/5.0 (SMART-TV; Linux) AppleWebKit/538.1' },
      { clientName:'WEB', clientVersion:'2.20231121.08.00', userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    ];

    for (const client of CLIENTS) {
      try {
        const r = await fetch('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': client.userAgent, 'X-YouTube-Client-Name': client.clientName, 'X-YouTube-Client-Version': client.clientVersion },
          body: JSON.stringify({ videoId: vid3, context: { client: { clientName: client.clientName, clientVersion: client.clientVersion, androidSdkVersion: client.androidSdkVersion } } })
        });
        if (!r.ok) continue;
        const d = await r.json();
        const allFormats = [...(d.streamingData?.formats||[]), ...(d.streamingData?.adaptiveFormats||[])];
        // Prefere mp4 com vídeo
        const fmt = allFormats.find(f => f.mimeType?.includes('video/mp4') && f.url && !f.mimeType.includes('audio-only'))
                 || allFormats.find(f => f.mimeType?.includes('video/mp4') && f.url);
        if (fmt?.url) return res.status(200).json({ url: fmt.url, quality: fmt.qualityLabel || fmt.quality });
      } catch(e) {}
    }
    // Fallback: Invidious (instâncias públicas open-source)
    const INVIDIOUS = [
      'https://invidious.privacyredirect.com',
      'https://inv.tux.pizza',
      'https://invidious.nerdvpn.de',
      'https://yt.dragonpub.com',
    ];
    for (const inst of INVIDIOUS) {
      try {
        const r = await fetch(`${inst}/api/v1/videos/${vid3}?fields=formatStreams,adaptiveFormats`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) continue;
        const d = await r.json();
        const fmts = [...(d.formatStreams||[]), ...(d.adaptiveFormats||[])];
        const mp4 = fmts.find(f => (f.container||f.type||'').includes('mp4') && f.url);
        if (mp4?.url) return res.status(200).json({ url: mp4.url, quality: mp4.qualityLabel||'?' });
      } catch(e) {}
    }

    // Fallback 3: delega pro /api/auth?action=download que tem a cascata COMPLETA
    // do YouTube (Cobalt self-hosted + ytstream RapidAPI + youtube-media-downloader
    // RapidAPI). Qualquer fix futuro no auth.js beneficia o BlueEditor automaticamente.
    try {
      const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (host) {
        const shortUrl = `https://www.youtube.com/shorts/${vid3}`;
        const authUrl = `${proto}://${host}/api/auth?action=download&url=${encodeURIComponent(shortUrl)}`;
        console.log('[get-video-url] Delegando pro /api/auth?action=download');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25000);
        const authR = await fetch(authUrl, { signal: ctrl.signal });
        clearTimeout(timer);
        if (authR.ok) {
          const authD = await authR.json();
          if (authD.url) {
            return res.status(200).json({
              url: authD.url,
              quality: authD.quality || '?',
              provider: 'auth-download-cascade'
            });
          }
          console.log('[get-video-url] auth-download sem url:', JSON.stringify(authD).slice(0, 200));
        } else {
          const et = await authR.text().catch(() => '');
          console.log('[get-video-url] auth-download HTTP', authR.status, et.slice(0, 200));
        }
      }
    } catch (e) {
      console.log('[get-video-url] auth-download falhou:', e.name === 'AbortError' ? 'timeout' : e.message);
    }

    return res.status(503).json({
      error: 'Não foi possível obter o link do vídeo. \n💡 Baixe pelo BaixaBlue e envie o arquivo diretamente, ou verifique COBALT_API_URL/RAPIDAPI_KEY no Vercel.'
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NOVO PIPELINE SERVER-SIDE (Railway FFmpeg)
  // Actions: list-estilos | prepare | generate-narration | get-music | edit | status | feedback
  // ═══════════════════════════════════════════════════════════════════════════

  const supaH = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
  const RAILWAY_FFMPEG_URL = process.env.RAILWAY_FFMPEG_URL;
  const MUBERT = process.env.MUBERT_API_KEY;

  // ── list-estilos: retorna estilos disponíveis ordenados por aprovações ────
  if (action === 'list-estilos') {
    try {
      const r = await fetch(`${SU}/rest/v1/editor_estilos?select=*&order=aprovacoes.desc`, { headers: supaH });
      if (!r.ok) return res.status(500).json({ error: 'Falha ao buscar estilos' });
      const rows = await r.json();
      return res.status(200).json({ estilos: rows });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── prepare: Claude Vision analisa frames do Short ────────────────────────
  if (action === 'prepare') {
    const vid = videoId || req.body?.videoId;
    const url = videoUrl || req.body?.videoUrl;
    let vidFinal = vid;
    if (!vidFinal && url) {
      const m = url.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/);
      if (m) vidFinal = m[1];
    }
    if (!vidFinal) return res.status(400).json({ error: 'videoId ou videoUrl obrigatório' });
    if (!ANTHROPIC) return res.status(200).json({ description: '', niche: '', impactMoments: [], mood: 'curiosidade' });

    try {
      const frameUrls = [
        'https://img.youtube.com/vi/' + vidFinal + '/maxresdefault.jpg',
        'https://img.youtube.com/vi/' + vidFinal + '/1.jpg',
        'https://img.youtube.com/vi/' + vidFinal + '/2.jpg',
        'https://img.youtube.com/vi/' + vidFinal + '/3.jpg',
      ];
      const content = frameUrls.map(u => ({ type: 'image', source: { type: 'url', url: u } }));
      content.push({
        type: 'text',
        text: 'Analise estes frames de um YouTube Short. Retorne SOMENTE JSON:\n{\n' +
          '  "description": "descrição visual em 2-3 frases",\n' +
          '  "niche": "nicho em 1-2 palavras (Curiosidades, Ciência, Humor, Esporte, Tecnologia, etc)",\n' +
          '  "impactMoments": ["descrição breve do momento 1 com maior impacto visual", "momento 2", "momento 3"],\n' +
          '  "mood": "uma das opções: suspense | curiosidade | energetico | misterioso | informativo"\n' +
          '}'
      });

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 700, messages: [{ role: 'user', content }] }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!r.ok) return res.status(200).json({ description: '', niche: '', impactMoments: [], mood: 'curiosidade' });
      const d = await r.json();
      const txt = d.content?.[0]?.text || '';
      const si = txt.indexOf('{'), ei = txt.lastIndexOf('}');
      if (si < 0) return res.status(200).json({ description: txt.slice(0, 500), niche: '', impactMoments: [], mood: 'curiosidade' });
      try {
        const parsed = JSON.parse(txt.slice(si, ei + 1));
        return res.status(200).json({
          description: parsed.description || '',
          niche: parsed.niche || '',
          impactMoments: Array.isArray(parsed.impactMoments) ? parsed.impactMoments : [],
          mood: parsed.mood || 'curiosidade'
        });
      } catch (e) {
        return res.status(200).json({ description: txt.slice(0, 500), niche: '', impactMoments: [], mood: 'curiosidade' });
      }
    } catch (e) {
      return res.status(200).json({ description: '', niche: '', impactMoments: [], mood: 'curiosidade', error: e.message });
    }
  }

  // ── generate-narration: ElevenLabs MP3 → upload → Whisper word timestamps ─
  if (action === 'generate-narration') {
    const rot = roteiro || req.body?.roteiro;
    const vid4 = voiceId || req.body?.voiceId;
    if (!rot || !vid4) return res.status(400).json({ error: 'roteiro e voiceId obrigatórios' });
    if (!ELABS) return res.status(500).json({ error: 'ElevenLabs não configurado' });
    if (!OPENAI) return res.status(500).json({ error: 'OPENAI_API_KEY não configurada (precisa para Whisper)' });

    try {
      // 1) Gera MP3 via ElevenLabs
      const ttsR = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid4}`, {
        method: 'POST',
        headers: { 'xi-api-key': ELABS, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({
          text: rot,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.45, similarity_boost: 0.78 }
        })
      });
      if (!ttsR.ok) {
        const et = await ttsR.text();
        return res.status(ttsR.status).json({ error: 'ElevenLabs: ' + et.slice(0, 150) });
      }
      const audioBuf = Buffer.from(await ttsR.arrayBuffer());

      // 2) Upload para Supabase Storage
      const jobIdShort = Math.random().toString(36).slice(2, 10);
      const narrPath = `editor/narrations/${userId}/${Date.now()}_${jobIdShort}.mp3`;
      const upR = await fetch(`${SU}/storage/v1/object/blue-videos/${narrPath}`, {
        method: 'POST',
        headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'audio/mpeg', 'x-upsert': 'true' },
        body: audioBuf
      });
      if (!upR.ok) {
        const et = await upR.text();
        return res.status(500).json({ error: 'Upload narração falhou: ' + et.slice(0, 150) });
      }
      const audioUrl = `${SU}/storage/v1/object/public/blue-videos/${narrPath}`;

      // 3) Whisper com word-level timestamps (multipart form)
      const boundary = '----bt' + Math.random().toString(36).slice(2);
      const parts = [];
      const push = (name, value, filename, contentType) => {
        let head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
        if (filename) head += `; filename="${filename}"`;
        head += '\r\n';
        if (contentType) head += `Content-Type: ${contentType}\r\n`;
        head += '\r\n';
        parts.push(Buffer.from(head, 'utf8'));
        parts.push(typeof value === 'string' ? Buffer.from(value, 'utf8') : value);
        parts.push(Buffer.from('\r\n', 'utf8'));
      };
      push('file', audioBuf, 'narration.mp3', 'audio/mpeg');
      push('model', 'whisper-1');
      push('response_format', 'verbose_json');
      push('timestamp_granularities[]', 'word');
      parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
      const body = Buffer.concat(parts);

      const wR = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + OPENAI,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length)
        },
        body
      });
      if (!wR.ok) {
        const et = await wR.text();
        console.error('[whisper]', et.slice(0, 300));
        // Fallback: sem palavras (o pipeline ainda pode renderizar sem karaoke)
        return res.status(200).json({ audio_url: audioUrl, words: [], warning: 'whisper_failed' });
      }
      const wd = await wR.json();
      const words = (wd.words || []).map(w => ({
        word: w.word || w.text || '',
        start: typeof w.start === 'number' ? w.start : 0,
        end: typeof w.end === 'number' ? w.end : 0
      }));

      return res.status(200).json({ audio_url: audioUrl, words, duration: wd.duration || null });
    } catch (e) {
      console.error('[generate-narration]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── get-music: tenta Mubert, senão retorna null pra frontend subir custom ─
  if (action === 'get-music') {
    const mood = (req.body?.mood || 'curiosidade').toLowerCase();
    const durSec = Math.min(180, Math.max(30, parseInt(req.body?.duration || 60, 10)));

    if (MUBERT) {
      try {
        // Mubert TTM API — retorna URL de track gerada
        const tagMap = {
          suspense: 'suspense,cinematic,dark',
          curiosidade: 'ambient,curious,discovery',
          energetico: 'upbeat,energetic,action',
          misterioso: 'mystery,dark,ambient',
          informativo: 'corporate,clean,focus'
        };
        const tags = tagMap[mood] || 'ambient,background';
        const r = await fetch('https://api-b2b.mubert.com/v2/TTMRecordTrack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'RecordTrackTTM',
            params: { pat: MUBERT, duration: durSec, format: 'mp3', bitrate: 128, intensity: 'low', mode: 'track', tags: tags.split(',') }
          })
        });
        if (r.ok) {
          const d = await r.json();
          const trackUrl = d?.data?.tasks?.[0]?.download_link || d?.data?.download_link || d?.download_link;
          if (trackUrl) return res.status(200).json({ musica_url: trackUrl, mood, provider: 'mubert' });
        }
      } catch (e) { console.log('[mubert]', e.message); }
    }

    // Fallback: sem música (frontend pode oferecer upload manual ou seguir sem)
    return res.status(200).json({ musica_url: null, mood, provider: null, message: 'Música automática indisponível — o vídeo será renderizado sem background.' });
  }

  // ── edit: envia job pro Railway + persiste em editor_jobs ─────────────────
  if (action === 'edit') {
    const {
      video_url, audio_url, words, estilo_id, musica_url
    } = req.body || {};
    if (!video_url || !audio_url || !Array.isArray(words) || !estilo_id) {
      return res.status(400).json({ error: 'Faltam campos: video_url, audio_url, words[], estilo_id' });
    }
    if (!RAILWAY_FFMPEG_URL) {
      return res.status(503).json({ error: 'RAILWAY_FFMPEG_URL não configurada. Deploy o serviço railway-ffmpeg/ primeiro.' });
    }

    // Verifica plano Master (BlueEditor é exclusivo Master)
    try {
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (!uR.ok) return res.status(401).json({ error: 'Sessão inválida' });
      const u = await uR.json();
      if (u.email) {
        const sR = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(u.email)}&select=plan,plan_expires_at,is_manual`, { headers: supaH });
        if (sR.ok) {
          const subs = await sR.json();
          const sub = subs?.[0];
          const planOk = sub?.plan === 'master' && (!sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date() || sub.is_manual);
          if (!planOk) return res.status(403).json({ error: 'BlueEditor é exclusivo Master.' });
        }
      }
    } catch (e) {}

    // Limite mensal configurável via env var EDITOR_MONTHLY_LIMIT (default 100).
    // Conta apenas jobs concluídos com sucesso (status=done) — falhas em teste/debug
    // não penalizam o usuário.
    try {
      const MONTHLY_LIMIT = parseInt(process.env.EDITOR_MONTHLY_LIMIT || '100', 10);
      const startMonth = new Date(); startMonth.setDate(1); startMonth.setHours(0, 0, 0, 0);
      const cR = await fetch(
        `${SU}/rest/v1/editor_jobs?user_id=eq.${userId}&status=eq.done&created_at=gte.${startMonth.toISOString()}&select=id`,
        { headers: { ...supaH, Prefer: 'count=exact' } }
      );
      const cd = cR.ok ? await cR.json() : [];
      if ((cd?.length || 0) >= MONTHLY_LIMIT) {
        return res.status(429).json({ error: `Limite de ${MONTHLY_LIMIT} edições concluídas por mês atingido.` });
      }
    } catch (e) {}

    // Busca configuração do estilo
    let estiloConfig = null;
    try {
      const eR = await fetch(`${SU}/rest/v1/editor_estilos?id=eq.${estilo_id}&select=configuracoes`, { headers: supaH });
      if (eR.ok) { const rows = await eR.json(); estiloConfig = rows?.[0]?.configuracoes || null; }
    } catch (e) {}
    if (!estiloConfig) return res.status(400).json({ error: 'Estilo inválido' });

    // Envia job pro Railway
    try {
      const jobR = await fetch(`${RAILWAY_FFMPEG_URL.replace(/\/$/, '')}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_url, audio_url, words, musica_url,
          estilo: estiloConfig,
          supabase_url: SU,
          supabase_key: SK
        })
      });
      if (!jobR.ok) {
        const et = await jobR.text();
        return res.status(502).json({ error: 'Railway: ' + et.slice(0, 200) });
      }
      const jd = await jobR.json();
      const railwayJobId = jd.job_id;

      // Persiste no editor_jobs
      const { data: inserted } = await (async () => {
        const r = await fetch(`${SU}/rest/v1/editor_jobs`, {
          method: 'POST',
          headers: { ...supaH, Prefer: 'return=representation' },
          body: JSON.stringify({
            user_id: userId,
            railway_job_id: railwayJobId,
            status: 'queued',
            progresso: 0,
            video_url,
            audio_url,
            estilo_id,
            musica_url
          })
        });
        const rows = r.ok ? await r.json() : [];
        return { data: rows[0] };
      })();

      return res.status(200).json({ ok: true, job_id: inserted?.id, railway_job_id: railwayJobId });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── status: consulta Railway + atualiza editor_jobs ───────────────────────
  if (action === 'status') {
    const jobId = req.body?.job_id;
    if (!jobId) return res.status(400).json({ error: 'job_id obrigatório' });
    if (!RAILWAY_FFMPEG_URL) return res.status(503).json({ error: 'RAILWAY_FFMPEG_URL não configurada' });

    try {
      const r = await fetch(`${SU}/rest/v1/editor_jobs?id=eq.${jobId}&user_id=eq.${userId}&select=*`, { headers: supaH });
      const rows = r.ok ? await r.json() : [];
      const job = rows?.[0];
      if (!job) return res.status(404).json({ error: 'Job não encontrado' });

      // Se já concluído, devolve direto
      if (job.status === 'done' && job.output_url) {
        return res.status(200).json({ status: 'done', progresso: 100, output_url: job.output_url });
      }

      // Pooling no Railway
      const sR = await fetch(`${RAILWAY_FFMPEG_URL.replace(/\/$/, '')}/status/${job.railway_job_id}`);
      if (!sR.ok) {
        return res.status(200).json({ status: job.status, progresso: job.progresso || 0 });
      }
      const sd = await sR.json();

      // Atualiza editor_jobs
      const patch = {
        status: sd.status,
        progresso: sd.progress || 0,
      };
      if (sd.status === 'done' && sd.output_url) {
        patch.output_url = sd.output_url;
        patch.concluido_em = new Date().toISOString();
      }
      if (sd.status === 'error') {
        patch.erro = sd.error || 'erro desconhecido';
      }
      await fetch(`${SU}/rest/v1/editor_jobs?id=eq.${jobId}`, {
        method: 'PATCH',
        headers: { ...supaH, Prefer: 'return=minimal' },
        body: JSON.stringify(patch)
      }).catch(() => {});

      return res.status(200).json({
        status: sd.status,
        progresso: sd.progress || 0,
        output_url: sd.output_url || null,
        erro: sd.error || null
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── feedback: aprovado ou ajuste ──────────────────────────────────────────
  if (action === 'feedback') {
    const jobId = req.body?.job_id;
    const aprovado = !!req.body?.aprovado;
    const comentario = (req.body?.comentario || '').slice(0, 500);
    if (!jobId) return res.status(400).json({ error: 'job_id obrigatório' });

    try {
      // Patch do job
      await fetch(`${SU}/rest/v1/editor_jobs?id=eq.${jobId}&user_id=eq.${userId}`, {
        method: 'PATCH',
        headers: { ...supaH, Prefer: 'return=minimal' },
        body: JSON.stringify({ aprovado, feedback_comentario: comentario || null })
      });

      // Se aprovado, incrementa aprovações do estilo
      if (aprovado) {
        const jR = await fetch(`${SU}/rest/v1/editor_jobs?id=eq.${jobId}&select=estilo_id`, { headers: supaH });
        const jd = jR.ok ? await jR.json() : [];
        const estiloId = jd?.[0]?.estilo_id;
        if (estiloId) {
          const eR = await fetch(`${SU}/rest/v1/editor_estilos?id=eq.${estiloId}&select=aprovacoes`, { headers: supaH });
          const ed = eR.ok ? await eR.json() : [];
          const current = ed?.[0]?.aprovacoes || 0;
          await fetch(`${SU}/rest/v1/editor_estilos?id=eq.${estiloId}`, {
            method: 'PATCH',
            headers: { ...supaH, Prefer: 'return=minimal' },
            body: JSON.stringify({ aprovacoes: current + 1 })
          });
        }
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Ação inválida' });
};
