// api/rewrite.js — BlueTube Viral Script Agent v6
// Rotates through 6 Gemini API keys automatically.
// When one hits rate limit, switches to next key instantly.
// 6 keys × 20 requests/day = 120 free scripts/day.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { transcript, lang, version } = req.body;
  if (!transcript || !lang) return res.status(400).json({ error: 'Missing fields' });

  // ── COLLECT ALL AVAILABLE KEYS ────────────────────────────────────────────
  const KEYS = [
    process.env.GEMINI_KEY_1,
    process.env.GEMINI_KEY_2,
    process.env.GEMINI_KEY_3,
    process.env.GEMINI_KEY_4,
    process.env.GEMINI_KEY_5,
    process.env.GEMINI_KEY_6,
    process.env.GEMINI_KEY_7,
    process.env.GEMINI_KEY_8,
    process.env.GEMINI_KEY_9,
    process.env.GEMINI_KEY_10,
  ].filter(Boolean); // ignore undefined keys

  if (KEYS.length === 0) {
    return res.status(500).json({ error: 'No Gemini API keys configured' });
  }

  // ── SUPABASE VIRAL CONTEXT ────────────────────────────────────────────────
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  let viralContext = '';

  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/viral_shorts?order=copy_count.desc&limit=5&select=transcript,copy_count&copy_count=gte.1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      if (r.ok) {
        const rows = await r.json();
        if (rows?.length > 0) {
          viralContext = `\nEXEMPLOS REAIS DE SHORTS VIRAIS (referência — mais copiados pelos usuários):
${rows.map((row, i) => `Exemplo ${i+1} (copiado ${row.copy_count}x): "${row.transcript.slice(0, 300)}..."`).join('\n')}
Identifique o padrão viral desses exemplos e aplique ao novo roteiro.\n`;
        }
      }
    } catch (e) { /* non-blocking */ }
  }

  // ── ANGLE PER VERSION ──────────────────────────────────────────────────────
  const ANGLE = version === 'V2'
    ? `ÂNGULO — APELATIVO/URGENTE:
Tom agressivo, urgente, provocativo. Máximo impacto desde a primeira palavra.
- Gancho: OBRIGATÓRIO ser chocante, polêmico ou criar FOMO imediato — para o scroll em 2 segundos
- Desenvolvimento: ritmo acelerado, frases curtas, cada frase aumenta a tensão
- Fechamento: call-to-action poderoso que provoca reação imediata
- Use: verbos de ação, números impactantes, perguntas que incomodam, afirmações ousadas`
    : `ÂNGULO — CASUAL/CONVERSACIONAL:
Tom leve, próximo, como conversa entre amigos.
- Gancho: desperta curiosidade de forma suave, sem pressão
- Desenvolvimento: fluido, natural, linguagem do dia a dia e contrações
- Fechamento: convite genuíno, sem forçar
- Evite: urgência excessiva, linguagem de vendas, exageros`;

  // ── MASTER PROMPT ──────────────────────────────────────────────────────────
  const prompt = `Você é um especialista nativo em criação, adaptação e otimização de roteiros curtos para YouTube Shorts, TikTok e Reels, com foco extremo em retenção, naturalidade e impacto emocional.

Sua função é transformar qualquer texto enviado em uma versão mais viral, mais natural e mais envolvente, como se tivesse sido criado originalmente por um roteirista profissional de conteúdo curto.

OBJETIVO PRINCIPAL — Criar roteiros que:
- Prendam atenção nos primeiros 2 segundos
- Tenham ritmo rápido e fluido
- Soem 100% naturais (zero cara de texto traduzido ou robótico)
- Sejam fáceis de narrar
- Funcionem para público jovem com baixa retenção de atenção

REGRAS OBRIGATÓRIAS:
1. NUNCA traduza ou adapte de forma literal — sempre priorize naturalidade e impacto
2. Sempre escreva em PARÁGRAFO ÚNICO — nunca use listas, tópicos ou quebras de linha
3. Remova timestamps, marcações e informações desnecessárias
4. Linguagem: conversacional, moderna, fluida para narração, parecendo fala humana real
5. Aumente levemente o impacto emocional ou curiosidade sempre que possível

ESTRUTURA MENTAL OBRIGATÓRIA:
Gancho → Desenvolvimento rápido → Momento mais interessante → Fechamento forte

ESTILO:
Use: curiosidade, suspense leve, sensação de descoberta, storytelling rápido
Evite: formalidade, explicações técnicas, frases longas, repetições

OTIMIZAÇÃO PARA VÍDEO CURTO:
- Funciona bem narrado em voz alta
- Flui sem travar
- Fácil de entender ouvindo uma única vez

AJUSTES AUTOMÁTICOS:
- Texto longo → Resuma mantendo impacto
- Texto confuso → Simplifique
- Texto sem emoção → Intensifique
- Texto muito técnico → Humanize

FORMATO DE ENTREGA — CRÍTICO:
- Entregue APENAS o texto do roteiro final
- NUNCA explique o que fez, NUNCA use títulos ou marcações
- O roteiro deve ter exatamente entre 60 e 90 palavras — escreva de forma concisa
- OBRIGATÓRIO: termine sempre com ponto final. Nunca corte no meio de uma frase
- Um único parágrafo corrido, sem quebras de linha, pronto para narrar do início ao fim

IDIOMA: ${lang} — escreva como nativo, não como tradução.
${viralContext}
${ANGLE}

TRANSCRIÇÃO ORIGINAL:
"${transcript.slice(0, 3000)}"

Escreva o roteiro agora. Apenas o texto, nada mais.`;

  // ── KEY ROTATION WITH AUTO-RETRY ──────────────────────────────────────────
  // Try each key in order. If one hits rate limit (429), move to next immediately.
  // Shuffles order each request to distribute load evenly across keys.
  const shuffledKeys = [...KEYS].sort(() => Math.random() - 0.5);

  for (let i = 0; i < shuffledKeys.length; i++) {
    const key = shuffledKeys[i];
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.9, maxOutputTokens: 500, topP: 0.95 }
          })
        }
      );

      const data = await r.json();

      // Rate limit on this key → try next key immediately
      if (r.status === 429 || data.error?.code === 429) {
        console.log(`Key ${i+1} rate limited, trying next...`);
        continue;
      }

      if (!r.ok) {
        console.log(`Key ${i+1} error ${r.status}, trying next...`);
        continue;
      }

      let text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';

      if (!text) {
        console.log(`Key ${i+1} returned empty, trying next...`);
        continue;
      }

      // Clean stray markdown
      text = text
        .replace(/^#+\s.*/gm, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/^\s*[-•]\s/gm, '')
        .replace(/\n{2,}/g, ' ')
        .trim();

      return res.status(200).json({ text, keyUsed: i + 1 });

    } catch (err) {
      console.log(`Key ${i+1} threw error, trying next:`, err.message);
      continue;
    }
  }

  // All keys exhausted
  return res.status(429).json({
    error: 'Limite diário atingido em todas as contas. Tente novamente amanhã ou entre em contato com o suporte.'
  });
}
