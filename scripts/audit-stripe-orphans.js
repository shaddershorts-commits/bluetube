#!/usr/bin/env node
// scripts/audit-stripe-orphans.js
//
// Lista TODAS as subscriptions ativas no Stripe e cruza com o DB do Supabase
// pra identificar:
//   A) Subs ativas SEM subscriber no DB (orfas totais)
//   B) Subs ativas cujo subscriber tem plan=free (zumbi pagante)
//   C) Subs ativas onde email tem MULTIPLAS subs (duplicacao tipo ferques)
//   D) Subs ativas com stripe_customer_id != do salvo em subscribers (stale)
//
// USO:
//   STRIPE_SECRET_KEY=sk_live_... SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//     node scripts/audit-stripe-orphans.js
//
//   # ou com env já carregado:
//   node scripts/audit-stripe-orphans.js
//
// NAO CANCELA NADA. Apenas lista. Saida em JSON salva em scripts/audit-output.json.

const fs = require('fs');
const path = require('path');

const STRIPE = process.env.STRIPE_SECRET_KEY;
const SU = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY;

if (!STRIPE || !SU || !SK) {
  console.error('Missing STRIPE_SECRET_KEY / SUPABASE_URL / SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}

const supaH = { apikey: SK, Authorization: 'Bearer ' + SK };

// Stripe paginated GET
async function stripeGet(path, params = {}) {
  const url = new URL(`https://api.stripe.com/v1/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${STRIPE}` } });
  if (!r.ok) throw new Error(`stripe_${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function listAllActiveSubs() {
  const all = [];
  let startingAfter = null;
  let page = 0;
  while (true) {
    page++;
    const params = { status: 'active', limit: 100, 'expand[]': 'data.customer' };
    if (startingAfter) params.starting_after = startingAfter;
    process.stdout.write(`  Pagina ${page} (${all.length} ate agora)... `);
    const r = await stripeGet('subscriptions', params);
    const items = r.data || [];
    all.push(...items);
    console.log(`+${items.length}`);
    if (!r.has_more) break;
    startingAfter = items[items.length - 1].id;
  }
  return all;
}

// Lookup batch subscribers por emails
async function fetchSubscribersByEmails(emails) {
  if (!emails.length) return [];
  const out = [];
  const CHUNK = 50;
  for (let i = 0; i < emails.length; i += CHUNK) {
    const batch = emails.slice(i, i + CHUNK).map(e => encodeURIComponent(e));
    const url = `${SU}/rest/v1/subscribers?email=in.(${batch.join(',')})&select=email,plan,plan_expires_at,is_manual,stripe_customer_id,stripe_subscription_id,cancel_at_period_end`;
    const r = await fetch(url, { headers: supaH });
    if (r.ok) out.push(...(await r.json()));
  }
  return out;
}

(async () => {
  console.log('═══ Auditoria de Subs Stripe Orfas ═══');
  console.log('');
  console.log('▶ Listando TODAS subs ativas no Stripe...');
  const allSubs = await listAllActiveSubs();
  console.log(`  Total subs ativas no Stripe: ${allSubs.length}`);
  console.log('');

  // Indexa por email
  const subsByEmail = {};
  let missingEmail = 0;
  for (const s of allSubs) {
    const email = (s.customer?.email || '').toLowerCase().trim();
    if (!email) { missingEmail++; continue; }
    if (!subsByEmail[email]) subsByEmail[email] = [];
    subsByEmail[email].push(s);
  }

  console.log(`  Subs sem email no customer: ${missingEmail}`);
  console.log(`  Emails unicos com sub ativa: ${Object.keys(subsByEmail).length}`);
  console.log('');

  // Busca subscribers desses emails
  console.log('▶ Buscando subscribers no Supabase...');
  const subscribers = await fetchSubscribersByEmails(Object.keys(subsByEmail));
  const subByEmail = {};
  for (const s of subscribers) {
    subByEmail[String(s.email).toLowerCase()] = s;
  }
  console.log(`  Subscribers encontrados: ${subscribers.length} de ${Object.keys(subsByEmail).length}`);
  console.log('');

  // Classifica casos
  const A_orphans = [];      // Sem subscriber
  const B_zombies = [];      // plan=free
  const C_duplicates = [];   // multiplas subs mesmo email
  const D_stale_cust = [];   // stripe_customer_id diferente
  const E_healthy = [];

  for (const email of Object.keys(subsByEmail)) {
    const subs = subsByEmail[email];
    const sub_db = subByEmail[email];

    if (subs.length > 1) {
      C_duplicates.push({ email, count: subs.length, stripe_subs: subs.map(s => ({ id: s.id, customer: s.customer?.id || s.customer, plan_amount: (s.items?.data?.[0]?.price?.unit_amount/100).toFixed(2), price_id: s.items?.data?.[0]?.price?.id })), db: sub_db || null });
    }

    if (!sub_db) {
      for (const s of subs) {
        A_orphans.push({ email, stripe_sub_id: s.id, customer: s.customer?.id || s.customer, amount: (s.items?.data?.[0]?.price?.unit_amount/100).toFixed(2), created: new Date(s.created*1000).toISOString().slice(0,19) });
      }
      continue;
    }

    // Classifica cada sub
    for (const s of subs) {
      const customerId = s.customer?.id || s.customer;
      const isZombie = (!sub_db.plan || sub_db.plan === 'free');
      const isStale = sub_db.stripe_customer_id && sub_db.stripe_customer_id !== customerId;

      if (isZombie) {
        B_zombies.push({ email, db_plan: sub_db.plan, stripe_sub_id: s.id, customer: customerId, amount: (s.items?.data?.[0]?.price?.unit_amount/100).toFixed(2), db_customer: sub_db.stripe_customer_id });
      } else if (isStale) {
        D_stale_cust.push({ email, db_plan: sub_db.plan, stripe_sub_id: s.id, stripe_customer: customerId, db_customer: sub_db.stripe_customer_id });
      } else {
        E_healthy.push({ email, db_plan: sub_db.plan, stripe_sub_id: s.id });
      }
    }
  }

  console.log('═══ RESUMO ═══');
  console.log(`A) Subs ATIVAS sem subscriber no DB        : ${A_orphans.length}`);
  console.log(`B) Subs ATIVAS com subscriber.plan=free   : ${B_zombies.length}`);
  console.log(`C) Emails com MULTIPLAS subs ativas        : ${C_duplicates.length}`);
  console.log(`D) Subs ATIVAS com customer_id stale       : ${D_stale_cust.length}`);
  console.log(`E) Subs ATIVAS saudaveis                   : ${E_healthy.length}`);
  console.log('');

  if (A_orphans.length) {
    console.log('═══ A) ORFAS (no subscriber DB row) ═══');
    A_orphans.forEach(o => console.log(`  ${o.email} | sub:${o.stripe_sub_id} | R$${o.amount} | cust:${o.customer} | criada:${o.created}`));
    console.log('');
  }
  if (B_zombies.length) {
    console.log('═══ B) ZUMBIS (paga mas plan=free) ═══');
    B_zombies.forEach(z => console.log(`  ${z.email} | sub:${z.stripe_sub_id} | R$${z.amount} | db_plan:${z.db_plan} | stripe_cust:${z.customer} | db_cust:${z.db_customer}`));
    console.log('');
  }
  if (C_duplicates.length) {
    console.log('═══ C) DUPLICADAS (multiplas subs no mesmo email) ═══');
    C_duplicates.forEach(d => {
      console.log(`  ${d.email} | ${d.count} subs ativas`);
      d.stripe_subs.forEach(s => console.log(`    - ${s.id} | R$${s.plan_amount} | cust:${s.customer}`));
    });
    console.log('');
  }
  if (D_stale_cust.length) {
    console.log('═══ D) STALE customer_id (DB aponta pra customer antigo) ═══');
    D_stale_cust.forEach(s => console.log(`  ${s.email} | sub:${s.stripe_sub_id} | stripe_cust:${s.stripe_customer} | db_cust:${s.db_customer}`));
    console.log('');
  }

  // Salva JSON
  const outPath = path.join(__dirname, 'audit-output.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    total_active_stripe_subs: allSubs.length,
    unique_emails: Object.keys(subsByEmail).length,
    summary: {
      A_orphans: A_orphans.length,
      B_zombies: B_zombies.length,
      C_duplicates: C_duplicates.length,
      D_stale_cust: D_stale_cust.length,
      E_healthy: E_healthy.length,
    },
    A_orphans, B_zombies, C_duplicates, D_stale_cust,
  }, null, 2));
  console.log(`Salvo: ${outPath}`);
})();
