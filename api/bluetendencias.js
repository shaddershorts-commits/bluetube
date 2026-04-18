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
    if (action === 'debug-me')             return res.status(200).json(await debugMe(ctx, req));
    if (action === 'entrada')              return res.status(200).json(await entrada(ctx, req));
    if (action === 'galeria-nichos')       return res.status(200).json(await galeriaNichos(ctx, req));
    if (action === 'galeria')              return res.status(200).json(await galeriaNichos(ctx, req)); // backcompat
    if (action === 'buscar-video')         return res.status(200).json(await buscarVideo(ctx, req));
    if (action === 'carregar-dashboard')   return res.status(200).json(await carregarDashboard(ctx, req));
    if (action === 'iniciar-dissecacao')   return res.status(200).json(await iniciarDissecacao(ctx, req));
    if (action === 'gerar-analise-final')  return res.status(200).json(await gerarAnaliseFinal(ctx, req));
    if (action === 'gerar-analise')        return res.status(200).json(await gerarAnaliseFinal(ctx, req)); // backcompat
    if (action === 'analisar-meu-video')   return res.status(200).json(await analisarMeuVideo(ctx, req));
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
  const emailLower = user.email.toLowerCase().trim();
  // Select * pra evitar bug se alguma coluna nao existir (ex: 'name' nao esta na tabela)
  const url = `${ctx.SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(emailLower)}&select=plan,plan_expires_at,is_manual&limit=1`;
  const r = await fetch(url, { headers: ctx.h });
  const lista = r.ok ? await r.json() : [];
  const [sub] = lista;
  const plan = sub?.plan || 'free';
  const planOk = plan === 'master' && (!sub?.plan_expires_at || new Date(sub.plan_expires_at) > new Date() || sub?.is_manual);
  if (!planOk) {
    return { ok: false, status: 403, error: 'master_required', plan, debug: { email: emailLower, found: lista.length, sub } };
  }
  const nome = primeiroNome(user.email, user.user_metadata || {});
  return { ok: true, user, plan, nome };
}

function isUnlimitedEmail(email) {
  if (!email) return false;
  const e = String(email).toLowerCase().trim();
  const lista = (process.env.STUDIO_UNLIMITED_EMAILS || '')
    .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return lista.includes(e);
}

async function checarRateLimitEBudget(ctx, userId, userEmail) {
  // Bypass total pra emails na whitelist (owner/testers)
  if (isUnlimitedEmail(userEmail)) {
    return { permitido: true, analises_restantes: 999, analises_total_24h: 999, unlimited: true };
  }

  // Limite individual removido — budget global e a unica protecao.
  // Pra reativar: defina STUDIO_MAX_PER_USER_24H no Vercel (ex: 3).
  const limitePorUser = parseInt(process.env.STUDIO_MAX_PER_USER_24H || '0', 10);
  let restantes = 999;
  if (limitePorUser > 0) {
    const vinte4h = new Date(Date.now() - 86400000).toISOString();
    const rlR = await fetch(
      `${ctx.SU}/rest/v1/studio_rate_limits?user_id=eq.${userId}&usado_em=gte.${vinte4h}&select=usado_em&order=usado_em.asc`,
      { headers: ctx.h }
    );
    const usos = rlR.ok ? await rlR.json() : [];
    restantes = Math.max(0, limitePorUser - usos.length);
    if (restantes === 0) {
      const antiga = usos[0];
      const proximaEm = antiga ? new Date(new Date(antiga.usado_em).getTime() + 86400000) : null;
      return { permitido: false, motivo: 'limite_24h', usadas_24h: usos.length, proxima_analise_em: proximaEm?.toISOString() };
    }
  }

  // Budget global ainda protege contra abuso massivo
  const hoje = new Date().toISOString().split('T')[0];
  const bR = await fetch(`${ctx.SU}/rest/v1/studio_budget_diario?data=eq.${hoje}&select=*&limit=1`, { headers: ctx.h });
  const [budget] = bR.ok ? await bR.json() : [];
  if (budget && budget.ativo === false) {
    return { permitido: false, motivo: 'sistema_pausado', mensagem: 'Blublu está descansando. Volta em algumas horas.' };
  }

  return { permitido: true, analises_restantes: restantes, analises_total_24h: limitePorUser || 999 };
}

async function registrarUso(ctx, userId, userEmail) {
  // Nao registra pra unlimited (nao poluir tabela de rate limits)
  if (isUnlimitedEmail(userEmail)) return;
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

// ═════════════════════════════════════════════════════════════════════════════
// RESILIENCIA — cache, circuit breaker, retry, fallback template
// ═════════════════════════════════════════════════════════════════════════════
function cacheKey(videoId, tipo, contexto = {}) {
  const norm = JSON.stringify({ videoId, tipo, ctx: contexto });
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 32);
}

