// api/activation-offer.js — Oferta de Ativação Master 50% x2 meses (2026-07-27)
// =============================================================================
// Popup único pós-cadastro. O BANCO é a fonte da verdade (activation_offers):
// limpar cookie/localStorage não ressuscita a oferta.
//
// Actions (POST, token Supabase do usuário):
//   eligibility — decide se mostra. Regras: conta <48h, plano free, SEM
//                 afiliado (affiliate_ref/attribution_source nulos — afiliado
//                 já tem cupom próprio, sem desconto duplo), nenhuma linha
//                 prévia na tabela. Elegível → INSERT 'shown' (expira em 15min)
//                 e retorna expires_at. Idempotente: re-chamada devolve estado.
//   decline     — fechar o popup = renúncia DEFINITIVA (status declined).
//   stats       — funil agregado (admin_secret): shown/declined/expired/
//                 accepted/converted.
//
// Quem aplica o desconto é o create-checkout.js (revalida aqui via mesma
// tabela). Quem marca 'converted' é o webhook (pagamento confirmado).

const OFFER_WINDOW_MIN = 15;            // contador honesto: 15min server-side

async function resolverUsuario(token, { SU, ANON }) {
  if (!token) return null;
  try {
    const r = await fetch(`${SU}/auth/v1/user`, {
      headers: { apikey: ANON, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.email ? { email: String(u.email).toLowerCase().trim(), id: u.id || null } : null;
  } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const ANON = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  const body = req.body || {};
  const action = body.action || req.query.action;

  try {
    // ── STATS (admin) ────────────────────────────────────────────────────────
    if (action === 'stats') {
      const secret = body.admin_secret || req.query.admin_secret;
      if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });
      const r = await fetch(`${SU}/rest/v1/activation_offers?select=status`, { headers: h });
      const rows = r.ok ? await r.json() : [];
      const funil = {};
      for (const row of rows) funil[row.status] = (funil[row.status] || 0) + 1;
      return res.status(200).json({ ok: true, total: rows.length, funil });
    }

    // Daqui pra baixo: precisa do usuário
    const user = await resolverUsuario(body.token, { SU, ANON });
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    const emailQ = encodeURIComponent(user.email);

    // Estado atual (se existe) — com expiração lazy
    const exR = await fetch(`${SU}/rest/v1/activation_offers?email=eq.${emailQ}&select=*`, { headers: h });
    const existente = exR.ok ? (await exR.json())[0] : null;
    if (existente && existente.status === 'shown' && new Date(existente.expires_at) < new Date()) {
      await fetch(`${SU}/rest/v1/activation_offers?email=eq.${emailQ}`, {
        method: 'PATCH', headers: h,
        body: JSON.stringify({ status: 'expired', decided_at: new Date().toISOString() }),
      }).catch(() => {});
      existente.status = 'expired';
    }

    // ── DECLINE ──────────────────────────────────────────────────────────────
    if (action === 'decline') {
      if (existente && existente.status === 'shown') {
        await fetch(`${SU}/rest/v1/activation_offers?email=eq.${emailQ}`, {
          method: 'PATCH', headers: h,
          body: JSON.stringify({ status: 'declined', decided_at: new Date().toISOString() }),
        });
      }
      return res.status(200).json({ ok: true, status: 'declined' });
    }

    // ── ELIGIBILITY ──────────────────────────────────────────────────────────
    if (action === 'eligibility') {
      // Já tem linha? Idempotente: devolve o estado real, nunca recria
      if (existente) {
        const ativa = existente.status === 'shown';
        return res.status(200).json({
          eligible: ativa,
          status: existente.status,
          expires_at: ativa ? existente.expires_at : null,
        });
      }

      // Regras de elegibilidade no subscriber
      const sR = await fetch(
        `${SU}/rest/v1/subscribers?email=eq.${emailQ}&select=plan,created_at,affiliate_ref,attribution_source`,
        { headers: h }
      );
      const sub = sR.ok ? (await sR.json())[0] : null;

      // Afiliado? SEM oferta (afiliado já tem cupom próprio — decisão do user)
      if (sub && (sub.affiliate_ref || sub.attribution_source)) {
        return res.status(200).json({ eligible: false, status: 'affiliate' });
      }
      // Já é pagante? Sem oferta
      if (sub && sub.plan && sub.plan !== 'free') {
        return res.status(200).json({ eligible: false, status: 'paid' });
      }
      // SEM trava de idade da conta (decisão do user no lançamento 2026-07-27):
      // a base free EXISTENTE também vê a oferta — uma única vez, no próximo
      // uso. A garantia de unicidade continua sendo a PK da tabela.

      // Elegível → cria a janela (INSERT; conflito = corrida entre 2 abas,
      // re-lê e devolve o estado real)
      const expiresAt = new Date(Date.now() + OFFER_WINDOW_MIN * 60000).toISOString();
      const ins = await fetch(`${SU}/rest/v1/activation_offers`, {
        method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ email: user.email, user_id: user.id, status: 'shown', expires_at: expiresAt }),
      });
      if (!ins.ok) {
        const re = await fetch(`${SU}/rest/v1/activation_offers?email=eq.${emailQ}&select=status,expires_at`, { headers: h });
        const row = re.ok ? (await re.json())[0] : null;
        const ativa = row && row.status === 'shown' && new Date(row.expires_at) > new Date();
        return res.status(200).json({ eligible: !!ativa, status: row ? row.status : 'error', expires_at: ativa ? row.expires_at : null });
      }
      return res.status(200).json({ eligible: true, status: 'shown', expires_at: expiresAt });
    }

    return res.status(400).json({ error: 'action_invalida' });
  } catch (e) {
    console.error('[activation-offer]', e && e.message);
    return res.status(500).json({ error: e && e.message });
  }
};
