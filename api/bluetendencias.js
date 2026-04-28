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
const { sentryCapture } = require('./_helpers/sentry.js');
const blubluPersonality = require('./_helpers/blublu-personality.js');

// Sonnet 4.6: $3/MTok input, $15/MTok output (taxa ~R$5)
const COST_INPUT_PER_MTOK_BRL  = 15;
const COST_OUTPUT_PER_MTOK_BRL = 75;

// Versao do prompt — controla v2 (prompts inline antigos) vs v3 (helper).
// Gravada em studio_analises.prompt_version pra permitir A/B e rollback.
// Feature flag via env BLUBLU_VERSION (default v3.0-blublu-realista).
// Rollback sem deploy: setar BLUBLU_VERSION='v2.0-split' no Vercel.
const PROMPT_VERSION = process.env.BLUBLU_VERSION || 'v3.0-blublu-realista';
const USAR_V3 = blubluPersonality.isV3Active(PROMPT_VERSION);

// Easter egg: idolos que ativam personalidade 'fa histerico' do Blublu.
// Detecta pelo nome do canal (case-insensitive, match por inclusao/igualdade).
const IDOLOS_EASTER_EGG = {
  luiz: {
    nome: 'Luiz',
    nome_completo: 'Luiz Stubbe',
    canal_patterns: ['luiz stubbe', 'luiz_stubbe', 'opiska'],
  },
  giuliana: {
    nome: 'Giuliana',
    nome_completo: 'Giuliana Mafra',
    canal_patterns: ['giuliana mafra', 'cortes giuliana mafra oficial', 'giulianamafra'],
  },
};

function detectarIdolo(video) {
  const nome = String(video?.canal_nome || '').toLowerCase().trim();
  if (!nome) return null;
  for (const [id, data] of Object.entries(IDOLOS_EASTER_EGG)) {
    if (data.canal_patterns.some(p => nome === p || nome.includes(p))) {
      return { id, nome: data.nome, nome_completo: data.nome_completo };
    }
  }
  return null;
}

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
    if (action === 'diagnostico')          return res.status(200).json(await diagnosticoStudio(ctx, req));
    if (action === 'smoke-test')           return res.status(200).json(await smokeTest(ctx, req));
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
    sentryCapture(e, { tags: { action, handler: 'dispatcher' }, extra: { method: req.method } });
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

// Limites por feature — janela rolante de 15h (sliding window).
// iniciar-analise e analisar-video sao caminhos de entrada; dissecar
// eh o caminho completo (gerarAnaliseFinal) que consome mais tokens.
const RATE_JANELA_MS = 15 * 60 * 60 * 1000; // 15 horas
const RATE_LIMITES = {
  'iniciar-analise': 2,
  'analisar-video': 2,
  'dissecar': 4,
};

async function checarRateLimitEBudget(ctx, userId, userEmail, feature = 'dissecar') {
  // Bypass total pra emails na whitelist (owner/testers)
  if (isUnlimitedEmail(userEmail)) {
    return { permitido: true, analises_restantes: 999, analises_total: 999, feature, unlimited: true };
  }

  const limite = RATE_LIMITES[feature] ?? 4;
  const janelaISO = new Date(Date.now() - RATE_JANELA_MS).toISOString();
  const rlR = await fetch(
    `${ctx.SU}/rest/v1/studio_rate_limits?user_id=eq.${userId}&feature=eq.${feature}&usado_em=gte.${janelaISO}&select=usado_em&order=usado_em.asc`,
    { headers: ctx.h }
  );
  const usos = rlR.ok ? await rlR.json() : [];
  const restantes = Math.max(0, limite - usos.length);
  if (restantes === 0) {
    const antiga = usos[0];
    const proximaEm = antiga ? new Date(new Date(antiga.usado_em).getTime() + RATE_JANELA_MS) : null;
    return { permitido: false, motivo: 'limite_atingido', feature, usadas: usos.length, limite, proxima_em: proximaEm?.toISOString() };
  }

  // Budget global ainda protege contra abuso massivo
  const hoje = new Date().toISOString().split('T')[0];
  const bR = await fetch(`${ctx.SU}/rest/v1/studio_budget_diario?data=eq.${hoje}&select=*&limit=1`, { headers: ctx.h });
  const [budget] = bR.ok ? await bR.json() : [];
  if (budget && budget.ativo === false) {
    return { permitido: false, motivo: 'sistema_pausado', mensagem: 'Blublu está descansando. Volta em algumas horas.' };
  }

  return { permitido: true, analises_restantes: restantes, analises_total: limite, feature };
}

async function registrarUso(ctx, userId, userEmail, feature = 'dissecar') {
  // Nao registra pra unlimited (nao poluir tabela de rate limits)
  if (isUnlimitedEmail(userEmail)) return;
  await fetch(`${ctx.SU}/rest/v1/studio_rate_limits`, {
    method: 'POST', headers: { ...ctx.h, Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: userId, feature }),
  }).catch(() => {});
}

// Thresholds de alerta progressivo no budget (50%, 75%, 90%, 100%).
// Cada nivel dispara 1x por dia (controlado via coluna alertas_enviados jsonb).
const BUDGET_ALERTAS = [
  { pct: 0.5,  key: 't50',  subject: '💙 Blublu em 50% do budget diario',   tom: 'Sistema saudavel, crescendo.',         urgencia: '' },
  { pct: 0.75, key: 't75',  subject: '💛 Blublu em 75% do budget diario',   tom: 'Atencao: considere aumentar o cap.',   urgencia: 'margem apertada' },
  { pct: 0.9,  key: 't90',  subject: '🔴 Blublu em 90% do budget diario',   tom: 'Critico: vai pausar em breve.',        urgencia: 'acao recomendada' },
  { pct: 1.0,  key: 't100', subject: '⚠️ Budget diario Blublu atingido',   tom: 'Sistema pausado ate meia-noite UTC.',  urgencia: 'pausado' },
];

