// api/rewrite.js — BlueTube Viral Script Agent v10
// Super Prompt literal + Supabase real viral examples as living memory
// Primary: OpenAI GPT-4o mini | Fallback: Gemini rotation

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { applyRateLimit } = require('./helpers/rate-limit.js');
const { cacheKey, getCache, setCache } = require('./helpers/cache.js');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit
  if (await applyRateLimit(req, res)) return;

  const { transcript, lang, version, adjust } = req.body;
  if (!transcript || !lang) return res.status(400).json({ error: 'Transcrição e idioma são obrigatórios.' });

  // Validate input length
  const cleanTranscript = (typeof transcript === 'string' ? transcript : '').replace(/<[^>]*>/g, '').trim();
  if (cleanTranscript.length > 5000) return res.status(400).json({ error: 'Transcrição excede o limite de 5000 caracteres.' });

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

  // ── ADAPTAÇÃO CULTURAL COMPLETA POR IDIOMA ──────────────────────────────────
  const CULTURAL_PROFILE = {
    'Português (Brasil)': {
      rule: 'Português Brasileiro natural e cotidiano. Use expressões brasileiras reais, gírias leves e anglicismos comuns. Nunca soe como tradução.',
      currency: 'Reais (R$)',
      adapt: 'Converta moedas estrangeiras para Reais. Use referências brasileiras: futebol brasileiro, BBB, celebridades BR. Troque milhas por km. Substitua expressões idiomáticas estrangeiras por equivalentes brasileiros naturais (ex: "hit the nail" → "acertou na mosca"). Adapte comidas, feriados e costumes para o contexto brasileiro.'
    },
    'English': {
      rule: 'Natural American English. Use real slang (no cap, lowkey, vibe), casual contractions and social media language. Never sound translated or robotic.',
      currency: 'Dollars ($)',
      adapt: 'Convert foreign currencies to USD. Use American cultural references: NFL, NBA, Hollywood, American celebrities. Keep miles. Replace foreign idioms with American equivalents (ex: "acertar na mosca" → "hit the nail on the head"). Adapt foods, holidays and customs to American context.'
    },
    'Español': {
      rule: 'Español natural y cotidiano de redes sociales. Usa expresiones idiomáticas reales y anglicismos comunes. Nunca suenes traducido.',
      currency: 'Use "dinero" genéricamente o adapta por contexto (pesos, euros, dólares)',
      adapt: 'Convierte monedas extranjeras a términos que un hispanohablante entienda. Usa referencias culturales latinas/hispanas. Reemplaza expresiones idiomáticas extranjeras por equivalentes en español (ex: "acertar na mosca" → "dar en el clavo"). Adapta comidas, costumbres y referencias culturales al mundo hispano.'
    },
    'Français': {
      rule: 'Français naturel et quotidien des réseaux sociaux. Utilise de vraies expressions idiomatiques. Ne sonne jamais traduit.',
      currency: 'Euros (€)',
      adapt: 'Convertis les devises étrangères en euros. Utilise des références culturelles françaises. Remplace les expressions idiomatiques étrangères par des équivalents français naturels. Adapte la nourriture, les fêtes et les coutumes au contexte français.'
    },
    'Deutsch': {
      rule: 'Natürliches, alltägliches Deutsch der sozialen Medien. Verwende echte Redewendungen und Anglizismen. Klinge niemals übersetzt.',
      currency: 'Euro (€)',
      adapt: 'Wandle Fremdwährungen in Euro um. Verwende deutsche Kulturverweise. Ersetze fremdsprachige Redewendungen durch natürliche deutsche Entsprechungen. Passe Essen, Feiertage und Bräuche an den deutschen Kontext an.'
    },
    'Italiano': {
      rule: 'Italiano naturale e quotidiano dei social media. Usa vere espressioni idiomatiche. Non sembrare mai tradotto.',
      currency: 'Euro (€)',
      adapt: 'Converti le valute straniere in euro. Usa riferimenti culturali italiani. Sostituisci le espressioni idiomatiche straniere con equivalenti italiani naturali. Adatta cibo, festività e usanze al contesto italiano.'
    },
    '日本語': {
      rule: '自然な日常的な日本語。本物の慣用表現とSNS言語を使用。絶対に翻訳のように聞こえてはならない。',
      currency: '円 (¥)',
      adapt: '外国通貨を円に変換。日本の文化的参照を使用。外国の慣用句を自然な日本語の同等物に置き換え。食べ物、祝日、習慣を日本の文脈に適応させる。'
    },
    '中文': {
      rule: '自然的日常中文社交媒体语言。使用真实成语和常见外来词。绝对不要听起来像翻译。',
      currency: '人民币 (¥)',
      adapt: '将外币转换为人民币。使用中国文化参考。将外国习语替换为自然的中文等价物。将食物、节日和习俗适配到中国语境。'
    },
    'العربية': {
      rule: 'العربية الطبيعية اليومية لوسائل التواصل الاجتماعي. استخدم التعابير الحقيقية. لا تبدو مترجماً أبداً.',
      currency: 'استخدم العملة المحلية المناسبة',
      adapt: 'حوّل العملات الأجنبية إلى ما يفهمه الجمهور العربي. استخدم مراجع ثقافية عربية. استبدل التعابير الأجنبية بمكافئات عربية طبيعية. كيّف الطعام والأعياد والعادات للسياق العربي.'
    }
  };

  const profile = CULTURAL_PROFILE[lang] || CULTURAL_PROFILE['English'];
  const nativeRule = profile.rule;
  const culturalAdaptation = `
ADAPTAÇÃO CULTURAL OBRIGATÓRIA:
- Moeda padrão: ${profile.currency}
- ${profile.adapt}
- NUNCA deixe moedas estrangeiras (Rúpias, Rupees, etc.) — converta para ${profile.currency}
- NUNCA deixe referências culturais incompatíveis — substitua por equivalentes locais
- Expressões idiomáticas: NUNCA traduza literalmente — use o equivalente nativo
- O resultado deve parecer escrito ORIGINALMENTE por um criador nativo de ${lang}`;

  // ── ANGLE ──────────────────────────────────────────────────────────────────
  const ANGLE = version === 'V2'
    ? 'ESTILO APELATIVO/URGENTE: gancho chocante que para o scroll em 2 segundos, tensão crescente, call-to-action poderoso no final. Afirmações ousadas, números impactantes, perguntas que incomodam.'
    : 'ESTILO CASUAL/CONVERSACIONAL: gancho curioso e suave, desenvolvimento como conversa entre amigos, fechamento com convite genuíno. Tom leve, próximo, sem pressão.';

  // ── SUPER PROMPT — ADAPTADOR CULTURAL ELITE + ROTEIRISTA VIRAL ─────────────
  const systemPrompt = `Você é um ADAPTADOR CULTURAL ELITE e roteirista viral profissional. Sua missão não é traduzir — é RECRIAR o roteiro como se tivesse sido escrito originalmente por um criador de conteúdo nativo de ${lang}.

🎯 OBJETIVO
Transformar qualquer texto em um roteiro:
- Mais curto, mais rápido, mais envolvente
- Pronto para narração em voz alta
- Máximo 75 palavras
- Culturalmente adaptado para ${lang}

⚙️ REGRAS CRÍTICAS
1. Tempo é prioridade absoluta — máximo 75 palavras
2. Corte agressivo — remova redundância, explicação óbvia, palavras fracas
3. Adaptação nativa — ${nativeRule}
4. Ritmo de retenção — frases curtas, sem travas, leitura fluida
5. Estrutura: Gancho (2s) → Desenvolvimento rápido → Clímax/Fechamento forte

${culturalAdaptation}

🧠 TESTE DE QUALIDADE antes de responder:
1. Um nativo de ${lang} perceberia que é tradução? Se sim, refaça.
2. Existe moeda, medida ou referência cultural estrangeira? Converta.
3. Alguma expressão idiomática foi traduzida literalmente? Use o equivalente nativo.
4. Funciona lido em voz alta? Ajuste o ritmo se necessário.
5. Parece escrito originalmente em ${lang}? Se não, refaça.

🚫 PROIBIDO
- Tradução literal
- Manter moedas/medidas/referências estrangeiras
- Aumentar o texto ou ultrapassar 75 palavras
- Soar como tradução automática
- Emojis, títulos ou explicações

✅ FORMATO DE SAÍDA
- Texto único em parágrafo corrido, sem emojis, sem títulos
- Termine com ponto final
- Máximo 75 palavras
${livingMemory ? `\nREFERÊNCIA DE QUALIDADE:\n${livingMemory}` : ''}
IDIOMA DE SAÍDA: ${lang}
${ANGLE}`;

  const userPrompt = adjust
    ? `ROTEIRO ATUAL:
"${transcript.slice(0, 3000)}"

AJUSTE PEDIDO PELO USUÁRIO: "${adjust.slice(0, 500)}"

Aplique o ajuste mantendo: gancho forte, curiosidade crescente, corte máximo, payoff. Retorne APENAS o roteiro ajustado, sem explicações.`
    : `TRANSCRIÇÃO ORIGINAL:
"${transcript.slice(0, 3000)}"

Escreva o roteiro agora. Apenas o texto final, nada mais.`;

  // ── CACHE — skip AI calls if same request was recently generated ──────────
  if (!adjust) {
    const ck = cacheKey(['rewrite', cleanTranscript.slice(0, 200), lang, version || 'V1']);
    const cached = await getCache(ck, process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    if (cached) return res.status(200).json(cached);
  }

  // ── PRIMARY: OPENAI GPT-4o mini ───────────────────────────────────────────
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (OPENAI_KEY) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
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
        }),
        signal: controller.signal
      });
      clearTimeout(timer);

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
        const result = { text, engine: 'openai' };
        if (!adjust) {
          const ck = cacheKey(['rewrite', cleanTranscript.slice(0, 200), lang, version || 'V1']);
          setCache(ck, result, 1, process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY).catch(() => {});
        }
        return res.status(200).json(result);
      }
      console.log('OpenAI failed:', data.error?.message);
    } catch (err) {
      console.log('OpenAI error:', err.name === 'AbortError' ? 'timeout' : err.message);
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
      const gc = new AbortController();
      const gt = setTimeout(() => gc.abort(), 30000);
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: fullPrompt }] }],
            generationConfig: { temperature: 0.85, maxOutputTokens: 600, topP: 0.95 }
          }),
          signal: gc.signal
        }
      );
      clearTimeout(gt);
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
      const result = { text, engine: 'gemini' };
      if (!adjust) {
        const ck2 = cacheKey(['rewrite', cleanTranscript.slice(0, 200), lang, version || 'V1']);
        setCache(ck2, result, 1, process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY).catch(() => {});
      }
      return res.status(200).json(result);
    } catch (e) { continue; }
  }

  res.setHeader('Retry-After', '60');
  return res.status(429).json({
    error: 'Nossos servidores estão sobrecarregados. Tente novamente em 1 minuto.',
    retry_after: 60
  });
}
