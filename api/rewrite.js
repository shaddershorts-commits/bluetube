// api/rewrite.js — BlueTube Viral Script Agent v10
// Super Prompt literal + Supabase real viral examples as living memory
// Primary: OpenAI GPT-4o mini | Fallback: Gemini rotation

// Helpers inlined for ESM compatibility on Vercel
import crypto from 'crypto';
function _ck(parts){ return crypto.createHash('md5').update(parts.join('|')).digest('hex'); }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit
  {
    const rlIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    const _SU = process.env.SUPABASE_URL, _SK = process.env.SUPABASE_SERVICE_KEY;
    if (_SU && _SK && rlIp) {
      try {
        const ws = new Date(Date.now() - 60000).toISOString();
        const cr = await fetch(`${_SU}/rest/v1/rate_limits?ip=eq.${encodeURIComponent(rlIp)}&endpoint=eq.${encodeURIComponent('/api/rewrite')}&window_start=gte.${ws}&select=count`, {
          headers: { 'apikey': _SK, 'Authorization': `Bearer ${_SK}` }, signal: AbortSignal.timeout(3000)
        });
        if (cr.ok) { const cd = await cr.json(); if ((cd?.length || 0) >= 10) { res.setHeader('Retry-After','60'); return res.status(429).json({ error:'Muitas requisições. Aguarde 1 minuto.', retry_after:60 }); } }
        fetch(`${_SU}/rest/v1/rate_limits`, { method:'POST', headers:{'Content-Type':'application/json','apikey':_SK,'Authorization':`Bearer ${_SK}`,'Prefer':'return=minimal'}, body:JSON.stringify({ip:rlIp,endpoint:'/api/rewrite',count:1,window_start:new Date().toISOString()}) }).catch(()=>{});
      } catch(e){}
    }
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const _supaH = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

  // ── FEEDBACK ACTION ─────────────────────────────────────────────────────────
  if (req.body?.action === 'feedback') {
    const { roteiro_id, tipo } = req.body;
    if (!roteiro_id || !tipo) return res.status(400).json({ error: 'Missing fields' });
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        // Get current counts
        const gr = await fetch(`${SUPABASE_URL}/rest/v1/roteiro_exemplos?id=eq.${roteiro_id}&select=aprovacoes,reprovacoes`, { headers: _supaH });
        if (gr.ok) {
          const gd = await gr.json();
          if (gd?.[0]) {
            const field = tipo === 'aprovado' ? 'aprovacoes' : 'reprovacoes';
            const newVal = (gd[0][field] || 0) + 1;
            await fetch(`${SUPABASE_URL}/rest/v1/roteiro_exemplos?id=eq.${roteiro_id}`, {
              method: 'PATCH', headers: { ..._supaH, 'Prefer': 'return=minimal' },
              body: JSON.stringify({ [field]: newVal, updated_at: new Date().toISOString() })
            });
          }
        }
      } catch(e) { console.error('[feedback]', e.message); }
    }
    return res.status(200).json({ ok: true });
  }

  const { transcript, lang, version, adjust } = req.body;
  if (!transcript || !lang) return res.status(400).json({ error: 'Transcrição e idioma são obrigatórios.' });

  const cleanTranscript = (typeof transcript === 'string' ? transcript : '').replace(/<[^>]*>/g, '').trim();
  if (cleanTranscript.length > 5000) return res.status(400).json({ error: 'Transcrição excede o limite de 5000 caracteres.' });

  // Helper: save roteiro, increment user stats, send transactional email
  async function saveAndReturn(result) {
    if (!adjust && SUPABASE_URL && SUPABASE_KEY && result.text) {
      try {
        const isCasual = version !== 'V2';
        const payload = {
          roteiro_casual: isCasual ? result.text : '',
          roteiro_apelativo: !isCasual ? result.text : '',
          idioma: lang,
          aprovacoes: 0, reprovacoes: 0,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString()
        };
        const sr = await fetch(`${SUPABASE_URL}/rest/v1/roteiro_exemplos`, {
          method: 'POST', headers: { ..._supaH, 'Prefer': 'return=representation' },
          body: JSON.stringify(payload)
        });
        if (sr.ok) { const sd = await sr.json(); if (sd?.[0]?.id) result.roteiro_id = sd[0].id; }
      } catch(e) {}

      // Increment user stats + send transactional email (fire-and-forget)
      const userToken = req.body?.token;
      if (userToken) {
        (async () => {
          try {
            const AK = process.env.SUPABASE_ANON_KEY || SUPABASE_KEY;
            const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + userToken } });
            if (!ur.ok) return;
            const user = await ur.json();
            const email = user.email;
            if (!email) return;

            // Get current stats
            const subR = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=total_roteiros,last_roteiro_at`, { headers: _supaH });
            const sub = subR.ok ? (await subR.json())[0] : null;
            const newTotal = (sub?.total_roteiros || 0) + 1;

            // Update stats
            fetch(`${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`, {
              method: 'PATCH', headers: { ..._supaH, Prefer: 'return=minimal' },
              body: JSON.stringify({ total_roteiros: newTotal, last_roteiro_at: new Date().toISOString() })
            }).catch(() => {});

            // Email transacional de roteiro pronto desativado para economizar envios
          } catch (e) {}
        })();
      }
    }
    return res.status(200).json(result);
  }

  // ── SUPABASE: LIVING MEMORY — real viral examples from real users ──────────
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

  // ── FEW-SHOT DINÂMICO — exemplos aprovados pelos usuários ──────────────────
  let fewShotExamples = '';
  if (SUPABASE_URL && SUPABASE_KEY && !adjust) {
    try {
      const fsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/roteiro_exemplos?idioma=eq.${encodeURIComponent(lang)}&aprovacoes=gte.3&select=roteiro_casual,roteiro_apelativo,nicho&order=aprovacoes.desc&limit=3`,
        { headers: _supaH }
      );
      if (fsRes.ok) {
        const fsRows = await fsRes.json();
        if (fsRows?.length > 0) {
          fewShotExamples = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 EXEMPLOS APROVADOS (roteiros que usuários reais aprovaram — use como referência):
${fsRows.map((r, i) => `
Exemplo ${i+1}${r.nicho ? ` (${r.nicho})` : ''}:
Casual: "${r.roteiro_casual?.slice(0, 300)}"
Apelativo: "${r.roteiro_apelativo?.slice(0, 300)}"`).join('\n')}

Gere roteiros com qualidade igual ou superior aos exemplos acima.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
        }
      }
    } catch(e) {}
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
    ? 'VERSÃO APELATIVA: narrador urgente e intenso. Linguagem direta e impactante. Ritmo acelerado, frases curtas. Máxima tensão do início ao fim.'
    : 'VERSÃO CASUAL: narrador próximo e informal. Linguagem cotidiana sem gírias excessivas. Como um amigo contando uma história incrível.';

  // ── SYSTEM PROMPT — NARRADOR EXTERNO + CONTINUIDADE ─────────────────────────
  const systemPrompt = `Você é um roteirista especialista em YouTube Shorts virais. Você cria narrações em TERCEIRA PESSOA — sempre como NARRADOR EXTERNO que conta uma história, NUNCA como personagem do vídeo.

IDENTIDADE DO NARRADOR:
- Você é o narrador — NUNCA a pessoa do vídeo
- Fala SOBRE os acontecimentos, não COMO se fosse o personagem
- Voz: narrador de documentário moderno, dinâmico e envolvente
- Adaptação nativa — ${nativeRule}

REGRA DE PERGUNTAS — ESTRATÉGICA:
✅ Pergunta permitida APENAS no gancho inicial OU no desfecho final
✅ Máximo 1 pergunta por roteiro
✅ Deve gerar tensão ou curiosidade real
❌ ZERO perguntas no meio do roteiro — quebram continuidade
❌ Proibido: 'Incrível, não é?', 'Consegue acreditar?', 'Que tal isso?'

PROIBIÇÕES ABSOLUTAS:
❌ Simular a voz da pessoa do vídeo ('Eu fiz...', 'Olha o que me aconteceu...')
❌ Narrar em primeira pessoa (eu, me, meu, minha, comigo)
❌ Usar 'você' no meio do roteiro (só permitido no gancho ou desfecho)
❌ Começar com contexto ('Este vídeo mostra...', 'Hoje vamos ver...')
❌ Conectores fracos ('também', 'além disso', 'por outro lado')
❌ Explicar o que vai acontecer antes de acontecer
❌ Terminar com CTA ('curta', 'compartilhe', 'se inscreva')
❌ Emojis, títulos, explicações fora do roteiro

ESTRUTURA OBRIGATÓRIA — 3 ATOS CONTÍNUOS:

ATO 1 — GANCHO (primeiras 2 frases):
Afirmação intrigante OU pergunta que gera dúvida. Direto ao conflito, sem contexto.

ATO 2 — PROGRESSÃO (2-3 frases):
Cada frase avança a história. Conectores de virada: 'Só que...', 'Mas aí...', 'Foi então que...'.
Tensão crescente. Pelo menos UMA virada inesperada. ZERO perguntas aqui.

ATO 3 — DESFECHO (1-2 frases):
Resultado ou revelação. Pode terminar com pergunta reflexiva se aumentar impacto.

RITMO: máximo 60 palavras. Frases curtas. Cada palavra ganha seu lugar.

${culturalAdaptation}

TESTE INTERNO antes de retornar:
1. A primeira frase prende sem dar contexto? ✓
2. Continuidade entre TODAS as frases? ✓
3. Alguma frase simula voz de alguém do vídeo? → reescrever em terceira pessoa
4. Pergunta no MEIO? → remover ou mover para gancho/desfecho
5. Mais de 1 pergunta? → remover extras
${livingMemory ? `\nREFERÊNCIA DE QUALIDADE:\n${livingMemory}` : ''}
${fewShotExamples}

IDIOMA: ${lang}
${ANGLE}`;

  const userPrompt = adjust
    ? `ROTEIRO ATUAL:
"${transcript.slice(0, 3000)}"

AJUSTE PEDIDO: "${adjust.slice(0, 500)}"

Aplique o ajuste mantendo: narrador externo em terceira pessoa, continuidade entre frases, máximo 1 pergunta (só no gancho ou desfecho). Retorne APENAS o roteiro ajustado.`
    : `CONTEÚDO DO VÍDEO ORIGINAL:
"${transcript.slice(0, 3000)}"

Crie um roteiro de narração baseado neste conteúdo.
- Narrador EXTERNO em terceira pessoa — NUNCA simule a voz de quem aparece no vídeo
- Pergunta permitida APENAS no gancho OU desfecho — máximo 1
- ZERO perguntas no meio do roteiro
- Continuidade total entre frases
- Máximo 60 palavras
- Retorne APENAS o texto do roteiro, nada mais.`;

  // ── CACHE — skip AI calls if same request was recently generated ──────────
  const _SU2 = process.env.SUPABASE_URL, _SK2 = process.env.SUPABASE_SERVICE_KEY;
  const _ckRewrite = !adjust ? _ck(['rewrite', cleanTranscript.slice(0, 200), lang, version || 'V1']) : null;
  if (_ckRewrite && _SU2 && _SK2) {
    try {
      const cr = await fetch(`${_SU2}/rest/v1/api_cache?cache_key=eq.${_ckRewrite}&expires_at=gt.${new Date().toISOString()}&select=value&limit=1`, {
        headers: { 'apikey': _SK2, 'Authorization': `Bearer ${_SK2}` }, signal: AbortSignal.timeout(3000)
      });
      if (cr.ok) { const cd = await cr.json(); if (cd?.[0]?.value) return res.status(200).json(cd[0].value); }
    } catch(e){}
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
        if (_ckRewrite && _SU2 && _SK2) {
          fetch(`${_SU2}/rest/v1/api_cache?cache_key=eq.${_ckRewrite}`, { method:'DELETE', headers:{'apikey':_SK2,'Authorization':`Bearer ${_SK2}`} }).catch(()=>{});
          fetch(`${_SU2}/rest/v1/api_cache`, { method:'POST', headers:{'Content-Type':'application/json','apikey':_SK2,'Authorization':`Bearer ${_SK2}`,'Prefer':'return=minimal'},
            body:JSON.stringify({cache_key:_ckRewrite,value:result,created_at:new Date().toISOString(),expires_at:new Date(Date.now()+3600*1000).toISOString()})
          }).catch(()=>{});
        }
        return saveAndReturn(result);
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
      if (_ckRewrite && _SU2 && _SK2) {
        fetch(`${_SU2}/rest/v1/api_cache?cache_key=eq.${_ckRewrite}`, { method:'DELETE', headers:{'apikey':_SK2,'Authorization':`Bearer ${_SK2}`} }).catch(()=>{});
        fetch(`${_SU2}/rest/v1/api_cache`, { method:'POST', headers:{'Content-Type':'application/json','apikey':_SK2,'Authorization':`Bearer ${_SK2}`,'Prefer':'return=minimal'},
          body:JSON.stringify({cache_key:_ckRewrite,value:result,created_at:new Date().toISOString(),expires_at:new Date(Date.now()+3600*1000).toISOString()})
        }).catch(()=>{});
      }
      return saveAndReturn(result);
    } catch (e) { continue; }
  }

  // ── FALLBACK: return example script when all AI providers fail ──────────
  const _fb = {
    'Português (Brasil)': ['Você não vai acreditar no que aconteceu. Uma história que parece ficção mas é real. Tudo começou quando alguém decidiu fazer diferente. O resultado? Algo que ninguém esperava.','Para de scrollar. Isso aqui é sério. O que eu vou te contar agora pode mudar completamente a forma como você pensa. Presta atenção porque depois que souber, não tem volta.'],
    'English': ["You won't believe what just happened. A story that sounds like fiction but is 100% real. It started when someone decided to do things differently. The result? Nobody expected it.","Stop scrolling. This is serious. What I'm about to tell you could completely change how you think. Pay attention. Once you know this, there's no going back."],
    'Español': ['No vas a creer lo que acaba de pasar. Una historia que parece ficción pero es real. Todo empezó cuando alguien decidió hacer las cosas diferente. El resultado? Nadie lo esperaba.','Deja de hacer scroll. Esto va en serio. Lo que te voy a contar puede cambiar tu forma de pensar. Presta atención porque después no hay vuelta atrás.'],
  };
  const fbScripts = _fb[lang] || _fb['Português (Brasil)'];
  const fbText = version === 'V2' ? (fbScripts[1] || fbScripts[0]) : fbScripts[0];
  res.setHeader('Retry-After', '60');
  return res.status(200).json({
    text: fbText,
    engine: 'fallback',
    fallback: true,
    message: '⚡ Roteiro de exemplo — nossos servidores estão sobrecarregados. Tente novamente em 1 minuto.',
    retry_after: 60
  });
}
