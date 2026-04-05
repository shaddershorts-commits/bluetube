// api/generate-from-zero.js — CommonJS
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { videoUrl, lang, token, userSummary, sentiments, niche } = req.body || {};
    if (!videoUrl) return res.status(400).json({ error: 'videoUrl obrigatorio' });

    let videoId = '';
    const match = videoUrl.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/);
    if (match) videoId = match[1];
    if (!videoId) return res.status(400).json({ error: 'Link invalido' });

    const SU = process.env.SUPABASE_URL;
    const SK = process.env.SUPABASE_SERVICE_KEY;
    const AK = process.env.SUPABASE_ANON_KEY || SK;

    // ── Verifica plano ────────────────────────────────────────────────────────
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
    ].filter(Boolean).sort(() => Math.random() - 0.5);

    const YTK = [
      process.env.YOUTUBE_API_KEY_1, process.env.YOUTUBE_API_KEY_2,
      process.env.YOUTUBE_API_KEY_3, process.env.YOUTUBE_API_KEY_4,
    ].filter(Boolean);

    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    const SUPADATA_KEY = process.env.SUPADATA_API_KEY;
    const safeLang = lang || 'Portugues (Brasil)';

    // ── 1. Supadata transcript (mais confiavel) ───────────────────────────────
    let transcriptText = '';
    if (SUPADATA_KEY) {
      try {
        const sR = await fetch('https://api.supadata.ai/v1/transcript?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + videoId), {
          headers: { 'x-api-key': SUPADATA_KEY }
        });
        if (sR.ok) {
          const sd = await sR.json();
          if (sd.content) {
            const t = Array.isArray(sd.content) ? sd.content.map(s => s.text || '').join(' ') : String(sd.content);
            if (t.trim().length > 20) transcriptText = t.trim().slice(0, 800);
          }
        }
      } catch(e) {}
    }

    // ── 2. YouTube timedtext (fallback transcript) ────────────────────────────
    if (!transcriptText) {
      try {
        const pR = await fetch('https://www.youtube.com/watch?v=' + videoId, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
        });
        if (pR.ok) {
          const html = await pR.text();
          const cm = html.match(/"captionTracks":\s*(\[.*?\])/);
          if (cm) {
            const tracks = JSON.parse(cm[1]);
            const track = tracks.find(t => t.kind !== 'asr') || tracks[0];
            if (track && track.baseUrl) {
              const cR = await fetch(track.baseUrl + '&fmt=json3');
              if (cR.ok) {
                const cd = await cR.json();
                const segs = (cd.events || []).filter(e => e.segs).map(e => e.segs.map(s => s.utf8 || '').join('')).join(' ').replace(/\s+/g, ' ').trim();
                if (segs.length > 20) transcriptText = segs.slice(0, 800);
              }
            }
          }
        }
      } catch(e) {}
    }

    // ── 3. YouTube API — metadados (sempre tenta) ─────────────────────────────
    let ytTitle = '', ytDesc = '', ytChannel = '';
    for (const key of YTK) {
      try {
        const yR = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet&id=' + videoId + '&key=' + key);
        if (!yR.ok) continue;
        const yd = await yR.json();
        const item = yd.items && yd.items[0];
        if (!item) continue;
        ytTitle = item.snippet.title || '';
        ytDesc = (item.snippet.description || '').slice(0, 300);
        ytChannel = item.snippet.channelTitle || '';
        break;
      } catch(e) { continue; }
    }

    // ── 4. Gemini Vision — analisa frames (se tiver quota) ───────────────────
    let visualDescription = '';
    if (GK.length > 0) {
      try {
        const frameUrls = [
          'https://img.youtube.com/vi/' + videoId + '/1.jpg',
          'https://img.youtube.com/vi/' + videoId + '/2.jpg',
          'https://img.youtube.com/vi/' + videoId + '/3.jpg',
        ];
        const frameParts = [];
        for (const url of frameUrls) {
          try {
            const fR = await fetch(url);
            if (fR.ok) {
              const buf = await fR.arrayBuffer();
              const b64 = Buffer.from(buf).toString('base64');
              if (b64.length > 1000) frameParts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
            }
          } catch(e) {}
        }
        if (frameParts.length > 0) {
          frameParts.push({ text: 'Descreva em ' + safeLang + ' O QUE ACONTECE VISUALMENTE nestes frames: quem aparece, o que faz, qual e a acao principal, o momento mais impactante. Apenas o que voce ve.' });
          for (const key of GK) {
            try {
              const gR = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + key, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: frameParts }], generationConfig: { temperature: 0.2, maxOutputTokens: 400 } })
              });
              const gd = await gR.json();
              if (gd.error && gd.error.code === 429) continue;
              const t = gd.candidates && gd.candidates[0] && gd.candidates[0].content && gd.candidates[0].content.parts && gd.candidates[0].content.parts[0] && gd.candidates[0].content.parts[0].text;
              if (t && t.trim().length > 30) { visualDescription = t.trim(); break; }
            } catch(e) { continue; }
          }
        }
      } catch(e) {}
    }

    // ── 5. Monta contexto — prioriza visual e audio, titulo como ultimo recurso ─
    const contextParts = [];
    if (visualDescription) contextParts.push('ANALISE VISUAL DO VIDEO:\n' + visualDescription);
    if (transcriptText) contextParts.push('AUDIO/LEGENDA DO VIDEO:\n' + transcriptText);
    // Se nao tem visual nem audio, usa titulo+descricao como contexto minimo
    if (!transcriptText && !visualDescription) {
      const fallback = [ytTitle, ytDesc].filter(Boolean).join(' | ');
      if (fallback.trim().length > 3) contextParts.push('CONTEXTO DO VIDEO (inferir tema e criar roteiro original):\n' + fallback);
    }
    if (ytChannel) contextParts.push('Canal: ' + ytChannel);
    // Context from user's guided flow
    if (userSummary) contextParts.push('RESUMO DO CRIADOR (prioridade máxima):\n' + userSummary);
    if (sentiments && sentiments.length) contextParts.push('SENTIMENTO DESEJADO: ' + sentiments.join(', '));
    if (niche) contextParts.push('NICHO DO CANAL: ' + niche);

    console.log('generate-from-zero:', videoId, '| transcript:', transcriptText.length, '| visual:', visualDescription.length, '| ytTitle:', ytTitle.length, '| ctx:', contextParts.length);

    if (contextParts.length === 0) {
      return res.status(503).json({ error: 'Nao foi possivel obter informacoes do video. Verifique se o link e publico.' });
    }

    // ── 6. Memoria viva ───────────────────────────────────────────────────────
    let livingMemory = '';
    if (SU && SK) {
      try {
        const mR = await fetch(SU + '/rest/v1/viral_shorts?order=copy_count.desc&limit=4&select=transcript,copy_count&copy_count=gte.2', { headers: { apikey: SK, Authorization: 'Bearer ' + SK } });
        if (mR.ok) {
          const rows = await mR.json();
          if (rows && rows.length > 0) livingMemory = rows.map((r, i) => 'Ex' + (i+1) + ': "' + (r.transcript || '').slice(0, 160) + '"').join('\n');
        }
      } catch(e) {}
    }

    // ── 7. Adaptação cultural + Prompt viral ────────────────────────────────
    const CULTURAL = {
      'Portugues (Brasil)': { cur:'Reais (R$)', ref:'brasileiras' },
      'Português (Brasil)': { cur:'Reais (R$)', ref:'brasileiras' },
      'English': { cur:'Dollars ($)', ref:'American' },
      'Español': { cur:'dinero/pesos/euros', ref:'hispanas/latinas' },
      'Français': { cur:'Euros (€)', ref:'françaises' },
      'Deutsch': { cur:'Euro (€)', ref:'deutsche' },
      'Italiano': { cur:'Euro (€)', ref:'italiane' },
      '日本語': { cur:'円 (¥)', ref:'日本の' },
      '中文': { cur:'人民币 (¥)', ref:'中国的' },
      'العربية': { cur:'العملة المحلية', ref:'عربية' },
    };
    const cult = CULTURAL[safeLang] || { cur:'local currency', ref:'local' };

    // Desfecho por nicho
    const nicheLabel = (niche || 'Geral').trim();
    const NICHE_ENDINGS = {
      'Curiosidades': 'Revele o fato surpreendente. Tom: "E a explicação disso vai te surpreender..." Termine com dado ou revelação inesperada.',
      'Ciência': 'Conecte o visual ao fenômeno científico. Tom: revelatório e fascinante. Termine explicando O PORQUÊ de forma simples e impactante.',
      'Entretenimento': 'Desfecho emocional ou cômico. Tom: satisfatório ou hilário. Termine com a reação ou consequência final.',
      'Finanças': 'Conecte ao aprendizado ou erro financeiro. Tom: revelador e prático. Termine com a lição de valor real.',
      'Saúde/Fitness': 'Conecte ao benefício ou consequência física. Tom: motivacional ou surpreendente. Termine com resultado concreto.',
      'Games': 'Desfecho épico ou engraçado. Tom: emocionante ou absurdo. Termine com a jogada ou momento decisivo.',
      'Tecnologia': 'Revele a implicação ou capacidade surpreendente. Tom: impressionante e acessível. Termine com o impacto prático.',
      'Outro': 'Desfecho surpreendente e satisfatório. Termine com uma revelação ou consequência inesperada.',
    };
    const nicheEnding = NICHE_ENDINGS[nicheLabel] || NICHE_ENDINGS['Outro'];

    // Sentimentos para tom
    const sentimentList = Array.isArray(sentiments) && sentiments.length > 0 ? sentiments.join(', ') : 'Surpresa';

    const prompt = [
      'Você é um roteirista de YouTube Shorts com 10 anos de experiência criando vídeos virais em ' + safeLang + '.',
      'Você não descreve vídeos — você cria experiências narrativas que prendem do primeiro ao último segundo.',
      'Cada roteiro tem começo, meio e fim com propósito. NUNCA soe como narração de documentário.',
      '',
      '=== CONTEXTO DO VÍDEO ===',
      contextParts.join('\n\n'),
      '',
      '=== DIREÇÕES DO CRIADOR ===',
      'Sentimento desejado: ' + sentimentList,
      'Nicho do canal: ' + nicheLabel,
      '',
      '=== ESTRUTURA NARRATIVA OBRIGATÓRIA (3 ATOS) ===',
      '',
      'ATO 1 — GANCHO NARRATIVO (primeiros 3 segundos):',
      '- Jogue o espectador no MEIO da história, sem contexto',
      '- Primeira frase = afirmação que gera dúvida ou pergunta implícita',
      '- Tom: urgente, intrigante, sem explicação',
      '',
      'ATO 2 — PROGRESSÃO COM VIRADAS (meio):',
      '- Cada frase avança a história — zero frases decorativas',
      '- Use OBRIGATORIAMENTE: "Só que..." / "Mas aí..." / "Foi aí que..." / "Ninguém esperava..."',
      '- PELO MENOS UMA virada inesperada',
      '- Tensão crescente: cada frase mais intensa que a anterior',
      '- Máximo 3 frases neste ato',
      '',
      'ATO 3 — DESFECHO ESPECÍFICO PARA [' + nicheLabel.toUpperCase() + ']:',
      nicheEnding,
      '',
      '=== RITMO E ENERGIA ===',
      '- Frases curtas: máximo 10 palavras por frase',
      '- Não repetir início de frase ("Ele... Ele..." proibido)',
      '- Alternar afirmativas com frases de impacto',
      '- Reticências para suspense, ponto final para impacto',
      '- Lido em voz alta: entre 20 e 35 segundos',
      '- Se pode cortar uma palavra, corte',
      '',
      '=== CASUAL vs APELATIVO ===',
      'casual = amigo contando uma história, coloquial, humor leve. Ex: "Cara, você não vai acreditar..."',
      'apelativo = urgência MÁXIMA, zero espaço para respirar, frases ainda mais curtas. Ex: "Isso não deveria ser possível. Mas aconteceu."',
      '',
      '=== PROIBIÇÕES ABSOLUTAS ===',
      '"Este vídeo mostra...", "Neste vídeo vemos...", "O objetivo é...", "Para isso ele..."',
      'Qualquer narração de documentário. Qualquer explicação de intenção.',
      'Começar com "Aqui" ou "Neste". Terminar com "curta e compartilhe".',
      'Markdown, emojis, títulos.',
      '',
      '=== ADAPTAÇÃO CULTURAL ===',
      'Moeda: ' + cult.cur + '. Referências: ' + cult.ref + '. NUNCA soe como tradução.',
      'Idioma: ' + safeLang + ' nativo de redes sociais.',
      '',
      '=== TESTE (aplique antes de responder) ===',
      '1. Primeira frase prende em 2s? 2. Tem virada no meio? 3. Desfecho é do nicho ' + nicheLabel + '?',
      '4. Alguma frase cortável? Corte. 5. Parece propaganda? Refaça. 6. Natural em voz alta?',
      '7. Narrativa tem começo-meio-fim claros? Se QUALQUER item falhar, refaça.',
      '',
      livingMemory ? 'CALIBRAÇÃO DE TOM:\n' + livingMemory + '\n' : '',
      'Responda SOMENTE com JSON válido, sem markdown, sem explicação:',
      '{"casual":"roteiro casual completo 3 atos","apelativo":"roteiro apelativo completo 3 atos","titleCasual":"título viral","titleApelativo":"título viral","narrative_arc":"gancho → virada → desfecho [' + nicheLabel + ']"}'
    ].join('\n');

    // ── 8. Gera com OpenAI (primary) + Gemini (fallback) ─────────────────────
    let result = null;

    if (OPENAI_KEY) {
      try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI_KEY },
          body: JSON.stringify({
            model: 'gpt-4o-mini', max_tokens: 600, temperature: 0.88,
            messages: [
              { role: 'system', content: 'Você é um roteirista viral de alto desempenho. Responda SOMENTE com JSON válido, sem markdown.' },
              { role: 'user', content: prompt }
            ]
          })
        });
        const d = await r.json();
        if (r.ok && d.choices && d.choices[0]) {
          let text = d.choices[0].message.content.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          const si = text.indexOf('{'), ei = text.lastIndexOf('}');
          if (si >= 0 && ei >= 0) { const p = JSON.parse(text.slice(si, ei+1)); if (p.casual && p.apelativo) result = p; }
        }
      } catch(e) { console.error('OpenAI error:', e.message); }
    }

    for (let i = 0; i < GK.length && !result; i++) {
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GK[i], {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.88, maxOutputTokens: 700, topP: 0.95 } })
        });
        const d = await r.json();
        if (d.error && (d.error.code === 429 || d.error.code === 503)) continue;
        if (!r.ok) continue;
        let text = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
        if (!text) continue;
        text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const si = text.indexOf('{'), ei = text.lastIndexOf('}');
        if (si >= 0 && ei >= 0) { const p = JSON.parse(text.slice(si, ei+1)); if (p.casual && p.apelativo) result = p; }
      } catch(e) { continue; }
    }

    if (!result) return res.status(503).json({ error: 'Falha ao gerar roteiros. Tente em alguns instantes.' });

    return res.status(200).json({
      casual: result.casual || '',
      apelativo: result.apelativo || '',
      titleCasual: result.titleCasual || result.title_casual || '',
      titleApelativo: result.titleApelativo || result.title_apelativo || '',
      narrative_arc: result.narrative_arc || ('gancho → virada → desfecho [' + (nicheLabel || 'Geral') + ']')
    });

  } catch(err) {
    console.error('generate-from-zero fatal:', err.message);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
};
