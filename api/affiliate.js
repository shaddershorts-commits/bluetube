// api/affiliate.js
// Sistema completo de afiliados — tracking, comissões, painel

import crypto from 'crypto';

const COMMISSION_RATES = { bronze: 0.35, silver: 0.40, gold: 0.58 };
const PLAN_AMOUNTS = { full: 29.99, master: 89.99 };

function getLevel(totalPaying) {
  if (totalPaying >= 1000) return 'gold';
  if (totalPaying >= 380) return 'silver';
  return 'bronze';
}

// Retorna a taxa efetiva de um afiliado:
// - Se admin setou comissao_percentual (override manual via painel), usa.
// - Senao, cai no nivel calculado por totalPaying (bronze/silver/gold).
function getEffectiveRate(affiliate, totalPaying) {
  if (affiliate && typeof affiliate.comissao_percentual === 'number' && affiliate.comissao_percentual > 0) {
    return affiliate.comissao_percentual / 100;
  }
  return COMMISSION_RATES[getLevel(totalPaying)];
}

// Idempotencia: ja existe commission paga/pending pra este afiliado+email+plano?
async function commissionAlreadyExists(SUPA_URL, supaH, affiliateId, email, plan) {
  try {
    const r = await fetch(
      `${SUPA_URL}/rest/v1/affiliate_commissions?affiliate_id=eq.${affiliateId}`
      + `&subscriber_email=eq.${encodeURIComponent(email)}`
      + `&plan=eq.${plan}`
      + `&status=in.(pending,paid)&select=id&limit=1`,
      { headers: supaH }
    );
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) { return false; }
}

function generateRefCode(email) {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const suffix = crypto.randomBytes(3).toString('hex');
  return base + suffix;
}

