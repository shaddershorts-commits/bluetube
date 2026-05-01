// api/audit-stripe-zumbis.js
//
// Auditoria CRITICA pra detectar SUBSCRIPTIONS ZUMBIS — caso onde:
//   - subscriber.plan = 'free' (perdeu acesso)
//   - subscription.status = 'active' no Stripe (continua cobrando)
// Ou seja, user esta pagando sem receber. Caso real do Joao Paulo
// 2026-04-30: refund manual sem cancel sub → Stripe rebillou → user cobrado
// e ficou free.
//
// Roda diario via cron (9h UTC = 6h BRT) + manual via /api/audit-stripe-zumbis
// Email pro admin com lista. Tambem detecta inverso: subscriber paying mas
// sub Stripe deletada (caso tipo victorprocesso — pagou mas continuou free).
//
// Usa pool YouTube? NAO — checa Stripe direto.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'BlueTube <bluetubeoficial@bluetubeviral.com>';

const supaH = SUPABASE_SERVICE_KEY ? {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY,
  'Content-Type': 'application/json',
} : null;

// Stripe API helper minimal (sem SDK pesado)
async function stripeGet(path) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET}` },
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Stripe ${r.status}: ${txt.slice(0, 200)}`);
  }
  return r.json();
}

module.exports = async function handler(req, res) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !STRIPE_SECRET) {
    return res.status(500).json({ error: 'config_missing' });
  }

  // Fase C2 — auto_fix=1 (query) ou {auto_fix:true} (body) chama
  // refund-and-cancel pra cada zumbi pagante detectado. Guardrails:
  //   - max 5 zumbis por execucao (se mais, algo MUITO errado, nao auto-fix)
  //   - skip_email=true (admin recebe email do cron, decide manualmente)
  //   - exige ADMIN_SECRET env var (mesmo do endpoint admin)
  const auto_fix = req.query?.auto_fix === '1' || req.query?.auto_fix === 'true' || (req.body && req.body.auto_fix === true);

  const startTs = Date.now();
  const zumbis_pagantes = []; // free no DB MAS active no Stripe — CRITICO
  const zumbis_orfaos = [];   // paid no DB MAS deleted no Stripe — bug menor
  let total_checados = 0;
  let stripe_errors = 0;

  try {
    // 1. Subscribers com stripe_subscription_id (qualquer status)
    const subsR = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?stripe_subscription_id=not.is.null&select=email,plan,is_manual,plan_expires_at,stripe_customer_id,stripe_subscription_id,updated_at`,
      { headers: supaH }
    );
    const subs = subsR.ok ? await subsR.json() : [];

    for (const sub of subs) {
      total_checados++;
      try {
        const stripeSub = await stripeGet(`subscriptions/${sub.stripe_subscription_id}`);
        const stripeStatus = stripeSub.status; // active | trialing | past_due | canceled | unpaid | incomplete

        // CASO A — plan free no DB MAS active no Stripe = ZUMBI PAGANTE (cobrar sem dar acesso)
        if (sub.plan === 'free' && (stripeStatus === 'active' || stripeStatus === 'trialing' || stripeStatus === 'past_due')) {
          zumbis_pagantes.push({
            email: sub.email,
            plan_db: sub.plan,
            stripe_status: stripeStatus,
            is_manual: sub.is_manual,
            customer_id: sub.stripe_customer_id,
            subscription_id: sub.stripe_subscription_id,
            current_period_end: stripeSub.current_period_end ? new Date(stripeSub.current_period_end * 1000).toISOString() : null,
            ultimo_update_db: sub.updated_at,
          });
        }

        // CASO B — plan paid no DB MAS canceled/incomplete no Stripe = ORFAO
        if ((sub.plan === 'full' || sub.plan === 'master') && (stripeStatus === 'canceled' || stripeStatus === 'incomplete_expired')) {
          // Soft case: se is_manual=true, admin marcou explicitamente, OK
          if (!sub.is_manual) {
            zumbis_orfaos.push({
              email: sub.email,
              plan_db: sub.plan,
              stripe_status: stripeStatus,
              subscription_id: sub.stripe_subscription_id,
              ultimo_update_db: sub.updated_at,
            });
          }
        }
      } catch (e) {
        stripe_errors++;
        console.error('[audit-stripe-zumbis]', sub.email, e.message);
      }
    }

    // Fase C2 — auto-fix dos zumbis pagantes (com guardrails)
    let auto_fix_status = null;
    let auto_fix_results = [];
    if (auto_fix) {
      const ADMIN_SECRET = process.env.ADMIN_SECRET;
      const SITE_URL = process.env.SITE_URL || 'https://bluetubeviral.com';
      if (!ADMIN_SECRET) {
        auto_fix_status = 'skipped_sem_admin_secret';
      } else if (zumbis_pagantes.length === 0) {
        auto_fix_status = 'skipped_sem_zumbis';
      } else if (zumbis_pagantes.length > 5) {
        auto_fix_status = `skipped_demais_zumbis_${zumbis_pagantes.length}_acima_de_5`;
      } else {
        auto_fix_status = `executado_${zumbis_pagantes.length}_zumbi(s)`;
        for (const z of zumbis_pagantes) {
          try {
            const r = await fetch(`${SITE_URL}/api/admin`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_SECRET}` },
              body: JSON.stringify({
                action: 'refund-and-cancel',
                email: z.email,
                dry_run: false,
                skip_email: true,
              }),
            });
            const body = await r.json().catch(() => null);
            auto_fix_results.push({ email: z.email, http: r.status, ok: r.ok, acoes: body?.acoes });
          } catch (e) {
            auto_fix_results.push({ email: z.email, error: e.message });
          }
        }
      }
    }

    // Email pro admin SE houver problemas
    const tem_problema = zumbis_pagantes.length > 0 || zumbis_orfaos.length > 0;
    if (tem_problema && RESEND_KEY && ADMIN_EMAIL) {
      const html = renderEmailHtml({ zumbis_pagantes, zumbis_orfaos, total_checados, stripe_errors, auto_fix_status, auto_fix_results });
      const subjectExtra = auto_fix && auto_fix_status?.startsWith('executado') ? ' (AUTO-FIX rodou)' : '';
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: ADMIN_EMAIL,
          subject: `🚨 Audit Stripe — ${zumbis_pagantes.length} zumbi(s) pagante(s), ${zumbis_orfaos.length} orfao(s)${subjectExtra}`,
          html,
        }),
      }).catch((e) => console.error('[audit-stripe-zumbis] email falhou:', e.message));
    }

    return res.status(200).json({
      ok: true,
      duracao_ms: Date.now() - startTs,
      total_checados,
      stripe_errors,
      zumbis_pagantes_count: zumbis_pagantes.length,
      zumbis_orfaos_count: zumbis_orfaos.length,
      zumbis_pagantes,
      zumbis_orfaos,
      auto_fix_status,
      auto_fix_results,
    });
  } catch (e) {
    console.error('[audit-stripe-zumbis] erro fatal:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

function renderEmailHtml({ zumbis_pagantes, zumbis_orfaos, total_checados, stripe_errors, auto_fix_status, auto_fix_results }) {
  const tabela = (arr, titulo, cor) => {
    if (!arr.length) return '';
    return `
      <h3 style="color:${cor};font-size:16px;margin:24px 0 8px">${titulo} (${arr.length})</h3>
      <table cellpadding="6" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-size:12px">
        <tr style="background:rgba(255,255,255,.04)">
          <th align="left" style="padding:8px;color:#7d92b8">Email</th>
          <th align="left" style="padding:8px;color:#7d92b8">Plan DB</th>
          <th align="left" style="padding:8px;color:#7d92b8">Stripe Status</th>
          <th align="left" style="padding:8px;color:#7d92b8">Sub ID</th>
        </tr>
        ${arr.map(z => `<tr style="border-top:1px solid #1a2740">
          <td style="padding:8px;color:#fff;font-weight:700">${escHtml(z.email)}</td>
          <td style="padding:8px;color:${z.plan_db === 'free' ? '#fca5a5' : '#86efac'}">${z.plan_db}</td>
          <td style="padding:8px;color:#fbbf24;font-family:monospace">${z.stripe_status}</td>
          <td style="padding:8px;color:#7d92b8;font-family:monospace;font-size:11px">${escHtml(z.subscription_id)}</td>
        </tr>`).join('')}
      </table>`;
  };
  return `<!DOCTYPE html><html><body style="margin:0;padding:30px;background:#020817;font-family:Arial,sans-serif;color:#fff">
    <div style="max-width:720px;margin:0 auto;background:#0a1220;border-radius:12px;padding:28px">
      <div style="font-size:22px;font-weight:800;color:#fbbf24;margin-bottom:6px">🚨 Audit Stripe — Inconsistências Detectadas</div>
      <div style="font-size:12px;color:#7d92b8;margin-bottom:20px;font-family:monospace">${total_checados} subscribers checados · ${stripe_errors} erro(s) Stripe</div>

      ${tabela(zumbis_pagantes, '🔴 ZUMBIS PAGANTES — cobrando mas plan=free (CRITICO)', '#fca5a5')}
      ${tabela(zumbis_orfaos, '🟡 ÓRFÃOS — plan=paid mas Stripe canceled', '#fbbf24')}

      ${auto_fix_status ? `
      <div style="margin-top:24px;padding:14px;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.3);border-radius:10px;font-size:12px;color:#86efac;line-height:1.5">
        <strong>🤖 Auto-fix:</strong> ${escHtml(auto_fix_status)}
        ${(auto_fix_results || []).length ? '<ul style="margin:8px 0 0 16px;padding:0">' + auto_fix_results.map(r => `<li>${escHtml(r.email)} — ${r.ok ? '✓ ok (HTTP ' + r.http + ')' : '✗ falhou' + (r.error ? ': ' + escHtml(r.error) : ' (HTTP ' + r.http + ')')}</li>`).join('') + '</ul>' : ''}
      </div>` : ''}

      <div style="margin-top:24px;padding:14px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);border-radius:10px;font-size:12px;color:#fca5a5;line-height:1.5">
        <strong>Ação recomendada pra zumbis pagantes</strong>: clicar no botão 💸 da linha do user no painel admin (faz refund + cancel atomic). Ou via API: POST /api/admin {action:'refund-and-cancel', email}.
        ${auto_fix_status ? '' : 'Pra ativar auto-fix automatico: chamar com <code>?auto_fix=1</code>.'}
      </div>
    </div></body></html>`;
}

function escHtml(s) {
  return String(s || '').replace(/[<>"&]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' }[c]));
}
