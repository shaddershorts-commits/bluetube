// api/cancel-subscription.js
// Usuario cancela a propria assinatura.
//
// FIX 2026-05-18: Refator pra cancelar TODAS subs ativas no Stripe pra esse
// email — nao so a `subscribers.stripe_subscription_id`. Razao: alguns users
// tem MULTIPLAS subs ativas em customers Stripe diferentes (bug historico de
// "duplo customer" — primeira sub criada, depois user fez novo checkout com
// novo customer, mas a 1a sub continuou ativa e renovando). Caso real:
// bruno tinha 3 subs ativas, ferques 2.
//
// Strategy:
//   1. Lista TODOS customers no Stripe pra esse email
//   2. Pra CADA customer, lista subs ativas
//   3. Cancela CADA sub via cancel_at_period_end=true (preserva acesso pago)
//   4. Update Supabase pra refletir total
//
// Garante: nenhuma sub "orfa" fica cobrando depois que user cancela.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, reason } = req.body;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ANON_KEY = process.env.SUPABASE_ANON_KEY || SUPABASE_KEY;
  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;

  if (!token) return res.status(401).json({ error: 'Token required' });
  if (!STRIPE_SECRET) return res.status(500).json({ error: 'Stripe nao configurado' });

  // Helper: garante que cancel apareca na lista "Mensagens dos usuarios" do admin.
  // Confirma 2026-06-23: ate aqui o type=cancel so vinha do confirmCancelStep2
  // (frontend index.html:4251). Cancels que pulam aquele step ou vem de outros
  // canais (webhook auto-cancel, Stripe Portal, etc) nao apareciam no painel.
  // Registra SEMPRE aqui pra garantia: 1 cancel = 1 entrada user_feedback.
  async function registerCancelFeedback(email, plan, motivo) {
    try {
      const msg = motivo && motivo.length >= 2
        ? (motivo.startsWith('Cancelamento') ? motivo : 'Cancelamento: ' + motivo)
        : 'Cancelamento (motivo nao informado)';
      await fetch(`${SUPABASE_URL}/rest/v1/user_feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          email: email || 'anônimo',
          plan: plan || 'free',
          message: msg.slice(0, 500),
          type: 'cancel',
          created_at: new Date().toISOString(),
        }),
      });
    } catch (e) { console.error('[cancel-sub] feedback insert err:', e.message); }
  }

  try {
    // 1. Valida usuario
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Invalid token' });
    const user = await userRes.json();
    const email = (user.email || '').toLowerCase().trim();
    if (!email) return res.status(401).json({ error: 'Could not identify user' });

    const supaHeaders = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    };

    // 2. Busca subscriber no Supabase
    const subRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=stripe_subscription_id,stripe_customer_id,plan,is_manual,plan_expires_at`,
      { headers: supaHeaders }
    );
    if (!subRes.ok) return res.status(500).json({ error: 'Failed to lookup subscriber' });
    const subs = await subRes.json();
    const sub = subs?.[0];

    // 3. SEMPRE busca TODOS customers no Stripe pra esse email (multiplos possíveis)
    const stripeAuth = { Authorization: `Bearer ${STRIPE_SECRET}` };
    const custList = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=100`,
      { headers: stripeAuth }
    );
    const custData = custList.ok ? await custList.json() : { data: [] };
    const customers = (custData.data || []).filter(c => !c.deleted);

    // Pra cada customer, lista subs ATIVAS (active|trialing|past_due — todas
    // que ainda podem retentar cobranca). Logar has_more pra diagnostico futuro.
    if (custData.has_more) {
      console.warn(`[cancel] ${email}: customers/list has_more=true — pode ter customers truncados`);
    }
    const allActiveSubs = [];
    const ACTIVE_LIKE = ['active', 'trialing', 'past_due'];
    for (const c of customers) {
      const sListR = await fetch(
        `https://api.stripe.com/v1/subscriptions?customer=${c.id}&status=all&limit=100`,
        { headers: stripeAuth }
      );
      if (!sListR.ok) continue;
      const sList = await sListR.json();
      for (const s of (sList.data || [])) {
        if (!ACTIVE_LIKE.includes(s.status)) continue;
        allActiveSubs.push({ sub_id: s.id, customer: c.id, current_period_end: s.current_period_end });
      }
    }

    // ADICIONAL: pega tambem sub do DB se nao caiu no allActiveSubs (defesa em profundidade)
    if (sub?.stripe_subscription_id && !allActiveSubs.find(s => s.sub_id === sub.stripe_subscription_id)) {
      try {
        const r = await fetch(
          `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(sub.stripe_subscription_id)}`,
          { headers: stripeAuth }
        );
        if (r.ok) {
          const s = await r.json();
          if (s.status === 'active' || s.status === 'trialing' || s.status === 'past_due') {
            allActiveSubs.push({ sub_id: s.id, customer: s.customer, current_period_end: s.current_period_end });
          }
        }
      } catch {}
    }

    // 4. Se manual OU sem nenhuma sub ativa: so rebaixa DB
    if (sub?.is_manual || allActiveSubs.length === 0) {
      await fetch(
        `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: { ...supaHeaders, 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            plan: 'free',
            plan_expires_at: null,
            cancel_at_period_end: false,
            stripe_subscription_id: null,
            updated_at: new Date().toISOString()
          })
        }
      );
      // Registra cancel no user_feedback (etiqueta no painel admin)
      await registerCancelFeedback(email, sub?.plan, reason);
      return res.status(200).json({
        success: true,
        email,
        plan: 'free',
        stripe_cancelled: false,
        canceled_subs_count: 0,
        reason: sub?.is_manual ? 'plano_manual' : 'sem_assinatura_stripe_ativa'
      });
    }

    // 5. Cancela CADA sub ativa via cancel_at_period_end=true
    const cancelResults = [];
    let lastPeriodEnd = null;
    for (const s of allActiveSubs) {
      try {
        const cancelR = await fetch(
          `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(s.sub_id)}`,
          {
            method: 'POST',
            headers: {
              ...stripeAuth,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'cancel_at_period_end=true'
          }
        );
        const cancelData = await cancelR.json();
        if (cancelR.ok) {
          cancelResults.push({ sub_id: s.sub_id, ok: true, current_period_end: cancelData.current_period_end });
          if (cancelData.current_period_end && (!lastPeriodEnd || cancelData.current_period_end > lastPeriodEnd)) {
            lastPeriodEnd = cancelData.current_period_end;
          }
        } else {
          cancelResults.push({ sub_id: s.sub_id, ok: false, error: cancelData.error?.message });
        }
      } catch (e) {
        cancelResults.push({ sub_id: s.sub_id, ok: false, error: e.message });
      }
    }

    const successCount = cancelResults.filter(r => r.ok).length;
    const failCount = cancelResults.filter(r => !r.ok).length;

    // 6. Update DB — usa o periodEnd MAIS DISTANTE entre todas as subs canceladas
    //    (user mantem acesso ate a ultima expirar)
    const periodEnd = lastPeriodEnd ? new Date(lastPeriodEnd * 1000) : null;
    if (periodEnd) {
      await fetch(
        `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: { ...supaHeaders, 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            plan_expires_at: periodEnd.toISOString(),
            cancel_at_period_end: true,
            updated_at: new Date().toISOString()
          })
        }
      );
    }

    console.log(`[cancel] ${email} — ${successCount} sub(s) cancelada(s) no Stripe (period end: ${periodEnd?.toISOString() || 'N/A'})`);
    if (failCount > 0) {
      console.error(`[cancel] ${email} — ${failCount} sub(s) falharam:`, cancelResults.filter(r => !r.ok));
    }

    // 7. Email de confirmacao (fire-and-forget)
    import('./_helpers/cancellationEmail.js')
      .then((m) => m.sendCancellationEmail(email, sub?.plan || 'unknown', periodEnd?.toISOString()))
      .catch((e) => console.error('[cancel-subscription] cancellationEmail:', e.message));

    // Registra cancel no user_feedback (etiqueta no painel admin)
    await registerCancelFeedback(email, sub?.plan, reason);

    return res.status(200).json({
      success: true,
      email,
      plan: sub?.plan || 'unknown',
      plan_expires_at: periodEnd?.toISOString() || null,
      stripe_cancelled: successCount > 0,
      canceled_subs_count: successCount,
      failed_subs_count: failCount,
      message: successCount > 1
        ? `Cancelamos ${successCount} assinaturas no total. Você mantém acesso até o fim do período pago.`
        : 'Cancelamento agendado. Você mantém acesso até o fim do período pago.',
    });
  } catch (err) {
    console.error('[cancel-subscription] error:', err);
    return res.status(500).json({ error: 'Failed to cancel subscription' });
  }
}
