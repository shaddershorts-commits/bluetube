// api/affiliate-saques.js — Saques de afiliados via ASAAS (Pix).
// Regras: libera so dia 22 de cada mes, minimo R$50, 1 saque/mes por afiliado.
// Fail-graceful: sem ASAAS_API_KEY, saques entram em fila 'pendente_manual'
// e admin processa manualmente. Sistema nao quebra.
//
// NUNCA modificar api/auth.js — este arquivo resolve user via endpoint auth
// do Supabase diretamente (/auth/v1/user).

const DIA_SAQUE = 22;
const VALOR_MINIMO = 50;
const ASAAS_KEY = process.env.ASAAS_API_KEY || '';
const ASAAS_URL = (process.env.ASAAS_ENVIRONMENT === 'production')
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';

function mascararChave(chave, tipo) {
  if (!chave) return '';
  if (tipo === 'email') {
    const [u, d] = chave.split('@');
    return (u?.[0] || '') + '***@' + (d || '');
  }
  if (tipo === 'cpf') return chave.replace(/\D/g, '').replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.***.$3-**');
  if (tipo === 'telefone') return chave.replace(/(\+55)(\d{2})\d{5}(\d{4})/, '$1 $2 *****-$3');
  if (tipo === 'aleatoria') return chave.slice(0, 4) + '…' + chave.slice(-4);
  return chave.slice(0, 3) + '…' + chave.slice(-3);
}

function validarChavePix(chave, tipo) {
  if (!chave || !tipo) return false;
  const clean = chave.trim();
  if (tipo === 'cpf') return /^\d{11}$/.test(clean.replace(/\D/g, ''));
  if (tipo === 'telefone') return /^\+?55\d{10,11}$/.test(clean.replace(/\D/g, '').replace(/^/, '+'));
  if (tipo === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean);
  if (tipo === 'aleatoria') return /^[0-9a-f-]{32,36}$/i.test(clean);
  return false;
}

function diasAteDia22() {
  const hoje = new Date();
  const dia = hoje.getDate();
  if (dia === DIA_SAQUE) return 0;
  if (dia < DIA_SAQUE) return DIA_SAQUE - dia;
  // ja passou — proximo mes
  const proximo = new Date(hoje.getFullYear(), hoje.getMonth() + 1, DIA_SAQUE);
  return Math.ceil((proximo - hoje) / (24 * 60 * 60 * 1000));
}