// Notifica afiliado por email quando nova comissao e criada (fire-and-forget)
async function notificarAfiliadoNovaComissao(affiliate, { subscriber, plan, commission_amount }) {
  const RESEND = process.env.RESEND_API_KEY;
  if (!RESEND || !affiliate?.email) return;
  const maskEmail = (e) => {
    if (!e) return '';
    const [u, d] = String(e).split('@');
    return (u?.[0] || '') + '***@' + (d || '');
  };
  const planLabel = plan === 'master' ? '👑 Master' : '⚡ Full';
  const valorFmt = 'R$ ' + Number(commission_amount || 0).toFixed(2).replace('.', ',');
  const nomeAff = (affiliate.name || affiliate.email.split('@')[0]).split(' ')[0];
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#020817;color:#e8f4ff;padding:40px 28px;border-radius:14px">
    <div style="text-align:center;margin-bottom:28px">
      <div style="display:inline-block;background:linear-gradient(135deg,#10b981,#3b82f6);color:#fff;font-weight:800;padding:8px 20px;border-radius:20px;letter-spacing:1px;font-size:11px">💰 NOVA COMISSÃO</div>
    </div>
    <h1 style="font-size:24px;font-weight:800;margin:0 0 12px;color:#fff">Boa, ${nomeAff}!</h1>
    <p style="font-size:15px;line-height:1.5;color:rgba(200,220,240,.8);margin:0 0 24px">Uma nova assinatura entrou pelo seu link de afiliado. A comissão já está no seu saldo pendente.</p>
    <div style="background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:12px;padding:20px;margin:20px 0">
      <div style="font-size:11px;color:rgba(200,220,240,.6);letter-spacing:2px;margin-bottom:8px;font-family:monospace">COMISSÃO GERADA</div>
      <div style="font-size:32px;font-weight:800;color:#10b981">${valorFmt}</div>
    </div>
    <table style="width:100%;margin:20px 0;border-collapse:collapse">
      <tr><td style="padding:8px 0;color:rgba(200,220,240,.6);font-size:13px">Assinante:</td><td style="padding:8px 0;color:#fff;text-align:right;font-family:monospace;font-size:13px">${maskEmail(subscriber)}</td></tr>
      <tr><td style="padding:8px 0;color:rgba(200,220,240,.6);font-size:13px">Plano:</td><td style="padding:8px 0;color:#fff;text-align:right;font-size:13px">${planLabel}</td></tr>
      <tr><td style="padding:8px 0;color:rgba(200,220,240,.6);font-size:13px">Status:</td><td style="padding:8px 0;text-align:right"><span style="background:rgba(251,191,36,.15);color:#fbbf24;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:700">PENDENTE</span></td></tr>
    </table>
    <div style="text-align:center;margin:28px 0">
      <a href="https://www.bluetubeviral.com/afiliado" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#00aaff);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:14px">Ver painel do afiliado →</a>
    </div>
    <p style="font-size:12px;color:rgba(200,220,240,.5);text-align:center;margin:24px 0 0;line-height:1.5">Pagamentos via Pix todo dia 22. Comissões ficam pendentes por 37 dias (garantia de reembolso) antes de liberar pra saque.</p>
  </div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'BlueAfiliados <noreply@bluetubeviral.com>',
        to: [affiliate.email],
        subject: `💰 Nova comissão: ${valorFmt}`,
        html,
      }),
    });
  } catch (e) { console.error('[notify-affiliate-email]', e.message); }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ANON_KEY = process.env.SUPABASE_ANON_KEY || SUPA_KEY;
  const supaH = {
    'Content-Type': 'application/json',
    'apikey': SUPA_KEY,
    'Authorization': `Bearer ${SUPA_KEY}`
  };

  const action = req.method === 'GET' ? req.query?.action : (req.body?.action || req.query?.action);

  // ── TRACK CLICK ────────────────────────────────────────────────────────────
  // GET /api/affiliate?action=click&ref=CODE&cookie_id=X
  if (req.method === 'GET' && action === 'click') {
    const { ref, cookie_id, referrer } = req.query;
    if (!ref) return res.status(400).json({ error: 'ref obrigatório' });

    try {
      // Busca afiliado pelo ref_code
      const ar = await fetch(`${SUPA_URL}/rest/v1/affiliates?ref_code=eq.${ref}&select=id,status`, { headers: supaH });
      const affiliates = await ar.json();
      const affiliate = affiliates?.[0];
      if (!affiliate || affiliate.status === 'suspended') {
        return res.status(404).json({ error: 'Link inválido' });
      }

      // Hash do IP para antifraude (sem guardar IP real)
      const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || '';
      const ipHash = crypto.createHash('sha256').update(ip + process.env.ADMIN_SECRET).digest('hex').slice(0, 16);

      // Fingerprint do visitor
      const ua = req.headers['user-agent'] || '';
      const lang = req.headers['accept-language'] || '';
      const fingerprint = crypto.createHash('sha256').update(ua + lang).digest('hex').slice(0, 16);

      // Registra clique
      await fetch(`${SUPA_URL}/rest/v1/affiliate_clicks`, {
        method: 'POST',
        headers: { ...supaH, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          affiliate_id: affiliate.id,
          ref_code: ref,
          cookie_id: cookie_id || null,
          ip_hash: ipHash,
          visitor_fingerprint: fingerprint,
          referrer: referrer?.slice(0, 200) || null
        })
      });

      // Incrementa total_clicks
      await fetch(`${SUPA_URL}/rest/v1/affiliates?ref_code=eq.${ref}`, {
        method: 'PATCH',
        headers: { ...supaH, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ total_clicks: (affiliate.total_clicks || 0) + 1, updated_at: new Date().toISOString() })
      }).catch(() => {});

      return res.status(200).json({ ok: true, affiliate_id: affiliate.id });
    } catch(e) {
      console.error('Affiliate click error:', e.message);
      return res.status(200).json({ ok: false });
    }
  }

  // ── REGISTER AFFILIATE ─────────────────────────────────────────────────────
  // POST { action: 'register', token, name }
  if (req.method === 'POST' && action === 'register') {
    const { token, name } = req.body;
    if (!token) return res.status(401).json({ error: 'Token obrigatório' });

    try {
      // Valida token e pega email
      const ur = await fetch(`${SUPA_URL}/auth/v1/user`, {
        headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` }
      });
      if (!ur.ok) return res.status(401).json({ error: 'Token inválido' });
      const user = await ur.json();
      const email = user.email;
      if (!email) return res.status(400).json({ error: 'Email não encontrado' });

      // Verifica se já é afiliado
      const existing = await fetch(`${SUPA_URL}/rest/v1/affiliates?email=eq.${encodeURIComponent(email)}&select=id,ref_code,status,level`, { headers: supaH });
      const existingData = await existing.json();
      if (existingData?.[0]) {
        return res.status(200).json({ affiliate: existingData[0], alreadyExists: true });
      }

      // Cria afiliado
      const refCode = generateRefCode(email);
      const r = await fetch(`${SUPA_URL}/rest/v1/affiliates`, {
        method: 'POST',
        headers: { ...supaH, 'Prefer': 'return=representation' },
        body: JSON.stringify({
          email,
          name: name || email.split('@')[0],
          ref_code: refCode,
          status: 'active', // ativo imediatamente (sem Stripe Connect por ora)
          level: 'bronze',
          terms_accepted_at: new Date().toISOString()
        })
      });
      const data = await r.json();
      return res.status(201).json({ affiliate: data[0] });
    } catch(e) {
      console.error('Register affiliate error:', e.message);
      return res.status(500).json({ error: 'Erro ao criar afiliado' });
    }
  }

  // ── GET DASHBOARD DATA ─────────────────────────────────────────────────────
  // GET ?action=dashboard&token=X
  if (req.method === 'GET' && action === 'dashboard') {
    const { token } = req.query;
    if (!token) return res.status(401).json({ error: 'Token obrigatório' });

    try {
      const ur = await fetch(`${SUPA_URL}/auth/v1/user`, {
        headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` }
      });
      if (!ur.ok) return res.status(401).json({ error: 'Token inválido' });
      const user = await ur.json();

      const ar = await fetch(`${SUPA_URL}/rest/v1/affiliates?email=eq.${encodeURIComponent(user.email)}&select=*`, { headers: supaH });
      const affiliates = await ar.json();
      const affiliate = affiliates?.[0];
      if (!affiliate) return res.status(404).json({ error: 'not_affiliate' });

      // Busca conversões
      const cr = await fetch(`${SUPA_URL}/rest/v1/affiliate_conversions?affiliate_id=eq.${affiliate.id}&select=*&order=converted_at.desc&limit=50`, { headers: supaH });
      const conversions = await cr.json() || [];

      // Busca comissões
      const cmr = await fetch(`${SUPA_URL}/rest/v1/affiliate_commissions?affiliate_id=eq.${affiliate.id}&select=*&order=created_at.desc&limit=100`, { headers: supaH });
      const commissions = await cmr.json() || [];

      // Busca clicks dos últimos 30 dias
      const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString();
      const clkr = await fetch(`${SUPA_URL}/rest/v1/affiliate_clicks?affiliate_id=eq.${affiliate.id}&landed_at=gte.${thirtyDaysAgo}&select=landed_at`, { headers: supaH });
      const clicks = await clkr.json() || [];

      // Calcula stats — usa taxa efetiva (admin override via comissao_percentual OU nivel calculado)
      const totalPaying = (affiliate.total_full || 0) + (affiliate.total_master || 0);
      const level = getLevel(totalPaying);
      const rate = getEffectiveRate(affiliate, totalPaying);

      const pendingCommissions = commissions.filter(c => c.status === 'pending');
      const paidCommissions = commissions.filter(c => c.status === 'paid');
      const pendingAmount = pendingCommissions.reduce((s, c) => s + parseFloat(c.commission_amount || 0), 0);
      const paidAmount = paidCommissions.reduce((s, c) => s + parseFloat(c.commission_amount || 0), 0);
      const mrrAffiliate = (affiliate.total_full || 0) * PLAN_AMOUNTS.full * rate +
                           (affiliate.total_master || 0) * PLAN_AMOUNTS.master * rate;

      // Próximo nível
      const nextLevelInfo = level === 'bronze'
        ? { next: 'silver', nextRate: 0.40, needed: 380 - totalPaying, total: 380 }
        : level === 'silver'
        ? { next: 'gold', nextRate: 0.58, needed: 1000 - totalPaying, total: 1000 }
        : { next: null, needed: 0, total: 1000 };

      // Clicks por dia (últimos 7 dias)
      const clicksByDay = {};
      for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i*24*60*60*1000).toISOString().split('T')[0];
        clicksByDay[d] = 0;
      }
      clicks.forEach(c => {
        const d = c.landed_at?.split('T')[0];
        if (d && clicksByDay[d] !== undefined) clicksByDay[d]++;
      });

      // Atualiza nível se mudou
      if (affiliate.level !== level) {
        fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${affiliate.id}`, {
          method: 'PATCH',
          headers: supaH,
          body: JSON.stringify({ level, updated_at: new Date().toISOString() })
        });
      }

      return res.status(200).json({
        affiliate: { ...affiliate, level },
        stats: {
          totalClicks: affiliate.total_clicks || 0,
          clicksLast30: clicks.length,
          totalFree: affiliate.total_free || 0,
          totalFull: affiliate.total_full || 0,
          totalMaster: affiliate.total_master || 0,
          totalPaying,
          mrrAffiliate: parseFloat(mrrAffiliate.toFixed(2)),
          pendingAmount: parseFloat(pendingAmount.toFixed(2)),
          paidAmount: parseFloat(paidAmount.toFixed(2)),
          totalEarnings: parseFloat((pendingAmount + paidAmount).toFixed(2)),
          commissionRate: rate,
          level,
          nextLevel: nextLevelInfo,
          clicksByDay: Object.entries(clicksByDay).map(([date, count]) => ({ date, count })),
        },
        conversions: conversions.slice(0, 20),
        recentCommissions: commissions.slice(0, 10),
      });
    } catch(e) {
      console.error('Dashboard error:', e.message);
      return res.status(500).json({ error: 'Erro ao carregar dashboard' });
    }
  }

  // ── RECORD CONVERSION ──────────────────────────────────────────────────────
  // POST { action: 'conversion', email, plan, cookie_id, stripe_customer_id }
  // Chamado internamente pelo auth.js no signup/pagamento
  if (req.method === 'POST' && action === 'conversion') {
    const { email, plan, cookie_id, stripe_customer_id, conversion_type } = req.body;
    if (!email) return res.status(400).json({ error: 'email obrigatório' });

    try {
      // Busca subscriber para pegar affiliate_ref
      const sr = await fetch(`${SUPA_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=affiliate_ref`, { headers: supaH });
      const subs = await sr.json();
      const refCode = subs?.[0]?.affiliate_ref;
      if (!refCode) return res.status(200).json({ ok: true, skipped: 'no_ref' });

      // Busca afiliado
      const ar = await fetch(`${SUPA_URL}/rest/v1/affiliates?ref_code=eq.${refCode}&select=*`, { headers: supaH });
      const affiliates = await ar.json();
      const affiliate = affiliates?.[0];
      if (!affiliate) return res.status(200).json({ ok: true, skipped: 'affiliate_not_found' });

      // Antifraude: afiliado não pode ser o próprio referido
      if (affiliate.email === email) return res.status(200).json({ ok: true, skipped: 'self_referral' });

      // Verifica se já existe conversão para este email
      const existingConv = await fetch(`${SUPA_URL}/rest/v1/affiliate_conversions?converted_email=eq.${encodeURIComponent(email)}&affiliate_id=eq.${affiliate.id}`, { headers: supaH });
      const existing = await existingConv.json();

      const type = conversion_type || (plan === 'free' ? 'signup' : `upgrade_${plan}`);

      if (!existing?.length || type !== 'signup') {
        // Registra conversão
        const convR = await fetch(`${SUPA_URL}/rest/v1/affiliate_conversions`, {
          method: 'POST',
          headers: { ...supaH, 'Prefer': 'return=representation' },
          body: JSON.stringify({
            affiliate_id: affiliate.id,
            ref_code: refCode,
            converted_email: email,
            cookie_id: cookie_id || null,
            conversion_type: type,
            plan: plan || 'free',
            stripe_customer_id: stripe_customer_id || null
          })
        });
        const conv = await convR.json();

        // Se plano pago, cria comissão (com idempotencia)
        if (plan === 'full' || plan === 'master') {
          const alreadyHas = await commissionAlreadyExists(SUPA_URL, supaH, affiliate.id, email, plan);
          if (alreadyHas) {
            console.log(`[affiliate] commission ja existe pra ${affiliate.email} ← ${email} (${plan}), skip`);
          } else {
            const totalPaying = (affiliate.total_full || 0) + (affiliate.total_master || 0) + 1;
            const rate = getEffectiveRate(affiliate, totalPaying);
            const planAmount = PLAN_AMOUNTS[plan];
            const commissionAmount = parseFloat((planAmount * rate).toFixed(2));

            await fetch(`${SUPA_URL}/rest/v1/affiliate_commissions`, {
              method: 'POST',
              headers: { ...supaH, 'Prefer': 'return=minimal' },
              body: JSON.stringify({
                affiliate_id: affiliate.id,
                conversion_id: conv?.[0]?.id || null,
                subscriber_email: email,
                plan,
                plan_amount: planAmount,
                commission_rate: rate,
                commission_amount: commissionAmount,
                status: 'pending',
                period_start: new Date().toISOString(),
                period_end: new Date(Date.now() + 37*24*60*60*1000).toISOString()
              })
            });

            // Atualiza stats do afiliado
            const field = plan === 'full' ? 'total_full' : 'total_master';
            await fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${affiliate.id}`, {
              method: 'PATCH',
              headers: supaH,
              body: JSON.stringify({
                [field]: (affiliate[field] || 0) + 1,
                total_earnings: parseFloat(((affiliate.total_earnings || 0) + commissionAmount)).toFixed(2),
                level: getLevel(totalPaying),
                updated_at: new Date().toISOString()
              })
            });

            console.log(`💰 Commission: ${affiliate.email} ← ${email} (${plan}) @ ${(rate*100).toFixed(0)}% = R$${commissionAmount.toFixed(2)}`);

            // Email de notificação pro afiliado (fire-and-forget, nao bloqueia)
            notificarAfiliadoNovaComissao(affiliate, { subscriber: email, plan, commission_amount: commissionAmount }).catch(()=>{});
          }
        } else if (plan === 'free') {
          // Incrementa total_free
          await fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${affiliate.id}`, {
            method: 'PATCH',
            headers: supaH,
            body: JSON.stringify({
              total_free: (affiliate.total_free || 0) + 1,
              updated_at: new Date().toISOString()
            })
          });
        }
      }

      return res.status(200).json({ ok: true });
    } catch(e) {
      console.error('Conversion error:', e.message);
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  // ── PROCESS RENEWAL COMMISSION ─────────────────────────────────────────────
  // POST { action: 'renewal', email, plan } — chamado pelo webhook.js
  if (req.method === 'POST' && action === 'renewal') {
    const { email, plan } = req.body;
    if (!email || !plan) return res.status(400).json({ error: 'email e plan obrigatórios' });

    try {
      // Busca conversão do afiliado para este email
      const cr = await fetch(`${SUPA_URL}/rest/v1/affiliate_conversions?converted_email=eq.${encodeURIComponent(email)}&select=affiliate_id`, { headers: supaH });
      const convs = await cr.json();
      if (!convs?.length) return res.status(200).json({ ok: true, skipped: 'no_conversion' });

      const affiliateId = convs[0].affiliate_id;
      const ar = await fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${affiliateId}&select=*`, { headers: supaH });
      const affiliates = await ar.json();
      const affiliate = affiliates?.[0];
      if (!affiliate) return res.status(200).json({ ok: true, skipped: 'no_affiliate' });

      const totalPaying = (affiliate.total_full || 0) + (affiliate.total_master || 0);
      const rate = getEffectiveRate(affiliate, totalPaying);
      const planAmount = PLAN_AMOUNTS[plan] || 0;
      const commissionAmount = parseFloat((planAmount * rate).toFixed(2));

      await fetch(`${SUPA_URL}/rest/v1/affiliate_commissions`, {
        method: 'POST',
        headers: { ...supaH, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          affiliate_id: affiliateId,
          subscriber_email: email,
          plan,
          plan_amount: planAmount,
          commission_rate: rate,
          commission_amount: commissionAmount,
          status: 'pending',
          period_start: new Date().toISOString(),
          period_end: new Date(Date.now() + 37*24*60*60*1000).toISOString()
        })
      });

      // Atualiza total_earnings
      await fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${affiliateId}`, {
        method: 'PATCH',
        headers: supaH,
        body: JSON.stringify({
          total_earnings: parseFloat((affiliate.total_earnings || 0) + commissionAmount).toFixed(2),
          updated_at: new Date().toISOString()
        })
      });

      console.log(`🔄 Renewal commission: ${affiliate.email} ← ${email} (${plan}) = $${commissionAmount.toFixed(2)}`);
      return res.status(200).json({ ok: true, commission: commissionAmount });
    } catch(e) {
      console.error('Renewal commission error:', e.message);
      return res.status(200).json({ ok: false });
    }
  }

  // ── CANCEL COMMISSION ──────────────────────────────────────────────────────
  // POST { action: 'cancel', email } — chamado pelo webhook.js no cancelamento
  if (req.method === 'POST' && action === 'cancel') {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email obrigatório' });

    try {
      // Busca conversão
      const cr = await fetch(`${SUPA_URL}/rest/v1/affiliate_conversions?converted_email=eq.${encodeURIComponent(email)}&select=affiliate_id,plan`, { headers: supaH });
      const convs = await cr.json();
      if (!convs?.length) return res.status(200).json({ ok: true, skipped: 'no_conversion' });

      const { affiliate_id, plan } = convs[0];

      // Cancela comissões pendentes futuras
      await fetch(`${SUPA_URL}/rest/v1/affiliate_commissions?affiliate_id=eq.${affiliate_id}&subscriber_email=eq.${encodeURIComponent(email)}&status=eq.pending`, {
        method: 'PATCH',
        headers: supaH,
        body: JSON.stringify({ status: 'cancelled' })
      });

      // Decrementa contador do afiliado
      const ar = await fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${affiliate_id}&select=*`, { headers: supaH });
      const affiliates = await ar.json();
      const affiliate = affiliates?.[0];
      if (affiliate) {
        const field = plan === 'full' ? 'total_full' : 'total_master';
        const newCount = Math.max(0, (affiliate[field] || 0) - 1);
        const totalPaying = Math.max(0, (affiliate.total_full||0) + (affiliate.total_master||0) - 1);
        await fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${affiliate_id}`, {
          method: 'PATCH',
          headers: supaH,
          body: JSON.stringify({
            [field]: newCount,
            level: getLevel(totalPaying),
            updated_at: new Date().toISOString()
          })
        });
      }

      console.log(`❌ Commission cancelled for: ${email}`);
      return res.status(200).json({ ok: true });
    } catch(e) {
      console.error('Cancel commission error:', e.message);
      return res.status(200).json({ ok: false });
    }
  }

  // ── ADMIN: notifica afiliado por email sobre commission(s) existente(s)
  // POST { action:'notify-commission-admin', admin_secret, subscriber_emails:[...], touch_dates:true }
  if (req.method === 'POST' && action === 'notify-commission-admin') {
    const { admin_secret, subscriber_emails, touch_dates } = req.body || {};
    if (admin_secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Nao autorizado' });
    const lista = Array.isArray(subscriber_emails) ? subscriber_emails : [];
    if (lista.length === 0) return res.status(400).json({ error: 'subscriber_emails obrigatorio' });
    const resultados = [];
    for (const se of lista) {
      try {
        const cr = await fetch(`${SUPA_URL}/rest/v1/affiliate_commissions?subscriber_email=eq.${encodeURIComponent(se)}&status=in.(pending,paid)&select=*&order=created_at.desc&limit=1`, { headers: supaH });
        const [comm] = cr.ok ? await cr.json() : [];
        if (!comm) { resultados.push({ email: se, ok: false, motivo: 'commission nao encontrada' }); continue; }
        const ar = await fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${comm.affiliate_id}&select=*`, { headers: supaH });
        const [aff] = ar.ok ? await ar.json() : [];
        if (!aff) { resultados.push({ email: se, ok: false, motivo: 'afiliado nao encontrado' }); continue; }
        // Opcional: atualiza datas pra parecer recente no painel do afiliado
        if (touch_dates) {
          const agora = new Date().toISOString();
          await fetch(`${SUPA_URL}/rest/v1/affiliate_commissions?id=eq.${comm.id}`, {
            method: 'PATCH', headers: { ...supaH, Prefer: 'return=minimal' },
            body: JSON.stringify({ created_at: agora, updated_at: agora }),
          }).catch(() => {});
          if (comm.conversion_id) {
            await fetch(`${SUPA_URL}/rest/v1/affiliate_conversions?id=eq.${comm.conversion_id}`, {
              method: 'PATCH', headers: { ...supaH, Prefer: 'return=minimal' },
              body: JSON.stringify({ converted_at: agora }),
            }).catch(() => {});
          }
        }
        await notificarAfiliadoNovaComissao(aff, { subscriber: se, plan: comm.plan, commission_amount: comm.commission_amount });
        resultados.push({ email: se, ok: true, afiliado: aff.email, valor: comm.commission_amount });
      } catch (e) { resultados.push({ email: se, ok: false, motivo: e.message }); }
    }
    return res.status(200).json({ ok: true, total: resultados.length, resultados });
  }

  return res.status(404).json({ error: 'Action não encontrada' });
}
