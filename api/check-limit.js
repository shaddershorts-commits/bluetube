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

  // ── VISIT TRACKING ─────────────────────────────────────────────────────────
  if (action === 'visit') {
    try {
      // Block private, internal, and known datacenter IP ranges
      const isInvalid = !ip || ip === 'unknown' || ip === '0.0.0.0' ||
        ip === '127.0.0.1' || ip === '::1' ||
        ip.startsWith('10.') ||
        ip.startsWith('172.') ||
        ip.startsWith('192.168.') ||
        ip.startsWith('169.254.') ||
        ip.startsWith('::ffff:');

      // Known datacenter ASN IP ranges (AWS, DigitalOcean, Google Cloud, Vercel, etc.)
      // These produce false positives from bots/crawlers/health checks
      const isDatacenter =
        // AWS us-west regions
        (ip.startsWith('13.') && (ip.startsWith('13.56.') || ip.startsWith('13.57.'))) ||
        (ip.startsWith('18.') && ip.startsWith('18.144.')) ||
        (ip.startsWith('54.') && (ip.startsWith('54.67.') || ip.startsWith('54.153.'))) ||
        (ip.startsWith('3.') && ip.startsWith('3.101.')) ||
        // DigitalOcean
        ip.startsWith('137.184.') ||
        ip.startsWith('164.92.') ||
        ip.startsWith('134.199.') ||
        ip.startsWith('64.23.') ||
        ip.startsWith('24.144.');

      if (isInvalid || isDatacenter) {
        return res.status(200).json({ ok: false, reason: 'filtered' });
      }

      const now = new Date().toISOString();
      await fetch(`${SUPABASE_URL}/rest/v1/ip_visits`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify({ ip_address: ip, visit_date: today, visited_at: now })
      });
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