function mesmoMes(dtA, dtB) {
  if (!dtA || !dtB) return false;
  const a = new Date(dtA), b = new Date(dtB);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

async function asaasCall(path, opts = {}) {
  if (!ASAAS_KEY) throw new Error('ASAAS_API_KEY_MISSING');
  const r = await fetch(ASAAS_URL + path, {
    ...opts,
    headers: {
      'access_token': ASAAS_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'BlueTube/1.0',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!r.ok) {
    const err = new Error(data?.errors?.[0]?.description || data?.error || `asaas_${r.status}`);
    err.asaas = data;
    err.status = r.status;
    throw err;
  }
  return data;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  const action = req.query.action || req.body?.action;

  // ── CRON: lembrete dia 22 (sem auth) ─────────────────────────────────────
  if (action === 'lembrete-dia22') {
    return lembreteDia22(res, { SU, h });
  }

  // ── CRON: avisa afiliados que o saque esta disponivel (roda dia 22 manha)
  if (action === 'avisar-afiliados-dia22') {
    return avisarAfiliadosDia22(res, { SU, h });
  }

  // ── Demais actions precisam de token ─────────────────────────────────────
  const token = req.query.token || req.body?.token;
  if (!token) return res.status(401).json({ error: 'token_obrigatorio' });

  let userEmail = null;
  try {
    const uR = await fetch(`${SU}/auth/v1/user`, {
      headers: { apikey: AK, Authorization: 'Bearer ' + token },
    });
    if (!uR.ok) return res.status(401).json({ error: 'token_invalido' });
    const uD = await uR.json();
    userEmail = (uD.email || '').toLowerCase();
  } catch (e) { return res.status(401).json({ error: 'token_invalido' }); }
  if (!userEmail) return res.status(401).json({ error: 'email_nao_encontrado' });

  // Busca afiliado pelo email (sistema atual de afiliados usa email como chave)
  const aR = await fetch(`${SU}/rest/v1/affiliates?email=eq.${encodeURIComponent(userEmail)}&select=*&limit=1`, { headers: h });
  if (!aR.ok) return res.status(502).json({ error: 'erro_banco' });
  const affRows = await aR.json();
  const afiliado = Array.isArray(affRows) ? affRows[0] : null;
  if (!afiliado) return res.status(404).json({ error: 'afiliado_nao_cadastrado', mensagem: 'Entre no programa de afiliados primeiro.' });

  // ── STATUS ────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && (!action || action === 'status')) {
    return statusAction(res, { h, SU, afiliado });
  }

  // ── CADASTRAR PIX ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'cadastrar-pix') {
    const { chave_pix, tipo_chave_pix } = req.body || {};
    if (!['cpf', 'telefone', 'email', 'aleatoria'].includes(tipo_chave_pix)) {
      return res.status(400).json({ error: 'tipo_invalido' });
    }
    if (!validarChavePix(chave_pix, tipo_chave_pix)) {
      return res.status(400).json({ error: 'chave_invalida', mensagem: 'Formato da chave Pix invalido para o tipo selecionado.' });
    }
    const u = await fetch(`${SU}/rest/v1/affiliates?id=eq.${afiliado.id}`, {
      method: 'PATCH', headers: h,
      body: JSON.stringify({ chave_pix: chave_pix.trim(), tipo_chave_pix, updated_at: new Date().toISOString() }),
    });
    if (!u.ok) return res.status(502).json({ error: 'erro_salvar' });
    return res.status(200).json({ ok: true, mensagem: '✅ Chave Pix cadastrada!' });
  }

  // ── SOLICITAR SAQUE ───────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'solicitar-saque') {
    return solicitarSaque(res, { SU, h, afiliado });
  }

  // ── HISTORICO ─────────────────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'historico') {
    const r = await fetch(
      `${SU}/rest/v1/affiliate_saques?affiliate_id=eq.${afiliado.id}&select=id,valor,chave_pix,tipo_chave_pix,status,solicitado_em,pago_em,erro_mensagem&order=solicitado_em.desc&limit=12`,
      { headers: h }
    );
    const rows = r.ok ? await r.json() : [];
    const masked = rows.map(s => ({
      id: s.id, valor: s.valor, status: s.status,
      chave_mascarada: mascararChave(s.chave_pix, s.tipo_chave_pix),
      solicitado_em: s.solicitado_em, pago_em: s.pago_em,
      erro: s.erro_mensagem,
    }));
    return res.status(200).json({ saques: masked });
  }

  return res.status(400).json({ error: 'action_invalida' });
};

