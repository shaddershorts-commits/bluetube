// api/create-checkout.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { plan, billing, token } = req.body;
  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  const SITE_URL      = process.env.SITE_URL || 'https://bluetubeviral.com';
  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const ANON_KEY      = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!STRIPE_SECRET) return res.status(500).json({ error: 'Stripe não configurado' });

  // Price IDs em BRL criados no Stripe
  const PRICE_IDS = {
    full:   { monthly: 'price_1THCi8Le4wOQftBwte1IEHgQ' }, // R$59,90/mês
    master: { monthly: 'price_1THCieLe4wOQftBwobBK9qUU' }, // R$179,90/mês
  };

  const isAnnual = billing === 'annual';
  const billingType = isAnnual ? 'annual' : 'monthly';
  const priceId = PRICE_IDS[plan]?.[billingType] || PRICE_IDS[plan]?.monthly;
  if (!priceId) return res.status(400).json({ error: 'Plano inválido' });

  // Busca email do usuário para pré-preencher o checkout
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
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'success_url': `${SITE_URL}?payment=success&plan=${plan}`,
      'cancel_url':  `${SITE_URL}?payment=cancelled`,
      'allow_promotion_codes': 'true',
      'metadata[plan]': plan,
      'metadata[billing]': billingType,
    });

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
      console.error('Stripe error:', session.error);
      return res.status(400).json({ error: session.error?.message || 'Erro no Stripe' });
    }

    return res.status(200).json({ url: session.url });
  } catch(err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: 'Falha ao criar sessão de pagamento' });
  }
}
