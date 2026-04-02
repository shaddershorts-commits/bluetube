// api/generate-from-zero.js
// Analisa frames do video (Gemini Vision) + transcricao se disponivel
// NAO usa titulo nem descricao como base criativa

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Garante que qualquer erro retorna JSON valido
  try {

  const { videoUrl, lang, token } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl obrigatorio' });

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
      const uR = await fetch(SU + '/auth/v1/user', { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
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
    } catch(e) {}
  }
  if (userPlan === 'free') return res.status(403).json({ error: 'Recurso exclusivo para planos Full e Master.' });

  const GK = [
    process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3,
    process.env.GEMINI_KEY_4, process.env.GEMINI_KEY_5, process.env.GEMINI_KEY_6,
    process.env.GEMINI_KEY_7, process.env.GEMINI_KEY_8, process.env.GEMINI_KEY_9,
    process.env.GEMINI_KEY_10,
  ].filter(Boolean);
  const shuffled = GK.slice().sort(() => Math.random() - 0.5);
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const safeLang = lang || 'Portugues (Brasil)';

  // ── 1. Tenta pegar transcricao/legenda (o que e DITO no video) ─────────────
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
        const manual = tracks.filter(t => t.kind !== 'asr');
        const track = manual[0] || tracks[0];
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
              .slice(0, 800);
            if (segs && segs.length > 20) transcriptText = segs;
          }
        }
      }
    }
  } catch(e) { console.log('transcript fetch error:', e.message); }

  // Fallback transcript: tenta Supadata se disponivel
  if (!transcriptText && process.env.SUPADATA_API_KEY) {
    try {
      const sRes = await fetch(
        'https://api.supadata.ai/v1/transcript?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + videoId),
        { headers: { 'x-api-key': process.env.SUPADATA_API_KEY } }
      );
      if (sRes.ok) {
        const sData = await sRes.json();
        if (sData.content) {
          const text = Array.isArray(sData.content)
            ? sData.content.map(s => s.text || '').join(' ').slice(0, 800)
            : String(sData.content).slice(0, 800);
          if (text.trim().length > 20) transcriptText = text.trim();
        }
      }
    } catch(e) { console.log('supadata fallback error:', e.message); }
  }

  let fallbackContext = '';
  // ── 2. Analisa frames do video com Gemini Vision (imagens = barato) ─────────
  // YouTube expoe 4 frames do video via thumbnails numeradas (0=thumb, 1/2/3=frames)
  let visualDescription = '';

  if (shuffled.length > 0) {
    try {
      // Baixa 3 frames do video (momentos diferentes)
      const frameUrls = [
        'https://img.youtube.com/vi/' + videoId + '/1.jpg',  // 25% do video
        'https://img.youtube.com/vi/' + videoId + '/2.jpg',  // 50% do video
        'https://img.youtube.com/vi/' + videoId + '/3.jpg',  // 75% do video
      ];

      const frameParts = [];
      for (let i = 0; i < frameUrls.length; i++) {
        try {
          const fRes = await fetch(frameUrls[i]);
          if (fRes.ok) {
            const buf = await fRes.arrayBuffer();
            const b64 = Buffer.from(buf).toString('base64');
            frameParts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
          }
        } catch(e) {}
      }

      if (frameParts.length > 0) {
        frameParts.push({
          text: 'Estes sao ' + frameParts.length + ' frames capturados em momentos diferentes de um Short do YouTube.\n\n' +
            'Descreva em ' + safeLang + ' O QUE ACONTECE VISUALMENTE:\n' +
            '- Quem aparece e o que esta fazendo\n' +
            '- Qual e a acao principal do video\n' +
            '- O que muda de frame para frame\n' +
            '- Qual e o momento mais impactante ou surpreendente\n' +
            '- Tom geral: engracado, emocional, surpreendente, educativo, etc\n\n' +
            'IMPORTANTE: Descreva apenas o que VOCE VE nas imagens. Nao invente nada.'
        });

        for (let k = 0; k < shuffled.length; k++) {
          try {
            const r = await fetch(
              'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + shuffled[k],
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: frameParts }],
                  generationConfig: { temperature: 0.2, maxOutputTokens: 500 }
                })
              }
            );
            const d = await r.json();
            if (d.error && d.error.code === 429) continue;
            const text = d.candidates && d.candidates[0] && d.candidates[0].content &&
              d.candidates[0].content.parts && d.candidates[0].content.parts[0] &&
              d.candidates[0].content.parts[0].text;
            if (text && text.trim().length > 30) {
              visualDescription = text.trim();
              break;
            }
          } catch(e) { continue; }
        }
      }
    } catch(e) { console.log('Frame analysis error:', e.message); }
  }

  // Log para debug
  console.log('generate-from-zero:', videoId, 'transcript:', transcriptText.length, 'chars', 'visual:', visualDescription.length, 'chars');

  // Se nao conseguiu nada, tenta usar YouTube API como ultimo recurso de contexto
  let fallbackContext = '';
  if (!transcriptText && !visualDescription) {
    const YT_KEYS = [
      process.env.YOUTUBE_API_KEY_1, process.env.YOUTUBE_API_KEY_2,
      process.env.YOUTUBE_API_KEY_3,
    ].filter(Boolean);
    for (let i = 0; i < YT_KEYS.length; i++) {
      try {
        const ytRes = await fetch(
          'https://www.googleapis.com/youtube/v3/videos?part=snippet&id=' + videoId + '&key=' + YT_KEYS[i]
        );
        if (!ytRes.ok) continue;
        const ytData = await ytRes.json();
        const item = ytData.items && ytData.items[0];
        if (!item) continue;
        // Usa apenas descricao (nao titulo) como contexto minimo
        const desc = (item.snippet.description || '').slice(0, 400).trim();
        if (desc && desc.length > 20) { fallbackContext = desc; break; }
      } catch(e) { continue; }
    }
    if (!fallbackContext) {
      return res.status(503).json({ error: 'Nao foi possivel analisar o conteudo do video. Verifique se o link e publico.' });
    }
  }

  // ── 3. Memoria viva ───────────────────────────────────────────────────────
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

  // ── 4. Monta contexto APENAS com o que acontece no video ─────────────────
  const contextLines = [];
  if (visualDescription) {
    contextLines.push('O QUE ACONTECE NO VIDEO (analise visual dos frames):');
    contextLines.push(visualDescription);
  }
  if (transcriptText) {
    contextLines.push('');
    contextLines.push('O QUE E DITO NO VIDEO (audio/legenda):');
    contextLines.push(transcriptText);
  }
  if (fallbackContext) {
    contextLines.push('CONTEXTO DISPONIVEL DO VIDEO:');
    contextLines.push(fallbackContext);
  }
  const videoContext = contextLines.join('\n');

  // ── 5. Gera roteiros com prompt viral ────────────────────────────────────
  const promptLines = [
    'FORMULA DO ROTEIRO VIRAL: Ganco forte + Curiosidade crescente + Corte maximo de palavras + Payoff no menor tempo possivel',
    '',
    '== NARRADOR VIRAL ANTI-PROPAGANDA ==',
    'Sua funcao: transformar o que acontece no video em narracao que prenda nos primeiros 2 segundos, gere curiosidade continua e entregue payoff satisfatorio.',
    '',
    'CONTEXTO DO VIDEO (baseie o roteiro APENAS nisso — ignore titulo e descricao):',
    videoContext,
    '',
  ];

  if (livingMemory) {
    promptLines.push('CALIBRACAO DE TOM (ritmo e estilo de referencia, NAO copie):');
    promptLines.push(livingMemory);
    promptLines.push('');
  }

  promptLines.push('IDIOMA: ' + safeLang + ' — linguagem nativa de redes sociais.');
  promptLines.push('');
  promptLines.push('ESTRUTURA OBRIGATORIA:');
  promptLines.push('1. GANCO (0-3s): Intriga imediata. Sem contexto completo. Cria pergunta na mente. Ex: "Ninguem entendeu isso no comeco…" / "Ele achou que era simples, mas…"');
  promptLines.push('2. PROGRESSAO (3-15s): Evolucao. Mini duvidas. Tensao. Use: "So que…" / "Mas ai…" / "Foi ai que…"');
  promptLines.push('3. PAYOFF: Entregar resultado. Surpreender ou satisfazer.');
  promptLines.push('');
  promptLines.push('PROIBIDO:');
  promptLines.push('- Soar como propaganda ou relatorio');
  promptLines.push('- Descrever friamente o que acontece');
  promptLines.push('- Usar "porque" e "para isso" em excesso');
  promptLines.push('- Narrar intencao do personagem');
  promptLines.push('- Mais de 75 palavras');
  promptLines.push('');
  promptLines.push('TESTE ANTES DE RESPONDER:');
  promptLines.push('1. Prende nos primeiros 2 segundos? 2. Tem curiosidade continua? 3. Parece propaganda? (se sim, refaca) 4. Da pra cortar alguma frase?');
  promptLines.push('');
  promptLines.push('casual = gancho curioso e leve, progressao natural, payoff satisfatorio.');
  promptLines.push('apelativo = gancho chocante ou intrigante, tensao maxima, payoff impactante.');
  promptLines.push('');
  promptLines.push('Responda APENAS em JSON valido sem markdown:');
  promptLines.push('{"casual":"roteiro casual aqui","apelativo":"roteiro apelativo aqui","titleCasual":"titulo viral casual","titleApelativo":"titulo viral apelativo"}');

  const prompt = promptLines.join('\n');

  // Tenta OpenAI primeiro, depois Gemini
  let result = null;

  if (OPENAI_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI_KEY },
        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 400, temperature: 0.85,
          messages: [{ role: 'user', content: prompt }] })
      });
      const d = await r.json();
      if (r.ok && d.choices && d.choices[0]) {
        let text = d.choices[0].message.content.trim()
          .replace(/```json/g, '').replace(/```/g, '').trim();
        const si = text.indexOf('{'), ei = text.lastIndexOf('}');
        if (si >= 0 && ei >= 0) {
          const parsed = JSON.parse(text.slice(si, ei + 1));
          if (parsed.casual && parsed.apelativo) result = parsed;
        }
      }
    } catch(e) { console.log('OpenAI error:', e.message); }
  }

  for (let i = 0; i < shuffled.length && !result; i++) {
    try {
      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + shuffled[i],
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.85, maxOutputTokens: 500 } }) }
      );
      const d = await r.json();
      if (d.error && d.error.code === 429) continue;
      let text = d.candidates && d.candidates[0] && d.candidates[0].content &&
        d.candidates[0].content.parts && d.candidates[0].content.parts[0] &&
        d.candidates[0].content.parts[0].text;
      if (!text) continue;
      text = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const si = text.indexOf('{'), ei = text.lastIndexOf('}');
      if (si >= 0 && ei >= 0) {
        const parsed = JSON.parse(text.slice(si, ei + 1));
        if (parsed.casual && parsed.apelativo) result = parsed;
      }
    } catch(e) { continue; }
  }

  if (!result) return res.status(503).json({ error: 'Falha ao gerar roteiros. Tente novamente em instantes.' });

  return res.status(200).json({
    casual: result.casual || '',
    apelativo: result.apelativo || '',
    titleCasual: result.titleCasual || '',
    titleApelativo: result.titleApelativo || ''
  });

  } catch(globalErr) {
    console.error('generate-from-zero fatal:', globalErr.message, globalErr.stack && globalErr.stack.slice(0,300));
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}