// ── HANDLERS ────────────────────────────────────────────────────────────────
async function statusAction(res, { h, SU, afiliado }) {
  const saldo = parseFloat(afiliado.saldo_disponivel || 0);
  // Se saldo_disponivel ainda nao foi populado, calcular on-the-fly a partir
  // das commissions pending (nao cancelled / nao paid / nao flagged):
  let saldoCalculado = saldo;
  try {
    const cR = await fetch(
      `${SU}/rest/v1/affiliate_commissions?affiliate_id=eq.${afiliado.id}&status=eq.pending&flagged=eq.false&select=commission_amount`,
      { headers: h }
    );
    if (cR.ok) {
      const rows = await cR.json();
      const soma = rows.reduce((s, c) => s + parseFloat(c.commission_amount || 0), 0);
      if (soma > saldoCalculado) saldoCalculado = soma;
    }
  } catch (e) {}

  const hoje = new Date();
  const isDia22 = hoje.getDate() === DIA_SAQUE;
  const jaSacouEsseMes = mesmoMes(afiliado.ultimo_saque_em, hoje);
  const temChave = !!(afiliado.chave_pix && afiliado.tipo_chave_pix);
  const saldoSuficiente = saldoCalculado >= VALOR_MINIMO;
  const podeSacarHoje = isDia22 && !jaSacouEsseMes && saldoSuficiente && temChave;

  const proximo = new Date(hoje.getFullYear(), hoje.getMonth() + (hoje.getDate() >= DIA_SAQUE ? 1 : 0), DIA_SAQUE);
  return res.status(200).json({
    saldo_disponivel: +saldoCalculado.toFixed(2),
    valor_minimo: VALOR_MINIMO,
    tem_chave: temChave,
    chave_mascarada: temChave ? mascararChave(afiliado.chave_pix, afiliado.tipo_chave_pix) : null,
    tipo_chave: afiliado.tipo_chave_pix || null,
    ja_sacou_esse_mes: jaSacouEsseMes,
    ultimo_saque_em: afiliado.ultimo_saque_em,
    total_sacado: parseFloat(afiliado.total_sacado || 0),
    is_dia22: isDia22,
    pode_sacar_hoje: podeSacarHoje,
    dias_para_proximo_saque: diasAteDia22(),
    proximo_saque_em: proximo.toISOString(),
    asaas_configurado: !!ASAAS_KEY,
  });
}

