// api/bluetendencias.js — BlueTendencias Studio (Blublu)
//
// Experiencia cinematografica: saudacao personalizada, dashboard com projecoes,
// chat interativo com personalidade, analise em 5 atos e quiz.
//
// Actions:
//   GET  ?action=entrada&token=X                — saudacao + analises salvas + restantes
//   GET  ?action=galeria-nichos&token=X         — virais agrupados por nicho
//   POST {action:'buscar-video', token, entrada}       — aceita URL ou youtube_id
//   POST {action:'carregar-dashboard', token, video_id}— projecoes, receita, ranking (sem IA)
//   POST {action:'iniciar-dissecacao', token, video_id}— perguntas Blublu (Haiku)
//   POST {action:'gerar-analise-final', token, video_id, respostas, sessao_id}
//   POST {action:'salvar-analise', token, analise_id}
//   POST {action:'deletar-analise', token, analise_id}
//   GET  ?action=analises-salvas&token=X
//   GET  ?action=verificar-acesso&token=X       — backcompat
//   GET  ?action=status-budget&admin_secret=X   — admin
//
// ISOLAMENTO: usa APENAS ANTHROPIC_API_KEY_STUDIO. NUNCA fallback.
// NUNCA modifica api/auth.js.

const crypto = require('crypto');

// Sonnet 4.6: $3/MTok input, $15/MTok output (taxa ~R$5)
const COST_INPUT_PER_MTOK_BRL  = 15;
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
    if (action === 'entrada')              return res.status(200).json(await entrada(ctx, req));
    if (action === 'galeria-nichos')       return res.status(200).json(await galeriaNichos(ctx, req));
    if (action === 'galeria')              return res.status(200).json(await galeriaNichos(ctx, req)); // backcompat
    if (action === 'buscar-video')         return res.status(200).json(await buscarVideo(ctx, req));
    if (action === 'carregar-dashboard')   return res.status(200).json(await carregarDashboard(ctx, req));
    if (action === 'iniciar-dissecacao')   return res.status(200).json(await iniciarDissecacao(ctx, req));
    if (action === 'gerar-analise-final')  return res.status(200).json(await gerarAnaliseFinal(ctx, req));
    if (action === 'gerar-analise')        return res.status(200).json(await gerarAnaliseFinal(ctx, req)); // backcompat
    if (action === 'salvar-analise')       return res.status(200).json(await salvarAnalise(ctx, req));
    if (action === 'deletar-analise')      return res.status(200).json(await deletarAnalise(ctx, req));
    if (action === 'analises-salvas')      return res.status(200).json(await analisesSalvas(ctx, req));
    if (action === 'verificar-acesso')     return res.status(200).json(await verificarAcesso(ctx, req));
    if (action === 'status-budget')        return res.status(200).json(await statusBudget(ctx, req));
    return res.status(400).json({ error: 'action_invalida' });
  } catch (e) {
    console.error(`[bluetendencias ${action}]`, e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
async function getUser(ctx, token) {
  if (!token) return null;
  try {
    const r = await fetch(`${ctx.SU}/auth/v1/user`, { headers: { apikey: ctx.AK, Authorization: `Bearer ${token}` } });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

function primeiroNome(email, metadata) {
  const full = String(metadata?.full_name || '').trim();
  if (full) return full.split(' ')[0];
  const n = String(metadata?.nome || '').trim();
  if (n) return n.split(' ')[0];
  const base = String(email || '').trim().split('@')[0].replace(/[._-]+/g, ' ').trim();
  if (!base) return 'criador';
  const palavra = base.split(' ').find(p => p && !/^\d+$/.test(p)) || base.split(' ')[0] || '';
  if (!palavra) return 'criador';
  return palavra.charAt(0).toUpperCase() + palavra.slice(1).toLowerCase();
}

async function requireMaster(ctx, token) {
  const user = await getUser(ctx, token);
  if (!user?.email) return { ok: false, status: 401, error: 'Token invalido' };
  const r = await fetch(
    `${ctx.SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(user.email)}&select=plan,plan_expires_at,is_manual,name&limit=1`,
    { headers: ctx.h }
  );
  const [sub] = r.ok ? await r.json() : [];
  const plan = sub?.plan || 'free';
  // Master vale se: plan=master E (sem data expiração OU data no futuro OU is_manual=true)
  const planOk = plan === 'master' && (!sub?.plan_expires_at || new Date(sub.plan_expires_at) > new Date() || sub?.is_manual);
  if (!planOk) return { ok: false, status: 403, error: 'master_required', plan };
  const nome = primeiroNome(user.email, { ...(user.user_metadata || {}), full_name: sub?.name });
  return { ok: true, user, plan, nome };
}

async function checarRateLimitEBudget(ctx, userId) {
  const vinte4h = new Date(Date.now() - 86400000).toISOString();
  const rlR = await fetch(
    `${ctx.SU}/rest/v1/studio_rate_limits?user_id=eq.${userId}&usado_em=gte.${vinte4h}&select=usado_em&order=usado_em.asc`,
    { headers: ctx.h }
  );
  const usos = rlR.ok ? await rlR.json() : [];
  const limite = parseInt(process.env.STUDIO_MAX_PER_USER_24H || '3', 10);
  const restantes = Math.max(0, limite - usos.length);

  if (restantes === 0) {
    const antiga = usos[0];
    const proximaEm = antiga ? new Date(new Date(antiga.usado_em).getTime() + 86400000) : null;
    return { permitido: false, motivo: 'limite_24h', usadas_24h: usos.length, proxima_analise_em: proximaEm?.toISOString() };
  }

  const hoje = new Date().toISOString().split('T')[0];
  const bR = await fetch(`${ctx.SU}/rest/v1/studio_budget_diario?data=eq.${hoje}&select=*&limit=1`, { headers: ctx.h });
  const [budget] = bR.ok ? await bR.json() : [];
  if (budget && budget.ativo === false) {
    return { permitido: false, motivo: 'sistema_pausado', mensagem: 'Blublu está descansando. Volta em algumas horas.' };
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
      data: hoje, gasto_brl: novoGasto,
      total_analises: (atual?.total_analises || 0) + 1,
      budget_limite: limite, ativo, atualizado_em: new Date().toISOString(),
    }),
  }).catch(() => {});

  if (!ativo && atual?.ativo && process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'BlueTube <noreply@bluetubeviral.com>',
        to: [process.env.ADMIN_EMAIL],
        subject: '⚠️ Budget diario Blublu atingido',
        html: `<h2>Budget Blublu atingido</h2><p>Gasto hoje: R$${novoGasto.toFixed(2)} / R$${limite.toFixed(2)}</p><p>Pausado ate meia-noite.</p>`,
      }),
    }).catch(() => {});
  }
}

