// api/asaas-webhook.js — Webhook Asaas (recebe confirmacao de pagamento Pix)
// =====================================================================
// Asaas chama este endpoint quando o status de um payment muda. Eventos:
//   - PAYMENT_CREATED   — cobranca criada (ignora)
//   - PAYMENT_RECEIVED  — Pix recebido (ATIVA PLANO)
//   - PAYMENT_CONFIRMED — pagamento confirmado (cartao tb usa este)
//   - PAYMENT_OVERDUE   — vencido (ignora)
//   - PAYMENT_DELETED   — cobranca apagada (ignora)
//   - PAYMENT_REFUNDED  — estornado (DESATIVA plano)
//
// Configurar no painel Asaas:
//   URL: https://bluetubeviral.com/api/asaas-webhook
//   Token: ASAAS_WEBHOOK_TOKEN (validado via header asaas-access-token)
//   Eventos: PAYMENT_RECEIVED, PAYMENT_CONFIRMED, PAYMENT_REFUNDED
//
// Idempotente: dedup via subscribers.asaas_payment_id (uniq logico).

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // ── Auth via header (configurado no painel Asaas) ────────────────────────
  const expectedToken = process.env.ASAAS_WEBHOOK_TOKEN;
  if (expectedToken) {
    const got = req.headers['asaas-access-token'] || req.headers['Asaas-Access-Token'];
    if (got !== expectedToken) {
      console.warn('[asaas-webhook] token invalido:', got?.slice(0, 8));
      return res.status(401).json({ error: 'token_invalido' });
    }
  }

  const event = req.body;
  if (!event?.event || !event?.payment) {
    return res.status(400).json({ error: 'payload_invalido' });
  }

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'config_missing' });
  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  const payment = event.payment;
  const eventType = event.event;

  // ── Decode externalReference (metadata embutida na criacao) ──────────────
  let meta = {};
  try {
    if (payment.externalReference) meta = JSON.parse(payment.externalReference);
  } catch (e) {
    console.warn('[asaas-webhook] externalReference invalido:', payment.externalReference);
  }

  const { plan, email, ref, kind } = meta;
  if (kind !== 'pix_annual' || !plan || !email) {
    // Não é cobrança de assinatura BlueTube — ignora silenciosamente
    return res.status(200).json({ ok: true, ignored: 'not_subscription' });
  }

  // ── PAYMENT_RECEIVED / PAYMENT_CONFIRMED → ATIVA PLANO ───────────────────
  if (eventType === 'PAYMENT_RECEIVED' || eventType === 'PAYMENT_CONFIRMED') {
    // Bonus 13 meses (396d) pra alinhar com a promessa "13 pelo preço de 12"
    const expiresAt = new Date(Date.now() + 396 * 24 * 60 * 60 * 1000).toISOString();
    const emailLower = String(email).toLowerCase().trim();

    // UPSERT atomico via on_conflict=email
    const upsertR = await fetch(`${SU}/rest/v1/subscribers?on_conflict=email`, {
      method: 'POST',
      headers: { ...H, 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        email: emailLower,
        plan,
        is_manual: false,
        plan_expires_at: expiresAt,
        cancel_at_period_end: false,
        amount_paid: Number(payment.value || 0),
        currency: 'brl',
        coupon_applied: false,
        coupon_discount: 0,
        billing_period: 'annual',
        billing_method: 'pix_annual',
        asaas_payment_id: payment.id,
        asaas_customer_id: payment.customer,
        updated_at: new Date().toISOString(),
      }),
    });

    if (!upsertR.ok) {
      const err = await upsertR.text();
      console.error('[asaas-webhook] UPSERT falhou:', upsertR.status, err.slice(0, 300));
      return res.status(500).json({ error: 'upsert_falhou' });
    }

    console.log(`✅ [asaas-webhook] plano ativado via Pix: ${emailLower} → ${plan} (396d)`);

    // ── Email confirmacao ────────────────────────────────────────────────
    if (RESEND) {
      try {
        const nome = (emailLower.split('@')[0] || 'criador').replace(/[._-]/g, ' ');
        const planLabel = plan === 'master' ? 'Master' : 'Full';
        const valorBR = Number(payment.value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND}` },
          body: JSON.stringify({
            from: 'BlueTube <noreply@bluetubeviral.com>',
            reply_to: 'suporte@bluetubeviral.com',
            to: [emailLower],
            subject: `Pix confirmado — BlueTube ${planLabel} ativo por 13 meses`,
            html: `<p>Oi ${nome}, recebemos seu Pix de ${valorBR}.</p>
<p>Seu plano <strong>BlueTube ${planLabel}</strong> esta ativo por <strong>13 meses</strong> (12 + 1 mes bonus).</p>
<p>Sem renovacao automatica — vamos te lembrar por email 30 e 15 dias antes do vencimento.</p>
<p>Bora criar viral? <a href="https://bluetubeviral.com">Acesse agora</a></p>`,
            text: `Oi ${nome}, recebemos seu Pix de ${valorBR}. Seu plano BlueTube ${planLabel} esta ativo por 13 meses. Acesse: https://bluetubeviral.com`,
          }),
        });
      } catch (e) { console.warn('[asaas-webhook] email falhou:', e.message); }
    }

    // ── Comissao de afiliado (se houve ref) ──────────────────────────────
    // Reusa logica do webhook Stripe: hard-call /api/affiliate?action=registrar
    if (ref) {
      try {
        await fetch(`${process.env.SITE_URL || 'https://bluetubeviral.com'}/api/affiliate?action=registrar-conversao`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ref,
            email: emailLower,
            plan,
            amount: Number(payment.value),
            currency: 'brl',
            source: 'asaas_pix',
            external_id: payment.id,
          }),
        });
      } catch (e) { console.warn('[asaas-webhook] afiliado falhou:', e.message); }
    }

    return res.status(200).json({ ok: true, activated: true, plan, expires_at: expiresAt });
  }

  // ── PAYMENT_REFUNDED → desativa plano ─────────────────────────────────────
  if (eventType === 'PAYMENT_REFUNDED') {
    const emailLower = String(email).toLowerCase().trim();
    await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(emailLower)}`, {
      method: 'PATCH',
      headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({
        plan: 'free',
        plan_expires_at: null,
        cancel_at_period_end: false,
        updated_at: new Date().toISOString(),
      }),
    }).catch(() => {});
    console.log(`[asaas-webhook] refund Pix: ${emailLower} → plano free`);
    return res.status(200).json({ ok: true, refunded: true });
  }

  // Outros eventos (CREATED, OVERDUE, DELETED) — ignora
  return res.status(200).json({ ok: true, event: eventType, ignored: true });
};
