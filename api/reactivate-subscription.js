// api/reactivate-subscription.js
// Reverte cancel_at_period_end na assinatura Stripe — usuario que cancelou
// e mudou de ideia volta a ser cobrado normalmente no proximo ciclo.
// Espelha cancel-subscription.js no formato.

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

    // 2. Busca subscriber
    const subRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=stripe_subscription_id,plan,is_manual,cancel_at_period_end,plan_expires_at`,
      { headers: supaHeaders }
    );
    if (!subRes.ok) return res.status(500).json({ error: 'Failed to lookup subscriber' });
    const subs = await subRes.json();
    const sub = subs?.[0];

    if (!sub || !sub.stripe_subscription_id) {
      return res.status(400).json({ error: 'Nenhuma assinatura Stripe pra reativar' });
    }
    if (sub.cancel_at_period_end !== true) {
      return res.status(400).json({
        error: 'Sua assinatura ja esta ativa — nao foi cancelada.',
        already_active: true
      });
    }

    // 3. Reverte cancel_at_period_end na Stripe
    const stripeRes = await fetch(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(sub.stripe_subscription_id)}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${STRIPE_SECRET}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'cancel_at_period_end=false'
      }
    );
    const stripeData = await stripeRes.json();

    if (!stripeRes.ok) {
      console.error('[reactivate-subscription] Stripe error:', stripeData.error);
      // Subscription nao existe mais (passou da data) — informa user
      if (stripeData.error?.code === 'resource_missing') {
        return res.status(400).json({
          error: 'Sua assinatura ja foi encerrada. Assine novamente pra voltar.',
          subscription_missing: true
        });
      }
      return res.status(502).json({
        error: 'Falha ao reativar no Stripe: ' + (stripeData.error?.message || 'unknown')
      });
    }

    // 4. Atualiza Supabase
    await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: { ...supaHeaders, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          cancel_at_period_end: false,
          updated_at: new Date().toISOString()
        })
      }
    );

    console.log(`[reactivate] ${email} — Stripe sub ${sub.stripe_subscription_id} reativada`);

    return res.status(200).json({
      success: true,
      email,
      plan: sub.plan,
      message: 'Assinatura reativada. Cobranca volta a acontecer normalmente no proximo ciclo.'
    });
  } catch (err) {
    console.error('[reactivate-subscription] error:', err);
    return res.status(500).json({ error: 'Failed to reactivate subscription' });
  }
}