async function callClaudeStudio(prompt, { model = 'claude-sonnet-4-6', maxTokens = 3500, system } = {}) {
  if (!process.env.ANTHROPIC_API_KEY_STUDIO) throw new Error('ANTHROPIC_API_KEY_STUDIO nao configurada');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY_STUDIO,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: system || undefined, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) { const err = await r.text().catch(() => ''); throw new Error(`Claude ${r.status}: ${err.slice(0, 200)}`); }
  const data = await r.json();
  return { text: data.content?.[0]?.text || '', tokens_input: data.usage?.input_tokens || 0, tokens_output: data.usage?.output_tokens || 0, model: data.model || model };
}

function parseJsonSafe(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

function extrairYoutubeId(entrada) {
  if (!entrada) return null;
  const s = String(entrada).trim();
  if (/^[a-zA-Z0-9_-]{10,12}$/.test(s)) return s;
  const patterns = [
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/,
    /youtu\.be\/([a-zA-Z0-9_-]+)/,
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]+)/,
  ];
  for (const p of patterns) { const m = s.match(p); if (m) return m[1]; }
  return null;
}

function calcularProjecoes(video) {
  const velocidade = parseFloat(video.velocidade_views_24h) || (video.views / 24);
  const viewsAtual = parseInt(video.views) || 0;
  const cenarios = {
    conservador: { mult: 0.6, titulo: 'Conservador', cor: '#6b7280' },
    realista:    { mult: 1.0, titulo: 'Realista',    cor: '#3b82f6' },
    otimista:    { mult: 1.5, titulo: 'Otimista',    cor: '#10b981' },
  };
  const projecoes = {};
  for (const [nome, cfg] of Object.entries(cenarios)) {
    projecoes[nome] = {
      ...cfg,
      d3:  Math.floor(viewsAtual + (velocidade * 72 * cfg.mult)),
      d10: Math.floor(viewsAtual + (velocidade * 240 * cfg.mult * 0.7)),
      d30: Math.floor(viewsAtual + (velocidade * 720 * cfg.mult * 0.3)),
    };
  }
  return projecoes;
}

