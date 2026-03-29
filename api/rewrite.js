// api/rewrite.js — BlueTube Viral Script Agent v10
// Super Prompt literal + Supabase real viral examples as living memory
// Primary: OpenAI GPT-4o mini | Fallback: Gemini rotation

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { transcript, lang, version } = req.body;
  if (!transcript || !lang) return res.status(400).json({ error: 'Missing fields' });

  // ── SUPABASE: LIVING MEMORY — real viral examples from real users ──────────
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  let livingMemory = '';
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/viral_shorts?order=copy_count.desc&limit=5&select=transcript,copy_count&copy_count=gte.1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      if (r.ok) {
        const rows = await r.json();
        if (rows?.length > 0) {
          livingMemory = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧠 MEMÓRIA VIVA — ROTEIROS QUE JÁ PROVARAM FUNCIONAR
Estes são roteiros reais que usuários copiaram e usaram.
Eles representam o padrão de qualidade que você deve superar a cada geração.
Analise o que eles têm em comum: ritmo, gancho, corte, naturalidade.
Use como referência evolutiva — cada novo roteiro deve ser melhor que estes.

${rows.map((row, i) =>
  `📌 Exemplo ${i+1} (aprovado por ${row.copy_count} usuário${row.copy_count > 1 ? 's' : ''}):\n"${row.transcript.slice(0, 350)}"`
).join('\n\n')}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
        }
      }
    } catch (e) { /* non-blocking */ }
  }

  // ── NATIVE LANGUAGE RULE ───────────────────────────────────────────────────
  const LANG_NATIVE = {
    'Português (Brasil)': 'Português Brasileiro natural e cotidiano. Use expressões brasileiras reais, gírias leves e anglicismos comuns. Nunca soe como tradução.',
    'English': 'Natural American English. Use real slang (no cap, lowkey, vibe), casual contractions and social media language. Never sound translated or robotic.',
    'Español': 'Español natural y cotidiano de redes sociales. Usa expresiones idiomáticas reales y anglicismos comunes. Nunca suenes traducido.',
    'Français': 'Français naturel et quotidien des réseaux sociaux. Utilise de vraies expressions idiomatiques. Ne sonne jamais traduit.',
    'Deutsch': 'Natürliches, alltägliches Deutsch der sozialen Medien. Verwende echte Redewendungen und Anglizismen. Klinge niemals übersetzt.',
    'Italiano': 'Italiano naturale e quotidiano dei social media. Usa vere espressioni idiomatiche. Non sembrare mai tradotto.',
    '日本語': '自然な日常的な日本語。本物の慣用表現とSNS言語を使用。絶対に翻訳のように聞こえてはならない。',
    '中文': '自然的日常中文社交媒体语言。使用真实成语和常见外来词。绝对不要听起来像翻译。',
    'العربية': 'العربية الطبيعية اليومية لوسائل التواصل الاجتماعي. استخدم التعابير الحقيقية. لا تبدو مترجماً أبداً.'
  };

  const nativeRule = LANG_NATIVE[lang] || LANG_NATIVE['English'];

  // ── ANGLE ──────────────────────────────────────────────────────────────────
  const ANGLE = version === 'V2'
    ? 'ESTILO APELATIVO/URGENTE: gancho chocante que para o scroll em 2 segundos, tensão crescente, call-to-action poderoso no final. Afirmações ousadas, números impactantes, perguntas que incomodam.'
    : 'ESTILO CASUAL/CONVERSACIONAL: gancho curioso e suave, desenvolvimento como conversa entre amigos, fechamento com convite genuíno. Tom leve, próximo, sem pressão.';

  // ── SUPER PROMPT (literal do usuário) + LIVING MEMORY ─────────────────────
  const systemPrompt = `Você é um especialista em tradução e adaptação de roteiros virais (Shorts, Reels, TikTok) com foco em:
- Retenção máxima
- Tempo igual ou menor que o original
- Linguagem completamente nativa
- Performance crescente a cada execução

🎯 OBJETIVO
Transformar qualquer texto em um roteiro:
- Mais curto
- Mais rápido
- Mais envolvente
- Pronto para narração
- Máximo 75 palavras

⚙️ REGRAS CRÍTICAS
1. Tempo é prioridade absoluta
   - Sempre reduzir palavras
   - Nunca ultrapassar o tempo original
   - Máximo absoluto: 75 palavras

2. Corte agressivo
   - Remova tudo que não impacta:
     - redundância
     - explicação óbvia
     - palavras fracas

3. Adaptação nativa
   - ${nativeRule}
   - Nunca traduza literalmente

4. Ritmo de retenção
   - Frases curtas
   - Sem travas
   - Leitura fluida

5. Estrutura obrigatória
   - Gancho (2 segundos) → Desenvolvimento rápido → Clímax/Fechamento forte

🧠 SISTEMA DE AUTO-OTIMIZAÇÃO
A cada novo roteiro gerado, analise internamente:
- Onde o texto pode ficar mais curto sem perder impacto
- Onde pode ganhar mais força emocional
- Onde pode aumentar a retenção

Aprenda padrões:
- Identifique palavras que podem ser sempre removidas
- Identifique estruturas mais rápidas e naturais
- Evolua continuamente: o próximo roteiro deve ser mais direto, mais fluido e mais eficiente

📈 REGRAS DE EVOLUÇÃO
- Evite repetir estruturas fracas
- Substitua frases longas por versões mais curtas automaticamente
- Priorize sempre: menos palavras + mais impacto

🚫 PROIBIDO
- Aumentar o texto
- Enrolar
- Explicar demais
- Repetir padrões ineficientes
- Traduzir literalmente
- Ultrapassar 75 palavras

✅ FORMATO DE SAÍDA
- Texto único em parágrafo corrido
- Sem emojis
- Sem títulos ou explicações
- Termine sempre com ponto final
- Máximo 75 palavras

📏 REGRA FINAL
Cada resposta deve ser:
- Mais curta que qualquer versão anterior
- Mais rápida de ler
- Mais natural
- Mais forte em retenção

🔁 INSTRUÇÃO FINAL
Você está em constante evolução.
Cada roteiro gerado deve ser melhor que o anterior, mesmo sem feedback explícito.
${livingMemory ? `\nUse os exemplos da memória viva abaixo como referência do padrão atual — e supere-os.\n${livingMemory}` : ''}
IDIOMA DE SAÍDA: ${lang}
${ANGLE}`;

  const userPrompt = `TRANSCRIÇÃO ORIGINAL:
"${transcript.slice(0, 3000)}"

Escreva o roteiro agora. Apenas o texto final, nada mais.`;

  // ── PRIMARY: OPENAI GPT-4o mini ───────────────────────────────────────────
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (OPENAI_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 250,
          temperature: 0.85
        })
      });

      const data = await r.json();
      if (r.ok && data.choices?.[0]?.message?.content) {
        let text = data.choices[0].message.content.trim();
        text = text
          .replace(/^#+\s.*/gm, '')
          .replace(/\*\*(.*?)\*\*/g, '$1')
          .replace(/\*(.*?)\*/g, '$1')
          .replace(/^\s*[-•]\s/gm, '')
          .replace(/\n{2,}/g, ' ')
          .trim();
        return res.status(200).json({ text, engine: 'openai' });
      }
      console.log('OpenAI failed:', data.error?.message);
    } catch (err) {
      console.log('OpenAI error:', err.message);
    }
  }

  // ── FALLBACK: GEMINI with key rotation ───────────────────────────────────
  const GEMINI_KEYS = [
    process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3,
    process.env.GEMINI_KEY_4, process.env.GEMINI_KEY_5, process.env.GEMINI_KEY_6,
    process.env.GEMINI_KEY_7, process.env.GEMINI_KEY_8, process.env.GEMINI_KEY_9,
    process.env.GEMINI_KEY_10,
  ].filter(Boolean);

  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
  const shuffledKeys = [...GEMINI_KEYS].sort(() => Math.random() - 0.5);

  for (const key of shuffledKeys) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: fullPrompt }] }],
            generationConfig: { temperature: 0.85, maxOutputTokens: 600, topP: 0.95 }
          })
        }
      );
      const data = await r.json();
      if (r.status === 429 || data.error?.code === 429) continue;
      if (!r.ok) continue;
      let text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
      if (!text) continue;
      text = text
        .replace(/^#+\s.*/gm, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/^\s*[-•]\s/gm, '')
        .replace(/\n{2,}/g, ' ')
        .trim();
      return res.status(200).json({ text, engine: 'gemini' });
    } catch (e) { continue; }
  }

  return res.status(429).json({
    error: 'Serviço temporariamente indisponível. Tente novamente em alguns instantes.'
  });
}
