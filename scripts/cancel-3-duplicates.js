#!/usr/bin/env node
// scripts/cancel-3-duplicates.js
// Cancela subs duplicadas pros 3 casos identificados em 2026-05-18:
//   - maurilioshorts: cancela Full R$29.99 (mantem Master R$89.99)
//   - manuelcardoso1814: cancela R$29.99 antiga (mantem R$14.99 do pais)
//   - devargasdjully: cancela mais antiga (mantem mais recente)
//
// DELETE imediato (sem refund, conforme Felipe).

const STRIPE = process.env.STRIPE_SECRET_KEY;
const SU = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY;
if (!STRIPE || !SU || !SK) { console.error('Missing env'); process.exit(1); }

const supaH = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

const TARGETS = [
  // mauril: cancelar Full (manter Master)
  { email: 'maurilioshorts@gmail.com', sub_id: 'sub_1TNu2aLe4wOQftBwWx3NUM8I', cust: 'cus_UMdJeVZL9UaXKF', motivo: 'Full duplicada (mantém Master R$89.99)' },
  // manuel: cancelar R$29.99 antiga (manter R$14.99 do pais)
  { email: 'manuelcardoso1814@gmail.com', sub_id: 'sub_1TOk0cLe4wOQftBwvc6REsFs', cust: 'cus_UNV0mnNzCrnsU5', motivo: 'Antiga R$29.99 (mantém R$14.99 preço regional)' },
  // djully: cancelar antiga (manter mais recente)
  { email: 'devargasdjully@gmail.com', sub_id: 'sub_1TRN1HLe4wOQftBwDZbgujYI', cust: 'cus_UQDS9CBrSAx4Ep', motivo: 'Duplicação idêntica (mantém mais recente)' },
];

(async () => {
  console.log('═══ Cancel 3 duplicates ═══');
  let ok = 0, err = 0;

  for (const t of TARGETS) {
    console.log(`▶ ${t.email} | sub:${t.sub_id} | ${t.motivo}`);
    // DELETE no Stripe
    const r = await fetch(`https://api.stripe.com/v1/subscriptions/${t.sub_id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${STRIPE}` },
    });
    if (!r.ok && r.status !== 404) {
      const body = await r.text().catch(() => '');
      console.log(`  ❌ Stripe DELETE ${r.status}: ${body.slice(0,200)}`);
      err++;
      continue;
    }
    console.log(`  ✅ Stripe DELETE: ${r.status}`);

    // Update DB SE o stripe_subscription_id atual no DB for esse (evita degradar plano errado)
    const patchR = await fetch(
      `${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(t.email)}&stripe_subscription_id=eq.${t.sub_id}`,
      {
        method: 'PATCH',
        headers: { ...supaH, Prefer: 'return=minimal' },
        body: JSON.stringify({
          stripe_subscription_id: null,
          updated_at: new Date().toISOString(),
        }),
      }
    );
    console.log(`  DB PATCH (se matched): ${patchR.status}`);

    // Log audit
    await fetch(`${SU}/rest/v1/payment_logs`, {
      method: 'POST',
      headers: { ...supaH, Prefer: 'return=minimal' },
      body: JSON.stringify({
        stripe_session_id: t.sub_id,
        user_email: t.email,
        plan: 'duplicated',
        amount: '0',
        status: 'manual_cancel_duplicate',
        note: `Manual cancel duplicate: ${t.motivo}`,
        created_at: new Date().toISOString(),
      }),
    }).catch(() => {});
    ok++;
  }

  console.log('');
  console.log(`Resultado: ${ok} OK, ${err} erros`);
})();
