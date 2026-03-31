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
    // Simple HMAC verification without stripe SDK
    const crypto = await import('crypto');
    const [, timestamp] = sig.split('t=');
    const ts = timestamp?.split(',')[0];
    const payload = `${ts}.${rawBody.toString()}`;
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
      .update(payload).digest('hex');
    const received = sig.split('v1=')[1]?.split(',')[0];
    if (expected !== received) throw new Error('Invalid signature');
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

      const r = await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
        method: 'POST',
        headers: { ...supaHeaders, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({
          email,
          plan,
          is_manual: false,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          plan_expires_at: expiresAt,
          created_at: new Date().toISOString(), // garante created_at no upsert
          updated_at: new Date().toISOString()
        })
      });

      if (!r.ok) {
        const err = await r.text();
        console.error('❌ Supabase upsert error:', err);
        return res.status(500).json({ error: 'DB update failed' });
      }

      console.log(`✅ Plan activated: ${email} → ${plan} (${billing})`);

      // Notifica sistema de afiliados — conversão paga
      const SITE_URL = process.env.SITE_URL || 'https://bluetubeviral.com';
      fetch(`${SITE_URL}/api/affiliate`, {
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
      fetch(`${SITE_URL_R}/api/affiliate`, {
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

    // ── CANCELAMENTO → Downgrade para free ───────────────────────────────────
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = sub.customer;

      const r = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}`, {
        method: 'PATCH',
        headers: supaHeaders,
        body: JSON.stringify({ plan: 'free', plan_expires_at: null, updated_at: new Date().toISOString() })
      });

      const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}&select=email`, { headers: supaHeaders });
      const subs = await subRes.json();
      const cancelledEmail = subs?.[0]?.email;
      console.log(`⬇️ Subscription cancelled: ${cancelledEmail || customerId}`);

      // Cancela comissões do afiliado
      if (cancelledEmail) {
        const SITE_URL_C = process.env.SITE_URL || 'https://bluetubeviral.com';
        fetch(`${SITE_URL_C}/api/affiliate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cancel', email: cancelledEmail })
        }).catch(() => {});
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    // Retorna 200 para o Stripe não ficar tentando reenviar
    return res.status(200).json({ received: true, warning: err.message });
  }
}
