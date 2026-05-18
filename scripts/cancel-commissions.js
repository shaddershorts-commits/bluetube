#!/usr/bin/env node
// scripts/cancel-commissions.js
// Marca comissoes especificas como 'cancelled' (afiliado nao recebe).
// NAO decrementa total_earnings porque pending ainda nao foi computado nessa soma.
// Adiciona entry em commission_history pra audit.

const SU = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY;
if (!SU || !SK) { console.error('Missing env'); process.exit(1); }

const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

const TO_CANCEL = [
  { id: '0766b5b4-...', email: 'espacoquizz@gmail.com',       motivo: 'Zumbi pagante (sub cancelada sem renovação possível)' },
  { id: '65adf794-...', email: 'arturmedeiros2018@gmail.com', motivo: 'Sub cancelada (Felipe pediu não cobrar de novo)' },
  { id: '847e86aa-...', email: 'brunoadaodasilvabarbosa@gmail.com (Full)', motivo: 'Bruno está no Master agora — comissão Full não aplica' },
];

// IDs PRECISOS pegos da query anterior (preciso buscar pelo id completo na hora)
async function findCommissionId(email, plan) {
  const r = await fetch(
    `${SU}/rest/v1/affiliate_commissions?subscriber_email=eq.${encodeURIComponent(email)}&plan=eq.${plan}&status=eq.pending&order=created_at.desc&limit=1`,
    { headers: h }
  );
  const arr = r.ok ? await r.json() : [];
  return arr[0] || null;
}

(async () => {
  const targets = [
    { email: 'espacoquizz@gmail.com',           plan: 'master', motivo: 'Zumbi pagante — sub cancelada hoje, sem renovação possível' },
    { email: 'arturmedeiros2018@gmail.com',     plan: 'full',   motivo: 'Sub cancelada hoje (Felipe pediu)' },
    { email: 'brunoadaodasilvabarbosa@gmail.com', plan: 'full', motivo: 'Bruno está no Master (sub Full era duplicação cancelada hoje)' },
  ];

  console.log('═══ Cancel commissions ═══');
  let okCount = 0, errCount = 0;

  for (const t of targets) {
    const row = await findCommissionId(t.email, t.plan);
    if (!row) {
      console.log(`  ⚠️  Sem pending encontrada pra ${t.email} (${t.plan})`);
      continue;
    }

    const history = Array.isArray(row.commission_history) ? row.commission_history : [];
    history.push({
      at: new Date().toISOString(),
      source: 'manual_cancel_script',
      prev_status: row.status,
      new_status: 'cancelled',
      prev_amount: parseFloat(row.commission_amount || 0),
      new_amount: 0,
      motivo: t.motivo,
    });

    const r = await fetch(`${SU}/rest/v1/affiliate_commissions?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'cancelled',
        refunded_at: new Date().toISOString(),
        commission_history: history,
      })
    });

    if (r.ok) {
      console.log(`  ✅ ${t.email} (${t.plan}) — R$${row.commission_amount} → cancelled`);
      okCount++;
    } else {
      const err = await r.text().catch(() => '');
      console.log(`  ❌ ${t.email} — falhou: ${r.status} ${err.slice(0,150)}`);
      errCount++;
    }
  }

  console.log('');
  console.log(`Resultado: ${okCount} OK, ${errCount} erros`);
})();
