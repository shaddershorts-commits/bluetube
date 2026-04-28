// api/check-limit.js
// Controla limites de uso por plano: Free=2/dia, Full=9/dia, Master=ilimitado

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ANON_KEY = process.env.SUPABASE_ANON_KEY || SUPABASE_KEY;

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();

  const { action, token, page: rawPage } = req.body;
  const today = new Date().toISOString().split('T')[0];
  // Whitelist de paginas trackadas. Default 'home' garante retrocompat.
  const page = (rawPage === 'landing') ? 'landing' : 'home';

  // ── OFFLINE SIGNAL ─────────────────────────────────────────────────────────
  if (action === 'offline') {
    // Deleta todas as rows de ip_online pra esse IP (independe de page) — user
    // pode ter abas abertas em home + landing; offline limpa tudo. Proximo
    // ping recria com page correta.
    fetch(`${SUPABASE_URL}/rest/v1/ip_online?ip_address=eq.${encodeURIComponent(ip)}`, {
      method: 'DELETE', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    }).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  // ── VISIT TRACKING ─────────────────────────────────────────────────────────
  if (action === 'visit') {
    try {
      const isPrivate = !ip || ip === 'unknown' || ip === '127.0.0.1' || ip === '::1' ||
        ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('::ffff:');
      if (isPrivate) return res.status(200).json({ ok: false });

      const p = ip.split('.').map(Number);
      const [o1, o2] = p;
      const isBot =
        (o1===13&&[52,56,57,58,59].includes(o2)) ||
        (o1===3&&[101,104,105,106].includes(o2)) ||
        (o1===54&&[36,67,148,149,151,153,176,177,183,184,185,193,215,219,241].includes(o2)) ||
        (o1===52&&[8,9,52].includes(o2)) ||
        (o1===64&&[23,227].includes(o2)) ||
        (o1===137&&o2===184) || (o1===143&&o2===198) || (o1===146&&o2===190) ||
        (o1===147&&o2===182) || (o1===159&&o2===65) || (o1===164&&o2===92) ||
        (o1===167&&o2===172) || (o1===174&&o2===138) ||
        (o1===24&&o2===144) || (o1===134&&o2===199) ||
        (o1===184&&o2===169) || (o1===204&&o2===236);
      if (isBot) return res.status(200).json({ ok: false, reason: 'bot' });

      const now = new Date().toISOString();
      // ip_online: delete por (ip, page) e re-cria — permite IP estar online
      // simultaneamente em home E landing (aba dupla) sem se sobrescreverem.
      await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/ip_online?ip_address=eq.${encodeURIComponent(ip)}&page=eq.${page}`, {
          method: 'DELETE', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        }).then(() => fetch(`${SUPABASE_URL}/rest/v1/ip_online`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ ip_address: ip, pinged_at: now, page })
        })),
        fetch(`${SUPABASE_URL}/rest/v1/ip_visits`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ ip_address: ip, visit_date: today, visited_at: now, page })
        }),
        fetch(`${SUPABASE_URL}/rest/v1/ip_online?pinged_at=lt.${new Date(Date.now()-3*60*1000).toISOString()}`, {
          method: 'DELETE', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        })
      ]);
      return res.status(200).json({ ok: true, page });
    } catch(e) { return res.status(200).json({ ok: false }); }
  }

  // ── CHECK / INCREMENT — controle de limites por plano ─────────────────────
  if (action === 'check' || action === 'increment') {

    let plan = 'free';
    let userEmail = null;
    let dailyLimit = 2;

    if (token) {
      try {
        const uRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` }
        });
        if (uRes.ok) {
          const user = await uRes.json();
          userEmail = user.email;

          if (userEmail) {
            const subRes = await fetch(
              `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(userEmail)}&select=plan,plan_expires_at,is_manual`,
              { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
            );
            if (subRes.ok) {
              const subs = await subRes.json();
              const sub = Array.isArray(subs) ? subs[0] : null;
              if (sub?.plan && sub.plan !== 'free') {
                const isManual = sub.is_manual === true;
                const notExpired = !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date();
                if (isManual || notExpired) {
                  plan = sub.plan;
                }
              }
            }
          }
        } else {
          return res.status(200).json({ allowed: false, reason: 'login_required', remaining: 0, plan: 'free' });
        }
      } catch(e) {
        return res.status(200).json({ allowed: true, remaining: 999, plan: 'free' });
      }
    }

    // Define limite
    if (plan === 'master') dailyLimit = 999999;
    else if (plan === 'full') dailyLimit = 9;
    else dailyLimit = 2;

    // Master = ilimitado
    if (plan === 'master') {
      if (action === 'increment') {
        fetch(`${SUPABASE_URL}/rest/v1/ip_usage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ ip_address: ip, usage_date: today, script_count: 1, plan })
        }).catch(() => {});
      }
      return res.status(200).json({ allowed: true, remaining: 999, plan, dailyLimit });
    }

    // Free e Full: consultar uso do dia via ip_usage
    let usedToday = 0;
    try {
      const usageRes = await fetch(
        `${SUPABASE_URL}/rest/v1/ip_usage?ip_address=eq.${encodeURIComponent(ip)}&usage_date=eq.${today}&select=script_count`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      if (usageRes.ok) {
        const usageData = await usageRes.json();
        usedToday = usageData?.[0]?.script_count || 0;
      }
    } catch(e) {}

    const remaining = Math.max(0, dailyLimit - usedToday);

    if (action === 'check') {
      return res.status(200).json({
        allowed: remaining > 0,
        remaining,
        used: usedToday,
        plan,
        dailyLimit,
        reason: remaining <= 0 ? (plan === 'free' ? 'limit_free' : 'limit_full') : null
      });
    }

    // action === 'increment'
    if (remaining <= 0) {
      return res.status(200).json({
        allowed: false,
        remaining: 0,
        used: usedToday,
        plan,
        dailyLimit,
        reason: plan === 'free' ? 'limit_free' : 'limit_full'
      });
    }

    // Incrementa uso na tabela ip_usage
    try {
      if (usedToday > 0) {
        // Atualiza script_count
        await fetch(
          `${SUPABASE_URL}/rest/v1/ip_usage?ip_address=eq.${encodeURIComponent(ip)}&usage_date=eq.${today}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
            body: JSON.stringify({ script_count: usedToday + 1, plan })
          }
        );
      } else {
        // Cria registro
        await fetch(`${SUPABASE_URL}/rest/v1/ip_usage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ ip_address: ip, usage_date: today, script_count: 1, plan })
        });
      }
    } catch(e) {
      console.error('check-limit increment error:', e);
    }

    return res.status(200).json({
      allowed: true,
      remaining: remaining - 1,
      used: usedToday + 1,
      plan,
      dailyLimit
    });
  }

  return res.status(400).json({ error: 'Invalid action' });
}