async function enviarAlertaBudget(threshold, gasto, limite) {
  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) return;
  const pct = Math.round((gasto / limite) * 100);
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'BlueTube <noreply@bluetubeviral.com>',
      to: [process.env.ADMIN_EMAIL],
      subject: threshold.subject,
      html: `<div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto">
        <h2 style="color:#020817">${threshold.subject}</h2>
        <p style="font-size:14px;color:#333">Gasto hoje: <b>R$${gasto.toFixed(2)}</b> de R$${limite.toFixed(2)} (${pct}%)</p>
        <p style="font-size:14px;color:#333">${threshold.tom}</p>
        ${threshold.urgencia ? `<p style="font-size:13px;color:#aa0000"><b>Urgencia:</b> ${threshold.urgencia}</p>` : ''}
        ${threshold.pct >= 0.75 ? `<p style="font-size:12px;color:#666">Pra aumentar o cap, edite STUDIO_DAILY_BUDGET_BRL no Vercel.</p>` : ''}
      </div>`,
    }),
  }).catch(() => {});
}

async function atualizarBudgetDiario(ctx, custoBRL) {
  const hoje = new Date().toISOString().split('T')[0];
  const r = await fetch(`${ctx.SU}/rest/v1/studio_budget_diario?data=eq.${hoje}&select=*&limit=1`, { headers: ctx.h });
  const [atual] = r.ok ? await r.json() : [];
  const gastoAntigo = atual?.gasto_brl || 0;
  const novoGasto = parseFloat((gastoAntigo + custoBRL).toFixed(4));
  const limite = parseFloat(process.env.STUDIO_DAILY_BUDGET_BRL || '200');
  const ativo = novoGasto < limite;

  // Detecta cruzamento de threshold (antigo < pct <= novo)
  const alertasJa = Array.isArray(atual?.alertas_enviados) ? atual.alertas_enviados : [];
  const novosAlertas = [];
  for (const t of BUDGET_ALERTAS) {
    const cruzou = (gastoAntigo / limite < t.pct) && (novoGasto / limite >= t.pct);
    if (cruzou && !alertasJa.includes(t.key)) {
      novosAlertas.push(t);
    }
  }

  await fetch(`${ctx.SU}/rest/v1/studio_budget_diario`, {
    method: 'POST',
    headers: { ...ctx.h, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      data: hoje, gasto_brl: novoGasto,
      total_analises: (atual?.total_analises || 0) + 1,
      budget_limite: limite, ativo, atualizado_em: new Date().toISOString(),
      alertas_enviados: [...alertasJa, ...novosAlertas.map(a => a.key)],
    }),
  }).catch(() => {});

  // Dispara emails dos thresholds recem cruzados (fire-and-forget)
  for (const t of novosAlertas) { enviarAlertaBudget(t, novoGasto, limite); }

  // Mantem o email legacy de "atingido" por compat visual, ja coberto pelo t100 acima.
  if (false && !ativo && atual?.ativo && process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
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
// 4o param 'version' opcional: passe pra invalidar cache em mudancas de prompt.
// Usado em 'narrativa' e 'aplicacao' (atos 1-5). NAO usar em 'meu_video'
// (schema diferente, escopo separado, cache existente preservado).
function cacheKey(videoId, tipo, contexto = {}, version = null) {
  const payload = version ? { videoId, tipo, ctx: contexto, v: version } : { videoId, tipo, ctx: contexto };
  const norm = JSON.stringify(payload);
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

// Classifica erros pra decidir estrategia de retry.
//  - FATAL_CONFIG: chave invalida, auth. Alerta admin imediato, nao retenta.
//  - OVERLOADED: 429/529. Backoff maior e retenta no mesmo modelo.
//  - TRANSIENT: 5xx genericos. Retenta no mesmo modelo.
//  - TIMEOUT: Abort local. Nao adianta retry — fallback direto.
//  - OTHER: tratado como TRANSIENT.
function classificarErroClaude(e) {
  const msg = String(e?.message || e || '');
  if (e?.name === 'AbortError' || /aborted|timeout/i.test(msg)) return 'TIMEOUT';
  if (/Claude\s*(401|403)/.test(msg)) return 'FATAL_CONFIG';
  if (/Claude\s*400/.test(msg)) return 'FATAL_CONFIG'; // input malformado — nao adianta retry
  if (/Claude\s*(429|529)/.test(msg)) return 'OVERLOADED';
  if (/Claude\s*5\d{2}/.test(msg)) return 'TRANSIENT';
  return 'TRANSIENT';
}

async function alertarChaveInvalida(componente, erroMsg) {
  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'BlueTube <noreply@bluetubeviral.com>',
      to: [process.env.ADMIN_EMAIL],
      subject: `🔴 URGENTE: chave ${componente} invalida/expirada`,
      html: `<h2>Chave API ${componente} rejeitada pela Anthropic</h2>
        <p style="color:#333">Resposta: <code>${erroMsg.slice(0, 200)}</code></p>
        <p><b>Acao:</b> gerar nova chave em <a href="https://console.anthropic.com">console.anthropic.com</a> e atualizar ANTHROPIC_API_KEY_STUDIO no Vercel.</p>
        <p style="color:#aa0000">Enquanto isso, Blublu esta usando fallback template.</p>`,
    }),
  }).catch(() => {});
}

