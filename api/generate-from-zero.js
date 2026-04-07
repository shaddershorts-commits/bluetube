// api/generate-from-zero.js — CommonJS
const { applyRateLimit } = require('./helpers/rate-limit.js');
const { detectInjection, sanitizeInput } = require('./helpers/sanitize.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (await applyRateLimit(req, res)) return;

  try {
    const { videoUrl, lang, token, userSummary, sentiments, niche } = req.body || {};
    if (!videoUrl) return res.status(400).json({ error: 'Link do vídeo é obrigatório.' });
    if (userSummary && userSummary.length > 5000) return res.status(400).json({ error: 'Descrição excede o limite.' });
    // Prompt injection check
    const combined = sanitizeInput([userSummary, niche, videoUrl].filter(Boolean).join(' '));
    if (detectInjection(combined)) return res.status(400).json({ error: 'Conteúdo não permitido detectado.' });

    let videoId = '';
    const match = videoUrl.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/);
    if (match) videoId = match[1];
    if (!videoId) return res.status(400).json({ error: 'Link inválido. Use um link de YouTube Shorts.' });

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
      'Você é um roteirista de YouTube Shorts especialista em narração EXTERNA em terceira pessoa.',
      'Você NUNCA simula a voz das pessoas do vídeo. Você é o NARRADOR que conta a história.',
      '',
      '=== CONTEXTO ===',
      contextParts.join('\n\n'),
      'Sentimento: ' + sentimentList,
      'Nicho: ' + nicheLabel,
      'Idioma: ' + safeLang,
      '',
      '=== IDENTIDADE DO NARRADOR ===',
      '- Você é o narrador EXTERNO — NUNCA a pessoa do vídeo',
      '- Fala SOBRE os acontecimentos em terceira pessoa',
      '- PROIBIDO: "Eu fiz...", "Olha o que me aconteceu...", primeira pessoa',
      '',
      '=== REGRA DE PERGUNTAS ===',
      '✅ Pergunta permitida APENAS no gancho OU no desfecho — máximo 1 por roteiro',
      '❌ ZERO perguntas no MEIO do roteiro',
      '❌ Proibido: "Incrível, não é?", "Consegue acreditar?"',
      '',
      '=== ESTRUTURA — 3 ATOS CONTÍNUOS ===',
      'ATO 1 — GANCHO: afirmação intrigante OU pergunta. Direto ao conflito, sem contexto.',
      'ATO 2 — PROGRESSÃO: cada frase avança. Viradas: "Só que...", "Mas aí...". ZERO perguntas.',
      'ATO 3 — DESFECHO [' + nicheLabel.toUpperCase() + ']: ' + nicheEnding,
      '',
      '=== CASUAL vs APELATIVO ===',
      'casual = narrador próximo e informal, ritmo respirado, como amigo contando história',
      'apelativo = narrador urgente, ritmo acelerado, frases curtas, tensão máxima',
      '',
      '=== REGRAS ===',
      '- Máximo 60 palavras cada versão',
      '- Continuidade total — cada frase conecta na próxima',
      '- Frases curtas, sem conectores fracos',
      '- Moeda: ' + cult.cur + '. Referências: ' + cult.ref,
      '- Sem emojis, sem CTA, sem markdown',
      '',
      '=== TESTE ANTES DE RESPONDER ===',
      '1. Narrador externo? 2. Pergunta só no gancho/desfecho? 3. Continuidade entre frases?',
      '4. Máximo 1 pergunta? 5. Desfecho do nicho ' + nicheLabel + '?',
      '',
      livingMemory ? 'REFERÊNCIA:\n' + livingMemory + '\n' : '',
      'Responda SOMENTE JSON válido:',
      '{"casual":"roteiro","apelativo":"roteiro","titleCasual":"título","titleApelativo":"título","narrative_arc":"gancho → virada → desfecho [' + nicheLabel + ']"}'
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
              { role: 'system', content: 'Você é um narrador EXTERNO de YouTube Shorts. NUNCA simule a voz das pessoas do vídeo. Fale SOBRE eles em terceira pessoa. Máximo 1 pergunta por roteiro (só no gancho ou desfecho). Responda SOMENTE JSON válido.' },
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

    let finalCasual = result.casual || '';
    let finalApelativo = result.apelativo || '';
    let finalTitleCasual = result.titleCasual || result.title_casual || '';
    let finalTitleApelativo = result.titleApelativo || result.title_apelativo || '';

    // Se idioma diferente de PT-BR, adaptar culturalmente
    const isPtBr = safeLang === 'Portugues (Brasil)' || safeLang === 'Português (Brasil)';
    if (!isPtBr && safeLang && (finalCasual || finalApelativo)) {
      console.log('generate-from-zero: adaptando para', safeLang);
      const adaptPrompt = `Você é um ADAPTADOR CULTURAL ELITE nativo de ${safeLang}.
Adapte estes roteiros para ${safeLang} como se fossem escritos originalmente por um criador nativo.

REGRAS:
- NUNCA traduza literalmente
- Adapte moedas para a moeda local de ${safeLang}
- Adapte referências culturais, expressões idiomáticas, nomes e contextos
- Mantenha a estrutura dos 3 atos: gancho → progressão → desfecho
- Mantenha o ritmo, energia e tom (casual=leve / apelativo=urgente)
- O resultado deve soar 100% nativo de ${safeLang}

ROTEIRO CASUAL:
"${finalCasual}"

ROTEIRO APELATIVO:
"${finalApelativo}"

TÍTULO CASUAL: "${finalTitleCasual}"
TÍTULO APELATIVO: "${finalTitleApelativo}"

Responda SOMENTE com JSON válido, sem markdown:
{"casual":"roteiro casual adaptado","apelativo":"roteiro apelativo adaptado","titleCasual":"título adaptado","titleApelativo":"título adaptado"}`;

      // Try OpenAI first, then Gemini
      let adapted = null;
      if (OPENAI_KEY) {
        try {
          const ar = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI_KEY },
            body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 600, temperature: 0.8,
              messages: [{ role: 'system', content: 'Adapte roteiros para ' + safeLang + '. Responda SOMENTE JSON.' }, { role: 'user', content: adaptPrompt }]
            })
          });
          const ad = await ar.json();
          if (ar.ok && ad.choices?.[0]?.message?.content) {
            let txt = ad.choices[0].message.content.trim().replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
            const si = txt.indexOf('{'), ei = txt.lastIndexOf('}');
            if (si >= 0 && ei >= 0) { const p = JSON.parse(txt.slice(si, ei+1)); if (p.casual) adapted = p; }
          }
        } catch(e) { console.error('adapt openai:', e.message); }
      }
      if (!adapted) {
        for (const key of GK) {
          try {
            const ar = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contents: [{ parts: [{ text: adaptPrompt }] }], generationConfig: { temperature: 0.8, maxOutputTokens: 700 } })
            });
            const ad = await ar.json();
            if (ad.error?.code === 429) continue;
            let txt = ad.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
            if (!txt) continue;
            txt = txt.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
            const si = txt.indexOf('{'), ei = txt.lastIndexOf('}');
            if (si >= 0 && ei >= 0) { const p = JSON.parse(txt.slice(si, ei+1)); if (p.casual) { adapted = p; break; } }
          } catch(e) { continue; }
        }
      }
      if (adapted) {
        finalCasual = adapted.casual || finalCasual;
        finalApelativo = adapted.apelativo || finalApelativo;
        finalTitleCasual = adapted.titleCasual || adapted.title_casual || finalTitleCasual;
        finalTitleApelativo = adapted.titleApelativo || adapted.title_apelativo || finalTitleApelativo;
        console.log('generate-from-zero: adaptação concluída para', safeLang);
      }
    }

    return res.status(200).json({
      casual: finalCasual,
      apelativo: finalApelativo,
      titleCasual: finalTitleCasual,
      titleApelativo: finalTitleApelativo,
      narrative_arc: result.narrative_arc || ('gancho → virada → desfecho [' + (nicheLabel || 'Geral') + ']'),
      lang: safeLang
    });

  } catch(err) {
    console.error('generate-from-zero fatal:', err.message);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
};
