// api/generate-from-zero.js
// Estrategia: YouTube Data API (metadados) + transcricao disponivel -> Gemini texto
// Sem video processing (muito quota) — usa contexto rico de texto

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { videoUrl, lang, token } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl obrigatorio' });

  // Extrai o videoId
  let videoId = '';
  try {
    const match = videoUrl.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/);
    if (match) videoId = match[1];
  } catch(e) {}
  if (!videoId) return res.status(400).json({ error: 'Link invalido' });

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;

  // Verifica plano
  let userPlan = 'free';
  if (token && SU && AK) {
    try {
      const uR = await fetch(SU + '/auth/v1/user', {
        headers: { apikey: AK, Authorization: 'Bearer ' + token }
      });
      if (uR.ok) {
        const uD = await uR.json();
        if (uD.email && SK) {
          const sR = await fetch(
            SU + '/rest/v1/subscribers?email=eq.' + encodeURIComponent(uD.email) + '&select=plan,plan_expires_at,is_manual',
            { headers: { apikey: SK, Authorization: 'Bearer ' + SK } }
          );
          if (sR.ok) {
            const subs = await sR.json();
            const sub = subs && subs[0];
            if (sub && (sub.plan === 'full' || sub.plan === 'master')) {
              const expired = sub.plan_expires_at && new Date(sub.plan_expires_at) < new Date() && !sub.is_manual;
              if (!expired) userPlan = sub.plan;
            }
          }
        }
      }
    } catch(e) { console.log('plan check:', e.message); }
  }
  if (userPlan === 'free') return res.status(403).json({ error: 'Recurso exclusivo para planos Full e Master.' });

  const GK = [
    process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3,
    process.env.GEMINI_KEY_4, process.env.GEMINI_KEY_5, process.env.GEMINI_KEY_6,
    process.env.GEMINI_KEY_7, process.env.GEMINI_KEY_8, process.env.GEMINI_KEY_9,
    process.env.GEMINI_KEY_10,
  ].filter(Boolean);

  // Rotacao aleatoria das chaves Gemini
  const shuffled = GK.slice().sort(() => Math.random() - 0.5);

  const YT_KEYS = [
    process.env.YOUTUBE_API_KEY_1, process.env.YOUTUBE_API_KEY_2,
    process.env.YOUTUBE_API_KEY_3, process.env.YOUTUBE_API_KEY_4,
    process.env.YOUTUBE_API_KEY_5,
  ].filter(Boolean);

  // ── 1. YouTube Data API — pega metadados do video ──────────────────────────
  let videoTitle = '';
  let videoDescription = '';
  let videoDuration = '';
  let viewCount = '';
  let channelName = '';

  for (let i = 0; i < YT_KEYS.length; i++) {
    try {
      const ytRes = await fetch(
        'https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=' + videoId + '&key=' + YT_KEYS[i]
      );
      if (!ytRes.ok) continue;
      const ytData = await ytRes.json();
      const item = ytData.items && ytData.items[0];
      if (!item) continue;
      videoTitle = item.snippet.title || '';
      videoDescription = (item.snippet.description || '').slice(0, 300);
      channelName = item.snippet.channelTitle || '';
      videoDuration = item.contentDetails.duration || '';
      viewCount = (item.statistics && item.statistics.viewCount) ? Number(item.statistics.viewCount).toLocaleString('pt-BR') : '';
      break;
    } catch(e) { continue; }
  }

  // ── 2. Tenta pegar transcricao se disponivel (pode nao ter em videos sem audio) ──
  let transcriptText = '';
  try {
    const tRes = await fetch('https://www.youtube.com/watch?v=' + videoId, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      }
    });
    if (tRes.ok) {
      const html = await tRes.text();
      const match = html.match(/"captionTracks":\s*(\[.*?\])/);
      if (match) {
        const tracks = JSON.parse(match[1]);
        const track = tracks.find(t => t.languageCode === 'pt') ||
                      tracks.find(t => t.languageCode === 'en') ||
                      tracks[0];
        if (track && track.baseUrl) {
          const capRes = await fetch(track.baseUrl + '&fmt=json3');
          if (capRes.ok) {
            const capData = await capRes.json();
            const segs = (capData.events || [])
              .filter(e => e.segs)
              .map(e => e.segs.map(s => s.utf8 || '').join(''))
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 600);
            if (segs && segs.length > 30) transcriptText = segs;
          }
        }
      }
    }
  } catch(e) {}

  // ── 3. Monta contexto rico para o Gemini ───────────────────────────────────
  const contextParts = [];
  if (videoTitle) contextParts.push('TITULO: ' + videoTitle);
  if (channelName) contextParts.push('CANAL: ' + channelName);
  if (viewCount) contextParts.push('VIEWS: ' + viewCount);
  if (videoDuration) contextParts.push('DURACAO: ' + videoDuration);
  if (videoDescription) contextParts.push('DESCRICAO: ' + videoDescription);
  if (transcriptText) contextParts.push('AUDIO/TRANSCRICAO DISPONIVEL: ' + transcriptText);
  else contextParts.push('OBS: Este video nao tem narração — crie um roteiro narrativo baseado apenas no contexto acima.');

  const videoContext = contextParts.join('\n');

  if (!videoTitle && !transcriptText) {
    return res.status(503).json({ error: 'Nao foi possivel obter informacoes do video. Verifique se o link e publico.' });
  }

  // ── 4. Memoria viva ───────────────────────────────────────────────────────
  let livingMemory = '';
  if (SU && SK) {
    try {
      const mR = await fetch(
        SU + '/rest/v1/viral_shorts?order=copy_count.desc&limit=5&select=transcript,copy_count&copy_count=gte.2',
        { headers: { apikey: SK, Authorization: 'Bearer ' + SK } }
      );
      if (mR.ok) {
        const rows = await mR.json();
        if (rows && rows.length > 0) {
          livingMemory = rows.map(function(r, i) {
            return 'Ex' + (i+1) + ': "' + (r.transcript || '').slice(0, 180) + '"';
          }).join('\n');
        }
      }
    } catch(e) {}
  }

  const safeLang = lang || 'Portugues (Brasil)';

  // ── 5. Gemini gera roteiros originais ────────────────────────────────────
  const promptLines = [
    'Voce e um especialista em roteiros virais para YouTube Shorts.',
    '',
    'DADOS DO VIDEO:',
    videoContext,
    '',
  ];
  if (livingMemory) {
    promptLines.push('CALIBRACAO DE TOM (use como referencia de ritmo e estilo, NAO copie):');
    promptLines.push(livingMemory);
    promptLines.push('');
  }
  promptLines.push('IDIOMA DE SAIDA: ' + safeLang);
  promptLines.push('');
  promptLines.push('Com base nos dados do video acima, crie 2 roteiros narrativos ORIGINAIS.');
  promptLines.push('Regras:');
  promptLines.push('- NAO copie o video original — crie algo novo sobre o mesmo tema');
  promptLines.push('- Maximo 75 palavras cada');
  promptLines.push('- Tom nativo de Short viral no idioma ' + safeLang);
  promptLines.push('- Texto corrido, sem emojis, sem marcadores, sem titulos');
  promptLines.push('- casual: leve, conversacional, curioso');
  promptLines.push('- apelativo: hook forte, urgencia, maximo impacto nos primeiros 2 segundos');
  promptLines.push('');
  promptLines.push('Responda APENAS em JSON valido sem markdown:');
  promptLines.push('{"casual":"roteiro casual aqui","apelativo":"roteiro apelativo aqui","titleCasual":"titulo viral casual","titleApelativo":"titulo viral apelativo"}');

  const prompt = promptLines.join('\n');

  let result = null;
  for (let i = 0; i < shuffled.length; i++) {
    try {
      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + shuffled[i],
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.85, maxOutputTokens: 600 }
          })
        }
      );
      const d = await r.json();
      if (d.error) {
        console.log('Gemini key', i, 'error:', d.error.code, d.error.status);
        if (d.error.code === 429) continue;
        continue;
      }
      let text = d.candidates && d.candidates[0] && d.candidates[0].content &&
        d.candidates[0].content.parts && d.candidates[0].content.parts[0] &&
        d.candidates[0].content.parts[0].text;
      if (!text) continue;
      text = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const si = text.indexOf('{');
      const ei = text.lastIndexOf('}');
      if (si >= 0 && ei >= 0) {
        const parsed = JSON.parse(text.slice(si, ei + 1));
        if (parsed.casual && parsed.apelativo) { result = parsed; break; }
      }
    } catch(e) { console.log('Gemini exception key', i, ':', e.message); continue; }
  }

  if (!result) return res.status(503).json({ error: 'Falha ao gerar roteiros. Todas as chaves Gemini atingiram o limite. Tente em alguns instantes.' });

  return res.status(200).json({
    casual: result.casual || '',
    apelativo: result.apelativo || '',
    titleCasual: result.titleCasual || '',
    titleApelativo: result.titleApelativo || ''
  });
}