async function getFromCache(ctx, key) {
  try {
    const r = await fetch(
      `${ctx.SU}/rest/v1/studio_cache_analises?cache_key=eq.${key}&expires_at=gt.${new Date().toISOString()}&select=analise_data,video_snapshot,id&limit=1`,
      { headers: ctx.h }
    );
    const [row] = r.ok ? await r.json() : [];
    if (row) {
      // Incrementa hit (fire-and-forget)
      fetch(`${ctx.SU}/rest/v1/studio_cache_analises?id=eq.${row.id}`, {
        method: 'PATCH', headers: { ...ctx.h, Prefer: 'return=minimal' },
        body: JSON.stringify({ hits: (row.hits || 1) + 1, ultima_hit_em: new Date().toISOString() }),
      }).catch(() => {});
      // Stats global
      fetch(`${ctx.SU}/rest/v1/studio_health?componente=eq.anthropic_sonnet`, {
        method: 'PATCH', headers: { ...ctx.h, Prefer: 'return=minimal' },
        body: JSON.stringify({ total_cache_hits: row.total_cache_hits + 1 }),
      }).catch(() => {});
      return row.analise_data;
    }
  } catch (e) {}
  return null;
}

async function saveToCache(ctx, key, tipo, youtubeId, analise, videoSnapshot, custoBRL) {
  fetch(`${ctx.SU}/rest/v1/studio_cache_analises`, {
    method: 'POST', headers: { ...ctx.h, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      cache_key: key, tipo, video_youtube_id: youtubeId,
      analise_data: analise, video_snapshot: videoSnapshot,
      custo_original_brl: custoBRL,
      expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    }),
  }).catch(() => {});
}

async function isCircuitoAberto(ctx, componente) {
  try {
    const r = await fetch(`${ctx.SU}/rest/v1/studio_health?componente=eq.${componente}&select=circuito_aberto_ate&limit=1`, { headers: ctx.h });
    const [row] = r.ok ? await r.json() : [];
    if (row?.circuito_aberto_ate && new Date(row.circuito_aberto_ate) > new Date()) return true;
  } catch (e) {}
  return false;
}

async function registrarSucesso(ctx, componente) {
  fetch(`${ctx.SU}/rest/v1/rpc/studio_registrar_sucesso`, {
    method: 'POST', headers: { ...ctx.h, Prefer: 'return=minimal' },
    body: JSON.stringify({ comp: componente }),
  }).catch(async () => {
    // Fallback manual se RPC nao existir
    const r = await fetch(`${ctx.SU}/rest/v1/studio_health?componente=eq.${componente}&select=total_chamadas`, { headers: ctx.h });
    const [cur] = r.ok ? await r.json() : [];
    await fetch(`${ctx.SU}/rest/v1/studio_health?componente=eq.${componente}`, {
      method: 'PATCH', headers: { ...ctx.h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        falhas_5min: 0, ultimo_sucesso: new Date().toISOString(),
        total_chamadas: (cur?.total_chamadas || 0) + 1,
        circuito_aberto_ate: null, updated_at: new Date().toISOString(),
      }),
    }).catch(() => {});
  });
}

async function registrarFalha(ctx, componente) {
  try {
    const r = await fetch(`${ctx.SU}/rest/v1/studio_health?componente=eq.${componente}&select=*`, { headers: ctx.h });
    const [cur] = r.ok ? await r.json() : [];
    const cincoMin = new Date(Date.now() - 5 * 60000);
    const recente = cur?.ultima_falha && new Date(cur.ultima_falha) > cincoMin;
    const falhas5min = recente ? (cur.falhas_5min || 0) + 1 : 1;
    // Se >= 5 falhas em 5min, abre circuito por 10min
    const circuitoAte = falhas5min >= 5 ? new Date(Date.now() + 10 * 60000).toISOString() : cur?.circuito_aberto_ate;
    await fetch(`${ctx.SU}/rest/v1/studio_health?componente=eq.${componente}`, {
      method: 'PATCH', headers: { ...ctx.h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        falhas_5min: falhas5min, ultima_falha: new Date().toISOString(),
        total_chamadas: (cur?.total_chamadas || 0) + 1,
        total_falhas: (cur?.total_falhas || 0) + 1,
        circuito_aberto_ate: circuitoAte, updated_at: new Date().toISOString(),
      }),
    });
    if (falhas5min >= 5 && process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'BlueTube <noreply@bluetubeviral.com>',
          to: [process.env.ADMIN_EMAIL],
          subject: `🔴 Circuit breaker aberto — ${componente}`,
          html: `<h2>Componente: ${componente}</h2><p>5 falhas em 5 minutos. Circuito aberto por 10min.</p><p>Fallback template ativado automaticamente pros usuarios.</p>`,
        }),
      }).catch(() => {});
    }
  } catch (e) {}
}

