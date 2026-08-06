// api/blue-monetizacao.js — Monetização de criadores via Stripe Connect
// CommonJS

const MIN_FOLLOWERS = 100;
const MIN_SAQUE = 20;
const FUNDO_PCT = 0.10; // 10% da receita vai pro fundo

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  const SITE = process.env.SITE_URL || 'https://bluetubeviral.com';
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const action = req.method === 'GET' ? req.query.action : (req.body && req.body.action);

  async function getUser(token) {
    if (!token) return null;
    const r = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    const u = await r.json();
    const pR = await fetch(`${SU}/rest/v1/blue_profiles?user_id=eq.${u.id}&select=user_id,username,display_name,avatar_url`, { headers: h });
    const profile = pR.ok ? (await pR.json())[0] : null;
    return { id: u.id, email: u.email, profile };
  }

  async function stripePost(path, params) {
    if (!STRIPE_KEY) throw new Error('Stripe não configurado');
    const r = await fetch('https://api.stripe.com/v1' + path, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(STRIPE_KEY + ':').toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    });
    return r.json();
  }

  async function stripeGet(path) {
    if (!STRIPE_KEY) throw new Error('Stripe não configurado');
    const r = await fetch('https://api.stripe.com/v1' + path, {
      headers: { Authorization: 'Basic ' + Buffer.from(STRIPE_KEY + ':').toString('base64') }
    });
    return r.json();
  }

  // ── CRIAR CONTA STRIPE CONNECT ──────────────────────────────────────────
  if (req.method === 'POST' && action === 'criar-conta') {
    const user = await getUser(req.body.token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });

    try {
      // Check followers
      const fR = await fetch(`${SU}/rest/v1/blue_follows?following_id=eq.${user.id}&select=id`, { headers: { ...h, 'Prefer': 'count=exact' } });
      const fTotal = parseInt(fR.headers?.get('content-range')?.split('/')[1] || '0');
      if (fTotal < MIN_FOLLOWERS) return res.status(400).json({ error: `Mínimo ${MIN_FOLLOWERS} seguidores para monetizar. Você tem ${fTotal}.` });

      // Check if already has account
      const eR = await fetch(`${SU}/rest/v1/blue_creator_accounts?user_id=eq.${user.id}&select=stripe_account_id,stripe_onboarding_completo`, { headers: h });
      const existing = eR.ok ? (await eR.json())[0] : null;

      let accountId;
      if (existing?.stripe_account_id) {
        accountId = existing.stripe_account_id;
      } else {
        // Create Stripe Connect Express account
        const account = await stripePost('/accounts', {
          type: 'express',
          country: 'BR',
          email: user.email,
          'capabilities[transfers][requested]': 'true',
          business_type: 'individual',
          'settings[payouts][schedule][interval]': 'weekly',
        });
        if (account.error) return res.status(500).json({ error: 'Erro Stripe: ' + account.error.message });
        accountId = account.id;

        // Save to DB
        await fetch(`${SU}/rest/v1/blue_creator_accounts`, {
          method: 'POST', headers: { ...h, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ user_id: user.id, stripe_account_id: accountId })
        });
      }

      // Generate onboarding link
      const link = await stripePost('/account_links', {
        account: accountId,
        refresh_url: SITE + '/blue-monetizacao',
        return_url: SITE + '/blue-monetizacao?setup=ok',
        type: 'account_onboarding',
      });
      if (link.error) return res.status(500).json({ error: 'Erro ao gerar link: ' + link.error.message });

      return res.status(200).json({ ok: true, onboarding_url: link.url, account_id: accountId });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── STATUS DA CONTA ─────────────────────────────────────────────────────
  // ── PROGRAMA DE MONETIZAÇÃO POR MARCOS (06/08/2026) ────────────────────
  // 100 seguidores  → link de produto nos vídeos
  // 1.000           → lives com link + doações
  // 10.000          → convite pro Programa de Parceria Blue (paga por view)
  //
  // CONTINGÊNCIA: as tabelas do programa (sql/blue_monetizacao_programa.sql)
  // podem AINDA não ter sido criadas. Nesse caso o endpoint continua
  // devolvendo os marcos e a contagem de seguidores — a tela nunca quebra,
  // só o botão de aplicar fica indisponível com aviso honesto. Endpoint que
  // depende de tabela nova precisa saber viver sem ela até o SQL rodar.
  const MARCOS = [
    { id: 'produto',  min: 100,   titulo: 'Link de produto nos vídeos',
      desc: 'Divulgue produtos com link direto nos seus vídeos e ganhe por indicação.' },
    { id: 'lives',    min: 1000,  titulo: 'Lives com link e doações',
      desc: 'Faça lives com link fixado e receba doações do seu público em tempo real.' },
    { id: 'parceria', min: 10000, titulo: 'Programa de Parceria Blue',
      desc: 'Convite para ganhar por visualização, com repasse mensal direto na sua conta.' },
  ];

  if (action === 'programa-status' || (req.method === 'POST' && (action === 'programa-aplicar' || action === 'programa-avisar'))) {
    const token = req.method === 'GET' ? req.query.token : req.body?.token;
    const u = await getUser(token);
    if (!u) return res.status(401).json({ error: 'Login necessário' });
    const uid = u.id || u.user_id;

    // seguidores reais (fonte única: blue_follows)
    let seguidores = 0;
    try {
      const fR = await fetch(`${SU}/rest/v1/blue_follows?following_id=eq.${uid}&select=id`, {
        headers: { ...h, Prefer: 'count=exact', Range: '0-0' },
      });
      seguidores = parseInt(((fR.headers.get('content-range') || '').split('/')[1] || '0'), 10) || 0;
    } catch (e) { /* segue com 0 — melhor mostrar 0 que quebrar a tela */ }

    // estado das candidaturas/avisos (some silenciosamente se a tabela não existe)
    let aplicacoes = [], avisos = [], tabelaPronta = true;
    try {
      const [aR, avR] = await Promise.all([
        fetch(`${SU}/rest/v1/blue_programa_aplicacoes?user_id=eq.${uid}&select=marco,status,created_at`, { headers: h }),
        fetch(`${SU}/rest/v1/blue_programa_avisos?user_id=eq.${uid}&select=marco`, { headers: h }),
      ]);
      if (aR.ok) aplicacoes = await aR.json(); else tabelaPronta = false;
      if (avR.ok) avisos = await avR.json();
    } catch (e) { tabelaPronta = false; }

    // ── POST aplicar ──
    if (action === 'programa-aplicar') {
      const marco = MARCOS.find((m) => m.id === req.body?.marco);
      if (!marco) return res.status(400).json({ error: 'marco inválido' });
      if (seguidores < marco.min) {
        return res.status(400).json({ error: `Você precisa de ${marco.min} seguidores para essa etapa.`, seguidores });
      }
      if (!tabelaPronta) return res.status(503).json({ error: 'Programa em configuração. Tenta de novo em breve.' });
      const jaTem = aplicacoes.find((a) => a.marco === marco.id);
      if (jaTem) return res.status(200).json({ ok: true, ja: jaTem.status });
      const iR = await fetch(`${SU}/rest/v1/blue_programa_aplicacoes`, {
        method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: uid, marco: marco.id, seguidores }),
      });
      if (!iR.ok) return res.status(500).json({ error: 'não deu pra registrar. tenta de novo.' });
      // avisa o dono do Blue que tem candidatura nova
      await fetch(`${SU}/rest/v1/blue_notificacoes`, {
        method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({
          user_id: uid, tipo: 'programa',
          titulo: 'Candidatura enviada ✅',
          mensagem: `Recebemos sua inscrição em "${marco.titulo}". Damos retorno em breve.`,
          dados: { marco: marco.id, seguidores },
        }),
      }).catch(() => null);
      return res.status(200).json({ ok: true, status: 'em_analise' });
    }

    // ── POST avisar quando atingir ──
    if (action === 'programa-avisar') {
      const marco = MARCOS.find((m) => m.id === req.body?.marco);
      if (!marco) return res.status(400).json({ error: 'marco inválido' });
      if (!tabelaPronta) return res.status(503).json({ error: 'Programa em configuração. Tenta de novo em breve.' });
      await fetch(`${SU}/rest/v1/blue_programa_avisos`, {
        method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: uid, marco: marco.id }),
      }).catch(() => null);
      return res.status(200).json({ ok: true, avisar: true });
    }

    // ── GET status ──
    const porMarco = MARCOS.map((m) => {
      const ap = aplicacoes.find((a) => a.marco === m.id);
      const querAviso = !!avisos.find((a) => a.marco === m.id);
      const atingiu = seguidores >= m.min;
      return {
        ...m,
        atingiu,
        faltam: atingiu ? 0 : m.min - seguidores,
        progresso: Math.min(100, Math.round((seguidores / m.min) * 100)),
        status: ap?.status || null,          // em_analise | aprovado | recusado
        aviso_ativo: querAviso,
      };
    });
    return res.status(200).json({ ok: true, seguidores, marcos: porMarco, programa_pronto: tabelaPronta });
  }

  if (action === 'status') {
    const user = await getUser(req.query.token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });

    try {
      const aR = await fetch(`${SU}/rest/v1/blue_creator_accounts?user_id=eq.${user.id}&select=*`, { headers: h });
      const account = aR.ok ? (await aR.json())[0] : null;

      if (!account) return res.status(200).json({ tem_conta: false });

      // Check Stripe status
      let onboardingOk = account.stripe_onboarding_completo;
      if (!onboardingOk && account.stripe_account_id && STRIPE_KEY) {
        try {
          const sa = await stripeGet('/accounts/' + account.stripe_account_id);
          onboardingOk = sa.charges_enabled && sa.payouts_enabled;
          if (onboardingOk && !account.stripe_onboarding_completo) {
            fetch(`${SU}/rest/v1/blue_creator_accounts?user_id=eq.${user.id}`, {
              method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
              body: JSON.stringify({ stripe_onboarding_completo: true, updated_at: new Date().toISOString() })
            }).catch(() => {});
          }
        } catch(e) {}
      }

      // Get this month's fund estimate
      const now = new Date();
      const mesRef = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      const mesInicio = mesRef + '-01T00:00:00Z';
      const [myViewsR, totalViewsR] = await Promise.all([
        fetch(`${SU}/rest/v1/blue_videos?user_id=eq.${user.id}&status=eq.active&select=views`, { headers: h }),
        fetch(`${SU}/rest/v1/blue_videos?status=eq.active&select=views`, { headers: h }),
      ]);
      const myViews = (myViewsR.ok ? await myViewsR.json() : []).reduce((s, v) => s + (v.views || 0), 0);
      const totalViews = (totalViewsR.ok ? await totalViewsR.json() : []).reduce((s, v) => s + (v.views || 0), 0);
      const myPct = totalViews > 0 ? (myViews / totalViews * 100) : 0;

      return res.status(200).json({
        tem_conta: true,
        onboarding_completo: onboardingOk,
        saldo_disponivel: parseFloat(account.saldo_disponivel || 0),
        saldo_pendente: parseFloat(account.saldo_pendente || 0),
        total_recebido: parseFloat(account.total_recebido || 0),
        total_sacado: parseFloat(account.total_sacado || 0),
        fundo: {
          mes: mesRef,
          minhas_views: myViews,
          views_totais: totalViews,
          meu_percentual: parseFloat(myPct.toFixed(2)),
        }
      });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── SACAR ───────────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'sacar') {
    const { token, valor } = req.body;
    const user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });

    const amount = parseFloat(valor);
    if (!amount || amount < MIN_SAQUE) return res.status(400).json({ error: `Mínimo para saque: R$${MIN_SAQUE},00` });

    try {
      const aR = await fetch(`${SU}/rest/v1/blue_creator_accounts?user_id=eq.${user.id}&select=*`, { headers: h });
      const account = aR.ok ? (await aR.json())[0] : null;
      if (!account?.stripe_account_id) return res.status(400).json({ error: 'Conta de pagamento não configurada' });
      if (!account.stripe_onboarding_completo) return res.status(400).json({ error: 'Complete o setup da conta de pagamento primeiro' });
      if (parseFloat(account.saldo_disponivel || 0) < amount) return res.status(400).json({ error: 'Saldo insuficiente' });

      // Cria registro de saque ANTES do transfer — UUID vira idempotency key.
      // Isso impede double-click / retry criarem 2 transfers Stripe.
      const saqueR = await fetch(`${SU}/rest/v1/blue_creator_saques`, {
        method: 'POST', headers: { ...h, 'Prefer': 'return=representation' },
        body: JSON.stringify({
          user_id: user.id,
          stripe_account_id: account.stripe_account_id,
          valor: amount,
          status: 'processando',
        })
      });
      const [saqueRow] = saqueR.ok ? await saqueR.json() : [null];
      if (!saqueRow) return res.status(500).json({ error: 'Falha ao registrar saque' });

      // Stripe transfer com idempotency baseada no UUID do saque
      const { criarTransfer } = require('./_helpers/stripe.js');
      let transfer;
      try {
        transfer = await criarTransfer({
          amount: Math.round(amount * 100),
          currency: 'brl',
          destination: account.stripe_account_id,
          metadata: {
            user_id: user.id,
            saque_id: saqueRow.id,
            referencia: 'blue_creator_payout',
          },
        }, `creator-saque-${saqueRow.id}`);
      } catch (stripeErr) {
        await fetch(`${SU}/rest/v1/blue_creator_saques?id=eq.${saqueRow.id}`, {
          method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ status: 'falhou', erro: stripeErr.message, processado_em: new Date().toISOString() })
        });
        return res.status(500).json({ error: 'Erro Stripe: ' + stripeErr.message });
      }

      // Update balances
      const newSaldo = parseFloat(account.saldo_disponivel) - amount;
      await fetch(`${SU}/rest/v1/blue_creator_accounts?user_id=eq.${user.id}`, {
        method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ saldo_disponivel: newSaldo, total_sacado: parseFloat(account.total_sacado || 0) + amount, updated_at: new Date().toISOString() })
      });

      // Finaliza o registro do saque
      await fetch(`${SU}/rest/v1/blue_creator_saques?id=eq.${saqueRow.id}`, {
        method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'processado', stripe_payout_id: transfer.id, processado_em: new Date().toISOString() })
      });

      // Notify
      fetch(`${SU}/rest/v1/blue_notificacoes`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ user_id: user.id, tipo: 'saque', titulo: '💸 Saque processado!', mensagem: `R$${amount.toFixed(2)} transferido para sua conta bancária` })
      }).catch(() => {});

      return res.status(200).json({ ok: true, novo_saldo: newSaldo, transfer_id: transfer.id });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── HISTÓRICO ───────────────────────────────────────────────────────────
  if (action === 'historico') {
    const user = await getUser(req.query.token);
    if (!user) return res.status(401).json({ error: 'Token inválido' });

    try {
      const [gorjR, saqR, fundR] = await Promise.all([
        fetch(`${SU}/rest/v1/blue_gorjetas?destinatario_id=eq.${user.id}&order=created_at.desc&limit=20&select=emoji,valor,bluecoins,remetente_id,created_at`, { headers: h }),
        fetch(`${SU}/rest/v1/blue_creator_saques?user_id=eq.${user.id}&order=created_at.desc&limit=10&select=valor,status,created_at,processado_em`, { headers: h }),
        fetch(`${SU}/rest/v1/blue_fundo_distribuicao?user_id=eq.${user.id}&order=created_at.desc&limit=10&select=valor,percentual,views_periodo,pago,created_at`, { headers: h }),
      ]);
      const gorjetas = gorjR.ok ? await gorjR.json() : [];
      const saques = saqR.ok ? await saqR.json() : [];
      const fundo = fundR.ok ? await fundR.json() : [];

      // Merge into unified timeline
      const timeline = [
        ...gorjetas.map(g => ({ tipo: 'gorjeta', valor: g.valor, emoji: g.emoji, data: g.created_at })),
        ...saques.map(s => ({ tipo: 'saque', valor: -s.valor, status: s.status, data: s.created_at })),
        ...fundo.map(f => ({ tipo: 'fundo', valor: f.valor, percentual: f.percentual, views: f.views_periodo, data: f.created_at })),
      ].sort((a, b) => new Date(b.data) - new Date(a.data)).slice(0, 30);

      return res.status(200).json({ transacoes: timeline });
    } catch(e) { return res.status(200).json({ transacoes: [] }); }
  }

  // ── DISTRIBUIR FUNDO (cron mensal) ──────────────────────────────────────
  if (action === 'distribuir-fundo') {
    try {
      const now = new Date();
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const mesRef = prevMonth.getFullYear() + '-' + String(prevMonth.getMonth() + 1).padStart(2, '0');
      const mesInicio = mesRef + '-01T00:00:00Z';
      const mesFim = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01T00:00:00Z';

      // Check if already distributed
      const fExist = await fetch(`${SU}/rest/v1/blue_fundo_criadores?mes_referencia=eq.${mesRef}&select=id,status`, { headers: h });
      const existing = fExist.ok ? (await fExist.json())[0] : null;
      if (existing?.status === 'distribuido') return res.status(200).json({ ok: true, message: 'Já distribuído este mês' });

      // Calculate fund amount (10% of subscriptions revenue)
      const subR = await fetch(`${SU}/rest/v1/subscribers?plan=neq.free&is_manual=eq.false&select=plan`, { headers: h });
      const subs = subR.ok ? await subR.json() : [];
      const mrr = subs.reduce((s, sub) => s + (sub.plan === 'master' ? 89.99 : 29.99), 0);
      const fundoTotal = mrr * FUNDO_PCT;

      if (fundoTotal < 1) return res.status(200).json({ ok: true, message: 'Fundo insuficiente', valor: fundoTotal });

      // Create fund record
      const fR = await fetch(`${SU}/rest/v1/blue_fundo_criadores`, {
        method: 'POST', headers: { ...h, 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ mes_referencia: mesRef, valor_total: fundoTotal, status: 'aberto' })
      });
      const fundo = fR.ok ? (await fR.json())[0] : null;
      if (!fundo) return res.status(500).json({ error: 'Erro ao criar fundo' });

      // Get all active creators with their views
      const vR = await fetch(`${SU}/rest/v1/blue_videos?status=eq.active&select=user_id,views`, { headers: h });
      const vids = vR.ok ? await vR.json() : [];
      const viewsByCreator = {};
      let totalViews = 0;
      vids.forEach(v => {
        if (!v.user_id) return;
        viewsByCreator[v.user_id] = (viewsByCreator[v.user_id] || 0) + (v.views || 0);
        totalViews += (v.views || 0);
      });

      if (totalViews === 0) {
        await fetch(`${SU}/rest/v1/blue_fundo_criadores?id=eq.${fundo.id}`, { method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ status: 'distribuido', valor_distribuido: 0 }) });
        return res.status(200).json({ ok: true, message: 'Nenhuma view no período' });
      }

      // Distribute to eligible creators (with creator accounts)
      const acR = await fetch(`${SU}/rest/v1/blue_creator_accounts?stripe_onboarding_completo=eq.true&select=user_id,stripe_account_id,saldo_disponivel,total_recebido`, { headers: h });
      const accounts = acR.ok ? await acR.json() : [];
      let distributed = 0;

      for (const acc of accounts) {
        const views = viewsByCreator[acc.user_id] || 0;
        if (views === 0) continue;
        const pct = views / totalViews;
        const valor = parseFloat((fundoTotal * pct).toFixed(2));
        if (valor < 0.01) continue;

        // Credit creator
        await fetch(`${SU}/rest/v1/blue_creator_accounts?user_id=eq.${acc.user_id}`, {
          method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            saldo_disponivel: parseFloat(acc.saldo_disponivel || 0) + valor,
            total_recebido: parseFloat(acc.total_recebido || 0) + valor,
            updated_at: new Date().toISOString()
          })
        });

        // Record distribution
        await fetch(`${SU}/rest/v1/blue_fundo_distribuicao`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ fundo_id: fundo.id, user_id: acc.user_id, views_periodo: views, percentual: parseFloat((pct * 100).toFixed(2)), valor, pago: true })
        });

        // Notify
        fetch(`${SU}/rest/v1/blue_notificacoes`, { method: 'POST', headers: { ...h, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ user_id: acc.user_id, tipo: 'fundo', titulo: '💰 Fundo de Criadores!', mensagem: `Você recebeu R$${valor.toFixed(2)} referente a ${mesRef}` })
        }).catch(() => {});

        distributed += valor;
      }

      // Mark fund as distributed
      await fetch(`${SU}/rest/v1/blue_fundo_criadores?id=eq.${fundo.id}`, { method: 'PATCH', headers: { ...h, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'distribuido', valor_distribuido: distributed }) });

      console.log(`💰 Fund distributed: ${mesRef} — R$${distributed.toFixed(2)} to ${accounts.length} creators`);
      return res.status(200).json({ ok: true, mes: mesRef, fundo_total: fundoTotal, distribuido: distributed, criadores: accounts.length });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(404).json({ error: 'Action não encontrada' });
};
