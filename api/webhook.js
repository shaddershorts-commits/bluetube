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
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const plan = session.metadata?.plan || 'full';
      const email = session.customer_details?.email;
      const customerId = session.customer;
      const subscriptionId = session.subscription;

      if (email) {
        await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
          method: 'POST',
          headers: { ...supaHeaders, 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify({
            email,
            plan,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            plan_expires_at: new Date(Date.now() + 32 * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString()
          })
        });
        // Also update IP limit for this subscriber if possible
        console.log(`✅ Plan activated: ${email} → ${plan}`);
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = sub.customer;
      // Downgrade to free when subscription cancelled
      await fetch(`${SUPABASE_URL}/rest/v1/subscribers?stripe_customer_id=eq.${customerId}`, {
        method: 'PATCH',
        headers: supaHeaders,
        body: JSON.stringify({ plan: 'free', plan_expires_at: null, updated_at: new Date().toISOString() })
      });
      console.log(`⬇️ Plan cancelled for customer: ${customerId}`);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}