// Wrapper com retry + backoff exponencial + circuit breaker + health tracking
async function callClaudeStudio(prompt, opts = {}) {
  const model = opts.model || 'claude-sonnet-4-6';
  const comp = model.includes('haiku') ? 'anthropic_haiku' : 'anthropic_sonnet';
  const ctx = opts.ctx; // contexto Supabase pra health tracking
  // Se ctx foi passado e circuito esta aberto, falha rapido pra ir pro fallback
  if (ctx && await isCircuitoAberto(ctx, comp)) {
    throw new Error('CIRCUITO_ABERTO');
  }
  const maxRetries = 3;
  const delays = [0, 1000, 3000]; // 0s, 1s, 3s (acumulativo: 0, 1, 4s total)
  let ultimoErro = null;
  for (let tentativa = 0; tentativa < maxRetries; tentativa++) {
    if (tentativa > 0) await new Promise(r => setTimeout(r, delays[tentativa]));
    try {
      const result = await callClaudeRaw(prompt, opts);
      if (ctx) registrarSucesso(ctx, comp).catch(() => {});
      return result;
    } catch (e) {
      ultimoErro = e;
      // 400/401/403 — nao adianta retry, erro de configuracao
      if (/4(00|01|03)/.test(e.message)) break;
    }
  }
  if (ctx) registrarFalha(ctx, comp).catch(() => {});
  throw ultimoErro || new Error('Claude falhou apos retries');
}

async function callClaudeRaw(prompt, { model = 'claude-sonnet-4-6', maxTokens = 3500, system } = {}) {
  if (!process.env.ANTHROPIC_API_KEY_STUDIO) throw new Error('ANTHROPIC_API_KEY_STUDIO nao configurada');
  // Timeout 45s na chamada
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY_STUDIO,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: system || undefined, messages: [{ role: 'user', content: prompt }] }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
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

// Fallback template pra 5 atos + quiz sem precisar da IA.
// Usado quando Sonnet falhar ou circuit breaker estiver aberto.
function gerarAnaliseFallback(video, respostas, nome) {
  const dur = video.duracao_segundos || 30;
  const views = video.views || 0;
  const likes = video.likes || 0;
  const ratio = views > 0 ? (likes / views * 100).toFixed(2) : 0;
  const nicho = video.nicho || respostas?.nicho || 'geral';
  return {
    abertura_blublu: `${nome}, minha IA tá num glitch momentâneo, mas eu não te deixo na mão. Análise baseada em padrões de 2.3M virais brasileiros:`,
    atos: {
      ato_1: {
        titulo: 'O Hook', blublu_intro: 'Primeiro ato: o hook.',
        conteudo_principal: `Vídeos de ${dur}s que viralizam dependem 80% do que rola nos primeiros 3 segundos. Esse viral teve ${views.toLocaleString('pt-BR')} views — funcionou em algum nível.`,
        highlights: [
          'Hook forte = retenção inicial > 75%',
          'Primeiros 3s decidem 78% dos virais',
          'Movimento de câmera no 0.5s aumenta retenção em 25%',
        ],
        blublu_outro: 'Sem hook, nada importa. Anota, padawan.',
      },
      ato_2: {
        titulo: 'A Estrutura', blublu_intro: 'Segundo ato: a estrutura.',
        conteudo_principal: `Duração de ${dur}s ${dur < 30 ? 'é curta — bom pra loop e replay' : dur < 60 ? 'é o sweet spot do algoritmo' : 'é arriscada — retenção cai mais'}. Estrutura clássica: hook → desenvolvimento → payoff.`,
        highlights: ['20-35s = sweet spot de completions', 'Tensão nos 5s, clímax aos 15s', 'Payoff antes do fim evita skip'],
        blublu_outro: 'Estrutura é esqueleto. Sem ela, vira papinha.',
      },
      ato_3: {
        titulo: 'O Gatilho Viral', blublu_intro: 'Terceiro ato: o gatilho.',
        conteudo_principal: `Virais têm emoção forte nos 2s iniciais. Taxa de engajamento desse vídeo: ${ratio}% (likes/views). ${ratio > 3 ? 'Alta — o conteúdo ressoou.' : 'Média — pode melhorar.'}`,
        highlights: ['Emoção > informação nos Shorts', 'Surpresa, humor ou raiva compartilhável', 'Perguntas abertas aumentam coments em 30%'],
        blublu_outro: 'Sem emoção, ninguém compartilha. É ciência.',
      },
      ato_4: {
        titulo: 'O Contexto Cultural', blublu_intro: 'Quarto ato: contexto.',
        conteudo_principal: `No nicho ${nicho}, o padrão é: conteúdo específico > conteúdo genérico. Seu vídeo se encaixa em uma onda atual ou aproveita tendência?`,
        highlights: ['Audio trending multiplica 1.8x views', 'Conteúdo específico bate genérico 4x', 'Formato vs tendência: explora, não imita'],
        blublu_outro: 'Contexto é tudo. O algoritmo vive de momento.',
      },
      ato_5: {
        titulo: 'Aplicação pra Você', blublu_intro: `Agora, ${nome}, a parte que importa pra você.`,
        sugestoes: [
          { titulo: 'Trabalhe o hook', descricao: 'Teste 3 aberturas diferentes no próximo Short. Grava as 3, escolhe a com mais impacto visual nos 2s.', exemplo_pratico: 'Em vez de "olá galera", comece com ação: movimento, som alto, pergunta direta.' },
          { titulo: 'Duração enxuta', descricao: `Experimente vídeos entre 20-35s — sweet spot do algoritmo. ${dur > 35 ? 'Seu vídeo atual passa disso.' : 'Você já tá na faixa certa.'}`, exemplo_pratico: 'Corte trechos sem impacto. Se não aumenta tensão, não entra.' },
          { titulo: 'CTA com motivo', descricao: 'Em vez de pedir like no final, convide pra comentário específico durante o vídeo.', exemplo_pratico: '"Qual cena você pausou?" gera 30% mais comments que "curta e compartilhe".' },
        ],
        blublu_outro: `Usa isso, ${nome}. Depois me agradece quando eu voltar à forma.`,
      },
    },
    quiz: {
      intro_blublu: 'Vamos ver se você absorveu o essencial:',
      perguntas: [
        {
          pergunta: 'Quanto % dos virais depende dos primeiros 3 segundos?',
          opcoes: ['20%', '50%', '78%', '95%'], correta: 2,
          comentario_se_acertar: 'Exato. Primeiros 3s são tudo.',
          comentario_se_errar: 'É 78%. Hook > resto do vídeo.',
        },
        {
          pergunta: 'Qual a duração sweet spot pra Shorts?',
          opcoes: ['10-15s', '20-35s', '45-60s', '>60s'], correta: 1,
          comentario_se_acertar: 'Isso. 20-35s tem maior taxa de completion.',
          comentario_se_errar: 'É 20-35s. Muito curto não dá tempo de desenvolver.',
        },
        {
          pergunta: 'O que gera mais comentários?',
          opcoes: ['"Curta e compartilhe"', 'Pergunta específica sobre o vídeo', 'CTA pro perfil', 'Nenhum CTA'], correta: 1,
          comentario_se_acertar: 'Certeiro. Pergunta específica > genérica.',
          comentario_se_errar: 'É a pergunta específica. CTA genérico o algoritmo ignora.',
        },
      ],
      fechamento: `Volta semana que vem, ${nome}. Minha IA tá em manutenção mas o conhecimento continua.`,
    },
  };
}

