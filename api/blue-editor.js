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
    return res.status(503).json({ error: 'Não foi possível obter o link do vídeo. \n💡 Baixe pelo BaixaBlue e envie o arquivo diretamente.' });
  }

  return res.status(400).json({ error: 'Ação inválida' });
};
