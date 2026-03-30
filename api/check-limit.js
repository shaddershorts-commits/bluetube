// api/check-limit.js
// Checks and increments daily script generation limit per IP.
// Free: 2/day | Full: 9/day | Master: unlimited

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    // If Supabase not configured, allow through (dev mode)
    return res.status(200).json({ allowed: true, remaining: 99, plan: 'free' });
  }

  // Get real IP (Vercel sets x-forwarded-for)
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();

  const { action } = req.body; // 'check', 'increment', or 'visit'
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // ── OFFLINE SIGNAL — instant removal from online ───────────────────────────
  if (action === 'offline') {
    try {
      // Delete this IP from ip_online immediately
      await fetch(
        `${SUPABASE_URL}/rest/v1/ip_online?ip_address=eq.${encodeURIComponent(ip)}`,
        {
          method: 'DELETE',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        }
      );
    } catch(e) {}
    return res.status(200).json({ ok: true });
  }

  // ── VISIT TRACKING ─────────────────────────────────────────────────────────
  if (action === 'visit') {
    try {
      // Block private/internal IPs
      const isPrivate = !ip || ip === 'unknown' || ip === '0.0.0.0' ||
        ip === '127.0.0.1' || ip === '::1' ||
        ip.startsWith('10.') || ip.startsWith('192.168.') ||
        ip.startsWith('169.254.') || ip.startsWith('::ffff:');

      if (isPrivate) return res.status(200).json({ ok: false, reason: 'private' });

      // Block confirmed bot datacenter ranges
      const parts = ip.split('.');
      const o1 = parseInt(parts[0]), o2 = parseInt(parts[1]);
      const isBot =
        (o1===13&&(o2===56||o2===57||o2===52)) || (o1===18&&o2===144) ||
        (o1===54&&(o2===67||o2===153||o2===183||o2===36)) || (o1===52&&o2===8) ||
        (o1===137&&o2===184) || (o1===143&&o2===198) || (o1===64&&o2===227) ||
        (o1===134&&o2===199) || (o1===24&&o2===144) ||
        (o1===164&&o2===92) || (o1===159&&o2===65);

      if (isBot) return res.status(200).json({ ok: false, reason: 'bot' });

      const now = new Date().toISOString();

      // 1. ip_online — upsert by IP (no unique constraint, just update/insert for this IP)
      //    Delete old entry for this IP then insert fresh (acts as upsert)
      await Promise.all([
        // Update pinged_at in ip_online (delete + insert = instant upsert)
        fetch(`${SUPABASE_URL}/rest/v1/ip_online?ip_address=eq.${encodeURIComponent(ip)}`, {
          method: 'DELETE',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        }).then(() => fetch(`${SUPABASE_URL}/rest/v1/ip_online`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ ip_address: ip, pinged_at: now })
        })),

        // 2. ip_visits — upsert unique IP per day (for daily visitor count)
        fetch(`${SUPABASE_URL}/rest/v1/ip_visits`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'resolution=merge-duplicates,return=minimal'
          },
          body: JSON.stringify({ ip_address: ip, visit_date: today, visited_at: now })
        }),

        // 3. Clean old ip_online entries (older than 3 minutes) to avoid stale data
        fetch(`${SUPABASE_URL}/rest/v1/ip_online?pinged_at=lt.${new Date(Date.now() - 3*60*1000).toISOString()}`, {
          method: 'DELETE',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        })
      ]);

      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(200).json({ ok: false });
    }
  }

  try {
    // Fetch current usage for this IP today
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/ip_usage?ip_address=eq.${encodeURIComponent(ip)}&usage_date=eq.${today}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );

    const rows = await fetchRes.json();
    const row = rows?.[0];
    const currentCount = row?.script_count || 0;
    const plan = row?.plan || 'free';

    // Limits per plan
    const LIMITS = { free: 2, full: 9, master: 999999 };
    const limit = LIMITS[plan] || 2;
    const remaining = Math.max(0, limit - currentCount);
    const allowed = currentCount < limit;

    if (action === 'check') {
      return res.status(200).json({ allowed, remaining, used: currentCount, limit, plan });
    }

    if (action === 'increment') {
      if (!allowed) {
        return res.status(429).json({ allowed: false, remaining: 0, used: currentCount, limit, plan });
      }

      if (row) {
        // Update existing row
        await fetch(
          `${SUPABASE_URL}/rest/v1/ip_usage?ip_address=eq.${encodeURIComponent(ip)}&usage_date=eq.${today}`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`
            },
            body: JSON.stringify({ script_count: currentCount + 1 })
          }
        );
      } else {
        // Insert new row
        await fetch(`${SUPABASE_URL}/rest/v1/ip_usage`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            ip_address: ip,
            usage_date: today,
            script_count: 1,
            plan: 'free'
          })
        });
      }

      return res.status(200).json({
        allowed: true,
        remaining: remaining - 1,
        used: currentCount + 1,
        limit,
        plan
      });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (err) {
    console.error('check-limit error:', err);
    // Fail open — don't block users if DB is down
    return res.status(200).json({ allowed: true, remaining: 99, plan: 'free' });
  }
}
