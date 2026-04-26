// api/get-plan.js
// Returns the subscriber plan for the authenticated user.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.body;
  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;

  if (!token) return res.status(400).json({ error: 'Token required' });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Not configured' });

  // SERVICE_KEY é obrigatório para ler a tabela subscribers
  if (!SERVICE_KEY) {
    console.error('get-plan: SUPABASE_SERVICE_KEY não configurado');
    return res.status(500).json({ error: 'Not configured' });
  }

  try {
    // 1. Valida token e pega email do usuário
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` }
    });
    const user = await userRes.json();
    if (!userRes.ok || !user.email) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // 2. Busca plano na tabela subscribers
    const subRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(user.email)}&select=plan,plan_expires_at,is_manual,cancel_at_period_end`,
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
    );

    // Verifica se a query deu certo antes de parsear
    if (!subRes.ok) {
      const errText = await subRes.text();
      console.error('get-plan: subscribers query failed:', subRes.status, errText);
      // Retorna free mas não quebra — usuário pelo menos consegue entrar
      return res.status(200).json({ plan: 'free', email: user.email, plan_expires_at: null });
    }

    const subs = await subRes.json();
    const sub  = Array.isArray(subs) ? subs[0] : null;

    let plan = 'free';

    if (sub?.plan && sub.plan !== 'free') {
      const isManual  = sub.is_manual === true;
      const notExpired = !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date();

      // Plano manual: sempre ativo (admin decidiu, não depende de expiração)
      // Plano via Stripe: ativo enquanto não expirado
      if (isManual || notExpired) {
        plan = sub.plan;
      } else {
        console.log(`get-plan: plano expirado para ${user.email} — expires_at: ${sub.plan_expires_at}`);
      }
    }

    return res.status(200).json({
      plan,
      email: user.email,
      plan_expires_at: sub?.plan_expires_at || null,
      is_manual: sub?.is_manual || false,
      cancel_at_period_end: sub?.cancel_at_period_end === true
    });

  } catch (err) {
    console.error('get-plan error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