async function solicitarSaque(res, { SU, h, afiliado }) {
  const hoje = new Date();
  if (hoje.getDate() !== DIA_SAQUE) {
    return res.status(400).json({ error: 'fora_do_dia22', mensagem: `Saques liberados apenas no dia ${DIA_SAQUE} de cada mes.` });
  }
  if (mesmoMes(afiliado.ultimo_saque_em, hoje)) {
    return res.status(400).json({ error: 'ja_sacou', mensagem: 'Voce ja fez saque este mes.' });
  }
  if (!afiliado.chave_pix || !afiliado.tipo_chave_pix) {
    return res.status(400).json({ error: 'sem_chave', mensagem: 'Cadastre uma chave Pix antes de solicitar saque.' });
  }

  // Calcular saldo real (sum das commissions pending NAO flaggadas)
  const cR = await fetch(
    `${SU}/rest/v1/affiliate_commissions?affiliate_id=eq.${afiliado.id}&status=eq.pending&flagged=eq.false&select=id,commission_amount`,
    { headers: h }
  );
  const pendings = cR.ok ? await cR.json() : [];
  const valorSaque = +pendings.reduce((s, c) => s + parseFloat(c.commission_amount || 0), 0).toFixed(2);
  if (valorSaque < VALOR_MINIMO) {
    return res.status(400).json({ error: 'saldo_insuficiente', mensagem: `Saldo minimo de R$${VALOR_MINIMO} pra sacar. Atual: R$${valorSaque.toFixed(2)}.` });
  }

  // Cria o registro do saque em status 'processando' (ou 'pendente_manual' se sem ASAAS)
  const statusInicial = ASAAS_KEY ? 'processando' : 'pendente_manual';
  const insR = await fetch(`${SU}/rest/v1/affiliate_saques`, {
    method: 'POST',
    headers: { ...h, Prefer: 'return=representation' },
    body: JSON.stringify({
      affiliate_id: afiliado.id,
      valor: valorSaque,
      chave_pix: afiliado.chave_pix,
      tipo_chave_pix: afiliado.tipo_chave_pix,
      status: statusInicial,
    }),
  });
  if (!insR.ok) return res.status(502).json({ error: 'erro_criar_saque' });
  const [saque] = await insR.json();

  // Tenta enviar via ASAAS
  if (ASAAS_KEY) {
    try {
      const tipoMap = { cpf: 'CPF', telefone: 'PHONE', email: 'EMAIL', aleatoria: 'EVP' };

      // Verifica saldo ASAAS antes
      try {
        const bal = await asaasCall('/finance/balance');
        if (bal && typeof bal.balance === 'number' && bal.balance < valorSaque) {
          await fetch(`${SU}/rest/v1/affiliate_saques?id=eq.${saque.id}`, {
            method: 'PATCH', headers: h,
            body: JSON.stringify({ status: 'falhou', erro_mensagem: `Saldo ASAAS insuficiente: R$${bal.balance.toFixed(2)}` }),
          });
          await alertarAdmin('🚨 ASAAS sem saldo pra saque', [
            ['Afiliado', afiliado.email],
            ['Valor pedido', `R$ ${valorSaque.toFixed(2)}`],
            ['Saldo ASAAS', `R$ ${bal.balance.toFixed(2)}`],
          ]).catch(() => {});
          return res.status(503).json({ error: 'saldo_asaas_insuficiente', mensagem: 'Sistema temporariamente indisponivel. Admin foi notificado.' });
        }
      } catch (e) { /* se /finance/balance falhar, seguir com transfer — ASAAS pode rejeitar la */ }

      const transfer = await asaasCall('/transfers', {
        method: 'POST',
        body: JSON.stringify({
          value: valorSaque,
          pixAddressKey: afiliado.chave_pix,
          pixAddressKeyType: tipoMap[afiliado.tipo_chave_pix],
          description: `Comissao BlueTube - ${hoje.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}`,
        }),
      });

      // Atualiza saque como pago
      await fetch(`${SU}/rest/v1/affiliate_saques?id=eq.${saque.id}`, {
        method: 'PATCH', headers: h,
        body: JSON.stringify({
          status: 'pago',
          asaas_transfer_id: transfer.id,
          asaas_pix_id: transfer.pixTransaction || null,
          pago_em: new Date().toISOString(),
        }),
      });

      // Atualiza afiliado (ultimo_saque + total_sacado + zera saldo)
      await fetch(`${SU}/rest/v1/affiliates?id=eq.${afiliado.id}`, {
        method: 'PATCH', headers: h,
        body: JSON.stringify({
          ultimo_saque_em: new Date().toISOString(),
          total_sacado: parseFloat(afiliado.total_sacado || 0) + valorSaque,
          saldo_disponivel: 0,
          updated_at: new Date().toISOString(),
        }),
      });

      // Marca commissions como paid
      const ids = pendings.map(p => p.id);
      if (ids.length) {
        await fetch(`${SU}/rest/v1/affiliate_commissions?id=in.(${ids.join(',')})`, {
          method: 'PATCH', headers: h,
          body: JSON.stringify({ status: 'paid', stripe_transfer_id: transfer.id }),
        });
      }

      return res.status(200).json({ ok: true, mensagem: '✅ Pix enviado!', valor: valorSaque, saque_id: saque.id });
    } catch (e) {
      // Marca como falhou e notifica admin
      await fetch(`${SU}/rest/v1/affiliate_saques?id=eq.${saque.id}`, {
        method: 'PATCH', headers: h,
        body: JSON.stringify({ status: 'falhou', erro_mensagem: (e.message || 'erro_asaas').slice(0, 300) }),
      });
      await alertarAdmin('🚨 Saque ASAAS falhou', [
        ['Afiliado', afiliado.email],
        ['Valor', `R$ ${valorSaque.toFixed(2)}`],
        ['Erro', e.message || 'desconhecido'],
      ]).catch(() => {});
      return res.status(502).json({ error: 'asaas_erro', mensagem: 'Nao foi possivel processar o Pix agora. Admin notificado.' });
    }
  }

  // Modo manual (sem ASAAS_KEY): saque fica em fila pro admin processar
  await alertarAdmin('💸 Saque manual pendente', [
    ['Afiliado', afiliado.email],
    ['Valor', `R$ ${valorSaque.toFixed(2)}`],
    ['Chave Pix', `${afiliado.tipo_chave_pix}: ${afiliado.chave_pix}`],
    ['Ação', 'Processar manualmente e marcar como pago no painel admin'],
  ]).catch(() => {});

  return res.status(200).json({
    ok: true,
    mensagem: '⏳ Saque solicitado! Processamento manual ate o fim do dia.',
    valor: valorSaque,
    saque_id: saque.id,
    processamento: 'manual',
  });
}

