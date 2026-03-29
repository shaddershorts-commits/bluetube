// api/admin.js
// Returns admin dashboard data: users, subscribers, usage stats.
// Protected by ADMIN_SECRET environment variable.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const authHeader = req.headers['authorization'];
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  if (!ADMIN_SECRET || authHeader !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };

  const { action, email, plan } = req.method === 'POST' ? req.body : req.query;

  // ── SET PLAN MANUALLY (for influencers, partners, yourself) ──────────────
  if (req.method === 'POST' && action === 'set_plan') {
    if (!email || !plan) return res.status(400).json({ error: 'Missing email or plan' });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({
        email, plan,
        is_manual: true, // Mark as manually granted — excluded from revenue
        plan_expires_at: plan === 'free' ? null : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString()
      })
    });
    if (!r.ok) return res.status(500).json({ error: 'Failed to update plan' });
    return res.status(200).json({ success: true, email, plan });
  }

  // ── GET DASHBOARD DATA ────────────────────────────────────────────────────
  try {
    const today = new Date().toISOString().split('T')[0];

    const [subsRes, usageRes, viralsRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=*&order=created_at.desc`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/ip_usage?usage_date=eq.${today}&select=*`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/viral_shorts?select=video_id,copy_count,lang,processed_at&order=copy_count.desc&limit=10`, { headers })
    ]);

    const [subscribers, todayUsage, topVirals] = await Promise.all([
      subsRes.json(), usageRes.json(), viralsRes.json()
    ]);

    const stats = {
      subscribers: {
        total: subscribers.length,
        free: subscribers.filter(s => s.plan === 'free').length,
        full: subscribers.filter(s => s.plan === 'full').length,
        master: subscribers.filter(s => s.plan === 'master').length,
        // Paying = not manual and not free
        paying_full: subscribers.filter(s => s.plan === 'full' && !s.is_manual).length,
        paying_master: subscribers.filter(s => s.plan === 'master' && !s.is_manual).length,
        manual_full: subscribers.filter(s => s.plan === 'full' && s.is_manual).length,
        manual_master: subscribers.filter(s => s.plan === 'master' && s.is_manual).length,
        list: subscribers
      },
      revenue: {
        // Only count paying subscribers in revenue
        monthly_mrr: (subscribers.filter(s => s.plan === 'full' && !s.is_manual).length * 9.99) +
                     (subscribers.filter(s => s.plan === 'master' && !s.is_manual).length * 29.99),
        full_revenue: subscribers.filter(s => s.plan === 'full' && !s.is_manual).length * 9.99,
        master_revenue: subscribers.filter(s => s.plan === 'master' && !s.is_manual).length * 29.99
      },
      today: {
        active_ips: todayUsage.length,
        total_scripts_generated: todayUsage.reduce((sum, r) => sum + (r.script_count || 0), 0),
        usage_breakdown: todayUsage
      },
      top_virals: topVirals,
      // Latest subscriber for real-time notification
      latest_subscriber: subscribers.filter(s => s.plan !== 'free' && !s.is_manual)[0] || null
    };

    return res.status(200).json(stats);
  } catch (err) {
    console.error('Admin error:', err);
    return res.status(500).json({ error: 'Failed to fetch admin data' });
  }
}
