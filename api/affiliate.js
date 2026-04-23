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
  // ── POPUP DE LANCAMENTO — unico por afiliado, persistido no banco ──────────
  // GET ?action=check-popup-lancamento&token=X
  // Retorna { mostrar: boolean, nome: string } pra frontend decidir
  if (req.method === 'GET' && action === 'check-popup-lancamento') {
    const { token } = req.query;
    if (!token) return res.status(401).json({ error: 'Token obrigatório' });
    try {
      const ur = await fetch(`${SUPA_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } });
      if (!ur.ok) return res.status(401).json({ error: 'Token inválido' });
      const user = await ur.json();
      const ar = await fetch(`${SUPA_URL}/rest/v1/affiliates?email=eq.${encodeURIComponent(user.email)}&select=id,name,popup_lancamento_visto&limit=1`, { headers: supaH });
      const [aff] = ar.ok ? await ar.json() : [];
      if (!aff) return res.status(200).json({ mostrar: false });
      const primeiroNome = (aff.name || user.email.split('@')[0]).split(' ')[0];
      return res.status(200).json({
        mostrar: !aff.popup_lancamento_visto,
        nome: primeiroNome.charAt(0).toUpperCase() + primeiroNome.slice(1).toLowerCase(),
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST {action:'marcar-popup-lancamento', token} — marca como visto
  if (req.method === 'POST' && action === 'marcar-popup-lancamento') {
    const { token } = req.body;
    if (!token) return res.status(401).json({ error: 'Token obrigatório' });
    try {
      const ur = await fetch(`${SUPA_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } });
      if (!ur.ok) return res.status(401).json({ error: 'Token inválido' });
      const user = await ur.json();
      await fetch(`${SUPA_URL}/rest/v1/affiliates?email=eq.${encodeURIComponent(user.email)}`, {
        method: 'PATCH',
        headers: { ...supaH, Prefer: 'return=minimal' },
        body: JSON.stringify({ popup_lancamento_visto: true, updated_at: new Date().toISOString() }),
      });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

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

  // ╔════════════════════════════════════════════════════════════════════════╗
  // ║ ⚠️  LIVE CODE — ACAO VIVA DE CANCELAMENTO  ⚠️                          ║
  // ║ Chamada pelo webhook.js quando Stripe cancela subscription.             ║
  // ║ ATENCAO: auth.js:2252 tem codigo legado identico mas NAO e mais chamado.║
  // ║ Toda logica de cancelamento afiliado mora AQUI.                         ║
  // ║                                                                         ║
  // ║ Corrige Bug 2 (commission paga nunca revertida):                        ║
  // ║  - pending → cancelled                                                  ║
  // ║  - paid    → cancelled_after_payout (+ alerta admin)                    ║
  // ║  - decrementa total_earnings do afiliado (soma dos amounts revertidos)  ║
  // ║  - idempotente: chamada duplicada retorna skipped: 'already_cancelled'  ║
  // ║  - log em affiliate_attribution_log (auditoria, sem schema change)      ║
  // ╚════════════════════════════════════════════════════════════════════════╝
  // POST { action: 'cancel', email }
  if (req.method === 'POST' && action === 'cancel') {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email obrigatorio' });

    try {
      // 1. Busca conversion pra identificar afiliado
      const cr = await fetch(`${SUPA_URL}/rest/v1/affiliate_conversions?converted_email=eq.${encodeURIComponent(email)}&select=affiliate_id,plan`, { headers: supaH });
      const convs = await cr.json();
      if (!convs?.length) return res.status(200).json({ ok: true, skipped: 'no_conversion' });
      const { affiliate_id, plan } = convs[0];

      // 2. IDEMPOTENCIA: Stripe faz retry — chamada duplicada nao deve re-decrementar.
      //    Busca TODAS commissions do par, checa se alguma ainda esta ativa (pending/paid).
      const cmR = await fetch(
        `${SUPA_URL}/rest/v1/affiliate_commissions?affiliate_id=eq.${affiliate_id}`
        + `&subscriber_email=eq.${encodeURIComponent(email)}`
        + `&select=id,status,commission_amount,paid_at,flagged&order=created_at.desc`,
        { headers: supaH }
      );
      const all = cmR.ok ? await cmR.json() : [];
      const active = all.filter(c => c.status === 'pending' || c.status === 'paid');
      if (active.length === 0) {
        console.log(`[cancel] ${email} ja processado (0 commissions ativas, ${all.length} historicas)`);
        return res.status(200).json({ ok: true, skipped: 'already_cancelled', historicas: all.length });
      }

      // 3. Separa por status (trata igual independente de flagged)
      const pendings = active.filter(c => c.status === 'pending');
      const paids    = active.filter(c => c.status === 'paid');

      // 4. Cancela pending → cancelled
      if (pendings.length > 0) {
        await fetch(
          `${SUPA_URL}/rest/v1/affiliate_commissions?affiliate_id=eq.${affiliate_id}`
          + `&subscriber_email=eq.${encodeURIComponent(email)}&status=eq.pending`,
          { method: 'PATCH', headers: supaH, body: JSON.stringify({ status: 'cancelled' }) }
        );
      }

      // 5. Reverte paid → cancelled_after_payout (Bug 2 fix)
      if (paids.length > 0) {
        await fetch(
          `${SUPA_URL}/rest/v1/affiliate_commissions?affiliate_id=eq.${affiliate_id}`
          + `&subscriber_email=eq.${encodeURIComponent(email)}&status=eq.paid`,
          { method: 'PATCH', headers: supaH, body: JSON.stringify({ status: 'cancelled_after_payout' }) }
        );
      }

      // 6. Atualiza afiliado: decrementa contador + level + total_earnings
      const totalReverted = active.reduce((s, c) => s + parseFloat(c.commission_amount || 0), 0);
      const ar = await fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${affiliate_id}&select=*`, { headers: supaH });
      const [aff] = (await ar.json()) || [];
      if (aff) {
        const field = plan === 'full' ? 'total_full' : 'total_master';
        const newCount = Math.max(0, (aff[field] || 0) - 1);
        const totalPaying = Math.max(0, (aff.total_full || 0) + (aff.total_master || 0) - 1);
        const newEarnings = Math.max(0, parseFloat(((aff.total_earnings || 0) - totalReverted).toFixed(2)));
        await fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${affiliate_id}`, {
          method: 'PATCH', headers: supaH,
          body: JSON.stringify({
            [field]: newCount,
            level: getLevel(totalPaying),
            total_earnings: newEarnings,
            updated_at: new Date().toISOString(),
          }),
        });
      }

      // 7. Log em affiliate_attribution_log (ajuste 2 — sem inflar schema)
      const logs = [
        ...pendings.map(c => ({
          email, affiliate_id, source: 'stripe_cancel', decisao: 'cancelled',
          detalhes: { commission_id: c.id, amount: c.commission_amount, flagged: c.flagged, context: 'subscription_cancelled' },
        })),
        ...paids.map(c => ({
          email, affiliate_id, source: 'stripe_cancel', decisao: 'cancelled_after_payout',
          detalhes: { commission_id: c.id, amount: c.commission_amount, paid_at: c.paid_at, flagged: c.flagged, context: 'subscription_cancelled_post_payout' },
        })),
      ];
      for (const l of logs) {
        fetch(`${SUPA_URL}/rest/v1/affiliate_attribution_log`, {
          method: 'POST', headers: { ...supaH, 'Prefer': 'return=minimal' },
          body: JSON.stringify(l),
        }).catch(() => {});
      }

      // 8. Alerta admin SE houve reversao de paid (alto impacto)
      if (paids.length > 0 && aff && process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
        (async () => {
          try {
            const totalPaidRev = paids.reduce((s, c) => s + parseFloat(c.commission_amount || 0), 0);
            const subR = await fetch(`${SUPA_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=created_at&limit=1`, { headers: supaH });
            const [sub] = subR.ok ? await subR.json() : [];
            const signupDate = sub?.created_at ? new Date(sub.created_at).toLocaleDateString('pt-BR') : 'desconhecido';
            const earliestPaid = paids.reduce((m, c) => (!m || (c.paid_at && c.paid_at < m)) ? c.paid_at : m, null);
            const saqueDate = earliestPaid ? new Date(earliestPaid).toLocaleDateString('pt-BR') : 'desconhecido';
            const lista = paids.map(c => `<li><code>${String(c.id).slice(0,8)}</code> — R$ ${Number(c.commission_amount).toFixed(2).replace('.',',')} — pago em ${c.paid_at || '?'}</li>`).join('');
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'BlueTube Alerts <noreply@bluetubeviral.com>',
                to: [process.env.ADMIN_EMAIL],
                subject: '🚨 Commission paga revertida — decisão manual',
                html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:28px;background:#0a1628;color:#e8f4ff;border-radius:14px">
                  <h2 style="color:#ff6b6b;margin:0 0 16px">🚨 Commission paga revertida</h2>
                  <p>Subscriber cancelou e a commission dele <b>ja tinha sido paga</b> ao afiliado. Precisa decisao manual.</p>
                  <table style="width:100%;border-collapse:collapse;margin:20px 0">
                    <tr><td style="padding:8px 0;color:#9bb;font-size:13px">Subscriber:</td><td style="padding:8px 0;text-align:right;font-family:monospace;font-size:13px">${email}</td></tr>
                    <tr><td style="padding:8px 0;color:#9bb;font-size:13px">Signup subscriber:</td><td style="padding:8px 0;text-align:right;font-size:13px">${signupDate}</td></tr>
                    <tr><td style="padding:8px 0;color:#9bb;font-size:13px">Afiliado:</td><td style="padding:8px 0;text-align:right;font-family:monospace;font-size:13px">${aff.email}</td></tr>
                    <tr><td style="padding:8px 0;color:#9bb;font-size:13px">Plano:</td><td style="padding:8px 0;text-align:right;font-size:13px">${plan}</td></tr>
                    <tr><td style="padding:8px 0;color:#9bb;font-size:13px">Valor revertido:</td><td style="padding:8px 0;text-align:right"><span style="color:#ffb020;font-weight:800;font-size:18px">R$ ${totalPaidRev.toFixed(2).replace('.',',')}</span></td></tr>
                    <tr><td style="padding:8px 0;color:#9bb;font-size:13px">Data saque original:</td><td style="padding:8px 0;text-align:right;font-size:13px">${saqueDate}</td></tr>
                    <tr><td style="padding:8px 0;color:#9bb;font-size:13px">Novo status:</td><td style="padding:8px 0;text-align:right"><span style="background:rgba(255,107,107,.15);color:#ff6b6b;padding:4px 10px;border-radius:10px;font-size:11px;font-weight:700">cancelled_after_payout</span></td></tr>
                  </table>
                  <h4 style="margin:20px 0 8px">Commissions revertidas:</h4>
                  <ul style="font-size:13px;color:#bcd">${lista}</ul>
                  <h4 style="margin:20px 0 8px">Opcoes de decisao:</h4>
                  <ol style="font-size:13px;color:#bcd;line-height:1.8">
                    <li><b>Cobrar</b>: solicitar reembolso do afiliado.</li>
                    <li><b>Absorver</b>: BlueTube banca o prejuizo.</li>
                    <li><b>Negociar</b>: descontar do proximo saque do afiliado.</li>
                  </ol>
                  <div style="text-align:center;margin:24px 0 0">
                    <a href="https://bluetubeviral.com/admin" style="display:inline-block;background:linear-gradient(135deg,#ff6b6b,#ff9068);color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:700;font-size:14px">Abrir painel admin →</a>
                  </div>
                </div>`,
              }),
            });
          } catch (e) { console.error('[cancel-alert]', e.message); }
        })();
      }

      console.log(`[cancel] ${email} — pending:${pendings.length}, paid:${paids.length}, reverted:R$${totalReverted.toFixed(2)}`);
      return res.status(200).json({
        ok: true,
        pendings_cancelled: pendings.length,
        paids_cancelled_after_payout: paids.length,
        total_reverted: parseFloat(totalReverted.toFixed(2)),
      });
    } catch (e) {
      console.error('[cancel] erro:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── ATRIBUI via fingerprint 72h (fallback quando cookie falhou) ──────────
  // POST { action: 'attribute-signup-fingerprint', token }
  // Chamado pelo frontend logo apos signup. Cookie sempre vence; fingerprint
  // so atua se subscribers.affiliate_ref esta vazio. Atualiza subscribers +
  // dispara conversion + registra em affiliate_attribution_log.
  if (req.method === 'POST' && action === 'attribute-signup-fingerprint') {
    const { token } = req.body || {};
    if (!token) return res.status(401).json({ error: 'token obrigatorio' });
    try {
      // Pega email do usuario logado
      const uR = await fetch(`${SUPA_URL}/auth/v1/user`, {
        headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token },
      });
      if (!uR.ok) return res.status(401).json({ error: 'token invalido' });
      const user = await uR.json();
      if (!user?.email) return res.status(401).json({ error: 'sem email' });
      const email = user.email.toLowerCase();

      // Verifica se subscriber ja tem affiliate_ref (cookie venceu)
      const sR = await fetch(`${SUPA_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=affiliate_ref,plan,is_manual`, { headers: supaH });
      const [sub] = sR.ok ? await sR.json() : [];
      if (!sub) return res.status(200).json({ ok: true, skipped: 'subscriber_nao_existe' });
      // Regra: cookie sempre vence. Se ja tem affiliate_ref, nao mexe.
      if (sub.affiliate_ref) {
        fetch(`${SUPA_URL}/rest/v1/affiliate_attribution_log`, {
          method: 'POST', headers: { ...supaH, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ email, ref_code: sub.affiliate_ref, source: 'cookie_signup', decisao: 'already_attributed', detalhes: { context: 'signup_post' } }),
        }).catch(() => {});
        return res.status(200).json({ ok: true, skipped: 'cookie_venceu', ref_code: sub.affiliate_ref });
      }
      if (sub.is_manual) return res.status(200).json({ ok: true, skipped: 'manual' });

      // Fingerprint do request atual
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
      const ua = req.headers['user-agent'] || '';
      const lang = req.headers['accept-language'] || '';
      if (!ip && !ua) return res.status(200).json({ ok: true, skipped: 'sem_headers' });
      const ipHash = crypto.createHash('sha256').update(ip + (process.env.ADMIN_SECRET || '')).digest('hex').slice(0, 16);
      const fingerprint = crypto.createHash('sha256').update(ua + lang).digest('hex').slice(0, 16);

      // Rate limit: max 5 chamadas por IP por hora (anti-fraude + anti-abuso).
      // Conta qualquer decisao (attributed/no_match/gap_too_large/skipped_self_ref)
      // vinda do mesmo ipHash pelo endpoint. Grava ip_hash nos detalhes pra viabilizar.
      const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
      try {
        const rlR = await fetch(
          `${SUPA_URL}/rest/v1/affiliate_attribution_log`
          + `?source=eq.fingerprint_72h&detalhes->>ip_hash=eq.${ipHash}`
          + `&created_at=gte.${encodeURIComponent(oneHourAgo)}&select=id&limit=10`,
          { headers: supaH }
        );
        const rlCount = rlR.ok ? (await rlR.json()).length : 0;
        if (rlCount >= 5) {
          return res.status(429).json({ ok: false, error: 'rate_limit_exceeded', window: '1h', limit: 5 });
        }
      } catch (_) { /* fail-open: se query falhar, nao bloqueia atribuicao legitima */ }

      // Janela de atribuicao por fingerprint: 14 dias.
      // (Antes: 72h — subimos em 2026-04-20 pra cobrir users que clicam no
      // link e esperam alguns dias pra assinar. 14d captura ~90% dos casos
      // validos sem aumentar muito o risco de falso match. Source do log
      // mantido como 'fingerprint_72h' pra retrocompat com queries/admin.)
      const cutoffFingerprint = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();

      // Busca clique mais recente com match de IP ou fingerprint dentro da janela
      const ckR = await fetch(
        `${SUPA_URL}/rest/v1/affiliate_clicks`
        + `?or=(ip_hash.eq.${ipHash},visitor_fingerprint.eq.${fingerprint})`
        + `&landed_at=gte.${cutoffFingerprint}`
        + `&order=landed_at.desc&limit=1&select=affiliate_id,ref_code,ip_hash,visitor_fingerprint,landed_at`,
        { headers: supaH }
      );
      const ck = ckR.ok ? (await ckR.json())?.[0] : null;
      if (!ck?.ref_code || !ck?.affiliate_id) {
        fetch(`${SUPA_URL}/rest/v1/affiliate_attribution_log`, {
          method: 'POST', headers: { ...supaH, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ email, source: 'fingerprint_72h', decisao: 'no_match', detalhes: { context: 'signup_post', ip_hash: ipHash } }),
        }).catch(() => {});
        return res.status(200).json({ ok: true, skipped: 'no_match' });
      }

      // Threshold de proximidade temporal: gap > 2h vira orfao pro admin decidir
      // no painel "Decidir →". Evita falso positivo de fingerprint match com clique
      // antigo coincidente (mesmo IP compartilhado em wifi publico, NAT, etc).
      // Dentro de 2h e indicio forte de que o clique gerou a compra.
      const GAP_AUTO_ATTRIBUTE_MS = 2 * 60 * 60 * 1000;
      const gapMs = Date.now() - new Date(ck.landed_at).getTime();
      const gapMinutes = Math.round(gapMs / 60000);
      if (gapMs > GAP_AUTO_ATTRIBUTE_MS) {
        fetch(`${SUPA_URL}/rest/v1/affiliate_attribution_log`, {
          method: 'POST', headers: { ...supaH, 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            email, ref_code: ck.ref_code, affiliate_id: ck.affiliate_id,
            source: 'fingerprint_72h', decisao: 'gap_too_large',
            detalhes: { context: 'signup_post', ip_hash: ipHash, landed_at: ck.landed_at, gap_minutes: gapMinutes },
          }),
        }).catch(() => {});
        return res.status(200).json({ ok: true, skipped: 'gap_too_large', gap_minutes: gapMinutes });
      }

      // Self-referral: afiliado nao pode ser o proprio usuario
      const affR = await fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${ck.affiliate_id}&select=id,email,ref_code,status`, { headers: supaH });
      const [aff] = affR.ok ? await affR.json() : [];
      if (!aff || aff.status === 'suspended' || String(aff.email).toLowerCase() === email) {
        fetch(`${SUPA_URL}/rest/v1/affiliate_attribution_log`, {
          method: 'POST', headers: { ...supaH, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ email, ref_code: ck.ref_code, affiliate_id: ck.affiliate_id, source: 'fingerprint_72h', decisao: 'skipped_self_ref', detalhes: { context: 'signup_post', ip_hash: ipHash } }),
        }).catch(() => {});
        return res.status(200).json({ ok: true, skipped: 'self_or_suspended' });
      }

      // Atribui: UPDATE subscribers.affiliate_ref + attribution_source + log + dispara conversion
      await fetch(`${SUPA_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH', headers: { ...supaH, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          affiliate_ref: ck.ref_code,
          attribution_source: 'fingerprint_window',
          updated_at: new Date().toISOString(),
        }),
      });
      fetch(`${SUPA_URL}/rest/v1/affiliate_attribution_log`, {
        method: 'POST', headers: { ...supaH, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ email, ref_code: ck.ref_code, affiliate_id: ck.affiliate_id, source: 'fingerprint_72h', decisao: 'attributed', detalhes: { context: 'signup_post', ip_hash: ipHash, landed_at: ck.landed_at, gap_minutes: gapMinutes } }),
      }).catch(() => {});
      // Dispara conversion (reusa fluxo existente)
      fetch(`${process.env.SITE_URL || 'https://bluetubeviral.com'}/api/auth`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'conversion', email, plan: sub.plan || 'free', conversion_type: 'signup' }),
      }).catch(() => {});

      // Alerta admin: se afiliado recebeu >5 atribuicoes automaticas via fingerprint
      // em 1h, dispara email (fire-and-forget). Pode ser padrao organico legitimo
      // (viral momentaneo) ou tentativa de fraude (mesma rede/IP burlando sistema).
      // Admin decide investigar os logs.
      (async () => {
        try {
          const RESEND = process.env.RESEND_API_KEY;
          const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
          if (!RESEND || !ADMIN_EMAIL) return;
          const sinceAlert = new Date(Date.now() - 3600 * 1000).toISOString();
          const ar = await fetch(
            `${SUPA_URL}/rest/v1/affiliate_attribution_log`
            + `?affiliate_id=eq.${ck.affiliate_id}&source=eq.fingerprint_72h&decisao=eq.attributed`
            + `&created_at=gte.${encodeURIComponent(sinceAlert)}&select=email,created_at&order=created_at.desc&limit=20`,
            { headers: supaH }
          );
          const recent = ar.ok ? await ar.json() : [];
          if (recent.length <= 5) return;
          const lista = recent.map(r => `<li><code>${r.email}</code> <span style="color:#888">${r.created_at}</span></li>`).join('');
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'BlueTube Alerts <noreply@bluetubeviral.com>',
              to: [ADMIN_EMAIL],
              subject: `[ALERTA AFILIADO] ${aff.email} recebeu ${recent.length} atribuicoes automaticas em 1h`,
              html: `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#0a1628;color:#e8f4ff;border-radius:12px">
                <h2 style="color:#ffb020;margin:0 0 12px">⚠️ Volume atipico de atribuicoes</h2>
                <p>Afiliado <b>${aff.email}</b> (ref <code>${aff.ref_code}</code>) recebeu <b>${recent.length}</b> atribuicoes automaticas via <code>fingerprint_window</code> em 1 hora.</p>
                <p style="color:#9bb">Pode ser padrao organico legitimo (viral momentaneo) ou tentativa de fraude (mesma rede/IP burlando sistema).</p>
                <h4 style="margin:18px 0 8px">Emails atribuidos recentes:</h4>
                <ul style="font-size:13px">${lista}</ul>
                <p style="font-size:12px;color:#778"><b>Acao sugerida:</b> abrir <code>affiliate_attribution_log</code> e cruzar <code>detalhes.ip_hash</code> pra checar se e mesmo IP repetido.</p>
              </div>`,
            }),
          });
        } catch (e) { console.error('[alert-high-volume]', e.message); }
      })();

      return res.status(200).json({ ok: true, attributed: true, ref_code: ck.ref_code, affiliate_email: aff.email, gap_minutes: gapMinutes });
    } catch (e) {
      console.error('[attribute-signup-fingerprint]', e.message);
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MILESTONES — pop-up cinematografico quando atinge 10/25/50/100/250/500
  // indicacoes pagas (full/master). Aparece 1x na vida do afiliado por marco.
  // ─────────────────────────────────────────────────────────────────────────
  // GET ?action=verificar-milestone&token=X
  // Retorna { mostrar: true, milestone: N, nome: 'Fulano' } se ha milestone
  // atingido + nao visto. Se nada a mostrar: { mostrar: false }.
  // Sempre retorna o MENOR milestone nao visto (protecao contra mostrar
  // varios simultaneos — ex: se passou de 0 pra 30 de uma vez, mostra o
  // de 10 primeiro e os outros ficam pra proximas visitas).
  if (req.method === 'GET' && action === 'verificar-milestone') {
    const { token } = req.query;
    if (!token) return res.status(401).json({ error: 'Token obrigatório' });
    try {
      const ur = await fetch(`${SUPA_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } });
      if (!ur.ok) return res.status(401).json({ error: 'Token inválido' });
      const user = await ur.json();
      const ar = await fetch(`${SUPA_URL}/rest/v1/affiliates?email=eq.${encodeURIComponent(user.email)}&select=id,name,ref_code,status&limit=1`, { headers: supaH });
      const [aff] = ar.ok ? await ar.json() : [];
      if (!aff || aff.status === 'suspended') return res.status(200).json({ mostrar: false });

      // Conta indicacoes pagas ativas (full/master, nao-manual)
      const subR = await fetch(
        `${SUPA_URL}/rest/v1/subscribers?affiliate_ref=eq.${encodeURIComponent(aff.ref_code)}&plan=in.(full,master)&is_manual=eq.false&select=id`,
        { headers: { ...supaH, Prefer: 'count=exact' } }
      );
      const subs = subR.ok ? await subR.json() : [];
      const indicacoes = subs.length;

      if (indicacoes < 10) return res.status(200).json({ mostrar: false, indicacoes });

      // Busca milestones ja vistos desse afiliado
      const vistosR = await fetch(
        `${SUPA_URL}/rest/v1/affiliate_milestones_vistos?affiliate_id=eq.${aff.id}&select=milestone`,
        { headers: supaH }
      );
      const vistos = vistosR.ok ? await vistosR.json() : [];
      const vistosSet = new Set(vistos.map(v => v.milestone));

      const MILESTONES = [10, 25, 50, 100, 250, 500];
      for (const m of MILESTONES) {
        if (indicacoes >= m && !vistosSet.has(`milestone_${m}`)) {
          const primeiroNome = (aff.name || user.email.split('@')[0]).split(' ')[0];
          const nomeFmt = primeiroNome.charAt(0).toUpperCase() + primeiroNome.slice(1).toLowerCase();
          return res.status(200).json({
            mostrar: true,
            milestone: m,
            nome: nomeFmt,
            indicacoes,
          });
        }
      }
      return res.status(200).json({ mostrar: false, indicacoes });
    } catch (e) {
      console.error('[verificar-milestone]', e.message);
      // NAO bloqueia UI em caso de erro — frontend continua normal
      return res.status(200).json({ mostrar: false, error: e.message });
    }
  }

  // POST {action:'marcar-milestone-visto', token, milestone}
  // Grava que o afiliado viu o pop-up deste milestone. Idempotente via
  // UNIQUE(affiliate_id, milestone) + Prefer:resolution=ignore-duplicates.
  if (req.method === 'POST' && action === 'marcar-milestone-visto') {
    const { token, milestone } = req.body || {};
    if (!token) return res.status(401).json({ error: 'Token obrigatório' });
    const milestoneNum = parseInt(milestone, 10);
    if (!milestoneNum || ![10, 25, 50, 100, 250, 500].includes(milestoneNum)) {
      return res.status(400).json({ error: 'milestone inválido (deve ser 10/25/50/100/250/500)' });
    }
    try {
      const ur = await fetch(`${SUPA_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } });
      if (!ur.ok) return res.status(401).json({ error: 'Token inválido' });
      const user = await ur.json();
      const ar = await fetch(`${SUPA_URL}/rest/v1/affiliates?email=eq.${encodeURIComponent(user.email)}&select=id&limit=1`, { headers: supaH });
      const [aff] = ar.ok ? await ar.json() : [];
      if (!aff) return res.status(404).json({ error: 'afiliado não encontrado' });

      await fetch(`${SUPA_URL}/rest/v1/affiliate_milestones_vistos`, {
        method: 'POST',
        headers: { ...supaH, Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({
          affiliate_id: aff.id,
          milestone: `milestone_${milestoneNum}`,
        }),
      });
      return res.status(200).json({ ok: true, milestone: milestoneNum });
    } catch (e) {
      console.error('[marcar-milestone-visto]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(404).json({ error: 'Action não encontrada' });
}
