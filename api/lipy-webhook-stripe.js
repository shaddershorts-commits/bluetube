// Lipy — Webhook Stripe (pagamentos e assinaturas)
// Observação: se o bluetube já tiver um webhook Stripe, este é dedicado à Lipy.
// Configure no Stripe uma rota separada OU filtre por metadata.scope='lipy'.
const { getSupabase } = require('./_lipy/supabase');
const { baseUrl } = require('./_lipy/http');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const secret = process.env.LIPY_STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const raw = await readRaw(req);
    if (secret && sig) {
      const Stripe = require('stripe');
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      event = stripe.webhooks.constructEvent(raw, sig, secret);
    } else {
      event = JSON.parse(raw.toString('utf8'));
    }
  } catch (err) {
    console.error('[lipy-stripe] assinatura inválida', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  try {
    const sb = getSupabase();
    const appUrl = baseUrl(req);

    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      // Processa apenas sessões marcadas como Lipy (metadata.scope='lipy')
      if (s?.metadata?.scope && s.metadata.scope !== 'lipy') {
        return res.status(200).json({ ignored: true, reason: 'not lipy' });
      }
      const plano = mapPlano(s?.metadata?.plano);
      const { data: cliente } = await sb.from('lipy_clientes').insert({
        nome: s.customer_details?.name || 'Novo cliente',
        empresa: s.metadata?.empresa || s.customer_details?.name || 'Empresa',
        email: s.customer_details?.email,
        telefone: s.customer_details?.phone,
        plano,
        status: 'onboarding',
        stripe_customer_id: s.customer,
        stripe_subscription_id: s.subscription
      }).select().single();

      fetch(`${appUrl}/api/lipy-supervisor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evento: 'pagamento_confirmado',
          cliente_id: cliente?.id,
          dados: { plano, session_id: s.id }
        })
      }).catch(() => {});

      fetch(`${appUrl}/api/lipy-onboarding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cliente_id: cliente?.id, etapa: 'inicio' })
      }).catch(() => {});
    }

    if (event.type === 'customer.subscription.deleted') {
      await sb.from('lipy_clientes').update({ status: 'cancelado' })
        .eq('stripe_subscription_id', event.data.object.id);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[lipy-stripe]', err);
    res.status(500).json({ error: err.message });
  }
};

module.exports.config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function mapPlano(txt) {
  if (!txt) return 'starter';
  const t = String(txt).toLowerCase();
  if (t.includes('premium')) return 'premium';
  if (t.includes('growth')) return 'growth';
  return 'starter';
}
