// api/affiliate-robustness.js
// Robustez + antifraude do sistema de afiliados:
//   GET  ?action=process-queue    — cron, consome commission_patch_queue (*/15min)
//   GET  ?action=reconcile        — cron, drift total_earnings vs soma (diario)
//   POST ?action=track-fingerprint — captura IP/UA do afiliado logado
//   GET  ?action=list-flagged&admin_secret=X — admin lista comissoes flaggadas
//   POST ?action=review-flagged&admin_secret=X — admin aprova/rejeita comissao
//   GET  ?action=retro-scan&admin_secret=X — admin roda deteccao retroativa
//
// Tudo silencioso pro afiliado. Admin recebe email quando deteccao pega algo.

const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  if (!SU || !SK) return res.status(500).json({ error: 'Config ausente' });
  const h = { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json' };
  const action = req.query?.action || req.body?.action;
  const ctx = { SU, AK, h, RESEND_KEY, ADMIN_EMAIL, ADMIN_SECRET };

  if (action === 'process-queue')     return processQueue(req, res, ctx);
  if (action === 'reconcile')         return reconcile(req, res, ctx);
  if (action === 'track-fingerprint') return trackFingerprint(req, res, ctx);
  if (action === 'list-flagged')      return listFlagged(req, res, ctx);
  if (action === 'review-flagged')    return reviewFlagged(req, res, ctx);
  if (action === 'retro-scan')        return retroScan(req, res, ctx);

  return res.status(400).json({ error: 'action invalida',
    valid: ['process-queue', 'reconcile', 'track-fingerprint', 'list-flagged', 'review-flagged', 'retro-scan'] });
};

