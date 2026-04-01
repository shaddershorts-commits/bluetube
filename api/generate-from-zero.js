// api/generate-from-zero.js
// Analisa qualquer Short com Gemini Vision e gera roteiro narrativo original
// Disponível para planos Full e Master

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

  // Verifica plano (Full ou Master)
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
    } catch(e) {
      console.log('plan check error:', e.message);
    }
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

  // Busca memoria viva — top roteiros copiados como referencia de tom
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
          livingMemory = 'REFERENCIA DE TOM (nao copie, use para calibrar estilo e ritmo):\n' +
            rows.map(function(r, i) {
              return 'Ex' + (i+1) + ': "' + (r.transcript || '').slice(0, 200) + '"';
            }).join('\n');
        }
      }
    } catch(e) {}
  }

  const safeLang = lang || 'Portugues (Brasil)';

  // Etapa 1: Gemini analisa o video
  const descParts = [
    'Analise este video do YouTube: ' + videoUrl,
    'Descreva em ' + safeLang + ':',
    '1. O que acontece visualmente (cena a cena)',
    '2. Tema central e mensagem',
    '3. Tom emocional (engracado, inspirador, chocante, educativo)',
    '4. Publico-alvo',
    '5. Gancho visual mais forte',
    'Seja especifico e detalhado.'
  ];
  const descPrompt = descParts.join('\n');

  let videoDesc = '';
  for (let i = 0; i < GK.length; i++) {
    try {
      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GK[i],
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: descPrompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 800 }
          })
        }
      );
      const d = await r.json();
      if (d.error && d.error.code === 429) continue;
      const text = d.candidates && d.candidates[0] && d.candidates[0].content &&
        d.candidates[0].content.parts && d.candidates[0].content.parts[0] &&
        d.candidates[0].content.parts[0].text;
      if (text && text.trim().length > 50) {
        videoDesc = text.trim();
        break;
      }
    } catch(e) { continue; }
  }

  if (!videoDesc) {
    return res.status(503).json({ error: 'Nao foi possivel analisar o video. Tente novamente.' });
  }

  // Etapa 2: Gera roteiros originais com base na analise
  const genParts = [
    'Voce e um especialista em roteiros virais para YouTube Shorts.',
    '',
    'ANALISE DO VIDEO:',
    videoDesc,
    '',
    livingMemory ? livingMemory + '\n' : '',
    'IDIOMA: ' + safeLang,
    '',
    'REGRAS:',
    '- Crie roteiros ORIGINAIS baseados no tema do video',
    '- NAO copie ou adapte o video original',
    '- Maximo 75 palavras cada',
    '- Linguagem nativa de redes sociais',
    '- Texto corrido, sem emojis, sem titulos, sem marcadores',
    '',
    'Responda APENAS em JSON valido sem markdown:',
    '{"casual":"roteiro casual aqui","apelativo":"roteiro apelativo aqui","titleCasual":"titulo casual","titleApelativo":"titulo apelativo"}'
  ];
  const genPrompt = genParts.join('\n');

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
        if (parsed.casual && parsed.apelativo) {
          result = parsed;
          break;
        }
      }
    } catch(e) { continue; }
  }

  if (!result) {
    return res.status(503).json({ error: 'Falha ao gerar roteiros. Tente novamente.' });
  }

  return res.status(200).json({
    casual: result.casual || '',
    apelativo: result.apelativo || '',
    titleCasual: result.titleCasual || '',
    titleApelativo: result.titleApelativo || ''
  });
}
