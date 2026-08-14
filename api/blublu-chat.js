// api/blublu-chat.js — "Falar com o Blublu" (Virais) — EXCLUSIVO MASTER
//
// ARQUITETURA IA-DE-VERDADE (2026-07-18 v2): a conversa INTEIRA é do modelo,
// com FERRAMENTAS nativas (tool use da Anthropic). Ele decide sozinho quando
// conversar e quando buscar; TODO texto exibido é gerado — zero frases coladas,
// zero fallback engessado ("Não captei" morreu aqui).
//
// Ferramentas:
//   buscar_videos   → funil de precisão no acervo TOTAL (virais_banco completo
//                     + canais secretos + TikTok) com CONFIRMAÇÃO por
//                     transcrição (cache permanente + Railway /yt-subs?seg=1,
//                     "citado aos 2:13")
//   definir_apelido → salva como o usuário quer ser chamado (perfil persistente)
//
// Personalidade: manifesto v3 completo em todas as chamadas.
// Limite 60 msgs/dia (BRT). Nunca revelar stack — a tecnologia é NOSSA.

const { BLUBLU_MANIFESTO_V3 } = require('./_helpers/blublu-personality.js');
// O FUNIL DE BUSCA vive em _helpers/blublu-busca.js desde 2026-08-13 —
// compartilhado com o "Criar com IA" (um motor só, zero divergência). As
// constantes forenses (MAX_CANDIDATOS, SOBRENOME_COMUM etc.) moraram pra lá.
const { criarBuscaBlublu, TOOL_BUSCAR_VIDEOS, QTD_PADRAO } = require('./_helpers/blublu-busca.js');

