// api/get-plan.js
// Returns the subscriber plan for the authenticated user.
// Called after login to update the UI with the correct plan badge.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.body;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!token) return res.status(400).json({ error: 'Token required' });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Not configured' });

  try {
    // Get user from token
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${token}`
      }
    });
    const user = await userRes.json();
    if (!userRes.ok || !user.email) return res.status(401).json({ error: 'Invalid token' });

    // Get subscriber plan
    const subRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(user.email)}&select=plan,plan_expires_at,is_manual`,
      {
        headers: {
          'apikey': SERVICE_KEY,
          'Authorization': `Bearer ${SERVICE_KEY}`
        }
      }
    );
    const subs = await subRes.json();
    const sub = subs?.[0];

    // Check if plan is still active
    let plan = 'free';
    if (sub?.plan && sub.plan !== 'free') {
      if (!sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date()) {
        plan = sub.plan;
      }
    }

    return res.status(200).json({ plan, email: user.email, plan_expires_at: sub?.plan_expires_at || null });
  } catch (err) {
    console.error('get-plan error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
