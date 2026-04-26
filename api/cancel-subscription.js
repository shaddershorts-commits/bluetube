// api/cancel-subscription.js
// Usuario cancela a propria assinatura. Chamamos a API do Stripe com
// cancel_at_period_end=true — assinatura para de cobrar no proximo ciclo,
// mas o usuario mantem acesso ate o fim do periodo pago. O webhook
// customer.subscription.updated depois atualiza o plan_expires_at final.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.body;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ANON_KEY = process.env.SUPABASE_ANON_KEY || SUPABASE_KEY;
  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;

  if (!token) return res.status(401).json({ error: 'Token required' });
  if (!STRIPE_SECRET) return res.status(500).json({ error: 'Stripe nao configurado' });

  try {
    // 1. Valida usuario
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Invalid token' });
    const user = await userRes.json();
    const email = user.email;
    if (!email) return res.status(401).json({ error: 'Could not identify user' });

    const supaHeaders = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    };

    // 2. Busca assinatura do usuario no Supabase
    const subRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=stripe_subscription_id,stripe_customer_id,plan,is_manual,plan_expires_at`,
      { headers: supaHeaders }
    );
    if (!subRes.ok) return res.status(500).json({ error: 'Failed to lookup subscriber' });
    const subs = await subRes.json();
    const sub = subs?.[0];

    // Plano manual (admin deu de graca), ja free, ou sem subscription Stripe:
    // so rebaixa no Supabase mesmo — nao ha assinatura na Stripe pra cancelar
    const noStripeSub = !sub || sub.plan === 'free' || sub.is_manual || !sub.stripe_subscription_id;
    if (noStripeSub) {
      await fetch(
        `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: { ...supaHeaders, 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            plan: 'free',
            plan_expires_at: null,
            cancel_at_period_end: false,
            updated_at: new Date().toISOString()
          })
        }
      );
      return res.status(200).json({
        success: true,
        email,
        plan: 'free',
        stripe_cancelled: false,
        reason: sub?.is_manual ? 'plano_manual' : 'sem_assinatura_stripe'
      });
    }

    // 3. Cancela agendado na Stripe — cobranca para no proximo ciclo,
    //    acesso mantido ate fim do periodo pago
    const stripeRes = await fetch(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(sub.stripe_subscription_id)}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${STRIPE_SECRET}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'cancel_at_period_end=true'
      }
    );
    const stripeData = await stripeRes.json();

    if (!stripeRes.ok) {
      console.error('[cancel-subscription] Stripe error:', stripeData.error);
      // Se a subscription nao existe mais na Stripe (ja cancelada/ausente),
      // rebaixa no Supabase imediatamente — senao ficaria em limbo
      if (stripeData.error?.code === 'resource_missing') {
        await fetch(
          `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`,
          {
            method: 'PATCH',
            headers: { ...supaHeaders, 'Prefer': 'return=minimal' },
            body: JSON.stringify({
              plan: 'free',
              plan_expires_at: null,
              cancel_at_period_end: false,
              updated_at: new Date().toISOString()
            })
          }
        );
        return res.status(200).json({
          success: true,
          email,
          plan: 'free',
          stripe_cancelled: false,
          reason: 'subscription_missing_on_stripe'
        });
      }
      return res.status(502).json({
        error: 'Falha ao cancelar no Stripe: ' + (stripeData.error?.message || 'unknown')
      });
    }

    // 4. Stripe confirmou. O webhook customer.subscription.updated vai atualizar
    //    plan_expires_at depois — mas gravamos agora tambem pra UI nao esperar.
    //    plan permanece ativo ate periodEnd (get-plan.js respeita plan_expires_at).
    const periodEnd = stripeData.current_period_end
      ? new Date(stripeData.current_period_end * 1000)
      : null;

    if (periodEnd) {
      await fetch(
        `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: { ...supaHeaders, 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            plan_expires_at: periodEnd.toISOString(),
            cancel_at_period_end: true,
            updated_at: new Date().toISOString()
          })
        }
      );
    }

    console.log(`[cancel] ${email} — Stripe sub ${sub.stripe_subscription_id} agendado pra cancelar em ${periodEnd?.toISOString()}`);

    // Email de confirmacao pro usuario — evita chargeback/estorno quando o
    // cliente fecha a tela rapido sem ler a mensagem de sucesso. Fire-and-forget.
    import('./_helpers/cancellationEmail.js')
      .then((m) => m.sendCancellationEmail(email, sub.plan, periodEnd?.toISOString()))
      .catch((e) => console.error('[cancel-subscription] cancellationEmail:', e.message));

    return res.status(200).json({
      success: true,
      email,
      plan: sub.plan, // plano atual mantido ate fim do periodo
      plan_expires_at: periodEnd?.toISOString() || null,
      stripe_cancelled: true,
      message: 'Cancelamento agendado. Voce mantem acesso ate o fim do periodo pago.'
    });
  } catch (err) {
    console.error('[cancel-subscription] error:', err);
    return res.status(500).json({ error: 'Failed to cancel subscription' });
  }
}
