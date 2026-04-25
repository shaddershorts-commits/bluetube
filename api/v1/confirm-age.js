// api/v1/confirm-age.js — Marca subscriber como age_confirmed=true (Fix 6 - Gap 5)
//
// Idempotente: se ja estava true, no-op silencioso (200).
// Auth: Bearer access_token. user_id NUNCA do body — sempre do token (IDOR-safe).
//
// Chamado pelo frontend depois de:
//   - Signup (OTP success): obrigatorio com retry, fail-soft (Caminho D)
//   - Login (signin success): silent fire-and-forget pra regularizar legacy

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token obrigatorio' });

  let userEmail;
  try {
    const ur = await fetch(`${SU}/auth/v1/user`, {
      headers: { apikey: AK, Authorization: 'Bearer ' + token },
    });
    if (!ur.ok) return res.status(401).json({ error: 'Token invalido' });
    const u = await ur.json();
    userEmail = (u.email || '').toLowerCase();
    if (!userEmail) return res.status(400).json({ error: 'Email nao encontrado' });
  } catch (e) {
    return res.status(500).json({ error: 'Erro na verificacao do token' });
  }

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  try {
    // Check current state pra reportar was_already_confirmed
    const cur = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(userEmail)}&select=age_confirmed&limit=1`, { headers: h });
    const curRows = cur.ok ? await cur.json() : [];
    const wasAlready = !!(curRows[0]?.age_confirmed);

    if (wasAlready) {
      return res.status(200).json({ ok: true, was_already_confirmed: true });
    }

    // PATCH: define age_confirmed=true + timestamp. Filtra apenas rows ainda nao confirmados
    // (defensive — evita overwrite acidental do age_confirmed_at se ja foi marcado por outro path)
    const pR = await fetch(
      `${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(userEmail)}&age_confirmed=is.false`,
      {
        method: 'PATCH',
        headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ age_confirmed: true, age_confirmed_at: new Date().toISOString() }),
      }
    );
    if (!pR.ok) {
      // Falha do supabase — frontend deve retry segundo caso
      return res.status(502).json({ error: 'Falha ao persistir confirmacao' });
    }

    return res.status(200).json({ ok: true, was_already_confirmed: false });
  } catch (e) {
    return res.status(500).json({ error: 'Erro ao processar' });
  }
};
