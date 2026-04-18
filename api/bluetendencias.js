// api/bluetendencias.js — Studio (Dissecação Cinematográfica de Virais)
//
// Substitui o antigo dashboard ML (agora em bluetendencias-old.js). Nova
// experiencia: galeria curada + chat 3 perguntas + analise Claude Sonnet
// em 5 atos + aplicacao pratica pro canal do usuario.
//
// Actions:
//   GET  ?action=galeria&token=X&filtro=...    - lista virais curados
//   GET  ?action=verificar-acesso&token=X       - plano Master + rate limit
//   POST {action:'iniciar-dissecacao',...}      - 3 perguntas contextuais
//   POST {action:'gerar-analise',...}           - gera analise 5 atos
//   GET  ?action=status-budget&admin_secret=X   - admin monitora custo
//
// ISOLAMENTO TOTAL:
// - Usa APENAS ANTHROPIC_API_KEY_STUDIO (chave separada)
// - Rate limit 3/24h por usuario (rolling, nao reseta meia-noite)
// - Budget cap R\$200/dia (pausa automatica se estourar)
// - Se chave falhar, nao usa fallback pra outras chaves
// - Tabelas com prefixo studio_
// - NUNCA modifica api/auth.js

const crypto = require('crypto');

// Preco Claude Sonnet 4.6 (ref Out 2025): $3/MTok input, $15/MTok output
// Convertido pra BRL usando taxa ~R$5.0
const COST_INPUT_PER_MTOK_BRL = 15;
const COST_OUTPUT_PER_MTOK_BRL = 75;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });
  const h = { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json' };

  const action = req.method === 'GET' ? req.query.action : (req.body?.action);
  const ctx = { SU, SK, AK, h };

  try {
    if (action === 'galeria')              return res.status(200).json(await galeria(ctx, req));
    if (action === 'verificar-acesso')     return res.status(200).json(await verificarAcesso(ctx, req));
    if (action === 'iniciar-dissecacao')   return res.status(200).json(await iniciarDissecacao(ctx, req));
    if (action === 'gerar-analise')        return res.status(200).json(await gerarAnalise(ctx, req));
    if (action === 'status-budget')        return res.status(200).json(await statusBudget(ctx, req));
    return res.status(400).json({ error: 'action_invalida', valid: ['galeria','verificar-acesso','iniciar-dissecacao','gerar-analise','status-budget'] });
  } catch (e) {
    console.error(`[bluetendencias ${action}] erro:`, e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS — auth, rate limit, budget
// ─────────────────────────────────────────────────────────────────────────────
async function getUser(ctx, token) {
  if (!token) return null;
  try {
    const r = await fetch(`${ctx.SU}/auth/v1/user`, { headers: { apikey: ctx.AK, Authorization: `Bearer ${token}` } });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

async function requireMaster(ctx, token) {
  const user = await getUser(ctx, token);
  if (!user?.email) return { ok: false, status: 401, error: 'Token invalido' };
  const r = await fetch(
    `${ctx.SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(user.email)}&select=plan,plan_expires_at&limit=1`,
    { headers: ctx.h }
  );
  const [sub] = r.ok ? await r.json() : [];
  const plan = sub?.plan || 'free';
  const expired = sub?.plan_expires_at && new Date(sub.plan_expires_at) < new Date();
  if (plan !== 'master' || expired) {
    return { ok: false, status: 403, error: 'master_required', plan };
  }
  return { ok: true, user, plan };
}

async function checarRateLimitEBudget(ctx, userId) {
  // 1) Rate limit 24h rolling
  const vinte4hAtras = new Date(Date.now() - 86400000).toISOString();
  const rlR = await fetch(
    `${ctx.SU}/rest/v1/studio_rate_limits?user_id=eq.${userId}&usado_em=gte.${vinte4hAtras}&select=usado_em&order=usado_em.asc`,
    { headers: ctx.h }
  );
  const usos = rlR.ok ? await rlR.json() : [];
  const limite = parseInt(process.env.STUDIO_MAX_PER_USER_24H || '3', 10);
  const usadas = usos.length;
  const restantes = Math.max(0, limite - usadas);

  if (restantes === 0) {
    const maisAntiga = usos[0];
    const proximaEm = maisAntiga ? new Date(new Date(maisAntiga.usado_em).getTime() + 86400000) : null;
    return { permitido: false, motivo: 'limite_24h', usadas_24h: usadas, proxima_analise_em: proximaEm?.toISOString() };
  }

  // 2) Budget diario global
  const hoje = new Date().toISOString().split('T')[0];
  const bR = await fetch(`${ctx.SU}/rest/v1/studio_budget_diario?data=eq.${hoje}&select=*&limit=1`, { headers: ctx.h });
  const [budget] = bR.ok ? await bR.json() : [];
  if (budget && budget.ativo === false) {
    return { permitido: false, motivo: 'sistema_pausado', mensagem: 'BlueTendências em pausa programada. Volta em algumas horas.' };
  }

  return { permitido: true, analises_restantes: restantes, analises_total_24h: limite };
}

async function registrarUso(ctx, userId) {
  await fetch(`${ctx.SU}/rest/v1/studio_rate_limits`, {
    method: 'POST', headers: { ...ctx.h, Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: userId }),
  }).catch(() => {});
}

async function atualizarBudgetDiario(ctx, custoBRL) {
  const hoje = new Date().toISOString().split('T')[0];
  const r = await fetch(`${ctx.SU}/rest/v1/studio_budget_diario?data=eq.${hoje}&select=*&limit=1`, { headers: ctx.h });
  const [atual] = r.ok ? await r.json() : [];
  const novoGasto = parseFloat(((atual?.gasto_brl || 0) + custoBRL).toFixed(4));
  const limite = parseFloat(process.env.STUDIO_DAILY_BUDGET_BRL || '200');
  const ativo = novoGasto < limite;

  await fetch(`${ctx.SU}/rest/v1/studio_budget_diario`, {
    method: 'POST',
    headers: { ...ctx.h, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      data: hoje,
      gasto_brl: novoGasto,
      total_analises: (atual?.total_analises || 0) + 1,
      budget_limite: limite,
      ativo,
      atualizado_em: new Date().toISOString(),
    }),
  }).catch(() => {});

  // Notifica admin se acabou de estourar
  if (!ativo && atual?.ativo && process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'BlueTube <noreply@bluetubeviral.com>',
        to: [process.env.ADMIN_EMAIL],
        subject: '⚠️ Budget diario da BlueTendencias atingido',
        html: `<h2>Budget BlueTendencias atingido</h2>
               <p>Gasto hoje: R\$${novoGasto.toFixed(2)}</p>
               <p>Limite: R\$${limite.toFixed(2)}</p>
               <p>Sistema pausado automaticamente ate meia-noite.</p>`,
      }),
    }).catch(() => {});
  }
}