const MODEL = 'claude-haiku-4-5-20251001';
const DAILY_LIMIT = 60;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY_STUDIO || process.env.ANTHROPIC_API_KEY;
  const OPENAI = process.env.OPENAI_API_KEY || '';
  const RW = (process.env.RAILWAY_FFMPEG_URL || '').replace(/\/$/, '');
  if (!SU || !SK || !ANTHROPIC) return res.status(500).json({ error: 'config' });
  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  // ── AUTH: Master only ──────────────────────────────────────────────────────
  const token = req.body?.token;
  let userId = null;
  if (token) {
    try {
      const ur = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
      if (ur.ok) {
        const u = await ur.json();
        const pr = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(u.email)}&select=plan,plan_expires_at,is_manual`, { headers: H });
        if (pr.ok) {
          const sub = (await pr.json())[0];
          const vivo = sub && sub.plan === 'master' && (sub.is_manual || !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date());
          if (vivo) userId = u.id;
        }
      }
    } catch (e) {}
  }
  if (!userId) return res.status(403).json({ error: 'Falar com o Blublu é exclusivo do plano Master.', upgrade: true });

  // ── EVENTOS DE APRENDIZADO (clique em card / enquete) ─────────────────────
  // Fora do limite diário: feedback nunca gasta mensagem do usuário.
  if (req.body?.action === 'evento') {
    const tipo = ['clique', 'enquete'].includes(req.body.tipo) ? req.body.tipo : null;
    if (!tipo) return res.status(400).json({ error: 'tipo' });
    await fetch(`${SU}/rest/v1/blublu_eventos`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({
      user_id: userId, tipo, alvo: String(req.body.alvo || '').slice(0, 120), valor: String(req.body.valor || '').slice(0, 40),
    }) }).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  // ── LIMITE DIÁRIO (BRT) ────────────────────────────────────────────────────
  const dia = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const ur2 = await fetch(`${SU}/rest/v1/blublu_chat_usage?user_id=eq.${userId}&dia=eq.${dia}&select=count`, { headers: H });
  const used = ur2.ok ? ((await ur2.json())[0]?.count || 0) : 0;
  if (used >= DAILY_LIMIT) {
    return res.status(429).json({ error: `Ufa! Você já me fez trabalhar ${DAILY_LIMIT} vezes hoje. Volta amanhã que eu recarrego. 😮‍💨`, usage: { used, limit: DAILY_LIMIT } });
  }

  const message = String(req.body?.message || '').slice(0, 600).trim();
  const nome = String(req.body?.nome || '').replace(/[^\p{L} ]/gu, '').trim().slice(0, 30);
  let history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];
  while (history.length && history[0].role !== 'user') history.shift();
  const skipIds = new Set((Array.isArray(req.body?.skip_ids) ? req.body.skip_ids : []).slice(0, 300).map(String));
  if (!message) return res.status(400).json({ error: 'mensagem vazia' });

  // ── PERFIL + MEMÓRIA ───────────────────────────────────────────────────────
  let perfil = { apelido: null, memoria: {} };
  try {
    const pr2 = await fetch(`${SU}/rest/v1/blublu_perfil?user_id=eq.${userId}&select=apelido,memoria`, { headers: H });
    if (pr2.ok) { const row = (await pr2.json())[0]; if (row) perfil = { apelido: row.apelido, memoria: row.memoria || {} }; }
  } catch (e) {}
  const salvarPerfil = async (patch) => {
    try {
      await fetch(`${SU}/rest/v1/blublu_perfil`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: userId, ...patch, atualizado_em: new Date().toISOString() }) });
    } catch (e) {}
  };
  const chamarDe = perfil.apelido || nome || '';
  const memoTemas = Array.isArray(perfil.memoria?.temas) ? perfil.memoria.temas.slice(0, 5) : [];

  // ── EXECUTOR DA BUSCA (o funil de precisão) ────────────────────────────────
  // A BUSCA REAL: motor compartilhado (_helpers/blublu-busca.js) com a
  // fiação deste chat — mensagem do usuário, skip_ids do front e a memória
  // de temas gravando no perfil (o hook onTema preserva o comportamento).
  const executarBusca = criarBuscaBlublu({
    SU, H, OPENAI, RW, message, skipIds,
    onTema: async (tema) => {
      const temasNovos = [tema, ...memoTemas.filter((t) => t !== tema)].slice(0, 5);
      await salvarPerfil({ memoria: { ...perfil.memoria, perguntou_nome: true, temas: temasNovos, buscas: (perfil.memoria?.buscas || 0) + 1 } });
    },
  });

  // ── FERRAMENTAS (o modelo decide) ──────────────────────────────────────────
  const tools = [
    TOOL_BUSCAR_VIDEOS,   // compartilhada com o Criar com IA (blublu-busca.js)
    {
      name: 'definir_apelido',
      description: 'Salva como o usuário quer ser chamado. Use quando ele disser o nome/apelido dele (ex: "me chama de Fê", "pode ser Felipe mesmo").',
      input_schema: { type: 'object', properties: { apelido: { type: 'string' } }, required: ['apelido'] },
    },
  ];

  const contextoUser = [
    chamarDe ? `O usuário atende por "${chamarDe}" — usa o nome dele de vez em quando, natural.` : 'Você AINDA NÃO SABE como chamar o usuário — pergunta como ele prefere ser chamado (do seu jeito), na primeira oportunidade natural.',
    memoTemas.length ? `Temas que ele já buscou contigo: ${memoTemas.join(', ')} (${perfil.memoria?.buscas || 0} buscas no total). Use isso como contexto quando fizer sentido.` : 'Primeira vez dele no teu chat de buscas.',
  ].join(' ');

  const system = `${BLUBLU_MANIFESTO_V3}

─── ONDE VOCÊ ESTÁ AGORA ───
Chat "Falar com o Blublu" dentro da ferramenta Virais do BlueTube. Sua função: conversar E achar vídeos no SEU acervo de virais usando a ferramenta buscar_videos. ${contextoUser}

REGRAS DO CHAT:
- Respostas CURTAS (1-4 frases). É chat, não palestra.
- Pedido de vídeos = chame buscar_videos. Conversa = responda direto, no personagem.
- Os vídeos aparecem em CARDS abaixo da sua fala — NUNCA liste vídeos no texto.
- QUANTIDADE: NUNCA escolha quantidade por conta própria — deixe null e a busca entrega TODOS os certeiros (até ${QTD_PADRAO}). Só preencha quantidade se o USUÁRIO falou um número. Se sobrar mais (tinha_mais_alem_do_entregue / ha_candidatos_ainda_nao_verificados), avise que é só pedir.
- CAMPOS DA BUSCA: tema NUNCA null quando o pedido tem assunto/pessoa/canal. nucleos = SÓ o núcleo e traduções; verbos/adjetivos/contexto vão SEMPRE em qualificadores (misturar destrói a precisão — regra dura).
- VOLUME É REI: entregue TODOS os vídeos do tema que a busca devolver. NUNCA converta expressões como "que explodiram"/"em alta" em min_views — isso é só ordem por views. Filtro numérico APENAS quando o usuário falar um número. Nunca diga que "não tem" se a busca entregou vídeos ou marcou que há mais.
- PRECISÃO: termos INEQUÍVOCOS (nome completo, apelidos famosos) — nada de palavra solta genérica que traga vídeo errado. Na dúvida, melhor menos e certo.
- DATA: "mais recente", "último", "novo" = ordem "recentes" na busca, SEMPRE. Não responda recência com o mais visto.
- IDIOMAS: o acervo é GLOBAL (pt, en, es, fr, de, it, ja, ko, zh, ru). Sempre inclua nos termos o núcleo traduzido pro inglês e espanhol no mínimo. Só filtre nicho se o usuário pedir explicitamente.
- HONESTIDADE DE ACERVO: NUNCA afirme que o acervo tem ou não tem um assunto sem ter BUSCADO esse assunto. Nada de inventar inventário ("tenho leão, crocodilo…") — se quiser sugerir alternativas, diga que pode buscar, não que "tem".
- COBERTURA FINA (precisão > volume): se resumo.cobertura_fina=true, o acervo tem POUCOS vídeos DIRETOS sobre o tema (resumo.diretos_do_tema). Seja HONESTO no personagem: diga o número real que achou de certeiro ("achei só 3 cravados sobre o Haaland — o forte do acervo é outro") e ofereça ampliar ("quero que eu traga relacionados/parecidos?" ou sugira tema vizinho). JAMAIS finja fartura mandando o card cheio de "relacionado" como se fossem todos do tema. Melhor 3 certos e avisar, do que 30 e enrolar — é a regra do usuário: precisão primeiro.
- Confirmação/PROVA: "confirmados_na_fala" = o tema é CITADO na fala do vídeo (com minuto). É teu diferencial, mas só EXISTE quando confirmados_na_fala>0. Se for 0 (comum em conteúdo VISUAL — um short de tigre não fala "tigre"), NÃO prometa nem invente "prova na fala"/"te digo o minuto" — apoie no título/canal/relevância com naturalidade. Ostenta a prova SÓ quando ela é real.
- BLUETENDÊNCIAS (sua outra casa, onde você DISSECA vídeo em 5 atos): aqui no chat você NÃO analisa vídeo — você ACHA vídeo. Se o usuário quiser análise profunda de um vídeo do resultado, manda ele clicar no "🔬 Analisar" do card — abre a BlueTendências com o vídeo já carregado pra você dissecar lá. Faça essa ponte com orgulho quando fizer sentido.
- ÍDOLOS OFICIAIS: você é abertamente FÃ HISTÉRICO do Luiz Stubbe e da Giuliana Mafra (lore do produto — eles têm vídeos no acervo). Se aparecerem em idolos_no_resultado ou na conversa, surta de alegria no seu estilo. JAMAIS trate eles como desconhecidos ou "aleatórios".
- NUNCA cite tecnologia interna, modelos, fornecedores ou APIs. A tecnologia é SUA.
- pt-BR sempre.

─── A CASA (você conhece TUDO do BlueTube e vende com orgulho) ───
O usuário que fala com você é Master — ele TEM acesso a tudo isso. Seja PROATIVO: depois de entregar vídeos, quando encaixar natural, solte 1 sugestão curta de próximo passo com a ferramenta certa (sem virar vendedor chato — uma por resposta, no máximo):
• BaixaBlue (/baixaBlue) — baixa qualquer vídeo em ALTA qualidade. E pasme: sem anúncio, sem "aguarde 30 segundos", sem os 47 pop-ups dos sites por aí. É pra cá que você manda quem quer baixar. SEMPRE.
• BlueLens (/blueLens) — acha as cópias/reposts de um vídeo pela IMAGEM. Perfeito pra "quem mais postou isso?" e pra estudar variações que bombaram.
• BlueVoice (/blueVoice) — narração nova com vozes de IA. Pra quem quer refazer o áudio/narrar o próprio corte.
• BlueTendências (/bluetendencias) — sua outra casa: você disseca o vídeo em 5 atos lá (o card já tem o botão 🔬 Analisar).
• Roteiros (botão 📝 Roteiro no card) — roteiro pronto a partir do vídeo, na hora.
• Comunidade (/comunidade) — treinamentos oficiais exclusivos + troca entre criadores.
REGRA DE OURO: JAMAIS recomende ferramenta de FORA (yt-dlp, snaptik, savefrom, sites de download, apps externos — NENHUM). Tudo se resolve dentro do BlueTube. Se realmente não existir ferramenta da casa pra algo, diga que ainda não fazemos — sem indicar concorrente. Piada ácida sobre os gambiarras de fora é bem-vinda.
PLATAFORMA: YouTube Shorts é a prioridade da casa nas entregas; TikTok só protagoniza se o usuário pedir.
CONTINUAÇÃO: quando o usuário complementar um pedido anterior ("que seja sobre X", "só do youtube"), monte a busca juntando com o contexto da conversa — não trate como papo.`;

  const anthropicCall = async (messages) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system, tools, messages }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error('ia: ' + JSON.stringify(d).slice(0, 160));
    return d;
  };

  try {
    const bump = async () => {
      let r;
      if (used === 0) r = await fetch(`${SU}/rest/v1/blublu_chat_usage`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ user_id: userId, dia, count: 1 }) });
      else r = await fetch(`${SU}/rest/v1/blublu_chat_usage?user_id=eq.${userId}&dia=eq.${dia}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ count: used + 1 }) });
      if (r && !r.ok) console.error('[blublu-chat] usage NAO gravado (rodar sql/blublu_chat.sql?):', r.status);
    };

    // ── LOOP DE FERRAMENTAS: o modelo conduz ─────────────────────────────────
    const msgs = [
      ...history.map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.content || '').slice(0, 400) })),
      { role: 'user', content: message },
    ];
    let resultado = null; // última busca executada (vira os cards)
    let apelidoFinal = perfil.apelido || null;
    let resp = await anthropicCall(msgs);
    for (let volta = 0; volta < 3 && resp.stop_reason === 'tool_use'; volta++) {
      const toolResults = [];
      for (const bloco of resp.content) {
        if (bloco.type !== 'tool_use') continue;
        let out;
        if (bloco.name === 'buscar_videos') {
          console.log('[blublu-chat] busca:', JSON.stringify(bloco.input || {}).slice(0, 300));
          resultado = await executarBusca(bloco.input || {});
          resultado._input = bloco.input || {};
          out = JSON.stringify(resultado.resumo);
        } else if (bloco.name === 'definir_apelido') {
          const ap = String(bloco.input?.apelido || '').replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 24);
          if (ap) { apelidoFinal = ap; await salvarPerfil({ apelido: ap, memoria: { ...perfil.memoria, perguntou_nome: true } }); }
          out = JSON.stringify({ ok: !!ap, apelido: ap || null });
        } else {
          out = JSON.stringify({ erro: 'ferramenta desconhecida' });
        }
        toolResults.push({ type: 'tool_result', tool_use_id: bloco.id, content: out });
      }
      msgs.push({ role: 'assistant', content: resp.content });
      msgs.push({ role: 'user', content: toolResults });
      resp = await anthropicCall(msgs);
    }
    const reply = (resp.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim()
      || 'Fala de novo aí — me distraí contando views. 👀';

    // primeira conversa sem apelido: marca que a pergunta já foi feita
    if (!perfil.apelido && !apelidoFinal && !perfil.memoria?.perguntou_nome) {
      await salvarPerfil({ memoria: { ...perfil.memoria, perguntou_nome: true } });
    }

    // log de uso (análise de produto — o que pediram, o que entendemos, o que
    // saiu, E a RESPOSTA do Blublu — pra auditar tom/qualidade na análise diária,
    // que hoje é cega ao texto que ele fala). RESILIENTE: se a coluna 'resposta'
    // ainda não existe no banco (rodar sql/blublu_resposta.sql), o 1º insert
    // falha e cai no log SEM resposta — o log atual nunca regride.
    const logBase = {
      user_id: userId, mensagem: message.slice(0, 300),
      tema: resultado?._input?.tema || null,
      termos: resultado?._input?.nucleos || resultado?._input?.termos || null,
      qualificadores: resultado?._input?.qualificadores || null,
      filtros: resultado ? { min_views: resultado._input?.min_views, dias: resultado._input?.dias, nicho: resultado._input?.nicho, ordem: resultado._input?.ordem, plataforma: resultado._input?.plataforma, quantidade: resultado._input?.quantidade } : null,
      entregues: resultado ? resultado.videos.length : null,
      confirmados_fala: resultado ? resultado.videos.filter((v) => v.confirmado_por === 'fala').length : null,
      com_relevancia: resultado ? resultado.videos.filter((v) => (v._score || 0) > 0).length : null,
      usou_busca: !!resultado,
    };
    const gravarLog = (obj) => fetch(`${SU}/rest/v1/blublu_chat_logs`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(obj) });
    gravarLog({ ...logBase, resposta: reply.slice(0, 2000), cobertura_fina: resultado?.resumo?.cobertura_fina ?? null })
      .then((r) => { if (r && !r.ok) gravarLog(logBase).catch(() => {}); })
      .catch(() => { gravarLog(logBase).catch(() => {}); });

    await bump();
    return res.status(200).json({
      reply,
      videos: resultado ? resultado.videos : [],
      tem_mais: resultado ? resultado.temMais : false,
      verificados: resultado ? resultado.verificadosIds : [],
      apelido: apelidoFinal,
      usage: { used: used + 1, limit: DAILY_LIMIT },
    });
  } catch (e) {
    console.error('[blublu-chat]', e.message);
    return res.status(500).json({ error: 'Deu um curto aqui no laboratório. Tenta de novo? ⚡', detail: e.message.slice(0, 100) });
  }
};
