// api/payment-monitor.js — Cron job (*/10 * * * *)
// Reconcilia pagamentos Stripe ↔ Supabase e notifica admin de problemas.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY    = process.env.RESEND_API_KEY;
  const ADMIN_EMAIL   = process.env.ADMIN_EMAIL;

  // GET = health check
  if (req.method === 'GET' && !req.headers['x-vercel-cron']) {
    return res.status(200).json({
      ok: true,
      status: 'Payment Monitor online',
      env: { stripe: !!STRIPE_SECRET, supabase: !!SUPABASE_URL, resend: !!RESEND_KEY, admin_email: !!ADMIN_EMAIL }
    });
  }

  if (!STRIPE_SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({ ok: false, error: 'Missing env vars' });
  }

  const supaHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  const results = { reconciled: 0, abandoned: 0, webhook_errors: 0, notifications: 0 };

  try {
    // ═══════════════════════════════════════════════════════════════════════════
    // 1. RECONCILE: Pagamentos aprovados no Stripe vs plano no Supabase
    // ═══════════════════════════════════════════════════════════════════════════
    const fifteenMinAgo = Math.floor((Date.now() - 15 * 60 * 1000) / 1000);
    const params = new URLSearchParams({
      'status': 'complete',
      'created[gte]': String(fifteenMinAgo),
      'limit': '50',
      'expand[]': 'data.customer_details'
    });

    const sessionsRes = await fetch(`https://api.stripe.com/v1/checkout/sessions?${params}`, {
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` }
    });

    if (sessionsRes.ok) {
      const sessionsData = await sessionsRes.json();
      const sessions = sessionsData.data || [];

      for (const session of sessions) {
        const email = session.customer_details?.email || session.customer_email;
        const plan = session.metadata?.plan;
        const billing = session.metadata?.billing || 'monthly';
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        if (!email || !plan) continue;

        // Check subscriber in Supabase
        const subRes = await fetch(
          `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=plan,plan_expires_at,stripe_customer_id`,
          { headers: supaHeaders }
        );

        if (!subRes.ok) continue;
        const subs = await subRes.json();
        const sub = Array.isArray(subs) ? subs[0] : null;

        // Discrepancy: paid in Stripe but still free (or no record) in Supabase
        const needsFix = !sub || sub.plan === 'free' || (sub.plan !== plan && plan !== 'free');

        if (needsFix) {
          const sessionAge = Date.now() - (session.created * 1000);
          const expiresAt = billing === 'annual'
            ? new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString()
            : new Date(Date.now() + 37 * 24 * 60 * 60 * 1000).toISOString();

          const payload = {
            plan,
            is_manual: false,
            stripe_customer_id: customerId || null,
            stripe_subscription_id: subscriptionId || null,
            plan_expires_at: expiresAt,
            updated_at: new Date().toISOString()
          };

          // Try PATCH, then POST
          const patchRes = await fetch(
            `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`,
            { method: 'PATCH', headers: { ...supaHeaders, 'Prefer': 'return=representation' }, body: JSON.stringify(payload) }
          );
          const patchData = await patchRes.json();

          if (Array.isArray(patchData) && patchData.length === 0) {
            await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
              method: 'POST',
              headers: { ...supaHeaders, 'Prefer': 'return=minimal' },
              body: JSON.stringify({ email, ...payload, created_at: new Date().toISOString() })
            });
          }

          results.reconciled++;
          console.log(`[payment-monitor] ✅ Reconciled: ${email} → ${plan}`);

          // Log transaction
          await logTransaction(supaHeaders, {
            stripe_session_id: session.id,
            user_email: email,
            plan,
            amount: session.amount_total ? (session.amount_total / 100).toFixed(2) : plan === 'master' ? '89.99' : '29.99',
            status: 'reconciled',
            note: `Auto-reconciled after ${Math.round(sessionAge / 60000)}min delay`
          });

          // Notify if took more than 5 minutes
          if (sessionAge > 5 * 60 * 1000) {
            await sendEmail('payment_delayed', {
              email,
              plan,
              delay: Math.round(sessionAge / 60000),
              sessionId: session.id
            });
            results.notifications++;
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 2. ABANDONED CHECKOUTS: Started but not completed in 30+ minutes
    // ═══════════════════════════════════════════════════════════════════════════
    const thirtyMinAgo = Math.floor((Date.now() - 30 * 60 * 1000) / 1000);
    const sixtyMinAgo = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);

    const abandonedParams = new URLSearchParams({
      'status': 'open',
      'created[gte]': String(sixtyMinAgo),
      'created[lte]': String(thirtyMinAgo),
      'limit': '20'
    });

    const abandonedRes = await fetch(`https://api.stripe.com/v1/checkout/sessions?${abandonedParams}`, {
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` }
    });

    if (abandonedRes.ok) {
      const abandonedData = await abandonedRes.json();
      const abandoned = abandonedData.data || [];

      if (abandoned.length > 0) {
        results.abandoned = abandoned.length;

        for (const session of abandoned) {
          await logTransaction(supaHeaders, {
            stripe_session_id: session.id,
            user_email: session.customer_email || session.customer_details?.email || 'unknown',
            plan: session.metadata?.plan || 'unknown',
            amount: '0',
            status: 'abandoned',
            note: `Checkout abandoned after ${Math.round((Date.now() - session.created * 1000) / 60000)}min`
          });
        }

        // Notify admin of abandoned checkouts (batch)
        await sendEmail('abandoned_checkouts', {
          count: abandoned.length,
          sessions: abandoned.map(s => ({
            email: s.customer_email || 'unknown',
            plan: s.metadata?.plan || '?',
            minutes: Math.round((Date.now() - s.created * 1000) / 60000)
          }))
        });
        results.notifications++;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 3. WEBHOOK HEALTH: Check recent failed events in Stripe
    // ═══════════════════════════════════════════════════════════════════════════
    const eventsParams = new URLSearchParams({
      'type': 'checkout.session.completed',
      'created[gte]': String(fifteenMinAgo),
      'limit': '20'
    });

    const eventsRes = await fetch(`https://api.stripe.com/v1/events?${eventsParams}`, {
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` }
    });

    if (eventsRes.ok) {
      const eventsData = await eventsRes.json();
      const events = eventsData.data || [];

      for (const event of events) {
        // Check if this event has pending webhook deliveries
        if (event.pending_webhooks > 0) {
          results.webhook_errors++;
        }
      }

      if (results.webhook_errors > 0) {
        await sendEmail('webhook_issues', {
          count: results.webhook_errors,
          note: `${results.webhook_errors} evento(s) com webhooks pendentes nos últimos 15min`
        });
        results.notifications++;
      }
    }

    return res.status(200).json({ ok: true, ...results, timestamp: new Date().toISOString() });

  } catch (err) {
    console.error('[payment-monitor] Error:', err);
    return res.status(200).json({ ok: false, error: err.message });
  }

  // ── HELPERS ──────────────────────────────────────────────────────────────────

  async function logTransaction(headers, data) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/payment_logs`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          stripe_session_id: data.stripe_session_id,
          user_email: data.user_email,
          plan: data.plan,
          amount: parseFloat(data.amount) || 0,
          status: data.status,
          note: data.note || null,
          created_at: new Date().toISOString()
        })
      });
    } catch (e) {
      // payment_logs table might not exist yet — fail silently
      console.warn('[payment-monitor] Log failed (table may not exist):', e.message);
    }
  }

  async function sendEmail(type, data) {
    if (!RESEND_KEY || !ADMIN_EMAIL) return;

    const templates = {
      payment_delayed: {
        subject: `💳 Pagamento não ativou plano — ${data.email}`,
        body: `
          <p><strong>${data.email}</strong> pagou o plano <strong>${data.plan?.toUpperCase()}</strong> há <strong>${data.delay} minutos</strong> mas o plano não foi ativado automaticamente pelo webhook.</p>
          <p>O Payment Monitor corrigiu automaticamente, mas o atraso indica um problema no webhook.</p>
          <p style="color:#ff7a5a"><strong>Ação:</strong> Verifique o webhook no Stripe Dashboard → Webhooks e confirme que o endpoint está respondendo 200.</p>
          <p style="font-size:12px;color:#888">Session ID: ${data.sessionId}</p>`
      },
      abandoned_checkouts: {
        subject: `🛒 ${data.count} checkout(s) abandonado(s)`,
        body: `
          <p><strong>${data.count}</strong> usuário(s) iniciaram checkout mas não finalizaram nos últimos 30-60 minutos:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr style="border-bottom:1px solid #333"><th style="text-align:left;padding:8px;color:#888">Email</th><th style="text-align:left;padding:8px;color:#888">Plano</th><th style="text-align:left;padding:8px;color:#888">Tempo</th></tr>
            ${(data.sessions || []).map(s => `<tr style="border-bottom:1px solid #222"><td style="padding:8px">${esc(s.email)}</td><td style="padding:8px">${esc(s.plan)}</td><td style="padding:8px">${s.minutes}min</td></tr>`).join('')}
          </table>
          <p style="color:#fbbf24"><strong>Ação:</strong> Considere enviar email de recuperação ou verificar se há problemas no checkout.</p>`
      },
      webhook_issues: {
        subject: `⚠️ Webhooks Stripe com entregas pendentes`,
        body: `
          <p><strong>${data.count}</strong> evento(s) de checkout completado nos últimos 15 minutos têm webhooks com entrega pendente.</p>
          <p>Isso pode significar que o endpoint <code>/api/webhook</code> está falhando ou lento.</p>
          <p style="color:#ff7a5a"><strong>Ação:</strong> Acesse Stripe Dashboard → Developers → Webhooks e verifique os eventos com falha. Se necessário, reenvie manualmente.</p>
          <p style="font-size:12px;color:#888">${data.note}</p>`
      }
    };

    const tmpl = templates[type];
    if (!tmpl) return;

    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;background:#0a1628;color:#e8f4ff;border-radius:16px;overflow:hidden;border:1px solid rgba(0,170,255,0.2)">
  <div style="background:linear-gradient(135deg,#1a6bff,#00aaff);padding:20px 28px">
    <div style="font-size:18px;font-weight:800;color:#fff">💳 Payment Monitor</div>
    <div style="font-size:11px;color:rgba(255,255,255,0.7);margin-top:4px">${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</div>
  </div>
  <div style="padding:24px 28px">
    ${tmpl.body}
    <div style="margin-top:20px;display:flex;gap:10px">
      <a href="https://dashboard.stripe.com" style="display:inline-block;background:#635bff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:700">Stripe Dashboard →</a>
      <a href="https://vercel.com/dashboard" style="display:inline-block;background:rgba(0,170,255,0.1);border:1px solid rgba(0,170,255,0.2);color:#00aaff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px">Vercel Logs</a>
    </div>
  </div>
  <div style="padding:14px 28px;border-top:1px solid rgba(0,170,255,0.08);font-size:11px;color:rgba(150,190,230,0.3)">BlueTube Payment Monitor · Executa a cada 10 minutos</div>
</div>`;

    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: 'BlueTube Monitor <noreply@bluetubeviral.com>',
          to: [ADMIN_EMAIL],
          subject: tmpl.subject,
          html
        })
      });
    } catch (e) {
      console.error('[payment-monitor] Email failed:', e.message);
    }
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
};
