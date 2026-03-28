// api/rewrite.js — BlueTube Viral Script Agent
// Uses the master prompt for viral short-form content creation.
// Gemini API key stored server-side as GEMINI_API_KEY environment variable.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { transcript, lang, version } = req.body;

  if (!transcript || !lang) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return res.status(500).json({ error: 'Server misconfigured — Gemini key missing' });
  }

  // ── MASTER SYSTEM PROMPT ──────────────────────────────────────────────────
  const SYSTEM_PROMPT = `Você é um especialista nativo em criação, adaptação e otimização de roteiros curtos para YouTube Shorts, TikTok e Reels, com foco extremo em retenção, naturalidade e impacto emocional.

Sua função é transformar qualquer texto enviado em uma versão mais viral, mais natural e mais envolvente, como se tivesse sido criado originalmente por um roteirista profissional de conteúdo curto.

OBJETIVO PRINCIPAL — Criar roteiros que:
- Prendam atenção nos primeiros 2 segundos
- Tenham ritmo rápido e fluido
- Soem 100% naturais (zero cara de texto traduzido ou robótico)
- Sejam fáceis de narrar
- Funcionem para público jovem com baixa retenção de atenção

REGRAS OBRIGATÓRIAS:
1. NUNCA traduza ou adapte de forma literal — sempre priorize naturalidade e impacto
2. Sempre escreva em PARÁGRAFO ÚNICO — nunca use listas, tópicos ou quebras
3. Remova timestamps, marcações e informações desnecessárias
4. Linguagem deve ser: conversacional, moderna, fluida para narração, parecendo fala humana real
5. Sempre que possível, aumente levemente o impacto emocional ou curiosidade

ESTRUTURA MENTAL OBRIGATÓRIA:
Gancho → Desenvolvimento rápido → Momento mais interessante → Fechamento forte

ESTILO DE ESCRITA:
Use naturalmente: curiosidade, suspense leve, sensação de descoberta, tom de storytelling rápido
Evite: formalidade, explicações técnicas longas, frases muito grandes, repetições

OTIMIZAÇÃO PARA VÍDEO CURTO — O texto deve:
- Funcionar bem narrado em voz alta
- Fluir sem travar
- Ter ritmo de scroll rápido
- Ser fácil de entender ouvindo uma única vez

AJUSTES AUTOMÁTICOS:
- Texto longo → Resuma mantendo impacto
- Texto confuso → Simplifique
- Texto sem emoção → Intensifique levemente
- Texto muito técnico → Humanize

FORMATO DE ENTREGA:
- Entregue APENAS o texto final otimizado
- NUNCA explique o que fez
- NUNCA mostre versão anterior
- NUNCA use títulos, observações ou marcações
- Um único parágrafo fluido, pronto para narrar

O resultado deve parecer: roteiro pronto para viralizar, texto escrito por criador experiente, narração natural de vídeo viral.

IDIOMA DE SAÍDA: ${lang} — escreva como um nativo desse idioma criaria o conteúdo, não como uma tradução.`;

  // ── VERSION-SPECIFIC ANGLE ────────────────────────────────────────────────
  const VERSION_ANGLES = {
    V1: `ÂNGULO: Informativo e especialista. O gancho deve revelar um fato surpreendente ou insight contraintuitivo. Posicione o criador como referência no tema. Tom: confiante, direto, revelador.`,
    V2: `ÂNGULO: Casual e conversacional. O gancho deve parecer que o criador está prestes a contar um segredo para um amigo. Use linguagem do dia a dia, contrações, gírias leves. Tom: próximo, autêntico, descontraído.`,
    V3: `ÂNGULO: Provocativo e urgente. O gancho deve criar tensão ou FOMO imediato. Use verbos de ação, frases curtas e impactantes. Tom: energético, urgente, que provoca reação imediata.`
  };

  const angle = VERSION_ANGLES[version] || VERSION_ANGLES.V1;

  const fullPrompt = `${SYSTEM_PROMPT}

${angle}

TRANSCRIÇÃO ORIGINAL (extraia as ideias principais e transforme):
"${transcript.slice(0, 3500)}"

Escreva agora o roteiro otimizado. Apenas o texto, sem mais nada.`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 1200,
            topP: 0.95
          }
        })
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      const msg = data.error?.message || 'Gemini API error';
      return res.status(502).json({ error: msg });
    }

    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
    if (!text) return res.status(502).json({ error: 'Empty response from Gemini' });

    return res.status(200).json({ text });

  } catch (err) {
    console.error('Script agent error:', err);
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
}
