// api/create-checkout.js
// Creates a Stripe checkout session — supports monthly and annual billing.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { plan, billing } = req.body;
  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  const SITE_URL = process.env.SITE_URL || 'https://bluetube-ten.vercel.app';

  if (!STRIPE_SECRET) return res.status(500).json({ error: 'Stripe não configurado' });

  const isAnnual = billing === 'annual';

  const PLANS = {
    full: {
      name: 'BlueTube Full',
      description: '9 roteiros/dia · Todos os idiomas · Comunidade exclusiva',
      monthly: 999,   // $9.99
      annual: 8999,   // $89.99/year = $7.49/month
    },
    master: {
      name: 'BlueTube Master',
      description: 'Roteiros ilimitados · Chat IA · Voz realista · Download HD',
      monthly: 2999,  // $29.99
      annual: 23988,  // $239.88/year = $19.99/month
    }
  };

  const selectedPlan = PLANS[plan];
  if (!selectedPlan) return res.status(400).json({ error: 'Plano inválido' });

  const amount = isAnnual ? selectedPlan.annual : selectedPlan.monthly;
  const interval = isAnnual ? 'year' : 'month';
  const planLabel = isAnnual ? `${selectedPlan.name} — Anual` : selectedPlan.name;

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'mode': 'subscription',
        'payment_method_types[]': 'card',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': planLabel,
        'line_items[0][price_data][product_data][description]': selectedPlan.description,
        'line_items[0][price_data][recurring][interval]': interval,
        'line_items[0][price_data][unit_amount]': amount,
        'line_items[0][quantity]': '1',
        'success_url': `${SITE_URL}?payment=success&plan=${plan}`,
        'cancel_url': `${SITE_URL}?payment=cancelled`,
        'metadata[plan]': plan,
        'metadata[billing]': billing || 'monthly'
      })
    });

    const session = await r.json();
    if (!r.ok) {
      console.error('Stripe error:', JSON.stringify(session.error));
      return res.status(400).json({ error: session.error?.message || 'Erro no Stripe' });
    }

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: 'Falha ao criar sessão de pagamento' });
  }
}
