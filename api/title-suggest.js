// api/title-suggest.js — Sugere títulos virais para shorts
const { applyRateLimit } = require('./helpers/rate-limit.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (await applyRateLimit(req, res)) return;

  const { transcript, lang, originalTitle } = req.body || {};
  if (!transcript || typeof transcript !== 'string' || transcript.trim().length < 10) return res.status(400).json({ error: 'Transcrição muito curta.' });
  if (transcript.length > 5000) return res.status(400).json({ error: 'Transcrição excede o limite.' });

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const GK = [
    process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3,
    process.env.GEMINI_KEY_4, process.env.GEMINI_KEY_5, process.env.GEMINI_KEY_6,
    process.env.GEMINI_KEY_7, process.env.GEMINI_KEY_8, process.env.GEMINI_KEY_9,
    process.env.GEMINI_KEY_10,
  ].filter(Boolean).sort(() => Math.random() - 0.5);

  const safeLang = lang || 'Português (Brasil)';
  const prompt = `Baseado nesta transcrição de vídeo curto, gere 2 sugestões de título viral.

TRANSCRIÇÃO:
"${transcript.trim().slice(0, 600)}"
${originalTitle ? `\nTÍTULO ORIGINAL: "${originalTitle}"` : ''}

REGRAS:
- Idioma: ${safeLang}
- Títulos curtos (máx 60 caracteres cada)
- Linguagem nativa de redes sociais
- Gere curiosidade e vontade de clicar
- casual = título leve e natural
- apelativo = título mais forte e urgente
- Sem emojis
- Sem aspas no texto

Responda SOMENTE com JSON válido, sem markdown:
{"casual":"título casual aqui","apelativo":"título apelativo aqui"}`;

  let result = null;

  // OpenAI primary
  if (OPENAI_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI_KEY },
        body: JSON.stringify({
          model: 'gpt-4o-mini', max_tokens: 150, temperature: 0.85,
          messages: [
            { role: 'system', content: 'Você gera títulos virais curtos. Responda apenas JSON.' },
            { role: 'user', content: prompt }
          ]
        })
      });
      const d = await r.json();
      if (r.ok && d.choices?.[0]?.message?.content) {
        let text = d.choices[0].message.content.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const si = text.indexOf('{'), ei = text.lastIndexOf('}');
        if (si >= 0 && ei >= 0) {
          const p = JSON.parse(text.slice(si, ei + 1));
          if (p.casual && p.apelativo) result = p;
        }
      }
    } catch(e) { console.error('title-suggest openai:', e.message); }
  }

  // Gemini fallback
  for (let i = 0; i < GK.length && !result; i++) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GK[i], {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.85, maxOutputTokens: 200 } })
      });
      const d = await r.json();
      if (d.error && (d.error.code === 429 || d.error.code === 503)) continue;
      if (!r.ok) continue;
      let text = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
      if (!text) continue;
      text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const si = text.indexOf('{'), ei = text.lastIndexOf('}');
      if (si >= 0 && ei >= 0) {
        const p = JSON.parse(text.slice(si, ei + 1));
        if (p.casual && p.apelativo) result = p;
      }
    } catch(e) { continue; }
  }

  if (!result) return res.status(503).json({ error: 'Não foi possível gerar títulos.' });
  return res.status(200).json(result);
};