// Chama Claude com chave STUDIO isolada. NUNCA usa fallback pra chave principal.
async function callClaudeStudio(prompt, { model = 'claude-sonnet-4-6', maxTokens = 2500, system } = {}) {
  if (!process.env.ANTHROPIC_API_KEY_STUDIO) {
    throw new Error('ANTHROPIC_API_KEY_STUDIO nao configurada');
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY_STUDIO,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: system || undefined,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => '');
    throw new Error(`Claude Studio ${r.status}: ${err.slice(0, 200)}`);
  }
  const data = await r.json();
  return {
    text: data.content?.[0]?.text || '',
    tokens_input: data.usage?.input_tokens || 0,
    tokens_output: data.usage?.output_tokens || 0,
    model: data.model || model,
  };
}

function parseJsonSafe(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION: galeria — lista virais curados por categoria
// ═════════════════════════════════════════════════════════════════════════════
async function galeria(ctx, req) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return { error: auth.error, mostrar_teaser: true, status: auth.status };

  const nicho = (req.query.nicho || '').toString().trim();
  const desde7d = new Date(Date.now() - 7 * 86400000).toISOString();

  // Top virais em alta (alta velocidade + score)
  const nichoClause = nicho ? `&nicho=eq.${nicho}` : '';

  const [emAltaR, emergentesR] = await Promise.all([
    fetch(
      `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&video_url=neq.null&coletado_em=gte.${desde7d}${nichoClause}&order=viral_score.desc.nullslast,views.desc&limit=12&select=id,youtube_id,titulo,thumbnail_url,url,canal_nome,canal_thumbnail,views,likes,comentarios,duracao_segundos,viral_score,velocidade_views_24h,nicho,publicado_em`,
      { headers: ctx.h }
    ),
    fetch(
      `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&video_url=neq.null&coletado_em=gte.${desde7d}&velocidade_views_24h=gte.1000${nichoClause}&order=velocidade_views_24h.desc&limit=10&select=id,youtube_id,titulo,thumbnail_url,url,canal_nome,views,likes,duracao_segundos,viral_score,velocidade_views_24h,nicho,publicado_em`,
      { headers: ctx.h }
    ),
  ]);
  const emAlta = emAltaR.ok ? await emAltaR.json() : [];
  const emergentes = emergentesR.ok ? await emergentesR.json() : [];

  // Top 15 por nicho (pra dropdown)
  const porNichoR = await fetch(
    `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&video_url=neq.null&coletado_em=gte.${desde7d}&nicho=not.is.null&order=viral_score.desc.nullslast&limit=50&select=id,youtube_id,titulo,thumbnail_url,views,canal_nome,nicho`,
    { headers: ctx.h }
  );
  const porNichoRaw = porNichoR.ok ? await porNichoR.json() : [];
  const porNicho = {};
  porNichoRaw.forEach(v => {
    const n = v.nicho || 'outros';
    if (!porNicho[n]) porNicho[n] = [];
    if (porNicho[n].length < 10) porNicho[n].push(v);
  });

  return {
    em_alta: emAlta,
    emergentes,
    por_nicho: porNicho,
    nicho_ativo: nicho || null,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION: verificar-acesso
// ═════════════════════════════════════════════════════════════════════════════
async function verificarAcesso(ctx, req) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return { permitido: false, motivo: auth.error, status: auth.status };
  const rl = await checarRateLimitEBudget(ctx, auth.user.id);
  return { ...rl, plan: auth.plan };
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION: iniciar-dissecacao — retorna video + 3 perguntas contextuais
// ═════════════════════════════════════════════════════════════════════════════
async function iniciarDissecacao(ctx, req) {
  const { token, video_id } = req.body || {};
  const auth = await requireMaster(ctx, token);
  if (!auth.ok) return { error: auth.error, status: auth.status };

  const rl = await checarRateLimitEBudget(ctx, auth.user.id);
  if (!rl.permitido) return rl;

  // Busca video (aceita UUID ou youtube_id)
  const filter = video_id.length > 20 ? `id=eq.${video_id}` : `youtube_id=eq.${video_id}`;
  const vR = await fetch(
    `${ctx.SU}/rest/v1/virais_banco?${filter}&select=*&limit=1`,
    { headers: ctx.h }
  );
  const [video] = vR.ok ? await vR.json() : [];
  if (!video) return { error: 'Video nao encontrado', status: 404 };

  // Gera 3 perguntas contextuais com Haiku (rapido + barato)
  const perguntas = await gerarPerguntasContextuais(video);

  return {
    sessao_id: crypto.randomUUID(),
    video: {
      id: video.id,
      youtube_id: video.youtube_id,
      titulo: video.titulo,
      thumbnail: video.thumbnail_url,
      canal: video.canal_nome,
      canal_thumb: video.canal_thumbnail,
      views: video.views,
      likes: video.likes,
      comentarios: video.comentarios,
      duracao: video.duracao_segundos,
      viral_score: video.viral_score,
      velocidade_24h: video.velocidade_views_24h,
      nicho: video.nicho,
      publicado_em: video.publicado_em,
    },
    perguntas,
  };
}

async function gerarPerguntasContextuais(video) {
  const prompt = `Voce e consultora de videos virais.
Este video viralizou: "${video.titulo}"
Nicho: ${video.nicho || 'nao classificado'}
Views: ${(video.views || 0).toLocaleString('pt-BR')}
Duracao: ${video.duracao_segundos}s

Gere EXATAMENTE 3 perguntas curtas com opcoes em botoes pra entender
o contexto do criador que vai usar a analise. Primeira sobre nicho,
segunda sobre duracao habitual, terceira sobre principal desafio.

Retorne APENAS JSON valido:
{
  "perguntas": [
    { "id": "nicho", "texto": "...?", "opcoes": ["a", "b", "c", "d"] },
    { "id": "duracao", "texto": "...?", "opcoes": ["a", "b", "c", "d"] },
    { "id": "desafio", "texto": "...?", "opcoes": ["a", "b", "c", "d", "e"] }
  ]
}`;

  try {
    const out = await callClaudeStudio(prompt, { model: 'claude-haiku-4-5', maxTokens: 500 });
    const parsed = parseJsonSafe(out.text);
    if (parsed?.perguntas && Array.isArray(parsed.perguntas) && parsed.perguntas.length >= 3) {
      return parsed.perguntas.slice(0, 3);
    }
  } catch (e) { console.error('[bluetendencias perguntas] erro:', e.message); }

  // Fallback generico se Haiku falhar
  return [
    { id: 'nicho', texto: 'Qual seu nicho principal?', opcoes: ['Humor', 'Finanças', 'Beleza', 'Fitness', 'Games', 'Outro'] },
    { id: 'duracao', texto: 'Qual o tamanho médio dos seus vídeos?', opcoes: ['Menos de 30s', '30-60s', '1-3 min', 'Mais longos'] },
    { id: 'desafio', texto: 'Qual seu maior desafio hoje?', opcoes: ['Hook nos 3s', 'Retenção', 'Algoritmo', 'Ideias', 'Edição'] },
  ];
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION: gerar-analise — Claude Sonnet gera analise 5 atos
// ═════════════════════════════════════════════════════════════════════════════
async function gerarAnalise(ctx, req) {
  const { token, video_id, respostas } = req.body || {};
  const inicio = Date.now();

  const auth = await requireMaster(ctx, token);
  if (!auth.ok) return { error: auth.error, status: auth.status };

  const rl = await checarRateLimitEBudget(ctx, auth.user.id);
  if (!rl.permitido) return rl;

  // Busca video
  const filter = video_id.length > 20 ? `id=eq.${video_id}` : `youtube_id=eq.${video_id}`;
  const vR = await fetch(
    `${ctx.SU}/rest/v1/virais_banco?${filter}&select=*&limit=1`,
    { headers: ctx.h }
  );
  const [video] = vR.ok ? await vR.json() : [];
  if (!video) return { error: 'Video nao encontrado', status: 404 };

  // Contexto do nicho (estatisticas agregadas)
  const nichoUserKey = (respostas?.nicho || video.nicho || '').toLowerCase();
  const statsR = await fetch(
    `${ctx.SU}/rest/v1/virais_banco?nicho=eq.${encodeURIComponent(nichoUserKey)}&viral_score=gte.70&select=duracao_segundos,viral_score,ratio_like_view&limit=50`,
    { headers: ctx.h }
  );
  const statsNicho = statsR.ok ? await statsR.json() : [];
  const duracaoMediaNicho = statsNicho.length > 0
    ? Math.round(statsNicho.reduce((s, v) => s + (v.duracao_segundos || 0), 0) / statsNicho.length)
    : null;

  const prompt = `Voce e uma consultora especialista em videos virais brasileiros.
Dissecte este video especifico e explique por que funcionou.

VIDEO EM ANALISE:
Titulo: "${video.titulo}"
Views: ${(video.views || 0).toLocaleString('pt-BR')}
Likes: ${(video.likes || 0).toLocaleString('pt-BR')}
Comentarios: ${(video.comentarios || 0).toLocaleString('pt-BR')}
Duracao: ${video.duracao_segundos} segundos
Velocidade: ${Math.round(video.velocidade_views_24h || 0)} views/hora
Nicho: ${video.nicho || 'nao classificado'}
Canal: ${video.canal_nome}

CONTEXTO DO NICHO:
Duracao media dos virais do nicho: ${duracaoMediaNicho ? duracaoMediaNicho + 's' : 'nao disponivel'}
Virais analisados no nicho: ${statsNicho.length}

CONTEXTO DO CRIADOR QUE VAI LER A ANALISE:
Nicho: ${respostas?.nicho || 'nao informado'}
Duracao habitual: ${respostas?.duracao || 'nao informado'}
Desafio principal: ${respostas?.desafio || 'nao informado'}

Gere analise cinematografica em 5 atos. Cada ato com titulo e analise
aprofundada. Tom profissional mas acessivel. Sem jargao vazio.
Especifico, NUNCA generico.

No ATO 5, considerando o nicho ${respostas?.nicho || 'do criador'} e
o desafio ${respostas?.desafio || 'informado'}, de 3 sugestoes
ESPECIFICAS e acionaveis pra adaptar essa formula ao canal dele.

Retorne APENAS JSON valido:
{
  "ato_1_hook": {
    "titulo": "O Hook",
    "analise": "por que o titulo prende nos primeiros 3 segundos...",
    "tecnica_identificada": "curiosidade | controversia | promessa | pergunta | numero | etc",
    "por_que_funciona": "explicacao psicologica curta"
  },
  "ato_2_estrutura": {
    "titulo": "A Estrutura",
    "duracao_analise": "por que ${video.duracao_segundos}s funciona...",
    "comparacao_nicho": "versus media ${duracaoMediaNicho || 'desconhecida'}s do nicho...",
    "estrutura_narrativa": "hook -> setup -> conflito -> climax -> cta, por exemplo"
  },
  "ato_3_gatilho": {
    "titulo": "O Gatilho Viral",
    "elemento_chave": "o que faz compartilhar",
    "emocao_despertada": "raiva, surpresa, admiracao, humor, etc",
    "por_que_compartilham": "por que alguem manda pro amigo"
  },
  "ato_4_contexto": {
    "titulo": "O Contexto Cultural",
    "momento_cultural": "por que ESTE video neste MOMENTO",
    "tendencia_maior": "qual onda ele pegou",
    "comparacao_nicho": "o que ele faz diferente do nicho"
  },
  "ato_5_aplicacao": {
    "titulo": "Aplicacao para Voce",
    "resumo_para_usuario": "paragrafo curto direcionado pro criador",
    "sugestao_1": "ideia concreta #1",
    "sugestao_2": "ideia concreta #2",
    "sugestao_3": "ideia concreta #3"
  }
}`;

  let out;
  try {
    out = await callClaudeStudio(prompt, { model: 'claude-sonnet-4-6', maxTokens: 2500 });
  } catch (e) {
    console.error('[bluetendencias gerar-analise] Claude falhou:', e.message);
    return { error: 'BlueTendências temporariamente indisponível. Outras ferramentas seguem normais.', status: 503 };
  }

  const analise = parseJsonSafe(out.text);
  if (!analise) {
    console.error('[bluetendencias gerar-analise] JSON invalido:', out.text.slice(0, 300));
    return { error: 'Falha ao processar análise. Tente novamente.', status: 500 };
  }

  // Calcula custo BRL
  const custoBRL = parseFloat((
    (out.tokens_input / 1_000_000) * COST_INPUT_PER_MTOK_BRL +
    (out.tokens_output / 1_000_000) * COST_OUTPUT_PER_MTOK_BRL
  ).toFixed(4));

  // Registra uso em paralelo (fire-and-forget pros que podem falhar)
  await Promise.all([
    registrarUso(ctx, auth.user.id),
    fetch(`${ctx.SU}/rest/v1/studio_dissecacoes`, {
      method: 'POST', headers: { ...ctx.h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: auth.user.id,
        video_youtube_id: video.youtube_id,
        video_titulo: video.titulo,
        video_views_inicio: video.views,
        video_likes_inicio: video.likes,
        nicho_usuario: respostas?.nicho || null,
        duracao_media_videos: respostas?.duracao || null,
        desafio_principal: respostas?.desafio || null,
        analise_completa: analise,
        tempo_geracao_ms: Date.now() - inicio,
        custo_tokens_input: out.tokens_input,
        custo_tokens_output: out.tokens_output,
        custo_brl: custoBRL,
        modelo_usado: out.model,
      }),
    }).catch(() => {}),
    atualizarBudgetDiario(ctx, custoBRL),
  ]);

  return {
    ok: true,
    analise,
    video: {
      id: video.id, youtube_id: video.youtube_id, titulo: video.titulo,
      thumbnail: video.thumbnail_url, canal: video.canal_nome, nicho: video.nicho,
    },
    tempo_ms: Date.now() - inicio,
    modelo: out.model,
    analises_restantes: Math.max(0, rl.analises_restantes - 1),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION: status-budget — admin dashboard
// ═════════════════════════════════════════════════════════════════════════════
async function statusBudget(ctx, req) {
  const secret = req.query.admin_secret || '';
  if (secret !== process.env.ADMIN_SECRET) return { error: 'Nao autorizado', status: 403 };

  const hoje = new Date().toISOString().split('T')[0];
  const sete = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

  const [budgetR, historicoR, ultimasR] = await Promise.all([
    fetch(`${ctx.SU}/rest/v1/studio_budget_diario?data=eq.${hoje}&select=*&limit=1`, { headers: ctx.h }),
    fetch(`${ctx.SU}/rest/v1/studio_budget_diario?data=gte.${sete}&select=*&order=data.desc`, { headers: ctx.h }),
    fetch(`${ctx.SU}/rest/v1/studio_dissecacoes?order=created_at.desc&limit=20&select=id,user_id,video_titulo,video_youtube_id,nicho_usuario,custo_brl,created_at`, { headers: ctx.h }),
  ]);
  const [budget] = budgetR.ok ? await budgetR.json() : [];
  const historico = historicoR.ok ? await historicoR.json() : [];
  const ultimas = ultimasR.ok ? await ultimasR.json() : [];

  // Usuarios ativos 24h
  const vinte4h = new Date(Date.now() - 86400000).toISOString();
  const ativosR = await fetch(`${ctx.SU}/rest/v1/studio_rate_limits?usado_em=gte.${vinte4h}&select=user_id`, { headers: ctx.h });
  const ativos = ativosR.ok ? await ativosR.json() : [];
  const usuariosUnicos24h = new Set(ativos.map(a => a.user_id)).size;

  return {
    hoje: budget || { gasto_brl: 0, total_analises: 0, budget_limite: 200, ativo: true },
    usuarios_ativos_24h: usuariosUnicos24h,
    historico_7d: historico,
    ultimas_analises: ultimas,
  };
}
