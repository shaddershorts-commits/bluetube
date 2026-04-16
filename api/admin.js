// api/admin.js
// Returns admin dashboard data: users, subscribers, usage stats.
// Protected by ADMIN_SECRET environment variable.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const authHeader = req.headers['authorization'];
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  if (!ADMIN_SECRET || authHeader !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };

  const { action, email, plan } = req.method === 'POST' ? req.body : req.query;

  // ── SET PLAN MANUALLY ────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'set_plan') {
    if (!email || !plan) return res.status(400).json({ error: 'Missing email or plan' });

    const payload = {
      plan,
      is_manual: true,
      plan_expires_at: plan === 'free' ? null : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString()
    };

    // Try PATCH first (update existing)
    const patch = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify(payload)
      }
    );

    const patchData = await patch.json();
    console.log('PATCH result:', patch.status, JSON.stringify(patchData).slice(0,200));

    // If no rows updated, INSERT new record
    if (patch.ok && Array.isArray(patchData) && patchData.length === 0) {
      const insert = await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ email, ...payload })
      });
      if (!insert.ok) {
        const err = await insert.json();
        console.error('INSERT error:', err);
        return res.status(500).json({ error: 'Failed to insert plan: ' + JSON.stringify(err) });
      }
    } else if (!patch.ok) {
      console.error('PATCH error:', patchData);
      return res.status(500).json({ error: 'Failed to update plan: ' + JSON.stringify(patchData) });
    }

    return res.status(200).json({ success: true, email, plan });
  }

  // ── AFFILIATE MANAGEMENT ─────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'set_affiliate_status') {
    const { email, status } = req.body; // status: active | pending | suspended
    if (!email || !status) return res.status(400).json({ error: 'email e status obrigatórios' });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/affiliates?email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ status, updated_at: new Date().toISOString() })
    });
    const data = await r.json();
    console.log(`Affiliate ${status}: ${email}`);
    return res.status(200).json({ success: true, email, status });
  }

  if (req.method === 'GET' && action === 'list_affiliates') {
    try {
      const [affRes, commRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/affiliates?select=*&order=created_at.desc`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/affiliate_commissions?select=affiliate_id,commission_amount,status&order=created_at.desc`, { headers }),
      ]);
      const affiliates = affRes.ok ? await affRes.json() : [];
      const commissions = commRes.ok ? await commRes.json() : [];
      // Agrupa comissões por afiliado
      const commMap = {};
      (Array.isArray(commissions) ? commissions : []).forEach(c => {
        if (!commMap[c.affiliate_id]) commMap[c.affiliate_id] = { pending: 0, paid: 0, total: 0 };
        const amt = parseFloat(c.commission_amount || 0);
        commMap[c.affiliate_id].total += amt;
        if (c.status === 'pending') commMap[c.affiliate_id].pending += amt;
        if (c.status === 'paid') commMap[c.affiliate_id].paid += amt;
      });
      const enriched = (Array.isArray(affiliates) ? affiliates : []).map(a => ({
        ...a,
        nivel: a.nivel || 'bronze',
        comissao_percentual: a.comissao_percentual || 30,
        commissions_pending: parseFloat((commMap[a.id]?.pending || 0).toFixed(2)),
        commissions_paid: parseFloat((commMap[a.id]?.paid || 0).toFixed(2)),
        commissions_total: parseFloat((commMap[a.id]?.total || 0).toFixed(2)),
      }));
      return res.status(200).json(enriched);
    } catch(e) { return res.status(200).json([]); }
  }

  // ── SET AFFILIATE LEVEL ─────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'set_affiliate_level') {
    const { affiliate_id, nivel, motivo } = req.body;
    if (!affiliate_id || !nivel) return res.status(400).json({ error: 'affiliate_id e nivel obrigatórios' });
    const NIVEL_RATES = { bronze: 30, prata: 45, ouro: 58 };
    const comissao = NIVEL_RATES[nivel];
    if (comissao === undefined) return res.status(400).json({ error: 'Nível inválido: bronze, prata ou ouro' });

    try {
      // Busca afiliado atual
      const ar = await fetch(`${SUPABASE_URL}/rest/v1/affiliates?id=eq.${affiliate_id}&select=*`, { headers });
      const affiliates = ar.ok ? await ar.json() : [];
      const affiliate = affiliates?.[0];
      if (!affiliate) return res.status(404).json({ error: 'Afiliado não encontrado' });

      const nivelAnterior = affiliate.nivel || 'bronze';
      if (nivelAnterior === nivel) return res.status(200).json({ ok: true, message: 'Já está neste nível', affiliate });

      // Atualiza nível
      await fetch(`${SUPABASE_URL}/rest/v1/affiliates?id=eq.${affiliate_id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          nivel,
          comissao_percentual: comissao,
          nivel_atualizado_em: new Date().toISOString(),
          nivel_atualizado_por: 'admin',
          updated_at: new Date().toISOString()
        })
      });

      // Histórico
      await fetch(`${SUPABASE_URL}/rest/v1/affiliate_nivel_historico`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          affiliate_id,
          nivel_anterior: nivelAnterior,
          nivel_novo: nivel,
          motivo: motivo || null,
          admin_email: 'admin'
        })
      });

      // Email de notificação — motivacional e personalizado por nível
      const RESEND = process.env.RESEND_API_KEY;
      if (RESEND && affiliate.email) {
        const nivelLabel = { bronze: 'Bronze', prata: 'Prata', ouro: 'Ouro' }[nivel];
        const nivelEmoji = { bronze: '🥉', prata: '🥈', ouro: '🥇' }[nivel];
        const nivelColor = { bronze: '#cd7f32', prata: '#c0c0c0', ouro: '#FFD700' }[nivel];
        const anteriorLabel = { bronze: 'Bronze', prata: 'Prata', ouro: 'Ouro' }[nivelAnterior] || 'Bronze';
        const anteriorRate = { bronze: 30, prata: 45, ouro: 58 }[nivelAnterior] || 30;
        const nome = affiliate.name || affiliate.email.split('@')[0];
        const exFull = (10 * 29.99 * comissao / 100).toFixed(2);
        const exMaster = (10 * 89.99 * comissao / 100).toFixed(2);

        const mensagens = {
          prata: {
            subject: `🥈 ${nome}, você foi promovido para Afiliado Prata!`,
            titulo: `Você mereceu, ${nome}!`,
            texto: `Seu esforço e dedicação chamaram nossa atenção. Você não é mais um afiliado comum — agora faz parte do grupo seleto de parceiros <strong style="color:#c0c0c0">Prata</strong> da BlueTube.`,
            motivacao: `Cada indicação sua ajuda criadores de conteúdo a transformarem seus canais. Isso tem um impacto real — e a gente reconhece quem faz a diferença.`,
            destaque: `Continue assim e o nível <strong style="color:#FFD700">Ouro (58%)</strong> está ao seu alcance. Nós acreditamos em você.`,
          },
          ouro: {
            subject: `🥇 ${nome}, bem-vindo ao nível Ouro! Você é elite.`,
            titulo: `${nome}, você chegou ao topo.`,
            texto: `Poucos chegam aqui. Você acaba de entrar para o grupo de parceiros mais valiosos da BlueTube — o nível <strong style="color:#FFD700">Ouro</strong>. Isso não é sorte, é resultado do seu trabalho excepcional.`,
            motivacao: `Você provou que é mais do que um afiliado — é um verdadeiro embaixador. Cada pessoa que você traz encontra uma ferramenta que transforma a vida dela como criador de conteúdo. Esse é o seu legado.`,
            destaque: `A partir de agora, você tem a maior comissão possível do programa: <strong style="color:#FFD700">58% vitalício</strong>. Pagamentos priorizados, suporte dedicado e acesso antecipado a novidades.`,
          },
          bronze: {
            subject: `🥉 ${nome}, seu nível foi atualizado para Bronze`,
            titulo: `${nome}, seu nível foi ajustado.`,
            texto: `Seu nível no programa de afiliados foi atualizado para <strong style="color:#cd7f32">Bronze</strong>. Isso não muda o quanto valorizamos sua parceria.`,
            motivacao: `Continue indicando a BlueTube e seu nível pode subir novamente. Cada indicação conta, e estamos torcendo por você.`,
            destaque: `Lembre-se: mesmo no Bronze, você ganha comissão recorrente em cada assinatura indicada. Seu potencial é ilimitado.`,
          },
        };
        const msg = mensagens[nivel] || mensagens.bronze;

        fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND}` },
          body: JSON.stringify({
            from: 'BlueTube <noreply@bluetubeviral.com>',
            to: [affiliate.email],
            subject: msg.subject,
            html: `<div style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;background:#0a1628;color:#e8f4ff;max-width:520px;margin:0 auto;border-radius:20px;overflow:hidden">
              <!-- Header com gradiente do nível -->
              <div style="background:linear-gradient(135deg,${nivel==='ouro'?'#B8860B,#FFD700,#FFA500':nivel==='prata'?'#808080,#c0c0c0,#e0e0e0':'#8B4513,#cd7f32,#D2691E'});padding:36px 32px;text-align:center">
                <div style="font-size:56px;margin-bottom:8px">${nivelEmoji}</div>
                <h1 style="font-size:22px;font-weight:800;margin:0;color:${nivel==='prata'?'#1a1a2e':'#fff'}">${msg.titulo}</h1>
              </div>

              <div style="padding:32px">
                <!-- Texto motivacional -->
                <p style="font-size:15px;line-height:1.7;color:#c8d6e5;margin:0 0 16px">${msg.texto}</p>
                <p style="font-size:14px;line-height:1.7;color:#99aabb;margin:0 0 20px">${msg.motivacao}</p>

                <!-- Card de comissão: antes → depois -->
                <div style="background:rgba(255,255,255,0.04);border:1px solid ${nivelColor}33;border-radius:14px;padding:24px;text-align:center;margin-bottom:20px">
                  <div style="display:inline-block;vertical-align:middle">
                    <div style="font-size:11px;color:#667;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Antes</div>
                    <div style="font-size:28px;font-weight:800;color:#556;text-decoration:line-through">${anteriorRate}%</div>
                    <div style="font-size:10px;color:#556">${anteriorLabel}</div>
                  </div>
                  <div style="display:inline-block;vertical-align:middle;margin:0 20px;font-size:24px;color:${nivelColor}">→</div>
                  <div style="display:inline-block;vertical-align:middle">
                    <div style="font-size:11px;color:${nivelColor};text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Agora</div>
                    <div style="font-size:42px;font-weight:900;color:${nivelColor}">${comissao}%</div>
                    <div style="font-size:10px;color:${nivelColor}">${nivelLabel}</div>
                  </div>
                </div>

                <!-- Destaque -->
                <p style="font-size:14px;line-height:1.7;color:#c8d6e5;margin:0 0 20px">${msg.destaque}</p>

                <!-- Exemplos de ganhos -->
                <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px;margin-bottom:24px">
                  <div style="font-size:11px;color:#667;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Seus ganhos potenciais</div>
                  <div style="font-size:13px;color:#99aabb;margin-bottom:6px">10 assinantes Full (R$29,99) = <strong style="color:${nivelColor}">R$${exFull}/mês</strong></div>
                  <div style="font-size:13px;color:#99aabb">10 assinantes Master (R$89,99) = <strong style="color:${nivelColor}">R$${exMaster}/mês</strong></div>
                </div>

                <!-- CTA -->
                <div style="text-align:center">
                  <a href="https://bluetubeviral.com/afiliado.html" style="display:inline-block;background:linear-gradient(135deg,${nivel==='ouro'?'#B8860B,#FFD700':nivel==='prata'?'#808080,#c0c0c0':'#4f46e5,#7c3aed'});color:${nivel==='prata'?'#1a1a2e':'#fff'};padding:16px 36px;border-radius:12px;text-decoration:none;font-weight:800;font-size:15px">Ver meu painel →</a>
                </div>

                <!-- Assinatura -->
                <div style="text-align:center;margin-top:28px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.06)">
                  <div style="font-size:13px;color:#556">Equipe BlueTube</div>
                  <div style="font-size:11px;color:#445;margin-top:4px">Obrigado por fazer parte dessa jornada com a gente.</div>
                </div>
              </div>
            </div>`
          })
        }).catch((e) => console.error('Email send error:', e.message));
      }

      console.log(`🎖 Affiliate level: ${affiliate.email} ${nivelAnterior} → ${nivel} (${comissao}%)`);
      return res.status(200).json({ ok: true, affiliate: { ...affiliate, nivel, comissao_percentual: comissao } });
    } catch(e) {
      console.error('Set affiliate level error:', e.message);
      return res.status(500).json({ error: 'Erro ao alterar nível: ' + e.message });
    }
  }

  // ── AFFILIATE LEVEL HISTORY ─────────────────────────────────────────────
  if (req.method === 'GET' && action === 'affiliate_history') {
    const { affiliate_id } = req.query;
    if (!affiliate_id) return res.status(400).json({ error: 'affiliate_id obrigatório' });
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/affiliate_nivel_historico?affiliate_id=eq.${affiliate_id}&select=*&order=created_at.desc&limit=20`, { headers });
      return res.status(200).json(r.ok ? await r.json() : []);
    } catch(e) { return res.status(200).json([]); }
  }

  // ── MODERATION ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'moderation') {
    try {
      const [reportsRes, reviewRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/blue_reports?order=created_at.desc&limit=50&select=*`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/blue_videos?status=eq.under_review&select=id,title,user_id,video_url,created_at`, { headers }),
      ]);
      const reports = reportsRes.ok ? await reportsRes.json() : [];
      const underReview = reviewRes.ok ? await reviewRes.json() : [];
      return res.status(200).json({
        reports,
        under_review: underReview,
        pending_count: reports.filter(r => r.status === 'pending').length,
        total_count: reports.length,
        review_count: underReview.length
      });
    } catch(e) { return res.status(200).json({ reports: [], under_review: [], error: e.message }); }
  }

  // ── MODERATE VIDEO ─────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'moderate') {
    const { video_id, decision } = req.body; // decision: 'approve' | 'remove'
    if (!video_id || !decision) return res.status(400).json({ error: 'Missing fields' });
    const newStatus = decision === 'approve' ? 'active' : 'removed';
    await fetch(`${SUPABASE_URL}/rest/v1/blue_videos?id=eq.${video_id}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status: newStatus, updated_at: new Date().toISOString() })
    });
    // Mark related reports as resolved
    await fetch(`${SUPABASE_URL}/rest/v1/blue_reports?video_id=eq.${video_id}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status: decision === 'approve' ? 'dismissed' : 'actioned' })
    });
    return res.status(200).json({ success: true, video_id, status: newStatus });
  }

  // ── LEARNING STATS ────────────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'learning_stats') {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/roteiro_exemplos?select=id,idioma,nicho,roteiro_casual,roteiro_apelativo,aprovacoes,reprovacoes,created_at&order=aprovacoes.desc&limit=50`, { headers });
      const data = await r.json();
      const arr = Array.isArray(data) ? data : [];
      const totalAprov = arr.reduce((s, r) => s + (r.aprovacoes || 0), 0);
      const totalReprov = arr.reduce((s, r) => s + (r.reprovacoes || 0), 0);
      const avgScore = arr.length > 0 && (totalAprov + totalReprov) > 0
        ? (totalAprov / (totalAprov + totalReprov)) * 100 : 0;
      return res.status(200).json({
        total: arr.length,
        total_aprovacoes: totalAprov,
        total_reprovacoes: totalReprov,
        avg_score: avgScore,
        top: arr.slice(0, 20)
      });
    } catch(e) {
      return res.status(200).json({ total: 0, top: [], error: e.message });
    }
  }

  // ── DELETE LEARNING EXAMPLE ──────────────────────────────────────────────
  if (req.method === 'POST' && action === 'delete_learning_example') {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    await fetch(`${SUPABASE_URL}/rest/v1/roteiro_exemplos?id=eq.${id}`, { method: 'DELETE', headers });
    return res.status(200).json({ success: true });
  }

  // ── DELETE LOW-SCORE LEARNING EXAMPLES ──────────────────────────────────
  if (req.method === 'POST' && action === 'delete_low_score_examples') {
    const all = await fetch(`${SUPABASE_URL}/rest/v1/roteiro_exemplos?select=id,aprovacoes,reprovacoes`, { headers });
    let deleted = 0;
    if (all.ok) {
      for (const r of await all.json()) {
        const t = (r.aprovacoes||0) + (r.reprovacoes||0);
        const sc = t > 0 ? r.aprovacoes / t : 0;
        if (sc < 0.3 && t >= 3) {
          await fetch(`${SUPABASE_URL}/rest/v1/roteiro_exemplos?id=eq.${r.id}`, { method:'DELETE', headers });
          deleted++;
        }
      }
    }
    return res.status(200).json({ success: true, deleted });
  }

  // ── DELETE USER (LGPD) ─────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'delete_user') {
    const { email: targetEmail } = req.body;
    if (!targetEmail) return res.status(400).json({ error: 'Missing email' });
    const h2 = { ...headers, 'Content-Type': 'application/json' };

    // Cancel Stripe if exists
    const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(targetEmail)}&select=stripe_customer_id,user_id`, { headers });
    const sub = subRes.ok ? (await subRes.json())[0] : null;
    const uid = sub?.user_id;
    const stripeId = sub?.stripe_customer_id;
    if (stripeId && process.env.STRIPE_SECRET_KEY) {
      try {
        const sr = await fetch(`https://api.stripe.com/v1/customers/${stripeId}/subscriptions?status=active`, {
          headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }
        });
        if (sr.ok) { for (const s of (await sr.json()).data||[]) { await fetch(`https://api.stripe.com/v1/subscriptions/${s.id}`, { method:'DELETE', headers:{ Authorization:`Bearer ${process.env.STRIPE_SECRET_KEY}` }}); } }
      } catch(e) {}
    }

    // Delete from all tables
    const tables = ['subscribers','user_feedback','roteiro_exemplos','reactivation_emails'];
    for (const t of tables) { await fetch(`${SUPABASE_URL}/rest/v1/${t}?email=eq.${encodeURIComponent(targetEmail)}`, { method:'DELETE', headers }).catch(()=>{}); }
    if (uid) {
      const uidTables = ['blue_profiles','blue_videos','blue_comments','blue_interactions','blue_notifications','blue_reports'];
      for (const t of uidTables) { await fetch(`${SUPABASE_URL}/rest/v1/${t}?user_id=eq.${uid}`, { method:'DELETE', headers }).catch(()=>{}); }
    }

    // Log action
    await fetch(`${SUPABASE_URL}/rest/v1/admin_actions`, {
      method:'POST', headers:h2,
      body: JSON.stringify({ admin_email:'admin', action:'delete_user', target_email:targetEmail, details:{ stripe_cancelled:!!stripeId } })
    }).catch(()=>{});

    // Email notification
    const RESEND = process.env.RESEND_API_KEY;
    if (RESEND) {
      fetch('https://api.resend.com/emails', { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${RESEND}`},
        body:JSON.stringify({ from:'BlueTube <noreply@bluetubeviral.com>', to:[targetEmail], subject:'Sua conta BlueTube foi removida',
          html:`<div style="font-family:sans-serif;background:#0a1628;color:#e8f4ff;padding:24px;border-radius:12px"><p>Sua conta foi removida do BlueTube por um administrador.</p><p>Todos os seus dados foram excluídos.</p></div>`})
      }).catch(()=>{});
    }

    return res.status(200).json({ success: true, email: targetEmail });
  }

  // ── FEEDBACK ACTIONS ────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'delete_feedback') {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    await fetch(`${SUPABASE_URL}/rest/v1/user_feedback?id=eq.${id}`, { method:'DELETE', headers });
    return res.status(200).json({ success: true });
  }
  if (req.method === 'POST' && action === 'delete_feedbacks_bulk') {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'Missing ids' });
    for (const id of ids) { await fetch(`${SUPABASE_URL}/rest/v1/user_feedback?id=eq.${id}`, { method:'DELETE', headers }); }
    return res.status(200).json({ success: true, deleted: ids.length });
  }
  if (req.method === 'POST' && action === 'mark_feedback_read') {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    await fetch(`${SUPABASE_URL}/rest/v1/user_feedback?id=eq.${id}`, {
      method:'PATCH', headers:{ ...headers,'Content-Type':'application/json','Prefer':'return=minimal' },
      body: JSON.stringify({ is_read: true })
    });
    return res.status(200).json({ success: true });
  }

  // ── PAGINATED LIST SUBSCRIBERS ──────────────────────────────────────────
  if (req.method === 'GET' && action === 'list_subscribers') {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    const search = req.query.search || '';
    const planFilter = req.query.plan || '';
    const offset = (page - 1) * limit;

    let url = `${SUPABASE_URL}/rest/v1/subscribers?select=*&order=created_at.desc&limit=${limit}&offset=${offset}`;
    if (search) url += `&email=ilike.*${encodeURIComponent(search)}*`;
    if (planFilter) url += `&plan=eq.${planFilter}`;

    const [dataRes, countRes] = await Promise.all([
      fetch(url, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=id${search ? `&email=ilike.*${encodeURIComponent(search)}*` : ''}${planFilter ? `&plan=eq.${planFilter}` : ''}`, { headers: { ...headers, 'Prefer': 'count=exact' } })
    ]);

    const data = dataRes.ok ? await dataRes.json() : [];
    const totalHeader = countRes.headers?.get('content-range');
    const total = totalHeader ? parseInt(totalHeader.split('/')[1]) || data.length : data.length;

    return res.status(200).json({ data, total, page, pages: Math.ceil(total / limit), has_more: offset + limit < total });
  }

  // ── PAGINATED FEEDBACK ──────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'list_feedback') {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const offset = (page - 1) * limit;
    const url = `${SUPABASE_URL}/rest/v1/user_feedback?select=*&order=created_at.desc&limit=${limit}&offset=${offset}`;
    const r = await fetch(url, { headers });
    const data = r.ok ? await r.json() : [];
    // Get total
    const cr = await fetch(`${SUPABASE_URL}/rest/v1/user_feedback?select=id`, { headers: { ...headers, 'Prefer': 'count=exact' } });
    const th = cr.headers?.get('content-range');
    const total = th ? parseInt(th.split('/')[1]) || 0 : data.length;
    return res.status(200).json({ data, total, page, pages: Math.ceil(total / limit), has_more: offset + limit < total });
  }

  // ── EMAIL MARKETING STATS ────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'email_marketing_stats') {
    try {
      const [allRes, unsubRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/email_marketing?select=email,total_sent,last_sent_at,unsubscribed,sequence_position&order=last_sent_at.desc.nullslast&limit=200`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/email_marketing?unsubscribed=eq.true&select=email`, { headers }),
      ]);
      const all = allRes.ok ? await allRes.json() : [];
      const unsubs = unsubRes.ok ? await unsubRes.json() : [];
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const sentThisWeek = all.filter(e => e.last_sent_at && e.last_sent_at > weekAgo).length;
      const totalSent = all.reduce((s, e) => s + (e.total_sent || 0), 0);
      return res.status(200).json({
        total_list: all.length,
        total_unsubscribed: unsubs.length,
        unsub_rate: all.length > 0 ? ((unsubs.length / all.length) * 100).toFixed(1) : '0',
        sent_this_week: sentThisWeek,
        total_sent: totalSent,
        recent: all.filter(e => e.last_sent_at).slice(0, 10)
      });
    } catch (e) { return res.status(200).json({ error: e.message }); }
  }

  // ── REALTIME PULSE (lightweight, for 10s polling) ────────────────────────
  if (req.method === 'GET' && action === 'realtime_pulse') {
    try {
      const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const [countRes, onlineRes, cancelRes, latestRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=id`, { headers: { ...headers, 'Prefer': 'count=exact' } }),
        fetch(`${SUPABASE_URL}/rest/v1/ip_online?pinged_at=gte.${twoMinAgo}&select=ip_address`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/subscribers?plan=eq.free&stripe_customer_id=not.is.null&select=email,updated_at&order=updated_at.desc&limit=1`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=email&order=created_at.desc&limit=1`, { headers }),
      ]);
      const totalHeader = countRes.headers?.get('content-range');
      const total = totalHeader ? parseInt(totalHeader.split('/')[1]) || 0 : 0;
      const online = onlineRes.ok ? (await onlineRes.json()).length : 0;
      const cancel = cancelRes.ok ? (await cancelRes.json())[0] : null;
      const latest = latestRes.ok ? (await latestRes.json())[0] : null;
      return res.status(200).json({
        total,
        online_now: online,
        latest_email: latest?.email || null,
        latest_cancel_email: cancel?.email || null,
      });
    } catch(e) { return res.status(200).json({ total: 0, online_now: 0 }); }
  }

  // ── GET DASHBOARD DATA ────────────────────────────────────────────────────
  try {
    const today = new Date().toISOString().split('T')[0];
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // safeJson: always returns an array, never throws
    const safeJson = async (resPromise) => {
      try {
        const res = await resPromise;
        if (!res || !res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      } catch(e) { return []; }
    };

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [subscribers, todayUsage, topVirals, feedbackRaw, visitsToday, onlineNow, weeklyRaw, bluescoreRaw, recentSubs] = await Promise.all([
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=*&order=created_at.desc`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/ip_usage?usage_date=eq.${today}&select=*`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/viral_shorts?select=video_id,copy_count,lang,processed_at&order=copy_count.desc&limit=10`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/user_feedback?select=*&order=created_at.desc&limit=50`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/ip_visits?visit_date=eq.${today}&select=ip_address`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/ip_online?pinged_at=gte.${twoMinAgo}&select=ip_address`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/ip_visits?visit_date=gte.${sevenDaysAgo}&select=ip_address,visit_date&order=visit_date.asc`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/bluescore_analyses?select=channel_name,score,classification,avg_views,analyzed_at&order=analyzed_at.desc&limit=20`, { headers })),
      safeJson(fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=email,plan,created_at&order=created_at.desc&limit=10`, { headers })),
    ]);

    // Group weekly visits by date
    const weeklyMap = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      weeklyMap[d.toISOString().split('T')[0]] = 0;
    }
    weeklyRaw.forEach(r => { if (weeklyMap[r.visit_date] !== undefined) weeklyMap[r.visit_date]++; });
    const weeklyVisits = Object.entries(weeklyMap).map(([date, count]) => ({ date, count }));

    // Sort feedback
    const feedback = feedbackRaw.sort((a,b)=>{
      if(a.plan==='master'&&b.plan!=='master')return -1;
      if(b.plan==='master'&&a.plan!=='master')return 1;
      if(a.type==='support'&&b.type!=='support')return -1;
      if(b.type==='support'&&a.type!=='support')return 1;
      return new Date(b.created_at)-new Date(a.created_at);
    });

    const stats = {
      subscribers: {
        total: subscribers.length,
        free: subscribers.filter(s => s.plan === 'free').length,
        full: subscribers.filter(s => s.plan === 'full').length,
        master: subscribers.filter(s => s.plan === 'master').length,
        paying_full: subscribers.filter(s => s.plan === 'full' && !s.is_manual).length,
        paying_master: subscribers.filter(s => s.plan === 'master' && !s.is_manual).length,
        manual_full: subscribers.filter(s => s.plan === 'full' && s.is_manual).length,
        manual_master: subscribers.filter(s => s.plan === 'master' && s.is_manual).length,
        list: subscribers
      },
      revenue: {
        monthly_mrr: (subscribers.filter(s => s.plan === 'full' && !s.is_manual).length * 29.99) +
                     (subscribers.filter(s => s.plan === 'master' && !s.is_manual).length * 89.99),
        full_revenue: subscribers.filter(s => s.plan === 'full' && !s.is_manual).length * 29.99,
        master_revenue: subscribers.filter(s => s.plan === 'master' && !s.is_manual).length * 89.99
      },
      conversion: {
        total_free: subscribers.filter(s => s.plan === 'free').length,
        total_paying: subscribers.filter(s => s.plan !== 'free' && !s.is_manual).length,
        rate: subscribers.length > 0
          ? ((subscribers.filter(s => s.plan !== 'free' && !s.is_manual).length / subscribers.length) * 100).toFixed(1)
          : '0.0',
        // Churn: users who had a paid plan but are now free (have stripe_customer_id but plan=free)
        churned: subscribers.filter(s => s.plan === 'free' && s.stripe_customer_id).length,
        // Expired: paid plan but expired
        expired: subscribers.filter(s => s.plan !== 'free' && s.plan_expires_at && new Date(s.plan_expires_at) < new Date()).length,
      },
      today: {
        active_ips: todayUsage.length,
        total_scripts_generated: todayUsage.reduce((sum, r) => sum + (r.script_count || 0), 0),
        usage_breakdown: todayUsage
      },
      top_virals: topVirals,
      feedback,
      visits: {
        today_unique: visitsToday.length,
        online_now: onlineNow.length,
        weekly: weeklyVisits,
      },
      latest_subscriber: subscribers.filter(s => s.plan !== 'free' && !s.is_manual)[0] || null,
      latest_cancellation: (() => {
        try {
          return subscribers.filter(s => s.plan==='free' && s.stripe_customer_id && s.updated_at && s.created_at
            && (new Date(s.updated_at)-new Date(s.created_at)) > 3600000)
            .sort((a,b)=>new Date(b.updated_at||0)-new Date(a.updated_at||0))[0]||null;
        } catch(e){return null;}
      })(),
      latest_signup: recentSubs[0] || null, // último cadastro (qualquer plano)
      recent_signups: recentSubs, // últimos 10 cadastros
      bluescore: {
        total_analyses: bluescoreRaw.length,
        recent: bluescoreRaw,
        avg_score: bluescoreRaw.length > 0
          ? Math.round(bluescoreRaw.reduce((s,a) => s + (a.score||0), 0) / bluescoreRaw.length)
          : 0,
      },
    };

    return res.status(200).json(stats);
  } catch (err) {
    console.error('Admin error:', err);
    return res.status(500).json({ error: 'Failed to fetch admin data: ' + err.message });
  }
}
