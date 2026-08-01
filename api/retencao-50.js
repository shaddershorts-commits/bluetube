// api/retencao-50.js — oferta de retenção no cancelamento (2026-08-02)
//
// Full ou Master clicou em "Confirmar cancelamento" → a última etapa oferece
// 50% DE DESCONTO PERMANENTE na assinatura atual (coupon Stripe duration=
// forever aplicado na subscription existente — o valor cai já na próxima
// fatura e nunca mais volta).
//
// Estratégia do dono (02/08): em vez de baixar o preço de tabela pra todo
// mundo, aumentar o incentivo com desconto EXPLÍCITO — o usuário sabe que
// está pagando metade.
//
// Substitui o acceptDiscount() antigo do index.html, que era um STUB: dava
// alert("Desconto aplicado!") sem aplicar absolutamente nada.
//
// Segurança:
//   - só assinante full/master vivo, não-manual, com assinatura Stripe real
//   - idempotente: assinatura que já tem desconto forever não reaplica
//   - nunca cancela nada — cancelar continua sendo o finalCancel() do front

const COUPON_ID = 'retencao-50-forever';

const cfg = () => ({
  SU: process.env.SUPABASE_URL,
  SK: process.env.SUPABASE_SERVICE_KEY,
  AK: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY,
  STRIPE: process.env.STRIPE_SECRET_KEY,
});

async function stripeCall(path, method, params) {
  const { STRIPE } = cfg();
  const opts = {
    method: method || 'GET',
    headers: { Authorization: 'Bearer ' + STRIPE },
    signal: AbortSignal.timeout(15000),
  };
  if (params) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(params).toString();
  }
  const r = await fetch('https://api.stripe.com/v1/' + path, opts);
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { SU, SK, AK, STRIPE } = cfg();
  if (!SU || !SK || !STRIPE) return res.status(500).json({ error: 'config incompleta' });
  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  // ── quem é ────────────────────────────────────────────────────────────────
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.body?.token;
  if (!token) return res.status(401).json({ error: 'login necessário' });
  let email = null;
  try {
    const ur = await fetch(`${SU}/auth/v1/user`, {
      headers: { apikey: AK, Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(6000),
    });
    if (ur.ok) email = (await ur.json())?.email || null;
  } catch {}
  if (!email) return res.status(401).json({ error: 'login necessário' });

  const sr = await fetch(
    `${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=plan,plan_expires_at,is_manual,stripe_subscription_id,currency`,
    { headers: H, signal: AbortSignal.timeout(6000) }
  );
  const sub = sr.ok ? (await sr.json())[0] : null;
  const vivo = sub && (sub.plan === 'full' || sub.plan === 'master')
    && (sub.is_manual || !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date());
  if (!vivo) return res.status(403).json({ error: 'A oferta é pra assinantes Full e Master ativos.' });
  if (!sub.stripe_subscription_id) {
    return res.status(400).json({ error: 'Sua assinatura não é renovável pela Stripe (Pix anual/manual) — fala com o suporte que a gente resolve o desconto por lá.' });
  }

  try {
    // ── assinatura atual (idempotência + valor real) ─────────────────────────
    const s = await stripeCall(`subscriptions/${sub.stripe_subscription_id}`);
    if (!s.ok) return res.status(400).json({ error: 'Não achei sua assinatura ativa na Stripe. Fala com o suporte.' });
    if (!['active', 'trialing', 'past_due'].includes(s.d.status)) {
      return res.status(400).json({ error: 'Sua assinatura não está ativa — a oferta vale pra assinatura em andamento.' });
    }
    const jaTem = s.d.discount?.coupon?.percent_off >= 50
      || (s.d.discounts || []).some((x) => x?.coupon?.percent_off >= 50 && x?.coupon?.duration === 'forever');
    const valorCheio = (s.d.items?.data?.[0]?.price?.unit_amount || 0) / 100;
    const moeda = (s.d.currency || sub.currency || 'brl').toUpperCase();

    if (jaTem) {
      return res.status(200).json({ ok: true, ja_tinha: true, valor_novo: valorCheio / 2, moeda });
    }

    // ── garante o cupom (idempotente) ────────────────────────────────────────
    const c = await stripeCall('coupons', 'POST', {
      id: COUPON_ID, percent_off: '50', duration: 'forever',
      name: 'Retenção — 50% permanente',
    });
    if (!c.ok && c.d?.error?.code !== 'resource_already_exists') {
      return res.status(500).json({ error: 'Falha ao preparar o desconto. Tenta de novo.' });
    }

    // ── aplica NA ASSINATURA EXISTENTE — permanente, próxima fatura já sai ───
    const ap = await stripeCall(`subscriptions/${sub.stripe_subscription_id}`, 'POST', { coupon: COUPON_ID });
    if (!ap.ok) {
      console.error('[retencao-50] aplicar falhou:', ap.status, JSON.stringify(ap.d?.error || {}).slice(0, 200));
      return res.status(500).json({ error: 'Não consegui aplicar agora. Tenta de novo — se repetir, fala com o suporte.' });
    }

    // se estava com cancelamento agendado, desliga (a pessoa decidiu FICAR)
    if (s.d.cancel_at_period_end) {
      await stripeCall(`subscriptions/${sub.stripe_subscription_id}`, 'POST', { cancel_at_period_end: 'false' });
    }

    // espelha no banco (campos que já existem — sem SQL novo)
    fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ coupon_applied: true, coupon_discount: 50, cancel_at_period_end: false, updated_at: new Date().toISOString() }),
    }).catch(() => {});

    console.log(`[retencao-50] APLICADO: ${email} (${sub.plan}) — ${moeda} ${valorCheio} → ${valorCheio / 2}`);
    return res.status(200).json({ ok: true, plano: sub.plan, valor_cheio: valorCheio, valor_novo: valorCheio / 2, moeda });
  } catch (e) {
    console.error('[retencao-50]', e.message);
    return res.status(500).json({ error: 'Erro inesperado. Nada foi alterado — tenta de novo.' });
  }
};
