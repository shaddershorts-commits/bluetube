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

function generateRefCode(email) {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const suffix = crypto.randomBytes(3).toString('hex');
  return base + suffix;
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

  const action = req.method === 'GET' ? req.query?.action : req.body?.action;

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

      // Calcula stats
      const totalPaying = (affiliate.total_full || 0) + (affiliate.total_master || 0);
      const level = getLevel(totalPaying);
      const rate = COMMISSION_RATES[level];

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

        // Se plano pago, cria comissão
        if (plan === 'full' || plan === 'master') {
          const totalPaying = (affiliate.total_full || 0) + (affiliate.total_master || 0) + 1;
          const level = getLevel(totalPaying);
          const rate = COMMISSION_RATES[level];
          const planAmount = PLAN_AMOUNTS[plan];
          const commissionAmount = planAmount * rate;

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
              total_earnings: parseFloat((affiliate.total_earnings || 0) + commissionAmount).toFixed(2),
              level: getLevel(totalPaying),
              updated_at: new Date().toISOString()
            })
          });

          console.log(`💰 Commission: ${affiliate.email} ← ${email} (${plan}) = $${commissionAmount.toFixed(2)}`);
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
      const level = getLevel(totalPaying);
      const rate = COMMISSION_RATES[level];
      const planAmount = PLAN_AMOUNTS[plan] || 0;
      const commissionAmount = planAmount * rate;

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

  return res.status(404).json({ error: 'Action não encontrada' });
}
