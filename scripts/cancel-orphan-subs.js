#!/usr/bin/env node
// scripts/cancel-orphan-subs.js
//
// Cancela IMEDIATAMENTE (DELETE) subs ativas no Stripe + atualiza DB.
// SEM refund (Felipe pediu pra garantir só nao cobrar novamente).
//
// Cada cancelamento e registrado em payment_logs pra audit.
//
// USO:
//   STRIPE_SECRET_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//     node scripts/cancel-orphan-subs.js [--dry-run]

const STRIPE = process.env.STRIPE_SECRET_KEY;
const SU = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY;
const DRY = process.argv.includes('--dry-run');

if (!STRIPE || !SU || !SK) {
  console.error('Missing env vars'); process.exit(1);
}

const supaH = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

// CASOS A CANCELAR IMEDIATAMENTE (DELETE no Stripe + DB→free)
const CANCEL_IMEDIATO = [
  { email: 'pilarskimatheus@gmail.com',    sub_id: 'sub_1TNK2nLe4wOQftBwHRLkrX6k', motivo: 'Zumbi+user cancelou' },
  { email: 'espacoquizz@gmail.com',        sub_id: 'sub_1TP6YOLe4wOQftBww7Kqh64N', motivo: 'Zumbi pagante (plan=free)' },
  { email: 'arturmedeiros2018@gmail.com',  sub_id: 'sub_1TNdOuLe4wOQftBwo0J78q5E', motivo: 'Zumbi+user cancelou' },
  { email: 'brunoadaodasilvabarbosa@gmail.com', sub_id: 'sub_1TXWo2Le4wOQftBwRq40W7CT', motivo: 'Duplicacao Full (manter Master)' },
  { email: 'brunoadaodasilvabarbosa@gmail.com', sub_id: 'sub_1TNby3Le4wOQftBwHSeB7pIB', motivo: 'Duplicacao Full (manter Master)' },
];

// SANEAMENTO DE DB (sub ja cancelada no Stripe, ou stale customer_id)
// {email, set:{...}}
const SANEAR_DB = [
  // ferques: stripe_customer_id aponta pra cus_UMR9 (deletado). Limpar.
  { email: 'ferques45@gmail.com', set: { stripe_customer_id: null, stripe_subscription_id: null, plan: 'free', plan_expires_at: null, cancel_at_period_end: false } },
  // guiitx: ja cancelada Stripe. Garantir DB consistente.
  { email: 'guiitx@yahoo.com', set: { plan: 'free', plan_expires_at: null, stripe_subscription_id: null, cancel_at_period_end: false } },
  // joao21xx: ja cancelada Stripe. Garantir DB consistente.
  { email: 'joao21xx.7@gmail.com', set: { plan: 'free', plan_expires_at: null, stripe_subscription_id: null, cancel_at_period_end: false } },
];

async function stripeDelete(subId) {
  const r = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${STRIPE}` },
  });
  return { ok: r.ok, status: r.status, body: await r.text().catch(() => '') };
}

async function supaPatch(table, qs, body) {
  const r = await fetch(`${SU}/rest/v1/${table}?${qs}`, {
    method: 'PATCH',
    headers: { ...supaH, Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, body: await r.text().catch(() => '') };
}

async function logPaymentLog(data) {
  return fetch(`${SU}/rest/v1/payment_logs`, {
    method: 'POST',
    headers: { ...supaH, Prefer: 'return=minimal' },
    body: JSON.stringify({ ...data, created_at: new Date().toISOString() }),
  });
}

(async () => {
  console.log('═══ Cancel orphan subs ═══');
  console.log('Mode:', DRY ? 'DRY-RUN (nada sera executado)' : 'EXECUCAO REAL');
  console.log('');

  let okCount = 0, errCount = 0;

  // FASE 1: cancel imediato no Stripe + DB → free
  console.log('▶ FASE 1: Cancel imediato Stripe + DB free');
  for (const c of CANCEL_IMEDIATO) {
    console.log(`  ${c.email} | sub:${c.sub_id} | ${c.motivo}`);
    if (DRY) { console.log('    [DRY] pularia DELETE+PATCH'); continue; }

    // 1. DELETE sub no Stripe
    const stripeR = await stripeDelete(c.sub_id);
    if (!stripeR.ok && stripeR.status !== 404) {
      console.log(`    ❌ Stripe DELETE falhou: ${stripeR.status} ${stripeR.body.slice(0, 200)}`);
      errCount++; continue;
    }
    console.log(`    ✅ Stripe DELETE: ${stripeR.status}`);

    // 2. DB → free (so pra esse email, e so se ja for free OU stripe_subscription_id == sub_id atual)
    //    Pro bruno que tem Master ativo, NAO degradar pra free — so limpar stripe_subscription_id se for esse.
    const patchR = await supaPatch('subscribers', `email=eq.${encodeURIComponent(c.email)}&stripe_subscription_id=eq.${c.sub_id}`, {
      plan: 'free',
      plan_expires_at: null,
      stripe_subscription_id: null,
      cancel_at_period_end: false,
      updated_at: new Date().toISOString(),
    });
    console.log(`    DB PATCH (se sub matched): ${patchR.status}`);

    // 3. Log audit
    await logPaymentLog({
      stripe_session_id: c.sub_id,
      user_email: c.email,
      plan: 'unknown',
      amount: '0',
      status: 'manual_cancel',
      note: `Manual cancel: ${c.motivo}`,
    }).catch(() => {});

    okCount++;
  }

  console.log('');
  console.log('▶ FASE 2: Sanear DB (subs ja canceladas Stripe ou stale)');
  for (const s of SANEAR_DB) {
    console.log(`  ${s.email} | set:`, JSON.stringify(s.set));
    if (DRY) { console.log('    [DRY] pularia'); continue; }
    const patchR = await supaPatch('subscribers', `email=eq.${encodeURIComponent(s.email)}`, {
      ...s.set,
      updated_at: new Date().toISOString(),
    });
    console.log(`    DB PATCH: ${patchR.status}`);
    okCount++;
  }

  console.log('');
  console.log('═══ RESUMO ═══');
  console.log(`OK: ${okCount} | Errors: ${errCount}`);
})();
