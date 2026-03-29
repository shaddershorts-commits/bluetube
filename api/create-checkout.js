// api/create-checkout.js
// Creates a Stripe checkout session for Full or Master plan subscriptions.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { plan } = req.body;
  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  const SITE_URL = process.env.SITE_URL || 'https://bluetube-ten.vercel.app';

  if (!STRIPE_SECRET) return res.status(500).json({ error: 'Stripe not configured' });

  const PLANS = {
    full: {
      name: 'BlueTube Full',
      amount: 999, // $9.99 in cents
      description: '9 roteiros/dia · Todos os idiomas · Comunidade exclusiva'
    },
    master: {
      name: 'BlueTube Master',
      amount: 2999, // $29.99 in cents
      description: 'Roteiros ilimitados · Chat IA · Voz realista · Download HD'
    }
  };

  const selectedPlan = PLANS[plan];
  if (!selectedPlan) return res.status(400).json({ error: 'Invalid plan' });

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
        'line_items[0][price_data][product_data][name]': selectedPlan.name,
        'line_items[0][price_data][product_data][description]': selectedPlan.description,
        'line_items[0][price_data][recurring][interval]': 'month',
        'line_items[0][price_data][unit_amount]': selectedPlan.amount,
        'line_items[0][quantity]': '1',
        'success_url': `${SITE_URL}?payment=success&plan=${plan}`,
        'cancel_url': `${SITE_URL}?payment=cancelled`,
        'metadata[plan]': plan
      })
    });

    const session = await r.json();
    if (!r.ok) return res.status(400).json({ error: session.error?.message || 'Stripe error' });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}
