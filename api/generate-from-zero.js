// api/generate-from-zero.js
// Analisa qualquer Short com Gemini Video API e gera roteiro narrativo original
// Disponivel para planos Full e Master

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { videoUrl, lang, token } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl obrigatorio' });

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
    } catch(e) { console.log('plan check error:', e.message); }
  }

  if (userPlan === 'free') {
    return res.status(403).json({ error: 'Recurso exclusivo para planos Full e Master.' });
  }

  const GK = [
    process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3,
    process.env.GEMINI_KEY_4, process.env.GEMINI_KEY_5, process.env.GEMINI_KEY_6,
    process.env.GEMINI_KEY_7, process.env.GEMINI_KEY_8, process.env.GEMINI_KEY_9,
    process.env.GEMINI_KEY_10,
  ].filter(Boolean);

  if (GK.length === 0) return res.status(500).json({ error: 'API nao configurada.' });

  const safeLang = lang || 'Portugues (Brasil)';

  // Busca memoria viva
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
            return 'Referencia ' + (i+1) + ': "' + (r.transcript || '').slice(0, 180) + '"';
          }).join('\n');
        }
      }
    } catch(e) {}
  }

  // ── ETAPA 1: Gemini analisa o video usando fileData (API correta para video) ──
  const descPromptText = 'Analise este Short do YouTube e descreva em ' + safeLang + ':\n' +
    '1. O que acontece visualmente (cena a cena)\n' +
    '2. Tema central e mensagem principal\n' +
    '3. Tom emocional (engracado, inspirador, chocante, educativo)\n' +
    '4. Publico-alvo provavel\n' +
    '5. O gancho visual mais forte\n\n' +
    'Seja especifico, detalhado e use o idioma ' + safeLang + '.';

  let videoDesc = '';

  for (let i = 0; i < GK.length; i++) {
    try {
      // Formato correto: fileData com YouTube URL para Gemini processar o video
      const body = {
        contents: [{
          parts: [
            {
              fileData: {
                mimeType: 'video/mp4',
                fileUri: videoUrl
              }
            },
            {
              text: descPromptText
            }
          ]
        }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 800 }
      };

      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GK[i],
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      const d = await r.json();

      if (d.error) {
        console.log('Gemini desc error key', i, ':', d.error.code, d.error.message);
        if (d.error.code === 429) continue;
        // Se fileData nao funcionar, tenta com texto simples
        if (d.error.code === 400 || d.error.code === 500) {
          const r2 = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GK[i],
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: 'Sobre o video ' + videoUrl + ': ' + descPromptText }] }],
                generationConfig: { temperature: 0.3, maxOutputTokens: 800 }
              })
            }
          );
          const d2 = await r2.json();
          if (!d2.error) {
            const t2 = d2.candidates && d2.candidates[0] && d2.candidates[0].content &&
              d2.candidates[0].content.parts && d2.candidates[0].content.parts[0] &&
              d2.candidates[0].content.parts[0].text;
            if (t2 && t2.trim().length > 50) { videoDesc = t2.trim(); break; }
          }
        }
        continue;
      }

      const text = d.candidates && d.candidates[0] && d.candidates[0].content &&
        d.candidates[0].content.parts && d.candidates[0].content.parts[0] &&
        d.candidates[0].content.parts[0].text;
      if (text && text.trim().length > 50) { videoDesc = text.trim(); break; }
    } catch(e) { console.log('Gemini desc exception:', e.message); continue; }
  }

  if (!videoDesc) {
    return res.status(503).json({ error: 'Nao foi possivel analisar o video. Verifique se o link e publico e tente novamente.' });
  }

  // ── ETAPA 2: Gera roteiros originais ──────────────────────────────────────
  const genPromptLines = [
    'Voce e um especialista em roteiros virais para YouTube Shorts.',
    '',
    'ANALISE DO VIDEO:',
    videoDesc,
    '',
  ];
  if (livingMemory) {
    genPromptLines.push('CALIBRACAO DE TOM (nao copie, use como referencia de ritmo e estilo):');
    genPromptLines.push(livingMemory);
    genPromptLines.push('');
  }
  genPromptLines.push('IDIOMA: ' + safeLang);
  genPromptLines.push('');
  genPromptLines.push('Crie 2 roteiros ORIGINAIS baseados no tema/contexto do video — NAO copie o original.');
  genPromptLines.push('- Maximo 75 palavras cada');
  genPromptLines.push('- Linguagem nativa, tom de Short viral');
  genPromptLines.push('- Texto corrido, sem emojis, sem marcadores');
  genPromptLines.push('');
  genPromptLines.push('Responda APENAS em JSON valido sem markdown:');
  genPromptLines.push('{"casual":"roteiro casual aqui","apelativo":"roteiro apelativo aqui","titleCasual":"titulo casual","titleApelativo":"titulo apelativo"}');

  const genPrompt = genPromptLines.join('\n');

  let result = null;
  for (let i = 0; i < GK.length; i++) {
    try {
      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GK[i],
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: genPrompt }] }],
            generationConfig: { temperature: 0.85, maxOutputTokens: 600 }
          })
        }
      );
      const d = await r.json();
      if (d.error && d.error.code === 429) continue;
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
    } catch(e) { continue; }
  }

  if (!result) return res.status(503).json({ error: 'Falha ao gerar roteiros. Tente novamente.' });

  return res.status(200).json({
    casual: result.casual || '',
    apelativo: result.apelativo || '',
    titleCasual: result.titleCasual || '',
    titleApelativo: result.titleApelativo || ''
  });
}