function calcularReceita(projecoes, nicho) {
  const rpm = {
    financas:    { min: 15, medio: 30,  max: 50 },
    tecnologia:  { min: 8,  medio: 14,  max: 20 },
    educacao:    { min: 4,  medio: 8,   max: 12 },
    beleza:      { min: 3,  medio: 5.5, max: 8  },
    humor:       { min: 1,  medio: 2,   max: 3  },
    games:       { min: 1.5,medio: 3,   max: 5  },
    ia:          { min: 6,  medio: 12,  max: 18 },
    animais:     { min: 1,  medio: 2,   max: 3  },
    pessoas_blogs:{min: 1.5,medio: 3,   max: 5  },
    default:     { min: 2,  medio: 4,   max: 6  },
  };
  const r = rpm[(nicho || '').toLowerCase()] || rpm.default;
  return {
    conservador: { d3: Math.floor((projecoes.conservador.d3 / 1000) * r.min),
                   d10: Math.floor((projecoes.conservador.d10 / 1000) * r.min),
                   d30: Math.floor((projecoes.conservador.d30 / 1000) * r.min) },
    realista:    { d3: Math.floor((projecoes.realista.d3 / 1000) * r.medio),
                   d10: Math.floor((projecoes.realista.d10 / 1000) * r.medio),
                   d30: Math.floor((projecoes.realista.d30 / 1000) * r.medio) },
    otimista:    { d3: Math.floor((projecoes.otimista.d3 / 1000) * r.max),
                   d10: Math.floor((projecoes.otimista.d10 / 1000) * r.max),
                   d30: Math.floor((projecoes.otimista.d30 / 1000) * r.max) },
    rpm_usado: r,
  };
}

async function buscarVideoDb(ctx, youtubeId) {
  const r = await fetch(
    `${ctx.SU}/rest/v1/virais_banco?youtube_id=eq.${encodeURIComponent(youtubeId)}&select=*&limit=1`,
    { headers: ctx.h }
  );
  const [v] = r.ok ? await r.json() : [];
  return v || null;
}