async function lembreteDia22(res, { SU, h }) {
  // Quantos afiliados tem saldo >= minimo? Qual total previsto?
  try {
    const cR = await fetch(
      `${SU}/rest/v1/affiliate_commissions?status=eq.pending&flagged=eq.false&select=affiliate_id,commission_amount`,
      { headers: h }
    );
    const rows = cR.ok ? await cR.json() : [];
    const porAfiliado = new Map();
    for (const r of rows) {
      porAfiliado.set(r.affiliate_id, (porAfiliado.get(r.affiliate_id) || 0) + parseFloat(r.commission_amount || 0));
    }
    const elegiveis = Array.from(porAfiliado.entries()).filter(([, v]) => v >= VALOR_MINIMO);
    const totalPrevisto = elegiveis.reduce((s, [, v]) => s + v, 0);

    // Verifica saldo ASAAS (se API key disponivel)
    let saldoAsaas = null;
    if (ASAAS_KEY) {
      try {
        const bal = await asaasCall('/finance/balance');
        saldoAsaas = (bal && typeof bal.balance === 'number') ? bal.balance : null;
      } catch (e) { /* ignora */ }
    }

    if (saldoAsaas !== null && saldoAsaas < totalPrevisto) {
      await alertarAdmin('🚨 URGENTE: Saldo ASAAS insuficiente pro dia 22', [
        ['Previsto', `R$ ${totalPrevisto.toFixed(2)}`],
        ['Saldo ASAAS', `R$ ${saldoAsaas.toFixed(2)}`],
        ['Faltam', `R$ ${(totalPrevisto - saldoAsaas).toFixed(2)}`],
        ['Afiliados elegiveis', String(elegiveis.length)],
      ]).catch(() => {});
    }

    return res.status(200).json({
      ok: true,
      afiliados_elegiveis: elegiveis.length,
      total_previsto: +totalPrevisto.toFixed(2),
      saldo_asaas: saldoAsaas,
      asaas_configurado: !!ASAAS_KEY,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function alertarAdmin(titulo, rows) {
  // Reutiliza o endpoint /api/monitor ou email helper se existir.
  // Aqui faz fetch leve pro /api/auth notify (nao modifica auth.js — so consome).
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!ADMIN_EMAIL || !RESEND_KEY) return; // sem email, skip (log no console ja foi feito)
  const html = `<h2>${titulo}</h2><table>${rows.map(r => `<tr><td><b>${r[0]}</b></td><td>${r[1]}</td></tr>`).join('')}</table>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'BlueTube <alerts@bluetubeviral.com>',
      to: ADMIN_EMAIL,
      subject: titulo,
      html,
    }),
  }).catch(() => {});
}

// ── Email genérico pro afiliado (via Resend) ───────────────────────────────
async function enviarEmailAfiliado(to, subject, html) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY || !to) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'BlueTube <saques@bluetubeviral.com>',
      to,
      subject,
      html,
    }),
  }).catch(() => {});
}

// Template HTML base (dark mode alinhado com a identidade BlueTube).
// bannerEmoji: ex '💰' | '✅'. cor destaca o valor em verde neon.
function emailTemplate({ titulo, subtitulo, valor, chaveMascarada, ctaLabel, ctaUrl, corpo, bannerEmoji = '💰' }) {
  const valorBloco = valor != null ? `
    <div style="text-align:center;margin:28px 0 8px">
      <div style="font-family:'Inter',Arial,sans-serif;font-size:12px;color:#7590ab;letter-spacing:.5px;text-transform:uppercase;font-weight:600">Valor</div>
      <div style="font-family:'Inter',Arial,sans-serif;font-size:44px;font-weight:800;color:#22c55e;line-height:1.1;margin-top:4px">R$ ${Number(valor).toFixed(2).replace('.', ',')}</div>
    </div>` : '';
  const chaveBloco = chaveMascarada ? `
    <div style="text-align:center;margin-bottom:16px">
      <span style="font-family:'Inter',Arial,sans-serif;font-size:12px;color:#7590ab">Chave Pix: </span>
      <span style="font-family:'DM Mono',Menlo,monospace;font-size:13px;color:#e8f4ff;font-weight:600">${chaveMascarada}</span>
    </div>` : '';
  const ctaBloco = ctaUrl ? `
    <div style="text-align:center;margin:28px 0 16px">
      <a href="${ctaUrl}" style="display:inline-block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;font-family:'Inter',Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:14px 32px;border-radius:10px;box-shadow:0 0 22px rgba(0,170,255,0.3)">${ctaLabel || 'Acessar painel'} →</a>
    </div>` : '';
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${titulo}</title></head>
<body style="margin:0;padding:0;background:#020817;font-family:'Inter',Arial,sans-serif;color:#e8f4ff">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#020817;padding:36px 16px">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#0a1628;border:1px solid rgba(0,170,255,0.15);border-radius:16px;overflow:hidden">
        <tr><td style="padding:28px 32px 12px;text-align:center">
          <div style="display:inline-block;font-family:'Inter Tight','Inter',Arial,sans-serif;font-size:24px;font-weight:800;letter-spacing:-0.5px;color:#fff">
            Blue<span style="color:#00aaff">Tube</span>
          </div>
        </td></tr>
        <tr><td style="padding:12px 32px 0;text-align:center">
          <div style="font-size:48px;line-height:1">${bannerEmoji}</div>
        </td></tr>
        <tr><td style="padding:14px 32px 6px;text-align:center">
          <div style="font-family:'Inter Tight','Inter',Arial,sans-serif;font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.3px;line-height:1.25">${titulo}</div>
        </td></tr>
        ${subtitulo ? `<tr><td style="padding:8px 32px 0;text-align:center">
          <div style="font-size:14px;color:rgba(232,244,255,0.7);line-height:1.55">${subtitulo}</div>
        </td></tr>` : ''}
        <tr><td style="padding:8px 32px 0">${valorBloco}${chaveBloco}</td></tr>
        ${corpo ? `<tr><td style="padding:0 32px;font-size:14px;color:rgba(232,244,255,0.75);line-height:1.65">${corpo}</td></tr>` : ''}
        <tr><td style="padding:0 32px">${ctaBloco}</td></tr>
        <tr><td style="padding:24px 32px 28px;border-top:1px solid rgba(0,170,255,0.08);text-align:center">
          <div style="font-size:11px;color:rgba(150,190,230,0.4);line-height:1.5">
            Esse email foi enviado pra você porque tem conta de afiliado no BlueTube.<br>
            <a href="https://bluetubeviral.com/afiliado" style="color:#00aaff;text-decoration:none">Painel de afiliado</a>
            &nbsp;·&nbsp;
            <a href="https://bluetubeviral.com/privacidade" style="color:#00aaff;text-decoration:none">Privacidade</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// Roda dia 22 via cron. Varre afiliados elegiveis e manda email lembrete.
async function avisarAfiliadosDia22(res, { SU, h }) {
  try {
    // Mesma logica do lembreteDia22 pra descobrir quem tem saldo >= minimo
    const cR = await fetch(
      `${SU}/rest/v1/affiliate_commissions?status=eq.pending&flagged=eq.false&select=affiliate_id,commission_amount`,
      { headers: h }
    );
    const rows = cR.ok ? await cR.json() : [];
    const porAfiliado = new Map();
    for (const r of rows) {
      porAfiliado.set(r.affiliate_id, (porAfiliado.get(r.affiliate_id) || 0) + parseFloat(r.commission_amount || 0));
    }
    const elegiveisIds = Array.from(porAfiliado.entries())
      .filter(([, v]) => v >= VALOR_MINIMO)
      .map(([id]) => id);

    if (!elegiveisIds.length) {
      return res.status(200).json({ ok: true, enviados: 0, motivo: 'nenhum_elegivel' });
    }

    // Busca email, chave, ultimo_saque dos elegiveis em 1 query
    const aR = await fetch(
      `${SU}/rest/v1/affiliates?id=in.(${elegiveisIds.join(',')})&select=id,email,chave_pix,tipo_chave_pix,ultimo_saque_em`,
      { headers: h }
    );
    const afiliados = aR.ok ? await aR.json() : [];

    const hoje = new Date();
    let enviados = 0, pulados_ja_sacou = 0, pulados_sem_chave = 0, erros = 0;

    for (const af of afiliados) {
      // Pula se ja sacou esse mes (caso o cron rode tarde ou afiliado sacou de madrugada)
      if (af.ultimo_saque_em && mesmoMes(af.ultimo_saque_em, hoje)) {
        pulados_ja_sacou++;
        continue;
      }
      const temChave = !!(af.chave_pix && af.tipo_chave_pix);
      const valor = porAfiliado.get(af.id) || 0;
      const chaveMascarada = temChave ? mascararChave(af.chave_pix, af.tipo_chave_pix) : null;

      try {
        let titulo, subtitulo, corpo, ctaLabel;
        if (temChave) {
          titulo = 'Seu saque está disponível';
          subtitulo = `Hoje é dia 22 — e você tem R$ ${valor.toFixed(2).replace('.', ',')} pra receber via Pix.`;
          corpo = `
            <p>Pode acessar o painel e clicar em <b>Sacar</b> — o Pix cai em segundos na chave que você cadastrou.</p>
            <p style="color:rgba(232,244,255,0.55);font-size:13px;margin-top:14px">⚠️ Saques só ficam disponíveis no dia 22 de cada mês. Se não sacar hoje, o próximo dia de saque é 22 do próximo mês.</p>`;
          ctaLabel = 'Sacar agora';
        } else {
          titulo = 'Seu saque tá esperando — falta cadastrar chave Pix';
          subtitulo = `Você tem R$ ${valor.toFixed(2).replace('.', ',')} pra receber, mas ainda não cadastrou sua chave Pix.`;
          corpo = `
            <p>Pra receber hoje, acessa o painel e cadastra a chave (CPF, telefone, email ou aleatória). Leva 1 minuto.</p>
            <p style="color:rgba(232,244,255,0.55);font-size:13px;margin-top:14px">⚠️ Saque só tá disponível hoje (dia 22). Se não cadastrar e sacar até o fim do dia, próximo dia de saque é mês que vem.</p>`;
          ctaLabel = 'Cadastrar chave Pix';
        }

        const html = emailTemplate({
          titulo,
          subtitulo,
          valor,
          chaveMascarada,
          corpo,
          ctaLabel,
          ctaUrl: 'https://bluetubeviral.com/afiliado',
          bannerEmoji: '💰',
        });

        await enviarEmailAfiliado(af.email, titulo, html);
        enviados++;
      } catch (e) {
        console.error('[avisarAfiliados]', af.email, e.message);
        erros++;
      }
    }

    return res.status(200).json({
      ok: true,
      elegiveis: afiliados.length,
      enviados,
      pulados_ja_sacou,
      pulados_sem_chave,
      erros,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
