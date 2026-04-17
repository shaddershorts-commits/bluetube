// api/pioneiros.js — Programa Pioneiros (CommonJS)
// Actions: status | desbloquear | painel | solicitar-pagamento |
//          processar-qualificacoes (cron)
const META_SEGUIDORES = 1000;
const META_ASSINANTES = 100;
const PREMIO_VALOR = 1000.00;
const MESES_MIN_QUALIFICACAO = 2;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const action = req.query.action || (req.body && req.body.action);

  // Cron: processar qualificações (sem auth)
  if (action === 'processar-qualificacoes') {
    return processarQualificacoes(req, res, { SU, SK, h });
  }

  // Admin: listar todos os pioneiros (auth via ADMIN_SECRET Bearer)
  if (action === 'admin-listar') {
    const authHeader = req.headers['authorization'] || '';
    const ADMIN_SECRET = process.env.ADMIN_SECRET;
    if (!ADMIN_SECRET || authHeader !== 'Bearer ' + ADMIN_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return adminListarAction(res, { SU, h });
  }

  // Demais actions precisam de token
  const token = req.query.token || (req.body && req.body.token);
  if (!token) return res.status(401).json({ error: 'token_obrigatorio' });

  // Resolve user via Supabase Auth
  let userId, userEmail;
  try {
    const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!uR.ok) return res.status(401).json({ error: 'token_invalido' });
    const uD = await uR.json();
    userId = uD.id;
    userEmail = uD.email;
  } catch (e) {
    return res.status(401).json({ error: 'token_invalido' });
  }

  try {
    if (action === 'status')               return statusAction(res, userId, { SU, h });
    if (action === 'desbloquear')          return desbloquearAction(res, userId, userEmail, { SU, h });
    if (action === 'painel')               return painelAction(res, userId, { SU, h });
    if (action === 'solicitar-pagamento')  return solicitarPagamentoAction(res, userId, { SU, h, STRIPE_KEY });
    return res.status(400).json({ error: 'action_invalida' });
  } catch (e) {
    console.error('[pioneiros] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────
async function contarSeguidores(userId, { SU, h }) {
  const r = await fetch(`${SU}/rest/v1/blue_follows?following_id=eq.${userId}&select=follower_id`, { headers: { ...h, Prefer: 'count=exact' } });
  if (!r.ok) return 0;
  const cr = r.headers.get('content-range') || '';
  const total = parseInt(cr.split('/')[1] || '0');
  if (!Number.isNaN(total) && total > 0) return total;
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) ? rows.length : 0;
}

async function buscarPioneiro(userId, { SU, h }) {
  const r = await fetch(`${SU}/rest/v1/pioneiros_programa?user_id=eq.${userId}&select=*&limit=1`, { headers: h });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

async function buscarPerfil(userId, { SU, h }) {
  const r = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${userId}&select=username,display_name&limit=1`, { headers: h });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

function gerarLinkRef(username) {
  const rand = Math.random().toString(36).slice(2, 8);
  const clean = (username || 'user').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  return `${clean || 'user'}-${rand}`;
}

async function criarPioneiro(userId, { SU, h }) {
  const perfil = await buscarPerfil(userId, { SU, h });
  const link_ref = gerarLinkRef(perfil?.username);
  const r = await fetch(`${SU}/rest/v1/pioneiros_programa`, {
    method: 'POST',
    headers: { ...h, Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: userId,
      status: 'ativo',
      link_ref,
      desbloqueado_em: new Date().toISOString(),
    }),
  });
  if (!r.ok) {
    // Race: outro request criou primeiro
    const existe = await buscarPioneiro(userId, { SU, h });
    if (existe) return existe;
    const errText = await r.text().catch(() => '');
    throw new Error(`criar pioneiro falhou: ${r.status} ${errText}`);
  }
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

function mascararEmail(email) {
  if (!email) return '***';
  const [u, dom] = email.split('@');
  if (!dom) return email;
  const visible = u.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(0, u.length - 2))}@${dom}`;
}

// ── Actions ───────────────────────────────────────────────────────────────
async function statusAction(res, userId, ctx) {
  const seguidores = await contarSeguidores(userId, ctx);
  let pioneiro = await buscarPioneiro(userId, ctx);

  if (!pioneiro && seguidores >= META_SEGUIDORES) {
    // Desbloqueio automático
    pioneiro = await criarPioneiro(userId, ctx);
    // Email fire-and-forget
    enviarEmailDesbloqueio(userId, pioneiro, ctx).catch(() => {});
  }

  if (!pioneiro) {
    return res.status(200).json({
      status: 'bloqueado',
      seguidores,
      meta_seguidores: META_SEGUIDORES,
      progresso_seguidores: Math.min(100, Math.round((seguidores / META_SEGUIDORES) * 100)),
      faltam: Math.max(0, META_SEGUIDORES - seguidores),
      mensagem: `Chegue a ${META_SEGUIDORES} seguidores para desbloquear o programa`,
    });
  }

  return res.status(200).json({
    status: pioneiro.status,
    seguidores,
    link_ref: pioneiro.link_ref,
    url_indicacao: `https://bluetubeviral.com/?ref=${pioneiro.link_ref}`,
    assinantes_indicados: pioneiro.assinantes_indicados,
    assinantes_qualificados: pioneiro.assinantes_qualificados,
    meta: META_ASSINANTES,
    progresso: Math.min(100, Math.round((pioneiro.assinantes_qualificados / META_ASSINANTES) * 100)),
    premio_valor: PREMIO_VALOR,
    premio_liberado: pioneiro.premio_liberado,
    premio_pago_em: pioneiro.premio_pago_em,
    desbloqueado_em: pioneiro.desbloqueado_em,
  });
}

async function desbloquearAction(res, userId, userEmail, ctx) {
  const seguidores = await contarSeguidores(userId, ctx);
  if (seguidores < META_SEGUIDORES) {
    return res.status(403).json({ error: 'seguidores_insuficientes', seguidores, meta: META_SEGUIDORES });
  }
  let pioneiro = await buscarPioneiro(userId, ctx);
  if (pioneiro) {
    return res.status(200).json({ ok: true, ja_desbloqueado: true, link_ref: pioneiro.link_ref, url_completa: `https://bluetubeviral.com/?ref=${pioneiro.link_ref}` });
  }
  pioneiro = await criarPioneiro(userId, ctx);
  enviarEmailDesbloqueio(userId, pioneiro, ctx, userEmail).catch(() => {});
  return res.status(200).json({ ok: true, link_ref: pioneiro.link_ref, url_completa: `https://bluetubeviral.com/?ref=${pioneiro.link_ref}` });
}

async function painelAction(res, userId, ctx) {
  const [pioneiro, seguidores] = await Promise.all([buscarPioneiro(userId, ctx), contarSeguidores(userId, ctx)]);
  if (!pioneiro) {
    return res.status(403).json({ error: 'nao_desbloqueado', seguidores, meta: META_SEGUIDORES, faltam: Math.max(0, META_SEGUIDORES - seguidores) });
  }
  // Últimas 20 indicações
  const { SU, h } = ctx;
  const indR = await fetch(
    `${SU}/rest/v1/pioneiros_indicacoes?pioneiro_id=eq.${pioneiro.id}&select=assinante_email,plano,valor_mensal,meses_ativos,qualificado,cancelado,created_at&order=created_at.desc&limit=20`,
    { headers: h }
  );
  const indicacoes = indR.ok ? await indR.json() : [];
  const lista_indicacoes = indicacoes.map((i) => ({
    email_mascarado: mascararEmail(i.assinante_email),
    plano: i.plano,
    valor_mensal: i.valor_mensal,
    meses_ativos: i.meses_ativos,
    qualificado: i.qualificado,
    cancelado: i.cancelado,
    data: i.created_at,
  }));

  // Receita gerada = soma de (valor_mensal * meses_ativos) das indicações não canceladas
  const receita_gerada = indicacoes
    .filter((i) => !i.cancelado)
    .reduce((acc, i) => acc + (parseFloat(i.valor_mensal) || 0) * (i.meses_ativos || 0), 0);

  // Previsão: taxa atual de qualificação por mês
  const agora = Date.now();
  const desbloqueado = pioneiro.desbloqueado_em ? new Date(pioneiro.desbloqueado_em).getTime() : agora;
  const mesesDesdeDesbloqueio = Math.max(1, (agora - desbloqueado) / (30 * 86400000));
  const taxaMensal = pioneiro.assinantes_qualificados / mesesDesdeDesbloqueio;
  const faltam = Math.max(0, META_ASSINANTES - pioneiro.assinantes_qualificados);
  const previsao_premio = taxaMensal > 0 ? new Date(agora + (faltam / taxaMensal) * 30 * 86400000).toISOString() : null;

  return res.status(200).json({
    status: pioneiro.status,
    link_ref: pioneiro.link_ref,
    url_indicacao: `https://bluetubeviral.com/?ref=${pioneiro.link_ref}`,
    assinantes_indicados: pioneiro.assinantes_indicados,
    assinantes_qualificados: pioneiro.assinantes_qualificados,
    meta: META_ASSINANTES,
    progresso: Math.min(100, Math.round((pioneiro.assinantes_qualificados / META_ASSINANTES) * 100)),
    premio_valor: PREMIO_VALOR,
    premio_liberado: pioneiro.premio_liberado,
    premio_pago_em: pioneiro.premio_pago_em,
    lista_indicacoes,
    estimativa_receita_gerada: Math.round(receita_gerada * 100) / 100,
    previsao_premio,
    seguidores,
    desbloqueado_em: pioneiro.desbloqueado_em,
  });
}

async function solicitarPagamentoAction(res, userId, ctx) {
  const { SU, h, STRIPE_KEY } = ctx;
  if (!STRIPE_KEY) return res.status(500).json({ error: 'stripe_nao_configurado' });

  const pioneiro = await buscarPioneiro(userId, ctx);
  if (!pioneiro) return res.status(403).json({ error: 'nao_desbloqueado' });
  if (pioneiro.premio_pago_em) return res.status(409).json({ error: 'premio_ja_pago', pago_em: pioneiro.premio_pago_em });
  if (pioneiro.assinantes_qualificados < META_ASSINANTES) {
    return res.status(403).json({ error: 'meta_nao_atingida', atual: pioneiro.assinantes_qualificados, meta: META_ASSINANTES });
  }

  // Conta Stripe Connect
  const accR = await fetch(`${SU}/rest/v1/blue_creator_accounts?user_id=eq.${userId}&select=stripe_account_id,stripe_onboarding_completo&limit=1`, { headers: h });
  const [account] = accR.ok ? await accR.json() : [];
  if (!account?.stripe_account_id) {
    return res.status(400).json({ error: 'conta_stripe_nao_configurada', setup_url: '/blue-monetizacao' });
  }
  if (!account.stripe_onboarding_completo) {
    return res.status(400).json({ error: 'onboarding_incompleto', setup_url: '/blue-monetizacao' });
  }

  // Registro do pagamento
  const pR = await fetch(`${SU}/rest/v1/pioneiros_pagamentos`, {
    method: 'POST',
    headers: { ...h, Prefer: 'return=representation' },
    body: JSON.stringify({
      pioneiro_id: pioneiro.id,
      user_id: userId,
      valor: PREMIO_VALOR,
      status: 'processando',
      stripe_account_id: account.stripe_account_id,
    }),
  });
  const [pag] = pR.ok ? await pR.json() : [null];
  if (!pag) return res.status(500).json({ error: 'falha_registrar_pagamento' });

  // Stripe transfer via helper (retry + idempotency + timeout)
  try {
    const { criarTransfer } = require('./_helpers/stripe.js');
    let tD;
    try {
      tD = await criarTransfer({
        amount: Math.round(PREMIO_VALOR * 100),
        currency: 'brl',
        destination: account.stripe_account_id,
        metadata: {
          programa: 'pioneiros',
          user_id: userId,
          pagamento_id: pag.id,
        },
      }, `pioneiros-${pag.id}`); // idempotency key custom — nao criar 2x o mesmo premio
    } catch (stripeErr) {
      await fetch(`${SU}/rest/v1/pioneiros_pagamentos?id=eq.${pag.id}`, {
        method: 'PATCH',
        headers: h,
        body: JSON.stringify({ status: 'falhou', erro: stripeErr.message || 'unknown', processado_em: new Date().toISOString() }),
      });
      return res.status(502).json({ error: 'stripe_transfer_falhou', detalhes: stripeErr.message });
    }

    // Atualizar pioneiro + pagamento
    await Promise.all([
      fetch(`${SU}/rest/v1/pioneiros_pagamentos?id=eq.${pag.id}`, {
        method: 'PATCH',
        headers: h,
        body: JSON.stringify({ status: 'pago', stripe_transfer_id: tD.id, processado_em: new Date().toISOString() }),
      }),
      fetch(`${SU}/rest/v1/pioneiros_programa?id=eq.${pioneiro.id}`, {
        method: 'PATCH',
        headers: h,
        body: JSON.stringify({ status: 'concluido', premio_pago_em: new Date().toISOString(), stripe_payout_id: tD.id, updated_at: new Date().toISOString() }),
      }),
    ]);

    enviarEmailPremio(userId, pioneiro, tD.id, ctx).catch(() => {});

    return res.status(200).json({ ok: true, valor: PREMIO_VALOR, transfer_id: tD.id, previsao_chegada: '1-2 dias úteis' });
  } catch (e) {
    await fetch(`${SU}/rest/v1/pioneiros_pagamentos?id=eq.${pag.id}`, {
      method: 'PATCH',
      headers: h,
      body: JSON.stringify({ status: 'falhou', erro: e.message, processado_em: new Date().toISOString() }),
    });
    return res.status(500).json({ error: e.message });
  }
}

async function adminListarAction(res, { SU, h }) {
  try {
    // 1. Todos os pioneiros, mais recentes primeiro
    const pR = await fetch(
      `${SU}/rest/v1/pioneiros_programa?select=*&order=desbloqueado_em.desc.nullslast&limit=500`,
      { headers: h }
    );
    if (!pR.ok) return res.status(502).json({ error: 'supabase_falhou' });
    const pioneiros = await pR.json();
    if (!pioneiros.length) {
      return res.status(200).json({ total: 0, pioneiros: [], stats: zeroStats() });
    }

    const userIds = pioneiros.map((p) => p.user_id).filter(Boolean);
    const inList = userIds.map((id) => `"${id}"`).join(',');

    // 2. Perfis Blue (username + display_name) em batch
    const profR = await fetch(
      `${SU}/rest/v1/blue_profiles?user_id=in.(${inList})&select=user_id,username,display_name`,
      { headers: h }
    );
    const profiles = profR.ok ? await profR.json() : [];
    const profMap = Object.fromEntries(profiles.map((pr) => [pr.user_id, pr]));

    // 3. Emails (subscribers) em batch
    const subR = await fetch(
      `${SU}/rest/v1/subscribers?user_id=in.(${inList})&select=user_id,email`,
      { headers: h }
    );
    const subs = subR.ok ? await subR.json() : [];
    const emailMap = Object.fromEntries(subs.map((s) => [s.user_id, s.email]));

    // 4. Pagamentos em batch (último por pioneiro)
    const pioneiroIds = pioneiros.map((p) => `"${p.id}"`).join(',');
    const pagR = await fetch(
      `${SU}/rest/v1/pioneiros_pagamentos?pioneiro_id=in.(${pioneiroIds})&select=pioneiro_id,status,valor,stripe_transfer_id,processado_em,erro&order=processado_em.desc.nullslast`,
      { headers: h }
    );
    const pagamentos = pagR.ok ? await pagR.json() : [];
    const pagMap = {};
    for (const pag of pagamentos) {
      if (!pagMap[pag.pioneiro_id]) pagMap[pag.pioneiro_id] = pag;
    }

    // 5. Monta linhas enriquecidas
    const linhas = pioneiros.map((p) => {
      const prof = profMap[p.user_id] || {};
      return {
        id: p.id,
        user_id: p.user_id,
        username: prof.username || null,
        display_name: prof.display_name || null,
        email: emailMap[p.user_id] || null,
        status: p.status,
        link_ref: p.link_ref,
        assinantes_indicados: p.assinantes_indicados || 0,
        assinantes_qualificados: p.assinantes_qualificados || 0,
        premio_liberado: !!p.premio_liberado,
        premio_pago_em: p.premio_pago_em,
        desbloqueado_em: p.desbloqueado_em,
        stripe_payout_id: p.stripe_payout_id,
        ultimo_pagamento: pagMap[p.id] || null,
      };
    });

    // 6. Estatísticas agregadas
    const stats = {
      total: linhas.length,
      ativos: linhas.filter((l) => l.status === 'ativo').length,
      pendente_pagamento: linhas.filter((l) => l.status === 'pendente_pagamento').length,
      concluidos: linhas.filter((l) => l.status === 'concluido').length,
      premios_pagos: linhas.filter((l) => l.premio_pago_em).length,
      total_indicados: linhas.reduce((a, l) => a + l.assinantes_indicados, 0),
      total_qualificados: linhas.reduce((a, l) => a + l.assinantes_qualificados, 0),
      total_premios_brl: linhas.filter((l) => l.premio_pago_em).length * 1000,
    };

    return res.status(200).json({ total: linhas.length, pioneiros: linhas, stats });
  } catch (e) {
    console.error('[pioneiros admin-listar]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

function zeroStats() {
  return { total: 0, ativos: 0, pendente_pagamento: 0, concluidos: 0, premios_pagos: 0, total_indicados: 0, total_qualificados: 0, total_premios_brl: 0 };
}

async function processarQualificacoes(req, res, { SU, SK, h }) {
  // Busca indicações não qualificadas e não canceladas com 2+ meses ativos
  try {
    const indR = await fetch(
      `${SU}/rest/v1/pioneiros_indicacoes?qualificado=eq.false&cancelado=eq.false&meses_ativos=gte.${MESES_MIN_QUALIFICACAO}&select=id,pioneiro_id&limit=500`,
      { headers: h }
    );
    const pendentes = indR.ok ? await indR.json() : [];
    const pioneirosAtualizados = new Set();

    for (const ind of pendentes) {
      await fetch(`${SU}/rest/v1/pioneiros_indicacoes?id=eq.${ind.id}`, {
        method: 'PATCH',
        headers: h,
        body: JSON.stringify({ qualificado: true }),
      }).catch(() => {});
      pioneirosAtualizados.add(ind.pioneiro_id);
    }

    // Re-conta qualificados de cada pioneiro afetado
    const notificaveis = [];
    for (const pid of pioneirosAtualizados) {
      const cR = await fetch(`${SU}/rest/v1/pioneiros_indicacoes?pioneiro_id=eq.${pid}&qualificado=eq.true&select=id`, { headers: { ...h, Prefer: 'count=exact' } });
      const cr = cR.headers.get('content-range') || '';
      const total = parseInt(cr.split('/')[1] || '0') || 0;

      const pR = await fetch(`${SU}/rest/v1/pioneiros_programa?id=eq.${pid}&select=user_id,premio_liberado,assinantes_qualificados,status`, { headers: h });
      const [piom] = pR.ok ? await pR.json() : [];
      if (!piom) continue;

      const agoraLibera = total >= META_ASSINANTES && !piom.premio_liberado;
      const patch = { assinantes_qualificados: total, updated_at: new Date().toISOString() };
      if (agoraLibera) {
        patch.premio_liberado = true;
        patch.status = 'pendente_pagamento';
        notificaveis.push({ pioneiro_id: pid, user_id: piom.user_id });
      }
      await fetch(`${SU}/rest/v1/pioneiros_programa?id=eq.${pid}`, {
        method: 'PATCH',
        headers: h,
        body: JSON.stringify(patch),
      }).catch(() => {});
    }

    // Fire-and-forget email + push pra quem acabou de bater a meta
    for (const n of notificaveis) {
      enviarEmailMetaAtingida(n.user_id, n.pioneiro_id, { SU, h }).catch(() => {});
      enviarPushMetaAtingida(n.user_id).catch(() => {});
    }

    return res.status(200).json({ ok: true, qualificadas: pendentes.length, pioneiros_afetados: pioneirosAtualizados.size, novos_premios_liberados: notificaveis.length });
  } catch (e) {
    console.error('[pioneiros cron]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ── Emails via Resend ─────────────────────────────────────────────────────
async function enviarEmailDesbloqueio(userId, pioneiro, ctx, emailOverride) {
  const { SU, h } = ctx;
  if (!process.env.RESEND_API_KEY) return;
  let email = emailOverride;
  if (!email) {
    const r = await fetch(`${SU}/rest/v1/subscribers?user_id=eq.${userId}&select=email&limit=1`, { headers: h });
    const [sub] = r.ok ? await r.json() : [];
    email = sub?.email;
  }
  if (!email) return;
  const url = `https://bluetubeviral.com/?ref=${pioneiro.link_ref}`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'BlueTube <noreply@bluetubeviral.com>',
      to: email,
      subject: '🔓 Você desbloqueou o Programa Pioneiros!',
      html: `
        <div style="background:#020817;color:#e8f4ff;padding:40px;font-family:system-ui;border-radius:16px;max-width:560px;margin:0 auto">
          <h1 style="color:#FFD700;margin:0 0 12px">🔓 Desbloqueado!</h1>
          <p>Você chegou a 1.000 seguidores no Blue e entrou para o <b>Programa Pioneiros</b>.</p>
          <p>Indique 100 assinantes (Full ou Master) com mais de 2 meses ativos pelo seu link exclusivo e receba <b>R$1.000 no Pix</b>.</p>
          <div style="background:rgba(0,170,255,.1);border:1px solid rgba(0,170,255,.3);border-radius:12px;padding:16px;margin:20px 0">
            <div style="font-size:12px;color:#00aaff;margin-bottom:6px">SEU LINK EXCLUSIVO</div>
            <code style="font-size:14px;word-break:break-all">${url}</code>
          </div>
          <a href="https://bluetubeviral.com/pioneiros" style="display:inline-block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700">Ver meu painel →</a>
        </div>`,
    }),
  }).catch(() => {});
}

async function enviarPushMetaAtingida(userId) {
  try {
    const { sendPushToUser } = require('./_helpers/push.js');
    await sendPushToUser(userId, {
      title: '🏆 R$1.000 são seus!',
      body: 'Você bateu a meta de 100 assinantes qualificados. Abra o painel e solicite o pagamento.',
      data: { url: 'https://bluetubeviral.com/pioneiros', type: 'pioneiros_meta' },
    });
  } catch (e) {
    console.error('[pioneiros push]', e.message);
  }
}

async function enviarEmailMetaAtingida(userId, pioneiroId, ctx) {
  const { SU, h } = ctx;
  if (!process.env.RESEND_API_KEY) return;
  const r = await fetch(`${SU}/rest/v1/subscribers?user_id=eq.${userId}&select=email&limit=1`, { headers: h });
  const [sub] = r.ok ? await r.json() : [];
  if (!sub?.email) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'BlueTube <noreply@bluetubeviral.com>',
      to: sub.email,
      subject: '🏆 R$1.000 são seus! Solicite agora',
      html: `
        <div style="background:#020817;color:#e8f4ff;padding:40px;font-family:system-ui;border-radius:16px;max-width:560px;margin:0 auto">
          <h1 style="color:#FFD700;margin:0 0 12px">🏆 Meta atingida!</h1>
          <p>Você indicou <b>100 assinantes qualificados</b> e ganhou <b>R$1.000,00</b>.</p>
          <a href="https://bluetubeviral.com/pioneiros" style="display:inline-block;background:linear-gradient(135deg,#f59e0b,#FFD700);color:#020817;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:800">Solicitar pagamento →</a>
          <p style="font-size:12px;color:rgba(232,244,255,.5);margin-top:16px">O valor chegará em 1-2 dias úteis na conta Stripe Connect configurada em /blue-monetizacao.</p>
        </div>`,
    }),
  }).catch(() => {});
}

async function enviarEmailPremio(userId, pioneiro, transferId, ctx) {
  const { SU, h } = ctx;
  if (!process.env.RESEND_API_KEY) return;
  const r = await fetch(`${SU}/rest/v1/subscribers?user_id=eq.${userId}&select=email&limit=1`, { headers: h });
  const [sub] = r.ok ? await r.json() : [];
  if (!sub?.email) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'BlueTube <noreply@bluetubeviral.com>',
      to: sub.email,
      subject: '💰 R$1.000 enviados para sua conta!',
      html: `
        <div style="background:#020817;color:#e8f4ff;padding:40px;font-family:system-ui;border-radius:16px;max-width:560px;margin:0 auto">
          <h1 style="color:#22c55e;margin:0 0 12px">💰 Pagamento iniciado!</h1>
          <p>A transferência de <b>R$1.000,00</b> foi disparada via Stripe Connect.</p>
          <p>Previsão de chegada: <b>1-2 dias úteis</b>.</p>
          <p style="font-size:11px;color:rgba(232,244,255,.4);margin-top:20px">Transfer ID: ${transferId}</p>
        </div>`,
    }),
  }).catch(() => {});
}