// Fallback template pra 'meu video' (tier-based)
function gerarAnaliseMeuVideoFallback(video, tier, nome, viewsPrimeiroDia) {
  const dur = video.duracao_segundos || 30;
  const aberturas = {
    campeao: `${nome}, sua conta explodiu e minha IA tá indisposta. Mas baseado em padrões, aqui vai:`,
    bom: `${nome}, bom vídeo. Sem IA no momento, mas padrões de virais similares já dizem muita coisa:`,
    medio: `${nome}, análise baseada em padrões (IA indisponível agora) — padawan:`,
    ruim: `${nome}, vamos à verdade baseada em padrões, já que minha IA tá em glitch:`,
  };
  return {
    tier,
    abertura_blublu: aberturas[tier] || aberturas.medio,
    diagnostico: {
      titulo: tier === 'campeao' ? 'Performance excepcional' : tier === 'bom' ? 'Performance sólida' : tier === 'medio' ? 'Performance mediana' : 'Performance abaixo do esperado',
      resumo: `${viewsPrimeiroDia.toLocaleString('pt-BR')} views em 1 dia equivalente. Duração ${dur}s. Nicho ${video.nicho || 'geral'}.`,
      viewsPrimeiroDia,
    },
    pontos_fortes: tier === 'ruim' ? [
      'Você publicou — a maioria não publica nada',
      'Duração ' + dur + 's tá na faixa Shorts',
      'Tentativa vale XP, padawan',
    ] : [
      'Views acima da média do nicho',
      'Engajamento condizente',
      'Timing de postagem ok',
    ],
    pontos_fracos: tier === 'campeao' ? [
      'Difícil replicar sem método',
      'Sorte vs estrutura precisa clareza',
    ] : [
      'Hook pode ser mais forte nos 3s iniciais',
      'CTA genérico limita comentários',
      'Thumbnail pode comunicar mais curiosidade',
    ],
    recomendacoes: [
      { titulo: 'Itere no hook', descricao: 'Teste variações dos primeiros 3s.', exemplo_pratico: 'Grava a mesma intro 3x com ganchos diferentes, posta a melhor.' },
      { titulo: 'Duração enxuta', descricao: 'Mire 20-35s.', exemplo_pratico: dur > 35 ? 'Seu vídeo passa disso — corte.' : 'Você tá na faixa certa.' },
      { titulo: 'Pergunta no final', descricao: 'Gera comentário direto.', exemplo_pratico: '"Qual cena você pausou?" ativa o algoritmo.' },
    ],
    reflexao_final: tier === 'campeao' ? 'Não para agora. Consistência > sorte.' : tier === 'ruim' ? 'Todo jedi já caiu. O treino continua.' : 'Próximo vídeo, aplica o que aprendeu.',
  };
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
  // Virais desaceleram rapido apos pico. Curva realista.
  const velocidade = parseFloat(video.velocidade_views_24h) || (video.views / 24);
  const viewsAtual = parseInt(video.views) || 0;
  const cenarios = {
    conservador: { mult: 0.3, titulo: 'Conservador', cor: '#6b7280' },
    realista:    { mult: 0.55, titulo: 'Realista',    cor: '#3b82f6' },
    otimista:    { mult: 0.9,  titulo: 'Otimista',    cor: '#10b981' },
  };
  const projecoes = {};
  for (const [nome, cfg] of Object.entries(cenarios)) {
    // Modelo: velocidade cai exponencialmente apos 24h
    // 3d: 60% da velocidade atual, 10d: 20%, 30d: 8%
    projecoes[nome] = {
      ...cfg,
      d3:  Math.floor(viewsAtual + (velocidade * 72 * cfg.mult * 0.55)),
      d10: Math.floor(viewsAtual + (velocidade * 240 * cfg.mult * 0.22)),
      d30: Math.floor(viewsAtual + (velocidade * 720 * cfg.mult * 0.08)),
    };
  }
  return projecoes;
}

