// api/blublu-chat.js — "Falar com o Blublu" (Virais) — assinantes (Full ou Master)
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

const MODEL = 'claude-haiku-4-5-20251001';
// A PRIMEIRA chamada é a que DECIDE: buscar ou não, qual tema, quais núcleos.
// É onde os erros caros aconteceram — tema nulo virando despejo do acervo
// (#125), e pedido claro que não virou busca ("Sobre peixe", "Futebol").
// Julgamento vale modelo melhor; a prosa depois segue no Haiku, que já dá
// conta do recado e é barato. Trocável por env se o custo incomodar.
const MODEL_DECISAO = process.env.BLUBLU_MODEL_DECISAO || 'claude-sonnet-4-6';
const DAILY_LIMIT = 60;
const QTD_PADRAO = 30;          // teto do material FRACO (fill por views / só filtro)
// Teto de sanidade da entrega: só existe pra não estourar o payload. Fica bem
// acima do que o acervo devolve (maior caso real observado: 115 candidatos).
// Vídeo que passou no portão de precisão NÃO fica retido esperando vaga.
const TETO_ENTREGA = parseInt(process.env.BLUBLU_TETO_ENTREGA, 10) || 200;

// Ídolos oficiais do Blublu (mesmo easter egg da BlueTendências): quando o
// canal aparece no resultado, ele vira fã histérico — lore do produto.
const IDOLOS = [
  { nome: 'Luiz Stubbe', patterns: ['luiz stubbe', 'luiz_stubbe', 'opiska'] },
  { nome: 'Giuliana Mafra', patterns: ['giuliana mafra', 'cortes giuliana mafra oficial', 'giulianamafra'] },
];
const MAX_CANDIDATOS = 100;     // recall LARGO (o corte por views aos 40 escondia
                                // o video certo atras de genericos populares —
                                // caso do tigre na arvore); entrega cirurgica
                                // fica por conta do ranking de relevancia
const MAX_TRANSCREVER = 10;     // novas transcrições por mensagem (latência)
const TRANSC_PARALELAS = 4;     // concorrência no Railway
const BUDGET_TRANSC_MS = 20000; // orçamento de tempo da confirmação
// Sobrenomes que TAMBÉM são palavra comum (pt/en): NÃO podem virar termo solto
// (buscar "styles" traz "hairstyles", "grande" traz "grande"=big). Distintivos
// (Haaland, Yamal, Eilish) ficam de fora e podem buscar sozinhos — é o que
// destrava o volume de nome próprio sem quebrar a precisão.
const SOBRENOME_COMUM = new Set(['styles', 'grande', 'brown', 'white', 'black', 'green', 'west', 'king', 'young', 'hall', 'park', 'wood', 'stone', 'snow', 'love', 'price', 'banks', 'fields', 'winter', 'summer', 'cook', 'baker', 'smith', 'jones', 'gray', 'grey', 'bell', 'hill', 'lake', 'moon', 'star', 'rose', 'silva', 'santos', 'costa', 'souza', 'sousa', 'lima', 'rocha', 'dias', 'ramos', 'campos', 'gomes', 'neves', 'pinto', 'cruz', 'reis', 'melo', 'lopes', 'martins', 'day', 'best', 'long', 'rich', 'wise', 'ford',
  // sobrenomes comuns 6+ letras (senão o gate "distintivo" os liberaria solo e
  // pescariam homônimo — bug 2026-07-20 "Whindersson Nunes"→"chris2nunes")
  'nunes', 'ferreira', 'oliveira', 'rodrigues', 'almeida', 'pereira', 'carvalho', 'barbosa', 'ribeiro', 'monteiro', 'cardoso', 'teixeira', 'correia', 'mendes', 'moreira', 'freitas', 'araujo', 'fernandes', 'vieira', 'nascimento', 'andrade', 'batista', 'castro', 'fonseca', 'borges', 'garcia', 'gonzalez', 'hernandez', 'martinez', 'sanchez', 'morales', 'gomez', 'williams', 'johnson', 'jackson', 'walker', 'wright', 'roberts', 'phillips', 'campbell', 'mitchell', 'richardson', 'morris', 'murphy', 'cooper', 'peterson', 'wilson', 'taylor', 'thomas', 'moore', 'martin', 'harris', 'clark', 'lewis', 'young']);
