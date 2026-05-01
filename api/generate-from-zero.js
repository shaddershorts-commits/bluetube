// api/generate-from-zero.js — CommonJS
const { applyRateLimit } = require('./helpers/rate-limit.js');
const { detectInjection, sanitizeInput } = require('./helpers/sanitize.js');
const { callAI } = require('./_helpers/ai.js');

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

    // Detecta plataforma da URL — YouTube/TikTok/Instagram suportadas via Supadata.
    // YouTube tambem extrai videoId pra usar em fluxos especificos (Vision/timedtext).
    let videoId = '';
    let platform = 'unknown';
    try {
      const u = new URL(String(videoUrl));
      const host = u.hostname.replace(/^www\./, '');
      if (/youtube\.com|youtu\.be/i.test(host)) {
        platform = 'youtube';
        const m = videoUrl.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/);
        if (m) videoId = m[1];
      } else if (/tiktok\.com/i.test(host)) {
        platform = 'tiktok';
      } else if (/instagram\.com/i.test(host)) {
        platform = 'instagram';
      }
    } catch (_) {}

    if (platform === 'unknown') {
      return res.status(400).json({ error: 'Link inválido. Use YouTube Shorts, TikTok ou Instagram Reels.' });
    }
    if (platform === 'youtube' && !videoId) {
      return res.status(400).json({ error: 'Link YouTube inválido. Use: youtube.com/shorts/...' });
    }

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
    const safeLang = lang || 'Portugues (Brasil)';

    // ── 1. Supadata transcript via helper (cache compartilhado + fallback) ───
    // Helper aceita URL completa de qualquer plataforma (YouTube/TikTok/Instagram).
    // Checa cache 30d, tenta SUPADATA_API_KEY, fallback SUPADATA_API_KEY_FALLBACK.
    let transcriptText = '';
    try {
      const { getTranscript, extractText } = require('./_helpers/supadata.js');
      const result = await getTranscript(videoUrl, { SUPABASE_URL: SU, SUPABASE_KEY: SK });
      if (result.ok) {
        const t = extractText(result.data, 800);
        if (t.length > 20) transcriptText = t;
      }
    } catch(e) {}

    // ── 2. YouTube timedtext (fallback transcript — SO YouTube) ──────────────
    if (!transcriptText && platform === 'youtube') {
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

    // ── 3. YouTube API — metadados (SO YouTube — TikTok/Instagram nao tem) ────
    let ytTitle = '', ytDesc = '', ytChannel = '';
    if (platform === 'youtube') {
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
    }

    // ── 4. Claude Vision — frames (SO YouTube por enquanto) ──────────────────
    // Pra TikTok/Instagram nao temos thumbs YouTube-style. Pulamos Vision
    // e geramos roteiro so com transcricao (Supadata fornece bem).
    let visualDescription = '';
    let detectedNiche = '';
    let visualHighlight = '';
    let visionProvider = null;
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

    if (ANTHROPIC_KEY && platform === 'youtube') {
      try {
        // 4 frames cobrindo ~25%, 50% (HD), 50%, 75% do vídeo
        const frameUrls = [
          'https://img.youtube.com/vi/' + videoId + '/maxresdefault.jpg',
          'https://img.youtube.com/vi/' + videoId + '/1.jpg',
          'https://img.youtube.com/vi/' + videoId + '/2.jpg',
          'https://img.youtube.com/vi/' + videoId + '/3.jpg',
        ];

        const claudeContent = frameUrls.map(url => ({
          type: 'image',
          source: { type: 'url', url }
        }));
        claudeContent.push({
          type: 'text',
          text: 'Analise estes frames de um YouTube Short e responda em ' + safeLang + '.\n\n' +
            'Retorne SOMENTE JSON válido sem markdown:\n' +
            '{\n' +
            '  "description": "descrição em 2-3 frases do que acontece visualmente: quem aparece, o que faz, ambiente, ação principal, momento mais impactante",\n' +
            '  "niche": "nicho do vídeo em 1-2 palavras (ex: Culinária, Esporte, Humor, Educação, Curiosidades, Ciência, Finanças, Saúde/Fitness, Games, Tecnologia, Entretenimento)",\n' +
            '  "highlight": "o momento ou elemento visual mais viral/impactante do vídeo"\n' +
            '}'
        });

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25000);
        const cR = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 600,
            messages: [{ role: 'user', content: claudeContent }]
          }),
          signal: ctrl.signal
        });
        clearTimeout(timer);

        if (cR.ok) {
          const cD = await cR.json();
          const txt = cD.content?.[0]?.text || '';
          if (txt) {
            try {
              const si = txt.indexOf('{'), ei = txt.lastIndexOf('}');
              if (si >= 0 && ei >= 0) {
                const parsed = JSON.parse(txt.slice(si, ei + 1));
                if (parsed.description && parsed.description.trim().length > 20) {
                  visualDescription = parsed.description.trim();
                  detectedNiche = (parsed.niche || '').trim();
                  visualHighlight = (parsed.highlight || '').trim();
                  visionProvider = 'claude';
                  console.log('generate-from-zero: Claude Vision OK, niche=', detectedNiche);
                }
              }
            } catch (parseErr) {
              // Texto livre — usa como descrição mesmo sem JSON
              if (txt.trim().length > 30) {
                visualDescription = txt.trim().slice(0, 1000);
                visionProvider = 'claude';
              }
            }
          }
        } else {
          console.log('generate-from-zero: Claude Vision falhou', cR.status);
        }
      } catch (e) {
        console.log('generate-from-zero: Claude Vision erro', e.name === 'AbortError' ? 'timeout' : e.message);
      }
    }

    // ── 4b. Gemini Vision — fallback se Claude falhou (SO YouTube) ───────────
    if (!visualDescription && GK.length > 0 && platform === 'youtube') {
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
              if (t && t.trim().length > 30) { visualDescription = t.trim(); visionProvider = 'gemini'; break; }
            } catch(e) { continue; }
          }
        }
      } catch(e) {}
    }

    // ── 5. Monta contexto — prioriza visual e audio, titulo como ultimo recurso ─
    const contextParts = [];
    if (visualDescription) {
      let visualBlock = 'ANALISE VISUAL DO VIDEO (a IA assistiu os frames reais):\n' + visualDescription;
      if (visualHighlight) visualBlock += '\nMOMENTO VIRAL DETECTADO: ' + visualHighlight;
      if (detectedNiche && !niche) visualBlock += '\nNICHO DETECTADO PELA VISION: ' + detectedNiche;
      contextParts.push(visualBlock);
    }
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

    console.log('generate-from-zero:', platform, videoId || videoUrl.slice(-30), '| transcript:', transcriptText.length, '| visual:', visualDescription.length, '| ytTitle:', ytTitle.length, '| ctx:', contextParts.length);

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

    // Desfecho por nicho — SEMPRE entrega o fato, nunca promete sem entregar
    const nicheLabel = (niche || 'Geral').trim();
    const NICHE_ENDINGS = {
      'Curiosidades': 'ENTREGUE o fato surpreendente concreto: o número, o nome, o mecanismo, a causa real. Se o vídeo mostrou algo impactante, NOMEIE o que é. O fato É a surpresa — não prometa surpresa, entregue.',
      'Ciência': 'ENTREGUE a explicação científica do fenômeno em 1-2 frases. Use a palavra-chave técnica real (ex: "tensão superficial", "efeito Mpemba"). Diga O QUÊ é incrível, nunca só "é incrível".',
      'Entretenimento': 'ENTREGUE a reação, consequência ou punch line concreta. Nomeie a emoção específica ou o resultado visual exato que aparece no vídeo.',
      'Finanças': 'ENTREGUE o número real, a lição específica ou o erro exato. Se disser "mudou tudo", diga O QUE mudou e de quanto para quanto.',
      'Saúde/Fitness': 'ENTREGUE o resultado mensurável: tempo, kg, cm, consequência física real. Sem "você vai ver o resultado" — diga qual resultado.',
      'Games': 'ENTREGUE a jogada, combo, score ou momento decisivo específico. Nomeie o personagem/arma/movimento real do vídeo.',
      'Tecnologia': 'ENTREGUE a capacidade técnica concreta ou impacto prático real. Números, especificações, comparações. Sem "impressionante" solto.',
      'Outro': 'ENTREGUE o fato/imagem/consequência específica do vídeo. Proibido prometer sem entregar.',
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
      'IDIOMA DE SAÍDA OBRIGATÓRIO: ' + safeLang + ' — escreva 100% neste idioma, NÃO em português se outro idioma for pedido',
      '',
      '=== IDENTIDADE DO NARRADOR ===',
      '- Você é o narrador EXTERNO — NUNCA a pessoa do vídeo',
      '- Fala SOBRE os acontecimentos em terceira pessoa',
      '- PROIBIDO: "Eu fiz...", "Olha o que me aconteceu...", primeira pessoa',
      '',
      '=== GANCHO (primeira frase) — PADRÕES QUE RETÊM ===',
      'Escolha UM destes 4 padrões concretos (NUNCA genérico):',
      '1. DETALHE ESPECÍFICO: "Com 3 reais, ele fez o que engenheiros levaram semanas pra resolver."',
      '2. EXPECTATIVA QUEBRADA: "Todo mundo achava impossível. Aí ele colou duas garrafas."',
      '3. NÚMERO/TEMPO CHOCANTE: "Em 0,8 segundos, o piloto decidiu virar tudo."',
      '4. COMPARAÇÃO IMPOSSÍVEL: "O menor cachorro do mundo é mais leve que uma moeda."',
      '❌ PROIBIDO como gancho: "Você já se perguntou...", "Hoje vamos ver...", "Olha só isso...", "Incrível...", "Imagina...", "Preparado para..."',
      'O gancho DEVE conter um detalhe concreto específico do vídeo analisado (nome, número, objeto, ação real).',
      '',
      '=== PROIBIÇÕES DE PAYOFF VAZIO (CRÍTICO — MOTIVO DE FALHA MAIS COMUM) ===',
      '❌ NUNCA termine com promessa em aberto. Lista proibida de finais:',
      '   "vai te surpreender", "você não vai acreditar", "o resultado é incrível",',
      '   "impressionante", "chocante", "incrível", "você precisa ver", "assista até o final"',
      '❌ NUNCA prometa uma revelação sem entregá-la na mesma frase ou na próxima',
      '✅ O desfecho DEVE entregar o FATO CONCRETO: número exato, nome, mecanismo, consequência visível',
      '✅ Se o vídeo mostra algo visual impactante, o desfecho DEVE nomear esse algo específico',
      '',
      'Exemplo RUIM (payoff vazio): "E o que aconteceu depois disso vai te surpreender."',
      'Exemplo BOM (payoff concreto): "O bolo cresceu 40% mais que o normal e explodiu o forno em 3 minutos."',
      '',
      '=== REGRA DE PERGUNTAS ===',
      '✅ Pergunta permitida APENAS no gancho OU no desfecho — máximo 1 por roteiro',
      '❌ ZERO perguntas no MEIO do roteiro',
      '❌ Proibido: "Incrível, não é?", "Consegue acreditar?", "Sabe por quê?"',
      '',
      '=== ESTRUTURA NARRATIVA — 3 ATOS COM RETENÇÃO ===',
      'ATO 1 — GANCHO (1-2 frases): use um dos 4 padrões acima. Detalhe específico já na primeira frase.',
      'ATO 2 — PROGRESSÃO (3-4 frases): cada frase PLANTA uma pergunta que a próxima responde OU cria tensão que a próxima resolve.',
      '  Use viradas concretas: "Só que...", "Mas aí...", "Foi aí que...", "E quando...". ZERO perguntas aqui.',
      '  Pelo menos 1 virada inesperada no meio.',
      'ATO 3 — DESFECHO [' + nicheLabel.toUpperCase() + '] (1-2 frases): ' + nicheEnding,
      '',
      '=== CASUAL vs APELATIVO ===',
      'casual = narrador próximo e informal, ritmo respirado, como amigo contando história',
      'apelativo = narrador urgente, ritmo acelerado, frases curtas, tensão máxima',
      'AMBAS as versões seguem as regras de gancho e payoff acima — só muda o ritmo.',
      '',
      '=== REGRAS DE RITMO ===',
      '- Entre 80 e 110 palavras cada versão (narrativa precisa de espaço)',
      '- Continuidade total — cada frase conecta diretamente na próxima',
      '- Frases curtas, sem conectores fracos ("também", "além disso", "por outro lado")',
      '- Moeda: ' + cult.cur + '. Referências: ' + cult.ref,
      '- Sem emojis, sem CTA, sem markdown',
      '',
      '=== TESTE INTERNO OBRIGATÓRIO ANTES DE RESPONDER ===',
      '1. O gancho tem um detalhe específico concreto do vídeo? Se não → refazer',
      '2. O desfecho ENTREGA um fato concreto (número, nome, imagem) ou só PROMETE? Se só promete → refazer',
      '3. Existe alguma frase proibida ("vai te surpreender", "você não vai acreditar")? Se sim → refazer',
      '4. Cada frase do ato 2 planta ou resolve algo da próxima? Se não → refazer',
      '5. Narrador externo em terceira pessoa mantido? Se não → refazer',
      '6. Idioma de saída é ' + safeLang + '? Se não → refazer',
      '',
      livingMemory ? 'REFERÊNCIA DE QUALIDADE:\n' + livingMemory + '\n' : '',
      'Responda SOMENTE JSON válido:',
      '{"casual":"roteiro casual (80-110 palavras, payoff concreto)","apelativo":"roteiro apelativo (80-110 palavras, payoff concreto)","titleCasual":"título casual","titleApelativo":"título apelativo","narrative_arc":"gancho → virada → desfecho [' + nicheLabel + ']"}'
    ].join('\n');

    // ── 8. Gera via callAI multi-provider (OpenAI → Gemini → Claude) ─────────
    const SYS_MAIN = 'Você é um narrador EXTERNO de YouTube Shorts. NUNCA simule a voz das pessoas do vídeo. Fale SOBRE eles em terceira pessoa. REGRA MAIS IMPORTANTE: o desfecho SEMPRE entrega um fato concreto (número, nome, imagem específica) — NUNCA use "vai te surpreender", "incrível", "você não vai acreditar" ou qualquer promessa sem entrega. Máximo 1 pergunta por roteiro (só no gancho ou desfecho). ESCREVA NO IDIOMA PEDIDO. Responda SOMENTE JSON válido.';

    function _parseJsonResult(raw, requiredKeys) {
      let text = (raw || '').trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const si = text.indexOf('{'), ei = text.lastIndexOf('}');
      if (si < 0 || ei < 0) return null;
      try {
        const p = JSON.parse(text.slice(si, ei + 1));
        for (const k of requiredKeys) if (!p[k]) return null;
        return p;
      } catch { return null; }
    }

    let result = null;
    try {
      const { result: raw } = await callAI(prompt, SYS_MAIN, 1000, null, {
        temperature: 0.92,
        topP: 0.95,
        geminiModel: 'gemini-2.5-flash',
      });
      result = _parseJsonResult(raw, ['casual', 'apelativo']);
    } catch (e) {
      console.error('[gen-from-zero] callAI main falhou:', e.message, e.attempts ? JSON.stringify(e.attempts) : '');
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

      // Adaptação cultural via callAI multi-provider
      let adapted = null;
      try {
        const { result: rawAdapt } = await callAI(adaptPrompt, 'Adapte roteiros para ' + safeLang + '. Responda SOMENTE JSON.', 700, null, {
          temperature: 0.8,
          geminiModel: 'gemini-2.5-flash',
        });
        adapted = _parseJsonResult(rawAdapt, ['casual']);
      } catch (e) {
        console.error('[gen-from-zero] callAI adapt falhou:', e.message);
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
      lang: safeLang,
      // Vision feedback pro frontend — "O que a IA viu"
      visualDescription: visualDescription || '',
      visualHighlight: visualHighlight || '',
      detectedNiche: detectedNiche || '',
      visionProvider: visionProvider
    });

  } catch(err) {
    console.error('generate-from-zero fatal:', err.message);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
};