// Wrapper com retry inteligente por tipo de erro + circuit breaker + health tracking
async function callClaudeStudio(prompt, opts = {}) {
  const model = opts.model || 'claude-sonnet-4-6';
  const comp = model.includes('haiku') ? 'anthropic_haiku' : 'anthropic_sonnet';
  const ctx = opts.ctx;
  if (ctx && await isCircuitoAberto(ctx, comp)) throw new Error('CIRCUITO_ABERTO');

  const maxRetries = 2;
  let ultimoErro = null;
  for (let tentativa = 0; tentativa < maxRetries; tentativa++) {
    try {
      const result = await callClaudeRaw(prompt, opts);
      if (ctx) registrarSucesso(ctx, comp).catch(() => {});
      return result;
    } catch (e) {
      ultimoErro = e;
      const tipo = classificarErroClaude(e);
      // FATAL_CONFIG: alerta admin e sai imediato — retry nao resolve
      if (tipo === 'FATAL_CONFIG') {
        console.error(`[callClaudeStudio] FATAL_CONFIG (${e.message}) — alertando admin e abortando`);
        alertarChaveInvalida(comp, e.message).catch(() => {});
        sentryCapture(e, { level: 'fatal', tags: { component: comp, tipo: 'FATAL_CONFIG' } });
        break; // nao retenta
      }
      // TIMEOUT: nao adianta re-tentar mesma chamada — cai rapido pro fallback externo
      if (tipo === 'TIMEOUT') {
        console.warn(`[callClaudeStudio] TIMEOUT em ${comp} — pulando retry, indo pro fallback externo`);
        break;
      }
      // OVERLOADED: backoff maior (3s) antes de tentar de novo
      // TRANSIENT: backoff menor (1s)
      if (tentativa < maxRetries - 1) {
        const delay = tipo === 'OVERLOADED' ? 3000 : 1000;
        console.warn(`[callClaudeStudio] ${tipo} em ${comp} (tentativa ${tentativa + 1}), retry em ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  if (ctx) registrarFalha(ctx, comp).catch(() => {});
  throw ultimoErro || new Error('Claude falhou apos retries');
}

async function callClaudeRaw(prompt, { model = 'claude-sonnet-4-6', maxTokens = 3500, system, cacheSystem = false } = {}) {
  if (!process.env.ANTHROPIC_API_KEY_STUDIO) throw new Error('ANTHROPIC_API_KEY_STUDIO nao configurada');
  // Timeout 55s na chamada — Sonnet com 3500 tokens pode estourar 45s
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);

  // Se cacheSystem=true, envia system como array com cache_control pra habilitar
  // prompt caching do Anthropic (economia de 90% no input repetido, 5 min TTL).
  // Min 1024 tokens no system pra valer.
  let systemField;
  if (system) {
    systemField = cacheSystem
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system;
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY_STUDIO,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: systemField, messages: [{ role: 'user', content: prompt }] }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
  if (!r.ok) { const err = await r.text().catch(() => ''); throw new Error(`Claude ${r.status}: ${err.slice(0, 200)}`); }
  const data = await r.json();
  return {
    text: data.content?.[0]?.text || '',
    tokens_input: data.usage?.input_tokens || 0,
    tokens_output: data.usage?.output_tokens || 0,
    tokens_cache_read: data.usage?.cache_read_input_tokens || 0,
    tokens_cache_created: data.usage?.cache_creation_input_tokens || 0,
    model: data.model || model,
  };
}

// Wrapper com fallback Sonnet -> Haiku por erro.
// Sonnet e o primario (qualidade). Se falhar por erro real (nao lentidao),
// Haiku assume pra nao deixar o user na mao. So cai no template se ambos
// falharem. Essa e a "Estrategia A" do fallback por erro.
async function callClaudeStudioComFallback(prompt, opts = {}) {
  try {
    const out = await callClaudeStudio(prompt, { ...opts, model: 'claude-sonnet-4-6' });
    return { ...out, modelo_usado: 'sonnet', fallback_usado: false };
  } catch (e) {
    console.warn(`[bluetendencias] Sonnet falhou (${e.message.slice(0, 100)}) — tentando Haiku`);
    const out = await callClaudeStudio(prompt, { ...opts, model: 'claude-haiku-4-5' });
    return { ...out, modelo_usado: 'haiku', fallback_usado: true };
  }
}

// Self-critique: depois que a analise foi entregue ao user, chama Haiku pra
// avaliar qualidade (especificidade, personalidade, acionabilidade) e grava
// score no studio_analises. Fire-and-forget — nao bloqueia UX. Admin consulta
// `SELECT * FROM studio_analises WHERE quality_score < 5` pra ver flagadas.
async function autoAvaliarQualidade(ctx, analiseId, analise, video, nome) {
  try {
    const resumo = {
      abertura: String(analise.abertura_blublu || '').slice(0, 300),
      ato_1_conteudo: String(analise.ato_1?.conteudo_principal || '').slice(0, 300),
      ato_3_conteudo: String(analise.ato_3?.conteudo_principal || '').slice(0, 300),
      ato_5_sugestao_1: String(analise.ato_5?.sugestoes?.[0]?.exemplo_pratico || '').slice(0, 300),
    };
    const prompt = `Avalie essa analise de video viral gerada pra ${nome}. Video: "${video.titulo}" (${video.views} views).

Trechos da analise:
Abertura: ${resumo.abertura}
Ato 1 (Hook): ${resumo.ato_1_conteudo}
Ato 3 (Gatilho Viral): ${resumo.ato_3_conteudo}
Ato 5 sugestao pratica: ${resumo.ato_5_sugestao_1}

Avalie em 3 eixos (1-10 cada):
1. ESPECIFICIDADE: cita numeros/detalhes do video ou e generica?
2. ACIONABILIDADE: sugestao pratica executavel ou vaga?
3. PERSONALIDADE: tom arrogante/divertido do Blublu ou neutra?

Retorne APENAS JSON:
{"especificidade": N, "acionabilidade": N, "personalidade": N, "score_geral": N, "problemas": ["bullet1", "bullet2"]}

Se tudo >=7, "problemas" fica array vazio. Se score_geral <5, seja especifico nos problemas.`;

    const out = await callClaudeRaw(prompt, { model: 'claude-haiku-4-5', maxTokens: 400 });
    const avaliacao = parseJsonSafe(out.text);
    if (!avaliacao || typeof avaliacao.score_geral !== 'number') return;

    await fetch(`${ctx.SU}/rest/v1/studio_analises?id=eq.${analiseId}`, {
      method: 'PATCH', headers: { ...ctx.h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        quality_score: avaliacao.score_geral,
        quality_details: avaliacao,
      }),
    }).catch(() => {});

    if (avaliacao.score_geral < 5) {
      console.warn(`[auto-avaliar] analise ${analiseId} score baixo:`, avaliacao.score_geral, avaliacao.problemas);
      sentryCapture(new Error(`Analise qualidade baixa: score ${avaliacao.score_geral}`), {
        level: 'warning',
        tags: { action: 'quality_check', low_score: 'true' },
        extra: { analise_id: analiseId, video: video.youtube_id, avaliacao },
      });
    }
  } catch (e) { /* silencioso — nao queremos falhas do critic afetando nada */ }
}

function parseJsonSafe(text) {
  if (!text) return null;
  let t = String(text).trim();
  // Remove markdown code fences comuns em respostas de LLM
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  // Encontra o primeiro { e fecha no } balanceado (evita pegar lixo posterior)
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  const raw = t.slice(start, end + 1);
  try { return JSON.parse(raw); } catch (e) {
    // Fallback: remove trailing commas (bug comum em saidas de LLM)
    try { return JSON.parse(raw.replace(/,(\s*[}\]])/g, '$1')); } catch (e2) { return null; }
  }
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
// ACTION: diagnostico — estado do sistema pra debug rapido (precisa master)
// Retorna: chave configurada, circuit breakers, budget, rate limit, ping Claude
// ═════════════════════════════════════════════════════════════════════════════
async function diagnosticoStudio(ctx, req) {
  const token = req.query.token || req.body?.token;
  const auth = await requireMaster(ctx, token);
  if (!auth.ok) return { error: auth.error, status: auth.status };

  const info = {
    timestamp: new Date().toISOString(),
    user: { id: auth.user.id, email: auth.user.email, nome: auth.nome },
    chaves: {
      anthropic_studio: !!process.env.ANTHROPIC_API_KEY_STUDIO,
      anthropic_principal: !!process.env.ANTHROPIC_API_KEY,
      supabase_url: !!process.env.SUPABASE_URL,
      supabase_key: !!process.env.SUPABASE_SERVICE_KEY,
    },
    config: {
      daily_budget_brl: parseFloat(process.env.STUDIO_DAILY_BUDGET_BRL || '200'),
      max_per_user_24h: parseInt(process.env.STUDIO_MAX_PER_USER_24H || '0', 10),
    },
  };

  // Circuit breakers (sonnet + haiku)
  try {
    const r = await fetch(`${ctx.SU}/rest/v1/studio_health?select=componente,falhas_consecutivas,circuito_aberto_ate,total_chamadas,total_falhas,updated_at`, { headers: ctx.h });
    const rows = r.ok ? await r.json() : [];
    info.circuit_breakers = rows.map(r => ({
      ...r,
      aberto_agora: r.circuito_aberto_ate ? new Date(r.circuito_aberto_ate) > new Date() : false,
    }));
  } catch(e) { info.circuit_breakers = 'erro: ' + e.message; }

  // Budget de hoje
  try {
    const hoje = new Date().toISOString().split('T')[0];
    const r = await fetch(`${ctx.SU}/rest/v1/studio_budget_diario?data=eq.${hoje}&select=*&limit=1`, { headers: ctx.h });
    const [b] = r.ok ? await r.json() : [];
    info.budget_hoje = b || { data: hoje, gasto_brl: 0, total_analises: 0, ativo: true };
  } catch(e) { info.budget_hoje = 'erro: ' + e.message; }

  // Analises do user em 24h
  try {
    const desde = new Date(Date.now() - 86400000).toISOString();
    const r = await fetch(`${ctx.SU}/rest/v1/studio_rate_limits?user_id=eq.${auth.user.id}&usado_em=gte.${desde}&select=usado_em`, { headers: ctx.h });
    const rows = r.ok ? await r.json() : [];
    info.uso_24h_user = { analises: rows.length, primeira: rows[0]?.usado_em || null };
  } catch(e) { info.uso_24h_user = 'erro: ' + e.message; }

  // Teste real do Claude (latencia + resposta)
  if (process.env.ANTHROPIC_API_KEY_STUDIO) {
    const t0 = Date.now();
    try {
      const out = await callClaudeRaw('Responda APENAS com a palavra PONG.', { maxTokens: 10, model: 'claude-haiku-4-5' });
      info.claude_ping = { ok: true, latencia_ms: Date.now() - t0, resposta: out.text.slice(0, 50), tokens: out.tokens_input + out.tokens_output };
    } catch(e) { info.claude_ping = { ok: false, latencia_ms: Date.now() - t0, erro: e.message }; }
  } else {
    info.claude_ping = { ok: false, erro: 'chave ANTHROPIC_API_KEY_STUDIO nao configurada' };
  }

  return info;
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION: smoke-test — teste automatico diario (cron)
// Faz 1 chamada minima ao Claude pra validar que tudo esta respondendo.
// Se falhar, alerta admin. Nao gera analise real (nao polui studio_analises).
// Uso: vercel cron chama GET /api/bluetendencias?action=smoke-test
// ═════════════════════════════════════════════════════════════════════════════
async function smokeTest(ctx, req) {
  const inicio = Date.now();
  const resultado = {
    timestamp: new Date().toISOString(),
    testes: {},
    saudavel: true,
    erros: [],
  };

  // Teste 1: chave Studio configurada
  resultado.testes.chave_studio_presente = !!process.env.ANTHROPIC_API_KEY_STUDIO;
  if (!resultado.testes.chave_studio_presente) {
    resultado.saudavel = false;
    resultado.erros.push('ANTHROPIC_API_KEY_STUDIO ausente no ambiente');
  }

  // Teste 2: Supabase responsivo
  try {
    const r = await fetch(`${ctx.SU}/rest/v1/studio_health?select=componente&limit=1`, { headers: ctx.h });
    resultado.testes.supabase_ok = r.ok;
    if (!r.ok) {
      resultado.saudavel = false;
      resultado.erros.push(`Supabase respondeu ${r.status}`);
    }
  } catch (e) {
    resultado.testes.supabase_ok = false;
    resultado.saudavel = false;
    resultado.erros.push('Supabase inacessivel: ' + e.message);
  }

  // Teste 3: Haiku ping (rapido)
  if (resultado.testes.chave_studio_presente) {
    const t0 = Date.now();
    try {
      const out = await callClaudeRaw('Responda APENAS com PONG.', { model: 'claude-haiku-4-5', maxTokens: 10 });
      resultado.testes.haiku_ping = { ok: true, latencia_ms: Date.now() - t0, tokens: (out.tokens_input || 0) + (out.tokens_output || 0) };
    } catch (e) {
      resultado.testes.haiku_ping = { ok: false, erro: e.message };
      resultado.saudavel = false;
      resultado.erros.push('Haiku ping falhou: ' + e.message);
    }
  }

  // Teste 4: Sonnet ping
  if (resultado.testes.chave_studio_presente && resultado.saudavel) {
    const t0 = Date.now();
    try {
      const out = await callClaudeRaw('Responda APENAS com PONG.', { model: 'claude-sonnet-4-6', maxTokens: 10 });
      resultado.testes.sonnet_ping = { ok: true, latencia_ms: Date.now() - t0, tokens: (out.tokens_input || 0) + (out.tokens_output || 0) };
    } catch (e) {
      resultado.testes.sonnet_ping = { ok: false, erro: e.message };
      resultado.saudavel = false;
      resultado.erros.push('Sonnet ping falhou: ' + e.message);
    }
  }

  // Teste 5: budget hoje nao esta pausado
  try {
    const hoje = new Date().toISOString().split('T')[0];
    const bR = await fetch(`${ctx.SU}/rest/v1/studio_budget_diario?data=eq.${hoje}&select=*&limit=1`, { headers: ctx.h });
    const [b] = bR.ok ? await bR.json() : [];
    const ativo = b ? b.ativo !== false : true;
    resultado.testes.budget_ativo = ativo;
    if (!ativo) {
      // Nao e falha critica — mas vale avisar
      resultado.erros.push('Budget do dia atingido — sistema pausado ate meia-noite UTC');
    }
  } catch (e) { /* nao bloqueia teste */ }

  resultado.tempo_total_ms = Date.now() - inicio;

  // Se algo falhou, alerta admin
  if (!resultado.saudavel && process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'BlueTube <noreply@bluetubeviral.com>',
          to: [process.env.ADMIN_EMAIL],
          subject: '🔴 Smoke test Blublu falhou',
          html: `<div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto">
            <h2 style="color:#aa0000">Smoke test BlueTendencias detectou problema</h2>
            <p><b>Erros:</b></p>
            <ul>${resultado.erros.map(e => `<li style="color:#333">${e}</li>`).join('')}</ul>
            <p style="font-size:12px;color:#666;margin-top:20px">Timestamp: ${resultado.timestamp}</p>
            <p style="font-size:12px;color:#666">Rode <code>/api/bluetendencias?action=diagnostico&token=SEU_TOKEN</code> pra detalhes completos.</p>
          </div>`,
        }),
      });
    } catch (e) {}
    sentryCapture(new Error('Smoke test falhou: ' + resultado.erros.join(' | ')), {
      level: 'error', tags: { action: 'smoke-test' }, extra: resultado,
    });
  }

  return resultado;
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
  // Usa feature 'dissecar' (4/15h) como a principal exibida na tela de entrada.
  const rl = await checarRateLimitEBudget(ctx, auth.user.id, auth.user.email, 'dissecar');

  return {
    nome: auth.nome,
    email: auth.user.email,
    restantes: rl.analises_restantes ?? 0,
    analises_total: rl.analises_total ?? 4,
    proxima_em: rl.proxima_em || null,
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

  return {
    video, projecoes, receita, engagement,
    comparacao_nicho: compNicho, ranking,
    easter_egg: detectarIdolo(video),
  };
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
  const rl = await checarRateLimitEBudget(ctx, auth.user.id, auth.user.email, 'iniciar-analise');
  if (!rl.permitido) return rl;
  // Registra uso da feature 'iniciar-analise' (2/15h) — enforca o limite
  // independentemente do user ir ate o final ou cancelar depois.
  registrarUso(ctx, auth.user.id, auth.user.email, 'iniciar-analise').catch(() => {});

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
  const rl = await checarRateLimitEBudget(ctx, auth.user.id, auth.user.email, 'dissecar');
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

  // ───── SELECAO DE PROMPTS POR VERSAO ─────
  // v2.0-split: prompts inline antigos (preservados 100%, regressao zero).
  // v3+: helper blublu-personality.js gera prompts a partir do manifesto.
  let systemPrompt, promptParte1, promptParte2;

  if (USAR_V3) {
    // v3: helper injeta manifesto + tecnicas + dados do video no user prompt.
    // System fica vazio (sem cache ephemeral por enquanto — pode ser otimizado
    // num commit futuro separando manifesto pra system, dados pra user).
    systemPrompt = null;
    const promptCtx = {
      nome: auth.nome,
      video,
      respostas,
      duracaoMedia,
      statsNichoLen: statsNicho.length,
      easterEgg: detectarIdolo(video),
    };
    promptParte1 = blubluPersonality.buildBlubluPrompt('narrativa', promptCtx);
    promptParte2 = blubluPersonality.buildBlubluPrompt('aplicacao', promptCtx);
  } else {
    // v2: prompts inline antigos. Mantidos identicos pra rollback fiel.
    systemPrompt = `Voce e Blublu, IA de analise de virais mais avancada do mercado.
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
Virais de referencia analisados: ${statsNicho.length}`;

    promptParte1 = `ENTREGA: atos 1-4 (narrativa tecnica do video). Cada ato tem:
- titulo (curto, impactante)
- blublu_intro (frase introduzindo o ato, com personalidade, SEM citar nome de pessoa)
- conteudo_principal (analise objetiva, 2-3 frases MAX)
- highlights (array de 2-3 bullets curtos e punchy)
- blublu_outro (frase final com personalidade, SEM citar nome de pessoa)

REGRA: os atos 1-4 analisam O VIDEO. NAO use "${auth.nome}" nem nome algum de pessoa.
Referencias pessoais ficam pra parte 2 (aplicacao + quiz).

Retorne APENAS JSON valido:
{
  "ato_1": {"titulo":"O Hook","blublu_intro":"...","conteudo_principal":"...","highlights":["...","...","..."],"blublu_outro":"..."},
  "ato_2": {"titulo":"A Estrutura","blublu_intro":"...","conteudo_principal":"...","highlights":["...","...","..."],"blublu_outro":"..."},
  "ato_3": {"titulo":"O Gatilho Viral","blublu_intro":"...","conteudo_principal":"...","highlights":["...","...","..."],"blublu_outro":"..."},
  "ato_4": {"titulo":"O Contexto Cultural","blublu_intro":"...","conteudo_principal":"...","highlights":["...","...","..."],"blublu_outro":"..."}
}`;

    promptParte2 = `ENTREGA: abertura_blublu + ato_5 (aplicacao pratica pra ${auth.nome}) + quiz de 3 perguntas.

ATO 5 estrutura especial:
- titulo, blublu_intro
- sugestoes: array com 3 sugestoes { titulo, descricao, exemplo_pratico } baseadas no video e no contexto do ${auth.nome}
- blublu_outro

QUIZ: 3 perguntas (4 opcoes cada) testando se ${auth.nome} absorveu conceitos-chave do video.
Inclua 1 pegadinha. Comentarios de Blublu pra cada resposta (certo/errado) com personalidade.

Retorne APENAS JSON valido:
{
  "abertura_blublu": "Frase abrindo a analise pra ${auth.nome}, com personalidade arrogante/divertida",
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
  }

  // CACHE SEGREGADO:
  //  - 'narrativa': atos 1-4 por video_id (compartilhado entre Masters)
  //  - 'aplicacao': abertura + ato 5 + quiz por video + respostas (por user)
  // Beneficio: se Master B analisar video que Master A ja analisou (ou user A
  // repetir analise com respostas diferentes), a narrativa ja esta pronta.
  // PROMPT_VERSION compoe a key SO em v3+ — mudanca v2→v3 invalida cache.
  // v2 mantem backward compat (cacheKey sem versao = formato antigo).
  // Garante que rollback BLUBLU_VERSION='v2.0-split' reencontra cache pre-v3.
  const versaoCache = USAR_V3 ? PROMPT_VERSION : null;
  const ckNarrativa = cacheKey(video.youtube_id, 'narrativa', {}, versaoCache);
  const ckAplicacao = cacheKey(video.youtube_id, 'aplicacao', respostas || {}, versaoCache);
  const [cachedNarrativa, cachedAplicacao] = await Promise.all([
    getFromCache(ctx, ckNarrativa),
    getFromCache(ctx, ckAplicacao),
  ]);

  // Full hit: as duas partes ja existem → retorna montado sem chamar IA
  if (cachedNarrativa?.ato_1 && cachedAplicacao?.ato_5) {
    console.log('[gerar-analise-final] CACHE HIT FULL (narrativa+aplicacao)');
    return {
      ok: true, cached: true, analise_id: null, nome: auth.nome,
      abertura_blublu: cachedAplicacao.abertura_blublu,
      atos: {
        ato_1: cachedNarrativa.ato_1, ato_2: cachedNarrativa.ato_2,
        ato_3: cachedNarrativa.ato_3, ato_4: cachedNarrativa.ato_4,
        ato_5: cachedAplicacao.ato_5,
      },
      quiz: cachedAplicacao.quiz,
      video: {
        id: video.id, youtube_id: video.youtube_id, titulo: video.titulo,
        thumbnail: video.thumbnail_url, canal: video.canal_nome, nicho: video.nicho,
        views: video.views, likes: video.likes,
      },
      tempo_ms: Date.now() - inicio, modelo: 'cache_full',
      analises_restantes: rl.analises_restantes ?? 999,
    };
  }

  // SPLIT PARALELO + CACHE PARCIAL + FALLBACK POR ERRO
  // Se uma das partes ja esta em cache, nao chama IA pra ela — so pra parte
  // faltante. Reduz 50-100% dos tokens dependendo do hit.
  const baseOpts = { ctx, system: systemPrompt, cacheSystem: true, maxTokens: 2000 };
  let out1, out2;
  const naoPrecisaP1 = !!cachedNarrativa?.ato_1;
  const naoPrecisaP2 = !!cachedAplicacao?.ato_5;
  console.log(`[gerar-analise-final] cache — narrativa:${naoPrecisaP1 ? 'HIT' : 'miss'} aplicacao:${naoPrecisaP2 ? 'HIT' : 'miss'}`);

  try {
    const promessaP1 = naoPrecisaP1
      ? Promise.resolve({ text: JSON.stringify(cachedNarrativa), tokens_input: 0, tokens_output: 0, modelo_usado: 'cache', fallback_usado: false, model: 'cache' })
      : callClaudeStudioComFallback(promptParte1, baseOpts);
    const promessaP2 = naoPrecisaP2
      ? Promise.resolve({ text: JSON.stringify(cachedAplicacao), tokens_input: 0, tokens_output: 0, modelo_usado: 'cache', fallback_usado: false, model: 'cache' })
      : callClaudeStudioComFallback(promptParte2, baseOpts);
    [out1, out2] = await Promise.all([promessaP1, promessaP2]);
  } catch (e) {
    console.error('[gerar-analise-final] Sonnet+Haiku falharam:', e.message);
    sentryCapture(e, {
      tags: { action: 'gerar-analise-final', failure_mode: 'ambos_modelos_falharam' },
      extra: { video_id: video.youtube_id, nome: auth.nome },
      user: { id: auth.user.id, email: auth.user.email },
    });
    const analiseFallback = gerarAnaliseFallback(video, respostas, auth.nome);
    return {
      ok: true, fallback: true, nome: auth.nome,
      abertura_blublu: analiseFallback.abertura_blublu,
      atos: analiseFallback.atos, quiz: analiseFallback.quiz,
      video: { id: video.id, youtube_id: video.youtube_id, titulo: video.titulo, thumbnail: video.thumbnail_url, canal: video.canal_nome, nicho: video.nicho, views: video.views, likes: video.likes },
      tempo_ms: Date.now() - inicio, modelo: 'template_fallback',
      analises_restantes: rl.analises_restantes ?? 999,
      aviso: 'Blublu tá num momento complicado. Te dei uma análise baseada em padrões — volta em uns minutos pra uma análise completa.',
    };
  }

  let parte1 = parseJsonSafe(out1.text);
  let parte2 = parseJsonSafe(out2.text);
  if (!parte1?.ato_1 || !parte2?.ato_5) {
    console.error(
      '[gerar-analise-final] JSON invalido — p1.ato_1:', !!parte1?.ato_1,
      'p2.ato_5:', !!parte2?.ato_5,
      '| p1 modelo:', out1.modelo_usado,
      '| p2 modelo:', out2.modelo_usado
    );
    if (!parte1?.ato_1) console.error('[gerar-analise-final] P1 raw (300 chars):', String(out1.text || '').slice(0, 300));
    if (!parte2?.ato_5) console.error('[gerar-analise-final] P2 raw (300 chars):', String(out2.text || '').slice(0, 300));
    sentryCapture(new Error('JSON invalido apos split'), {
      level: 'warning',
      tags: { action: 'gerar-analise-final', failure_mode: 'json_invalido' },
      extra: {
        video_id: video.youtube_id,
        p1_modelo: out1.modelo_usado,
        p2_modelo: out2.modelo_usado,
        p1_ok: !!parte1?.ato_1,
        p2_ok: !!parte2?.ato_5,
        p1_raw: String(out1.text || '').slice(0, 500),
        p2_raw: String(out2.text || '').slice(0, 500),
      },
    });
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

  // ───── QUALITY GATE V3 (re-roll granular 1x se output generico) ─────
  // So roda em v3+. Cache hits NAO sao re-rolados — ja vieram de v3 valido.
  // Se 1a tentativa falha quality: re-rolla SOMENTE a parte que falhou.
  // 2a tentativa: usa o output mesmo que ainda imperfeito (sem 3a tentativa).
  // Se re-roll lancar excecao ou retornar JSON invalido, mantem output original.
  if (USAR_V3 && (!naoPrecisaP1 || !naoPrecisaP2)) {
    const valP1 = !naoPrecisaP1 ? blubluPersonality.validateOutputQuality(parte1, 'narrativa') : { passed: true, issues: [] };
    const valP2 = !naoPrecisaP2 ? blubluPersonality.validateOutputQuality(parte2, 'aplicacao') : { passed: true, issues: [] };
    const reRollP1 = !valP1.passed && !naoPrecisaP1;
    const reRollP2 = !valP2.passed && !naoPrecisaP2;

    if (reRollP1 || reRollP2) {
      console.warn(
        `[quality-gate v3] re-roll — p1:${reRollP1 ? 'YES (' + valP1.issues.slice(0,3).join('; ') + ')' : 'no'} ` +
        `p2:${reRollP2 ? 'YES (' + valP2.issues.slice(0,3).join('; ') + ')' : 'no'}`
      );
      sentryCapture(new Error('quality_gate falhou 1a tentativa'), {
        level: 'warning',
        tags: { action: 'gerar-analise-final', failure_mode: 'quality_gate_failed', prompt_version: PROMPT_VERSION },
        extra: {
          video_id: video.youtube_id,
          p1_issues: valP1.issues, p2_issues: valP2.issues,
          p1_passed: valP1.passed, p2_passed: valP2.passed,
          rerolled_p1: reRollP1, rerolled_p2: reRollP2,
        },
      });

      try {
        const sufP1 = reRollP1
          ? '\n\nIMPORTANTE: tentativa anterior teve problemas: ' + valP1.issues.slice(0, 5).join('; ') + '. Corrija e siga as regras de qualidade rigorosamente.'
          : '';
        const sufP2 = reRollP2
          ? '\n\nIMPORTANTE: tentativa anterior teve problemas: ' + valP2.issues.slice(0, 5).join('; ') + '. Corrija e siga as regras de qualidade rigorosamente.'
          : '';
        const [reroll1, reroll2] = await Promise.all([
          reRollP1 ? callClaudeStudioComFallback(promptParte1 + sufP1, baseOpts) : Promise.resolve(out1),
          reRollP2 ? callClaudeStudioComFallback(promptParte2 + sufP2, baseOpts) : Promise.resolve(out2),
        ]);

        if (reRollP1) {
          const novoP1 = parseJsonSafe(reroll1.text);
          if (novoP1?.ato_1) {
            parte1 = novoP1;
            out1 = reroll1;
          } else {
            console.warn('[quality-gate v3] re-roll p1 retornou JSON invalido, mantendo original');
          }
        }
        if (reRollP2) {
          const novoP2 = parseJsonSafe(reroll2.text);
          if (novoP2?.ato_5) {
            parte2 = novoP2;
            out2 = reroll2;
          } else {
            console.warn('[quality-gate v3] re-roll p2 retornou JSON invalido, mantendo original');
          }
        }
      } catch (e) {
        console.warn('[quality-gate v3] re-roll lancou excecao, mantendo output original:', e.message);
      }
    }
  }

  // Merge das duas partes num objeto unico compativel com resto do fluxo
  const analise = {
    abertura_blublu: parte1.abertura_blublu,
    ato_1: parte1.ato_1,
    ato_2: parte1.ato_2,
    ato_3: parte1.ato_3,
    ato_4: parte1.ato_4,
    ato_5: parte2.ato_5,
    quiz: parte2.quiz,
  };

  // Pseudo-out pra compat com resto do codigo (tokens somados)
  const out = {
    text: JSON.stringify(analise),
    tokens_input: (out1.tokens_input || 0) + (out2.tokens_input || 0),
    tokens_output: (out1.tokens_output || 0) + (out2.tokens_output || 0),
    tokens_cache_read: (out1.tokens_cache_read || 0) + (out2.tokens_cache_read || 0),
    tokens_cache_created: (out1.tokens_cache_created || 0) + (out2.tokens_cache_created || 0),
    model: out1.model || out2.model,
  };
  const usouFallback = out1.fallback_usado || out2.fallback_usado;
  console.log(`[gerar-analise-final] split ok — p1:${out1.modelo_usado} p2:${out2.modelo_usado} | in:${out.tokens_input} out:${out.tokens_output} cache_read:${out.tokens_cache_read}`);

  // Cache read e 10% do custo normal de input
  const custoInputBRL = (
    ((out.tokens_input || 0) / 1_000_000) * COST_INPUT_PER_MTOK_BRL +
    ((out.tokens_cache_read || 0) / 1_000_000) * COST_INPUT_PER_MTOK_BRL * 0.1
  );
  const custoOutputBRL = (out.tokens_output / 1_000_000) * COST_OUTPUT_PER_MTOK_BRL;
  const custoBRL = parseFloat((custoInputBRL + custoOutputBRL).toFixed(4));

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
        prompt_version: PROMPT_VERSION,
      }),
    });
    if (insR.ok) { const [row] = await insR.json(); analiseId = row?.id || null; }
  } catch (e) { console.error('[insert studio_analises]', e.message); }

  // Salva nos 2 caches separados (fire-and-forget).
  // Narrativa (video_id) — reusavel por qualquer Master que analisar o mesmo video.
  // Aplicacao (video_id + respostas) — reusavel pelo mesmo contexto/respostas.
  // So salva as partes NOVAS (evita overwrite de cache existente).
  if (!naoPrecisaP1) {
    saveToCache(ctx, ckNarrativa, 'narrativa', video.youtube_id, {
      ato_1: analise.ato_1, ato_2: analise.ato_2,
      ato_3: analise.ato_3, ato_4: analise.ato_4,
    }, { views: video.views, likes: video.likes, titulo: video.titulo }, custoBRL / 2);
  }
  if (!naoPrecisaP2) {
    saveToCache(ctx, ckAplicacao, 'aplicacao', video.youtube_id, {
      abertura_blublu: analise.abertura_blublu,
      ato_5: analise.ato_5,
      quiz: analise.quiz,
    }, { respostas }, custoBRL / 2);
  }

  // Self-critique Haiku — rodar em paralelo (fire-and-forget) pra logar
  // qualidade de analises. Nao bloqueia resposta ao user. Grava score
  // no studio_analises pra admin poder revisar depois.
  if (analiseId) {
    autoAvaliarQualidade(ctx, analiseId, analise, video, auth.nome).catch(() => {});
  }

  await Promise.all([
    registrarUso(ctx, auth.user.id, auth.user.email, 'dissecar'),
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
    modelo: `p1:${out1.modelo_usado}/p2:${out2.modelo_usado}`,
    analises_restantes: Math.max(0, rl.analises_restantes - 1),
    analises_total: rl.analises_total ?? 4,
    ...(usouFallback ? { aviso_fallback: true } : {}),
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
  const rl = await checarRateLimitEBudget(ctx, auth.user.id, auth.user.email, 'analisar-video');
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

  // CACHE HIT por youtube_id — mesmo video ja analisado = resposta instantanea
  const ck = cacheKey(video.youtube_id, 'meu_video', { tier });
  const cached = await getFromCache(ctx, ck);
  if (cached?.recomendacoes) {
    console.log('[analisar-meu-video] CACHE HIT', ck);
    return {
      ok: true, cached: true, analise_id: null, tier, nome: auth.nome,
      video: { id: video.id, youtube_id: video.youtube_id, titulo: video.titulo, thumbnail: video.thumbnail_url, canal: video.canal_nome, views, likes: video.likes, publicado_em: video.publicado_em },
      performance: { views_primeiro_dia: viewsPrimeiroDia, dias_desde_post: Math.round(diasDesdePost * 10) / 10 },
      analise: cached,
      analises_restantes: rl.analises_restantes ?? 999,
    };
  }

  let out;
  try {
    out = await callClaudeStudio(prompt, { ctx, model: 'claude-sonnet-4-6', maxTokens: 3000 });
  } catch (e) {
    console.error('[analisar-meu-video] Sonnet falhou:', e.message);
    // Template fallback pra nao deixar user na mao
    const fb = gerarAnaliseMeuVideoFallback(video, tier, auth.nome, viewsPrimeiroDia);
    return {
      ok: true, fallback: true, tier, nome: auth.nome,
      video: { id: video.id, youtube_id: video.youtube_id, titulo: video.titulo, thumbnail: video.thumbnail_url, canal: video.canal_nome, views, likes: video.likes, publicado_em: video.publicado_em },
      performance: { views_primeiro_dia: viewsPrimeiroDia, dias_desde_post: Math.round(diasDesdePost * 10) / 10 },
      analise: fb, aviso: 'Blublu tá em manutenção. Te dei uma análise baseada em padrões — volta em uns minutos pra uma análise completa com IA.',
      analises_restantes: rl.analises_restantes ?? 999,
    };
  }

  const analise = parseJsonSafe(out.text);
  if (!analise?.recomendacoes) {
    const fb = gerarAnaliseMeuVideoFallback(video, tier, auth.nome, viewsPrimeiroDia);
    return {
      ok: true, fallback: true, tier, nome: auth.nome,
      video: { id: video.id, youtube_id: video.youtube_id, titulo: video.titulo, thumbnail: video.thumbnail_url, canal: video.canal_nome, views, likes: video.likes, publicado_em: video.publicado_em },
      performance: { views_primeiro_dia: viewsPrimeiroDia, dias_desde_post: Math.round(diasDesdePost * 10) / 10 },
      analise: fb, aviso: 'Blublu tá num glitch. Análise baseada em padrões.',
      analises_restantes: rl.analises_restantes ?? 999,
    };
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
        prompt_version: PROMPT_VERSION,
      }),
    });
    if (insR.ok) { const [row] = await insR.json(); analiseId = row?.id || null; }
  } catch (e) { console.error('[insert meu_video]', e.message); }

  // Salva no cache (fire-and-forget) pro mesmo video reusar depois
  saveToCache(ctx, ck, 'meu_video', video.youtube_id, analise,
    { views, likes: video.likes, titulo: video.titulo, tier }, custoBRL);

  await Promise.all([
    registrarUso(ctx, auth.user.id, auth.user.email, 'analisar-video'),
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
    analises_total: rl.analises_total ?? 2,
    easter_egg: detectarIdolo(video),
  };
}