// ─────────────────────────────────────────────────────────────────────────────
// TRACK FINGERPRINT — chamado pelo afiliado.html ao abrir dashboard
// ─────────────────────────────────────────────────────────────────────────────
async function trackFingerprint(req, res, { SU, AK, h }) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST apenas' });
  try {
    const { token, cookie_id } = req.body || {};
    if (!token) return res.status(401).json({ error: 'token obrigatorio' });

    // Valida token
    const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: `Bearer ${token}` } });
    if (!uR.ok) return res.status(401).json({ error: 'token invalido' });
    const user = await uR.json();
    if (!user?.email) return res.status(401).json({ error: 'sem email' });

    // Resolve afiliado pelo email
    const aR = await fetch(`${SU}/rest/v1/affiliates?email=eq.${encodeURIComponent(user.email)}&select=id`, { headers: h });
    const [aff] = aR.ok ? await aR.json() : [];
    if (!aff) return res.status(200).json({ ok: true, skipped: 'not_affiliate' });

    // Hash do IP + UA (mesmo jeito que auth.js faz em click)
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || '';
    const ipHash = ip ? crypto.createHash('sha256').update(ip + (process.env.ADMIN_SECRET || '')).digest('hex').slice(0, 16) : null;
    const ua = req.headers['user-agent'] || '';
    const lang = req.headers['accept-language'] || '';
    const fingerprint = crypto.createHash('sha256').update(ua + lang).digest('hex').slice(0, 16);
    const uaSnippet = ua.slice(0, 180);

    // Upsert: se ja existe (mesma tupla), atualiza last_seen/seen_count
    const ipClause = ipHash ? `ip_hash=eq.${ipHash}` : 'ip_hash=is.null';
    const ckClause = cookie_id ? `cookie_id=eq.${cookie_id}` : 'cookie_id=is.null';
    const existingR = await fetch(
      `${SU}/rest/v1/affiliate_fingerprints?affiliate_id=eq.${aff.id}&${ipClause}&visitor_fingerprint=eq.${fingerprint}&${ckClause}&select=id,seen_count&limit=1`,
      { headers: h }
    );
    const [existing] = existingR.ok ? await existingR.json() : [];

    if (existing) {
      await fetch(`${SU}/rest/v1/affiliate_fingerprints?id=eq.${existing.id}`, {
        method: 'PATCH', headers: h,
        body: JSON.stringify({
          last_seen: new Date().toISOString(),
          seen_count: (existing.seen_count || 1) + 1,
        }),
      });
    } else {
      await fetch(`${SU}/rest/v1/affiliate_fingerprints`, {
        method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({
          affiliate_id: aff.id,
          ip_hash: ipHash, visitor_fingerprint: fingerprint,
          cookie_id: cookie_id || null, ua_snippet: uaSnippet,
        }),
      });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[track-fingerprint] erro:', e.message);
    return res.status(200).json({ ok: false }); // nunca bloqueia UX do afiliado
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LIST FLAGGED — admin lista comissoes em analise
// ─────────────────────────────────────────────────────────────────────────────
async function listFlagged(req, res, { SU, h, ADMIN_SECRET }) {
  if (req.query?.admin_secret !== ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });
  const r = await fetch(
    `${SU}/rest/v1/affiliate_commissions?flagged=eq.true&admin_decision=is.null&select=*,affiliates!inner(email,id)&order=flagged_at.desc&limit=100`,
    { headers: h }
  );
  const rows = r.ok ? await r.json() : [];
  return res.status(200).json({ ok: true, flagged: rows });
}

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW FLAGGED — admin aprova ou rejeita uma comissao flaggada
// ─────────────────────────────────────────────────────────────────────────────
async function reviewFlagged(req, res, { SU, h, ADMIN_SECRET }) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST apenas' });
  if (req.query?.admin_secret !== ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });
  const { commission_id, decision, note } = req.body || {};
  if (!commission_id || !['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'commission_id + decision (approved|rejected) obrigatorios' });
  }

  try {
    const cr = await fetch(`${SU}/rest/v1/affiliate_commissions?id=eq.${commission_id}&select=*`, { headers: h });
    const [row] = cr.ok ? await cr.json() : [];
    if (!row) return res.status(404).json({ error: 'comissao nao encontrada' });
    if (!row.flagged) return res.status(400).json({ error: 'comissao nao esta flaggada' });
    if (row.admin_decision) return res.status(400).json({ error: 'ja decidida: ' + row.admin_decision });

    const amount = parseFloat(row.commission_amount || 0);
    const history = Array.isArray(row.commission_history) ? row.commission_history : [];
    history.push({
      at: new Date().toISOString(), source: 'admin_review',
      decision, note: note || null, amount_at_review: amount,
    });

    const patchBody = {
      admin_decision: decision,
      admin_reviewed_at: new Date().toISOString(),
      admin_review_note: note || null,
      commission_history: history,
    };
    if (decision === 'approved') {
      // Desflagga e soma no total_earnings
      patchBody.flagged = false;
      const aR = await fetch(`${SU}/rest/v1/affiliates?id=eq.${row.affiliate_id}&select=total_earnings`, { headers: h });
      const [aff] = aR.ok ? await aR.json() : [];
      if (aff) {
        await fetch(`${SU}/rest/v1/affiliates?id=eq.${row.affiliate_id}`, {
          method: 'PATCH', headers: h,
          body: JSON.stringify({
            total_earnings: parseFloat(((parseFloat(aff.total_earnings) || 0) + amount).toFixed(2)),
            updated_at: new Date().toISOString(),
          }),
        });
      }
    } else {
      // Rejeitada — status vira 'rejected', valor zerado
      patchBody.status = 'rejected';
      patchBody.commission_amount = 0;
    }

    await fetch(`${SU}/rest/v1/affiliate_commissions?id=eq.${commission_id}`, {
      method: 'PATCH', headers: h, body: JSON.stringify(patchBody),
    });
    return res.status(200).json({ ok: true, decision, commission_id });
  } catch (e) {
    console.error('[review-flagged] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RETRO SCAN — admin roda deteccao retroativa em comissoes antigas pending/paid
// ─────────────────────────────────────────────────────────────────────────────
async function retroScan(req, res, { SU, h, ADMIN_SECRET, RESEND_KEY, ADMIN_EMAIL }) {
  if (req.query?.admin_secret !== ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });

  try {
    // Pega comissoes pending/paid nao-flaggadas
    const cR = await fetch(
      `${SU}/rest/v1/affiliate_commissions?status=in.(pending,paid)&flagged=eq.false&select=id,affiliate_id,subscriber_email,plan,commission_amount&limit=500`,
      { headers: h }
    );
    const commissions = cR.ok ? await cR.json() : [];

    // Carrega afiliados envolvidos + fingerprints
    const affIds = [...new Set(commissions.map(c => c.affiliate_id))];
    if (affIds.length === 0) return res.status(200).json({ ok: true, checked: 0, flagged: 0 });

    const aR = await fetch(`${SU}/rest/v1/affiliates?id=in.(${affIds.join(',')})&select=id,email`, { headers: h });
    const affs = aR.ok ? await aR.json() : [];
    const affById = new Map(affs.map(a => [a.id, a]));

    const fpR = await fetch(`${SU}/rest/v1/affiliate_fingerprints?affiliate_id=in.(${affIds.join(',')})&select=affiliate_id,ip_hash,visitor_fingerprint,cookie_id`, { headers: h });
    const fps = fpR.ok ? await fpR.json() : [];
    const fpByAff = new Map();
    fps.forEach(f => {
      if (!fpByAff.has(f.affiliate_id)) fpByAff.set(f.affiliate_id, { ips: new Set(), fps: new Set(), cks: new Set() });
      const s = fpByAff.get(f.affiliate_id);
      if (f.ip_hash) s.ips.add(f.ip_hash);
      if (f.visitor_fingerprint) s.fps.add(f.visitor_fingerprint);
      if (f.cookie_id) s.cks.add(f.cookie_id);
    });

    const ckR = await fetch(`${SU}/rest/v1/affiliate_clicks?affiliate_id=in.(${affIds.join(',')})&select=affiliate_id,cookie_id,ip_hash,visitor_fingerprint&limit=5000`, { headers: h });
    const clicks = ckR.ok ? await ckR.json() : [];
    const clicksByAff = new Map();
    clicks.forEach(c => {
      if (!clicksByAff.has(c.affiliate_id)) clicksByAff.set(c.affiliate_id, []);
      clicksByAff.get(c.affiliate_id).push(c);
    });

    function normEmail(e) {
      if (!e) return '';
      const [local, domain] = e.toLowerCase().split('@');
      if (!domain) return e.toLowerCase();
      let l = local.split('+')[0];
      if (domain === 'gmail.com' || domain === 'googlemail.com') l = l.replace(/\./g, '');
      return `${l}@${domain}`;
    }

    let flaggedCount = 0;
    for (const c of commissions) {
      const aff = affById.get(c.affiliate_id);
      if (!aff) continue;
      const reasons = [];
      if (normEmail(aff.email) === normEmail(c.subscriber_email)) reasons.push('email_normalizado_igual');
      const s = fpByAff.get(c.affiliate_id);
      const affClicks = clicksByAff.get(c.affiliate_id) || [];
      if (s) {
        const clickMatch = affClicks.find(ck =>
          (ck.cookie_id && s.cks.has(ck.cookie_id)) ||
          (ck.ip_hash && s.ips.has(ck.ip_hash)) ||
          (ck.visitor_fingerprint && s.fps.has(ck.visitor_fingerprint))
        );
        if (clickMatch) {
          if (clickMatch.cookie_id && s.cks.has(clickMatch.cookie_id)) reasons.push('click_cookie_igual_afiliado');
          else if (clickMatch.ip_hash && s.ips.has(clickMatch.ip_hash)) reasons.push('click_ip_igual_afiliado');
          else reasons.push('click_fingerprint_igual_afiliado');
        }
      }
      if (reasons.length > 0) {
        await fetch(`${SU}/rest/v1/affiliate_commissions?id=eq.${c.id}`, {
          method: 'PATCH', headers: h,
          body: JSON.stringify({
            flagged: true,
            flagged_reason: reasons.join(',') + ',retroactive',
            flagged_at: new Date().toISOString(),
          }),
        });
        // Reverte do total_earnings
        const aR2 = await fetch(`${SU}/rest/v1/affiliates?id=eq.${c.affiliate_id}&select=total_earnings`, { headers: h });
        const [affCur] = aR2.ok ? await aR2.json() : [];
        if (affCur) {
          const amount = parseFloat(c.commission_amount || 0);
          await fetch(`${SU}/rest/v1/affiliates?id=eq.${c.affiliate_id}`, {
            method: 'PATCH', headers: h,
            body: JSON.stringify({
              total_earnings: parseFloat(Math.max(0, (parseFloat(affCur.total_earnings) || 0) - amount).toFixed(2)),
              updated_at: new Date().toISOString(),
            }),
          });
        }
        flaggedCount++;
      }
    }

    if (flaggedCount > 0) {
      await notifyAdmin({ RESEND_KEY, ADMIN_EMAIL }, `Retro-scan flaggou ${flaggedCount} comissao(oes)`, [
        ['Comissoes checadas', String(commissions.length)],
        ['Flaggadas', String(flaggedCount)],
        ['Acao', 'Revise em list-flagged / Supabase'],
      ]);
    }
    return res.status(200).json({ ok: true, checked: commissions.length, flagged: flaggedCount });
  } catch (e) {
    console.error('[retro-scan] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

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
    // ─── FASE 1: criar commissions FALTANTES
    // Cobre 2 cenarios:
    //  (a) Conversion ja marcada como full/master mas sem commission (rede falhou)
    //  (b) Conversion marcada como signup/free mas usuario upgradou pra pago depois
    //      e o upgrade nao disparou chamada ao /api/affiliate?action=conversion
    const PLAN_AMOUNTS = { full: 29.99, master: 89.99 };
    const desde120d = new Date(Date.now() - 120*86400000).toISOString();

    // Busca TODAS conversions dos ultimos 120 dias (todos os tipos)
    const convR = await fetch(
      `${SU}/rest/v1/affiliate_conversions?converted_at=gte.${desde120d}&select=id,affiliate_id,converted_email,plan,converted_at,stripe_customer_id&limit=1000`,
      { headers: h }
    );
    const conversions = convR.ok ? await convR.json() : [];

    // Existing commissions (pra idempotencia)
    const existR = await fetch(
      `${SU}/rest/v1/affiliate_commissions?status=in.(pending,paid,flagged)&select=affiliate_id,subscriber_email,plan`,
      { headers: h }
    );
    const existing = existR.ok ? await existR.json() : [];
    const existingKey = new Set(existing.map(c => `${c.affiliate_id}|${String(c.subscriber_email).toLowerCase()}`));

    // Busca plano ATUAL dos emails (pra pegar upgrades que passaram em branco)
    const emails = [...new Set(conversions.map(c => c.converted_email).filter(Boolean))];
    const subMap = new Map();
    if (emails.length > 0) {
      // Chunk pra evitar URL gigante (PostgREST limita)
      for (let i = 0; i < emails.length; i += 50) {
        const chunk = emails.slice(i, i + 50);
        const list = chunk.map(e => `"${e}"`).join(',');
        const subR = await fetch(`${SU}/rest/v1/subscribers?email=in.(${encodeURIComponent(list)})&select=email,plan,is_manual`, { headers: h });
        const subs = subR.ok ? await subR.json() : [];
        subs.forEach(s => subMap.set(String(s.email).toLowerCase(), s));
      }
    }

    // Pra cada conversion, determina plan REAL (considerando upgrade posterior)
    const missing = [];
    for (const c of conversions) {
      const key = `${c.affiliate_id}|${String(c.converted_email).toLowerCase()}`;
      if (existingKey.has(key)) continue; // ja tem commission
      // Plano ATUAL do subscriber
      const sub = subMap.get(String(c.converted_email).toLowerCase());
      if (!sub) continue; // cadastro nao existe mais
      if (sub.is_manual) continue; // manual nao gera commission
      const planFinal = sub.plan;
      if (planFinal !== 'full' && planFinal !== 'master') continue; // ainda free
      missing.push({ ...c, plan_final: planFinal });
    }

    // Mapa affiliate_id -> affiliate (pra rate + stats)
    const affIds = [...new Set(missing.map(m => m.affiliate_id))].filter(Boolean);
    const affMap = new Map();
    if (affIds.length > 0) {
      const affsR = await fetch(`${SU}/rest/v1/affiliates?id=in.(${affIds.join(',')})&select=*`, { headers: h });
      const affs = affsR.ok ? await affsR.json() : [];
      affs.forEach(a => affMap.set(a.id, a));
    }

    let criadas = 0;
    const detalhesCriadas = [];
    for (const miss of missing) {
      const aff = affMap.get(miss.affiliate_id);
      if (!aff) continue;
      // Anti self-referral basico
      if (String(aff.email).toLowerCase() === String(miss.converted_email).toLowerCase()) continue;
      const planReal = miss.plan_final; // 'full' ou 'master' (do subscriber atual)
      const planAmount = PLAN_AMOUNTS[planReal];
      if (!planAmount) continue;
      // Rate atual do afiliado (comissao_percentual ou default nivel)
      const NIVEL_RATES = { bronze: 0.30, prata: 0.45, ouro: 0.58 };
      const rate = (typeof aff.comissao_percentual === 'number' && aff.comissao_percentual > 0)
        ? aff.comissao_percentual / 100
        : (NIVEL_RATES[aff.nivel] || 0.30);
      const commissionAmount = parseFloat((planAmount * rate).toFixed(2));
      try {
        await fetch(`${SU}/rest/v1/affiliate_commissions`, {
          method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify({
            affiliate_id: aff.id,
            conversion_id: miss.id,
            subscriber_email: miss.converted_email,
            plan: planReal,
            plan_amount: planAmount,
            commission_rate: rate,
            commission_amount: commissionAmount,
            status: 'pending',
            period_start: new Date().toISOString(),
            period_end: new Date(Date.now() + 37*86400000).toISOString(),
          }),
        });
        criadas++;
        detalhesCriadas.push(`${aff.email} ← ${miss.converted_email} (${planReal}) R$${commissionAmount.toFixed(2)}`);
      } catch (e) { console.error('[reconcile:create-missing]', e.message); }
    }

    // ─── FASE 2: drift de total_earnings (codigo original)
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

    // ─── FASE 3: drift de total_full / total_master
    // Causa conhecida: api/affiliate.js:427 faz incremento otimista (lê stale +1)
    // que pode perder eventos em race ou quando o reconcile cria commission
    // sem incrementar counter. Source of truth = COUNT das commissions ativas.
    const cr2 = await fetch(
      `${SU}/rest/v1/affiliate_commissions?status=in.(pending,paid)&flagged=is.false&select=affiliate_id,plan`,
      { headers: h }
    );
    const commList = cr2.ok ? await cr2.json() : [];
    const countsByAff = new Map(); // id -> { full, master }
    commList.forEach(c => {
      if (c.plan !== 'full' && c.plan !== 'master') return;
      const prev = countsByAff.get(c.affiliate_id) || { full: 0, master: 0 };
      prev[c.plan]++;
      countsByAff.set(c.affiliate_id, prev);
    });

    const counterR = await fetch(`${SU}/rest/v1/affiliates?select=id,email,total_full,total_master`, { headers: h });
    const affCounters = counterR.ok ? await counterR.json() : [];
    const counterDrifts = [];
    for (const aff of affCounters) {
      const real = countsByAff.get(aff.id) || { full: 0, master: 0 };
      const fullStored = parseInt(aff.total_full || 0, 10);
      const masterStored = parseInt(aff.total_master || 0, 10);
      if (real.full !== fullStored || real.master !== masterStored) {
        counterDrifts.push({
          affiliate_id: aff.id, email: aff.email,
          full_stored: fullStored, full_real: real.full,
          master_stored: masterStored, master_real: real.master,
        });
      }
    }

    let countersFixed = 0;
    for (const d of counterDrifts) {
      try {
        await fetch(`${SU}/rest/v1/affiliates?id=eq.${d.affiliate_id}`, {
          method: 'PATCH', headers: h,
          body: JSON.stringify({
            total_full: d.full_real,
            total_master: d.master_real,
            updated_at: new Date().toISOString(),
          }),
        });
        countersFixed++;
      } catch (e) { console.error('[reconcile] counter patch falhou', d.email, e.message); }
    }

    // Log (inclui counter drifts)
    await fetch(`${SU}/rest/v1/affiliate_reconcile_log`, {
      method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        afiliados_checados: affiliates.length,
        drifts_detectados: drifts.length + counterDrifts.length,
        ajustes_aplicados: ajustados + countersFixed,
        detalhes: {
          drifts_earnings: drifts.slice(0, 100),
          drifts_counters: counterDrifts.slice(0, 100),
          commissions_criadas: criadas,
          exemplos: detalhesCriadas.slice(0, 20),
        },
      }),
    }).catch(() => {});

    // Notifica admin se tiver qualquer drift OU commissions criadas
    if (drifts.length > 0 || counterDrifts.length > 0 || criadas > 0) {
      const extras = [];
      if (criadas > 0) {
        extras.push(['⚠️ Commissions faltantes criadas', String(criadas)]);
        extras.push(['Exemplos', detalhesCriadas.slice(0, 5).join(' | ')]);
      }
      if (counterDrifts.length > 0) {
        extras.push(['⚠️ Drifts de counter (total_full/master)', String(counterDrifts.length)]);
        extras.push(['Counter exemplos', counterDrifts.slice(0, 5).map(d =>
          `${d.email}: full ${d.full_stored}→${d.full_real}, master ${d.master_stored}→${d.master_real}`
        ).join(' | ')]);
      }
      await notifyAdmin({ RESEND_KEY, ADMIN_EMAIL }, `Reconciliacao de afiliados — ${drifts.length + counterDrifts.length} drift(s) + ${criadas} commission(s) recuperada(s)`, [
        ['Afiliados checados', String(affiliates.length)],
        ['Drifts earnings', String(drifts.length)],
        ['Drifts counters', String(counterDrifts.length)],
        ['Ajustes aplicados', String(ajustados + countersFixed)],
        ['Drift earnings exemplos', drifts.slice(0, 5).map(d => `${d.email}: guardado R$${d.stored.toFixed(2)} → real R$${d.real.toFixed(2)}`).join(' | ')],
        ...extras,
      ]);
    }

    return res.status(200).json({
      ok: true,
      afiliados_checados: affiliates.length,
      drifts_earnings: drifts.length,
      drifts_counters: counterDrifts.length,
      ajustes_aplicados: ajustados + countersFixed,
      commissions_criadas: criadas,
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
