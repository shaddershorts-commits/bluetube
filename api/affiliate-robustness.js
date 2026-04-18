// api/affiliate-robustness.js
// Crons de robustez do sistema de afiliados:
//   GET ?action=process-queue — consome commission_patch_queue (a cada 15min)
//   GET ?action=reconcile — compara total_earnings vs soma commissions (diario)
//
// Ambos sao invisiveis pro afiliado. Apenas corrigem drift silenciosamente e
// notificam admin por email se encontrarem algo relevante.

module.exports = async function handler(req, res) {
  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  if (!SU || !SK) return res.status(500).json({ error: 'Config ausente' });
  const h = { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json' };
  const action = req.query?.action;

  if (action === 'process-queue') return processQueue(req, res, { SU, h, RESEND_KEY, ADMIN_EMAIL });
  if (action === 'reconcile')     return reconcile(req, res,    { SU, h, RESEND_KEY, ADMIN_EMAIL });
  return res.status(400).json({ error: 'action invalida', valid: ['process-queue', 'reconcile'] });
};

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS QUEUE — consome commission_patch_queue
// ─────────────────────────────────────────────────────────────────────────────
async function processQueue(req, res, { SU, h, RESEND_KEY, ADMIN_EMAIL }) {
  try {
    const r = await fetch(
      `${SU}/rest/v1/commission_patch_queue?status=eq.pending&tentativas=lt.5&select=*&order=created_at.asc&limit=50`,
      { headers: h }
    );
    const queue = r.ok ? await r.json() : [];
    let processados = 0, sucesso = 0, falhou = 0, aguardando = 0;

    for (const item of queue) {
      processados++;
      const tentativas = (item.tentativas || 0) + 1;
      try {
        // Busca a linha da comissao
        const cur = await fetch(
          `${SU}/rest/v1/affiliate_commissions?affiliate_id=eq.${item.affiliate_id}&subscriber_email=eq.${encodeURIComponent(item.subscriber_email)}&plan=eq.${item.plan}&status=in.(pending,paid)&order=created_at.desc&limit=1&select=id,commission_amount,commission_rate,plan_amount,commission_history`,
          { headers: h }
        );
        const [row] = cur.ok ? await cur.json() : [];
        if (!row) {
          // auth.js ainda nao criou — vai tentar no proximo cron. Se passar de
          // 5 tentativas, marca failed.
          aguardando++;
          await fetch(`${SU}/rest/v1/commission_patch_queue?id=eq.${item.id}`, {
            method: 'PATCH', headers: h,
            body: JSON.stringify({
              tentativas,
              status: tentativas >= 5 ? 'failed' : 'pending',
              last_error: 'commission_row_not_found_after_retry',
            }),
          });
          continue;
        }

        const paidAmount = parseFloat(item.paid_amount || 0);
        const rate = parseFloat(item.rate || 0);
        const correctedAmount = parseFloat((paidAmount * rate).toFixed(2));
        const prev = parseFloat(row.commission_amount || 0);
        const delta = parseFloat((correctedAmount - prev).toFixed(2));

        const history = Array.isArray(row.commission_history) ? row.commission_history : [];
        history.push({
          at: new Date().toISOString(),
          source: `queue_retry_${item.source}`,
          prev_amount: prev, new_amount: correctedAmount,
          prev_rate: parseFloat(row.commission_rate || 0), new_rate: rate,
          prev_plan_amount: parseFloat(row.plan_amount || 0), new_plan_amount: paidAmount,
          coupon_applied: !!item.coupon_applied,
          coupon_discount: parseFloat(item.coupon_discount || 0),
          queue_id: item.id,
        });

        const patchBody = {
          commission_rate: rate,
          commission_amount: correctedAmount,
          plan_amount: paidAmount,
          commission_history: history,
        };
        if (item.coupon_applied) patchBody.coupon_applied = true;
        if (item.coupon_discount > 0) patchBody.coupon_discount = parseFloat(item.coupon_discount);

        const pr = await fetch(`${SU}/rest/v1/affiliate_commissions?id=eq.${row.id}`, {
          method: 'PATCH', headers: h, body: JSON.stringify(patchBody),
        });
        if (!pr.ok) throw new Error(`patch_failed_${pr.status}`);

        // Atualiza total_earnings do afiliado
        if (delta !== 0) {
          const affR = await fetch(`${SU}/rest/v1/affiliates?id=eq.${item.affiliate_id}&select=total_earnings`, { headers: h });
          const [aff] = affR.ok ? await affR.json() : [];
          if (aff) {
            await fetch(`${SU}/rest/v1/affiliates?id=eq.${item.affiliate_id}`, {
              method: 'PATCH', headers: h,
              body: JSON.stringify({
                total_earnings: parseFloat(((parseFloat(aff.total_earnings) || 0) + delta).toFixed(2)),
                updated_at: new Date().toISOString(),
              }),
            });
          }
        }

        await fetch(`${SU}/rest/v1/commission_patch_queue?id=eq.${item.id}`, {
          method: 'PATCH', headers: h,
          body: JSON.stringify({
            status: 'success', tentativas, processed_at: new Date().toISOString(),
          }),
        });
        sucesso++;
      } catch (err) {
        falhou++;
        await fetch(`${SU}/rest/v1/commission_patch_queue?id=eq.${item.id}`, {
          method: 'PATCH', headers: h,
          body: JSON.stringify({
            tentativas,
            status: tentativas >= 5 ? 'failed' : 'pending',
            last_error: err.message?.slice(0, 500) || 'unknown',
          }),
        });
      }
    }

    // Se teve itens virando 'failed', avisa admin
    if (falhou > 0 || aguardando > 0) {
      const failedNow = await fetch(
        `${SU}/rest/v1/commission_patch_queue?status=eq.failed&select=id,subscriber_email,plan,last_error&limit=20`,
        { headers: h }
      );
      const failedRows = failedNow.ok ? await failedNow.json() : [];
      if (failedRows.length > 0) {
        await notifyAdmin({ RESEND_KEY, ADMIN_EMAIL }, 'Fila de comissao com itens permanentemente falhos', [
          ['Total permanente falhos', String(failedRows.length)],
          ['Exemplos', failedRows.slice(0, 5).map(f => `${f.subscriber_email} (${f.plan}): ${f.last_error}`).join(' | ') || '—'],
        ]);
      }
    }

    return res.status(200).json({ ok: true, processados, sucesso, falhou, aguardando });
  } catch (e) {
    console.error('[process-queue] erro geral:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RECONCILE — compara affiliate.total_earnings vs SUM(commission_amount)
// ─────────────────────────────────────────────────────────────────────────────
async function reconcile(req, res, { SU, h, RESEND_KEY, ADMIN_EMAIL }) {
  try {
    // Pega todos afiliados
    const ar = await fetch(`${SU}/rest/v1/affiliates?select=id,email,total_earnings`, { headers: h });
    const affiliates = ar.ok ? await ar.json() : [];

    // Pega todas comissoes nao-refunded agrupadas em memoria
    const cr = await fetch(
      `${SU}/rest/v1/affiliate_commissions?status=in.(pending,paid)&select=affiliate_id,commission_amount`,
      { headers: h }
    );
    const commissions = cr.ok ? await cr.json() : [];

    const byAff = new Map();
    commissions.forEach(c => {
      const id = c.affiliate_id;
      const amt = parseFloat(c.commission_amount || 0);
      byAff.set(id, (byAff.get(id) || 0) + amt);
    });

    const drifts = [];
    for (const aff of affiliates) {
      const stored = parseFloat(aff.total_earnings || 0);
      const real = parseFloat((byAff.get(aff.id) || 0).toFixed(2));
      const diff = parseFloat((real - stored).toFixed(2));
      if (Math.abs(diff) > 0.01) {
        drifts.push({
          affiliate_id: aff.id, email: aff.email,
          stored, real, diff,
        });
      }
    }

    // Corrige total_earnings dos que driftaram (source of truth = soma das commissions)
    let ajustados = 0;
    for (const d of drifts) {
      try {
        await fetch(`${SU}/rest/v1/affiliates?id=eq.${d.affiliate_id}`, {
          method: 'PATCH', headers: h,
          body: JSON.stringify({ total_earnings: d.real, updated_at: new Date().toISOString() }),
        });
        ajustados++;
      } catch (e) { console.error('[reconcile] patch falhou', d.email, e.message); }
    }

    // Log
    await fetch(`${SU}/rest/v1/affiliate_reconcile_log`, {
      method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        afiliados_checados: affiliates.length,
        drifts_detectados: drifts.length,
        ajustes_aplicados: ajustados,
        detalhes: drifts.slice(0, 100),
      }),
    }).catch(() => {});

    // Notifica admin se tiver drift
    if (drifts.length > 0) {
      await notifyAdmin({ RESEND_KEY, ADMIN_EMAIL }, `Reconciliacao de afiliados — ${drifts.length} drift(s) corrigido(s)`, [
        ['Afiliados checados', String(affiliates.length)],
        ['Drifts detectados', String(drifts.length)],
        ['Ajustes aplicados', String(ajustados)],
        ['Exemplos', drifts.slice(0, 5).map(d => `${d.email}: guardado R$${d.stored.toFixed(2)} → real R$${d.real.toFixed(2)} (diff ${d.diff >= 0 ? '+' : ''}${d.diff.toFixed(2)})`).join(' | ')],
      ]);
    }

    return res.status(200).json({
      ok: true,
      afiliados_checados: affiliates.length,
      drifts_detectados: drifts.length,
      ajustes_aplicados: ajustados,
    });
  } catch (e) {
    console.error('[reconcile] erro geral:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper — notifica admin via Resend
// ─────────────────────────────────────────────────────────────────────────────
async function notifyAdmin({ RESEND_KEY, ADMIN_EMAIL }, subject, rows) {
  if (!RESEND_KEY || !ADMIN_EMAIL) return;
  const body = rows.map(([k, v]) =>
    `<tr><td style="padding:8px 12px;color:rgba(150,190,230,.5);font-size:12px;white-space:nowrap">${k}</td><td style="padding:8px 12px;font-size:13px;font-weight:600;word-break:break-word">${v}</td></tr>`
  ).join('');
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'BlueTube <noreply@bluetubeviral.com>',
        to: [ADMIN_EMAIL],
        subject: `[Afiliados · robustez] ${subject}`,
        html: `<div style="font-family:-apple-system,sans-serif;max-width:620px;margin:0 auto;background:#0a1628;color:#e8f4ff;border-radius:16px;overflow:hidden;border:1px solid rgba(0,170,255,.2)">
          <div style="background:linear-gradient(135deg,#1a6bff,#00aaff);padding:18px 24px">
            <div style="font-size:16px;font-weight:800;color:#fff">${subject}</div>
          </div>
          <table style="width:100%;border-collapse:collapse;padding:8px">${body}</table>
        </div>`,
      }),
    });
  } catch (e) { console.error('[notifyAdmin] erro:', e.message); }
}
