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

  // ── OFFLINE SIGNAL ─────────────────────────────────────────────────────────
  // Called via sendBeacon when user closes tab — set visited_at to past so they leave "online"
  if (action === 'offline') {
    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/ip_visits?ip_address=eq.${encodeURIComponent(ip)}&visit_date=eq.${today}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ visited_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() })
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
        ip.startsWith('10.') || ip.startsWith('172.') ||
        ip.startsWith('192.168.') || ip.startsWith('169.254.') ||
        ip.startsWith('::ffff:');

      // Block known datacenter ranges by first two octets
      const parts = ip.split('.');
      const o1 = parseInt(parts[0]);
      const o2 = parseInt(parts[1]);

      const isDatacenter =
        // AWS (all ranges)
        o1===13 || o1===18 || o1===34 || o1===35 || o1===44 || o1===52 || o1===54 ||
        (o1===3) || (o1===15) || (o1===16) ||
        // DigitalOcean
        (o1===64&&o2===227) || (o1===137&&o2===184) || (o1===143&&o2===198) ||
        (o1===144&&o2===126) || (o1===146&&o2===190) || (o1===147&&o2===182) ||
        (o1===159&&(o2===65||o2===89||o2===203)) ||
        (o1===161&&o2===35) || (o1===162&&o2===243) ||
        (o1===164&&(o2===90||o2===92)) || (o1===165&&o2===22) ||
        (o1===167&&(o2===71||o2===99||o2===172)) || (o1===174&&o2===138) ||
        (o1===134&&o2===199) || (o1===24&&o2===144) ||
        (o1===64&&o2===23) || (o1===68&&o2===183) ||
        // GCP
        (o1===104&&o2===196) || (o1===130&&o2===211) || (o1===104&&o2===155) ||
        // Linode/Akamai
        (o1===45&&(o2===33||o2===56||o2===79)) ||
        (o1===50&&o2===116) || (o1===96&&o2===126) ||
        (o1===172&&o2===104) || (o1===198&&o2===74) ||
        // Vultr
        (o1===45&&o2===32) || (o1===66&&o2===42) || (o1===108&&o2===61) ||
        (o1===149&&o2===28) || (o1===207&&o2===148) ||
        // OVH
        (o1===51&&o2===68) || (o1===51&&o2===75) || (o1===51&&o2===77) ||
        (o1===51&&o2===89) || (o1===54&&o2===36) ||
        // Hetzner
        (o1===116&&o2===202) || (o1===116&&o2===203) ||
        (o1===128&&o2===140) || (o1===157&&o2===90) ||
        (o1===176&&o2===9) || (o1===178&&o2===63) ||
        // Cloudflare
        (o1===104&&(o2>=16&&o2<=31)) || (o1===172&&(o2>=64&&o2<=79)) ||
        (o1===162&&o2===158) || (o1===190&&o2===93) ||
        // Fastly/CDNs
        (o1===151&&o2===101) || (o1===199&&o2===232);

      if (isPrivate || isDatacenter) {
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
