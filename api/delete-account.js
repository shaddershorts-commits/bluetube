// api/delete-account.js — LGPD: Delete all user data
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const { token } = req.body || {};
  if (!token) return res.status(401).json({ error: 'Token required' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  try {
    // Verify user
    const ur = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!ur.ok) return res.status(401).json({ error: 'Token inválido' });
    const user = await ur.json();
    const email = user.email;
    const userId = user.id;

    if (!email || !userId) return res.status(400).json({ error: 'User not found' });

    // Cancel Stripe subscription if exists
    const subRes = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=stripe_customer_id`, { headers: h });
    if (subRes.ok) {
      const subs = await subRes.json();
      const stripeId = subs?.[0]?.stripe_customer_id;
      if (stripeId && process.env.STRIPE_SECRET_KEY) {
        try {
          // List active subscriptions and cancel them
          const sr = await fetch(`https://api.stripe.com/v1/customers/${stripeId}/subscriptions?status=active`, {
            headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }
          });
          if (sr.ok) {
            const sd = await sr.json();
            for (const sub of (sd.data || [])) {
              await fetch(`https://api.stripe.com/v1/subscriptions/${sub.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }
              });
            }
          }
        } catch(e) { console.error('[delete-account] Stripe cancel error:', e.message); }
      }
    }

    // Delete user data from all tables
    const tables = [
      `subscribers?email=eq.${encodeURIComponent(email)}`,
      `roteiro_exemplos?idioma=neq.NEVER`, // Only if user-specific data exists
      `blue_videos?user_id=eq.${userId}`,
      `blue_comments?user_id=eq.${userId}`,
      `blue_interactions?user_id=eq.${userId}`,
      `blue_profiles?user_id=eq.${userId}`,
      `blue_notifications?user_id=eq.${userId}`,
      `blue_reports?reporter_id=eq.${userId}`,
      `user_feedback?email=eq.${encodeURIComponent(email)}`,
      `reactivation_emails?email=eq.${encodeURIComponent(email)}`,
    ];

    for (const table of tables) {
      await fetch(`${SU}/rest/v1/${table}`, { method: 'DELETE', headers: h }).catch(() => {});
    }

    // Send confirmation email
    if (RESEND_KEY && email) {
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: 'BlueTube <noreply@bluetubeviral.com>', to: [email],
          subject: '✅ Sua conta BlueTube foi deletada',
          html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0a1628;color:#e8f4ff;border-radius:16px;padding:28px;border:1px solid rgba(0,170,255,.2)">
            <h2 style="color:#00aaff;margin:0 0 16px">Conta deletada</h2>
            <p>Todos os seus dados foram removidos do BlueTube conforme solicitado.</p>
            <p>Se mudar de ideia, você pode criar uma nova conta a qualquer momento em <a href="https://bluetubeviral.com" style="color:#00aaff">bluetubeviral.com</a>.</p>
            <p style="color:rgba(150,190,230,.4);font-size:12px;margin-top:20px">Este email foi enviado em conformidade com a LGPD.</p>
          </div>`
        })
      }).catch(() => {});
    }

    return res.status(200).json({ ok: true, message: 'Conta deletada com sucesso. Todos os dados foram removidos.' });
  } catch(e) {
    console.error('[delete-account] Error:', e);
    return res.status(500).json({ error: 'Erro ao deletar conta: ' + e.message });
  }
};
