// api/check-limit.js
// Free: 2/day | Full: 9/day | Master: unlimited
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ANON_KEY     = process.env.SUPABASE_ANON_KEY || SUPABASE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY)
    return res.status(200).json({ allowed: true, remaining: 99, plan: 'free' });

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();

  const { action, token } = req.body;
  const today = new Date().toISOString().split('T')[0];

  // ── OFFLINE SIGNAL ─────────────────────────────────────────────────────────
  if (action === 'offline') {
    fetch(`${SUPABASE_URL}/rest/v1/ip_online?ip_address=eq.${encodeURIComponent(ip)}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    }).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  // ── VISIT TRACKING ─────────────────────────────────────────────────────────
  if (action === 'visit') {
    try {
      const isPrivate = !ip || ip === 'unknown' || ip === '0.0.0.0' ||
        ip === '127.0.0.1' || ip === '::1' ||
        ip.startsWith('10.') || ip.startsWith('192.168.') ||
        ip.startsWith('169.254.') || ip.startsWith('::ffff:');
      if (isPrivate) return res.status(200).json({ ok: false });

      // Bloqueia IPs de datacenter conhecidos (AWS, DigitalOcean, Linode, GCP)
      const p = ip.split('.').map(Number);
      const [o1, o2] = p;
      const isBot =
        (o1===13&&[52,56,57,58,59].includes(o2)) ||    // AWS us-west
        (o1===3&&[101,104,105,106].includes(o2)) ||      // AWS us-west-2
        (o1===18&&[144,177,178].includes(o2)) ||          // AWS
        (o1===54&&[36,67,148,149,151,153,177,183,184,185,193,215,219,241].includes(o2)) || // AWS
        (o1===52&&[8,9,52].includes(o2)) ||               // AWS
        (o1===64&&[23,227].includes(o2)) ||               // DigitalOcean
        (o1===137&&o2===184) || (o1===138&&o2===197) ||   // DigitalOcean
        (o1===143&&o2===198) || (o1===146&&o2===190) ||   // DigitalOcean
        (o1===147&&o2===182) || (o1===159&&o2===65) ||    // DigitalOcean
        (o1===161&&o2===35) || (o1===164&&o2===92) ||     // DigitalOcean
        (o1===167&&o2===172) || (o1===174&&o2===138) ||   // DigitalOcean
        (o1===45&&[33,56].includes(o2)) ||                // Linode
        (o1===173&&o2===230) || (o1===172&&o2===104) ||   // Linode
        (o1===169&&o2===197) ||                            // Datacenter
        (o1===34&&o2===86) || (o1===35&&o2===186);        // GCP bots
      if (isBot) return res.status(200).json({ ok: false, reason: 'bot' });

      const now = new Date().toISOString();
      await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/ip_online?ip_address=eq.${encodeURIComponent(ip)}`, {
          method: 'DELETE',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        }).then(() => fetch(`${SUPABASE_URL}/rest/v1/ip_online`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ ip_address: ip, pinged_at: now })
        })),
        fetch(`${SUPABASE_URL}/rest/v1/ip_visits`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ ip_address: ip, visit_date: today, visited_at: now })
        }),
        fetch(`${SUPABASE_URL}/rest/v1/ip_online?pinged_at=lt.${new Date(Date.now()-3*60*1000).toISOString()}`, {
          method: 'DELETE',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        })
      ]);
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(200).json({ ok: false });
    }
  }

  // ── RESOLVE USER PLAN FROM TOKEN ────────────────────────────────────────────
  let userPlan = 'free';
  let userEmail = null;

  if (token) {
    try {
      // 1. Get user email from token
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` }
      });
      if (userRes.ok) {
        const userData = await userRes.json();
        userEmail = userData.email || null;
      }
      // 2. Get plan from subscribers table
      if (userEmail) {
        const subRes = await fetch(
          `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(userEmail)}&select=plan,plan_expires_at,is_manual`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        if (subRes.ok) {
          const subs = await subRes.json();
          const sub = subs?.[0];
          if (sub) {
            const now = new Date();
            const expired = sub.plan_expires_at && new Date(sub.plan_expires_at) < now && !sub.is_manual;
            if (!expired && (sub.plan === 'full' || sub.plan === 'master')) {
              userPlan = sub.plan;
            }
          }
        }
      }
    } catch(e) {}
  }

  // Master = unlimited, always allow
  if (userPlan === 'master') {
    return res.status(200).json({ allowed: true, remaining: 999, used: 0, limit: 999, plan: 'master' });
  }

  const LIMITS = { free: 2, full: 9, master: 999999 };
  const limit = LIMITS[userPlan] || 2;

  try {
    // Fetch current IP usage
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/ip_usage?ip_address=eq.${encodeURIComponent(ip)}&usage_date=eq.${today}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await fetchRes.json();
    const row = rows?.[0];
    const currentCount = row?.script_count || 0;
    const remaining = Math.max(0, limit - currentCount);
    const allowed = currentCount < limit;

    if (action === 'check') {
      return res.status(200).json({ allowed, remaining, used: currentCount, limit, plan: userPlan });
    }

    if (action === 'increment') {
      if (!allowed) {
        return res.status(429).json({ allowed: false, remaining: 0, used: currentCount, limit, plan: userPlan });
      }
      if (row) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/ip_usage?ip_address=eq.${encodeURIComponent(ip)}&usage_date=eq.${today}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
            body: JSON.stringify({ script_count: currentCount + 1, plan: userPlan })
          }
        );
      } else {
        await fetch(`${SUPABASE_URL}/rest/v1/ip_usage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ ip_address: ip, usage_date: today, script_count: 1, plan: userPlan })
        });
      }
      return res.status(200).json({ allowed: true, remaining: remaining - 1, used: currentCount + 1, limit, plan: userPlan });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch(err) {
    console.error('check-limit error:', err);
    return res.status(200).json({ allowed: true, remaining: 99, plan: userPlan });
  }
}