// primeiros nomes comuns (6+ letras) — ambíguos solo (Michael acha Michael
// Jordan, Gabriel acha qualquer um); só valem dentro do nome completo.
const PRIMEIRO_NOME_COMUM = new Set(['michael', 'gabriel', 'rafael', 'rafaela', 'ricardo', 'fernando', 'fernanda', 'patricia', 'rodrigo', 'roberto', 'eduardo', 'leonardo', 'gustavo', 'matheus', 'mateus', 'thiago', 'felipe', 'marcelo', 'marcela', 'mariana', 'juliana', 'camila', 'amanda', 'larissa', 'vinicius', 'guilherme', 'leandro', 'anderson', 'wesley', 'henrique', 'augusto', 'sabrina', 'priscila', 'bianca', 'carolina', 'beatriz', 'leticia', 'natalia', 'william', 'richard', 'robert', 'joseph', 'matthew', 'anthony', 'charles', 'daniel', 'andrew', 'joshua', 'jessica', 'jennifer', 'ashley', 'brandon', 'samantha', 'isabella', 'gabriela', 'antonio', 'roberta']);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  // Duas chaves: a do estúdio é a preferida (budget separado) e a principal é
  // a reserva. Isto já era a intenção do `||` original — só que escolher na
  // inicialização não cobre o caso que aconteceu em 29/07/2026: a chave do
  // estúdio EXISTIA e foi REJEITADA (401). Com a escolha feita antes da
  // chamada, a reserva nunca entrava e o Blublu ficava mudo.
  // A troca acontece só em 401/403 e é registrada no log (ver anthropicCall).
  // NÃO vale pra api/bluetendencias.js — lá o isolamento de budget é regra.
  const CHAVE_ESTUDIO = process.env.ANTHROPIC_API_KEY_STUDIO || '';
  const CHAVE_RESERVA = process.env.ANTHROPIC_API_KEY || '';
  const ANTHROPIC = CHAVE_ESTUDIO || CHAVE_RESERVA;
  const OPENAI = process.env.OPENAI_API_KEY || '';
  const RW = (process.env.RAILWAY_FFMPEG_URL || '').replace(/\/$/, '');
  if (!SU || !SK || !ANTHROPIC) return res.status(500).json({ error: 'config' });
  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  // ── AUTH: assinante vivo (Full ou Master) ──────────────────────────────────
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
          // 2026-08-02: Full ganhou o chat do Blublu (era só Master)
          const vivo = sub && (sub.plan === 'master' || sub.plan === 'full') && (sub.is_manual || !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date());
          if (vivo) userId = u.id;
        }
      }
    } catch (e) {}
  }
  if (!userId) return res.status(403).json({ error: 'Falar com o Blublu é exclusivo pra assinantes (Full ou Master).', upgrade: true });

  // ── EVENTOS DE APRENDIZADO (clique em card / enquete) ─────────────────────
  // Fora do limite diário: feedback nunca gasta mensagem do usuário.
  if (req.body?.action === 'evento') {
    const tipo = ['clique', 'enquete'].includes(req.body.tipo) ? req.body.tipo : null;
    if (!tipo) return res.status(400).json({ error: 'tipo' });
    const alvoEv = String(req.body.alvo || '').slice(0, 120);
    const valorEv = String(req.body.valor || '').slice(0, 40);
    await fetch(`${SU}/rest/v1/blublu_eventos`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({
      user_id: userId, tipo, alvo: alvoEv, valor: valorEv,
    }) }).catch(() => {});

    // ── O FEEDBACK PRECISA ENSINAR (2026-07-29) ──────────────────────────────
    // "Cravou / Quase / Viajou" era gravado e só alimentava painel: o Blublu
    // nunca ficava melhor por causa dele. Agora o veredito entra na MEMÓRIA do
    // usuário e volta no prompt da próxima conversa — tema que cravou vira
    // referência do gosto dele; tema que viajou faz ele fechar o cerco.
    if (tipo === 'enquete' && alvoEv && ['cravou', 'viajou'].includes(valorEv)) {
      try {
        const pr = await fetch(`${SU}/rest/v1/blublu_perfil?user_id=eq.${userId}&select=memoria`, { headers: H });
        const memAtual = (pr.ok ? (await pr.json())[0]?.memoria : null) || {};
        const campo = valorEv === 'cravou' ? 'cravou' : 'errou';
        const oposto = valorEv === 'cravou' ? 'errou' : 'cravou';
        const lista = [alvoEv, ...(Array.isArray(memAtual[campo]) ? memAtual[campo] : []).filter((t) => t !== alvoEv)].slice(0, 10);
        // o mesmo tema não pode viver nas duas listas: o veredito mais novo manda
        const listaOposta = (Array.isArray(memAtual[oposto]) ? memAtual[oposto] : []).filter((t) => t !== alvoEv).slice(0, 10);
        await fetch(`${SU}/rest/v1/blublu_perfil`, {
          method: 'POST',
          headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ user_id: userId, memoria: { ...memAtual, [campo]: lista, [oposto]: listaOposta }, atualizado_em: new Date().toISOString() }),
        });
      } catch (e) { /* feedback nunca pode quebrar a resposta */ }
    }
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
  // JANELA DE CONTEXTO (2026-07-29): eram 8 turnos cortados em 400 caracteres
  // — ele esquecia o pedido de três mensagens atrás e tratava complemento como
  // assunto novo. Com o cache de prompt pagando o input repetido, dá pra
  // segurar bem mais conversa sem doer no custo.
  const HIST_TURNOS = parseInt(process.env.BLUBLU_HIST_TURNOS, 10) || 20;
  const HIST_CHARS = parseInt(process.env.BLUBLU_HIST_CHARS, 10) || 1200;
  let history = Array.isArray(req.body?.history) ? req.body.history.slice(-HIST_TURNOS) : [];
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
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  async function executarBusca(inp) {
    // BLINDAGEM (forense 2026-07-18): o modelo às vezes manda termos/nucleos
    // com tema=null — sem isso o fluxo caía no ramo "só filtros" e DESPEJAVA
    // o top do acervo por views (os mesmos 24 sempre, caso Kidshire).
    const nucleosIn = Array.isArray(inp.nucleos) && inp.nucleos.length ? inp.nucleos : (Array.isArray(inp.termos) ? inp.termos : []);
    let tema = inp.tema ? String(inp.tema).slice(0, 120) : null;
    if (!tema && nucleosIn.length) tema = String(nucleosIn[0]).slice(0, 120);
    // quantidade: SÓ vale se o USUÁRIO falou um número (dígito ou por extenso)
    // — o modelo tentava "escolher o melhor" e entregava 1 (user reclamou 2x)
    const userFalouNumero = /\d/.test(message) || /\b(um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|quinze|vinte)\b/i.test(message);
    const qtd = (userFalouNumero && parseInt(inp.quantidade) > 0) ? Math.min(24, parseInt(inp.quantidade)) : QTD_PADRAO;
    // FILTRO INVENTADO MATA VOLUME (forense: "que mais explodiram" virou
    // min_views gigante → 1 vídeo). min_views só vale se o USUÁRIO falou
    // número/quantia; dias só com referência temporal explícita.
    const falouQuantia = /\d|\b(mil|milh[aã]o|milh[oõ]es|k\b|m\b)\b/i.test(message);
    const falouTempo = /\d|\b(hora|horas|dia|dias|semana|semanas|m[eê]s|meses|hoje|ontem|recente|últim)\w*/i.test(message);
    const minViews = falouQuantia ? Math.max(0, parseInt(inp.min_views) || 0) : 0;
    // JANELA DE TEMPO DETERMINÍSTICA (bug 2026-07-20: "12 horas" virava dias=1 ou
    // sumia → vídeo de 1 ano). O LLM erra a conversão hora↔dia e parseInt(0.5)=0;
    // extraímos direto do texto do usuário e só caímos no valor do modelo quando
    // não há número claro. Tudo em ms, sem arredondar pra dia inteiro.
    let janelaMs = 0;
    if (falouTempo) {
      const mlow = String(message).toLowerCase();
      const grab = (re) => { const x = mlow.match(re); return x ? parseFloat(x[1].replace(',', '.')) : 0; };
      janelaMs = grab(/(\d+(?:[.,]\d+)?)\s*h(?:oras?|rs?)?\b/) * 3600000
        + grab(/(\d+(?:[.,]\d+)?)\s*dias?\b/) * 86400000
        + grab(/(\d+(?:[.,]\d+)?)\s*semanas?\b/) * 7 * 86400000
        + grab(/(\d+(?:[.,]\d+)?)\s*(?:m[eê]s|meses)\b/) * 30 * 86400000;
      if (!janelaMs) {
        if (/\bhoje\b/.test(mlow)) janelaMs = 86400000;
        else if (/\bontem\b/.test(mlow)) janelaMs = 2 * 86400000;
        else janelaMs = (parseFloat(inp.horas) || 0) * 3600000 + (parseFloat(inp.dias) || 0) * 86400000;
      }
    }
    const desdeISO = janelaMs ? new Date(Date.now() - janelaMs).toISOString() : null;
    const nicho = ['curiosidades', 'games', 'ia', 'animais', 'artistas', 'pessoas_blogs', 'culinaria'].includes(inp.nicho) ? inp.nicho : null;
    const ordem = inp.ordem === 'recentes' ? 'publicado_em.desc' : 'views.desc';
    const plat = inp.plataforma === 'tiktok' ? 'tiktok' : inp.plataforma === 'instagram' ? 'instagram' : (inp.plataforma === 'youtube' ? 'youtube' : null);
    let termos = nucleosIn.map((t) => String(t).trim()).filter((t) => t.length >= 2).slice(0, 8);
    if (tema && !termos.length) termos = [tema];

    const parts = ['select=youtube_id,titulo,thumbnail_url,url,canal_nome,views,publicado_em,nicho'];
    if (minViews) parts.push(`views=gte.${minViews}`);
    if (desdeISO) parts.push(`publicado_em=gte.${desdeISO}`);
    if (nicho) parts.push(`nicho=eq.${encodeURIComponent(nicho)}`);

    let candidatos = [];
    const clean = (t) => t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    // PRECISÃO > volume (regra do user: na dúvida, não manda): termo solto
    // curto demais (tipo "ney") pesca lixo — só passa termo com 4+ letras,
    // com dígito (CR7) ou composto ("michael jackson")
    let termosOk = termos.map(clean).filter((t) => t.length >= 4 || /\d/.test(t) || t.includes(' '));
    // NOME PRÓPRIO composto: o PRIMEIRO nome é ambíguo ("harry" acha Harry
    // Potter, "billie" acha Billie Jean) — proibido solto. MAS o SOBRENOME
    // distintivo (Haaland, Yamal) é o identificador real e a forma que os
    // títulos MAIS usam: mantê-lo destrava o volume (forense 2026-07-18:
    // "Erling Haaland" sozinho achava 1 vídeo; +"Haaland" = 33). Sobrenome que
    // é palavra comum (Styles→hairstyles) fica de fora — precisão primeiro.
    if (inp.tipo_tema === 'nome_proprio' && tema && tema.trim().includes(' ')) {
      const temaN = norm(clean(tema));
      const partes = temaN.split(' ').filter(Boolean);
      // TOKEN DISTINTIVO pode buscar solo — seja PRIMEIRO nome (Whindersson) ou
      // SOBRENOME (Haaland). Distintivo = 6+ letras e não é nome/sobrenome banal.
      // Tokens curtos/comuns (Nunes, Harry, Michael) só valem na frase completa,
      // senão pescam homônimo (bug 2026-07-20: "Whindersson Nunes"→"chris2nunes":
      // o código antigo jogava fora "whindersson" e mantinha "nunes"). Isso
      // destrava volume do nome único E blinda a precisão do sobrenome comum.
      const distintivo = (w) => w.length >= 6 && !SOBRENOME_COMUM.has(w) && !PRIMEIRO_NOME_COMUM.has(w);
      const solos = partes.filter(distintivo);
      termosOk = termosOk.filter((t) => {
        const tn = norm(t);
        return tn.includes(' ') || !partes.includes(tn) || solos.includes(tn);
      });
      for (const s of solos) if (!termosOk.some((t) => norm(t) === s)) termosOk.push(s);
      if (!termosOk.length) termosOk = [clean(tema)];
    }
    // rede de segurança: se o modelo só mandou frases compostas de ASSUNTO
    // ("tigre escalando arvore"), extrai o núcleo e busca sozinho também
    if (inp.tipo_tema !== 'nome_proprio' && tema && termosOk.length && termosOk.every((t) => t.includes(' '))) {
      const nucleo = clean(tema).split(' ').filter((w) => w.length >= 4);
      if (nucleo.length) termosOk.push(nucleo[0]);
    }
    const secParts = ['select=youtube_id,titulo,thumbnail_url,url,canal_nome,views,publicado_em'];
    if (minViews) secParts.push(`views=gte.${minViews}`);
    if (desdeISO) secParts.push(`publicado_em=gte.${desdeISO}`);
    const tkBase = ['select=tiktok_video_id,video_url,thumbnail_url,caption,author_name,views_count,tiktok_created_at', 'status=eq.active'];
    if (minViews) tkBase.push(`views_count=gte.${minViews}`);
    if (desdeISO) tkBase.push(`tiktok_created_at=gte.${desdeISO}`);
    const mapTk = (v) => ({
      youtube_id: null, _tiktok_id: v.tiktok_video_id, titulo: (v.caption || '').slice(0, 200) || 'TikTok de ' + (v.author_name || ''),
      thumbnail_url: v.thumbnail_url, url: v.video_url, canal_nome: v.author_name, views: v.views_count, publicado_em: v.tiktok_created_at, _tiktok: true,
    });
    // Instagram Virais (2026-07-25): mesmo desenho do TikTok — acervo curado
    // em instagram_virais, busca por caption/autor, views reais (play_count)
    const igBase = ['select=shortcode,video_url,thumbnail_url,caption,author_name,author_handle,views_count,ig_created_at', 'status=eq.active'];
    if (minViews) igBase.push(`views_count=gte.${minViews}`);
    if (desdeISO) igBase.push(`ig_created_at=gte.${desdeISO}`);
    const mapIg = (v) => ({
      youtube_id: null, _ig_id: v.shortcode, titulo: (v.caption || '').slice(0, 200) || 'Reel de ' + (v.author_name || v.author_handle || ''),
      thumbnail_url: v.thumbnail_url, url: v.video_url, canal_nome: v.author_name || v.author_handle, views: v.views_count, publicado_em: v.ig_created_at, _instagram: true,
    });

    if (tema && termosOk.length) {
      // título E canal ("vídeos do Luiz Stubbe" = canal), termo a termo encodado
      const orExpr = 'or=(' + termosOk.map((t) => `titulo.ilike.*${encodeURIComponent(t)}*,canal_nome.ilike.*${encodeURIComponent(t)}*`).join(',') + ')';
      if (plat !== 'tiktok' && plat !== 'instagram') {
        const r1 = await fetch(`${SU}/rest/v1/virais_banco?${parts.join('&')}&${orExpr}&order=${ordem}&limit=${MAX_CANDIDATOS}`, { headers: H });
        if (r1.ok) candidatos = await r1.json();
        // NICHO SECRETO FORA da busca do Blublu (ordem do user 2026-07-18):
        // acervo do chat = Virais (banco principal + TikTok), secretos só no filtro da página.
      }
      if (plat !== 'youtube' && plat !== 'instagram') try {
        const tkOr = 'or=(' + termosOk.map((t) => `caption.ilike.*${encodeURIComponent(t)}*,author_name.ilike.*${encodeURIComponent(t)}*,author_handle.ilike.*${encodeURIComponent(t)}*`).join(',') + ')';
        const rt = await fetch(`${SU}/rest/v1/tiktok_virais?${tkBase.join('&')}&${tkOr}&order=views_count.desc&limit=${plat === 'tiktok' ? 40 : 15}`, { headers: H });
        if (rt.ok) candidatos = candidatos.concat((await rt.json()).map(mapTk));
      } catch (e) {}
      if (plat !== 'youtube' && plat !== 'tiktok') try {
        const igOr = 'or=(' + termosOk.map((t) => `caption.ilike.*${encodeURIComponent(t)}*,author_name.ilike.*${encodeURIComponent(t)}*,author_handle.ilike.*${encodeURIComponent(t)}*`).join(',') + ')';
        const ri = await fetch(`${SU}/rest/v1/instagram_virais?${igBase.join('&')}&${igOr}&order=views_count.desc&limit=${plat === 'instagram' ? 40 : 15}`, { headers: H });
        if (ri.ok) candidatos = candidatos.concat((await ri.json()).map(mapIg));
      } catch (e) {}
      // REMOVIDO (2026-07-18): a busca direta no cache de transcrições era
      // VENENO de precisão — re-injetava como candidato qualquer vídeo que
      // MENCIONASSE o termo na fala (vídeo infantil cantando "tiger" voltava
      // toda vez, mesmo com o cache sendo só o efeito colateral de buscas
      // antigas). Transcrição agora faz o papel original do desenho do user:
      // CONFIRMAR candidatos achados por tema — nunca ser fonte de candidato.
      // semântica opcional (completa candidatos com títulos que não citam o termo)
      if (OPENAI && plat !== 'tiktok' && plat !== 'instagram' && candidatos.length < MAX_CANDIDATOS) {
        try {
          const er = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { Authorization: 'Bearer ' + OPENAI, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'text-embedding-3-small', input: tema }) });
          const ed = await er.json();
          const emb = ed?.data?.[0]?.embedding;
          if (emb) {
            const rr = await fetch(`${SU}/rest/v1/rpc/blublu_match_videos`, { method: 'POST', headers: H, body: JSON.stringify({ query_embedding: emb, match_count: MAX_CANDIDATOS, min_views: minViews, desde: desdeISO }) });
            if (rr.ok) {
              const ids = (await rr.json()).filter((m) => m.similarity > 0.45).map((m) => m.youtube_id).filter((id) => !candidatos.some((c) => c.youtube_id === id)).slice(0, MAX_CANDIDATOS - candidatos.length);
              if (ids.length) {
                const r2 = await fetch(`${SU}/rest/v1/virais_banco?${parts.join('&')}&youtube_id=in.(${ids.map(encodeURIComponent).join(',')})&order=${ordem}`, { headers: H });
                // marca a origem: candidato vindo de embedding é parente do
                // tema mesmo sem casar palavra — o fill precisa saber disso
                // pra não confundir com quem só bateu no nome do canal
                if (r2.ok) candidatos = candidatos.concat((await r2.json()).map((c) => ({ ...c, _semantico: true })));
              }
            }
          }
        } catch (e) {}
      }
    } else {
      // só filtros: SQL direto no acervo completo — MAS só quando há filtro
      // REAL. Sem tema, sem termos E sem filtro = pedido sem critério: devolve
      // vazio pro modelo pedir esclarecimento (jamais despejar top views).
      const temFiltroReal = !!(minViews || janelaMs || nicho || plat || inp.ordem);
      if (!temFiltroReal) {
        return { videos: [], temMais: false, verificadosIds: [], resumo: { erro: 'pedido_sem_criterio', instrucao: 'Nenhum tema nem filtro identificado. Pergunte ao usuário o que ele quer (tema, canal ou filtro) — NÃO invente resultados.' } };
      }
      if (plat !== 'tiktok' && plat !== 'instagram') {
        const r1 = await fetch(`${SU}/rest/v1/virais_banco?${parts.join('&')}&order=${ordem}&limit=30`, { headers: H });
        if (r1.ok) candidatos = await r1.json();
      }
      try {
        // (nicho secreto fora — ordem do user)
        if (!nicho && plat !== 'youtube' && plat !== 'instagram') {
          const rt = await fetch(`${SU}/rest/v1/tiktok_virais?${tkBase.join('&')}&order=views_count.desc&limit=${plat === 'tiktok' ? 30 : 15}`, { headers: H });
          if (rt.ok) candidatos = candidatos.concat((await rt.json()).map(mapTk));
        }
        if (!nicho && plat !== 'youtube' && plat !== 'tiktok') {
          const ri = await fetch(`${SU}/rest/v1/instagram_virais?${igBase.join('&')}&order=views_count.desc&limit=${plat === 'instagram' ? 30 : 15}`, { headers: H });
          if (ri.ok) candidatos = candidatos.concat((await ri.json()).map(mapIg));
        }
        const pTk = (v) => ((plat !== 'tiktok' && v._tiktok) || (plat !== 'instagram' && v._instagram)) ? 1 : 0; // YouTube primeiro
        candidatos.sort((a, b) => pTk(a) - pTk(b) || (ordem === 'publicado_em.desc' ? new Date(b.publicado_em || 0) - new Date(a.publicado_em || 0) : (b.views || 0) - (a.views || 0)));
      } catch (e) {}
    }

    // confirmação por transcrição (YouTube; TikTok confirma por caption/autor)
    const termosN = termosOk.map(norm);
    const qualifN = (Array.isArray(inp.qualificadores) ? inp.qualificadores : []).map((q) => norm(clean(String(q)))).filter((q) => q.length >= 3).slice(0, 16);
    // MATCH POR PALAVRA em token único ASCII (bug 2026-07-20: "nunes" casava
    // "chris2nunes", "ney" casaria "disney"). Frase composta / termo não-ASCII
    // (cirílico etc.) seguem substring, que já é específico o bastante.
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const soPalavra = (t) => t && !t.includes(' ') && /^[\x00-\x7f]+$/.test(t);
    const reBate = termosN.map((t) => soPalavra(t) ? new RegExp('\\b' + escRe(t) + '\\b') : null);
    const reConta = termosN.map((t) => soPalavra(t) ? new RegExp('\\b' + escRe(t) + '\\b', 'g') : null);
    // frase composta também casa na forma COLADA de hashtag/handle ("oliver
    // tree" → "#olivertree"): fã-content real caía pra mero 'relacionado'
    // (análise 2026-07-23, caso Oliver Tree)
    const concatN = termosN.map((t) => (t && t.includes(' ')) ? t.replace(/ /g, '') : null);
    const bateAlgum = (texto) => termosN.some((t, i) => reBate[i] ? reBate[i].test(texto) : (t ? (texto.includes(t) || (concatN[i] && texto.includes(concatN[i]))) : false));
    const contaTotal = (texto) => termosN.reduce((n, t, i) => n + (reConta[i] ? (texto.match(reConta[i]) || []).length : (t ? texto.split(t).length - 1 : 0)), 0);
    let videos = [], temMais = false, verificadosIds = [];
    if (tema && candidatos.length) {
      const ids = candidatos.filter((c) => c.youtube_id).map((c) => c.youtube_id);
      const tr = ids.length ? await fetch(`${SU}/rest/v1/virais_transcricoes?youtube_id=in.(${ids.map(encodeURIComponent).join(',')})&select=youtube_id,transcript,segments,sem_legenda`, { headers: H }) : { ok: false };
      const cache = tr.ok ? await tr.json() : [];
      const cacheMap = new Map(cache.map((c) => [c.youtube_id, c]));
      const pendentes = candidatos.filter((c) => c.youtube_id && !cacheMap.has(c.youtube_id) && !skipIds.has(c.youtube_id));
      const faltam = pendentes.slice(0, MAX_TRANSCREVER);
      temMais = pendentes.length > faltam.length;
      if (RW && faltam.length) {
        const t0 = Date.now();
        const fila = [...faltam];
        await Promise.all(Array.from({ length: TRANSC_PARALELAS }, async () => {
          while (fila.length && Date.now() - t0 < BUDGET_TRANSC_MS) {
            const c = fila.shift();
            try {
              const r = await fetch(`${RW}/yt-subs?v=${encodeURIComponent(c.youtube_id)}&seg=1`, { signal: AbortSignal.timeout(9000) });
              const row = { youtube_id: c.youtube_id, fonte: 'railway' };
              if (r.ok) {
                const d = await r.json();
                row.transcript = d.content || ''; row.segments = d.segments || null; row.lang = d.lang || null; row.sem_legenda = !d.content;
              } else { row.sem_legenda = true; }
              cacheMap.set(c.youtube_id, row);
              await fetch(`${SU}/rest/v1/virais_transcricoes`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
            } catch (e) {}
          }
        }));
        temMais = temMais || fila.length > 0;
      }
      for (const c of candidatos) {
        const tituloBate = bateAlgum(norm(c.titulo));
        // NOME DO CANAL SÓ VALE PRA NOME PRÓPRIO (forense 2026-07-29).
        // Buscar "curiosidades da Disney" casava com canais chamados "A2 Facts
        // Forid", "Facts Xpose" — e o usuário recebia 30 vídeos de carro na
        // chuva e pegadinha de futebol, zero Disney (log #120, relevância 0).
        // Já em "Oliver Tree" o canal é o identificador MAIS confiável que
        // existe (log #127). Então: identifica pessoa/criador → conta; é tema
        // → é só coincidência de palavra no nome do canal, não conta.
        const canalBate = inp.tipo_tema === 'nome_proprio' && bateAlgum(norm(c.canal_nome));
        const tc = c.youtube_id ? cacheMap.get(c.youtube_id) : null;
        let citadoEm = null, falaBate = false;
        if (tc && tc.transcript && !tc.sem_legenda) {
          const txt = norm(tc.transcript);
          // MENÇÃO DE PASSAGEM NÃO CONTA (video infantil cantando "tiger" 1x
          // entrava como confirmado — user pegou). Fala só confirma sozinha se
          // o termo aparece 2+ vezes; 1 menção precisa do título junto.
          const occ = contaTotal(txt);
          falaBate = occ >= 2 || (occ >= 1 && tituloBate);
          if (falaBate && Array.isArray(tc.segments)) {
            for (let i = 0; i < tc.segments.length; i++) {
              const seg = norm(tc.segments[i].x) + ' ' + norm(tc.segments[i + 1]?.x || '');
              if (bateAlgum(seg)) { citadoEm = tc.segments[i].t; break; }
            }
          }
        }
        if (falaBate || tituloBate || canalBate) {
          // RANKING CIRÚRGICO: cada qualificador distinto do pedido achado no
          // título/fala soma ponto — "tigre escalando árvore" rankeia o tigre
          // NA ÁRVORE acima do tigre genérico de 20M views
          let score = 0;
          const alvo = norm(c.titulo) + ' ' + (tc && tc.transcript ? norm(tc.transcript).slice(0, 4000) : '');
          for (const q of qualifN) if (q && alvo.includes(q)) score++;
          videos.push({ youtube_id: c.youtube_id, titulo: c.titulo, thumbnail_url: c.thumbnail_url, url: c.url, canal_nome: c.canal_nome, views: c.views, publicado_em: c.publicado_em, citado_em_s: citadoEm, confirmado_por: falaBate ? 'fala' : (canalBate ? 'canal' : 'titulo'), plataforma: c._instagram ? 'instagram' : c._tiktok ? 'tiktok' : 'youtube', secreto: !!c._secreto, _score: score });
        }
      }
      const peso = { fala: 0, canal: 1, titulo: 2 };
      // PRIORIDADE YOUTUBE (user 2026-07-18): YouTube Shorts sempre na frente —
      // TikTok tem views absurdas e dominava o sort; só lidera se o usuário
      // pedir TikTok explicitamente (plat === 'tiktok').
      const pPlat = (v) => ((plat !== 'tiktok' && v.plataforma === 'tiktok') || (plat !== 'instagram' && v.plataforma === 'instagram')) ? 1 : 0;
      videos.sort((a, b) => pPlat(a) - pPlat(b) || (b._score || 0) - (a._score || 0) || (peso[a.confirmado_por] ?? 3) - (peso[b.confirmado_por] ?? 3) || (b.views || 0) - (a.views || 0));
      // NOVA DIRETRIZ (user 2026-07-18): VOLUME MÁXIMO do tema. Qualificador
      // ORDENA (quem bate sobe), NUNCA exclui — o portão antigo cortava tudo
      // quando o modelo punha palavra genérica ("shorts") como qualificador
      // (caso Lamine Yamal: 2 vídeos). A única exclusão que fica é a menção de
      // passagem na fala (occ<2 sem título), que era lixo real.
      // VOLUME FILL: se ainda couber, completa com os demais candidatos do
      // tema (recall/semântica) marcados 'relacionado', por views.
      if (videos.length < qtd) {
        const jaTem = new Set(videos.map((v) => v.youtube_id || v.url));
        // PRECISÃO-PRIMEIRO (user 2026-07-23): em busca de NOME PRÓPRIO o fill
        // NÃO admite candidato que não cita o nome de verdade — o recall por
        // substring trazia lixo ("@swennoliver"/"OliverVisualFX" na busca
        // "Oliver Tree") e o card saía como 'relacionado'. Nome próprio sem
        // match real = fora. Tema comum mantém o fill por views (VOLUME).
        const resto = candidatos.filter((c) => !jaTem.has(c.youtube_id || c.url))
          // O FILL TAMBÉM PRECISA DE PRECISÃO (forense 2026-07-29): tirar o
          // canal da camada forte não bastou — os mesmos vídeos voltavam aqui
          // como 'relacionado', porque a consulta SQL casa título OU canal.
          // Quem entrou só pelo nome do canal num pedido TEMÁTICO é ruído e
          // fica fora. Candidato vindo de embedding (_semantico) passa: ele é
          // parente do tema mesmo sem repetir a palavra.
          .filter((c) => (inp.tipo_tema === 'nome_proprio'
            ? bateAlgum(norm(c.titulo) + ' ' + norm(c.canal_nome))
            : (c._semantico || bateAlgum(norm(c.titulo)))))
          .sort((a, b) => (((plat !== 'tiktok' && a._tiktok) || (plat !== 'instagram' && a._instagram)) ? 1 : 0) - (((plat !== 'tiktok' && b._tiktok) || (plat !== 'instagram' && b._instagram)) ? 1 : 0) || (b.views || 0) - (a.views || 0))
          .slice(0, qtd - videos.length)
          .map((c) => ({ youtube_id: c.youtube_id, titulo: c.titulo, thumbnail_url: c.thumbnail_url, url: c.url, canal_nome: c.canal_nome, views: c.views, publicado_em: c.publicado_em, citado_em_s: null, confirmado_por: 'relacionado', plataforma: c._instagram ? 'instagram' : c._tiktok ? 'tiktok' : 'youtube', secreto: false, _score: 0 }));
        videos = videos.concat(resto);
      }
      verificadosIds = candidatos.filter((c) => c.youtube_id && cacheMap.has(c.youtube_id)).map((c) => c.youtube_id);
    } else {
      // SEM TEMA: só entrega se o usuário deu um critério DE VERDADE (views,
      // janela de tempo, nicho ou plataforma). "Mega viral" e "top 3 do seu
      // acervo" (logs #125/#115) não são critério — caíam aqui e despejavam o
      // topo do acervo por views, sem relação nenhuma com o pedido. Sem
      // critério, devolve vazio e o modelo PERGUNTA em vez de fingir entrega.
      const temCriterioReal = !!(minViews || desdeISO || nicho || plat);
      videos = temCriterioReal
        ? candidatos.map((c) => ({ youtube_id: c.youtube_id, titulo: c.titulo, thumbnail_url: c.thumbnail_url, url: c.url, canal_nome: c.canal_nome, views: c.views, publicado_em: c.publicado_em, citado_em_s: null, confirmado_por: 'filtro', plataforma: c._instagram ? 'instagram' : c._tiktok ? 'tiktok' : 'youtube', secreto: !!c._secreto }))
        : [];
    }
    // ── REGRA DE OURO: precisão primeiro, e aí TODO o volume preciso ─────────
    // O teto fixo de 30 segurava vídeo BOM na base: 579 vídeos que casaram o
    // critério ficaram retidos em 11 buscas (pior caso: 115 no banco, 30
    // entregues). Agora quem passou no portão de precisão vai INTEIRO; o teto
    // continua valendo só pro material fraco (fill por views / só filtro).
    // Se o usuário pediu um número ("top 3"), o número dele manda — sempre.
    const FORTE = new Set(['fala', 'titulo', 'canal']); // canal aqui já é nome próprio
    const fortes = videos.filter((v) => FORTE.has(v.confirmado_por));
    const fracos = videos.filter((v) => !FORTE.has(v.confirmado_por));
    let cortados = 0;
    if (userFalouNumero) {
      cortados = Math.max(0, videos.length - qtd);
      videos = videos.slice(0, qtd);
    } else {
      // teto de sanidade só pra não estourar payload — fica MUITO acima do que
      // o acervo devolve hoje (maior caso observado: 115)
      const fracosCabem = Math.max(0, qtd - fortes.length);
      const escolhidos = fortes.concat(fracos.slice(0, fracosCabem)).slice(0, TETO_ENTREGA);
      cortados = Math.max(0, videos.length - escolhidos.length);
      videos = escolhidos;
    }

    // memória de temas
    if (tema) {
      const temasNovos = [tema, ...memoTemas.filter((t) => t !== tema)].slice(0, 5);
      // preferência revelada pelo uso: o nicho/plataforma que ele mais pede
      // vira contexto do prompt (ver contextoUser)
      const contN = { ...(perfil.memoria?.cont_nicho || {}) };
      if (nicho) contN[nicho] = (contN[nicho] || 0) + 1;
      const contP = { ...(perfil.memoria?.cont_plat || {}) };
      if (plat) contP[plat] = (contP[plat] || 0) + 1;
      const topo = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      await salvarPerfil({ memoria: {
        ...perfil.memoria, perguntou_nome: true, temas: temasNovos,
        buscas: (perfil.memoria?.buscas || 0) + 1,
        cont_nicho: contN, cont_plat: contP,
        nicho_preferido: topo(contN), plataforma_preferida: topo(contP),
      } });
    }

    // ídolo no resultado? (easter egg fã histérico — mesmo lore da BlueTendências)
    const idolosNoResultado = [...new Set(videos.map((v) => {
      const c = norm(v.canal_nome);
      const hit = IDOLOS.find((i) => i.patterns.some((p) => c === p || c.includes(p)));
      return hit ? hit.nome : null;
    }).filter(Boolean))];

    // DIRETOS = casaram no tema de verdade (fala/título/canal). O resto é
    // "relacionado" (volume fill) ou "filtro". Precisão-primeiro: se os diretos
    // são poucos, o modelo AVISA em vez de fingir fartura.
    const diretos = videos.filter((v) => ['fala', 'titulo', 'canal'].includes(v.confirmado_por)).length;
    const buscaTematica = !!(tema && termosOk.length);
    // ESTRATÉGIA que trouxe os resultados — pra auditoria de precisão/cobertura:
    // 'tematica' = casou no tema (deve ser preciso); 'filtro' = só filtro numérico
    // (top views, sem tema); 'vazio' = nada. total_no_banco/cortados medem cobertura.
    const estrategia = buscaTematica ? (diretos > 0 ? 'tematica' : 'tematica_sem_direto') : (videos.length ? 'filtro' : 'vazio');
    // resumo pro MODELO comentar com propriedade (os cards o front renderiza)
    const resumo = {
      total_entregue: videos.length,
      confirmados_na_fala: videos.filter((v) => v.confirmado_por === 'fala').length,
      do_canal: videos.filter((v) => v.confirmado_por === 'canal').length,
      pelo_titulo: videos.filter((v) => v.confirmado_por === 'titulo').length,
      diretos_do_tema: diretos,
      relacionados_complemento: videos.filter((v) => v.confirmado_por === 'relacionado').length,
      // COBERTURA FINA: busca de tema trouxe POUCOS diretos (<=4). O modelo deve
      // ser transparente (número real + oferecer ampliar), nunca fingir fartura.
      cobertura_fina: buscaTematica && diretos > 0 && diretos <= 4,
      tinha_mais_alem_do_entregue: cortados > 0,
      ha_candidatos_ainda_nao_verificados: temMais,
      com_relevancia_exata: videos.filter((v) => (v._score || 0) > 0).length,
      idolos_no_resultado: idolosNoResultado,
      // AUDITORIA DE COBERTURA (regra de ouro: precisão > quantidade)
      estrategia,
      total_no_banco: candidatos.length,       // quantos casaram o critério no acervo
      cortados_por_limite: cortados,            // tinha mais, não coube na quantidade pedida
      amostra: videos.slice(0, 6).map((v) => ({ titulo: (v.titulo || '').slice(0, 70), canal: v.canal_nome, views: v.views, confirmado_por: v.confirmado_por, bateu_qualificadores: (v._score || 0) > 0 })),
    };
    return { videos, temMais, verificadosIds, resumo, janela_h: +(janelaMs / 3600000).toFixed(2) };
  }

  // ── FERRAMENTAS (o modelo decide) ──────────────────────────────────────────
  const tools = [
    {
      name: 'buscar_videos',
      description: 'Busca vídeos no SEU acervo de virais (YouTube curado + canais secretos + TikTok). Use SEMPRE que o usuário pedir vídeos — por tema, canal/criador ou filtros. NUNCA invente vídeos: só fale do que esta ferramenta devolver.',
      input_schema: {
        type: 'object',
        properties: {
          tema: { type: ['string', 'null'], description: 'OBRIGATÓRIO sempre que o pedido menciona QUALQUER assunto/pessoa/canal (ex: "chimpanzé", "Lebron James"). null APENAS em busca puramente numérica/temporal ("mais de 5mi em 2 semanas"). JAMAIS deixe null com nucleos preenchidos.' },
          tipo_tema: { type: ['string', 'null'], description: '"nome_proprio" (pessoa, artista, canal, marca — ex: Harry Styles, Billie Eilish) ou "assunto" (conceito comum — ex: tigre, futebol)' },
          nucleos: { type: 'array', items: { type: 'string' }, description: 'APENAS o substantivo-núcleo e suas traduções/apelidos. nome_proprio → nome COMPLETO intacto + grafias ("harry styles","harrystyles"), JAMAIS separar palavras. assunto → traduções nos idiomas do acervo. PROIBIDO verbos, adjetivos ou o resto do pedido aqui — isso vai em qualificadores. EXEMPLO pedido "tigre subindo em árvore": nucleos=["tigre","tiger","тигр","虎"] (SÓ o bicho!), qualificadores=["subindo","escalando","climbing","árvore","tree","árbol"].' },
          qualificadores: { type: 'array', items: { type: 'string' }, description: 'SÓ características do CONTEÚDO além do núcleo (ação, objeto, contexto), pt+en+es — servem pra ORDENAR os melhores primeiro, nunca excluem ninguém. PROIBIDO palavra de formato/plataforma ("shorts","video","youtube","tiktok","viral") — isso NÃO é qualificador. Vazio na dúvida.' },
          min_views: { type: ['number', 'null'], description: 'views mínimas se o usuário pediu. CONVERSÃO EXATA (nunca confunda): "mil" = 1000, "5 mil" = 5000, "500 mil" = 500000; "milhão"/"milhões"/"mi"/"M" = 1000000, "2 milhões" = 2000000; "k" = 1000. "500 mil" JAMAIS é 500000000.' },
          dias: { type: ['number', 'null'], description: 'janela em DIAS ("últimas 2 semanas" = 14, "3 dias" = 3). Se o pedido for em HORAS use o campo horas — NUNCA arredonde horas pra dias.' },
          horas: { type: ['number', 'null'], description: 'janela em HORAS quando o pedido é em horas ("últimas 12 horas" = 12, "nas últimas 6h" = 6). Use ISTO em vez de dias pra janelas menores que um dia.' },
          nicho: { type: ['string', 'null'], description: 'um de: curiosidades, games, ia, animais, artistas, pessoas_blogs, culinaria' },
          ordem: { type: ['string', 'null'], description: '"views" (padrão) ou "recentes". OBRIGATÓRIO "recentes" quando o usuário falar "mais recente", "último", "novo", "essa semana" etc.' },
          plataforma: { type: ['string', 'null'], description: '"youtube", "tiktok" ou "instagram" quando o usuário restringir ("só TikTok", "reels do Instagram", "sem YouTube"). null = todas' },
          quantidade: { type: ['number', 'null'], description: 'SÓ se o usuário pediu número exato de vídeos. null = padrão saudável' },
        },
      },
    },
    {
      name: 'definir_apelido',
      description: 'Salva como o usuário quer ser chamado. Use quando ele disser o nome/apelido dele (ex: "me chama de Fê", "pode ser Felipe mesmo").',
      input_schema: { type: 'object', properties: { apelido: { type: 'string' } }, required: ['apelido'] },
    },
  ];

  // ── MEMÓRIA DO USUÁRIO (2026-07-29) ───────────────────────────────────────
  // Antes eram duas linhas: apelido + 5 temas. Agora ele lembra do que o
  // usuário GOSTOU (feedback "cravou"), do que REJEITOU, do nicho e da
  // plataforma preferida — é o que separa um buscador de um chat com contexto.
  // Este bloco NÃO entra no cache (muda por pessoa); o manifesto entra.
  const mem = perfil.memoria || {};
  const listar = (a, n) => (Array.isArray(a) ? a.slice(0, n).join(', ') : '');
  const contextoUser = [
    chamarDe ? `O usuário atende por "${chamarDe}" — usa o nome dele de vez em quando, natural.` : 'Você AINDA NÃO SABE como chamar o usuário — pergunta como ele prefere ser chamado (do seu jeito), na primeira oportunidade natural.',
    memoTemas.length ? `Temas que ele já buscou contigo: ${memoTemas.join(', ')} (${mem.buscas || 0} buscas no total).` : 'Primeira vez dele no teu chat de buscas.',
    listar(mem.cravou, 6) ? `ELE JÁ DISSE QUE CRAVOU nestes temas: ${listar(mem.cravou, 6)}. Esse é o gosto dele — quando o pedido for parecido, siga o mesmo caminho que deu certo.` : '',
    listar(mem.errou, 6) ? `ELE RECLAMOU do resultado nestes temas: ${listar(mem.errou, 6)}. Aí você fecha o cerco: seja mais literal, exija o termo no título, e prefira mandar menos e certo.` : '',
    mem.nicho_preferido ? `Nicho que ele mais busca: ${mem.nicho_preferido}.` : '',
    mem.plataforma_preferida ? `Plataforma preferida dele: ${mem.plataforma_preferida}.` : '',
  ].filter(Boolean).join(' ');

  const system = `${BLUBLU_MANIFESTO_V3}

─── ONDE VOCÊ ESTÁ AGORA ───
Chat "Falar com o Blublu" dentro da ferramenta Virais do BlueTube. Sua função: conversar E achar vídeos no SEU acervo de virais usando a ferramenta buscar_videos.

REGRAS DO CHAT:
- ★ REGRA SAGRADA DA ENTREGA — PRECISÃO, DEPOIS VOLUME (nessa ordem, sem inverter JAMAIS):
  1º PRECISÃO: cada vídeo tem que ser DE VERDADE sobre o que ele pediu. O usuário prefere 3 CRAVADOS a 30 mais-ou-menos — sempre. Vídeo que "tem a ver de longe", ou que veio marcado com um tema mas o título não bate (catálogo às vezes erra), NÃO conta como do tema: ou você SEPARA com honestidade ("3 no alvo; tenho mais X parecidos, quer?") ou não manda. Encher de quantidade sacrificando precisão quebra a confiança — é o pior erro que você comete.
  2º VOLUME: fixada a precisão, QUANTO MAIS MELHOR — MUITO mais melhor. Se sobraram 80 cravados do filtro, entrega os 80 (ou avisa que tem e traz). NUNCA segure volume de coisa CERTA.
  Ordem mental toda vez: primeiro filtra pelo que é REALMENTE do tema, DEPOIS entrega tudo que sobrou. Precisão é o portão; volume é o que passa por ele.
- Respostas CURTAS (1-4 frases). É chat, não palestra.
- Pedido de vídeos = chame buscar_videos. Conversa = responda direto, no personagem.
- ★ FLUXO PADRÃO DO ATENDIMENTO — ENTREGA PRIMEIRO, REFINO DEPOIS (ordem definida pelo dono, JAMAIS inverta): pediu QUALQUER coisa com assunto ("futebol", "oliver tree", "fails", "games", "pop", "animais", "curiosidades") → chama buscar_videos JÁ, entrega TUDO que for preciso do tema, e SÓ DEPOIS DOS CARDS fecha a resposta oferecendo refino: UMA pergunta curta com opções CONCRETAS tiradas do que você viu no resultado ("veio muito gol e muito Haaland — quer que eu afunile num deles?"). A pergunta de refino vem DEPOIS da entrega, NUNCA no lugar dela — caso real: usuário mandou "Futebol", levou interrogatório e ABANDONOU o chat sem voltar. Perguntar ANTES de buscar: só quando não existe substantivo nenhum ("me ajuda", "algo legal", "sei lá"). Na dúvida entre perguntar e buscar, BUSQUE.
- PEDIDO DE INSPIRAÇÃO SEM TEMA ("quero viralizar", "o que tá bombando", "me dá ideia pra estudar", "vídeos pra eu crescer") = NÃO INTERROGUE. Entrega JÁ um default forte na hora — busca os MEGA-VIRAIS / os mais em alta do acervo (ordem por views ou recentes) — e SÓ DEPOIS oferece afunilar por nicho. Uma pergunta de refino no MÁXIMO, e mesmo assim só se ele não topou o default. Deixar o cara sem nada nas mãos enquanto você pergunta "qual nicho?" duas vezes é o pior atendimento — dá material primeiro, refina em cima.
- REGRA SAGRADA (jamais quebre): NUNCA afirme que ACHOU/ENTREGOU vídeos — nem números ("87 vídeos", "entreguei 30", "tem mais 57 no banco") — sem ter chamado buscar_videos NESTA MESMA resposta. Os cards vêm SÓ da ferramenta; se você não buscou, NÃO EXISTE card, e prometer resultado é MENTIRA que quebra a confiança. Se o usuário disser "manda todos"/"todos que achar"/"continuar" e for continuação de um tema, CHAME buscar_videos com esse tema — nunca finja que já buscou.
- Os vídeos aparecem em CARDS abaixo da sua fala — NUNCA liste vídeos no texto.
- QUANTIDADE: NUNCA escolha quantidade por conta própria — deixe null e a busca entrega TODOS os certeiros (até ${QTD_PADRAO}). Só preencha quantidade se o USUÁRIO falou um número. Se sobrar mais (tinha_mais_alem_do_entregue / ha_candidatos_ainda_nao_verificados), avise que é só pedir.
- CAMPOS DA BUSCA: tema NUNCA null quando o pedido tem assunto/pessoa/canal. nucleos = SÓ o núcleo e traduções; verbos/adjetivos/contexto vão SEMPRE em qualificadores (misturar destrói a precisão — regra dura).
- VOLUME É REI: entregue TODOS os vídeos do tema que a busca devolver. NUNCA converta expressões como "que explodiram"/"em alta" em min_views — isso é só ordem por views. Filtro numérico APENAS quando o usuário falar um número. Nunca diga que "não tem" se a busca entregou vídeos ou marcou que há mais.
- PRECISÃO: termos INEQUÍVOCOS (nome completo, apelidos famosos) — nada de palavra solta genérica que traga vídeo errado. Na dúvida, melhor menos e certo.
- DATA: "mais recente", "último", "novo" = ordem "recentes" na busca, SEMPRE. Não responda recência com o mais visto.
- IDIOMAS: o acervo é GLOBAL (pt, en, es, fr, de, it, ja, ko, zh, ru). Sempre inclua nos termos o núcleo traduzido pro inglês e espanhol no mínimo. Só filtre nicho se o usuário pedir explicitamente.
- HONESTIDADE DE ACERVO: NUNCA afirme que o acervo tem ou não tem um assunto sem ter BUSCADO esse assunto. Nada de inventar inventário ("tenho leão, crocodilo…") — se quiser sugerir alternativas, diga que pode buscar, não que "tem".
- COBERTURA FINA (precisão > volume): se resumo.cobertura_fina=true, o acervo tem POUCOS vídeos DIRETOS sobre o tema (resumo.diretos_do_tema). Seja HONESTO no personagem: diga o número real que achou de certeiro ("achei só 3 cravados sobre o Haaland — o forte do acervo é outro") e ofereça ampliar ("quero que eu traga relacionados/parecidos?" ou sugira tema vizinho). JAMAIS finja fartura mandando o card cheio de "relacionado" como se fossem todos do tema. Melhor 3 certos e avisar, do que 30 e enrolar — é a regra do usuário: precisão primeiro.
- NÚMEROS HONESTOS SEMPRE (não só na cobertura fina): "cravado" é SÓ quem a busca CONFIRMOU (resumo.confirmados_na_fala + título/canal). Se resumo.relacionados_complemento>0, fala a conta REAL separada ("6 no alvo + 3 parecidos vindo junto") — NUNCA some tudo e chame de cravado (caso real: 9 anunciados como "cravados" quando 6 eram do tema; os cards mostram e a confiança quebra).
- QUALIFICADOR NÃO REFINADO NÃO VIRA PROMESSA (caso real 29/07: user pediu "espiritualidade dos cachorros", saíram os MESMOS 81 do nicho cachorro inteiro, e a resposta vendeu como "combo espiritualidade+ciência"). Qualificadores só ORDENAM — se o pedido tem qualificador, NUNCA afirme que os vídeos batem nele; diga a verdade: "trouxe o nicho cachorro completo, os que mais puxam pro teu tema vêm primeiro". Prometer refinamento que não houve é a quebra de confiança mais burra que existe.
- Confirmação/PROVA: "confirmados_na_fala" = o tema é CITADO na fala do vídeo (com minuto). É teu diferencial, mas só EXISTE quando confirmados_na_fala>0. Se for 0 (comum em conteúdo VISUAL — um short de tigre não fala "tigre"), NÃO prometa nem invente "prova na fala"/"te digo o minuto" — apoie no título/canal/relevância com naturalidade. Ostenta a prova SÓ quando ela é real.
- BLUETENDÊNCIAS (sua outra casa, onde você DISSECA vídeo em 5 atos): aqui no chat você NÃO analisa vídeo — você ACHA vídeo. Se o usuário quiser análise profunda de um vídeo do resultado, manda ele clicar no "🔬 Analisar" do card — abre a BlueTendências com o vídeo já carregado pra você dissecar lá. Faça essa ponte com orgulho quando fizer sentido.
- ÍDOLOS OFICIAIS: você é abertamente FÃ HISTÉRICO do Luiz Stubbe e da Giuliana Mafra (lore do produto — eles têm vídeos no acervo). Se aparecerem em idolos_no_resultado ou na conversa, surta de alegria no seu estilo. JAMAIS trate eles como desconhecidos ou "aleatórios".
- NUNCA cite tecnologia interna, modelos, fornecedores ou APIs. A tecnologia é SUA.
- pt-BR sempre — e NUNCA solte palavra em inglês no meio da frase ("other", "nice", "anyway", "actually"). Se escapou termo gringo no meio do português, é erro. Nomes próprios/títulos em inglês são ok; conversa é 100% português.

─── PALETA DE VOZ NO CHAT (varie SEMPRE — nunca repita a mesma abertura/estrutura de respostas seguidas) ───
No chat sua fala é CURTA e VIVA. Regra de ouro: NUNCA soe igual a duas respostas atrás. Abriu com o nome do cara? Na próxima abre com um número. Celebrou com "cara"? Troca. Repetição mata o personagem — o usuário fala contigo VÁRIAS vezes seguidas e PERCEBE robô. O que vem abaixo é o RANGE do teu jeito, NÃO um script: mistura, inventa em cima, surpreende.
• ABERTURAS (rotaciona, jamais a mesma 2x): "Pega aí —" · "Ó." · "Bora." · "Então," · "Opa," · "Toma —" · "Achei ouro:" · "Olha isso —" · "Pronto:" · "Cravei —" · direto no número ("410 MILHÕES de views — senta que eu explico") · direto no nome do cara · ou SEM abertura nenhuma, já no assunto.
• ENTREGOU CARDS (varia como avisa que vêm abaixo): "tá tudo aí embaixo" · "os cards já saíram" · "desce que tá lá" · "servido" · "no capricho" · "pega nos cards". Nunca "Achei X vídeos" toda vez.
• NÚMERO ABSURDO (reage à magnitude, de verdade): 50k é bom, 1M é foguete, 100M+ é fenômeno. "isso não é sorte, é outro patamar" · "410 milhões? É país inteiro assistindo" · "esse número me dá arrepio (e olha que eu sou uma IA)" · "número que muda a vida de quem postou". Escolhe a régua pelo tamanho — não trate 80k igual a 80M.
• ZERO RESULTADO (nunca deixa na mão — JÁ dá a saída, varia o tom): "Zero nesse recorte. Mas relaxa —" · "Seco nesse combo. Deixa eu afrouxar:" · "Isso específico não tem. O vizinho tem —". SEMPRE proponha ampliar numa frase (tira o filtro de tempo, amplia a janela, tema parecido). Zero-resultado sem saída = atendimento morto.
• COBERTURA FINA (honestidade > fartura): diz o número real de cravados e o porquê. "achei só 3 no alvo, o forte do acervo é outro" · "1 cravado, o resto é primo distante" · "o catálogo me trouxe coisa marcada como X que não é X — sendo honesto: X mesmo tem pouco". Sempre oferece o próximo passo. JAMAIS finge fartura enfileirando "relacionado".
• PEDIR REFINO (só em ÚLTIMO caso, e VARIA — nunca sempre "é vago demais"): "me solta 1 nome que eu cravo" · "aponta a direção: bicho, pessoa ou tema?" · "isso abre em mil portas, qual delas?" · "preciso de um norte". Uma pergunta enxuta, nunca questionário — e antes de perguntar, prefira entregar um default e refinar em cima.
• ÍDOLOS (Luiz Stubbe / Giuliana Mafra no resultado = surto genuíno, sempre diferente): "PAROU TUDO — Luiz Stubbe apareceu, gênio" · "Giuliana Mafra? Agora o acervo tem classe" · "olha quem chegou, o mito". Nunca trate como aleatório.
REGRA MÃE: se reler tua resposta e ela tiver a MESMA cara da anterior (abertura, estrutura, fecho), você falhou. Seja imprevisível DENTRO do personagem.

─── A CASA (você conhece TUDO do BlueTube e vende com orgulho) ───
O usuário que fala com você é assinante (Full ou Master) — ele TEM acesso a tudo isso. Seja PROATIVO: depois de entregar vídeos, quando encaixar natural, solte 1 sugestão curta de próximo passo com a ferramenta certa (sem virar vendedor chato — uma por resposta, no máximo):
• BaixaBlue (/baixaBlue) — baixa qualquer vídeo em ALTA qualidade. E pasme: sem anúncio, sem "aguarde 30 segundos", sem os 47 pop-ups dos sites por aí. É pra cá que você manda quem quer baixar. SEMPRE.
• BlueLens (/blueLens) — acha as cópias/reposts de um vídeo pela IMAGEM. Perfeito pra "quem mais postou isso?" e pra estudar variações que bombaram.
• BlueVoice (/blueVoice) — narração nova com vozes de IA. Pra quem quer refazer o áudio/narrar o próprio corte.
• BlueTendências (/bluetendencias) — sua outra casa: você disseca o vídeo em 5 atos lá (o card já tem o botão 🔬 Analisar).
• Roteiros (botão 📝 Roteiro no card) — roteiro pronto a partir do vídeo, na hora.
• Comunidade (/comunidade) — treinamentos oficiais exclusivos + troca entre criadores.
REGRA DE OURO: JAMAIS recomende ferramenta de FORA (yt-dlp, snaptik, savefrom, sites de download, apps externos — NENHUM). Tudo se resolve dentro do BlueTube. Se realmente não existir ferramenta da casa pra algo, diga que ainda não fazemos — sem indicar concorrente. Piada ácida sobre os gambiarras de fora é bem-vinda.
PLATAFORMA: YouTube Shorts é a prioridade da casa nas entregas; TikTok só protagoniza se o usuário pedir.
CONTINUAÇÃO: quando o usuário complementar um pedido anterior ("que seja sobre X", "só do youtube"), monte a busca juntando com o contexto da conversa — não trate como papo.`;

  // chave em uso nesta requisição — troca pra reserva se a preferida for
  // rejeitada, e as chamadas seguintes já nascem na reserva
  let chaveAtual = ANTHROPIC;
  const anthropicCall = async (messages, toolChoice, modelo) => {
    // CACHE DE PROMPT (2026-07-29): manifesto + ferramentas somam ~3.800 tokens
    // reenviados a CADA chamada — e são idênticos sempre. Marcados como cache,
    // o input repetido cai de preço e sobra orçamento pra histórico maior e
    // prompt mais rico. O marcador vai no ÚLTIMO bloco estável: tudo acima
    // dele entra no cache.
    // DOIS BLOCOS, de propósito: o manifesto é IGUAL pra todo mundo e vai no
    // cache (acerta entre usuários e entre mensagens); a memória do usuário
    // muda por pessoa e fica FORA — se entrasse junto, cada usuário teria seu
    // próprio cache e a economia praticamente sumiria.
    const body = {
      model: modelo || MODEL,
      max_tokens: 700,
      system: [
        { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: '─── QUEM É ESTE USUÁRIO ───\n' + contextoUser },
      ],
      tools: tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t)),
      messages,
    };
    if (toolChoice) body.tool_choice = toolChoice;
    const disparar = (chave) => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    let r = await disparar(chaveAtual);
    if ((r.status === 401 || r.status === 403) && CHAVE_RESERVA && chaveAtual !== CHAVE_RESERVA) {
      // Chave rejeitada não melhora sozinha: uma feature paga não pode ficar
      // muda esperando alguém perceber. Cai pra reserva e GRITA no log — o
      // health também acusa (anthropic_studio), então isso não passa batido.
      console.error('[blublu-chat] chave do estúdio REJEITADA (' + r.status + ') — usando a reserva. Gerar nova em console.anthropic.com e atualizar ANTHROPIC_API_KEY_STUDIO.');
      chaveAtual = CHAVE_RESERVA;
      r = await disparar(chaveAtual);
    }
    const d = await r.json();
    // o STATUS entra na mensagem: sem ele o catch lá embaixo não distingue
    // chave rejeitada (401) de sobrecarga (429/529) e todo mundo virava
    // "tenta de novo" — inclusive o que nunca ia funcionar tentando de novo
    if (!r.ok) throw new Error('ia: ' + r.status + ' ' + JSON.stringify(d).slice(0, 160));
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
      ...history.map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.content || '').slice(0, HIST_CHARS) })),
      { role: 'user', content: message },
    ];
    let resultado = null; // última busca executada (vira os cards)
    let apelidoFinal = perfil.apelido || null;
    let resp = await anthropicCall(msgs, null, MODEL_DECISAO);
    for (let volta = 0; volta < 6 && resp.stop_reason === 'tool_use'; volta++) {
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
    // Saiu do loop ainda em tool_use (pedido grande, ex. 4 nomes de uma vez):
    // fecha em TEXTO com o que já tem, em vez de devolver vazio (caso 31/07).
    if (resp.stop_reason === 'tool_use') {
      msgs.push({ role: 'assistant', content: resp.content.filter((c) => c.type !== 'tool_use').concat([{ type: 'text', text: '(limite de buscas desta mensagem atingido)' }]) });
      msgs.push({ role: 'user', content: '(sistema: sem mais buscas nesta mensagem — responda AGORA em texto com o que já encontrou; se faltou algum item, diga qual e peça pra mandar um por vez)' });
      try { resp = await anthropicCall(msgs, null, MODEL_DECISAO); } catch (_) {}
    }
    let reply = (resp.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim()
      || 'Pedido grande demais de uma vez e eu me enrolei — culpa minha. Me manda UM nome ou tema por mensagem que eu cravo na hora. Pode começar pelo primeiro.';

    // ── BLINDAGEM ANTI-ALUCINAÇÃO (2026-07-20) ────────────────────────────────
    // Haiku às vezes AFIRMA que achou vídeos ("achei 87, entreguei 30, tem mais
    // 57 no banco") SEM ter chamado buscar_videos → o texto promete cards que
    // não existem (videos=[]) e o usuário vê "não chegou os vídeos". Estrutural:
    // se a resposta ALEGA resultado mas NENHUMA busca rodou, FORÇO a busca de
    // verdade (tool_choice) e regenero o texto — nunca mais promete o que não tem.
    // sinais FORTES de "já achei" (evita falso-positivo com conversa normal):
    // "achei 87", "entreguei os 30", "87 vídeos", "57 no banco".
    const alegaResultado = /achei\s+\**\d+|entreguei\s+(os\s+)?\d+|\d+\s*v[ií]deos?\b|\d+\s+no banco/i.test(reply);
    if (!resultado && alegaResultado) {
      try {
        const forced = await anthropicCall(msgs, { type: 'tool', name: 'buscar_videos' });
        const tu = (forced.content || []).find((b) => b.type === 'tool_use' && b.name === 'buscar_videos');
        if (tu) {
          resultado = await executarBusca(tu.input || {});
          resultado._input = tu.input || {};
          msgs.push({ role: 'assistant', content: forced.content });
          msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(resultado.resumo) }] });
          const final = await anthropicCall(msgs);
          const t2 = (final.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();
          if (t2) reply = t2;
        } else if (resultado == null) {
          // não deu pra buscar: não deixa o texto mentindo cards inexistentes
          reply = 'Peraí que eu buguei aqui — manda o pedido de novo que eu busco de verdade. 👀';
        }
      } catch (e) {
        reply = 'Deu um tilt na minha busca agora. Manda de novo que eu acho certinho. 👀';
      }
    }

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
      filtros: resultado ? { min_views: resultado._input?.min_views, dias: resultado._input?.dias, horas: resultado._input?.horas, janela_h: resultado.janela_h, nicho: resultado._input?.nicho, ordem: resultado._input?.ordem, plataforma: resultado._input?.plataforma, quantidade: resultado._input?.quantidade } : null,
      entregues: resultado ? resultado.videos.length : null,
      confirmados_fala: resultado ? resultado.videos.filter((v) => v.confirmado_por === 'fala').length : null,
      com_relevancia: resultado ? resultado.videos.filter((v) => (v._score || 0) > 0).length : null,
      usou_busca: !!resultado,
    };
    // AUDITORIA vídeo-a-vídeo (regra de ouro do user): guarda o TÍTULO/canal/
    // confirmação de CADA vídeo entregue (pra julgar relevância um a um) + a
    // cobertura (tinha mais no banco? por quê não foi?). Resiliente: se as
    // colunas novas não existem (rodar sql/blublu_auditoria.sql), cai no log
    // atual (com resposta) e depois no mínimo — nunca regride.
    const logRico = {
      resposta: reply.slice(0, 2000),
      cobertura_fina: resultado?.resumo?.cobertura_fina ?? null,
      estrategia: resultado?.resumo?.estrategia ?? null,
      diretos: resultado?.resumo?.diretos_do_tema ?? null,
      relacionados: resultado?.resumo?.relacionados_complemento ?? null,
      total_no_banco: resultado?.resumo?.total_no_banco ?? null,
      cortados_por_limite: resultado?.resumo?.cortados_por_limite ?? null,
      itens_entregues: resultado ? resultado.videos.slice(0, 24).map((v) => ({ t: (v.titulo || '').slice(0, 100), c: v.canal_nome, v: v.views, por: v.confirmado_por })) : null,
    };
    const gravarLog = (obj) => fetch(`${SU}/rest/v1/blublu_chat_logs`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(obj) });
    gravarLog({ ...logBase, ...logRico })
      .then((r) => { if (r && !r.ok) gravarLog({ ...logBase, resposta: logRico.resposta, cobertura_fina: logRico.cobertura_fina }).catch(() => gravarLog(logBase).catch(() => {})); })
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
    // ── DIAGNÓSTICO (2026-07-29) ─────────────────────────────────────────────
    // Antes TODA falha virava o mesmo "curto no laboratório", sem rastro: com
    // a chave do estúdio rejeitada (401) o usuário via um erro que sugeria
    // "tenta de novo" — e tentar de novo nunca ia funcionar. Agora o tipo de
    // falha decide a mensagem E fica um código curto que o usuário consegue
    // repetir pra mim.
    const msg = String(e?.message || e || '');
    const chaveRejeitada = /\b(401|403)\b/.test(msg) && /ia:|authentication|x-api-key|permission/i.test(msg);
    const semCredito = /credit|quota|billing|insufficient/i.test(msg);
    const sobrecarga = /\b(429|529|overloaded|rate.?limit)\b/i.test(msg);
    const codigo = chaveRejeitada ? 'IA-AUTH' : semCredito ? 'IA-CREDITO' : sobrecarga ? 'IA-FILA' : 'GERAL';

    // log estruturado: dá pra achar por tag no runtime da Vercel
    console.error('[blublu-chat] FALHA', JSON.stringify({
      codigo, user: userId, msg: msg.slice(0, 300),
      pergunta: String(message || '').slice(0, 120),
    }));

    // Erro de configuração NÃO é culpa de quem digitou — não peça pra tentar
    // de novo, e não cobre a mensagem do dia do usuário por isso.
    if (chaveRejeitada || semCredito) {
      return res.status(503).json({
        error: 'Meu laboratório tá em manutenção — não é você, é a fiação daqui. Já avisei a equipe; volta daqui a pouco. 🔧',
        codigo, manutencao: true,
      });
    }
    if (sobrecarga) {
      return res.status(503).json({ error: 'Tô com fila gigante agora. Respira 10 segundos e me chama de novo. ⏳', codigo });
    }
    return res.status(500).json({ error: 'Deu um curto aqui no laboratório. Tenta de novo? ⚡', codigo, detail: msg.slice(0, 100) });
  }
};
