// api/create-checkout.js — Stripe Checkout multi-currency
//
// Aceita currency no body (brl, usd, eur, gbp, cad, aud). Default e fallback: brl.
// Usa priceIds registrados no Stripe (criados via _scripts/setup-stripe-multicurrency.js).
// Auto-switch TEST/LIVE baseado no prefixo de STRIPE_SECRET_KEY.
//
// Body esperado: { plan, billing, token?, ref?, currency?, lang? }
//   plan:     'full' | 'master'
//   billing:  'monthly' | 'annual'
//   currency: 'brl' | 'usd' | 'eur' | 'gbp' | 'cad' | 'aud'  (default brl, invalida cai pra brl)
//   lang:     'pt' | 'en'  (apenas pra mensagens de erro)
//
// metadata[currency] anexado a sessao pra webhook saber gravar comissao na moeda certa.

// PriceIds — TEST mode (sk_test_)
// Gerados em 2026-04-25 via _scripts/setup-stripe-multicurrency.js
const PRICE_IDS_TEST = {
  full: {
    monthly: {
      brl: 'price_1TQ87cLe4wOQftBwMGVajXFr',
      usd: 'price_1TQ87dLe4wOQftBwe10ZT288',
      eur: 'price_1TQ87dLe4wOQftBwrteYlOY1',
      gbp: 'price_1TQ87eLe4wOQftBwhY3ds5J6',
      cad: 'price_1TQ87fLe4wOQftBwKmUTVySg',
      aud: 'price_1TQ87fLe4wOQftBwOUn00CBu',
    },
    annual: {
      brl: 'price_1TQ87gLe4wOQftBwXrU4aCTL',
      usd: 'price_1TQ87gLe4wOQftBwHyQxVRPh',
      eur: 'price_1TQ87hLe4wOQftBwLWyLdD5T',
      gbp: 'price_1TQ87iLe4wOQftBwQQ4DjUuD',
      cad: 'price_1TQ87iLe4wOQftBwW9Sz4LYj',
      aud: 'price_1TQ87jLe4wOQftBwhGdBEMYD',
    },
  },
  master: {
    monthly: {
      brl: 'price_1TQ87kLe4wOQftBwmJ8UxAFV',
      usd: 'price_1TQ87lLe4wOQftBwYbvPPc46',
      eur: 'price_1TQ87lLe4wOQftBwrTtTCdU0',
      gbp: 'price_1TQ87mLe4wOQftBwQNc6cxwi',
      cad: 'price_1TQ87nLe4wOQftBwsp27R3KC',
      aud: 'price_1TQ87nLe4wOQftBwNB4XDsmj',
    },
    annual: {
      brl: 'price_1TQ87oLe4wOQftBwYxZZGMKR',
      usd: 'price_1TQ87pLe4wOQftBwbwDlmf6R',
      eur: 'price_1TQ87qLe4wOQftBwGJeM1wJi',
      gbp: 'price_1TQ87qLe4wOQftBwg1uvrmUr',
      cad: 'price_1TQ87rLe4wOQftBwphstSnaL',
      aud: 'price_1TQ87rLe4wOQftBwu9AuigSZ',
    },
  },
};

// PriceIds — LIVE mode (sk_live_) — preencher apos rodar setup-stripe-multicurrency.js em LIVE
const PRICE_IDS_LIVE = {
  full:   { monthly: {}, annual: {} },
  master: { monthly: {}, annual: {} },
};

const ALLOWED_CURRENCIES = ['brl', 'usd', 'eur', 'gbp', 'cad', 'aud'];

function getPriceIds() {
  const isLive = String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_');
  return isLive ? PRICE_IDS_LIVE : PRICE_IDS_TEST;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const i18nMod = await import('./_helpers/i18n.js');
  const { t } = i18nMod.default || i18nMod;

  const { plan, billing, token, ref, currency: rawCurrency, lang } = req.body || {};
  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  const SITE_URL      = process.env.SITE_URL || 'https://bluetubeviral.com';
  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const ANON_KEY      = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!STRIPE_SECRET) return res.status(500).json({ error: t('stripe_unavailable', lang) });

  const billingKey = billing === 'annual' ? 'annual' : 'monthly';

  // Currency: lowercase + whitelist; invalida/ausente cai em brl silenciosamente
  const currency = ALLOWED_CURRENCIES.includes(String(rawCurrency || '').toLowerCase())
    ? String(rawCurrency).toLowerCase()
    : 'brl';

  const PRICE_IDS = getPriceIds();
  const planMap  = PRICE_IDS && PRICE_IDS[plan];
  if (!planMap) return res.status(400).json({ error: t('invalid_plan', lang) });

  const priceId = planMap[billingKey] && planMap[billingKey][currency];
  if (!priceId) return res.status(400).json({ error: t('invalid_plan_currency', lang) });

  // Busca email do usuario (token Supabase opcional)
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
      'metadata[billing]': billing || 'monthly',
      'metadata[currency]': currency,
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
      return res.status(400).json({ error: session.error?.message || t('stripe_error', lang) });
    }

    return res.status(200).json({ url: session.url });
  } catch(err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: t('checkout_failed', lang) });
  }
}
