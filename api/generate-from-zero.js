// api/generate-from-zero.js — CommonJS
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { videoUrl, lang, token } = req.body || {};
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

    // ── 5. Monta contexto — prioriza o que realmente acontece no video ────────
    const contextParts = [];
    if (visualDescription) contextParts.push('ANALISE VISUAL DO VIDEO:\n' + visualDescription);
    if (transcriptText) contextParts.push('AUDIO/LEGENDA DO VIDEO:\n' + transcriptText);
    // Titulo e descricao apenas como contexto de apoio, nao como base criativa
    if (!transcriptText && !visualDescription && ytDesc) contextParts.push('CONTEXTO DISPONIVEL:\n' + ytDesc);
    else if (ytTitle && (transcriptText || visualDescription)) contextParts.push('CONTEXTO ADICIONAL — Canal: ' + ytChannel);

    console.log('generate-from-zero:', videoId, '| transcript:', transcriptText.length, '| visual:', visualDescription.length, '| ytTitle:', ytTitle.length);

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

    // ── 7. Prompt viral ───────────────────────────────────────────────────────
    const prompt = [
      'FORMULA VIRAL: Ganco forte + Curiosidade crescente + Corte maximo + Payoff no menor tempo possivel',
      '',
      '== NARRADOR VIRAL ANTI-PROPAGANDA ==',
      'Crie roteiros que PRENDAM nos primeiros 2 segundos. NAO descreva friamente. Crie SENSACAO.',
      '',
      'CONTEXTO DO VIDEO (baseie-se APENAS nisso):',
      contextParts.join('\n\n'),
      '',
      livingMemory ? 'CALIBRACAO DE TOM (NAO copie):\n' + livingMemory + '\n' : '',
      'IDIOMA: ' + safeLang + ' — linguagem nativa de redes sociais.',
      '',
      'ESTRUTURA: 1.GANCO (intriga imediata, sem contexto completo) 2.PROGRESSAO ("So que…"/"Mas ai…") 3.PAYOFF (surpreende ou satisfaz)',
      'PROIBIDO: soar como propaganda, descrever friamente, mais de 75 palavras.',
      'casual = leve, conversacional | apelativo = hook chocante, tensao maxima',
      '',
      'Responda APENAS em JSON valido:',
      '{"casual":"roteiro casual","apelativo":"roteiro apelativo","titleCasual":"titulo casual","titleApelativo":"titulo apelativo"}'
    ].join('\n');

    // ── 8. Gera com OpenAI (primary) + Gemini (fallback) ─────────────────────
    let result = null;

    if (OPENAI_KEY) {
      try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI_KEY },
          body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 400, temperature: 0.85, messages: [{ role: 'user', content: prompt }] })
        });
        const d = await r.json();
        if (r.ok && d.choices && d.choices[0]) {
          let text = d.choices[0].message.content.trim().replace(/```json/g, '').replace(/```/g, '').trim();
          const si = text.indexOf('{'), ei = text.lastIndexOf('}');
          if (si >= 0 && ei >= 0) { const p = JSON.parse(text.slice(si, ei+1)); if (p.casual && p.apelativo) result = p; }
        }
      } catch(e) {}
    }

    for (let i = 0; i < GK.length && !result; i++) {
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GK[i], {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.85, maxOutputTokens: 500 } })
        });
        const d = await r.json();
        if (d.error && d.error.code === 429) continue;
        let text = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts[0] && d.candidates[0].content.parts[0].text;
        if (!text) continue;
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const si = text.indexOf('{'), ei = text.lastIndexOf('}');
        if (si >= 0 && ei >= 0) { const p = JSON.parse(text.slice(si, ei+1)); if (p.casual && p.apelativo) result = p; }
      } catch(e) { continue; }
    }

    if (!result) return res.status(503).json({ error: 'Falha ao gerar roteiros. Tente em alguns instantes.' });

    return res.status(200).json({ casual: result.casual || '', apelativo: result.apelativo || '', titleCasual: result.titleCasual || '', titleApelativo: result.titleApelativo || '' });

  } catch(err) {
    console.error('generate-from-zero fatal:', err.message);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
};
