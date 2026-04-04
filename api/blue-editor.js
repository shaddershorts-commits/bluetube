// api/blue-editor.js — BlueEditor: transcrição + roteiro + TTS para o wizard
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const OPENAI = process.env.OPENAI_API_KEY;
  const SUPADATA = process.env.SUPADATA_API_KEY;
  const GK = [
    process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3,
    process.env.GEMINI_KEY_4, process.env.GEMINI_KEY_5
  ].filter(Boolean).sort(() => Math.random() - 0.5);
  const YTK = [process.env.YOUTUBE_API_KEY_1, process.env.YOUTUBE_API_KEY_2].filter(Boolean);

  const { action, token, videoUrl, lang, voiceId, roteiro } = req.body || {};

  // Validate token
  let userId = null;
  if (token) {
    try {
      const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (uR.ok) userId = (await uR.json()).id;
    } catch(e) {}
  }
  if (!userId) return res.status(401).json({ error: 'Login necessário' });

  // ── ACTION: generate (transcrição + 2 roteiros) ───────────────────────────
  if (action === 'generate') {
    if (!videoUrl) return res.status(400).json({ error: 'videoUrl obrigatório' });
    const match = videoUrl.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/);
    if (!match) return res.status(400).json({ error: 'Link inválido' });
    const videoId = match[1];
    const safeLang = lang || 'Português (Brasil)';

    // 1. Transcrição via Supadata
    let transcript = '';
    if (SUPADATA) {
      try {
        const r = await fetch('https://api.supadata.ai/v1/transcript?url=https://www.youtube.com/watch?v=' + videoId, {
          headers: { 'x-api-key': SUPADATA }
        });
        if (r.ok) {
          const d = await r.json();
          const raw = Array.isArray(d.content) ? d.content.map(s => s.text || '').join(' ') : String(d.content || '');
          transcript = raw.trim().slice(0, 1000);
        }
      } catch(e) {}
    }

    // 2. YouTube timedtext fallback
    if (!transcript) {
      try {
        const pageR = await fetch('https://www.youtube.com/watch?v=' + videoId, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (pageR.ok) {
          const html = await pageR.text();
          const cm = html.match(/"captionTracks":\s*(\[.*?\])/);
          if (cm) {
            const track = JSON.parse(cm[1])[0];
            if (track?.baseUrl) {
              const cr = await fetch(track.baseUrl + '&fmt=json3');
              if (cr.ok) {
                const cd = await cr.json();
                transcript = (cd.events || []).filter(e => e.segs).map(e => e.segs.map(s => s.utf8 || '').join('')).join(' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
              }
            }
          }
        }
      } catch(e) {}
    }

    // 3. YouTube metadata
    let ytTitle = '', ytDesc = '';
    for (const key of YTK) {
      try {
        const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${key}`);
        if (r.ok) { const d = await r.json(); ytTitle = d.items?.[0]?.snippet?.title || ''; ytDesc = (d.items?.[0]?.snippet?.description || '').slice(0, 200); break; }
      } catch(e) {}
    }

    if (!transcript && !ytTitle) return res.status(503).json({ error: 'Não foi possível obter o conteúdo do vídeo. Tente um Short público.' });

    const context = [transcript && `CONTEÚDO DO VÍDEO:\n${transcript}`, ytTitle && `TÍTULO: ${ytTitle}`, ytDesc && `DESCRIÇÃO: ${ytDesc}`].filter(Boolean).join('\n\n');

    // 4. Gera 2 roteiros
    const prompt = `Você é um especialista em roteiros virais para YouTube Shorts.
Baseado neste conteúdo:
${context}

Crie 2 roteiros em ${safeLang} para um novo Short baseado nesse conteúdo:
1. CASUAL: linguagem natural, conversacional, como um amigo contando
2. APELATIVO: gancho forte, drama, máximo engajamento

Regras: máximo 60 palavras cada, NÃO copie o texto original, crie algo novo e viral.

Responda APENAS em JSON válido:
{"casual":"roteiro casual aqui","apelativo":"roteiro apelativo aqui","title_casual":"título casual","title_apelativo":"título apelativo"}`;

    let roteiros = null;
    if (OPENAI) {
      try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI },
          body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 500, temperature: 0.85, messages: [{ role: 'user', content: prompt }] })
        });
        const d = await r.json();
        if (r.ok && d.choices?.[0]) {
          const text = d.choices[0].message.content.replace(/```json|```/g, '').trim();
          const si = text.indexOf('{'), ei = text.lastIndexOf('}');
          if (si >= 0 && ei >= 0) roteiros = JSON.parse(text.slice(si, ei + 1));
        }
      } catch(e) {}
    }

    for (let i = 0; i < GK.length && !roteiros; i++) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GK[i]}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.85, maxOutputTokens: 500 } })
        });
        const d = await r.json();
        if (d.error?.code === 429) continue;
        const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) { const si = text.indexOf('{'), ei = text.lastIndexOf('}'); if (si >= 0) roteiros = JSON.parse(text.slice(si, ei + 1)); }
      } catch(e) {}
    }

    if (!roteiros) return res.status(503).json({ error: 'Falha ao gerar roteiros. Tente novamente.' });
    return res.status(200).json({ roteiros, videoId, transcript: transcript.slice(0, 100) });
  }

  // ── ACTION: tts (gera áudio do roteiro escolhido) ─────────────────────────
  if (action === 'tts') {
    if (!roteiro || !voiceId) return res.status(400).json({ error: 'roteiro e voiceId obrigatórios' });
    const EL = process.env.ELEVENLABS_API_KEY;
    if (!EL) return res.status(500).json({ error: 'ElevenLabs não configurado' });
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: { 'xi-api-key': EL, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: roteiro, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.78 } })
      });
      if (!r.ok) { const err = await r.text(); return res.status(r.status).json({ error: 'ElevenLabs: ' + err.slice(0, 100) }); }
      const buf = await r.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');

      // Conta narração
      try {
        const now = new Date();
        const month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
        const narKey = `bv_narr_${userId}_${month}`;
        const cR = await fetch(`${SU}/rest/v1/bv_narration_counts?user_id=eq.${userId}&month=eq.${month}&select=count`, { headers: { apikey: SK, Authorization: 'Bearer ' + SK } });
        if (cR.ok) {
          const cd = await cR.json();
          const cnt = cd[0]?.count || 0;
          if (cnt >= 30) return res.status(429).json({ error: 'Limite de 30 narrações/mês atingido' });
          if (cnt === 0) {
            await fetch(`${SU}/rest/v1/bv_narration_counts`, { method: 'POST', headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: userId, month, count: 1 }) });
          } else {
            await fetch(`${SU}/rest/v1/bv_narration_counts?user_id=eq.${userId}&month=eq.${month}`, { method: 'PATCH', headers: { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ count: cnt + 1 }) });
          }
        }
      } catch(e) {}

      return res.status(200).json({ audio_b64: b64, content_type: 'audio/mpeg' });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }


  // ── ACTION: voice-preview ────────────────────────────────────────────────
  if (action === 'voice-preview') {
    const EL = process.env.ELEVENLABS_API_KEY;
    if (!EL) return res.status(500).json({ error: 'ElevenLabs não configurado' });
    const vid = req.body?.voiceId || req.query?.voiceId;
    if (!vid) return res.status(400).json({ error: 'voiceId obrigatório' });
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/voices/${vid}`, {
        headers: { 'xi-api-key': EL }
      });
      if (!r.ok) return res.status(404).json({ error: 'Voz não encontrada no ElevenLabs' });
      const d = await r.json();
      if (!d.preview_url) return res.status(404).json({ error: 'Preview não disponível para esta voz' });
      return res.status(200).json({ url: d.preview_url, name: d.name });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── ACTION: get-video-url (proxy cobalt para evitar CORS) ────────────────
  if (action === 'get-video-url') {
    const vid = req.body?.videoId;
    if (!vid) return res.status(400).json({ error: 'videoId obrigatório' });
    try {
      const r = await fetch('https://api.cobalt.tools/api/json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          url: `https://www.youtube.com/shorts/${vid}`,
          vCodec: 'h264', vQuality: '720',
          filenamePattern: 'basic', disableMetadata: true
        })
      });
      const d = await r.json();
      if (!r.ok || d.status === 'error') {
        return res.status(503).json({ error: d.text || 'Falha ao obter link do vídeo. Verifique se o Short é público.' });
      }
      const videoUrl = d.url || d.picker?.[0]?.url;
      if (!videoUrl) return res.status(503).json({ error: 'URL de download não encontrada' });
      return res.status(200).json({ url: videoUrl });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── ACTION: get-music (proxy música para evitar CORS) ─────────────────────
  if (action === 'get-music') {
    const { musicId } = req.body || {};
    const MUSIC_URLS = {
      lofi:      'https://cdn.pixabay.com/audio/2023/06/19/audio_f5f9b7b0e3.mp3',
      epic:      'https://cdn.pixabay.com/audio/2023/04/18/audio_71ef0ddf98.mp3',
      corporate: 'https://cdn.pixabay.com/audio/2022/12/23/audio_e9b0d2c02e.mp3',
      upbeat:    'https://cdn.pixabay.com/audio/2023/07/26/audio_dfe6e47b77.mp3',
    };
    if (!musicId || !MUSIC_URLS[musicId]) return res.status(400).json({ error: 'musicId inválido' });
    try {
      const r = await fetch(MUSIC_URLS[musicId]);
      if (!r.ok) return res.status(503).json({ error: 'Música indisponível' });
      const buf = await r.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      return res.status(200).json({ audio_b64: b64 });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(400).json({ error: 'Ação inválida' });
};
