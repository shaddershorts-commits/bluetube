// api/trial-activate.js — Ativacao trial 30d via link no email (2026-06-23)
// =====================================================================
// Fluxo:
//   1. User clica link no email → GET /api/trial-activate?token=...
//   2. Valida token HMAC + descobre email
//   3. Checa elegibilidade (free, sem trial previo, nao Full/Master pagante)
//   4. Redireciona pra https://bluetubeviral.com/?trial_activate=<token>
//   5. Frontend index.html detecta param, exige login, chama POST /api/trial-activate
//   6. POST valida sessao Supabase + ativa plan=full por 30 dias
//   7. Frontend mostra popup de boas-vindas
//
// Seguranca:
//   - GET nunca ativa nada (so valida token e redireciona)
//   - POST exige Authorization Bearer (JWT do Supabase auth) + token na body
//   - Email do token TEM QUE BATER com email do JWT (anti-token-roubo)

const { verifyTrialToken } = require('./_helpers/trial-token');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const ANON = process.env.SUPABASE_ANON_KEY;
  if (!SU || !SK || !ANON) return res.status(500).json({ ok: false, error: 'missing env' });

  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  // ── GET: valida token, redireciona pro frontend ─────────────────────────
  if (req.method === 'GET') {
    const token = req.query?.token;
    if (!token) {
      return res.redirect(302, 'https://bluetubeviral.com/?trial_error=missing_token');
    }
    const v = verifyTrialToken(token);
    if (!v.valid) {
      return res.redirect(302, `https://bluetubeviral.com/?trial_error=${encodeURIComponent(v.reason || 'invalid')}`);
    }
    // Token ok — redireciona pro index. Frontend faz login + POST
    return res.redirect(302, `https://bluetubeviral.com/?trial_activate=${encodeURIComponent(token)}`);
  }

  // ── POST: ativa o trial ─────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  const body = req.body || {};
  const token = body.token;
  const authHeader = req.headers?.authorization || '';
  const userJWT = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) return res.status(400).json({ ok: false, error: 'token required' });
  if (!userJWT) return res.status(401).json({ ok: false, error: 'auth required' });

  // Valida token
  const v = verifyTrialToken(token);
  if (!v.valid) return res.status(400).json({ ok: false, error: 'invalid_token', reason: v.reason });

  // Valida JWT do Supabase (descobre email do user logado)
  const meRes = await fetch(`${SU}/auth/v1/user`, {
    headers: { apikey: ANON, Authorization: 'Bearer ' + userJWT },
  });
  if (!meRes.ok) return res.status(401).json({ ok: false, error: 'jwt_invalid' });
  const me = await meRes.json();
  const loggedEmail = String(me?.email || '').toLowerCase();
  const tokenEmail = String(v.email || '').toLowerCase();

  if (!loggedEmail || loggedEmail !== tokenEmail) {
    return res.status(403).json({ ok: false, error: 'email_mismatch', logged: loggedEmail, token_owner: tokenEmail });
  }

  // Busca subscriber pra checar elegibilidade
  const subRes = await fetch(
    `${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(loggedEmail)}&select=email,plan,plan_expires_at,trial_origin,stripe_customer_id&limit=1`,
    { headers: H }
  );
  const subs = subRes.ok ? await subRes.json() : [];
  const sub = subs[0];

  // Bloqueios:
  // 1. Ja eh full/master ATIVO pagante (NAO sobrescreve plano pago)
  if (sub && (sub.plan === 'full' || sub.plan === 'master')) {
    const stillActive = !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date();
    if (stillActive && sub.trial_origin !== 'email_30d') {
      return res.status(400).json({
        ok: false,
        error: 'already_paid',
        message: 'Você já tem plano ativo. Trial não é necessário.'
      });
    }
  }
  // 2. Ja usou trial 30d antes
  if (sub && sub.trial_origin === 'email_30d') {
    return res.status(400).json({
      ok: false,
      error: 'trial_already_used',
      message: 'Você já ativou o trial de 30 dias antes. Só pode ser usado uma vez por conta.'
    });
  }

  // Calcula nova data de expiracao (30 dias a partir de agora)
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const upsertPayload = {
    email: loggedEmail,
    plan: 'full',
    plan_expires_at: expires.toISOString(),
    is_manual: false,
    cancel_at_period_end: false,
    trial_origin: 'email_30d',
    trial_started_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  // UPSERT subscriber
  const upRes = await fetch(`${SU}/rest/v1/subscribers?on_conflict=email`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(upsertPayload),
  });

  if (!upRes.ok) {
    const errText = await upRes.text();
    console.error(`[trial-activate] upsert fail: ${upRes.status} ${errText.slice(0, 300)}`);
    return res.status(500).json({ ok: false, error: 'upsert_failed', detail: errText.slice(0, 200) });
  }

  // Marca no email_marketing tambem (pra cron parar de oferecer trial)
  await fetch(`${SU}/rest/v1/email_marketing?email=eq.${encodeURIComponent(loggedEmail)}`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ trial_offered_at: now.toISOString() }),
  }).catch(() => {});

  console.log(`[trial-activate] ATIVADO ${loggedEmail} expira ${expires.toISOString()}`);

  return res.status(200).json({
    ok: true,
    plan: 'full',
    expires_at: expires.toISOString(),
    days_remaining: 30,
    message: 'Trial de 30 dias ativado com sucesso!'
  });
};
