// api/check-limit.js
// Plataforma gratuita — só verifica se o usuário tem conta (token válido)
// Sem limites de uso por plano. BlueVoice tem seu próprio limite de 30/mês em auth.js

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

  const { action, token } = req.body;
  const today = new Date().toISOString().split('T')[0];

  // ── OFFLINE SIGNAL ─────────────────────────────────────────────────────────
  if (action === 'offline') {
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

      // Bot detection
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
      await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/ip_online?ip_address=eq.${encodeURIComponent(ip)}`, {
          method: 'DELETE', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
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
          method: 'DELETE', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        })
      ]);
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(200).json({ ok: false }); }
  }

  // ── CHECK / INCREMENT — só verifica se tem conta ───────────────────────────
  // Plataforma é gratuita. Só precisa estar logado.
  if (action === 'check' || action === 'increment') {
    if (!token) {
      return res.status(200).json({ allowed: false, reason: 'login_required', remaining: 0 });
    }

    // Verifica se o token é válido
    try {
      const uRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` }
      });
      if (!uRes.ok) {
        return res.status(200).json({ allowed: false, reason: 'login_required', remaining: 0 });
      }
    } catch(e) {
      // Se não conseguir verificar, permite passar (fail open)
      return res.status(200).json({ allowed: true, remaining: 999, plan: 'free' });
    }

    // Registra uso para analytics (não bloqueia)
    if (action === 'increment' && SUPABASE_URL && SUPABASE_KEY) {
      fetch(`${SUPABASE_URL}/rest/v1/ip_usage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ ip_address: ip, usage_date: today, script_count: 1, plan: 'free' })
      }).catch(() => {});
    }

    return res.status(200).json({ allowed: true, remaining: 999, plan: 'free' });
  }

  return res.status(400).json({ error: 'Invalid action' });
}
