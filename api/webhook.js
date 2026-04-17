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
    const rows = await H.supaFetch(
      `/stripe_webhook_log?status=eq.erro&tentativas=lt.5&select=id,stripe_event_id,tipo,payload,tentativas&order=created_at.asc&limit=50`
    );

    let reprocessados = 0, sucesso = 0, falhou = 0;
    for (const row of rows) {
      reprocessados++;
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

    return res.status(200).json({ ok: true, reprocessados, sucesso, falhou });
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

    const patchR = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        plan,
        is_manual: false,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        plan_expires_at: expiresAt,
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

    notifyStripe(`💰 Nova assinatura — ${plan.toUpperCase()} — ${email}`, [
      ['Cliente', email],
      ['Plano', `${plan === 'master' ? '👑' : '⚡'} ${plan.toUpperCase()}`],
      ['Valor', _prices[plan] || 'N/A'],
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
        const subRef = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=affiliate_ref`, { headers: supaHeaders });
        const refData = subRef.ok ? await subRef.json() : [];
        const refCode = refData?.[0]?.affiliate_ref;
        if (!refCode) return;
        const affRes = await fetch(`${SUPABASE_URL}/rest/v1/affiliates?ref_code=eq.${refCode}&select=id,comissao_percentual,nivel,email`, { headers: supaHeaders });
        const aff = affRes.ok ? (await affRes.json())?.[0] : null;
        if (!aff?.comissao_percentual) return;
        const rate = aff.comissao_percentual / 100;
        const planAmount = plan === 'master' ? 89.99 : 29.99;
        const correctedAmount = parseFloat((planAmount * rate).toFixed(2));
        await fetch(`${SUPABASE_URL}/rest/v1/affiliate_commissions?affiliate_id=eq.${aff.id}&subscriber_email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`, {
          method: 'PATCH',
          headers: supaHeaders,
          body: JSON.stringify({ commission_rate: rate, commission_amount: correctedAmount })
        });
        console.log(`💰 Commission corrected: ${aff.email} nivel=${aff.nivel} ${(rate*100).toFixed(0)}% = R$${correctedAmount} (${email})`);
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
        const affRes = await fetch(`${SUPABASE_URL}/rest/v1/affiliates?ref_code=eq.${refCode}&select=id,comissao_percentual,nivel`, { headers: supaHeaders });
        const aff = affRes.ok ? (await affRes.json())?.[0] : null;
        if (!aff?.comissao_percentual) return;
        const rate = aff.comissao_percentual / 100;
        const planAmount = renewPlan === 'master' ? 89.99 : 29.99;
        const correctedAmount = parseFloat((planAmount * rate).toFixed(2));
        await fetch(`${SUPABASE_URL}/rest/v1/affiliate_commissions?affiliate_id=eq.${aff.id}&subscriber_email=eq.${encodeURIComponent(renewEmail)}&order=created_at.desc&limit=1`, {
          method: 'PATCH',
          headers: supaHeaders,
          body: JSON.stringify({ commission_rate: rate, commission_amount: correctedAmount })
        });
        console.log(`🔄 Renewal commission corrected: nivel=${aff.nivel} ${(rate*100).toFixed(0)}% = R$${correctedAmount}`);
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
      fetch(`${SITE_URL_C}/api/auth`, {
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
