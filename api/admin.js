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

  // ── SET PLAN MANUALLY ────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'set_plan') {
    if (!email || !plan) return res.status(400).json({ error: 'Missing email or plan' });

    const payload = {
      plan,
      is_manual: true,
      plan_expires_at: plan === 'free' ? null : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString()
    };

    // Try PATCH first (update existing)
    const patch = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify(payload)
      }
    );

    const patchData = await patch.json();
    console.log('PATCH result:', patch.status, JSON.stringify(patchData).slice(0,200));

    // If no rows updated, INSERT new record
    if (patch.ok && Array.isArray(patchData) && patchData.length === 0) {
      const insert = await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ email, ...payload })
      });
      if (!insert.ok) {
        const err = await insert.json();
        console.error('INSERT error:', err);
        return res.status(500).json({ error: 'Failed to insert plan: ' + JSON.stringify(err) });
      }
    } else if (!patch.ok) {
      console.error('PATCH error:', patchData);
      return res.status(500).json({ error: 'Failed to update plan: ' + JSON.stringify(patchData) });
    }

    return res.status(200).json({ success: true, email, plan });
  }

  // ── GET DASHBOARD DATA ────────────────────────────────────────────────────
  try {
    const today = new Date().toISOString().split('T')[0];
    // "Online" = visited in last 5 minutes
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const [subsRes, usageRes, viralsRes, feedbackRes, visitsRes, onlineRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=*&order=created_at.desc`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/ip_usage?usage_date=eq.${today}&select=*`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/viral_shorts?select=video_id,copy_count,lang,processed_at&order=copy_count.desc&limit=10`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/user_feedback?select=*&order=created_at.desc&limit=50`, { headers }),
      // All unique visitors today
      fetch(`${SUPABASE_URL}/rest/v1/ip_visits?visit_date=eq.${today}&select=ip_address,visited_at`, { headers }),
      // Online now = visited in last 5 min
      fetch(`${SUPABASE_URL}/rest/v1/ip_visits?visit_date=eq.${today}&visited_at=gte.${fiveMinAgo}&select=ip_address`, { headers }),
    ]);

    const [subscribers, todayUsage, topVirals, feedbackRaw, visitsToday, onlineNow] = await Promise.all([
      subsRes.json(), usageRes.json(), viralsRes.json(),
      feedbackRes.ok ? feedbackRes.json() : [],
      visitsRes.ok ? visitsRes.json() : [],
      onlineRes.ok ? onlineRes.json() : [],
    ]);

    // Sort feedback: master first, then support, then others
    const feedback = Array.isArray(feedbackRaw) ? feedbackRaw.sort((a,b)=>{
      if(a.plan==='master'&&b.plan!=='master')return -1;
      if(b.plan==='master'&&a.plan!=='master')return 1;
      if(a.type==='support'&&b.type!=='support')return -1;
      if(b.type==='support'&&a.type!=='support')return 1;
      return new Date(b.created_at)-new Date(a.created_at);
    }) : [];

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
      feedback,
      visits: {
        today_unique: Array.isArray(visitsToday) ? visitsToday.length : 0,
        online_now: Array.isArray(onlineNow) ? onlineNow.length : 0,
      },
      // Latest subscriber for real-time notification
      latest_subscriber: subscribers.filter(s => s.plan !== 'free' && !s.is_manual)[0] || null
    };

    return res.status(200).json(stats);
  } catch (err) {
    console.error('Admin error:', err);
    return res.status(500).json({ error: 'Failed to fetch admin data' });
  }
}