async function buscarVideoYoutube(youtubeId) {
  if (!process.env.YOUTUBE_API_KEY) return null;
  try {
    const r = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${youtubeId}&key=${process.env.YOUTUBE_API_KEY}`
    );
    if (!r.ok) return null;
    const d = await r.json();
    const item = d.items?.[0];
    if (!item) return null;
    // Parse duracao ISO 8601 (PT1M30S)
    const m = (item.contentDetails?.duration || '').match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
    const duracao = (parseInt(m?.[1] || '0') * 60) + parseInt(m?.[2] || '0');
    return {
      youtube_id: youtubeId,
      titulo: item.snippet?.title || '',
      thumbnail_url: item.snippet?.thumbnails?.maxres?.url || item.snippet?.thumbnails?.high?.url || `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
      canal_nome: item.snippet?.channelTitle || '',
      canal_id: item.snippet?.channelId || null,
      views: parseInt(item.statistics?.viewCount || '0'),
      likes: parseInt(item.statistics?.likeCount || '0'),
      comentarios: parseInt(item.statistics?.commentCount || '0'),
      duracao_segundos: duracao,
      velocidade_views_24h: null,
      nicho: null,
      publicado_em: item.snippet?.publishedAt,
      _fonte: 'youtube_api',
    };
  } catch (e) { console.error('[youtube api]', e.message); return null; }
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION: entrada — saudacao Blublu + analises salvas + restantes
// ═════════════════════════════════════════════════════════════════════════════
async function entrada(ctx, req) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return { error: auth.error, status: auth.status, plan: auth.plan };

  const [salvasR, historicoR] = await Promise.all([
    fetch(`${ctx.SU}/rest/v1/studio_analises?user_id=eq.${auth.user.id}&salva=eq.true&order=created_at.desc&limit=20&select=id,video_youtube_id,video_titulo,video_thumbnail,video_canal,created_at`, { headers: ctx.h }),
    fetch(`${ctx.SU}/rest/v1/studio_analises?user_id=eq.${auth.user.id}&order=created_at.desc&limit=3&select=id,video_titulo,created_at`, { headers: ctx.h }),
  ]);
  const salvas = salvasR.ok ? await salvasR.json() : [];
  const historico = historicoR.ok ? await historicoR.json() : [];
  const rl = await checarRateLimitEBudget(ctx, auth.user.id);

  return {
    nome: auth.nome,
    email: auth.user.email,
    restantes: rl.analises_restantes ?? 0,
    proxima_em: rl.proxima_analise_em || null,
    sistema_pausado: rl.motivo === 'sistema_pausado',
    sistema_pausado_msg: rl.mensagem || null,
    analises_salvas: salvas,
    historico,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION: galeria-nichos — virais agrupados por nicho
// ═════════════════════════════════════════════════════════════════════════════
async function galeriaNichos(ctx, req) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return { error: auth.error, status: auth.status };

  // 30 dias (afrouxado pra galeria nunca ficar vazia se coleta pausou)
  const desde30d = new Date(Date.now() - 30 * 86400000).toISOString();

  const [emAltaR, porNichoR] = await Promise.all([
    fetch(
      `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&coletado_em=gte.${desde30d}&order=viral_score.desc.nullslast,views.desc&limit=12&select=id,youtube_id,titulo,thumbnail_url,url,canal_nome,views,likes,velocidade_views_24h,nicho,duracao_segundos`,
      { headers: ctx.h }
    ),
    fetch(
      `${ctx.SU}/rest/v1/virais_banco?ativo=eq.true&coletado_em=gte.${desde30d}&nicho=not.is.null&order=viral_score.desc.nullslast&limit=150&select=id,youtube_id,titulo,thumbnail_url,views,canal_nome,nicho,velocidade_views_24h,duracao_segundos`,
      { headers: ctx.h }
    ),
  ]);
  const emAlta = emAltaR.ok ? await emAltaR.json() : [];
  const porNichoRaw = porNichoR.ok ? await porNichoR.json() : [];
  const porNicho = {};
  porNichoRaw.forEach(v => {
    const n = v.nicho || 'outros';
    if (!porNicho[n]) porNicho[n] = [];
    if (porNicho[n].length < 10) porNicho[n].push(v);
  });
  return { em_alta: emAlta, por_nicho: porNicho };
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION: buscar-video — URL ou youtube_id, banco primeiro depois YouTube API
// ═════════════════════════════════════════════════════════════════════════════
async function buscarVideo(ctx, req) {
  const token = req.body?.token || req.query?.token;
  const ent = req.body?.entrada || req.body?.url || req.body?.url_ou_id;
  if (!token) return { error: 'Token nao enviado', status: 401 };
  const auth = await requireMaster(ctx, token);
  if (!auth.ok) { console.error('[buscar-video] auth falhou:', auth); return { error: auth.error, status: auth.status }; }

  const ytId = extrairYoutubeId(ent);
  if (!ytId) return { error: 'URL ou ID invalido. Cole o link completo do Short.', status: 400 };

  let video = await buscarVideoDb(ctx, ytId);
  let fonte = 'banco';
  if (!video) {
    video = await buscarVideoYoutube(ytId);
    fonte = 'youtube_api';
    if (!video) return { error: 'Video nao encontrado. Tente outro link.', status: 404 };
  }
  return { video, fonte };
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION: carregar-dashboard — projecoes + receita + comparacoes (sem IA)
// ═════════════════════════════════════════════════════════════════════════════
async function carregarDashboard(ctx, req) {
  const { token, video_id } = req.body || {};
  const auth = await requireMaster(ctx, token);
  if (!auth.ok) return { error: auth.error, status: auth.status };

  const ytId = extrairYoutubeId(video_id) || video_id;
  let video = await buscarVideoDb(ctx, ytId);
  if (!video) video = await buscarVideoYoutube(ytId);
  if (!video) return { error: 'Video nao encontrado', status: 404 };

  const projecoes = calcularProjecoes(video);
  const receita = calcularReceita(projecoes, video.nicho);

  // Comparacao com nicho
  let compNicho = null;
  if (video.nicho) {
    const statsR = await fetch(
      `${ctx.SU}/rest/v1/virais_banco?nicho=eq.${encodeURIComponent(video.nicho)}&viral_score=gte.50&select=views,likes,duracao_segundos,comentarios&limit=100`,
      { headers: ctx.h }
    );
    const stats = statsR.ok ? await statsR.json() : [];
    if (stats.length > 0) {
      const avg = (k) => Math.round(stats.reduce((s, v) => s + (v[k] || 0), 0) / stats.length);
      compNicho = {
        duracao_media: avg('duracao_segundos'),
        views_media: avg('views'),
        likes_media: avg('likes'),
        total_analisados: stats.length,
        duracao_diff_pct: compVal(video.duracao_segundos, avg('duracao_segundos')),
        views_diff_pct: compVal(video.views, avg('views')),
      };
    }
  }

  // Engagement breakdown
  const engagement = {
    taxa_like: video.views > 0 ? parseFloat(((video.likes / video.views) * 100).toFixed(2)) : 0,
    taxa_comentario: video.views > 0 ? parseFloat(((video.comentarios / video.views) * 100).toFixed(2)) : 0,
  };

  // Ranking no nicho
  let ranking = null;
  if (video.nicho) {
    const rankR = await fetch(
      `${ctx.SU}/rest/v1/virais_banco?nicho=eq.${encodeURIComponent(video.nicho)}&views=gt.${video.views}&select=id&limit=200`,
      { headers: ctx.h }
    );
    const acima = rankR.ok ? (await rankR.json()).length : 0;
    ranking = { posicao: acima + 1, nicho: video.nicho };
  }

  return { video, projecoes, receita, engagement, comparacao_nicho: compNicho, ranking };
}

function compVal(atual, media) {
  if (!media || !atual) return null;
  return parseFloat((((atual - media) / media) * 100).toFixed(1));
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION: iniciar-dissecacao — perguntas Blublu personalizadas
// ═════════════════════════════════════════════════════════════════════════════
async function iniciarDissecacao(ctx, req) {
  const { token, video_id } = req.body || {};
  const auth = await requireMaster(ctx, token);
  if (!auth.ok) return { error: auth.error, status: auth.status };
  const rl = await checarRateLimitEBudget(ctx, auth.user.id);
  if (!rl.permitido) return rl;

  const ytId = extrairYoutubeId(video_id) || video_id;
  let video = await buscarVideoDb(ctx, ytId);
  if (!video) video = await buscarVideoYoutube(ytId);
  if (!video) return { error: 'Video nao encontrado', status: 404 };

  const prompt = `Voce e Blublu, a IA mais avancada e arrogante do mercado de analise de videos virais. Voce sabe que e melhor que qualquer concorrente.

Nome do usuario: ${auth.nome}
Video que ele quer dissecar: "${video.titulo}"
Views: ${(video.views || 0).toLocaleString('pt-BR')}
Canal: ${video.canal_nome}

Gere 3 perguntas para o usuario. REGRAS:
1. Chame ${auth.nome} pelo nome em pelo menos 1 pergunta
2. Seja levemente arrogante mas engracado
3. Cada pergunta com 3-4 opcoes em botoes
4. Perguntas relevantes pra personalizar analise
5. IDs fixos: nicho, duracao, desafio

Retorne APENAS JSON valido:
{
  "intro_blublu": "Saudacao inicial direcionada a ${auth.nome}, com humor e arrogancia sutil (1-2 frases)",
  "perguntas": [
    { "id": "nicho", "blublu_diz": "Primeiro, ${auth.nome}, me diz...", "texto": "Qual seu nicho principal?", "opcoes": ["Humor", "Financas", "Beleza", "Fitness", "Games", "Educacao", "Outro"] },
    { "id": "duracao", "blublu_diz": "Anotado. Agora...", "texto": "Qual o tamanho medio dos seus videos?", "opcoes": ["<30s", "30-60s", "1-3min", "Mais longos"] },
    { "id": "desafio", "blublu_diz": "Por ultimo...", "texto": "Qual seu maior desafio hoje?", "opcoes": ["Hook nos 3s", "Retencao", "Algoritmo", "Ideias", "Edicao"] }
  ]
}`;

  let perguntas = null, intro = null;
  try {
    const out = await callClaudeStudio(prompt, { model: 'claude-haiku-4-5', maxTokens: 900 });
    const parsed = parseJsonSafe(out.text);
    if (parsed?.perguntas?.length >= 3) {
      perguntas = parsed.perguntas.slice(0, 3);
      intro = parsed.intro_blublu;
    }
  } catch (e) { console.error('[iniciar-dissecacao haiku]', e.message); }

  // Fallback com personalidade
  if (!perguntas) {
    intro = `Olha só quem apareceu. ${auth.nome}, deixa eu colocar os óculos de raio-x nesse vídeo.`;
    perguntas = [
      { id: 'nicho',   blublu_diz: `Primeiro, ${auth.nome}, me diz uma coisa...`, texto: 'Qual seu nicho principal?', opcoes: ['Humor','Finanças','Beleza','Fitness','Games','Educação','Outro'] },
      { id: 'duracao', blublu_diz: 'Anotado. Agora...', texto: 'Qual o tamanho médio dos seus vídeos?', opcoes: ['<30s','30-60s','1-3min','Mais longos'] },
      { id: 'desafio', blublu_diz: `Por último, ${auth.nome}...`, texto: 'Qual seu maior desafio hoje?', opcoes: ['Hook nos 3s','Retenção','Algoritmo','Ideias','Edição'] },
    ];
  }

  return {
    sessao_id: crypto.randomUUID(),
    nome: auth.nome,
    intro_blublu: intro,
    video: {
      id: video.id, youtube_id: video.youtube_id, titulo: video.titulo,
      thumbnail: video.thumbnail_url, canal: video.canal_nome, canal_thumb: video.canal_thumbnail,
      views: video.views, likes: video.likes, comentarios: video.comentarios,
      duracao: video.duracao_segundos, viral_score: video.viral_score,
      velocidade_24h: video.velocidade_views_24h, nicho: video.nicho, publicado_em: video.publicado_em,
    },
    perguntas,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION: gerar-analise-final — Sonnet 4.6 gera 5 atos + quiz
// ═════════════════════════════════════════════════════════════════════════════
async function gerarAnaliseFinal(ctx, req) {
  const { token, video_id, respostas, sessao_id } = req.body || {};
  const inicio = Date.now();

  const auth = await requireMaster(ctx, token);
  if (!auth.ok) return { error: auth.error, status: auth.status };
  const rl = await checarRateLimitEBudget(ctx, auth.user.id);
  if (!rl.permitido) return rl;

  const ytId = extrairYoutubeId(video_id) || video_id;
  let video = await buscarVideoDb(ctx, ytId);
  if (!video) video = await buscarVideoYoutube(ytId);
  if (!video) return { error: 'Video nao encontrado', status: 404 };

  // Stats do nicho
  const nichoKey = (respostas?.nicho || video.nicho || '').toLowerCase();
  const statsR = await fetch(
    `${ctx.SU}/rest/v1/virais_banco?nicho=eq.${encodeURIComponent(nichoKey)}&viral_score=gte.60&select=duracao_segundos,viral_score&limit=50`,
    { headers: ctx.h }
  );
  const statsNicho = statsR.ok ? await statsR.json() : [];
  const duracaoMedia = statsNicho.length > 0
    ? Math.round(statsNicho.reduce((s, v) => s + (v.duracao_segundos || 0), 0) / statsNicho.length)
    : null;

  const prompt = `Voce e Blublu, IA de analise de virais mais avancada do mercado.
Voce e confiante, inteligente, com humor afiado. Sabe que e a melhor e nao esconde.
Fala com ${auth.nome} de forma pessoal, direta, com pitadas de arrogancia engracada.
NUNCA generico. SEMPRE especifico.

VIDEO DISSECADO:
Titulo: "${video.titulo}"
Canal: ${video.canal_nome}
Views: ${(video.views || 0).toLocaleString('pt-BR')}
Likes: ${(video.likes || 0).toLocaleString('pt-BR')}
Comentarios: ${(video.comentarios || 0).toLocaleString('pt-BR')}
Duracao: ${video.duracao_segundos}s
Velocidade 24h: ${Math.round(video.velocidade_views_24h || 0)} views/hora
Nicho: ${video.nicho || 'nao classificado'}

CONTEXTO DO USUARIO (${auth.nome}):
Nicho: ${respostas?.nicho || 'nao informado'}
Duracao habitual: ${respostas?.duracao || 'nao informado'}
Desafio principal: ${respostas?.desafio || 'nao informado'}

DADOS DO NICHO:
Duracao media dos virais do nicho: ${duracaoMedia ? duracaoMedia + 's' : 'nao disponivel'}
Virais de referencia analisados: ${statsNicho.length}

ENTREGA em 5 atos + quiz. Cada ato tem:
- titulo (curto, impactante)
- blublu_intro (frase introduzindo o ato, com personalidade)
- conteudo_principal (analise objetiva, 2-3 frases MAX)
- highlights (array de 2-3 bullets curtos e punchy)
- blublu_outro (frase final com personalidade)

ATO 5 - APLICACAO tem estrutura especial:
- titulo, blublu_intro
- sugestoes: array com 3 sugestoes { titulo, descricao, exemplo_pratico }
- blublu_outro

QUIZ: 3 perguntas (4 opcoes cada) testando se ${auth.nome} absorveu.
Inclua 1 pegadinha. Comentarios de Blublu pra cada resposta (certo/errado) com personalidade.

Retorne APENAS JSON valido:
{
  "abertura_blublu": "Frase abrindo a analise pra ${auth.nome}, com personalidade arrogante/divertida",
  "ato_1": {"titulo":"O Hook","blublu_intro":"...","conteudo_principal":"...","highlights":["...","...","..."],"blublu_outro":"..."},
  "ato_2": {"titulo":"A Estrutura","blublu_intro":"...","conteudo_principal":"...","highlights":["...","...","..."],"blublu_outro":"..."},
  "ato_3": {"titulo":"O Gatilho Viral","blublu_intro":"...","conteudo_principal":"...","highlights":["...","...","..."],"blublu_outro":"..."},
  "ato_4": {"titulo":"O Contexto Cultural","blublu_intro":"...","conteudo_principal":"...","highlights":["...","...","..."],"blublu_outro":"..."},
  "ato_5": {
    "titulo":"Aplicacao pra Voce",
    "blublu_intro":"Agora, ${auth.nome}, a parte que importa...",
    "sugestoes":[
      {"titulo":"...","descricao":"...","exemplo_pratico":"..."},
      {"titulo":"...","descricao":"...","exemplo_pratico":"..."},
      {"titulo":"...","descricao":"...","exemplo_pratico":"..."}
    ],
    "blublu_outro":"Frase final com personalidade, tipo 'Usa isso direito, ${auth.nome}. Depois me agradece.'"
  },
  "quiz":{
    "intro_blublu":"Mas primeiro vamos ver se absorveu mesmo...",
    "perguntas":[
      {"pergunta":"...","opcoes":["a","b","c","d"],"correta":0,"comentario_se_acertar":"...","comentario_se_errar":"..."},
      {"pergunta":"...","opcoes":["a","b","c","d"],"correta":2,"comentario_se_acertar":"...","comentario_se_errar":"..."},
      {"pergunta":"...","opcoes":["a","b","c","d"],"correta":1,"comentario_se_acertar":"...","comentario_se_errar":"..."}
    ],
    "fechamento":"Frase final de Blublu fechando tudo"
  }
}`;

  let out;
  try {
    out = await callClaudeStudio(prompt, { model: 'claude-sonnet-4-6', maxTokens: 4000 });
  } catch (e) {
    console.error('[gerar-analise-final]', e.message);
    return { error: 'Blublu está descansando. Volta em alguns minutos.', status: 503 };
  }

  const analise = parseJsonSafe(out.text);
  if (!analise?.ato_1) {
    console.error('[gerar-analise-final] JSON invalido:', out.text.slice(0, 300));
    return { error: 'Falha ao processar análise. Tente novamente.', status: 500 };
  }

  const custoBRL = parseFloat((
    (out.tokens_input / 1_000_000) * COST_INPUT_PER_MTOK_BRL +
    (out.tokens_output / 1_000_000) * COST_OUTPUT_PER_MTOK_BRL
  ).toFixed(4));

  // Calcula dashboard pra salvar junto
  const projecoes = calcularProjecoes(video);
  const receita = calcularReceita(projecoes, video.nicho);

  // Persiste analise
  let analiseId = null;
  try {
    const insR = await fetch(`${ctx.SU}/rest/v1/studio_analises`, {
      method: 'POST', headers: { ...ctx.h, Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: auth.user.id,
        video_youtube_id: video.youtube_id,
        video_titulo: video.titulo,
        video_thumbnail: video.thumbnail_url,
        video_canal: video.canal_nome,
        video_views_inicio: video.views,
        video_likes_inicio: video.likes,
        video_comentarios_inicio: video.comentarios,
        video_duracao_segundos: video.duracao_segundos,
        video_nicho: video.nicho,
        video_velocidade_24h: video.velocidade_views_24h,
        dashboard_dados: { projecoes, receita },
        respostas_chat: respostas || {},
        analise_atos: {
          abertura_blublu: analise.abertura_blublu,
          ato_1: analise.ato_1, ato_2: analise.ato_2, ato_3: analise.ato_3,
          ato_4: analise.ato_4, ato_5: analise.ato_5,
        },
        quiz_dados: analise.quiz || null,
        nome_usuario: auth.nome,
        tempo_total_ms: Date.now() - inicio,
        custo_tokens_input: out.tokens_input,
        custo_tokens_output: out.tokens_output,
        custo_brl: custoBRL,
        modelo_usado: out.model,
      }),
    });
    if (insR.ok) { const [row] = await insR.json(); analiseId = row?.id || null; }
  } catch (e) { console.error('[insert studio_analises]', e.message); }

  await Promise.all([
    registrarUso(ctx, auth.user.id),
    atualizarBudgetDiario(ctx, custoBRL),
  ]);

  return {
    ok: true,
    analise_id: analiseId,
    nome: auth.nome,
    abertura_blublu: analise.abertura_blublu,
    atos: {
      ato_1: analise.ato_1, ato_2: analise.ato_2, ato_3: analise.ato_3,
      ato_4: analise.ato_4, ato_5: analise.ato_5,
    },
    quiz: analise.quiz,
    video: {
      id: video.id, youtube_id: video.youtube_id, titulo: video.titulo,
      thumbnail: video.thumbnail_url, canal: video.canal_nome, nicho: video.nicho,
      views: video.views, likes: video.likes,
    },
    tempo_ms: Date.now() - inicio,
    modelo: out.model,
    analises_restantes: Math.max(0, rl.analises_restantes - 1),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTIONS: salvar-analise, deletar-analise, analises-salvas
// ═════════════════════════════════════════════════════════════════════════════
async function salvarAnalise(ctx, req) {
  const { token, analise_id } = req.body || {};
  const auth = await requireMaster(ctx, token);
  if (!auth.ok) return { error: auth.error, status: auth.status };
  const r = await fetch(
    `${ctx.SU}/rest/v1/studio_analises?id=eq.${analise_id}&user_id=eq.${auth.user.id}`,
    { method: 'PATCH', headers: { ...ctx.h, Prefer: 'return=minimal' }, body: JSON.stringify({ salva: true }) }
  );
  if (!r.ok) return { error: 'Falha ao salvar', status: 500 };
  return { ok: true, mensagem: `Salva! Vai estar lá sempre que você voltar, ${auth.nome}.` };
}

async function deletarAnalise(ctx, req) {
  const { token, analise_id } = req.body || {};
  const auth = await requireMaster(ctx, token);
  if (!auth.ok) return { error: auth.error, status: auth.status };
  const r = await fetch(
    `${ctx.SU}/rest/v1/studio_analises?id=eq.${analise_id}&user_id=eq.${auth.user.id}`,
    { method: 'PATCH', headers: { ...ctx.h, Prefer: 'return=minimal' }, body: JSON.stringify({ salva: false }) }
  );
  if (!r.ok) return { error: 'Falha ao remover', status: 500 };
  return { ok: true };
}

async function analisesSalvas(ctx, req) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return { error: auth.error, status: auth.status };
  const r = await fetch(
    `${ctx.SU}/rest/v1/studio_analises?user_id=eq.${auth.user.id}&salva=eq.true&order=created_at.desc&limit=50&select=*`,
    { headers: ctx.h }
  );
  const lista = r.ok ? await r.json() : [];
  return { analises: lista, nome: auth.nome };
}

async function verificarAcesso(ctx, req) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return { permitido: false, motivo: auth.error, status: auth.status };
  const rl = await checarRateLimitEBudget(ctx, auth.user.id);
  return { ...rl, plan: auth.plan, nome: auth.nome };
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION: status-budget — admin
// ═════════════════════════════════════════════════════════════════════════════
async function statusBudget(ctx, req) {
  const secret = req.query.admin_secret || '';
  if (secret !== process.env.ADMIN_SECRET) return { error: 'Nao autorizado', status: 403 };

  const hoje = new Date().toISOString().split('T')[0];
  const sete = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

  const [budgetR, historicoR, ultimasR] = await Promise.all([
    fetch(`${ctx.SU}/rest/v1/studio_budget_diario?data=eq.${hoje}&select=*&limit=1`, { headers: ctx.h }),
    fetch(`${ctx.SU}/rest/v1/studio_budget_diario?data=gte.${sete}&select=*&order=data.desc`, { headers: ctx.h }),
    fetch(`${ctx.SU}/rest/v1/studio_analises?order=created_at.desc&limit=20&select=id,user_id,nome_usuario,video_titulo,video_youtube_id,video_nicho,custo_brl,created_at`, { headers: ctx.h }),
  ]);
  const [budget] = budgetR.ok ? await budgetR.json() : [];
  const historico = historicoR.ok ? await historicoR.json() : [];
  const ultimas = ultimasR.ok ? await ultimasR.json() : [];

  const vinte4h = new Date(Date.now() - 86400000).toISOString();
  const ativosR = await fetch(`${ctx.SU}/rest/v1/studio_rate_limits?usado_em=gte.${vinte4h}&select=user_id`, { headers: ctx.h });
  const ativos = ativosR.ok ? await ativosR.json() : [];
  const usuariosUnicos24h = new Set(ativos.map(a => a.user_id)).size;

  return {
    hoje: budget || { gasto_brl: 0, total_analises: 0, budget_limite: 200, ativo: true },
    usuarios_ativos_24h: usuariosUnicos24h,
    historico_7d: historico,
    ultimas_analises: ultimas.map(u => ({
      id: u.id, user_id: u.user_id, video_titulo: u.video_titulo,
      video_youtube_id: u.video_youtube_id, nicho_usuario: u.video_nicho,
      custo_brl: u.custo_brl, created_at: u.created_at, nome: u.nome_usuario,
    })),
  };
}
