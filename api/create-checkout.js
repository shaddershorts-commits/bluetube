// api/create-checkout.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { plan, billing, token, ref } = req.body;
  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  const SITE_URL      = process.env.SITE_URL || 'https://bluetubeviral.com';
  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const ANON_KEY      = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!STRIPE_SECRET) return res.status(500).json({ error: 'Stripe não configurado' });

  const isAnnual = billing === 'annual';

  // Preços em centavos de BRL
  const PLANS = {
    full: {
      name: 'BlueTube Full',
      description: '9 roteiros/dia · Todos os idiomas · Comunidade exclusiva',
      monthly: 2999,   // R$29,99
      annual:  26988,  // R$269,88/ano (R$22,49/mês — 25% desconto)
    },
    master: {
      name: 'BlueTube Master',
      description: 'Roteiros ilimitados · Voz IA · Download HD · Buscador viral',
      monthly: 8999,   // R$89,99
      annual:  80988,  // R$809,88/ano (R$67,49/mês — 25% desconto)
    }
  };

  const selectedPlan = PLANS[plan];
  if (!selectedPlan) return res.status(400).json({ error: 'Plano inválido' });

  const amount   = isAnnual ? selectedPlan.annual : selectedPlan.monthly;
  const interval = isAnnual ? 'year' : 'month';
  const label    = isAnnual ? `${selectedPlan.name} — Anual` : selectedPlan.name;

  // Busca email do usuário
  let customerEmail = null;
  if (token && SUPABASE_URL) {
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` }
      });
      if (r.ok) customerEmail = (await r.json()).email || null;
    } catch(e) {}
  }

  try {
    const params = new URLSearchParams({
      'mode': 'subscription',
      'payment_method_types[]': 'card',
      'line_items[0][price_data][currency]': 'brl',
      'line_items[0][price_data][product_data][name]': label,
      'line_items[0][price_data][product_data][description]': selectedPlan.description,
      'line_items[0][price_data][recurring][interval]': interval,
      'line_items[0][price_data][unit_amount]': String(amount),
      'line_items[0][quantity]': '1',
      'success_url': `${SITE_URL}?payment=success&plan=${plan}`,
      'cancel_url':  `${SITE_URL}?payment=cancelled`,
      'allow_promotion_codes': 'true',
      'metadata[plan]': plan,
      'metadata[billing]': billing || 'monthly',
    });
    // Programa Pioneiros: propaga ref do criador indicador pro webhook
    if (ref && /^[a-z0-9_-]{4,32}$/i.test(ref)) {
      params.set('metadata[ref]', ref);
      params.set('client_reference_id', ref);
    }

    if (customerEmail) params.set('customer_email', customerEmail);

    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });

    const session = await r.json();
    if (!r.ok) {
      console.error('Stripe error:', JSON.stringify(session.error));
      return res.status(400).json({ error: session.error?.message || 'Erro no Stripe' });
    }

    return res.status(200).json({ url: session.url });
  } catch(err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: 'Falha ao criar sessão de pagamento' });
  }
}
