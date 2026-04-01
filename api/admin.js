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

  // ── AFFILIATE MANAGEMENT ─────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'set_affiliate_status') {
    const { email, status } = req.body; // status: active | pending | suspended
    if (!email || !status) return res.status(400).json({ error: 'email e status obrigatórios' });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/affiliates?email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ status, updated_at: new Date().toISOString() })
    });
    const data = await r.json();
    console.log(`Affiliate ${status}: ${email}`);
    return res.status(200).json({ success: true, email, status });
  }

  if (req.method === 'GET' && action === 'list_affiliates') {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/affiliates?select=*&order=created_at.desc`, { headers });
    const data = await r.json();
    return res.status(200).json(Array.isArray(data) ? data : []);
  }

  // ── GET DASHBOARD DATA ────────────────────────────────────────────────────
  try {
    const today = new Date().toISOString().split('T')[0];
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // safeJson: always returns an array, never throws
    const safeJson = async (resPromise) => {
      try {
        const res = await resPromise;
        if (!res || !res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      } catch(e) { return []; }
    };

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [subscribers, todayUsage, topVirals, feedbackRaw, visitsToday, onlineNow, weeklyRaw, bluescoreRaw, recentSubs] = await Promise.all([
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=*&order=created_at.desc`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/ip_usage?usage_date=eq.${today}&select=*`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/viral_shorts?select=video_id,copy_count,lang,processed_at&order=copy_count.desc&limit=10`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/user_feedback?select=*&order=created_at.desc&limit=50`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/ip_visits?visit_date=eq.${today}&select=ip_address`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/ip_online?pinged_at=gte.${twoMinAgo}&select=ip_address`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/ip_visits?visit_date=gte.${sevenDaysAgo}&select=ip_address,visit_date&order=visit_date.asc`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/bluescore_analyses?select=channel_name,score,classification,avg_views,analyzed_at&order=analyzed_at.desc&limit=20`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=email,plan,created_at&order=created_at.desc&limit=10`, { headers })),
    ]);

    // Group weekly visits by date
    const weeklyMap = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      weeklyMap[d.toISOString().split('T')[0]] = 0;
    }
    weeklyRaw.forEach(r => { if (weeklyMap[r.visit_date] !== undefined) weeklyMap[r.visit_date]++; });
    const weeklyVisits = Object.entries(weeklyMap).map(([date, count]) => ({ date, count }));

    // Sort feedback
    const feedback = feedbackRaw.sort((a,b)=>{
      if(a.plan==='master'&&b.plan!=='master')return -1;
      if(b.plan==='master'&&a.plan!=='master')return 1;
      if(a.type==='support'&&b.type!=='support')return -1;
      if(b.type==='support'&&a.type!=='support')return 1;
      return new Date(b.created_at)-new Date(a.created_at);
    });

    const stats = {
      subscribers: {
        total: subscribers.length,
        free: subscribers.filter(s => s.plan === 'free').length,
        full: subscribers.filter(s => s.plan === 'full').length,
        master: subscribers.filter(s => s.plan === 'master').length,
        paying_full: subscribers.filter(s => s.plan === 'full' && !s.is_manual).length,
        paying_master: subscribers.filter(s => s.plan === 'master' && !s.is_manual).length,
        manual_full: subscribers.filter(s => s.plan === 'full' && s.is_manual).length,
        manual_master: subscribers.filter(s => s.plan === 'master' && s.is_manual).length,
        list: subscribers
      },
      revenue: {
        monthly_mrr: (subscribers.filter(s => s.plan === 'full' && !s.is_manual).length * 59.90) +
                     (subscribers.filter(s => s.plan === 'master' && !s.is_manual).length * 179.90),
        full_revenue: subscribers.filter(s => s.plan === 'full' && !s.is_manual).length * 59.90,
        master_revenue: subscribers.filter(s => s.plan === 'master' && !s.is_manual).length * 179.90
      },
      today: {
        active_ips: todayUsage.length,
        total_scripts_generated: todayUsage.reduce((sum, r) => sum + (r.script_count || 0), 0),
        usage_breakdown: todayUsage
      },
      top_virals: topVirals,
      feedback,
      visits: {
        today_unique: visitsToday.length,
        online_now: onlineNow.length,
        weekly: weeklyVisits,
      },
      latest_subscriber: subscribers.filter(s => s.plan !== 'free' && !s.is_manual)[0] || null,
      latest_cancellation: subscribers
        .filter(s => s.plan === 'free' && s.updated_at)
        .sort((a,b) => new Date(b.updated_at) - new Date(a.updated_at))[0] || null,
      latest_signup: recentSubs[0] || null, // último cadastro (qualquer plano)
      recent_signups: recentSubs, // últimos 10 cadastros
      bluescore: {
        total_analyses: bluescoreRaw.length,
        recent: bluescoreRaw,
        avg_score: bluescoreRaw.length > 0
          ? Math.round(bluescoreRaw.reduce((s,a) => s + (a.score||0), 0) / bluescoreRaw.length)
          : 0,
      },
    };

    return res.status(200).json(stats);
  } catch (err) {
    console.error('Admin error:', err);
    return res.status(500).json({ error: 'Failed to fetch admin data: ' + err.message });
  }
}
