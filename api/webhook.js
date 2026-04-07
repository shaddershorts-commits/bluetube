// api/webhook.js
// Listens to Stripe webhook events and updates subscriber plans in Supabase.
// Must be set up in Stripe Dashboard → Webhooks → Add endpoint

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
  if (req.method !== 'POST') return res.status(405).end();

  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  // Verify webhook signature
  let event;
  try {
    // HMAC verification — formato Stripe: t=timestamp,v1=signature
    const crypto = await import('crypto');
    // Extrai timestamp e assinatura do header
    const parts = {};
    sig.split(',').forEach(part => {
      const [k, v] = part.split('=');
      parts[k.trim()] = v?.trim();
    });
    const ts = parts['t'];
    const received = parts['v1'];
    if (!ts || !received) throw new Error('Malformed signature header');
    const payload = `${ts}.${rawBody.toString()}`;
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
      .update(payload, 'utf8').digest('hex');
    // Comparação segura contra timing attacks
    if (expected.length !== received.length || 
        !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
      throw new Error('Invalid signature');
    }
    event = JSON.parse(rawBody.toString());
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

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

  try {

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
        return res.status(200).json({ received: true });
      }

      const expiresAt = billing === 'annual'
        ? new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString()
        : new Date(Date.now() + 37 * 24 * 60 * 60 * 1000).toISOString(); // +5 dias de margem

      // Tenta PATCH primeiro (atualiza se existe), depois POST (cria se não existe)
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
        // PATCH funcionou — subscriber existia
        r = patchR;
        console.log(`✅ Plan updated via PATCH: ${email} → ${plan}`);
      } else {
        // Subscriber não existe — cria
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
        console.error('❌ Supabase upsert error:', err);
        return res.status(500).json({ error: 'DB update failed' });
      }

      console.log(`✅ Plan activated: ${email} → ${plan} (${billing})`);

      // Email para admin
      notifyStripe(`💰 Nova assinatura — ${plan.toUpperCase()} — ${email}`, [
        ['Cliente', email],
        ['Plano', `${plan === 'master' ? '👑' : '⚡'} ${plan.toUpperCase()}`],
        ['Valor', _prices[plan] || 'N/A'],
        ['Billing', billing === 'annual' ? 'Anual' : 'Mensal'],
        ['Stripe ID', customerId || '—'],
      ]).catch(() => {});

      // Notifica sistema de afiliados — conversão paga
      const SITE_URL = process.env.SITE_URL || 'https://bluetubeviral.com';
      fetch(`${SITE_URL}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'conversion', email, plan, stripe_customer_id: customerId, conversion_type: `upgrade_${plan}` })
      }).catch(() => {});
    }

    // ── RENOVAÇÃO → Atualiza plan_expires_at ─────────────────────────────────
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const subscriptionId = invoice.subscription;
      if (!subscriptionId) return res.status(200).json({ received: true });

      // Busca email pelo customer_id
      const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}&select=email,plan`, {
        headers: supaHeaders
      });
      const subs = await subRes.json();
      if (!subs?.length) return res.status(200).json({ received: true });

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

      // Comissão recorrente do afiliado
      const SITE_URL_R = process.env.SITE_URL || 'https://bluetubeviral.com';
      fetch(`${SITE_URL_R}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'renewal', email: subs[0].email, plan: subs[0].plan })
      }).catch(() => {});
    }

    // ── FALHA DE PAGAMENTO → Loga para acompanhar ────────────────────────────
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const attemptCount = invoice.attempt_count;

      const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}&select=email,plan`, {
        headers: supaHeaders
      });
      const subs = await subRes.json();
      const email = subs?.[0]?.email || 'desconhecido';

      // Após 3 tentativas falhas o Stripe cancela automaticamente
      // Loga para visibilidade no admin
      console.log(`⚠️ Payment failed: ${email} — tentativa ${attemptCount}/3`);

      notifyStripe(`⚠️ Pagamento falhou — ${email}`, [
        ['Cliente', email],
        ['Plano', subs?.[0]?.plan?.toUpperCase() || '—'],
        ['Tentativa', `${attemptCount}/3`],
        ['Status', attemptCount >= 3 ? '🔴 Downgrade automático' : '🟡 Aguardando retry'],
        ['Stripe ID', customerId || '—'],
      ]).catch(() => {});

      // Na 3ª falha, faz downgrade preventivo
      if (attemptCount >= 3) {
        await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}`, {
          method: 'PATCH',
          headers: supaHeaders,
          body: JSON.stringify({ plan: 'free', plan_expires_at: null, updated_at: new Date().toISOString() })
        });
        console.log(`⬇️ Downgrade por falha de pagamento: ${email}`);
      }
    }

    // ── CANCELAMENTO ─────────────────────────────────────────────────────────
    // customer.subscription.deleted = período atual expirou E cancelamento efetivado
    // Usa current_period_end para manter acesso até o final do período pago
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = sub.customer;

      // current_period_end = timestamp Unix de quando o período pago termina
      // Se já passou → rebaixa agora. Se ainda não passou → agenda expiração
      const periodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000)
        : new Date();
      const now = new Date();
      const expiresAt = periodEnd > now ? periodEnd : now;

      // Mantém o plano atual mas define expiração = fim do período pago
      // get-plan.js já respeita plan_expires_at para decidir se é premium
      const subRes = await fetch(
        `${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}&select=email,plan`,
        { headers: supaHeaders }
      );
      const subs = await subRes.json();
      const cancelledEmail = subs?.[0]?.email;
      const currentPlan = subs?.[0]?.plan || 'free';

      // Se o período ainda não acabou, mantém o plano com data de expiração
      // Se já acabou, rebaixa para free imediatamente
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

      notifyStripe(`😢 Cancelamento — ${currentPlan.toUpperCase()} — ${cancelledEmail || customerId}`, [
        ['Cliente', cancelledEmail || customerId],
        ['Plano cancelado', `${currentPlan === 'master' ? '👑' : '⚡'} ${currentPlan.toUpperCase()}`],
        ['Acesso até', stillActive ? expiresAt.toLocaleDateString('pt-BR') : 'Imediato'],
        ['Status', stillActive ? '🟡 Ativo até fim do período' : '🔴 Rebaixado para Free'],
      ]).catch(() => {});

      // Cancela comissões do afiliado (apenas quando rebaixar de verdade)
      if (cancelledEmail && !stillActive) {
        const SITE_URL_C = process.env.SITE_URL || 'https://bluetubeviral.com';
        fetch(`${SITE_URL_C}/api/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cancel', email: cancelledEmail })
        }).catch(() => {});
      }
    }

    // ── ASSINATURA AGENDADA PARA CANCELAR (usuario pediu cancelamento mas período ativo) ──
    // customer.subscription.updated com cancel_at_period_end = true
    // Aproveitamos para registrar a data de expiração já no momento do pedido
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
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    // Retorna 200 para o Stripe não ficar tentando reenviar
    return res.status(200).json({ received: true, warning: err.message });
  }
}
