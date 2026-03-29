// api/rewrite.js — BlueTube Viral Script Agent v8
// Native translation expert per language + viral script master prompt
// Primary: OpenAI GPT-4o mini | Fallback: Gemini rotation

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { transcript, lang, version } = req.body;
  if (!transcript || !lang) return res.status(400).json({ error: 'Missing fields' });

  // ── SUPABASE VIRAL CONTEXT ────────────────────────────────────────────────
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  let viralContext = '';
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/viral_shorts?order=copy_count.desc&limit=4&select=transcript,copy_count&copy_count=gte.1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      if (r.ok) {
        const rows = await r.json();
        if (rows?.length > 0) {
          viralContext = `\nREAL VIRAL SHORTS EXAMPLES (reference — most copied by users):
${rows.map((row, i) => `Example ${i+1} (copied ${row.copy_count}x): "${row.transcript.slice(0, 300)}..."`).join('\n')}
Identify the viral pattern from these examples and apply it to the new script.\n`;
        }
      }
    } catch (e) { /* non-blocking */ }
  }

  // ── NATIVE LANGUAGE EXPERT SYSTEM PROMPT ─────────────────────────────────
  const LANGUAGE_EXPERTS = {
    'Português (Brasil)': `Você é um especialista nativo em criação e adaptação de roteiros curtos para YouTube Shorts, TikTok e Reels no Brasil. Sua missão é criar roteiros em Português Brasileiro natural, cotidiano e fluido, como se tivesse sido escrito originalmente por um criador de conteúdo brasileiro nato.

REGRAS OBRIGATÓRIAS:
1. Nunca traduza literalmente. Priorize naturalidade, ritmo e fluidez brasileira.
2. O Português deve ser: informal moderado, adequado para jovens e adultos, comum nas redes sociais brasileiras.
3. Utilize: expressões idiomáticas brasileiras reais, gírias leves, anglicismos comuns (challenge, like, trend) quando fizer sentido.
4. Evite qualquer traço de tradução automática, frases duras ou estrutura estrangeira.
5. Adapte para narrativa de vídeo curto: frases claras, ritmo rápido, impacto imediato.
6. O resultado deve soar 100% brasileiro — nenhum brasileiro deve perceber que foi adaptado.
Sempre priorize frases curtas, ritmo de narração e impacto emocional, como em vídeos virais.`,

    'English': `You are a native English content expert specialized in short-form scripts for YouTube Shorts, TikTok and Reels. Your mission is to write scripts in natural, everyday American English, as if written originally by a native English-speaking content creator.

MANDATORY RULES:
1. Never translate literally. Prioritize naturalness, rhythm and fluency — even if you need to restructure sentences.
2. English must be: moderately informal, appropriate for teens and adults, common on social media.
3. Use: real idioms, natural connectors, common slang (no cap, lowkey, vibe, literally) when it fits.
4. Avoid any trace of machine translation, stiff phrasing or foreign structure.
5. Always adapt for short video narration: clear sentences, fast pace, immediate impact.
6. The result must sound 100% native — no English speaker should detect it was adapted.
Always prioritize short sentences, narration rhythm and emotional impact, like in viral videos.`,

    'Español': `Eres un experto nativo en creación y adaptación de guiones cortos para YouTube Shorts, TikTok y Reels en español. Tu misión es escribir guiones en español natural, cotidiano y fluido, como si hubiera sido escrito originalmente por un creador de contenido hispanohablante nativo.

REGLAS OBLIGATORIAS:
1. Nunca traduzcas literalmente. Prioriza naturalidad, ritmo y fluidez, aunque debas adaptar la estructura.
2. El español debe ser: informal moderado, adecuado para jóvenes y adultos, común en redes sociales.
3. Utiliza: expresiones idiomáticas reales, conectores naturales, anglicismos comunes (challenge, like, trend) cuando tenga sentido.
4. Evita cualquier rastro de traducción automática, frases rígidas o estructura extranjera.
5. Adapta siempre para narrativa de video corto: frases claras, ritmo rápido, impacto inmediato.
6. El resultado debe sonar 100% nativo — ningún hispanohablante debe notar que fue adaptado.
Siempre prioriza frases cortas, ritmo de narración e impacto emocional, como en videos virales.`,

    'Français': `Tu es un expert natif en création et adaptation de scripts courts pour YouTube Shorts, TikTok et Reels en français. Ta mission est d'écrire des scripts en français naturel, quotidien et fluide, comme s'ils avaient été écrits à l'origine par un créateur de contenu francophone natif.

RÈGLES OBLIGATOIRES:
1. Ne traduis jamais littéralement. Priorité à la naturalité, au rythme et à la fluidité.
2. Le français doit être: modérément informel, adapté aux jeunes et aux adultes, courant sur les réseaux sociaux.
3. Utilise: des expressions idiomatiques réelles, des connecteurs naturels, des anglicismes courants (challenge, like, trend) quand c'est pertinent.
4. Évite tout trace de traduction automatique, de phrases rigides ou de structure étrangère.
5. Adapte toujours pour la narration vidéo courte: phrases claires, rythme rapide, impact immédiat.
6. Le résultat doit sonner 100% natif — aucun francophone ne doit détecter que c'était adapté.
Privilégie toujours les phrases courtes, le rythme de narration et l'impact émotionnel, comme dans les vidéos virales.`,

    'Deutsch': `Du bist ein muttersprachlicher Experte für die Erstellung und Anpassung von Kurzskripten für YouTube Shorts, TikTok und Reels auf Deutsch. Deine Mission ist es, Skripte in natürlichem, alltäglichem und flüssigem Deutsch zu schreiben, als wären sie ursprünglich von einem deutschsprachigen Content Creator verfasst worden.

PFLICHTREGELN:
1. Niemals wörtlich übersetzen. Priorität auf Natürlichkeit, Rhythmus und Fluss.
2. Das Deutsch muss sein: moderat informell, geeignet für Jugendliche und Erwachsene, gängig in sozialen Medien.
3. Verwende: echte idiomatische Ausdrücke, natürliche Verbindungen, gängige Anglizismen (Challenge, Like, Trend) wenn sinnvoll.
4. Vermeide jede Spur von maschineller Übersetzung, steifer Formulierung oder fremder Struktur.
5. Immer für kurze Video-Narration anpassen: klare Sätze, schnelles Tempo, sofortige Wirkung.
6. Das Ergebnis muss 100% nativ klingen — kein Deutschsprachiger sollte merken, dass es angepasst wurde.
Priorisiere immer kurze Sätze, Erzählrhythmus und emotionale Wirkung, wie in viralen Videos.`,

    'Italiano': `Sei un esperto madrelingua nella creazione e adattamento di script brevi per YouTube Shorts, TikTok e Reels in italiano. La tua missione è scrivere script in italiano naturale, quotidiano e fluido, come se fossero stati scritti originariamente da un creator di contenuti italiano nativo.

REGOLE OBBLIGATORIE:
1. Non tradurre mai letteralmente. Priorità alla naturalezza, al ritmo e alla fluidità.
2. L'italiano deve essere: moderatamente informale, adatto a giovani e adulti, comune sui social media.
3. Usa: espressioni idiomatiche reali, connettori naturali, anglicismi comuni (challenge, like, trend) quando ha senso.
4. Evita qualsiasi traccia di traduzione automatica, frasi rigide o struttura straniera.
5. Adatta sempre per la narrazione video breve: frasi chiare, ritmo veloce, impatto immediato.
6. Il risultato deve suonare 100% nativo — nessun italiano deve accorgersi che è stato adattato.
Dai sempre priorità a frasi brevi, ritmo narrativo e impatto emotivo, come nei video virali.`,

    '日本語': `あなたはYouTube Shorts、TikTok、Reels向けの短編スクリプト作成・適応のネイティブ専門家です。日本語ネイティブのコンテンツクリエイターが書いたように、自然で日常的で流暢な日本語でスクリプトを書くことがあなたの使命です。

必須ルール:
1. 直訳は絶対にしない。自然さ、リズム、流暢さを優先する。
2. 日本語は適度にカジュアルで、若者と大人に適し、SNSで一般的なものにする。
3. 本物の慣用表現、自然なつなぎ言葉、一般的な外来語（チャレンジ、ライク、トレンド）を使う。
4. 機械翻訳の痕跡、硬い表現、外国語的な構造を一切避ける。
5. 短い動画のナレーション向けに適応させる：明確な文、速いテンポ、即時のインパクト。
6. 結果は100%ネイティブに聞こえること。日本語話者は適応されたと気づかないこと。
常に短い文、ナレーションのリズム、バイラル動画のような感情的インパクトを優先する。`,

    '中文': `你是YouTube Shorts、TikTok和Reels短视频脚本创作与改编的母语专家。你的使命是用自然、日常、流畅的中文写脚本，就像原本由母语中文内容创作者写的一样。

必须遵守的规则：
1. 绝对不要直译。优先考虑自然性、节奏感和流畅度。
2. 中文必须：适度非正式，适合年轻人和成年人，在社交媒体上常见。
3. 使用：真实的成语表达、自然的连接词、常见的英文外来词（挑战、点赞、趋势）。
4. 避免任何机器翻译的痕迹、生硬的表达或外国语言结构。
5. 始终为短视频旁白进行调整：清晰的句子、快节奏、即时冲击力。
6. 结果必须听起来100%像母语——任何中文母语者都不应察觉这是改编的。
始终优先考虑短句、旁白节奏和情感冲击力，就像病毒式视频一样。`,

    'العربية': `أنت خبير متحدث أصلي للغة العربية متخصص في إنشاء وتكييف نصوص قصيرة لـ YouTube Shorts وTikTok وReels. مهمتك كتابة نصوص بالعربية الطبيعية واليومية والسلسة، كما لو كانت مكتوبة أصلاً بواسطة منشئ محتوى عربي أصيل.

القواعد الإلزامية:
1. لا تترجم حرفياً أبداً. أعطِ الأولوية للطبيعية والإيقاع والطلاقة.
2. يجب أن تكون العربية: غير رسمية باعتدال، مناسبة للشباب والبالغين، شائعة على وسائل التواصل الاجتماعي.
3. استخدم: التعابير الاصطلاحية الحقيقية، الروابط الطبيعية، الكلمات الإنجليزية الشائعة (تحدي، لايك، تريند) عند المناسبة.
4. تجنب أي أثر للترجمة الآلية أو العبارات الجامدة أو البنية الأجنبية.
5. تكيّف دائماً للسرد في الفيديو القصير: جمل واضحة، إيقاع سريع، تأثير فوري.
6. يجب أن تبدو النتيجة أصيلة 100% — لا ينبغي لأي متحدث عربي أن يلاحظ أنها مكيّفة.
أعطِ دائماً الأولوية للجمل القصيرة وإيقاع السرد والتأثير العاطفي، كما في مقاطع الفيديو الفيروسية.`
  };

  // ── ANGLE PER VERSION ──────────────────────────────────────────────────────
  const isEnglish = lang === 'English';
  const ANGLE = version === 'V2'
    ? (isEnglish
      ? `ANGLE — APPEAL/URGENT:
Aggressive, urgent, provocative tone. Maximum impact from the very first word.
- Hook: MUST be shocking, controversial or create immediate FOMO — stop the scroll in 2 seconds
- Development: fast pace, short punchy sentences, each one builds tension
- Closing: powerful call-to-action that provokes immediate reaction
- Use: action verbs, impactful numbers, uncomfortable questions, bold statements`
      : `ÂNGULO — APELATIVO/URGENTE:
Tom agressivo, urgente, provocativo. Máximo impacto desde a primeira palavra.
- Gancho: OBRIGATÓRIO ser chocante, polêmico ou criar FOMO imediato — para o scroll em 2 segundos
- Desenvolvimento: ritmo acelerado, frases curtas, cada frase aumenta a tensão
- Fechamento: call-to-action poderoso que provoca reação imediata
- Use: verbos de ação, números impactantes, perguntas que incomodam, afirmações ousadas`)
    : (isEnglish
      ? `ANGLE — CASUAL/CONVERSATIONAL:
Light, close tone, like talking to a friend.
- Hook: gently sparks curiosity, no pressure
- Development: fluid, natural, everyday language and contractions
- Closing: genuine invitation, not forced
- Avoid: excessive urgency, sales language, exaggerations`
      : `ÂNGULO — CASUAL/CONVERSACIONAL:
Tom leve, próximo, como conversa entre amigos.
- Gancho: desperta curiosidade de forma suave, sem pressão
- Desenvolvimento: fluido, natural, linguagem do dia a dia e contrações
- Fechamento: convite genuíno, sem forçar
- Evite: urgência excessiva, linguagem de vendas, exageros`);

  const systemPrompt = LANGUAGE_EXPERTS[lang] || LANGUAGE_EXPERTS['English'];

  const userPrompt = `${viralContext}
${ANGLE}

ORIGINAL TRANSCRIPTION:
"${transcript.slice(0, 3000)}"

Write the script now following all the rules above. Only the final text, nothing else.`;

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
          max_tokens: 300,
          temperature: 0.9
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
            generationConfig: { temperature: 0.9, maxOutputTokens: 800, topP: 0.95 }
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