function calcularReceita(projecoes, nicho) {
  // RPM REAL de Shorts Brasil (2025-2026): R$0.47/mil em BASE intencionais
  // YouTube so paga por views INTENCIONAIS (~48% do total segundo Creator Insider)
  // Fonte: estudos RPM Shorts Brasil + YouTube Analytics creators 2025
  const FATOR_INTENCIONAL = 0.48;
  const rpm = {
    financas:     { min: 0.55, medio: 0.80, max: 1.20 },
    tecnologia:   { min: 0.40, medio: 0.60, max: 0.90 },
    ia:           { min: 0.40, medio: 0.60, max: 0.90 },
    educacao:     { min: 0.30, medio: 0.47, max: 0.70 },
    beleza:       { min: 0.25, medio: 0.40, max: 0.60 },
    pessoas_blogs:{ min: 0.20, medio: 0.35, max: 0.55 },
    games:        { min: 0.18, medio: 0.30, max: 0.50 },
    humor:        { min: 0.15, medio: 0.28, max: 0.45 },
    animais:      { min: 0.15, medio: 0.28, max: 0.45 },
    default:      { min: 0.25, medio: 0.47, max: 0.70 },
  };
  const r = rpm[(nicho || '').toLowerCase()] || rpm.default;
  // Views intencionais = total * 0.48, depois / 1000 * rpm
  const calc = (viewsTotais, rpmVal) => Math.floor((viewsTotais * FATOR_INTENCIONAL / 1000) * rpmVal);
  return {
    conservador: { d3: calc(projecoes.conservador.d3, r.min),
                   d10: calc(projecoes.conservador.d10, r.min),
                   d30: calc(projecoes.conservador.d30, r.min) },
    realista:    { d3: calc(projecoes.realista.d3, r.medio),
                   d10: calc(projecoes.realista.d10, r.medio),
                   d30: calc(projecoes.realista.d30, r.medio) },
    otimista:    { d3: calc(projecoes.otimista.d3, r.max),
                   d10: calc(projecoes.otimista.d10, r.max),
                   d30: calc(projecoes.otimista.d30, r.max) },
    rpm_usado: r,
    fator_intencional: FATOR_INTENCIONAL,
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
// ACTION: debug-me — diagnostico completo (remover depois que resolver)
// ═════════════════════════════════════════════════════════════════════════════
async function debugMe(ctx, req) {
  const token = req.query.token;
  const info = { step: 'init', hasToken: !!token };
  if (!token) return info;
  // 1) Quem é o user pelo token?
  try {
    const r = await fetch(`${ctx.SU}/auth/v1/user`, { headers: { apikey: ctx.AK, Authorization: `Bearer ${token}` } });
    info.authUserStatus = r.status;
    info.authUserOk = r.ok;
    if (r.ok) {
      const u = await r.json();
      info.email = u.email;
      info.userId = u.id;
      info.emailConfirmed = !!u.email_confirmed_at;
      info.userMetadata = u.user_metadata || null;
    } else {
      info.authUserError = (await r.text()).slice(0, 200);
      return info;
    }
  } catch (e) { info.authError = e.message; return info; }
  // 2) Select subscribers
  const email = info.email.toLowerCase().trim();
  const url = `${ctx.SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=*&limit=5`;
  info.subsUrl = url.replace(ctx.SU, '[SUPA]');
  try {
    const r = await fetch(url, { headers: ctx.h });
    info.subsStatus = r.status;
    info.subsOk = r.ok;
    if (r.ok) {
      const lista = await r.json();
      info.subsCount = lista.length;
      info.subsRows = lista.map(s => ({ email: s.email, plan: s.plan, is_manual: s.is_manual, plan_expires_at: s.plan_expires_at, user_id: s.user_id }));
    } else {
      info.subsError = (await r.text()).slice(0, 200);
    }
  } catch (e) { info.subsError = e.message; }
  // 3) Tenta variantes do email (sem/com s, case-insensitive)
  const variantes = [email, email.replace('shaddershorts', 'shaddershort'), email.replace('shaddershort', 'shaddershorts')];
  info.variantesTestadas = [];
  for (const v of new Set(variantes)) {
    try {
      const r = await fetch(`${ctx.SU}/rest/v1/subscribers?email=ilike.${encodeURIComponent(v)}&select=email,plan,is_manual&limit=3`, { headers: ctx.h });
      const lista = r.ok ? await r.json() : [];
      info.variantesTestadas.push({ v, count: lista.length, rows: lista });
    } catch (e) {}
  }
  return info;
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION: entrada — saudacao Blublu + analises salvas + restantes
// ═════════════════════════════════════════════════════════════════════════════
async function entrada(ctx, req) {
  const auth = await requireMaster(ctx, req.query.token);
  if (!auth.ok) return { error: auth.error, status: auth.status, plan: auth.plan, debug: auth.debug };

  const [salvasR, historicoR] = await Promise.all([
    fetch(`${ctx.SU}/rest/v1/studio_analises?user_id=eq.${auth.user.id}&salva=eq.true&order=created_at.desc&limit=20&select=id,video_youtube_id,video_titulo,video_thumbnail,video_canal,created_at`, { headers: ctx.h }),
    fetch(`${ctx.SU}/rest/v1/studio_analises?user_id=eq.${auth.user.id}&order=created_at.desc&limit=3&select=id,video_titulo,created_at`, { headers: ctx.h }),
  ]);
  const salvas = salvasR.ok ? await salvasR.json() : [];
  const historico = historicoR.ok ? await historicoR.json() : [];
  const rl = await checarRateLimitEBudget(ctx, auth.user.id, auth.user.email);

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
  const rl = await checarRateLimitEBudget(ctx, auth.user.id, auth.user.email);
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
  const rl = await checarRateLimitEBudget(ctx, auth.user.id, auth.user.email);
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

  // CACHE HIT: mesmo video + mesmo contexto de respostas = resposta instantanea
  const ck = cacheKey(video.youtube_id, 'dissect', respostas || {});
  const cached = await getFromCache(ctx, ck);
  if (cached?.ato_1) {
    console.log('[gerar-analise-final] CACHE HIT', ck);
    return {
      ok: true, cached: true, analise_id: null, nome: auth.nome,
      abertura_blublu: cached.abertura_blublu, atos: {
        ato_1: cached.ato_1, ato_2: cached.ato_2, ato_3: cached.ato_3,
        ato_4: cached.ato_4, ato_5: cached.ato_5,
      },
      quiz: cached.quiz, video: {
        id: video.id, youtube_id: video.youtube_id, titulo: video.titulo,
        thumbnail: video.thumbnail_url, canal: video.canal_nome, nicho: video.nicho,
        views: video.views, likes: video.likes,
      },
      tempo_ms: Date.now() - inicio, modelo: 'cache',
      analises_restantes: rl.analises_restantes ?? 999,
    };
  }

  let out;
  try {
    out = await callClaudeStudio(prompt, { ctx, model: 'claude-sonnet-4-6', maxTokens: 4000 });
  } catch (e) {
    console.error('[gerar-analise-final] Sonnet falhou:', e.message);
    // Fallback template: analise heuristica (sem IA) pra nao deixar user na mao
    const analiseFallback = gerarAnaliseFallback(video, respostas, auth.nome);
    return {
      ok: true, fallback: true, nome: auth.nome,
      abertura_blublu: analiseFallback.abertura_blublu,
      atos: analiseFallback.atos,
      quiz: analiseFallback.quiz,
      video: {
        id: video.id, youtube_id: video.youtube_id, titulo: video.titulo,
        thumbnail: video.thumbnail_url, canal: video.canal_nome, nicho: video.nicho,
        views: video.views, likes: video.likes,
      },
      tempo_ms: Date.now() - inicio, modelo: 'template_fallback',
      analises_restantes: rl.analises_restantes ?? 999,
      aviso: 'Blublu tá num momento complicado. Te dei uma análise baseada em padrões — volta em uns minutos pra uma análise completa.',
    };
  }

  const analise = parseJsonSafe(out.text);
  if (!analise?.ato_1) {
    console.error('[gerar-analise-final] JSON invalido:', out.text.slice(0, 300));
    // Fallback tambem quando JSON vem torto
    const analiseFallback = gerarAnaliseFallback(video, respostas, auth.nome);
    return {
      ok: true, fallback: true, nome: auth.nome,
      abertura_blublu: analiseFallback.abertura_blublu,
      atos: analiseFallback.atos, quiz: analiseFallback.quiz,
      video: { id: video.id, youtube_id: video.youtube_id, titulo: video.titulo, thumbnail: video.thumbnail_url, canal: video.canal_nome, nicho: video.nicho, views: video.views, likes: video.likes },
      tempo_ms: Date.now() - inicio, modelo: 'template_fallback_json',
      analises_restantes: rl.analises_restantes ?? 999,
      aviso: 'Blublu tá num momento complicado. Te dei uma análise baseada em padrões.',
    };
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
    registrarUso(ctx, auth.user.id, auth.user.email),
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
  const rl = await checarRateLimitEBudget(ctx, auth.user.id, auth.user.email);
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

// ═════════════════════════════════════════════════════════════════════════════
// ACTION: analisar-meu-video — fluxo novo "meu video" com 4 tiers de analise
// Usuario cola o video do proprio canal. Blublu avalia pela performance real
// (views por dia desde publicacao) e gera feedback adaptado ao tier.
// ═════════════════════════════════════════════════════════════════════════════
async function analisarMeuVideo(ctx, req) {
  const { token, entrada: ent } = req.body || {};
  const inicio = Date.now();

  const auth = await requireMaster(ctx, token);
  if (!auth.ok) return { error: auth.error, status: auth.status };
  const rl = await checarRateLimitEBudget(ctx, auth.user.id, auth.user.email);
  if (!rl.permitido) return rl;

  const ytId = extrairYoutubeId(ent);
  if (!ytId) return { error: 'URL ou ID invalido. Cole o link completo do seu Short.', status: 400 };

  // Busca video (banco primeiro, YouTube depois)
  let video = await buscarVideoDb(ctx, ytId);
  if (!video) video = await buscarVideoYoutube(ytId);
  if (!video) return { error: 'Nao consegui achar esse video. Verifica o link.', status: 404 };

  // Calcula performance real
  const views = parseInt(video.views) || 0;
  const publicadoEm = video.publicado_em ? new Date(video.publicado_em) : null;
  const horasDesdePost = publicadoEm ? Math.max(0.1, (Date.now() - publicadoEm.getTime()) / 3600000) : 24;
  const diasDesdePost = horasDesdePost / 24;
  // Views normalizadas pra primeiro dia (pra comparar com criterio de "1 dia")
  const viewsPrimeiroDia = diasDesdePost <= 1 ? views : Math.round(views / diasDesdePost);

  // Tier baseado nas views do primeiro dia
  let tier;
  if (viewsPrimeiroDia >= 1_000_000)  tier = 'campeao';
  else if (viewsPrimeiroDia >= 150_000) tier = 'bom';
  else if (viewsPrimeiroDia >= 40_000)  tier = 'medio';
  else                                  tier = 'ruim';

  // Tom base compartilhado (professor-aluno com humor nerd)
  const tomBase = `
PERSONALIDADE BLUBLU PROFESSOR:
- Voce e Blublu, mestre sabio e arrogante, mas agora em modo MENTOR de ${auth.nome}
- Trata ${auth.nome} como 'jovem padawan' em pelo menos 1 momento da analise
- Use referencias nerds dosadas (1-2 por analise): Jedi, Matrix, One Piece, Hogwarts, Fellowship, Xavier, Doctor Strange, Bruce Wayne, Goku/Saiyajin, Coach Carter, Dr. Strange
- Metaforas geek: 'nivel 1 de Souls-like', 'sem checkpoint', 'easter egg', 'side quest',
  'ultimate skill', 'final boss do algoritmo', 'XP', 'respawn', 'combo', 'glitch no hook'
- Alivio comico entre verdades duras (ninguem gosta de critica seca)
- Professor que implica mas quer o aluno fora do colo
- NUNCA use mais de 2 referencias nerds por analise (fica forcado)`;

  const promptsPorTier = {
    campeao: `Voce e Blublu. O criador ${auth.nome} trouxe um video que EXPLODIU: ${viewsPrimeiroDia.toLocaleString('pt-BR')} views em ${Math.round(diasDesdePost*10)/10} dias. Isso e raro. 1M+ em 1 dia equivalente.
${tomBase}

MODO COMEDIANTE + ALUNO-SUPEROU-MESTRE: ${auth.nome} te superou. Brinque com isso (tipo Obi-Wan orgulhoso de Luke, ou mestre nocauteado no treino). Seja auto-depreciativo com humor, peca pra ${auth.nome} te ensinar. Reflexao final: o jedi caiu pro padawan, hora de subir outro degrau.`,

    bom: `Voce e Blublu. ${auth.nome} trouxe um video que PERFORMOU BEM: ${viewsPrimeiroDia.toLocaleString('pt-BR')} views em ${Math.round(diasDesdePost*10)/10} dias (150k-1M em 1 dia equivalente).
${tomBase}

Tom professor satisfeito com o padawan que esta no caminho certo. Analise O QUE FUNCIONOU especificamente. 2-3 dicas pro proximo nivel (proximo boss, proximo nivel de skill tree). Mostre que voce ve potencial pra 'Ultimate'.`,

    medio: `Voce e Blublu. ${auth.nome} trouxe um video com performance MEDIA: ${viewsPrimeiroDia.toLocaleString('pt-BR')} views em ${Math.round(diasDesdePost*10)/10} dias (40k-150k em 1 dia equivalente).
${tomBase}

Tom professor honesto: padawan promissor mas ainda nao dominou a forca. Balanceada: 1-2 acertos + 2-3 pontos a melhorar. Metaforas de treino/grind/XP sao bem-vindas. Sem tapinha nas costas, sem crueldade.`,

    ruim: `Voce e Blublu. ${auth.nome} trouxe um video que NAO PERFORMOU: ${viewsPrimeiroDia.toLocaleString('pt-BR')} views em ${Math.round(diasDesdePost*10)/10} dias (<40k em 1 dia).
${tomBase}

MODO DEEP ANALYSIS + PROFESSOR NO TREINO: honesto mas construtivo. Compare com erros classicos ('esse hook e tipo o Luke atacando Vader sem treinar'). Passo a passo tipo tutorial: hook (primeiros 3s), estrutura narrativa, thumbnail, CTA. De exemplo de reescrita concreta. Reflexao final: 'todo jedi ja caiu, o treino continua'.`,
  };

  const prompt = `${promptsPorTier[tier]}

VIDEO:
Titulo: "${video.titulo}"
Canal: ${video.canal_nome}
Views: ${views.toLocaleString('pt-BR')}
Likes: ${(video.likes || 0).toLocaleString('pt-BR')}
Comentarios: ${(video.comentarios || 0).toLocaleString('pt-BR')}
Duracao: ${video.duracao_segundos}s
Publicado ha: ${Math.round(diasDesdePost*10)/10} dias
Nicho: ${video.nicho || 'nao classificado'}

Retorne APENAS JSON valido:
{
  "tier": "${tier}",
  "abertura_blublu": "Frase de Blublu abrindo a analise, com tom adequado ao tier",
  "diagnostico": {
    "titulo": "Titulo curto do diagnostico",
    "resumo": "2-3 frases explicando o que aconteceu com esse video",
    "viewsPrimeiroDia": ${viewsPrimeiroDia}
  },
  "pontos_fortes": ["bullet 1", "bullet 2", "bullet 3"],
  "pontos_fracos": ["bullet 1", "bullet 2", "bullet 3"],
  "recomendacoes": [
    {"titulo": "...", "descricao": "...", "exemplo_pratico": "..."},
    {"titulo": "...", "descricao": "...", "exemplo_pratico": "..."},
    {"titulo": "...", "descricao": "...", "exemplo_pratico": "..."}
  ],
  "reflexao_final": "Frase motivacional de Blublu pra fechar a analise, adequada ao tier"
}`;

  let out;
  try {
    out = await callClaudeStudio(prompt, { model: 'claude-sonnet-4-6', maxTokens: 3000 });
  } catch (e) {
    console.error('[analisar-meu-video]', e.message);
    return { error: 'Blublu está descansando. Volta em alguns minutos.', status: 503 };
  }

  const analise = parseJsonSafe(out.text);
  if (!analise?.recomendacoes) {
    return { error: 'Falha ao processar análise. Tente novamente.', status: 500 };
  }

  const custoBRL = parseFloat((
    (out.tokens_input / 1_000_000) * COST_INPUT_PER_MTOK_BRL +
    (out.tokens_output / 1_000_000) * COST_OUTPUT_PER_MTOK_BRL
  ).toFixed(4));

  // Persiste como tipo especial
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
        analise_atos: { tipo: 'meu_video', tier, ...analise, dias_desde_post: diasDesdePost, views_primeiro_dia: viewsPrimeiroDia },
        nome_usuario: auth.nome,
        tempo_total_ms: Date.now() - inicio,
        custo_tokens_input: out.tokens_input,
        custo_tokens_output: out.tokens_output,
        custo_brl: custoBRL,
        modelo_usado: out.model,
      }),
    });
    if (insR.ok) { const [row] = await insR.json(); analiseId = row?.id || null; }
  } catch (e) { console.error('[insert meu_video]', e.message); }

  await Promise.all([
    registrarUso(ctx, auth.user.id, auth.user.email),
    atualizarBudgetDiario(ctx, custoBRL),
  ]);

  return {
    ok: true,
    analise_id: analiseId,
    tier,
    nome: auth.nome,
    video: {
      id: video.id, youtube_id: video.youtube_id, titulo: video.titulo,
      thumbnail: video.thumbnail_url, canal: video.canal_nome,
      views, likes: video.likes, publicado_em: video.publicado_em,
    },
    performance: {
      views_primeiro_dia: viewsPrimeiroDia,
      dias_desde_post: Math.round(diasDesdePost * 10) / 10,
    },
    analise,
    analises_restantes: rl.analises_restantes ? Math.max(0, rl.analises_restantes - 1) : 999,
  };
}
