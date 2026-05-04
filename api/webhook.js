// api/webhook.js
// Listens to Stripe webhook events and updates subscriber plans in Supabase.
// Blindagem: idempotencia via stripe_webhook_log + log de tentativas + retry
// via cron (GET ?action=reprocessar).

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  // Cron: reprocessa eventos com status=erro e tentativas<5
  if (req.method === 'GET' && (req.query?.action === 'reprocessar')) {
    return reprocessarEventosComErro(req, res);
  }

  if (req.method !== 'POST') return res.status(405).end();

  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const helperMod = await import('./_helpers/stripe.js');
  const H = helperMod.default || helperMod;

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  // Verifica assinatura (HMAC + timingSafeEqual + anti-replay 5min)
  let event;
  try {
    event = H.verificarWebhook(rawBody, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature invalida:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Idempotencia: se ja processamos com sucesso, so retorna 200
  let tentativa = 1;
  try {
    const existente = await H.buscarEvento(event.id);
    if (existente?.status === 'concluido') {
      console.log(`[webhook] ${event.id} ja processado — ignorando`);
      return res.status(200).json({ ok: true, status: 'already_processed' });
    }
    tentativa = (existente?.tentativas || 0) + 1;
    await H.registrarEventoIniciando(event, tentativa);
  } catch (e) {
    console.error('[webhook] falha ao logar evento:', e.message);
    // Nao bloqueia processamento — log eh best-effort
  }

  // Responde 200 ANTES de processar (Stripe exige < 30s)
  // Vercel mantem a funcao viva ate o handler retornar, entao o processing
  // abaixo continua rodando ate o maxDuration.
  res.status(200).json({ received: true });

  try {
    await processarEvento(event, { SUPABASE_URL, SUPABASE_KEY });
    await H.marcarEventoConcluido(event.id).catch(() => {});
    console.log(`[webhook] ${event.type} ${event.id} — concluido`);
  } catch (err) {
    console.error(`[webhook] ${event.type} ${event.id} — erro:`, err.message);
    const status = await H.marcarEventoErro(event.id, err.message, tentativa).catch(() => 'erro');
    const eventosCriticos = [
      'checkout.session.completed',
      'customer.subscription.deleted',
      'invoice.payment_failed',
      'charge.refunded',
    ];
    if (eventosCriticos.includes(event.type) || status === 'falha_permanente') {
      await H.notificarAdminWebhookErro(event, err).catch(() => {});
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Reprocessamento (cron */15min via vercel.json)
// ──────────────────────────────────────────────────────────────────────────
async function reprocessarEventosComErro(req, res) {
  const helperMod = await import('./_helpers/stripe.js');
  const H = helperMod.default || helperMod;

  try {
    // Busca DOIS conjuntos de eventos pra reprocessar:
    //   1) status=erro                             — tentou, falhou, pode retentar
    //   2) status=processando E created_at < 10min — zumbi (funcao morreu no meio)
    //
    // Causa do bug victorprocesso@gmail.com: webhook ficou 'processando' 4 dias
    // porque o cron so pegava 'erro'. Agora tambem pega zumbis >10min.
    const cutoffZumbi = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const rows = await H.supaFetch(
      `/stripe_webhook_log?or=(status.eq.erro,and(status.eq.processando,created_at.lt.${cutoffZumbi}))&tentativas=lt.5&select=id,stripe_event_id,tipo,payload,tentativas,status,created_at&order=created_at.asc&limit=50`
    );

    let reprocessados = 0, sucesso = 0, falhou = 0, zumbis = 0;
    for (const row of rows) {
      reprocessados++;
      if (row.status === 'processando') zumbis++;
      const event = row.payload;
      const tentativa = (row.tentativas || 0) + 1;
      try {
        await H.registrarEventoIniciando(event, tentativa);
        await processarEvento(event, {
          SUPABASE_URL: process.env.SUPABASE_URL,
          SUPABASE_KEY: process.env.SUPABASE_SERVICE_KEY,
        });
        await H.marcarEventoConcluido(event.id);
        sucesso++;
      } catch (err) {
        console.error(`[webhook reproc] ${event.id} falhou:`, err.message);
        const status = await H.marcarEventoErro(event.id, err.message, tentativa).catch(() => 'erro');
        if (status === 'falha_permanente') {
          await H.notificarAdminWebhookErro(event, err).catch(() => {});
        }
        falhou++;
      }
    }

    return res.status(200).json({ ok: true, reprocessados, sucesso, falhou, zumbis });
  } catch (err) {
    console.error('[webhook reproc] erro geral:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Processamento dos eventos (logica original preservada)
// ──────────────────────────────────────────────────────────────────────────
async function processarEvento(event, { SUPABASE_URL, SUPABASE_KEY }) {
  const supaHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  const RESEND_KEY = process.env.RESEND_API_KEY;
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  const _now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const _prices = { full: 'R$29,99', master: 'R$89,99' };

  async function notifyStripe(subject, rows) {
    if (!RESEND_KEY || !ADMIN_EMAIL) return;
    const body = rows.map(([k, v]) => `<tr><td style="padding:8px 12px;color:rgba(150,190,230,.5);font-size:12px;white-space:nowrap">${k}</td><td style="padding:8px 12px;font-size:13px;font-weight:600">${v}</td></tr>`).join('');
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: 'BlueTube <noreply@bluetubeviral.com>',
          to: [ADMIN_EMAIL],
          subject,
          html: `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;background:#0a1628;color:#e8f4ff;border-radius:16px;overflow:hidden;border:1px solid rgba(0,170,255,.2)">
            <div style="background:linear-gradient(135deg,#1a6bff,#00aaff);padding:18px 24px">
              <div style="font-size:16px;font-weight:800;color:#fff">${subject}</div>
              <div style="font-size:11px;color:rgba(255,255,255,.6);margin-top:4px">${_now}</div>
            </div>
            <table style="width:100%;border-collapse:collapse;padding:8px">${body}</table>
            <div style="padding:16px 24px;border-top:1px solid rgba(0,170,255,.08)">
              <a href="https://dashboard.stripe.com" style="color:#00aaff;font-size:12px;text-decoration:none">Abrir Stripe Dashboard →</a>
            </div>
          </div>`
        })
      });
    } catch (e) { console.error('Resend error:', e.message); }
  }

  // ── HELPERS de comissao ──────────────────────────────────────────────────
  // Salva o intento na fila pra cron reprocessar caso o PATCH direto falhe.
  async function enqueueCommissionPatch(payload) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/commission_patch_queue`, {
        method: 'POST',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ ...payload, status: 'pending' })
      });
      console.log(`[commission-queue] enfileirado: ${payload.subscriber_email} (${payload.source})`);
    } catch(e) { console.error('[commission-queue] enqueue falhou:', e.message); }
  }

  // Aplica a correcao de comissao: PATCH direto + history + total_earnings delta.
  // Em caso de falha (row nao encontrada, rede, Supabase lento), enfileira retry.
  async function applyCommissionCorrection({ affiliate, email, plan, rate, paidAmount, couponApplied, couponDiscount, source, stripeCustomerId, currency }) {
    const correctedAmount = parseFloat((paidAmount * rate).toFixed(2));
    // Sprint 1.5 multi-currency: normaliza moeda em uppercase pra usar como
    // chave em total_earnings_by_currency e column affiliate_commissions.currency.
    const cur = String(currency || 'BRL').toUpperCase();
    try {
      const curRes = await fetch(`${SUPABASE_URL}/rest/v1/affiliate_commissions?affiliate_id=eq.${affiliate.id}&subscriber_email=eq.${encodeURIComponent(email)}&plan=eq.${plan}&status=in.(pending,paid)&order=created_at.desc&limit=1&select=id,commission_amount,commission_rate,plan_amount,commission_history,flagged`, { headers: supaHeaders });
      const [row] = curRes.ok ? await curRes.json() : [];
      if (!row) {
        // Linha ainda nao existe (auth.js pode ter demorado) — enfileira retry
        await enqueueCommissionPatch({
          affiliate_id: affiliate.id, subscriber_email: email, plan,
          paid_amount: paidAmount, rate, coupon_applied: !!couponApplied,
          coupon_discount: couponDiscount || 0, source,
          last_error: 'commission_row_not_found'
        });
        return { ok: false, queued: true };
      }
      const prev = parseFloat(row.commission_amount || 0);
      const delta = parseFloat((correctedAmount - prev).toFixed(2));
      // Audit trail — append no jsonb
      const history = Array.isArray(row.commission_history) ? row.commission_history : [];
      history.push({
        at: new Date().toISOString(), source,
        prev_amount: prev, new_amount: correctedAmount,
        prev_rate: parseFloat(row.commission_rate || 0), new_rate: rate,
        prev_plan_amount: parseFloat(row.plan_amount || 0), new_plan_amount: paidAmount,
        coupon_applied: !!couponApplied, coupon_discount: couponDiscount || 0,
      });
      // Deteccao de self-referral — antes do PATCH, checa sinais
      let fraudFlag = null;
      if (!row.flagged) { // Nao re-flagga o que ja foi flaggado
        fraudFlag = await detectSelfReferral({ affiliate, subscriberEmail: email, stripeCustomerId });
      }

      const patchBody = {
        commission_rate: rate,
        commission_amount: correctedAmount,
        plan_amount: paidAmount,
        commission_history: history,
        currency: cur,
      };
      if (couponApplied) patchBody.coupon_applied = true;
      if (couponDiscount > 0) patchBody.coupon_discount = couponDiscount;
      if (fraudFlag?.flagged) {
        patchBody.flagged = true;
        patchBody.flagged_reason = fraudFlag.reason;
        patchBody.flagged_at = new Date().toISOString();
        history.push({
          at: new Date().toISOString(), source: `${source}_self_referral_flag`,
          reason: fraudFlag.reason, auto_flag: true,
        });
        patchBody.commission_history = history;
      }
      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/affiliate_commissions?id=eq.${row.id}`, {
        method: 'PATCH', headers: supaHeaders, body: JSON.stringify(patchBody)
      });
      if (!patchRes.ok) {
        const errTxt = await patchRes.text().catch(() => '');
        await enqueueCommissionPatch({
          affiliate_id: affiliate.id, subscriber_email: email, plan,
          paid_amount: paidAmount, rate, coupon_applied: !!couponApplied,
          coupon_discount: couponDiscount || 0, source,
          last_error: `patch_failed_${patchRes.status}: ${errTxt.slice(0,200)}`
        });
        return { ok: false, queued: true };
      }
      // Ajusta total_earnings do afiliado. Se flaggada como self-referral,
      // reverte o valor antigo que auth.js ja tinha adicionado (não conta no
      // saldo ate admin aprovar).
      const earningsDelta = fraudFlag?.flagged ? -prev : delta;
      if (earningsDelta !== 0) {
        // Sprint 1.5 multi-currency: incrementa bucket da moeda real em
        // total_earnings_by_currency. total_earnings (numeric BRL) so e atualizado
        // quando cur==='BRL' pra preservar compat com codigo legado que ainda le.
        const currentTeBC = (affiliate.total_earnings_by_currency && typeof affiliate.total_earnings_by_currency === 'object')
          ? affiliate.total_earnings_by_currency : { BRL: 0 };
        const newTeBC = { ...currentTeBC };
        newTeBC[cur] = parseFloat(((parseFloat(newTeBC[cur] || 0) + earningsDelta)).toFixed(2));
        const patchAffBody = {
          total_earnings_by_currency: newTeBC,
          updated_at: new Date().toISOString(),
        };
        if (cur === 'BRL') {
          patchAffBody.total_earnings = parseFloat(((parseFloat(affiliate.total_earnings) || 0) + earningsDelta).toFixed(2));
        }
        await fetch(`${SUPABASE_URL}/rest/v1/affiliates?id=eq.${affiliate.id}`, {
          method: 'PATCH', headers: supaHeaders,
          body: JSON.stringify(patchAffBody)
        });
      }

      // Notifica admin se flaggada
      if (fraudFlag?.flagged) {
        notifyStripe(`🚨 Comissao em analise — possivel auto-indicacao`, [
          ['Afiliado', affiliate.email || '—'],
          ['Assinante', email],
          ['Plano', plan?.toUpperCase() || '—'],
          ['Valor', `R$${correctedAmount.toFixed(2)}`],
          ['Motivos', fraudFlag.reason],
          ['Acao', 'Revise em Supabase: affiliate_commissions WHERE flagged=true'],
        ]).catch(() => {});
        console.log(`🚨 FLAGGED self-referral: ${affiliate.email} ← ${email} (${fraudFlag.reason})`);
      }

      return { ok: true, delta, prev, correctedAmount, flagged: !!fraudFlag?.flagged };
    } catch (e) {
      console.error('[applyCommissionCorrection] erro:', e.message);
      await enqueueCommissionPatch({
        affiliate_id: affiliate.id, subscriber_email: email, plan,
        paid_amount: paidAmount, rate, coupon_applied: !!couponApplied,
        coupon_discount: couponDiscount || 0, source,
        last_error: `exception: ${e.message.slice(0,200)}`
      });
      return { ok: false, queued: true };
    }
  }

  // Normaliza email pra detectar truques do tipo john+test@gmail = john@gmail.
  // Strip de +tag em qualquer provedor; strip de dots no local-part do gmail.
  function normEmail(e) {
    if (!e || typeof e !== 'string') return '';
    const [local, domain] = e.toLowerCase().trim().split('@');
    if (!domain) return e.toLowerCase().trim();
    let l = local.split('+')[0];
    if (domain === 'gmail.com' || domain === 'googlemail.com') l = l.replace(/\./g, '');
    return `${l}@${domain}`;
  }

  // Detecta sinais de auto-indicacao. Retorna { flagged, reason } ou null.
  // Sinais fortes (flagga direto):
  //  1) email normalizado do subscriber == email normalizado do afiliado
  //  2) cookie_id do click esta em affiliate_fingerprints do proprio afiliado
  //  3) ip_hash do click esta em affiliate_fingerprints do proprio afiliado
  //  4) stripe_customer_id do subscriber == stripe_customer_id de outra
  //     conta ligada ao afiliado
  async function detectSelfReferral({ affiliate, subscriberEmail, stripeCustomerId }) {
    const reasons = [];
    try {
      // 1) Email normalizado
      if (normEmail(affiliate.email) === normEmail(subscriberEmail)) {
        reasons.push('email_normalizado_igual');
      }

      // Busca fingerprints do afiliado
      const fpRes = await fetch(
        `${SUPABASE_URL}/rest/v1/affiliate_fingerprints?affiliate_id=eq.${affiliate.id}&select=ip_hash,visitor_fingerprint,cookie_id`,
        { headers: supaHeaders }
      );
      const fingerprints = fpRes.ok ? await fpRes.json() : [];
      const affCookieIds = new Set(fingerprints.map(f => f.cookie_id).filter(Boolean));
      const affIpHashes = new Set(fingerprints.map(f => f.ip_hash).filter(Boolean));
      const affFps = new Set(fingerprints.map(f => f.visitor_fingerprint).filter(Boolean));

      // Busca clicks mais recentes pra esse afiliado (ultimos 30 dias)
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const ckRes = await fetch(
        `${SUPABASE_URL}/rest/v1/affiliate_clicks?affiliate_id=eq.${affiliate.id}&landed_at=gte.${cutoff}&select=cookie_id,ip_hash,visitor_fingerprint&order=landed_at.desc&limit=200`,
        { headers: supaHeaders }
      );
      const clicks = ckRes.ok ? await ckRes.json() : [];

      // 2/3) Qualquer click com fingerprint que bata com o proprio afiliado
      const clickMatch = clicks.find(c =>
        (c.cookie_id && affCookieIds.has(c.cookie_id)) ||
        (c.ip_hash && affIpHashes.has(c.ip_hash)) ||
        (c.visitor_fingerprint && affFps.has(c.visitor_fingerprint))
      );
      if (clickMatch) {
        if (clickMatch.cookie_id && affCookieIds.has(clickMatch.cookie_id)) reasons.push('click_cookie_igual_afiliado');
        else if (clickMatch.ip_hash && affIpHashes.has(clickMatch.ip_hash)) reasons.push('click_ip_igual_afiliado');
        else reasons.push('click_fingerprint_igual_afiliado');
      }

      // 4) Stripe customer compartilhado — afiliado eh tambem subscriber com
      // mesmo customer_id? (cenario raro mas possivel)
      if (stripeCustomerId) {
        const affSubRes = await fetch(
          `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(affiliate.email)}&select=stripe_customer_id`,
          { headers: supaHeaders }
        );
        const [affSub] = affSubRes.ok ? await affSubRes.json() : [];
        if (affSub?.stripe_customer_id && affSub.stripe_customer_id === stripeCustomerId) {
          reasons.push('stripe_customer_id_igual_afiliado');
        }
      }
    } catch (e) {
      console.error('[detectSelfReferral] erro:', e.message);
      // Em caso de erro na deteccao, nao flagga — evita falso positivo
      return null;
    }
    return reasons.length > 0 ? { flagged: true, reason: reasons.join(',') } : null;
  }

  // Resolve taxa efetiva do afiliado (override do admin > nivel auto)
  function effectiveRate(aff) {
    const LEVEL_RATES = { bronze: 0.35, silver: 0.40, gold: 0.58 };
    const levelKey = (aff.level || aff.nivel || 'bronze').toLowerCase();
    return (typeof aff.comissao_percentual === 'number' && aff.comissao_percentual > 0)
      ? { rate: aff.comissao_percentual / 100, levelKey, source: 'admin_override' }
      : { rate: LEVEL_RATES[levelKey] || 0.35, levelKey, source: 'level_default' };
  }

  // ── CHECKOUT CONCLUÍDO → Ativa plano ─────────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const plan = session.metadata?.plan || 'full';
    const billing = session.metadata?.billing || 'monthly';
    const email = session.customer_details?.email;
    const customerId = session.customer;
    const subscriptionId = session.subscription;

    if (!email) {
      console.error('❌ checkout.session.completed sem email:', session.id);
      return;
    }

    const expiresAt = billing === 'annual'
      ? new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString()
      : new Date(Date.now() + 37 * 24 * 60 * 60 * 1000).toISOString();

    // Valor REAL pago ao Stripe (com desconto de cupom). amount_total em centavos → /100.
    // Extraido aqui pra gravar no subscribers (antes era extraido depois e descartado — bug
    // onde admin painel mostrava valor hardcoded R$29,99/R$89,99 ignorando moeda e cupom).
    const paidAmount = typeof session.amount_total === 'number'
      ? parseFloat((session.amount_total / 100).toFixed(2))
      : (plan === 'master' ? 89.99 : 29.99);
    const stripeCurrency = (session.currency || 'brl').toLowerCase();
    const couponApplied = (session.total_details?.amount_discount || 0) > 0;
    const couponDiscount = session.total_details?.amount_discount
      ? parseFloat((session.total_details.amount_discount / 100).toFixed(2)) : 0;
    const billingPeriod = billing === 'annual' ? 'annual' : 'monthly';

    const patchR = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        plan,
        is_manual: false,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        plan_expires_at: expiresAt,
        cancel_at_period_end: false,
        amount_paid: paidAmount,
        currency: stripeCurrency,
        coupon_applied: couponApplied,
        coupon_discount: couponDiscount,
        billing_period: billingPeriod,
        updated_at: new Date().toISOString()
      })
    });
    const patchData = await patchR.json();

    let r;
    if (Array.isArray(patchData) && patchData.length > 0) {
      r = patchR;
      console.log(`✅ Plan updated via PATCH: ${email} → ${plan}`);
    } else {
      r = await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
        method: 'POST',
        headers: { ...supaHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify({
          email,
          plan,
          is_manual: false,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          plan_expires_at: expiresAt,
          cancel_at_period_end: false,
          amount_paid: paidAmount,
          currency: stripeCurrency,
          coupon_applied: couponApplied,
          coupon_discount: couponDiscount,
          billing_period: billingPeriod,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      });
    }

    if (!r.ok) {
      const err = await r.text();
      throw new Error('Supabase upsert: ' + err.slice(0, 200));
    }

    console.log(`✅ Plan activated: ${email} → ${plan} (${billing})`);

    // Notificacao Telegram com valor REAL (moeda e cupom inclusos).
    const _curSym = { brl:'R$', usd:'$', eur:'€', gbp:'£', cad:'C$', aud:'A$' }[stripeCurrency] || stripeCurrency.toUpperCase()+' ';
    const _valFmt = stripeCurrency === 'brl'
      ? `${_curSym}${paidAmount.toFixed(2).replace('.',',')}`
      : `${_curSym}${paidAmount.toFixed(2)} ${stripeCurrency.toUpperCase()}`;
    const _valWithCoupon = couponApplied ? `${_valFmt} 🎟️ (-${couponDiscount.toFixed(2)})` : _valFmt;
    notifyStripe(`💰 Nova assinatura — ${plan.toUpperCase()} — ${email}`, [
      ['Cliente', email],
      ['Plano', `${plan === 'master' ? '👑' : '⚡'} ${plan.toUpperCase()}`],
      ['Valor', _valWithCoupon],
      ['Billing', billing === 'annual' ? 'Anual' : 'Mensal'],
      ['Stripe ID', customerId || '—'],
    ]).catch(() => {});

    import('./_helpers/upgradeEmail.js')
      .then((m) => m.sendUpgradeEmail(email, plan, billing))
      .catch((e) => console.error('upgradeEmail (webhook):', e.message));

    const SITE_URL = process.env.SITE_URL || 'https://bluetubeviral.com';

    fetch(`${SITE_URL}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'conversion', email, plan, stripe_customer_id: customerId, conversion_type: `upgrade_${plan}` })
    }).then(async () => {
      try {
        // Fonte 1 (primaria): affiliate_ref salvo no subscribers (cookie venceu no signup)
        const subRef = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=affiliate_ref`, { headers: supaHeaders });
        const refData = subRef.ok ? await subRef.json() : [];
        let refCode = refData?.[0]?.affiliate_ref;
        let attribSource = 'cookie_signup';
        // Fonte 2 (fallback): metadata do Stripe — cookie NAO sobrescreve (regra),
        // so e usado se affiliate_ref esta vazio.
        if (!refCode) {
          const stripeRef = session.metadata?.ref || session.client_reference_id;
          if (stripeRef && /^[a-zA-Z0-9_-]{4,64}$/.test(stripeRef)) {
            refCode = stripeRef;
            attribSource = 'stripe_metadata';
          }
        }
        if (!refCode) {
          // Log "no_match" pra auditoria
          fetch(`${SUPABASE_URL}/rest/v1/affiliate_attribution_log`, {
            method: 'POST', headers: { ...supaHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({ email, source: 'none', decisao: 'no_match', detalhes: { context: 'checkout_upgrade', plan } }),
          }).catch(() => {});
          return;
        }
        const affRes = await fetch(`${SUPABASE_URL}/rest/v1/affiliates?ref_code=eq.${refCode}&select=id,comissao_percentual,nivel,level,email,total_earnings,total_earnings_by_currency`, { headers: supaHeaders });
        const aff = affRes.ok ? (await affRes.json())?.[0] : null;
        if (!aff) {
          fetch(`${SUPABASE_URL}/rest/v1/affiliate_attribution_log`, {
            method: 'POST', headers: { ...supaHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({ email, ref_code: refCode, source: attribSource, decisao: 'no_match', detalhes: { reason: 'affiliate_nao_encontrado' } }),
          }).catch(() => {});
          return;
        }
        // Denormaliza attribution_source no subscribers pra facilitar diagnostico
        // (1 query no suporte, sem JOIN com affiliate_attribution_log). Se veio por
        // stripe_metadata e ainda nao havia ref salvo, tambem grava o affiliate_ref.
        fetch(`${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`, {
          method: 'PATCH', headers: { ...supaHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify(
            attribSource === 'stripe_metadata'
              ? { attribution_source: attribSource, affiliate_ref: refCode, updated_at: new Date().toISOString() }
              : { attribution_source: attribSource, updated_at: new Date().toISOString() }
          ),
        }).catch(() => {});
        // Log decisao de atribuicao
        fetch(`${SUPABASE_URL}/rest/v1/affiliate_attribution_log`, {
          method: 'POST', headers: { ...supaHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({
            email, ref_code: refCode, affiliate_id: aff.id, source: attribSource,
            decisao: 'attributed',
            detalhes: { context: 'checkout_upgrade', plan, affiliate_email: aff.email },
          }),
        }).catch(() => {});
        const { rate, levelKey, source: rateSource } = effectiveRate(aff);
        const result = await applyCommissionCorrection({
          affiliate: aff, email, plan, rate, paidAmount,
          couponApplied, couponDiscount, source: 'checkout',
          stripeCustomerId: customerId,
          currency: session.metadata?.currency,
        });
        if (result.ok) {
          const flagTag = result.flagged ? ' 🚨 FLAGGED' : '';
          console.log(`💰 Commission corrected [${rateSource}]${flagTag}: ${aff.email} ${levelKey} ${(rate*100).toFixed(0)}% × R$${paidAmount}${couponApplied?` (cupom -R$${couponDiscount})`:''} = R$${result.correctedAmount} (antes R$${result.prev}, delta R$${result.delta}) — ${email}`);
        } else {
          console.log(`⏳ Commission queued for retry: ${aff.email} ← ${email} (${plan})`);
        }
      } catch(e) { console.error('Commission correction error:', e.message); }
    }).catch(() => {});

    // Programa Pioneiros
    try {
      const pioRef = session.metadata?.ref || session.client_reference_id;
      if (pioRef) {
        const pioR = await fetch(`${SUPABASE_URL}/rest/v1/pioneiros_programa?link_ref=eq.${encodeURIComponent(pioRef)}&select=id,status&limit=1`, { headers: supaHeaders });
        const [pioneiro] = pioR.ok ? await pioR.json() : [];
        if (pioneiro && pioneiro.status !== 'bloqueado') {
          await fetch(`${SUPABASE_URL}/rest/v1/pioneiros_indicacoes`, {
            method: 'POST',
            headers: { ...supaHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({
              pioneiro_id: pioneiro.id,
              link_ref: pioRef,
              assinante_email: email,
              stripe_customer_id: customerId,
              stripe_subscription_id: subscriptionId,
              plano: plan,
              valor_mensal: plan === 'master' ? 89.99 : 29.99,
              meses_ativos: 1,
              primeira_cobranca_em: new Date().toISOString(),
              ultima_cobranca_em: new Date().toISOString(),
            }),
          });
          await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_pioneiro_indicados`, {
            method: 'POST',
            headers: { ...supaHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({ pid: pioneiro.id }),
          }).catch(async () => {
            const cur = await fetch(`${SUPABASE_URL}/rest/v1/pioneiros_programa?id=eq.${pioneiro.id}&select=assinantes_indicados`, { headers: supaHeaders });
            const [row] = cur.ok ? await cur.json() : [{ assinantes_indicados: 0 }];
            await fetch(`${SUPABASE_URL}/rest/v1/pioneiros_programa?id=eq.${pioneiro.id}`, {
              method: 'PATCH',
              headers: supaHeaders,
              body: JSON.stringify({ assinantes_indicados: (row.assinantes_indicados || 0) + 1, updated_at: new Date().toISOString() }),
            });
          });
          console.log(`🏆 Pioneiros: indicação registrada para ref=${pioRef} (${email})`);
        }
      }
    } catch (e) { console.error('Pioneiros tracking error:', e.message); }
    return;
  }

  // ── RENOVAÇÃO ────────────────────────────────────────────────────────────
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    const customerId = invoice.customer;
    const subscriptionId = invoice.subscription;
    if (!subscriptionId) return;

    const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}&select=email,plan`, { headers: supaHeaders });
    const subs = await subRes.json();
    if (!subs?.length) return;

    // ── Fase B2 — Recovery anti-zumbi ────────────────────────────────────
    // Se subscriber.plan='free' MAS chegou pagamento real (amount_paid>0), o
    // user esta pagando sem ter acesso (zumbi pagante). Auto-corrige:
    // cancela sub + refund do charge atual + alerta admin. Sistema autocura.
    if (subs[0].plan === 'free' && (invoice.amount_paid || 0) > 0) {
      console.warn(`🚨 [B2] ZUMBI PAGANTE: ${subs[0].email} pagou R$${(invoice.amount_paid/100).toFixed(2)} mas plan=free. Auto-corrigindo.`);
      const STRIPE_SECRET_B2 = process.env.STRIPE_SECRET_KEY;
      try {
        if (STRIPE_SECRET_B2 && subscriptionId) {
          await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${STRIPE_SECRET_B2}` }
          });
        }
        const chargeId = invoice.charge;
        if (STRIPE_SECRET_B2 && chargeId) {
          await fetch('https://api.stripe.com/v1/refunds', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${STRIPE_SECRET_B2}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({ charge: chargeId, reason: 'requested_by_customer' }).toString()
          });
        }
        await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}`, {
          method: 'PATCH', headers: supaHeaders,
          body: JSON.stringify({
            plan: 'free',
            stripe_subscription_id: null,
            plan_expires_at: null,
            updated_at: new Date().toISOString()
          })
        });
        notifyStripe(`🚨 [B2] ZUMBI PAGANTE auto-corrigido — ${subs[0].email}`, [
          ['Cliente', subs[0].email],
          ['Valor refundado', `R$${(invoice.amount_paid/100).toFixed(2)}`],
          ['Charge', chargeId || 'sem_charge_id'],
          ['Sub cancelada', subscriptionId],
          ['Motivo', 'invoice.payment_succeeded com plan=free no DB (auto-blindagem)'],
        ]).catch(() => {});
        console.log(`✅ [B2] Auto-corrigido: ${subs[0].email}`);
        return; // Skip resto (renewal expires + comissao) — nao faz sentido renovar zumbi
      } catch (e) {
        console.error(`[B2] Falha ao auto-corrigir ${subs[0].email}:`, e.message);
        notifyStripe(`🚨 [B2] FALHA ao corrigir zumbi — ${subs[0].email}`, [
          ['Cliente', subs[0].email],
          ['Erro', e.message],
          ['Acao manual', 'Use POST /api/admin {action:"refund-and-cancel"}'],
        ]).catch(() => {});
        // Nao return — deixa fluxo normal seguir pra nao quebrar webhook
      }
    }

    const billing = invoice.lines?.data?.[0]?.plan?.interval === 'year' ? 'annual' : 'monthly';
    const expiresAt = billing === 'annual'
      ? new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString()
      : new Date(Date.now() + 37 * 24 * 60 * 60 * 1000).toISOString();

    await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}`, {
      method: 'PATCH',
      headers: supaHeaders,
      body: JSON.stringify({ plan_expires_at: expiresAt, updated_at: new Date().toISOString() })
    });

    console.log(`🔄 Renewal: ${subs[0].email} → expires ${expiresAt.split('T')[0]}`);

    // Pioneiros: incrementa meses_ativos
    try {
      const indR = await fetch(`${SUPABASE_URL}/rest/v1/pioneiros_indicacoes?stripe_subscription_id=eq.${subscriptionId}&select=id,meses_ativos,cancelado&limit=1`, { headers: supaHeaders });
      const [ind] = indR.ok ? await indR.json() : [];
      if (ind && !ind.cancelado) {
        await fetch(`${SUPABASE_URL}/rest/v1/pioneiros_indicacoes?id=eq.${ind.id}`, {
          method: 'PATCH',
          headers: supaHeaders,
          body: JSON.stringify({
            meses_ativos: (ind.meses_ativos || 0) + 1,
            ultima_cobranca_em: new Date().toISOString(),
          }),
        });
        console.log(`🏆 Pioneiros: indicação ${ind.id} cresceu pra ${(ind.meses_ativos || 0) + 1} mes(es)`);
      }
    } catch (e) { console.error('Pioneiros renewal tracking error:', e.message); }

    // Comissao recorrente afiliado
    const SITE_URL_R = process.env.SITE_URL || 'https://bluetubeviral.com';
    const renewEmail = subs[0].email;
    const renewPlan = subs[0].plan;
    // Valor REALMENTE pago nesta renovacao (ja com cupom/desconto aplicado, e
    // valor correto pra anual — invoice.amount_paid vem em centavos).
    const renewPaidAmount = typeof invoice.amount_paid === 'number' && invoice.amount_paid > 0
      ? parseFloat((invoice.amount_paid / 100).toFixed(2))
      : (renewPlan === 'master' ? 89.99 : 29.99);
    const renewDiscount = invoice.total_discount_amounts?.reduce((s, d) => s + (d.amount || 0), 0) || 0;
    const renewCouponApplied = renewDiscount > 0;

    fetch(`${SITE_URL_R}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'renewal', email: renewEmail, plan: renewPlan })
    }).then(async () => {
      try {
        const subRef = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(renewEmail)}&select=affiliate_ref`, { headers: supaHeaders });
        const refData = subRef.ok ? await subRef.json() : [];
        const refCode = refData?.[0]?.affiliate_ref;
        if (!refCode) return;
        const affRes = await fetch(`${SUPABASE_URL}/rest/v1/affiliates?ref_code=eq.${refCode}&select=id,comissao_percentual,nivel,level,email,total_earnings,total_earnings_by_currency`, { headers: supaHeaders });
        const aff = affRes.ok ? (await affRes.json())?.[0] : null;
        if (!aff) return;
        const { rate, levelKey, source: rateSource } = effectiveRate(aff);
        const renewCouponDiscount = renewDiscount ? parseFloat((renewDiscount / 100).toFixed(2)) : 0;
        const result = await applyCommissionCorrection({
          affiliate: aff, email: renewEmail, plan: renewPlan, rate,
          paidAmount: renewPaidAmount,
          couponApplied: renewCouponApplied,
          couponDiscount: renewCouponDiscount,
          source: 'renewal',
          stripeCustomerId: customerId,
          currency: invoice.currency,
        });
        if (result.ok) {
          const flagTag = result.flagged ? ' 🚨 FLAGGED' : '';
          console.log(`🔄 Renewal commission corrected [${rateSource}]${flagTag}: ${levelKey} ${(rate*100).toFixed(0)}% × R$${renewPaidAmount}${renewCouponApplied?' (com cupom)':''} = R$${result.correctedAmount} (delta R$${result.delta})`);
        } else {
          console.log(`⏳ Renewal commission queued for retry: ${aff.email} ← ${renewEmail}`);
        }
      } catch(e) { console.error('Renewal commission correction error:', e.message); }
    }).catch(() => {});
    return;
  }

  // ── FALHA DE PAGAMENTO ───────────────────────────────────────────────────
  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const customerId = invoice.customer;
    const attemptCount = invoice.attempt_count;

    const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}&select=email,plan`, { headers: supaHeaders });
    const subs = await subRes.json();
    const email = subs?.[0]?.email || 'desconhecido';

    console.log(`⚠️ Payment failed: ${email} — tentativa ${attemptCount}/3`);

    notifyStripe(`⚠️ Pagamento falhou — ${email}`, [
      ['Cliente', email],
      ['Plano', subs?.[0]?.plan?.toUpperCase() || '—'],
      ['Tentativa', `${attemptCount}/3`],
      ['Status', attemptCount >= 3 ? '🔴 Downgrade automático' : '🟡 Aguardando retry'],
      ['Stripe ID', customerId || '—'],
    ]).catch(() => {});

    if (attemptCount >= 3) {
      await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}`, {
        method: 'PATCH',
        headers: supaHeaders,
        body: JSON.stringify({ plan: 'free', plan_expires_at: null, updated_at: new Date().toISOString() })
      });
      console.log(`⬇️ Downgrade por falha de pagamento: ${email}`);
    }
    return;
  }

  // ── REEMBOLSO ────────────────────────────────────────────────────────────
  // Quando o Stripe reembolsa um charge:
  //   1. (Fase B1) Cancela a sub Stripe se ainda active — previne "refund antes
  //      de cancelar" virar zumbi pagante (caso joao21xx 2026-04-30).
  //   2. Reverte a comissao mais recente do afiliado desse assinante.
  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    const customerId = charge.customer;
    const refundedCents = charge.amount_refunded || 0;
    if (!customerId || refundedCents <= 0) return;

    try {
      const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}&select=email,plan,affiliate_ref,stripe_subscription_id`, { headers: supaHeaders });
      const [sub] = subRes.ok ? await subRes.json() : [];

      // ── Fase B1 — Auto-cancel sub Stripe apos refund ──────────────────────
      // Independe de afiliado. Roda mesmo pra subs sem ref_code.
      const STRIPE_SECRET_B1 = process.env.STRIPE_SECRET_KEY;
      if (sub?.stripe_subscription_id && STRIPE_SECRET_B1) {
        try {
          const ssR = await fetch(`https://api.stripe.com/v1/subscriptions/${sub.stripe_subscription_id}`, {
            headers: { Authorization: `Bearer ${STRIPE_SECRET_B1}` }
          });
          if (ssR.ok) {
            const ssData = await ssR.json();
            if (['active', 'trialing', 'past_due'].includes(ssData.status)) {
              await fetch(`https://api.stripe.com/v1/subscriptions/${sub.stripe_subscription_id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${STRIPE_SECRET_B1}` }
              });
              await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}`, {
                method: 'PATCH', headers: supaHeaders,
                body: JSON.stringify({
                  plan: 'free',
                  stripe_subscription_id: null,
                  plan_expires_at: null,
                  updated_at: new Date().toISOString()
                })
              });
              console.log(`🛡️ [B1] Sub ${sub.stripe_subscription_id} cancelada apos refund (${sub.email})`);
              notifyStripe(`🛡️ Auto-cancel apos refund — ${sub.email}`, [
                ['Cliente', sub.email],
                ['Sub cancelada', sub.stripe_subscription_id],
                ['Charge', charge.id],
                ['Motivo', 'charge.refunded com sub ainda active (auto-blindagem)'],
              ]).catch(() => {});
            }
          }
        } catch (e) { console.error('[B1 auto-cancel] erro:', e.message); }
      }

      if (!sub?.email || !sub.affiliate_ref) {
        console.log(`[refund] skip comissao — sem afiliado vinculado a ${customerId}`);
        return;
      }

      const affRes = await fetch(`${SUPABASE_URL}/rest/v1/affiliates?ref_code=eq.${sub.affiliate_ref}&select=id,email,total_earnings,total_earnings_by_currency`, { headers: supaHeaders });
      const [aff] = affRes.ok ? await affRes.json() : [];
      if (!aff) return;

      // Pega comissao mais recente pending/paid pra esse assinante
      const cmRes = await fetch(`${SUPABASE_URL}/rest/v1/affiliate_commissions?affiliate_id=eq.${aff.id}&subscriber_email=eq.${encodeURIComponent(sub.email)}&status=in.(pending,paid)&order=created_at.desc&limit=1&select=id,commission_amount,commission_history,status,currency`, { headers: supaHeaders });
      const [row] = cmRes.ok ? await cmRes.json() : [];
      if (!row) {
        console.log(`[refund] nenhuma comissao ativa pra reverter: ${sub.email}`);
        return;
      }

      const amount = parseFloat(row.commission_amount || 0);
      const history = Array.isArray(row.commission_history) ? row.commission_history : [];
      history.push({
        at: new Date().toISOString(), source: 'refund',
        prev_status: row.status, new_status: 'refunded',
        prev_amount: amount, new_amount: 0,
        refund_amount_cents: refundedCents,
        stripe_charge_id: charge.id,
      });

      await fetch(`${SUPABASE_URL}/rest/v1/affiliate_commissions?id=eq.${row.id}`, {
        method: 'PATCH', headers: supaHeaders,
        body: JSON.stringify({
          status: 'refunded',
          refunded_at: new Date().toISOString(),
          commission_history: history,
        })
      });

      // Sprint 1.5 multi-currency: decrementa bucket da moeda real em
      // total_earnings_by_currency. total_earnings (numeric BRL) so e atualizado
      // quando refundCur==='BRL' pra preservar compat com codigo legado.
      if (amount > 0) {
        const refundCur = String(row.currency || 'BRL').toUpperCase();
        const currentTeBC = (aff.total_earnings_by_currency && typeof aff.total_earnings_by_currency === 'object')
          ? aff.total_earnings_by_currency : { BRL: 0 };
        const newTeBC = { ...currentTeBC };
        newTeBC[refundCur] = Math.max(0, parseFloat(((parseFloat(newTeBC[refundCur] || 0) - amount)).toFixed(2)));
        const patchAffBody = {
          total_earnings_by_currency: newTeBC,
          updated_at: new Date().toISOString()
        };
        if (refundCur === 'BRL') {
          patchAffBody.total_earnings = parseFloat(Math.max(0, (parseFloat(aff.total_earnings) || 0) - amount).toFixed(2));
        }
        await fetch(`${SUPABASE_URL}/rest/v1/affiliates?id=eq.${aff.id}`, {
          method: 'PATCH', headers: supaHeaders,
          body: JSON.stringify(patchAffBody)
        });
      }

      console.log(`↩️  Refund: comissao ${row.id} (${aff.email} ← ${sub.email}) marcada refunded, -R$${amount}`);
      notifyStripe(`↩️ Reembolso processado — comissao revertida`, [
        ['Cliente', sub.email],
        ['Afiliado', aff.email],
        ['Comissao revertida', `R$${amount.toFixed(2)}`],
        ['Charge', charge.id],
      ]).catch(() => {});
    } catch(e) { console.error('[refund handler] erro:', e.message); }
    return;
  }

  // ── CANCELAMENTO ─────────────────────────────────────────────────────────
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const customerId = sub.customer;

    const periodEnd = sub.current_period_end
      ? new Date(sub.current_period_end * 1000)
      : new Date();
    const now = new Date();
    const expiresAt = periodEnd > now ? periodEnd : now;

    const subRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}&select=email,plan`,
      { headers: supaHeaders }
    );
    const subs = await subRes.json();
    const cancelledEmail = subs?.[0]?.email;
    const currentPlan = subs?.[0]?.plan || 'free';

    const stillActive = periodEnd > now;
    await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}`, {
      method: 'PATCH',
      headers: supaHeaders,
      body: JSON.stringify({
        plan: stillActive ? currentPlan : 'free',
        plan_expires_at: stillActive ? expiresAt.toISOString() : null,
        cancel_at_period_end: false,
        updated_at: now.toISOString()
      })
    });

    console.log(`⬇️ Subscription cancelled: ${cancelledEmail || customerId} | Active until: ${expiresAt.toISOString()} | Still active: ${stillActive}`);

    try {
      await fetch(`${SUPABASE_URL}/rest/v1/pioneiros_indicacoes?stripe_subscription_id=eq.${sub.id}`, {
        method: 'PATCH',
        headers: supaHeaders,
        body: JSON.stringify({ cancelado: true, qualificado: false }),
      });
    } catch(e) { console.error('Pioneiros cancel tracking:', e.message); }

    notifyStripe(`😢 Cancelamento — ${currentPlan.toUpperCase()} — ${cancelledEmail || customerId}`, [
      ['Cliente', cancelledEmail || customerId],
      ['Plano cancelado', `${currentPlan === 'master' ? '👑' : '⚡'} ${currentPlan.toUpperCase()}`],
      ['Acesso até', stillActive ? expiresAt.toLocaleDateString('pt-BR') : 'Imediato'],
      ['Status', stillActive ? '🟡 Ativo até fim do período' : '🔴 Rebaixado para Free'],
    ]).catch(() => {});

    if (cancelledEmail && !stillActive) {
      const SITE_URL_C = process.env.SITE_URL || 'https://bluetubeviral.com';
      // Migrado de /api/auth pra /api/affiliate em 2026-04-23 pra destravar Bug 2 fix
      // (reversao de commission paga). auth.js:2252 virou dead code.
      fetch(`${SITE_URL_C}/api/affiliate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', email: cancelledEmail })
      }).catch(() => {});
    }
    return;
  }

  // ── CANCELAMENTO AGENDADO ────────────────────────────────────────────────
  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    if (sub.cancel_at_period_end === true) {
      const customerId = sub.customer;
      const periodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000)
        : null;

      if (periodEnd) {
        const subRes = await fetch(
          `${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}&select=email,plan`,
          { headers: supaHeaders }
        );
        const subs = await subRes.json();
        const email = subs?.[0]?.email;
        const currentPlan = subs?.[0]?.plan;

        if (email && currentPlan && currentPlan !== 'free') {
          await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}`, {
            method: 'PATCH',
            headers: supaHeaders,
            body: JSON.stringify({
              plan_expires_at: periodEnd.toISOString(),
              cancel_at_period_end: true,
              updated_at: new Date().toISOString()
            })
          });
          console.log(`📅 Cancel scheduled: ${email} — expires ${periodEnd.toISOString()}`);

          notifyStripe(`🔄 Cancelamento agendado — ${currentPlan.toUpperCase()} — ${email}`, [
            ['Cliente', email],
            ['Plano', `${currentPlan === 'master' ? '👑' : '⚡'} ${currentPlan.toUpperCase()}`],
            ['Acesso até', periodEnd.toLocaleDateString('pt-BR')],
            ['Status', '📅 Cancelamento agendado — acesso mantido até fim do período'],
          ]).catch(() => {});
        }
      }
    }
    return;
  }

  // Evento nao tratado — so loga, nao falha
  console.log(`[webhook] evento nao tratado: ${event.type}`);
}

// sendUpgradeEmail extraído para api/_helpers/upgradeEmail.js
